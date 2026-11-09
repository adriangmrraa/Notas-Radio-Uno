import { db } from '../db/index.js';
import {
    transmissions,
    streamRecordings,
    recordingSegments,
    transmissionSegments,
    personAppearances,
    jobExecutions,
    scheduledJobs,
} from '../db/schema/index.js';
import type {
    TransmissionSource,
    TransmissionStatus,
} from '../db/schema/transmissions.js';
import { eq, and, desc, inArray, lt, or, isNull } from 'drizzle-orm';
import { emitTransmissionEvent } from './notificationService.js';
import { release as releaseQuota } from './quotaService.js';
import { audit } from './auditService.js';

// ---------------------------------------------------------------------------
// transmissionService — CRUD + FSM de transmissions (T-21, spec stream-recording)
//
// FSM: scheduled → waiting → live → processing → done | error | canceled
//   - `startedAt` es el ANCLA wall-clock: todo artefacto temporal
//     (recording_segments, person_appearances, transmission_segments, ventanas
//     de clip, utterances) se expresa en ms relativos a ese instante.
//   - Cada transición emite `transmission:{status}` + `transmission:update`
//     por Socket.IO (o relay interno hacia el api — ver notificationService).
//   - Las ejecuciones de scheduler vinculadas (job_executions.transmission_id)
//     se cierran cuando la transmisión llega a un estado terminal.
// ---------------------------------------------------------------------------

export const MIN_CAPTURE_MS = Number(process.env.MIN_CAPTURE_MS ?? 5 * 60 * 1000);
/** Heartbeat más viejo que esto = proceso engine muerto → reconciliar al boot. */
export const STALE_HEARTBEAT_MS = Number(process.env.STALE_HEARTBEAT_MS ?? 10 * 60 * 1000);

export type Transmission = typeof transmissions.$inferSelect;

export const TRANSITIONS: Record<TransmissionStatus, TransmissionStatus[]> = {
    scheduled: ['waiting', 'canceled'],
    waiting: ['live', 'error', 'canceled'],
    live: ['processing', 'error', 'canceled'],
    processing: ['done', 'error'],
    done: [],
    error: [],
    canceled: [],
};

const TERMINAL: ReadonlySet<TransmissionStatus> = new Set(['done', 'error', 'canceled']);

export class TransmissionTransitionError extends Error {
    constructor(from: TransmissionStatus, to: TransmissionStatus) {
        super(`Invalid transmission transition ${from} → ${to}`);
        this.name = 'TransmissionTransitionError';
    }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export interface CreateTransmissionInput {
    tenantId: string;
    source: TransmissionSource;
    programId?: string | null;
    scheduledJobId?: string | null;
    streamUrl?: string | null;
    durationMinutes?: number | null;
    operationId?: string | null;
    pipelineConfig?: Record<string, unknown>;
    /** Default 'waiting' (F1). VOD usa 'processing'. */
    initialStatus?: Extract<TransmissionStatus, 'scheduled' | 'waiting' | 'processing'>;
}

export async function create(input: CreateTransmissionInput): Promise<Transmission> {
    const initialStatus = input.initialStatus ?? 'waiting';
    const now = new Date();

    const [tx] = await db.insert(transmissions).values({
        tenantId: input.tenantId,
        source: input.source,
        programId: input.programId ?? null,
        scheduledJobId: input.scheduledJobId ?? null,
        streamUrl: input.streamUrl ?? null,
        durationMinutes: input.durationMinutes ?? null,
        operationId: input.operationId ?? null,
        pipelineConfig: input.pipelineConfig ?? {},
        status: initialStatus,
        waitingSince: initialStatus === 'waiting' ? now : null,
        startedAt: initialStatus === 'processing' ? now : null,
    }).returning();

    emitTransmissionEvent(input.tenantId, tx.id, initialStatus, { source: tx.source });
    return tx;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getById(tenantId: string, id: string): Promise<Transmission | null> {
    const [tx] = await db.select().from(transmissions)
        .where(and(eq(transmissions.id, id), eq(transmissions.tenantId, tenantId)))
        .limit(1);
    return tx ?? null;
}

export async function getByIdAnyTenant(id: string): Promise<Transmission | null> {
    const [tx] = await db.select().from(transmissions)
        .where(eq(transmissions.id, id))
        .limit(1);
    return tx ?? null;
}

export interface ListTransmissionsFilter {
    status?: TransmissionStatus | TransmissionStatus[];
    programId?: string;
    scheduledJobId?: string;
    limit?: number;
    offset?: number;
    /** 'upcoming' = scheduled/waiting/live primero por createdAt ASC; default = createdAt DESC. */
    order?: 'asc' | 'desc';
}

export async function list(tenantId: string, filter: ListTransmissionsFilter = {}): Promise<Transmission[]> {
    const conditions = [eq(transmissions.tenantId, tenantId)];
    if (filter.status) {
        conditions.push(
            Array.isArray(filter.status)
                ? inArray(transmissions.status, filter.status)
                : eq(transmissions.status, filter.status),
        );
    }
    if (filter.programId) conditions.push(eq(transmissions.programId, filter.programId));
    if (filter.scheduledJobId) conditions.push(eq(transmissions.scheduledJobId, filter.scheduledJobId));

    return db.select().from(transmissions)
        .where(and(...conditions))
        .orderBy(filter.order === 'asc' ? transmissions.createdAt : desc(transmissions.createdAt))
        .limit(filter.limit ?? 50)
        .offset(filter.offset ?? 0);
}

/** Transmissions activas (para el recorder del engine). */
export async function listWaiting(limit = 10): Promise<Transmission[]> {
    return db.select().from(transmissions)
        .where(eq(transmissions.status, 'waiting'))
        .orderBy(transmissions.waitingSince)
        .limit(limit);
}

// ---------------------------------------------------------------------------
// FSM transition
// ---------------------------------------------------------------------------
export interface TransitionOptions {
    errorMessage?: string | null;
    resolvedStreamUrl?: string | null;
    /** Cuando se pasa a 'live' sin startedAt previo, se fija acá (ancla). */
    startedAt?: Date;
    /** Actor para audit (userId o null = sistema). */
    actorUserId?: string | null;
    /** Omite validación de aristas — solo para reconciliación al boot. */
    force?: boolean;
}

export async function transition(
    id: string,
    to: TransmissionStatus,
    opts: TransitionOptions = {},
): Promise<Transmission> {
    const tx = await getByIdAnyTenant(id);
    if (!tx) throw new Error(`Transmission ${id} not found`);

    if (!opts.force && tx.status !== to) {
        const allowed = TRANSITIONS[tx.status] ?? [];
        if (!allowed.includes(to)) {
            throw new TransmissionTransitionError(tx.status, to);
        }
    }
    if (tx.status === to) return tx;

    const now = new Date();
    const patch: Partial<typeof transmissions.$inferInsert> = {
        status: to,
        ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
        ...(opts.resolvedStreamUrl !== undefined ? { resolvedStreamUrl: opts.resolvedStreamUrl } : {}),
    };

    if (to === 'waiting') patch.waitingSince = now;
    if (to === 'live') {
        // startedAt = ancla wall-clock absoluta de la transmisión.
        patch.startedAt = opts.startedAt ?? tx.startedAt ?? now;
        patch.lastHeartbeatAt = now;
    }
    if (TERMINAL.has(to)) {
        patch.endedAt = now;
    }

    const [updated] = await db.update(transmissions)
        .set(patch)
        .where(eq(transmissions.id, id))
        .returning();

    emitTransmissionEvent(tx.tenantId, id, to, {
        previousStatus: tx.status,
        ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
    });

    // Cerrar ejecuciones de scheduler vinculadas en estados terminales.
    if (TERMINAL.has(to)) {
        const execStatus = to === 'done' ? 'completed' : 'failed';
        await db.update(jobExecutions)
            .set({
                status: execStatus,
                finishedAt: now,
                ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
            })
            .where(and(
                eq(jobExecutions.transmissionId, id),
                inArray(jobExecutions.status, ['pending', 'running']),
            ));

        void audit({
            actorUserId: opts.actorUserId ?? null,
            tenantId: tx.tenantId,
            action: `transmission.${to}`,
            metadata: { transmissionId: id, from: tx.status, to, source: tx.source },
        });
    }

    return updated;
}

// ---------------------------------------------------------------------------
// Heartbeat (recorder → transmisión viva)
// ---------------------------------------------------------------------------
export async function heartbeat(id: string): Promise<void> {
    await db.update(transmissions)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(transmissions.id, id));
}

// ---------------------------------------------------------------------------
// Stop solicitado por el usuario — el recorder/looper lo recoge en su poll.
// waiting|live → canceled; la liberación de cuota por captura corta la decide
// finalizeCapture() (llamada por el recorder al cerrar).
// ---------------------------------------------------------------------------
export async function requestStop(tenantId: string, id: string, actorUserId?: string | null): Promise<Transmission> {
    const tx = await getById(tenantId, id);
    if (!tx) throw new Error('Transmission not found');
    return transition(id, 'canceled', { actorUserId });
}

// ---------------------------------------------------------------------------
// Registra una stream_recording + segmento en la transmisión (llamado por el
// recorder / vod_ingest). Devuelve ids para seguir appendeando segmentos.
// ---------------------------------------------------------------------------
export async function ensureRecording(txId: string, storagePrefix: string): Promise<typeof streamRecordings.$inferSelect> {
    const [existing] = await db.select().from(streamRecordings)
        .where(eq(streamRecordings.transmissionId, txId))
        .limit(1);
    if (existing) return existing;

    const [rec] = await db.insert(streamRecordings).values({
        transmissionId: txId,
        storagePrefix,
        status: 'recording',
        startedAt: new Date(),
    }).returning();

    await db.update(transmissions)
        .set({ crudoRef: storagePrefix })
        .where(eq(transmissions.id, txId));
    return rec;
}

export async function addRecordingSegment(input: {
    recordingId: string;
    sequence: number;
    startMs: number;
    endMs?: number | null;
    fileRef: string;
    bytes?: number | null;
}): Promise<typeof recordingSegments.$inferSelect> {
    const [seg] = await db.insert(recordingSegments).values({
        recordingId: input.recordingId,
        sequence: input.sequence,
        startMs: input.startMs,
        endMs: input.endMs ?? null,
        fileRef: input.fileRef,
        bytes: input.bytes ?? null,
    }).onConflictDoUpdate({
        target: [recordingSegments.recordingId, recordingSegments.sequence],
        set: {
            startMs: input.startMs,
            ...(input.endMs !== undefined ? { endMs: input.endMs } : {}),
            fileRef: input.fileRef,
            ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
        },
    }).returning();
    return seg;
}

export async function closeRecordingSegment(recordingId: string, sequence: number, endMs: number, bytes?: number | null): Promise<void> {
    await db.update(recordingSegments)
        .set({ endMs, ...(bytes != null ? { bytes } : {}) })
        .where(and(
            eq(recordingSegments.recordingId, recordingId),
            eq(recordingSegments.sequence, sequence),
        ));
}

export async function completeRecording(recordingId: string, status: 'completed' | 'error', totalBytes?: number): Promise<void> {
    await db.update(streamRecordings)
        .set({ status, endedAt: new Date(), ...(totalBytes != null ? { totalBytes } : {}) })
        .where(eq(streamRecordings.id, recordingId));
}

export async function nextSegmentSequence(recordingId: string): Promise<number> {
    const rows = await db.select({ sequence: recordingSegments.sequence })
        .from(recordingSegments)
        .where(eq(recordingSegments.recordingId, recordingId))
        .orderBy(desc(recordingSegments.sequence))
        .limit(1);
    return (rows[0]?.sequence ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Liberación de cuota por captura corta (usage-quota: fallo < MIN_CAPTURE_MS).
// `capturedMs` = ms efectivamente grabados (o 0 si nunca capturó).
// ---------------------------------------------------------------------------
export async function releaseQuotaIfEarly(tx: Transmission, capturedMs: number): Promise<boolean> {
    if (!tx.operationId || capturedMs >= MIN_CAPTURE_MS) return false;
    const { released } = await releaseQuota(tx.operationId);
    if (released) {
        console.log(`[Transmission] cuota liberada tx=${tx.id} op=${tx.operationId} (captura ${Math.round(capturedMs / 1000)}s < ${MIN_CAPTURE_MS / 1000}s)`);
        void audit({
            tenantId: tx.tenantId,
            action: 'quota.released_early_capture',
            metadata: { transmissionId: tx.id, operationId: tx.operationId, capturedMs },
        });
    }
    return released;
}

// ---------------------------------------------------------------------------
// Reconciliación al boot del engine (T-20 / F1): transmisiones en waiting|live
// |processing con heartbeat viejo quedaron huérfanas (proceso muerto).
//   - waiting huérfana  → error (sin captura → release de cuota)
//   - live huérfana     → si hay segmentos grabados → processing (finaliza el
//                         post-stream con lo que hay); si no → error + release
//   - processing viejo  → processing (reintenta poststream; no se toca)
// Devuelve cuántas reconcilió.
// ---------------------------------------------------------------------------
export async function reconcileOrphanedTransmissions(staleMs = STALE_HEARTBEAT_MS): Promise<number> {
    const cutoff = new Date(Date.now() - staleMs);
    const orphans = await db.select().from(transmissions)
        .where(and(
            inArray(transmissions.status, ['waiting', 'live']),
            or(
                lt(transmissions.lastHeartbeatAt, cutoff),
                and(isNull(transmissions.lastHeartbeatAt), lt(transmissions.updatedAt, cutoff)),
            ),
        ));

    let reconciled = 0;
    for (const tx of orphans) {
        try {
            if (tx.status === 'waiting') {
                await transition(tx.id, 'error', {
                    errorMessage: 'Reconciliación: proceso engine murió durante la espera de live',
                    force: true,
                });
                await releaseQuotaIfEarly(tx, 0);
            } else {
                // live huérfana: ¿hay crudo grabado?
                const [rec] = await db.select({ id: streamRecordings.id })
                    .from(streamRecordings)
                    .where(eq(streamRecordings.transmissionId, tx.id))
                    .limit(1);
                let hasSegments = false;
                if (rec) {
                    const [seg] = await db.select({ id: recordingSegments.id })
                        .from(recordingSegments)
                        .where(eq(recordingSegments.recordingId, rec.id))
                        .limit(1);
                    hasSegments = !!seg;
                }
                if (hasSegments) {
                    await transition(tx.id, 'processing', { force: true });
                    await db.update(streamRecordings)
                        .set({ status: 'completed', endedAt: new Date() })
                        .where(eq(streamRecordings.transmissionId, tx.id));
                } else {
                    await transition(tx.id, 'error', {
                        errorMessage: 'Reconciliación: proceso engine murió sin captura',
                        force: true,
                    });
                    const capturedMs = tx.startedAt ? Date.now() - tx.startedAt.getTime() : 0;
                    await releaseQuotaIfEarly(tx, Math.min(capturedMs, MIN_CAPTURE_MS - 1));
                }
            }
            reconciled++;
        } catch (err) {
            console.error(`[Transmission] reconciliación falló para ${tx.id}:`, err);
        }
    }

    if (reconciled > 0) {
        console.log(`[Transmission] reconciliación al boot: ${reconciled} transmisiones huérfanas resueltas`);
    }
    return reconciled;
}

// ---------------------------------------------------------------------------
// Segments / timeline helpers (consumidos por rutas live — T-34)
// ---------------------------------------------------------------------------
export async function listSegments(txId: string) {
    return db.select().from(transmissionSegments)
        .where(eq(transmissionSegments.transmissionId, txId))
        .orderBy(transmissionSegments.startMs);
}

export async function listAppearances(txId: string) {
    return db.select().from(personAppearances)
        .where(eq(personAppearances.transmissionId, txId))
        .orderBy(personAppearances.startMs);
}

export async function getScheduledJob(id: string | null | undefined) {
    if (!id) return null;
    const [job] = await db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.id, id))
        .limit(1);
    return job ?? null;
}
