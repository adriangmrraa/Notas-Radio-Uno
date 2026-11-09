import type { Express, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { requireAuth } from '../middleware/auth.js';
import { db } from '../db/index.js';
import {
    transmissions,
    transmissionSegments,
    personAppearances,
    persons,
} from '../db/schema/index.js';
import { eq, and, inArray, desc } from 'drizzle-orm';
import * as transmissionService from '../services/transmissionService.js';
import { consume as consumeQuota } from '../services/quotaService.js';
import { correctSpeaker, fuseTransmission } from '../services/attributionService.js';
import { enqueue } from '../services/jobsQueueService.js';
import { emitToTenant } from '../services/notificationService.js';
import { audit } from '../services/auditService.js';
import type { TransmissionStatus } from '../db/schema/transmissions.js';
import { transmissionStatusValues } from '../db/schema/transmissions.js';

// ---------------------------------------------------------------------------
// /api/transmissions + /api/live — Live Room API (T-34) + VOD upload (T-35)
//
//   GET    /api/transmissions                 lista tenant-scoped
//   GET    /api/transmissions/:id             detalle
//   POST   /api/transmissions                 start manual (consume cuota)
//   POST   /api/transmissions/:id/stop        stop → canceled
//   POST   /api/transmissions/upload          VOD → transmission + vod_ingest
//   GET    /api/live/:txId/timeline           segments + speakers + appearances
//   POST   /api/live/:txId/mark               marca manual → render_clip
//   POST   /api/live/:txId/correct            corrección de atribución
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(dirname(__filename), '..', '..', '..');
const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const UPLOAD_TMP = path.join(PROJECT_ROOT, 'uploads');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });

const upload = multer({
    dest: UPLOAD_TMP,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
    fileFilter: (_req, file, cb) => {
        const ok = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav'].includes(file.mimetype)
            || /\.(mp4|webm|mov|mkv|mp3|m4a|wav)$/i.test(file.originalname);
        if (ok) cb(null, true);
        else cb(new Error('Formato no soportado (mp4/webm/mov/mkv/mp3/m4a/wav)'));
    },
});

function asStatus(v: unknown): TransmissionStatus | null {
    if (typeof v !== 'string') return null;
    return (transmissionStatusValues as readonly string[]).includes(v) ? (v as TransmissionStatus) : null;
}

export function registerTransmissionRoutes(app: Express): void {
    // ------------------------------------------------------------------
    // GET /api/transmissions — lista
    // ------------------------------------------------------------------
    app.get('/api/transmissions', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const { status, programId, limit, offset } = req.query as Record<string, string | undefined>;

            const statusFilter = status?.includes(',')
                ? status.split(',').map(asStatus).filter((s): s is TransmissionStatus => !!s)
                : asStatus(status) ?? undefined;

            const rows = await transmissionService.list(tenantId, {
                status: statusFilter,
                programId: programId || undefined,
                limit: Math.min(Number(limit) || 50, 200),
                offset: Number(offset) || 0,
            });
            res.json({ transmissions: rows });
        } catch (error) {
            console.error('[Transmissions] list error:', error);
            res.status(500).json({ error: 'Error al listar transmisiones' });
        }
    });

    // ------------------------------------------------------------------
    // GET /api/transmissions/:id — detalle
    // ------------------------------------------------------------------
    app.get('/api/transmissions/:id', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const tx = await transmissionService.getById(tenantId, String(req.params.id));
            if (!tx) {
                res.status(404).json({ error: 'Transmisión no encontrada' });
                return;
            }
            res.json({ transmission: tx });
        } catch (error) {
            console.error('[Transmissions] get error:', error);
            res.status(500).json({ error: 'Error al obtener la transmisión' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/transmissions — start manual (live_capture o directo)
    // Consume cuota ANTES de crear (operationId manual:{tenant}:{uuid}).
    // ------------------------------------------------------------------
    app.post('/api/transmissions', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = req.body as {
                streamUrl?: string;
                programId?: string | null;
                durationMinutes?: number;
                pipelineConfig?: Record<string, unknown>;
            };
            if (!body.streamUrl?.trim()) {
                res.status(400).json({ error: 'Se requiere streamUrl' });
                return;
            }

            const operationId = `manual:${tenantId}:${randomUUID()}`;
            const quota = await consumeQuota(tenantId, operationId, 'transmission');
            if (!quota.allowed) {
                res.status(402).json({
                    error: 'Cuota de transmisiones agotada',
                    paywall: true,
                    limit: quota.effectiveLimit,
                    count: quota.count,
                    period: quota.period,
                });
                return;
            }

            const tx = await transmissionService.create({
                tenantId,
                source: 'manual',
                programId: body.programId ?? null,
                streamUrl: body.streamUrl.trim(),
                durationMinutes: body.durationMinutes ?? null,
                operationId,
                pipelineConfig: body.pipelineConfig ?? {},
                initialStatus: 'waiting',
            });

            void audit({
                actorUserId: req.auth!.userId,
                tenantId,
                action: 'transmission.manual_start',
                metadata: { transmissionId: tx.id, operationId, streamUrl: body.streamUrl },
            });
            res.status(201).json({ success: true, transmission: tx });
        } catch (error) {
            console.error('[Transmissions] create error:', error);
            res.status(500).json({ error: 'Error al iniciar la transmisión' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/transmissions/:id/stop — detener (canceled; recorder cierra)
    // ------------------------------------------------------------------
    app.post('/api/transmissions/:id/stop', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const tx = await transmissionService.requestStop(tenantId, String(req.params.id), req.auth!.userId);
            res.json({ success: true, transmission: tx });
        } catch (error) {
            const e = error as Error;
            if (e.name === 'TransmissionTransitionError') {
                res.status(409).json({ error: e.message });
                return;
            }
            console.error('[Transmissions] stop error:', error);
            res.status(500).json({ error: 'Error al detener la transmisión' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/transmissions/upload — VOD ingest (T-35)
    // multipart: file + programId? + durationMinutes?
    // → transmission(source='vod_upload', status='processing') → vod_ingest
    // ------------------------------------------------------------------
    app.post('/api/transmissions/upload', requireAuth, upload.single('file'), async (req: Request, res: Response) => {
        const tmpPath = req.file?.path;
        try {
            const tenantId = req.auth!.tenantId;
            if (!req.file) {
                res.status(400).json({ error: 'Se requiere el archivo (campo "file")' });
                return;
            }
            const { programId } = req.body as { programId?: string };

            const operationId = `vod:${tenantId}:${randomUUID()}`;
            const quota = await consumeQuota(tenantId, operationId, 'transmission');
            if (!quota.allowed) {
                res.status(402).json({
                    error: 'Cuota de transmisiones agotada',
                    paywall: true,
                    limit: quota.effectiveLimit,
                    count: quota.count,
                    period: quota.period,
                });
                return;
            }

            const tx = await transmissionService.create({
                tenantId,
                source: 'vod_upload',
                programId: programId ?? null,
                operationId,
                initialStatus: 'processing',
            });

            // Mover el archivo al storagePrefix del tx
            const ext = path.extname(req.file.originalname) || '.mp4';
            const storagePrefix = `${tenantId}/${tx.id}`;
            const outDir = path.join(MEDIA_ROOT, storagePrefix);
            await fsp.mkdir(outDir, { recursive: true });
            const fileRef = `${storagePrefix}/upload${ext}`;
            await fsp.rename(tmpPath!, path.join(outDir, `upload${ext}`));

            await db.update(transmissions)
                .set({ streamUrl: null })
                .where(eq(transmissions.id, tx.id));

            await enqueue('vod_ingest', {
                transmissionId: tx.id,
                tenantId,
                fileRef,
            }, { tenantId, dedupKey: `vod:${tx.id}` });

            void audit({
                actorUserId: req.auth!.userId,
                tenantId,
                action: 'transmission.vod_upload',
                metadata: { transmissionId: tx.id, fileRef, bytes: req.file.size },
            });
            res.status(201).json({ success: true, transmission: tx });
        } catch (error) {
            if (tmpPath) await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
            console.error('[Transmissions] upload error:', error);
            res.status(500).json({ error: 'Error al subir el video' });
        }
    });

    // ------------------------------------------------------------------
    // GET /api/live/:txId/timeline — sala en vivo
    // Devuelve: tx + transmission_segments + speakers únicos + appearances.
    // ------------------------------------------------------------------
    app.get('/api/live/:txId/timeline', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const tx = await transmissionService.getById(tenantId, String(req.params.txId));
            if (!tx) {
                res.status(404).json({ error: 'Transmisión no encontrada' });
                return;
            }

            const [segments, appearances] = await Promise.all([
                transmissionService.listSegments(tx.id),
                transmissionService.listAppearances(tx.id),
            ]);

            // Resolver nombres de personas referenciadas en appearances
            const personIds = Array.from(new Set(appearances.map((a) => a.personId).filter((x): x is string => !!x)));
            const people = personIds.length
                ? await db.select({ id: persons.id, name: persons.name, role: persons.role })
                    .from(persons)
                    .where(and(inArray(persons.id, personIds), eq(persons.tenantId, tenantId)))
                : [];
            const peopleById = new Map(people.map((p) => [p.id, p]));

            const speakers = new Set<string>();
            for (const seg of segments) {
                for (const s of (seg.speakers as string[] | null) ?? []) speakers.add(s);
            }
            for (const a of appearances) if (a.speakerLabel) speakers.add(a.speakerLabel);

            res.json({
                transmission: tx,
                segments,
                speakers: Array.from(speakers),
                appearances: appearances.map((a) => ({
                    ...a,
                    person: a.personId ? peopleById.get(a.personId) ?? null : null,
                })),
            });
        } catch (error) {
            console.error('[Live] timeline error:', error);
            res.status(500).json({ error: 'Error al obtener el timeline' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/live/:txId/mark — marca manual → segment(mark) + render_clip
    // body: { startMs, endMs, label? }
    // ------------------------------------------------------------------
    app.post('/api/live/:txId/mark', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const tx = await transmissionService.getById(tenantId, String(req.params.txId));
            if (!tx) {
                res.status(404).json({ error: 'Transmisión no encontrada' });
                return;
            }

            const { startMs, endMs, label } = req.body as { startMs?: number; endMs?: number; label?: string };
            if (typeof startMs !== 'number' || typeof endMs !== 'number' || startMs < 0 || endMs <= startMs) {
                res.status(400).json({ error: 'startMs/endMs inválidos (endMs > startMs >= 0)' });
                return;
            }

            const [mark] = await db.insert(transmissionSegments).values({
                transmissionId: tx.id,
                tenantId,
                kind: 'mark',
                title: label?.trim() || 'Marca manual',
                startMs: Math.round(startMs),
                endMs: Math.round(endMs),
                payload: { createdBy: req.auth!.userId, manual: true },
            }).returning();

            const job = await enqueue('render_clip', {
                transmissionId: tx.id,
                tenantId,
                transmissionSegmentId: mark.id,
                startMs: Math.round(startMs),
                endMs: Math.round(endMs),
                hookText: label?.trim() || 'Marca manual',
                manual: true,
            }, { tenantId, dedupKey: `renderclip:${tx.id}:${mark.id}` });

            emitToTenant(tenantId, 'transmission:update', { transmissionId: tx.id, markAdded: mark.id });
            res.status(201).json({ success: true, segment: mark, renderJobId: job.id });
        } catch (error) {
            console.error('[Live] mark error:', error);
            res.status(500).json({ error: 'Error al crear la marca' });
        }
    });

    // ------------------------------------------------------------------
    // POST /api/live/:txId/correct — corrección de atribución (T-26)
    //
    //   a) { appearanceId, personId|null } → re-etiqueta una aparición
    //      (personId null → desasignar). Marca source='manual'.
    //   b) { speakerLabel, personId|null } → corrección de speaker:
    //      re-etiqueta TODAS las appearances emitidas con ese label
    //      (backward) y fija el mapa label→persona (forward) vía
    //      attributionService.correctSpeaker.
    //   c) { startMs, endMs, speakerLabel?, personId } → aparición manual
    //      nueva sobre una ventana puntual.
    //   d) { kind:'auto' } → re-corre la fusión sobre las ventanas speaker
    //      de transmission_segments (attributionService.fuseTransmission).
    // ------------------------------------------------------------------
    app.post('/api/live/:txId/correct', requireAuth, async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const tx = await transmissionService.getById(tenantId, String(req.params.txId));
            if (!tx) {
                res.status(404).json({ error: 'Transmisión no encontrada' });
                return;
            }

            const body = req.body as {
                appearanceId?: string;
                personId?: string | null;
                startMs?: number;
                endMs?: number;
                speakerLabel?: string;
                kind?: 'manual' | 'auto';
            };

            // (d) re-fusión automática de la transmisión
            if (body.kind === 'auto') {
                const { fused } = await fuseTransmission(tx.id);
                emitToTenant(tenantId, 'transmission:update', { transmissionId: tx.id, refused: fused });
                void audit({ actorUserId: req.auth!.userId, tenantId, action: 'live.attribution_refused', metadata: { transmissionId: tx.id, fused } });
                res.json({ success: true, fused });
                return;
            }

            // (a) re-etiquetar aparición existente
            if (body.appearanceId) {
                if (body.personId !== undefined && body.personId !== null) {
                    const [person] = await db.select({ id: persons.id }).from(persons)
                        .where(and(eq(persons.id, body.personId), eq(persons.tenantId, tenantId)))
                        .limit(1);
                    if (!person) {
                        res.status(400).json({ error: 'personId no existe en este tenant' });
                        return;
                    }
                }
                const [updated] = await db.update(personAppearances)
                    .set({
                        personId: body.personId ?? null,
                        source: 'manual',
                    })
                    .where(and(
                        eq(personAppearances.id, body.appearanceId),
                        eq(personAppearances.transmissionId, tx.id),
                        eq(personAppearances.tenantId, tenantId),
                    ))
                    .returning();
                if (!updated) {
                    res.status(404).json({ error: 'Aparición no encontrada en esta transmisión' });
                    return;
                }
                emitToTenant(tenantId, 'transmission:update', { transmissionId: tx.id, appearanceCorrected: updated.id });
                void audit({ actorUserId: req.auth!.userId, tenantId, action: 'live.appearance_corrected', metadata: { transmissionId: tx.id, appearanceId: updated.id, personId: updated.personId } });
                res.json({ success: true, appearance: updated });
                return;
            }

            // (b) corrección de speaker label — backward + forward (T-26)
            if (body.speakerLabel && body.startMs === undefined && body.endMs === undefined) {
                const { updated } = await correctSpeaker({
                    txId: tx.id,
                    speakerLabel: body.speakerLabel,
                    personId: body.personId ?? null,
                    actorUserId: req.auth!.userId,
                });
                res.json({ success: true, updated });
                return;
            }

            // (c) aparición manual nueva
            const { startMs, endMs, speakerLabel, personId } = body;
            if (typeof startMs !== 'number' || typeof endMs !== 'number' || startMs < 0 || endMs <= startMs || !personId) {
                res.status(400).json({ error: 'Se requiere appearanceId, {speakerLabel, personId} o {startMs, endMs, personId} válidos' });
                return;
            }
            const [person] = await db.select({ id: persons.id }).from(persons)
                .where(and(eq(persons.id, personId), eq(persons.tenantId, tenantId)))
                .limit(1);
            if (!person) {
                res.status(400).json({ error: 'personId no existe en este tenant' });
                return;
            }
            const [appearance] = await db.insert(personAppearances).values({
                transmissionId: tx.id,
                tenantId,
                personId,
                speakerLabel: speakerLabel ?? null,
                source: 'manual',
                startMs: Math.round(startMs),
                endMs: Math.round(endMs),
                confidence: '1',
            }).returning();

            emitToTenant(tenantId, 'transmission:update', { transmissionId: tx.id, appearanceAdded: appearance.id });
            void audit({ actorUserId: req.auth!.userId, tenantId, action: 'live.appearance_added_manual', metadata: { transmissionId: tx.id, appearanceId: appearance.id, personId } });
            res.status(201).json({ success: true, appearance });
        } catch (error) {
            console.error('[Live] correct error:', error);
            res.status(500).json({ error: 'Error en la corrección' });
        }
    });
}
