import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { db } from '../db/index.js';
import { recordingSegments, streamRecordings, transmissions } from '../db/schema/index.js';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { enqueue } from './jobsQueueService.js';
import { emitToTenant, notify } from './notificationService.js';
import { audit } from './auditService.js';

// ---------------------------------------------------------------------------
// recordingPurgeService — purga del crudo por retención del plan (T-36, PI-05)
//
//   - El crudo vive plans.retentionDays desde el FIN de la transmisión
//     (transmissions.ended_at); null en el plan = retención indefinida →
//     conservador: NO purgar.
//   - Barrido diario (engine): candidatos → enqueue 'purge_recording' por
//     transmisión (dedup purge:tx:{id}) → la cola da retries/backoff.
//   - ANTES de borrar: si hay render_clip pending/running de esa tx → skip
//     (el crudo sigue siendo fuente; se reevalúa mañana).
//   - Borra SOLO los fileRef de recording_segments (nunca los assets en
//     {tenant}/{tx}/clips/ ni metadata). Luego status='purged'.
//   - Post-sweep: uso de disco por tenant vs plans.max_storage_gb →
//     notificación de alerta al superar DISK_WARN_PCT.
//   - Idempotente: segmentos ya purgados no re-fallan; ENOENT = ya borrado.
// ---------------------------------------------------------------------------

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const PURGE_BATCH = 25;
const DISK_WARN_PCT = Number(process.env.MEDIA_DISK_WARN_PCT ?? 0.85);
const DISK_ALERT_COOLDOWN_MS = 24 * 3_600_000;

const lastDiskAlert = new Map<string, number>();

export interface PurgeRecordingPayload {
    /** Purga UNA transmisión (sweep la encola así; también sirve manual). */
    transmissionId?: string;
    /** Forzar borrado aunque la retención no haya vencido (admin). */
    force?: boolean;
}

interface PurgeCandidate {
    recordingId: string;
    transmissionId: string;
    tenantId: string;
    storagePrefix: string;
}

/** render_clip pendientes/en curso que referencian la tx → el crudo sigue vivo. */
async function hasPendingRenders(transmissionId: string): Promise<boolean> {
    const res = await db.execute(sql`
        SELECT count(*)::int AS n
        FROM "jobs_queue"
        WHERE "type" = 'render_clip'
          AND "status" IN ('pending', 'running')
          AND "payload"->>'transmissionId' = ${transmissionId}
    `);
    return ((res.rows[0] as { n?: number } | undefined)?.n ?? 0) > 0;
}

/** Recordings cuyo crudo venció retención (transmissions.ended_at + retention < now). */
async function findPurgeCandidates(): Promise<PurgeCandidate[]> {
    const res = await db.execute(sql`
        SELECT sr."id" AS recording_id,
               sr."transmission_id",
               t."tenant_id",
               sr."storage_prefix"
        FROM "stream_recordings" sr
        JOIN "transmissions" t ON t."id" = sr."transmission_id"
        JOIN "subscriptions" s ON s."tenant_id" = t."tenant_id"
        JOIN "plans" p ON p."id" = s."plan_id"
        WHERE p."retention_days" IS NOT NULL
          AND COALESCE(t."ended_at", sr."ended_at") IS NOT NULL
          AND COALESCE(t."ended_at", sr."ended_at")
              < now() - (p."retention_days" || ' days')::interval
          AND EXISTS (
              SELECT 1 FROM "recording_segments" seg
              WHERE seg."recording_id" = sr."id" AND seg."status" = 'active'
          )
        ORDER BY sr."ended_at" NULLS LAST
        LIMIT ${PURGE_BATCH}
    `);
    return (res.rows as unknown as { recording_id: string; transmission_id: string; tenant_id: string; storage_prefix: string }[])
        .map((r) => ({
            recordingId: r.recording_id,
            transmissionId: r.transmission_id,
            tenantId: r.tenant_id,
            storagePrefix: r.storage_prefix,
        }));
}

/** Purga el crudo de UNA transmisión. Devuelve segs purgados + bytes liberados. */
async function purgeTransmission(transmissionId: string, force: boolean): Promise<{ purged: number; bytes: number; skipped: boolean }> {
    // Guard: renders pendientes — el crudo es su fuente.
    if (!force && (await hasPendingRenders(transmissionId))) {
        console.log(`[Purge] tx=${transmissionId} skip — render_clip pendiente/en curso`);
        return { purged: 0, bytes: 0, skipped: true };
    }

    const segs = await db.select().from(recordingSegments)
        .innerJoin(streamRecordings, eq(recordingSegments.recordingId, streamRecordings.id))
        .where(and(
            eq(streamRecordings.transmissionId, transmissionId),
            inArray(recordingSegments.status, ['active', 'corrupt']),
        ));

    if (segs.length === 0) return { purged: 0, bytes: 0, skipped: false };

    let purged = 0;
    let freedBytes = 0;
    const segIds: string[] = [];
    for (const row of segs) {
        const seg = row.recording_segments;
        const filePath = path.isAbsolute(seg.fileRef) ? seg.fileRef : path.join(MEDIA_ROOT, seg.fileRef);
        try {
            const stat = await fsp.stat(filePath).catch(() => null);
            await fsp.unlink(filePath);
            freedBytes += stat?.size ?? seg.bytes ?? 0;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') {
                console.warn(`[Purge] no se pudo borrar ${filePath}:`, err instanceof Error ? err.message : err);
            }
        }
        segIds.push(seg.id);
        purged++;
    }

    if (segIds.length > 0) {
        await db.update(recordingSegments)
            .set({ status: 'purged' })
            .where(inArray(recordingSegments.id, segIds));
    }

    const [tx] = await db.select({ tenantId: transmissions.tenantId })
        .from(transmissions).where(eq(transmissions.id, transmissionId)).limit(1);
    const tenantId = tx?.tenantId ?? null;
    if (tenantId) {
        void audit({
            tenantId,
            action: 'recording.purged',
            metadata: { transmissionId, segments: purged, freedBytes },
        });
        emitToTenant(tenantId, 'transmission:update', { transmissionId, crudoPurged: true });
        console.log(`[Purge] tx=${transmissionId} → ${purged} segs, ${(freedBytes / 1e6).toFixed(1)} MB liberados`);
    }
    return { purged, bytes: freedBytes, skipped: false };
}

// ---------------------------------------------------------------------------
// Handler 'purge_recording' — una tx o barrido completo
// ---------------------------------------------------------------------------
export async function handlePurgeRecording(payload: PurgeRecordingPayload): Promise<void> {
    if (payload?.transmissionId) {
        const r = await purgeTransmission(payload.transmissionId, payload.force === true);
        if (r.skipped && !payload.force) {
            // Reprogramar para mañana: el render pendiente probablemente ya salió.
            await enqueue('purge_recording', payload as Record<string, unknown>, {
                dedupKey: `purge:tx:${payload.transmissionId}:retry:${Date.now()}`,
                runAt: new Date(Date.now() + 24 * 3_600_000),
            }).catch(() => undefined);
        }
        return;
    }

    // Barrido: candidatos vencidos → 1 job por tx (dedup diario por tx).
    const candidates = await findPurgeCandidates();
    for (const c of candidates) {
        await enqueue('purge_recording', { transmissionId: c.transmissionId }, {
            tenantId: c.tenantId,
            dedupKey: `purge:tx:${c.transmissionId}`,
        }).catch((e) => console.warn('[Purge] enqueue falló:', e instanceof Error ? e.message : e));
    }
    if (candidates.length > 0) {
        console.log(`[Purge] sweep → ${candidates.length} transmisiones encoladas`);
    }
}

// ---------------------------------------------------------------------------
// Alerta de uso de disco — tenant vs plans.max_storage_gb (T-36)
// ---------------------------------------------------------------------------
async function dirSizeBytes(dir: string): Promise<number> {
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        const entries = await fsp.readdir(cur, { withFileTypes: true }).catch(() => null);
        if (!entries) continue;
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile()) {
                const st = await fsp.stat(p).catch(() => null);
                total += st?.size ?? 0;
            }
        }
    }
    return total;
}

/** Uso de MEDIA_ROOT/{tenantId} vs max_storage_gb → notify si ≥ DISK_WARN_PCT. */
export async function checkDiskUsageAlerts(): Promise<void> {
    if (!fs.existsSync(MEDIA_ROOT)) return;
    const res = await db.execute(sql`
        SELECT t."id" AS tenant_id,
               t."platform_name",
               p."max_storage_gb"
        FROM "tenants" t
        LEFT JOIN "subscriptions" s ON s."tenant_id" = t."id"
        LEFT JOIN "plans" p ON p."id" = s."plan_id"
        WHERE t."is_active" = true
    `);
    for (const row of res.rows as unknown as { tenant_id: string; platform_name: string | null; max_storage_gb: number | null }[]) {
        const tenantId = row.tenant_id;
        const limitGb = row.max_storage_gb;
        if (limitGb == null || limitGb <= 0) continue;
        const usedBytes = await dirSizeBytes(path.join(MEDIA_ROOT, tenantId)).catch(() => 0);
        const pct = usedBytes / (limitGb * 1e9);
        if (pct >= DISK_WARN_PCT) {
            const last = lastDiskAlert.get(tenantId) ?? 0;
            if (Date.now() - last < DISK_ALERT_COOLDOWN_MS) continue;
            lastDiskAlert.set(tenantId, Date.now());
            void notify({
                tenantId,
                type: 'disk_usage_warning',
                title: 'Uso de almacenamiento alto',
                message: `${(usedBytes / 1e9).toFixed(1)} GB de ${limitGb} GB del plan (${Math.round(pct * 100)}%). Considerá purgar o subir de plan.`,
                icon: '💾',
                metadata: { usedBytes, limitGb, pct: Math.round(pct * 100) },
            });
            void audit({
                tenantId,
                action: 'storage.usage_warning',
                metadata: { usedBytes, limitGb, pct: Math.round(pct * 100) },
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Loop diario del engine
// ---------------------------------------------------------------------------
const DAILY_MS = 24 * 3_600_000;

export function startPurgeLoop(): { stop: () => void } {
    const tick = async () => {
        try {
            await handlePurgeRecording({});
        } catch (err) {
            console.error('[Purge] sweep error:', err);
        }
        try {
            await checkDiskUsageAlerts();
        } catch (err) {
            console.error('[Purge] disk-usage check error:', err);
        }
    };
    // Primer tick con delay corto (deja bootear el resto del engine).
    const initial = setTimeout(() => { void tick(); }, 60_000);
    const timer = setInterval(() => { void tick(); }, DAILY_MS);
    console.log('[Purge] loop started (diario)');
    return {
        stop: () => {
            clearTimeout(initial);
            clearInterval(timer);
        },
    };
}
