import { Router, type Request, type Response } from 'express';
import type { Server } from 'socket.io';

import { reconcileOrphanedTransmissions, type Transmission } from './services/transmissionService.js';
import { registerJobHandler, startWorker } from './services/jobsQueueService.js';
import { startRecorderLoop, setAudioTapHooks } from './services/streamRecorderService.js';
import { initJobScheduler } from './services/jobSchedulerService.js';
import { initDossierScheduler } from './services/dossierService.js';
import { handlePoststreamAnalysis, type PoststreamPayload } from './services/poststreamAnalysisService.js';
import { handleVodIngest, type VodIngestPayload } from './services/vodIngestService.js';
import { handleDunningCycle } from './services/dunningService.js';
import { handleRenderClip, type RenderClipPayload } from './services/clipCutterService.js';
import { handlePurgeRecording, startPurgeLoop, type PurgeRecordingPayload } from './services/recordingPurgeService.js';
import { startFrameSamplerLoop } from './services/frameSamplerService.js';
import { ingestUtterances } from './services/attributionService.js';
import { AutoPipeline } from './services/pipelineService.js';
import { emitToTenant, INTERNAL_EMIT_SECRET } from './services/notificationService.js';
import { jobNotify } from './services/notificationService.js';
import type { PipelineConfig } from '../shared/types.js';

// ---------------------------------------------------------------------------
// engine.ts — bootstrap del proceso ENGINE (T-20 / D1)
//
//   PROCESS_ROLE=engine   → solo esto: loops + workers + recorder + purges +
//                           dunning + scheduler. NO levanta rutas API.
//   PROCESS_ROLE=combined → API + engine en el mismo proceso (dev default).
//   PROCESS_ROLE=api      → jamás se llama initEngine (sin loops).
//
//   El engine no tiene Socket.IO real: los eventos salen por emitToTenant →
//   POST {API_INTERNAL_URL}/internal/emit con x-internal-token (relay a la API).
// ---------------------------------------------------------------------------

// ── Socket shim para AutoPipeline dentro del engine ─────────────────────────
// AutoPipeline espera un Server; acá solo necesitamos .to(room).emit y .emit.
// Todo se reenvía por emitToTenant (que usa io real en combined o relay HTTP).
function makeIoShim(tenantId: string): Server {
    const emit = (event: string, data: unknown) => {
        emitToTenant(tenantId, event, (data ?? {}) as Record<string, unknown>);
    };
    return {
        to: (_room: string) => ({ emit }),
        emit,
    } as unknown as Server;
}

// ── Audio tap (D3) — un AutoPipeline por transmisión live ───────────────────
const audioTaps = new Map<string, AutoPipeline>();

function startAudioTap(tx: Transmission): void {
    if (audioTaps.has(tx.id)) return;
    const tenantId = tx.tenantId;
    const pipeline = new AutoPipeline(makeIoShim(tenantId), tenantId);
    audioTaps.set(tx.id, pipeline);

    const cfg = (tx.pipelineConfig ?? {}) as Partial<PipelineConfig>;
    pipeline.setTransmissionContext({
        transmissionId: tx.id,
        startedAt: tx.startedAt ?? new Date(),
        programId: tx.programId,
    });

    // T-26: utterances alineadas a wall-clock → fusión speaker↔rostro en vivo.
    pipeline.setUtteranceSink((utterances) => {
        void ingestUtterances(tx.id, utterances).catch((e) =>
            console.warn(`[Engine] ingestUtterances tx=${tx.id}:`, e instanceof Error ? e.message : e),
        );
    });

    // Espejo de eventos del canvas → notificaciones del tenant (como hacía el
    // scheduler legacy). En engine sale por relay; en combined por io directo.
    const originalEmit = (pipeline as unknown as { emit: (e: string, d: Record<string, unknown>) => void }).emit.bind(pipeline);
    (pipeline as unknown as { emit: (e: string, d: Record<string, unknown>) => void }).emit = (event, data) => {
        originalEmit(event, data);
        const handler: (() => Promise<unknown>) | undefined = ({
            step: () => jobNotify.pipelineStep(tenantId, tx.scheduledJobId ?? tx.id, data),
            detail: () => jobNotify.pipelineDetail(tenantId, tx.scheduledJobId ?? tx.id, data),
            transcription: () => jobNotify.pipelineTranscription(tenantId, tx.scheduledJobId ?? tx.id, data),
            note: () => jobNotify.pipelineNote(tenantId, tx.scheduledJobId ?? tx.id, data),
            flyer: () => jobNotify.pipelineFlyer(tenantId, tx.scheduledJobId ?? tx.id, data),
            published: () => jobNotify.pipelinePublished(tenantId, tx.scheduledJobId ?? tx.id, data),
            error: () => jobNotify.pipelineError(tenantId, tx.scheduledJobId ?? tx.id, data),
        } as Record<string, () => Promise<unknown>>)[event];
        if (handler) handler().catch(() => undefined);
    };

    const url = tx.resolvedStreamUrl ?? tx.streamUrl;
    if (!url) {
        console.warn(`[Engine] audio tap sin URL para tx=${tx.id}`);
        audioTaps.delete(tx.id);
        return;
    }

    pipeline.start({
        url,
        tone: cfg.tone ?? 'formal',
        structure: cfg.structure ?? 'completa',
        imageModel: cfg.imageModel ?? 'gemini',
        segmentDuration: cfg.segmentDuration ?? 120,
        autoPublish: cfg.autoPublish !== false,
        ...(tx.programId ? { programId: tx.programId } : {}),
    }).catch((err) => {
        console.error(`[Engine] audio tap tx=${tx.id} terminó con error:`, err instanceof Error ? err.message : err);
        audioTaps.delete(tx.id);
    });
    console.log(`[Engine] audio tap iniciado tx=${tx.id}`);
}

function stopAudioTap(tx: Transmission): void {
    const pipeline = audioTaps.get(tx.id);
    if (!pipeline) return;
    try {
        pipeline.stop();
    } catch (e) {
        console.warn(`[Engine] stop audio tap tx=${tx.id}:`, e instanceof Error ? e.message : e);
    }
    audioTaps.delete(tx.id);
}

// ---------------------------------------------------------------------------
// initEngine — arranque de todos los loops/workers del engine
// ---------------------------------------------------------------------------
export interface EngineHandle {
    stop: () => void;
}

const DUNNING_CYCLE_MS = Number(process.env.DUNNING_CYCLE_MS ?? 6 * 60 * 60 * 1000);

export async function initEngine(opts: { io: Server | null }): Promise<EngineHandle> {
    console.log('[Engine] initEngine — reconciliando transmisiones huérfanas…');
    try {
        await reconcileOrphanedTransmissions();
    } catch (err) {
        console.error('[Engine] reconciliación falló (seguimos igual):', err);
    }

    // ── Handlers de la cola ─────────────────────────────────────────────────
    registerJobHandler<PoststreamPayload>('poststream_analysis', (p) => handlePoststreamAnalysis(p));
    registerJobHandler<VodIngestPayload>('vod_ingest', (p) => handleVodIngest(p));
    registerJobHandler('dunning_cycle', () => handleDunningCycle({}).then(() => undefined));
    registerJobHandler<RenderClipPayload>('render_clip', (p) => handleRenderClip(p).then(() => undefined));
    registerJobHandler<PurgeRecordingPayload>('purge_recording', (p) => handlePurgeRecording(p));

    // ── Workers + loops ─────────────────────────────────────────────────────
    const worker = startWorker({ workerId: `engine-${process.pid}` });
    const recorder = startRecorderLoop();
    const frameSampler = startFrameSamplerLoop(); // T-25: rostros por segmento
    const purgeLoop = startPurgeLoop();           // T-36: retención + disco
    initJobScheduler(opts.io ?? undefined);
    initDossierScheduler();

    // Audio tap: el recorder levanta el tap al pasar waiting→live (D3).
    setAudioTapHooks({ start: startAudioTap, stop: stopAudioTap });

    // ── Dunning periódico (además de jobs 'dunning_cycle' puntuales) ────────
    const dunningTimer = setInterval(() => {
        handleDunningCycle({}).catch((e) => console.error('[Engine] dunning tick:', e));
    }, DUNNING_CYCLE_MS);

    console.log('[Engine] listo — scheduler + workers + recorder + dunning');

    return {
        stop: () => {
            worker.stop();
            recorder.stop();
            frameSampler.stop();
            purgeLoop.stop();
            clearInterval(dunningTimer);
            for (const [, p] of audioTaps) {
                try { p.stop(); } catch { /* ignore */ }
            }
            audioTaps.clear();
        },
    };
}

// ---------------------------------------------------------------------------
// /internal/emit — relay engine→api de eventos Socket.IO (T-20)
// Auth: header x-internal-token = INTERNAL_EMIT_SECRET.
// Se monta en la app de la API (y en combined es no-op porque ioRef emite local).
// ---------------------------------------------------------------------------
export function createInternalEmitRouter(io: Server): Router {
    const router = Router();

    router.post('/internal/emit', (req: Request, res: Response) => {
        const token = req.headers['x-internal-token'];
        if (token !== INTERNAL_EMIT_SECRET) {
            res.status(403).json({ error: 'Invalid internal token' });
            return;
        }
        const { tenantId, event, payload } = req.body as {
            tenantId?: string;
            event?: string;
            payload?: Record<string, unknown>;
        };
        if (!tenantId || !event) {
            res.status(400).json({ error: 'tenantId y event son requeridos' });
            return;
        }
        io.to(`tenant:${tenantId}`).emit(event, payload ?? {});
        res.json({ ok: true });
    });

    return router;
}
