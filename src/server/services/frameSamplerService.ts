import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { db } from '../db/index.js';
import {
    recordingSegments,
    streamRecordings,
    transmissions,
    personAppearances,
} from '../db/schema/index.js';
import { eq, and, sql, inArray, gte, lt, isNotNull } from 'drizzle-orm';
import { detectFaces, checkFaceHealth, matchFace } from './faceService.js';
import { resolveFeature } from './featureFlagService.js';
import { emitToTenant } from './notificationService.js';
import { recordAiCost } from './aiCostMeter.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// frameSamplerService — watcher de segmentos completados → rostros (T-25)
//
//   recording_segments cerrados (end_ms NOT NULL) ──poll──► ffmpeg -vf fps=1
//   → frames/*.jpg → POST face:8000/detect → match face_embeddings del tenant
//   (cosine en app, umbral ~0.5) → person_appearances(source='face',
//   personId?, bbox normalizado [0..1], startMs/endMs wall-clock).
//
//   - Corre SOLO en el engine (loop, no job): un segmento por tick, backlog
//     de las últimas FRAME_SAMPLE_MAX_AGE_H horas. Idempotente: antes de
//     insertar borra las appearances 'face' de la ventana del segmento —
//     retries/restarts reprocesan sin duplicar.
//   - Degradación: flag face_attribution off → skip; face service caído →
//     no marca el segmento y reintenta en el próximo tick (spec: nunca
//     fatal, speakers quedan genéricos).
//   - bbox se guarda NORMALIZADO [0..1] respecto del frame (clipCutter lo
//     escala a la resolución del crudo).
// ---------------------------------------------------------------------------

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');

function findBinary(name: string): string {
    const toolsPath = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(toolsPath)) return toolsPath;
    return name;
}
const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

const POLL_MS = Number(process.env.FRAME_SAMPLER_POLL_MS ?? 10_000);
const FPS = Number(process.env.FRAME_SAMPLER_FPS ?? 1);
const MAX_AGE_H = Number(process.env.FRAME_SAMPLE_MAX_AGE_H ?? 24);
const MAX_FRAMES = Number(process.env.FRAME_SAMPLE_MAX_FRAMES ?? 90);
const CANDIDATES_PER_TICK = 10;

// Segmentos ya procesados en esta vida del proceso (idempotencia in-memory;
// el delete+insert previo a escribir appearances lo hace seguro ante restart).
const processedIds = new Set<string>();

interface SegmentRow {
    segmentId: string;
    fileRef: string;
    startMs: number;
    endMs: number;
    transmissionId: string;
    tenantId: string;
}

/** Segmentos cerrados, activos, recientes y de transmisiones con pipeline. */
async function nextUnprocessedSegment(): Promise<SegmentRow | null> {
    const cutoff = new Date(Date.now() - MAX_AGE_H * 3_600_000);
    const rows = await db.select({
        segmentId: recordingSegments.id,
        fileRef: recordingSegments.fileRef,
        startMs: recordingSegments.startMs,
        endMs: recordingSegments.endMs,
        transmissionId: streamRecordings.transmissionId,
        tenantId: transmissions.tenantId,
    })
        .from(recordingSegments)
        .innerJoin(streamRecordings, eq(recordingSegments.recordingId, streamRecordings.id))
        .innerJoin(transmissions, eq(streamRecordings.transmissionId, transmissions.id))
        .where(and(
            eq(recordingSegments.status, 'active'),
            isNotNull(recordingSegments.endMs),
            gte(recordingSegments.createdAt, cutoff),
            inArray(transmissions.status, ['live', 'processing', 'done', 'error', 'canceled']),
        ))
        .orderBy(recordingSegments.createdAt)
        .limit(100);

    for (const r of rows.slice(0, CANDIDATES_PER_TICK)) {
        if (processedIds.has(r.segmentId)) continue;
        if (r.endMs == null || r.endMs <= r.startMs) { processedIds.add(r.segmentId); continue; }
        return { ...r, endMs: r.endMs } as SegmentRow;
    }
    return null;
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe helpers
// ---------------------------------------------------------------------------
async function probeVideoSize(filePath: string): Promise<{ width: number; height: number } | null> {
    try {
        const { stdout } = await execFileAsync(FFPROBE, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0:s=x', filePath,
        ], { timeout: 20_000 });
        const m = /(\d+)x(\d+)/.exec(stdout.trim());
        if (!m) return null;
        return { width: Number(m[1]), height: Number(m[2]) };
    } catch {
        return null;
    }
}

async function extractFrames(videoPath: string, outDir: string): Promise<string[]> {
    const pattern = path.join(outDir, 'frame-%03d.jpg');
    await execFileAsync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error',
        '-i', videoPath,
        '-vf', `fps=${FPS}`,
        '-q:v', '3',
        '-frames:v', String(MAX_FRAMES),
        '-y', pattern,
    ], { timeout: 120_000 });
    const files = (await fsp.readdir(outDir)).filter((f) => f.startsWith('frame-') && f.endsWith('.jpg')).sort();
    return files.map((f) => path.join(outDir, f));
}

// ---------------------------------------------------------------------------
// Detections → runs → person_appearances
// ---------------------------------------------------------------------------
interface FrameDetection {
    frameIdx: number;
    personId: string | null;
    similarity: number;
    bboxNorm: [number, number, number, number];
    /** área relativa — para elegir el rostro "principal" al mergear */
    area: number;
}

interface AppearanceRun {
    personId: string | null;
    startMs: number;
    endMs: number;
    bboxNorm: [number, number, number, number];
    sims: number[];
}

/**
 * Mergea detecciones por persona en ventanas contiguas (mismo personId en
 * frames consecutivos → una sola appearance). Spec: "Martín de 00:10 a
 * 00:14" → una fila, no 240.
 */
function mergeRuns(detections: FrameDetection[], segStartMs: number, frameStepMs: number): AppearanceRun[] {
    const byPerson = new Map<string | null, FrameDetection[]>();
    for (const d of detections) {
        const arr = byPerson.get(d.personId) ?? [];
        arr.push(d);
        byPerson.set(d.personId, arr);
    }

    const runs: AppearanceRun[] = [];
    for (const [personId, dets] of byPerson) {
        dets.sort((a, b) => a.frameIdx - b.frameIdx);
        let cur: AppearanceRun | null = null;
        for (const d of dets) {
            const startMs = segStartMs + d.frameIdx * frameStepMs;
            const contiguous = cur !== null && d.frameIdx * frameStepMs + segStartMs - cur.endMs <= frameStepMs * 1.5;
            if (!cur || !contiguous) {
                if (cur) runs.push(cur);
                cur = { personId, startMs, endMs: startMs + frameStepMs, bboxNorm: d.bboxNorm, sims: [d.similarity] };
            } else {
                cur.endMs = startMs + frameStepMs;
                // bbox: último rostro conocido del run (spec: para el crop)
                cur.bboxNorm = d.bboxNorm;
                cur.sims.push(d.similarity);
            }
        }
        if (cur) runs.push(cur);
    }
    return runs.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// Procesamiento de UN segmento
// ---------------------------------------------------------------------------
async function processSegment(seg: SegmentRow): Promise<'done' | 'skipped' | 'retry'> {
    const flag = await resolveFeature(seg.tenantId, 'face_attribution').catch(() => false);
    if (flag !== true) return 'skipped';

    // Fast-path post-restart: si la ventana YA tiene appearances 'face' el
    // segmento ya se muestreó en otra vida del proceso (processedIds es
    // in-memory). Evita re-extraer todo el backlog tras un reboot.
    const [existing] = await db.select({ id: personAppearances.id })
        .from(personAppearances)
        .where(and(
            eq(personAppearances.transmissionId, seg.transmissionId),
            eq(personAppearances.source, 'face'),
            gte(personAppearances.startMs, seg.startMs),
            lt(personAppearances.startMs, seg.endMs),
        ))
        .limit(1);
    if (existing) return 'skipped';

    const filePath = path.isAbsolute(seg.fileRef) ? seg.fileRef : path.join(MEDIA_ROOT, seg.fileRef);
    if (!fs.existsSync(filePath)) {
        // Archivo no está (purgado/volumen distinto) → no reintentar.
        console.warn(`[FrameSampler] archivo ausente para seg=${seg.segmentId} (${seg.fileRef}) — skip permanente`);
        return 'skipped';
    }

    const size = await probeVideoSize(filePath);
    if (!size) {
        console.warn(`[FrameSampler] ffprobe falló seg=${seg.segmentId} — skip permanente`);
        return 'skipped';
    }

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `frames-${seg.segmentId.slice(0, 8)}-`));
    try {
        const frames = await extractFrames(filePath, workDir);
        const frameStepMs = Math.round(1000 / FPS);
        const detections: FrameDetection[] = [];

        for (let i = 0; i < frames.length; i++) {
            const buf = await fsp.readFile(frames[i]);
            let faces;
            try {
                faces = await detectFaces(buf);
            } catch (err) {
                // Si el servicio murió a mitad del segmento → retry el tick próximo.
                const alive = await checkFaceHealth(true);
                if (!alive) {
                    console.warn(`[FrameSampler] face service caído a mitad de seg=${seg.segmentId} — retry`);
                    return 'retry';
                }
                console.warn(`[FrameSampler] detect falló frame ${i} seg=${seg.segmentId}:`, err instanceof Error ? err.message : err);
                continue;
            }

            for (const face of faces) {
                const [x, y, w, h] = face.bbox;
                const match = await matchFace(seg.tenantId, face.embedding).catch(() => null);
                detections.push({
                    frameIdx: i,
                    personId: match?.personId ?? null,
                    similarity: match?.similarity ?? 0,
                    bboxNorm: [x / size.width, y / size.height, w / size.width, h / size.height],
                    area: (w * h) / (size.width * size.height),
                });
            }
        }

        // Idempotencia: reemplazar appearances 'face' de ESTA ventana.
        await db.delete(personAppearances).where(and(
            eq(personAppearances.transmissionId, seg.transmissionId),
            eq(personAppearances.source, 'face'),
            gte(personAppearances.startMs, seg.startMs),
            lt(personAppearances.startMs, seg.endMs),
        ));

        const runs = mergeRuns(detections, seg.startMs, frameStepMs);
        for (const run of runs) {
            const avgSim = run.sims.length ? run.sims.reduce((a, b) => a + b, 0) / run.sims.length : 0;
            await db.insert(personAppearances).values({
                transmissionId: seg.transmissionId,
                tenantId: seg.tenantId,
                personId: run.personId,
                speakerLabel: null,
                source: 'face',
                startMs: Math.round(run.startMs),
                endMs: Math.round(run.endMs),
                confidence: avgSim.toFixed(3),
                bbox: run.bboxNorm,
            });
        }

        void recordAiCost({
            tenantId: seg.tenantId,
            transmissionId: seg.transmissionId,
            provider: 'insightface',
            kind: 'face',
            units: frames.length,
            unit: 'frames',
            costEstimateUsd: 0, // self-hosted — costo infra, no por llamada
        });

        if (runs.length > 0) {
            emitToTenant(seg.tenantId, 'transmission:update', {
                transmissionId: seg.transmissionId,
                facesDetected: runs.length,
            });
        }
        console.log(`[FrameSampler] seg=${seg.segmentId} → ${frames.length} frames, ${detections.length} caras, ${runs.length} appearances`);
        return 'done';
    } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

// ---------------------------------------------------------------------------
// Loop del engine — un segmento por tick (carga acotada).
// ---------------------------------------------------------------------------
let loopTimer: NodeJS.Timeout | null = null;
let busy = false;

export function startFrameSamplerLoop(): { stop: () => void } {
    if (loopTimer) return { stop: () => { if (loopTimer) clearInterval(loopTimer); loopTimer = null; } };

    const tick = async () => {
        if (busy) return;
        busy = true;
        try {
            const seg = await nextUnprocessedSegment();
            if (!seg) return;

            const result = await processSegment(seg);
            if (result === 'done' || result === 'skipped') {
                processedIds.add(seg.segmentId);
            }
            // 'retry' → queda sin marcar: el próximo tick lo retoma.
        } catch (err) {
            console.error('[FrameSampler] tick error:', err);
        } finally {
            busy = false;
        }
    };

    loopTimer = setInterval(() => { void tick(); }, POLL_MS);
    void tick();
    console.log(`[FrameSampler] loop started (poll ${POLL_MS}ms, fps=${FPS}, maxAge=${MAX_AGE_H}h)`);

    return {
        stop: () => {
            if (loopTimer) clearInterval(loopTimer);
            loopTimer = null;
        },
    };
}
