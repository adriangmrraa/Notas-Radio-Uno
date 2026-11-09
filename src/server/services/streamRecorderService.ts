import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { detectLiveStream } from './liveDetectorService.js';
import {
    listWaiting,
    getByIdAnyTenant,
    transition,
    heartbeat,
    ensureRecording,
    addRecordingSegment,
    closeRecordingSegment,
    completeRecording,
    nextSegmentSequence,
    releaseQuotaIfEarly,
    MIN_CAPTURE_MS,
} from './transmissionService.js';
import { enqueue } from './jobsQueueService.js';
import { audit } from './auditService.js';
import type { Transmission } from './transmissionService.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// streamRecorderService — supervisor de captura ffmpeg del engine (T-22, D2)
//
//   waiting ──detectLiveStream()──► resuelve 1 vez con `yt-dlp -g`
//        ──► ffmpeg -i <hls> -c copy -f segment -segment_time 60 -strftime 1
//        ──► /data/media/{tenant}/{transmission}/seg-YYYYMMDD-HHMMSS.mp4
//        ──► recording_segments (startMs = filename wall-clock − startedAt)
//        ──► heartbeat periódico; si la URL HLS expira → re-resuelve y sigue
//
//   startedAt (seteado en la transición a live) es el ANCLA wall-clock.
//   El audio-tap existente NO se toca — corre en paralelo (D3).
//
//   Punto de extensión T-44: setMaxDurationHandler() — reemplaza el
//   comportamiento por defecto al llegar al techo de duración.
// ---------------------------------------------------------------------------

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');
const PROJECT_ROOT = path.resolve(process.cwd());

function findBinary(name: string): string {
    const projectPath = path.join(PROJECT_ROOT, name);
    if (fs.existsSync(projectPath)) return projectPath;
    const toolsPath = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(toolsPath)) return toolsPath;
    return name;
}
const YTDLP = findBinary('yt-dlp');
const FFMPEG = findBinary('ffmpeg');

const POLL_MS = Number(process.env.RECORDER_POLL_MS ?? 5_000);
const DETECT_POLL_MS = Number(process.env.RECORDER_DETECT_POLL_MS ?? 15_000);
const HEARTBEAT_MS = Number(process.env.RECORDER_HEARTBEAT_MS ?? 30_000);
const SEGMENT_SECONDS = Number(process.env.RECORDER_SEGMENT_SECONDS ?? 60);
const SEGMENT_WATCH_MS = Number(process.env.RECORDER_SEGMENT_WATCH_MS ?? 3_000);
/** Ventana máxima esperando el live antes de declarar error (default 45 min). */
const DETECT_WINDOW_MS = Number(process.env.RECORDER_DETECT_WINDOW_MS ?? 45 * 60_000);
/** Backoff entre reinicios de ffmpeg tras caída del stream. */
const FFMPEG_RESTART_DELAY_MS = Number(process.env.RECORDER_RESTART_DELAY_MS ?? 10_000);
const FFMPEG_MAX_RESTARTS = Number(process.env.RECORDER_MAX_RESTARTS ?? 5);
/** Techo de captura por defecto si la tx no define durationMinutes. */
const DEFAULT_MAX_DURATION_MIN = Number(process.env.RECORDER_MAX_DURATION_MIN ?? 240);

// ---------------------------------------------------------------------------
// Extension point T-44 — qué hacer al llegar al techo de duración.
// Default: cortar captura → processing → poststream_analysis.
// T-44 puede reemplazarlo (p.ej. extender, avisar, cobrar extra).
// ---------------------------------------------------------------------------
export interface MaxDurationContext {
    tx: Transmission;
    capturedMs: number;
    stopCapture: () => void;
}
type MaxDurationHandler = (ctx: MaxDurationContext) => void;
let maxDurationHandler: MaxDurationHandler | null = null;
export function setMaxDurationHandler(handler: MaxDurationHandler | null): void {
    maxDurationHandler = handler;
}

// ---------------------------------------------------------------------------
// Audio tap (D3) — el recorder es el que sabe cuándo empieza/termina el live;
// el engine inyecta start/stop para levantar el AutoPipeline en paralelo.
// ---------------------------------------------------------------------------
export interface AudioTapHooks {
    start: (tx: Transmission) => void;
    stop: (tx: Transmission) => void;
}
let audioTapHooks: AudioTapHooks | null = null;
export function setAudioTapHooks(hooks: AudioTapHooks | null): void {
    audioTapHooks = hooks;
}

// ---------------------------------------------------------------------------
// Resolución de URL de stream — UNA vez por arranque de ffmpeg (D2).
// `yt-dlp -g` devuelve la URL directa (HLS m3u8 firmada o progresiva).
// ---------------------------------------------------------------------------
export async function resolveStreamUrl(url: string): Promise<string> {
    const { stdout } = await execFileAsync(YTDLP, ['-g', '--no-warnings', url], {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    const resolved = stdout.trim().split('\n').pop()?.trim();
    if (!resolved) throw new Error(`yt-dlp -g no devolvió URL para ${url}`);
    return resolved;
}

// ---------------------------------------------------------------------------
// Segment files — seg-YYYYMMDD-HHMMSS.mp4 (strftime, TZ=UTC en el child)
// ---------------------------------------------------------------------------
const SEGMENT_RE = /^seg-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.mp4$/;

function segmentFileStartMs(filename: string): number | null {
    const m = SEGMENT_RE.exec(filename);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

// ---------------------------------------------------------------------------
// runTransmission — ciclo completo de una transmisión waiting → terminal.
// Corre como task por el recorder loop; una por tx a la vez.
// ---------------------------------------------------------------------------
interface CaptureState {
    recordingId: string;
    outDir: string;
    storagePrefix: string;
    ffmpeg: ChildProcess | null;
    restarts: number;
    stopRequested: boolean;
    capturedMs: number;
    lastHeartbeatAt: number;
    lastSeq: number;
    /** Archivo de segmento actualmente abierto (último visto). */
    openFile: string | null;
    openStartMs: number;
}

async function getCurrentStatus(txId: string): Promise<string | null> {
    const tx = await getByIdAnyTenant(txId);
    return tx?.status ?? null;
}

async function scanSegments(state: CaptureState, startedAtMs: number): Promise<void> {
    let files: string[];
    try {
        files = (await fsp.readdir(state.outDir)).filter((f) => SEGMENT_RE.test(f)).sort();
    } catch {
        return;
    }
    for (const file of files) {
        const fileStartAbs = segmentFileStartMs(file);
        if (fileStartAbs == null) continue;
        const startMs = Math.max(0, fileStartAbs - startedAtMs);
        const full = path.join(state.outDir, file);
        const stat = await fsp.stat(full).catch(() => null);

        if (state.openFile === file) {
            state.capturedMs = Math.max(state.capturedMs, startMs + (stat ? Math.min(SEGMENT_SECONDS * 1000, stat.mtimeMs - fileStartAbs + SEGMENT_SECONDS * 1000) : 0));
            continue;
        }

        // Nuevo segmento → cerrar el anterior con contigüidad wall-clock.
        if (state.openFile) {
            await closeRecordingSegment(state.recordingId, state.lastSeq, startMs).catch((e) =>
                console.warn('[Recorder] closeSegment falló:', e instanceof Error ? e.message : e),
            );
        }

        state.lastSeq = await nextSegmentSequence(state.recordingId);
        const relRef = `${state.storagePrefix}/${file}`;
        await addRecordingSegment({
            recordingId: state.recordingId,
            sequence: state.lastSeq,
            startMs,
            fileRef: relRef,
            bytes: stat?.size ?? null,
        });
        state.openFile = file;
        state.openStartMs = startMs;
        state.capturedMs = Math.max(state.capturedMs, startMs);
    }
}

async function finalizeOpenSegment(state: CaptureState, startedAtMs: number): Promise<void> {
    if (!state.openFile) return;
    const stat = await fsp.stat(path.join(state.outDir, state.openFile)).catch(() => null);
    const endMs = stat
        ? Math.max(state.openStartMs + 1, stat.mtimeMs - startedAtMs)
        : state.openStartMs + SEGMENT_SECONDS * 1000;
    await closeRecordingSegment(state.recordingId, state.lastSeq, endMs, stat?.size ?? null).catch(() => undefined);
    state.openFile = null;
    state.capturedMs = Math.max(state.capturedMs, endMs);
}

function spawnFfmpeg(resolvedUrl: string, state: CaptureState): ChildProcess {
    const pattern = path.join(state.outDir, 'seg-%Y%m%d-%H%M%S.mp4');
    const args = [
        '-hide_banner', '-loglevel', 'warning',
        // HLS reconnect (stream puede cortar un rato sin morir)
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', resolvedUrl,
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', String(SEGMENT_SECONDS),
        '-reset_timestamps', '1',
        '-strftime', '1',
        pattern,
    ];
    // TZ=UTC → los nombres strftime quedan en UTC → startMs deterministic.
    const child = spawn(FFMPEG, args, {
        env: { ...process.env, TZ: 'UTC' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) console.log(`[Recorder] ffmpeg: ${line.slice(0, 300)}`);
    });
    return child;
}

function waitExit(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(child.exitCode); return; }
        child.once('exit', (code) => resolve(code));
    });
}

/**
 * Corre la captura de UNA transmisión. Devuelve cuando la tx quedó en estado
 * terminal (processing/canceled/error) — el recorder loop no la vuelve a tomar.
 */
export async function runTransmission(tx0: Transmission): Promise<void> {
    const txId = tx0.id;
    const tenantId = tx0.tenantId;
    const streamUrl = tx0.streamUrl;
    if (!streamUrl) {
        await transition(txId, 'error', { errorMessage: 'Transmission sin streamUrl', force: true });
        await releaseQuotaIfEarly(tx0, 0);
        return;
    }

    // ── 1. Ventana de detección del live ────────────────────────────────────
    const windowMs = tx0.durationMinutes
        ? Math.max(tx0.durationMinutes * 60_000, DETECT_WINDOW_MS)
        : DETECT_WINDOW_MS;
    const deadline = (tx0.waitingSince?.getTime() ?? Date.now()) + windowMs;

    let liveUrl: string | null = null;
    for (;;) {
        const status = await getCurrentStatus(txId);
        if (status !== 'waiting') return; // cancelada/reconciliada mientras esperaba

        const det = await detectLiveStream(streamUrl).catch((e) => ({
            found: false, liveUrl: null, title: null, platform: 'unknown',
            error: e instanceof Error ? e.message : String(e),
        }));
        if (det.found && det.liveUrl) { liveUrl = det.liveUrl; break; }

        if (Date.now() >= deadline) {
            await transition(txId, 'error', {
                errorMessage: `No se detectó live dentro de la ventana (${Math.round(windowMs / 60000)}m): ${det.error ?? 'sin live'}`,
                force: true,
            });
            await releaseQuotaIfEarly(tx0, 0);
            void audit({ tenantId, action: 'transmission.detect_timeout', metadata: { transmissionId: txId, streamUrl } });
            return;
        }
        await heartbeat(txId);
        await new Promise((r) => setTimeout(r, DETECT_POLL_MS));
    }

    // ── 2. Resolución ÚNICA con yt-dlp -g + transición a live (ancla) ──────
    let resolved: string;
    try {
        resolved = await resolveStreamUrl(liveUrl);
    } catch (err) {
        // Fallback: algunos canales devuelven URL directa ya usable por ffmpeg
        console.warn(`[Recorder] yt-dlp -g falló (${(err as Error).message}); usando liveUrl directo`);
        resolved = liveUrl;
    }

    const tx = await transition(txId, 'live', { resolvedStreamUrl: resolved });
    const startedAtMs = (tx.startedAt ?? new Date()).getTime();

    // Audio tap en paralelo (D3) — el engine inyecta el AutoPipeline acá.
    try {
        audioTapHooks?.start(tx);
    } catch (e) {
        console.warn('[Recorder] audioTap.start falló:', e instanceof Error ? e.message : e);
    }

    // ── 3. Recording row + directorio ───────────────────────────────────────
    const storagePrefix = `${tenantId}/${txId}`;
    const outDir = path.join(MEDIA_ROOT, storagePrefix);
    await fsp.mkdir(outDir, { recursive: true });
    const recording = await ensureRecording(txId, storagePrefix);

    const state: CaptureState = {
        recordingId: recording.id,
        outDir,
        storagePrefix,
        ffmpeg: null,
        restarts: 0,
        stopRequested: false,
        capturedMs: 0,
        lastHeartbeatAt: 0,
        lastSeq: 0,
        openFile: null,
        openStartMs: 0,
    };

    const maxDurationMs = (tx.durationMinutes ?? DEFAULT_MAX_DURATION_MIN) * 60_000;

    // ── 4. Loop de supervisión ffmpeg (con re-resolución de HLS) ────────────
    for (;;) {
        const status = await getCurrentStatus(txId);
        if (status !== 'live') break; // canceled/error → salir sin re-transicionar

        if (state.capturedMs >= maxDurationMs) {
            // Extension point T-44 — handler externo decide; default = stop.
            if (maxDurationHandler) {
                maxDurationHandler({ tx, capturedMs: state.capturedMs, stopCapture: () => { state.stopRequested = true; } });
                if (!state.stopRequested) { await sleep(SEGMENT_WATCH_MS); continue; }
            } else {
                console.log(`[Recorder] tx=${txId} llegó a maxDuration (${Math.round(maxDurationMs / 60000)}m) — corte`);
                state.stopRequested = true;
            }
        }

        // Arrancar ffmpeg si no corre
        if (!state.ffmpeg || state.ffmpeg.exitCode !== null || state.ffmpeg.signalCode !== null) {
            if (state.ffmpeg) {
                // Murió → HLS probablemente expiró → RE-RESOLVER antes de reiniciar
                state.restarts += 1;
                if (state.restarts > FFMPEG_MAX_RESTARTS) {
                    await finalizeOpenSegment(state, startedAtMs);
                    await completeRecording(state.recordingId, 'error');
                    await transition(txId, 'error', {
                        errorMessage: `ffmpeg se cayó ${state.restarts} veces (stream inestable)`,
                        force: true,
                    });
                    await releaseQuotaIfEarly(tx, state.capturedMs);
                    return;
                }
                console.warn(`[Recorder] ffmpeg murió (restart ${state.restarts}/${FFMPEG_MAX_RESTARTS}) — re-resolviendo URL`);
                await finalizeOpenSegment(state, startedAtMs);
                try {
                    const det = await detectLiveStream(streamUrl);
                    resolved = await resolveStreamUrl(det.liveUrl ?? liveUrl);
                    await heartbeat(txId);
                } catch (err) {
                    console.warn('[Recorder] re-resolución falló:', (err as Error).message);
                }
                await sleep(FFMPEG_RESTART_DELAY_MS);
            }
            state.ffmpeg = spawnFfmpeg(resolved, state);
            console.log(`[Recorder] ffmpeg spawn tx=${txId} → ${outDir}`);
        }

        // Scan de segmentos + heartbeat + watch de stop
        await scanSegments(state, startedAtMs);
        if (Date.now() - state.lastHeartbeatAt >= HEARTBEAT_MS) {
            await heartbeat(txId);
            state.lastHeartbeatAt = Date.now();
        }
        if (state.stopRequested) break;

        await sleep(SEGMENT_WATCH_MS);
    }

    // ── 5. Cierre limpio ────────────────────────────────────────────────────
    try {
        audioTapHooks?.stop(tx);
    } catch (e) {
        console.warn('[Recorder] audioTap.stop falló:', e instanceof Error ? e.message : e);
    }
    if (state.ffmpeg && state.ffmpeg.exitCode === null && !state.ffmpeg.killed) {
        // 'q' por stdin no aplica (stdio ignore) → SIGTERM; fallback SIGKILL.
        state.ffmpeg.kill('SIGTERM');
        const exited = await Promise.race([waitExit(state.ffmpeg), sleep(8_000).then(() => 'timeout' as const)]);
        if (exited === 'timeout') state.ffmpeg.kill('SIGKILL');
        await waitExit(state.ffmpeg);
    }
    await finalizeOpenSegment(state, startedAtMs);
    await completeRecording(state.recordingId, 'completed');

    const finalTx = await getByIdAnyTenant(txId);
    const finalStatus = finalTx?.status;

    if (finalStatus === 'live') {
        // Corte normal (maxDuration o fin del stream): live → processing → poststream
        await transition(txId, 'processing');
        await enqueue('poststream_analysis', {
            transmissionId: txId,
            tenantId,
            capturedMs: state.capturedMs,
        }, { tenantId, dedupKey: `poststream:${txId}` });
        void audit({ tenantId, action: 'transmission.capture_completed', metadata: { transmissionId: txId, capturedMs: state.capturedMs, segments: state.lastSeq } });
    } else if (finalStatus === 'canceled' || finalStatus === 'error') {
        // Captura corta → liberar cuota reservada por el scheduler/manual start
        await releaseQuotaIfEarly(finalTx ?? tx, state.capturedMs);
        if (finalStatus === 'canceled' && state.capturedMs >= MIN_CAPTURE_MS) {
            // Cancelada pero con material: igual conviene analizar lo capturado
            await enqueue('poststream_analysis', {
                transmissionId: txId, tenantId, capturedMs: state.capturedMs,
            }, { tenantId, dedupKey: `poststream:${txId}` });
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Recorder loop — escanea waiting y levanta runTransmission por cada una.
// Solo corre en PROCESS_ROLE=engine (T-20).
// ---------------------------------------------------------------------------
const running = new Set<string>();
let loopTimer: NodeJS.Timeout | null = null;

export function startRecorderLoop(): { stop: () => void } {
    if (loopTimer) return { stop: () => { if (loopTimer) clearInterval(loopTimer); loopTimer = null; } };

    const tick = async () => {
        try {
            const waiting = await listWaiting(10);
            for (const tx of waiting) {
                if (running.has(tx.id)) continue;
                running.add(tx.id);
                void runTransmission(tx)
                    .catch((err) => console.error(`[Recorder] runTransmission ${tx.id} error:`, err))
                    .finally(() => running.delete(tx.id));
            }
        } catch (err) {
            console.error('[Recorder] tick error:', err);
        }
    };

    loopTimer = setInterval(() => { void tick(); }, POLL_MS);
    void tick();
    console.log(`[Recorder] loop started (poll ${POLL_MS}ms, segments ${SEGMENT_SECONDS}s → ${MEDIA_ROOT})`);

    return {
        stop: () => {
            if (loopTimer) clearInterval(loopTimer);
            loopTimer = null;
        },
    };
}
