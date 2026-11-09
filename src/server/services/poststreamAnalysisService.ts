import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { db } from '../db/index.js';
import {
    streamRecordings,
    recordingSegments,
    transmissionSegments,
} from '../db/schema/index.js';
import { eq, and, asc, sql } from 'drizzle-orm';

import { transcribeAudio } from './transcriptionService.js';
import { extractInsights } from './insightService.js';
import { analyzeTopicSegments, extractSegmentText } from './topicService.js';
import { detectHighlights } from './clipService.js';
import { listForTransmission } from './personService.js';
import { ingestUtterances } from './attributionService.js';
import { enqueue } from './jobsQueueService.js';
import { getPlanLimits } from './quotaService.js';
import { transition, getByIdAnyTenant } from './transmissionService.js';
import { recordAiCost } from './aiCostMeter.js';
import { notify } from './notificationService.js';
import { audit } from './auditService.js';
import { createTranscription } from './databaseService.js';
import type { Utterance } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// poststreamAnalysisService — análisis wall-clock post-transmisión (T-30)
//
// Job 'poststream_analysis' (encolado por el recorder al cerrar captura):
//   1. Extrae audio de cada recording_segment (ffmpeg -vn) y transcribe.
//   2. ALINEA utterances al wall-clock: offset utterance + segment.startMs
//      (segment.startMs ya es relativo a transmissions.startedAt — el ancla).
//   3. Temas → transmission_segments(kind='topic') con startMs/endMs.
//   4. Momentos → transmission_segments(kind='moment') + jobs render_clip
//      respetando plans.max_clips_per_transmission.
//   5. Metering IA por evento (aiCostMeter) con transmissionId.
//   6. Transcripción persistida + tx → done + notificación.
// ---------------------------------------------------------------------------

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');
const FFMPEG = fs.existsSync(path.join(TOOLS_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
    ? path.join(TOOLS_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : 'ffmpeg';
const DEFAULT_MAX_CLIPS = Number(process.env.MAX_CLIPS_PER_TRANSMISSION ?? 3);

export interface PoststreamPayload {
    transmissionId: string;
    tenantId: string;
    capturedMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function extractAudio(videoPath: string, outPath: string): Promise<void> {
    await execFileAsync(FFMPEG, [
        '-hide_banner', '-loglevel', 'error',
        '-i', videoPath,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
        '-y', outPath,
    ], { timeout: 120_000 });
}

/** Límite de clips del plan del tenant (default si el plan no lo define). */
async function getMaxClipsPerTransmission(tenantId: string): Promise<number> {
    const limits = await getPlanLimits(tenantId);
    return limits.maxClipsPerTransmission ?? DEFAULT_MAX_CLIPS;
}

/** render_clip ya encolados para esta tx (idempotencia de re-runs). */
async function countEnqueuedClips(transmissionId: string): Promise<number> {
    const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM "jobs_queue"
        WHERE "type" = 'render_clip'
          AND "payload"->>'transmissionId' = ${transmissionId}
          AND "status" IN ('pending','running','done')
    `);
    return Number((rows.rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** Fracción del texto → ms aproximados usando el último utterance como escala. */
function estimateRangeMs(fullText: string, segmentText: string, totalMs: number): { startMs: number; endMs: number } | null {
    if (!fullText || !segmentText || totalMs <= 0) return null;
    const idx = fullText.indexOf(segmentText.slice(0, Math.min(80, segmentText.length)));
    if (idx < 0) return null;
    const frac = idx / Math.max(1, fullText.length);
    const endFrac = Math.min(1, (idx + segmentText.length) / Math.max(1, fullText.length));
    return {
        startMs: Math.round(frac * totalMs),
        endMs: Math.round(endFrac * totalMs),
    };
}

// ---------------------------------------------------------------------------
// Handler principal — registrado en el engine para 'poststream_analysis'
// ---------------------------------------------------------------------------
export async function handlePoststreamAnalysis(payload: PoststreamPayload): Promise<void> {
    const { transmissionId, tenantId } = payload;
    const tx = await getByIdAnyTenant(transmissionId);
    if (!tx) throw new Error(`Transmission ${transmissionId} no encontrada`);
    if (tx.tenantId !== tenantId) throw new Error('tenant mismatch en poststream_analysis');
    if (tx.status === 'done' || tx.status === 'error' || tx.status === 'canceled') {
        console.log(`[Poststream] tx=${transmissionId} ya terminal (${tx.status}) — skip`);
        return;
    }
    if (tx.status !== 'processing') {
        await transition(transmissionId, 'processing', { force: true });
    }

    const [recording] = await db.select().from(streamRecordings)
        .where(eq(streamRecordings.transmissionId, transmissionId)).limit(1);
    if (!recording) throw new Error(`Sin stream_recording para tx=${transmissionId}`);

    const segments = await db.select().from(recordingSegments)
        .where(and(eq(recordingSegments.recordingId, recording.id), eq(recordingSegments.status, 'active')))
        .orderBy(asc(recordingSegments.sequence));

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `poststream-${transmissionId.slice(0, 8)}-`));

    try {
        // ── 1. Transcribir segmento por segmento → utterances wall-clock ────
        const allUtterances: Utterance[] = [];
        const texts: string[] = [];
        let totalAudioSec = 0;

        for (const seg of segments) {
            const videoPath = path.isAbsolute(seg.fileRef)
                ? seg.fileRef
                : path.join(MEDIA_ROOT, seg.fileRef);
            if (!fs.existsSync(videoPath)) continue;

            const audioPath = path.join(workDir, `seg-${seg.sequence}.mp3`);
            try {
                await extractAudio(videoPath, audioPath);
                const result = await transcribeAudio(audioPath);

                // Ancla wall-clock: utterance offset dentro del archivo +
                // seg.startMs (relativo a transmissions.startedAt).
                for (const u of result.utterances) {
                    allUtterances.push({
                        ...u,
                        start: u.start + seg.startMs,
                        end: u.end + seg.startMs,
                    });
                }
                if (result.text) texts.push(result.text);

                const segSec = ((seg.endMs ?? seg.startMs + 60_000) - seg.startMs) / 1000;
                totalAudioSec += segSec;
                void recordAiCost({
                    tenantId, transmissionId,
                    provider: result.provider,
                    kind: 'transcription',
                    units: Number((segSec / 60).toFixed(2)),
                    unit: 'minutes',
                    costEstimateUsd: result.provider === 'assemblyai' ? segSec * 0.00025 : 0.006 * (segSec / 60),
                });
            } catch (err) {
                console.warn(`[Poststream] segmento ${seg.sequence} falló transcripción:`, err instanceof Error ? err.message : err);
            } finally {
                await fsp.rm(audioPath, { force: true }).catch(() => undefined);
            }
        }

        const fullText = texts.join(' ');
        const diarizedText = allUtterances.length
            ? allUtterances.map((u) => `[${u.speaker}]: ${u.text}`).join('\n')
            : fullText;
        const speakerCount = new Set(allUtterances.map((u) => u.speaker)).size;

        // T-26: re-fusión retroactiva del timeline completo (las appearances
        // 'face' ya existen vía frameSampler). Corre ANTES de encolar los
        // render_clip para que los clips hereden nombres/crop de atribución.
        try {
            const fused = await ingestUtterances(transmissionId, allUtterances);
            console.log(`[Poststream] atribución: ${fused} appearances 'fusion' para tx=${transmissionId}`);
        } catch (err) {
            console.warn('[Poststream] fusión speaker↔rostro falló (degradado):', err instanceof Error ? err.message : err);
        }
        const totalMs = allUtterances.length
            ? Math.max(...allUtterances.map((u) => u.end))
            : (tx.endedAt && tx.startedAt ? tx.endedAt.getTime() - tx.startedAt.getTime() : 0);

        if (!fullText.trim()) {
            await transition(transmissionId, 'done', { force: true });
            await notify({ tenantId, type: 'transmission_done', title: 'Transmisión procesada', message: 'Sin contenido transcribible', icon: '✅' });
            return;
        }

        // Persistir la transcripción completa (auditoría / re-análisis)
        await createTranscription({
            text: diarizedText,
            source: tx.source === 'manual' ? 'manual' : 'scheduled',
            durationSeconds: Math.round(totalAudioSec),
            diarized: speakerCount > 0,
            speakerCount,
            provider: 'assemblyai',
        }, tenantId).catch((e) => console.warn('[Poststream] createTranscription warn:', e));

        // ── 2. Personas del programa → contexto de speakers ─────────────────
        const linkedPersons = await listForTransmission(tenantId, transmissionId);
        const speakerContext = linkedPersons.length
            ? linkedPersons.map((p) => `- ${p.name} (${p.role ?? 'participante'})`).join('\n')
            : null;

        // ── 3. Insights + temas → transmission_segments(kind='topic') ──────
        const [insights, topicAnalysis] = await Promise.all([
            extractInsights(diarizedText.slice(-12000), speakerContext).catch((e) => {
                console.warn('[Poststream] insights falló:', e instanceof Error ? e.message : e);
                return null;
            }),
            analyzeTopicSegments(diarizedText, diarizedText.slice(-2000)).catch((e) => {
                console.warn('[Poststream] topics falló:', e instanceof Error ? e.message : e);
                return null;
            }),
        ]);
        void recordAiCost({
            tenantId, transmissionId, provider: 'deepseek', kind: 'text',
            units: Math.round(diarizedText.length / 4), unit: 'tokens',
            costEstimateUsd: (diarizedText.length / 4) * 0.00000014,
        });

        const speakersJson = Array.from(new Set(allUtterances.map((u) => u.speaker)));

        if (topicAnalysis) {
            for (const seg of topicAnalysis.segments) {
                const segText = extractSegmentText(diarizedText, seg);
                const range = estimateRangeMs(diarizedText, segText, totalMs);
                await db.insert(transmissionSegments).values({
                    transmissionId,
                    tenantId,
                    kind: 'topic',
                    title: seg.topic,
                    summary: seg.summary,
                    startMs: range?.startMs ?? null,
                    endMs: range?.endMs ?? null,
                    speakers: speakersJson,
                    score: seg.confidence === 'high' ? '1' : seg.confidence === 'medium' ? '0.6' : '0.3',
                    payload: {
                        status: seg.status,
                        newsworthy: seg.newsworthy,
                        suggestedNotes: seg.suggestedNotes,
                    },
                });
            }
        }

        // ── 4. Momentos → segments(kind='moment') + render_clip (cuota) ────
        const highlights = await detectHighlights(diarizedText.slice(0, 12000), allUtterances, {
            tenantId,
            programId: tx.programId,
            persons: speakerContext,
        }).catch((e) => {
            console.warn('[Poststream] highlights falló:', e instanceof Error ? e.message : e);
            return [];
        });
        void recordAiCost({
            tenantId, transmissionId, provider: 'gemini', kind: 'text',
            units: Math.round(diarizedText.slice(0, 12000).length / 4), unit: 'tokens',
            costEstimateUsd: (diarizedText.slice(0, 12000).length / 4) * 0.0000001,
        });

        const maxClips = await getMaxClipsPerTransmission(tenantId);
        let enqueued = await countEnqueuedClips(transmissionId);

        for (const h of highlights) {
            const [momentRow] = await db.insert(transmissionSegments).values({
                transmissionId,
                tenantId,
                kind: 'moment',
                title: h.hookText,
                summary: h.reason,
                startMs: Math.round(h.startMs),
                endMs: Math.round(h.endMs),
                speakers: speakersJson,
                payload: { reason: h.reason },
            }).returning();

            if (enqueued >= maxClips) {
                console.log(`[Poststream] clip quota alcanzada (${enqueued}/${maxClips}) — momento registrado sin render`);
                continue;
            }
            await enqueue('render_clip', {
                transmissionId,
                tenantId,
                transmissionSegmentId: momentRow.id,
                startMs: Math.round(h.startMs),
                endMs: Math.round(h.endMs),
                hookText: h.hookText,
            }, { tenantId, dedupKey: `renderclip:${transmissionId}:${momentRow.id}` });
            enqueued++;
        }

        // ── 5. Cierre ───────────────────────────────────────────────────────
        await transition(transmissionId, 'done', { force: true });
        await notify({
            tenantId,
            type: 'transmission_done',
            title: 'Transmisión procesada',
            message: `${topicAnalysis?.segments.length ?? 0} temas, ${highlights.length} momentos, ${enqueued} clips en render`,
            icon: '✅',
            metadata: { transmissionId, topics: topicAnalysis?.segments.length ?? 0, moments: highlights.length, clipsEnqueued: enqueued },
        });
        void audit({
            tenantId, action: 'transmission.poststream_done',
            metadata: { transmissionId, topics: topicAnalysis?.segments.length ?? 0, moments: highlights.length, insights: insights?.topics ?? [] },
        });
        console.log(`[Poststream] tx=${transmissionId} done — ${allUtterances.length} utterances, ${enqueued} clips enqueued`);
    } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
