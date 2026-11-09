import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { db } from '../db/index.js';
import {
    assets,
    assetPersons,
    personAppearances,
    persons,
    programs,
    recordingSegments,
    streamRecordings,
    transmissionSegments,
} from '../db/schema/index.js';
import { eq, and, asc, gte, lt, inArray, isNotNull, sql } from 'drizzle-orm';
import { getByIdAnyTenant } from './transmissionService.js';
import { transcribeAudio } from './transcriptionService.js';
import { dominantPersonInWindow, attributeWindow, personIdsInWindow } from './attributionService.js';
import { loadTenantBranding } from './brandingService.js';
import { getFontFamily } from './fontService.js';
import { emitToTenant, notify } from './notificationService.js';
import { recordAiCost } from './aiCostMeter.js';
import { audit } from './auditService.js';
import type { Utterance } from '../../shared/types.js';
import type { FontFamilyId } from '../../shared/types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// clipCutterService — handler del job 'render_clip' (T-32, spec clip-extraction)
//
//   recording_segments que cubren [startMs,endMs]
//     → cut por tramo (-ss/-t por segmento, concat vía filter — el gap de
//       captura se salta exacto, nunca inventa footage)
//     → crop 9:16 con x(t) piecewise = centro bbox ponderado del speaker
//       dominante por tramo (split en speaker-change; fallback centrado — D5)
//     → ASS subs de la ventana: re-transcribe el audio del clip (los nombres
//       se resuelven por overlap wall-clock con person_appearances vía
//       attributionService — las labels de re-diarización NO se matchean con
//       las de sesión, la resolución es por TIEMPO)
//     → overlay Remotion LiveClipOverlay (webm alpha — D6)
//     → UNA pasada ffmpeg: concat→crop→scale 1080x1920→subtitles→overlay
//     → assets(type='clip', source='footage', status='pending_review')
//       + thumb + asset_persons('speaker') + versionado de re-cortes
//
//   Nota de diseño (desvío documentado): las utterances NO se persisten con
//   timing en ninguna tabla — por eso el subs path re-transcribe la ventana
//   (~60s de audio) en vez de leer utterances preexistentes. Mismo costo
//   que leer, cero acoplamiento y timing exacto al clip.
// ---------------------------------------------------------------------------

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');
const PROJECT_ROOT = path.resolve(process.cwd());
const REMOTION_DIR = path.join(PROJECT_ROOT, 'remotion');
const FONTS_DIR = path.join(PROJECT_ROOT, 'fonts');

function findBinary(name: string): string {
    const projectPath = path.join(PROJECT_ROOT, name);
    if (fs.existsSync(projectPath)) return projectPath;
    const toolsPath = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(toolsPath)) return toolsPath;
    return name;
}
const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/** Gap máximo wall-clock tolerado dentro de la ventana del clip. */
const CLIP_MAX_GAP_MS = Number(process.env.CLIP_MAX_GAP_MS ?? 10_000);
const OVERLAY_FPS = 30;
const OVERLAY_MAX_FRAMES = 2700; // composition LiveClipOverlay (90s @30fps)

export interface RenderClipPayload {
    transmissionId: string;
    tenantId?: string;
    transmissionSegmentId?: string;
    startMs: number;
    endMs: number;
    hookText?: string;
    manual?: boolean;
    /** Re-corte: id del asset origen (versionado — el previo se conserva). */
    recutOfAssetId?: string;
}

// ---------------------------------------------------------------------------
// ffprobe / ffmpeg helpers
// ---------------------------------------------------------------------------
async function probeVideo(filePath: string): Promise<{ width: number; height: number; hasAudio: boolean } | null> {
    try {
        const { stdout } = await execFileAsync(FFPROBE, [
            '-v', 'error',
            '-show_entries', 'stream=codec_type,width,height',
            '-of', 'json', filePath,
        ], { timeout: 20_000 });
        const parsed = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number }[] };
        const v = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
        if (!v?.width || !v.height) return null;
        return {
            width: v.width,
            height: v.height,
            hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === 'audio'),
        };
    } catch {
        return null;
    }
}

function relToMedia(absPath: string): string {
    return path.relative(MEDIA_ROOT, absPath).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Segmentos que cubren la ventana
// ---------------------------------------------------------------------------
interface CoveringPiece {
    filePath: string;
    segStartMs: number;
    segEndMs: number;
    /** offset dentro del archivo donde empieza el corte (ms) */
    cutOffsetMs: number;
    /** duración del pedazo (ms) */
    durMs: number;
}

async function resolveCovering(
    transmissionId: string,
    startMs: number,
    endMs: number,
): Promise<{ pieces: CoveringPiece[]; windowStartMs: number; windowEndMs: number }> {
    const [recording] = await db.select().from(streamRecordings)
        .where(eq(streamRecordings.transmissionId, transmissionId)).limit(1);
    if (!recording) throw new Error(`tx=${transmissionId} sin stream_recording — nada que cortar`);

    const allSegs = await db.select().from(recordingSegments)
        .where(eq(recordingSegments.recordingId, recording.id))
        .orderBy(asc(recordingSegments.sequence));
    if (allSegs.length === 0) throw new Error(`tx=${transmissionId} sin recording_segments`);

    // ¿La ventana pisa segmentos purgados? → error explícito de retención.
    const purgedOverlap = allSegs.filter((s) =>
        s.status === 'purged' && s.startMs < endMs && (s.endMs ?? Number.MAX_SAFE_INTEGER) > startMs,
    );
    if (purgedOverlap.length > 0) {
        throw new Error(`crudo expirado por retención (${purgedOverlap.length} segmento(s) purgados en la ventana)`);
    }

    const covering = allSegs.filter((s) =>
        s.status === 'active' && s.endMs != null && s.startMs < endMs && (s.endMs as number) > startMs,
    );
    if (covering.length === 0) {
        throw new Error(`ventana [${startMs},${endMs}] fuera del footage disponible`);
    }

    // Clamp al coverage real (el momento puede no haber terminado de grabarse).
    const windowStartMs = Math.max(startMs, covering[0].startMs);
    const last = covering[covering.length - 1];
    const windowEndMs = Math.min(endMs, last.endMs as number);
    if (windowEndMs - windowStartMs < 2_000) {
        throw new Error(`ventana efectiva demasiado corta tras clamp (${windowEndMs - windowStartMs}ms)`);
    }

    // Gap check: si dentro de la ventana hay un salto > CLIP_MAX_GAP_MS → rechazar.
    for (let i = 1; i < covering.length; i++) {
        const gap = covering[i].startMs - (covering[i - 1].endMs as number);
        if (gap > CLIP_MAX_GAP_MS) {
            throw new Error(`gap de captura de ${Math.round(gap / 1000)}s dentro de la ventana del clip`);
        }
    }

    const pieces: CoveringPiece[] = covering.map((seg) => {
        const filePath = path.isAbsolute(seg.fileRef) ? seg.fileRef : path.join(MEDIA_ROOT, seg.fileRef);
        const cutStart = Math.max(windowStartMs, seg.startMs);
        const cutEnd = Math.min(windowEndMs, seg.endMs as number);
        return {
            filePath,
            segStartMs: seg.startMs,
            segEndMs: seg.endMs as number,
            cutOffsetMs: cutStart - seg.startMs,
            durMs: cutEnd - cutStart,
        };
    });

    return { pieces, windowStartMs, windowEndMs };
}

// ---------------------------------------------------------------------------
// Crop 9:16 — tramos por speaker dominante con x(t) piecewise (D5)
// ---------------------------------------------------------------------------
interface CropTramo {
    /** fin del tramo en ms RELATIVO al inicio del clip */
    untilMs: number;
    /** x del crop en px del frame fuente */
    xPx: number;
}

/**
 * Tramos de crop: para cada sub-ventana, la appearance con mejor
 * (prioridad manual>fusion>face) × solapamiento × confidence que tenga
 * bbox — su centro-x ponderado manda. Intervalos sin cara heredan la
 * posición anterior (pan determinístico, sin saltos).
 * bbox está normalizado [0..1] — se escala a px del frame fuente.
 */
async function buildCropTramos(
    txId: string,
    windowStartMs: number,
    windowEndMs: number,
    videoW: number,
    videoH: number,
): Promise<CropTramo[] | null> {
    const appearances = await db.select({
        personId: personAppearances.personId,
        source: personAppearances.source,
        startMs: personAppearances.startMs,
        endMs: personAppearances.endMs,
        confidence: personAppearances.confidence,
        bbox: personAppearances.bbox,
    }).from(personAppearances)
        .where(and(
            eq(personAppearances.transmissionId, txId),
            isNotNull(personAppearances.personId),
            isNotNull(personAppearances.bbox),
            lt(personAppearances.startMs, windowEndMs),
            gte(personAppearances.endMs, windowStartMs),
        ))
        .orderBy(asc(personAppearances.startMs));

    if (appearances.length === 0) return null;

    // Prioridad de fuente: corrección manual > fusión > detección cruda.
    const srcRank = (s: string) => (s === 'manual' ? 3 : s === 'fusion' ? 2 : 1);

    // Partir la ventana en intervalos atómicos por los bordes de appearances.
    const bounds = new Set<number>([windowStartMs, windowEndMs]);
    for (const a of appearances) {
        bounds.add(Math.max(windowStartMs, a.startMs));
        bounds.add(Math.min(windowEndMs, a.endMs));
    }
    const sorted = Array.from(bounds).sort((x, y) => x - y);

    // Por intervalo: ganador (personId + centro-x normalizado ponderado).
    const intervalPick: { personId: string; cxNorm: number }[] = [];
    for (let i = 0; i + 1 < sorted.length; i++) {
        const a0 = sorted[i];
        const a1 = sorted[i + 1];
        let best: { personId: string; cxNorm: number; score: number } | null = null;
        for (const ap of appearances) {
            if (!ap.personId || !Array.isArray(ap.bbox)) continue;
            const overlap = Math.min(ap.endMs, a1) - Math.max(ap.startMs, a0);
            if (overlap <= 0) continue;
            const conf = Math.max(0.05, Number(ap.confidence ?? 0));
            const score = overlap * conf * srcRank(ap.source);
            const bbox = ap.bbox as number[];
            const cxNorm = (bbox[0] ?? 0.5) + (bbox[2] ?? 0) / 2;
            if (!best || score > best.score) best = { personId: ap.personId, cxNorm, score };
        }
        if (best) intervalPick.push({ personId: best.personId, cxNorm: best.cxNorm });
        else intervalPick.push({ personId: '', cxNorm: NaN }); // sin cara
    }

    const cropW = Math.min(videoW, Math.floor((videoH * 9 / 16) / 2) * 2);
    const maxX = Math.max(0, videoW - cropW);
    const centered = Math.floor(maxX / 2);
    const clampX = (cxNorm: number) => Math.round(Math.min(Math.max(cxNorm * videoW - cropW / 2, 0), maxX));

    // Mergear intervalos contiguos con mismo personId; sin cara → x previa.
    const tramos: CropTramo[] = [];
    let lastX = centered;
    for (let i = 0; i + 1 < sorted.length; i++) {
        const pick = intervalPick[i];
        const xPx = pick.personId ? clampX(pick.cxNorm) : lastX;
        lastX = xPx;
        const untilMs = sorted[i + 1] - windowStartMs;
        if (tramos.length > 0 && tramos[tramos.length - 1].xPx === xPx) {
            tramos[tramos.length - 1].untilMs = untilMs;
        } else {
            tramos.push({ untilMs, xPx });
        }
    }
    return tramos.length > 0 ? tramos : null;
}

/**
 * Expresión ffmpeg para x del crop: x(t) piecewise-constante por tramo.
 * t en segundos de la salida (post setpts=PTS-STARTPTS).
 */
function cropXExpression(tramos: CropTramo[] | null, fallbackXPx: number): string {
    if (!tramos || tramos.length === 0) return String(fallbackXPx);
    if (tramos.length === 1) return String(tramos[0].xPx);
    const terms = tramos.map((t, i) => {
        const start = i === 0 ? 0 : tramos[i - 1].untilMs / 1000;
        const end = t.untilMs / 1000;
        return `${t.xPx}*between(t,${start.toFixed(3)},${end.toFixed(3)})`;
    });
    return terms.join('+');
}

// ---------------------------------------------------------------------------
// ASS subtitles — re-transcripción de la ventana + nombres resueltos
// ---------------------------------------------------------------------------
function assTime(ms: number): string {
    const total = Math.max(0, Math.round(ms / 10)); // centésimas ASS
    const cs = total % 100;
    const s = Math.floor(total / 100) % 60;
    const m = Math.floor(total / 6000) % 60;
    const h = Math.floor(total / 360000);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(text: string): string {
    return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, ' ').trim();
}

async function buildAssSubs(
    txId: string,
    windowStartMs: number,
    windowEndMs: number,
    clipDurMs: number,
    audioPath: string,
    fontFamilyId: FontFamilyId,
    workDir: string,
): Promise<string | null> {
    let utterances: Utterance[] = [];
    try {
        const res = await transcribeAudio(audioPath);
        utterances = res.utterances ?? [];
        void recordAiCost({
            tenantId: (await getByIdAnyTenant(txId))?.tenantId ?? '',
            transmissionId: txId,
            provider: res.provider,
            kind: 'transcription',
            units: Number((clipDurMs / 60000).toFixed(3)),
            unit: 'minutes',
            costEstimateUsd: res.provider === 'assemblyai' ? (clipDurMs / 1000) * 0.00025 : 0.006 * (clipDurMs / 60000),
        });
    } catch (err) {
        console.warn(`[ClipCutter] transcripción de ventana falló — clip sin subs:`, err instanceof Error ? err.message : err);
        return null;
    }
    if (utterances.length === 0) return null;

    // Appearances de la ventana para resolver nombres por overlap wall-clock.
    const appearances = await db.select({
        personId: personAppearances.personId,
        source: personAppearances.source,
        startMs: personAppearances.startMs,
        endMs: personAppearances.endMs,
        confidence: personAppearances.confidence,
    }).from(personAppearances)
        .where(and(
            eq(personAppearances.transmissionId, txId),
            lt(personAppearances.startMs, windowEndMs),
            gte(personAppearances.endMs, windowStartMs),
        ));

    const personIds = Array.from(new Set(appearances.map((a) => a.personId).filter((x): x is string => !!x)));
    const names = personIds.length
        ? await db.select({ id: persons.id, name: persons.name })
            .from(persons)
            .where(inArray(persons.id, personIds))
        : [];
    const nameById = new Map(names.map((n) => [n.id, n.name]));

    const fontName = getFontFamily(fontFamilyId).replace(/"/g, '') || 'Arial';
    const lines = utterances
        .filter((u) => u.end > u.start && u.text.trim())
        .map((u) => {
            const attr = dominantPersonInWindow(appearances, windowStartMs + u.start, windowStartMs + u.end);
            const speaker = attr.personId ? nameById.get(attr.personId) ?? null : null;
            const prefix = speaker ? `{\\c&H00E5FF&}${assEscape(speaker)}:{\\c&HFFFFFF&} ` : '';
            return `Dialogue: 0,${assTime(u.start)},${assTime(u.end)},Default,,0,0,0,,${prefix}${assEscape(u.text)}`;
        });
    if (lines.length === 0) return null;

    const ass = [
        '[Script Info]',
        'Title: PeriodistApp clip subs',
        'ScriptType: v4.00+',
        'PlayResX: 1080',
        'PlayResY: 1920',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Default,${fontName},64,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,2,60,60,140,1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...lines,
        '',
    ].join('\n');

    const assPath = path.join(workDir, 'subs.ass');
    await fsp.writeFile(assPath, ass, 'utf-8');
    return assPath;
}

// ---------------------------------------------------------------------------
// Overlay Remotion — LiveClipOverlay → webm alpha (D6)
// ---------------------------------------------------------------------------
async function renderOverlay(opts: {
    durationMs: number;
    personName: string | null;
    personRole: string | null;
    programName: string;
    platformName: string;
    logoDataUrl: string | null;
    outPath: string;
}): Promise<string | null> {
    const frames = Math.min(OVERLAY_MAX_FRAMES, Math.max(1, Math.round((opts.durationMs / 1000) * OVERLAY_FPS)));
    const props = {
        logoDataUrl: opts.logoDataUrl ?? undefined,
        personName: opts.personName ?? undefined,
        personRole: opts.personRole ?? undefined,
        programName: opts.programName,
        platformName: opts.platformName,
        durationInSeconds: Math.ceil(opts.durationMs / 1000),
        lowerThirdSec: 6,
    };
    try {
        await execFileAsync(NPX, [
            'remotion', 'render', 'LiveClipOverlay', opts.outPath,
            '--codec=vp8',
            '--pixel-format=yuva420p',
            '--image-format=png', // alpha requiere PNG en los frames internos
            `--frames=0-${frames - 1}`,
            `--props=${JSON.stringify(props)}`,
            '--log=error',
        ], { cwd: REMOTION_DIR, timeout: 240_000 });
        return fs.existsSync(opts.outPath) ? opts.outPath : null;
    } catch (err) {
        console.warn('[ClipCutter] Remotion overlay falló — clip sin overlay:', err instanceof Error ? err.message.slice(0, 300) : err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Handler principal — 'render_clip'
// ---------------------------------------------------------------------------
export async function handleRenderClip(payload: RenderClipPayload): Promise<{ assetId: string }> {
    const { transmissionId, startMs, endMs } = payload;
    if (typeof startMs !== 'number' || typeof endMs !== 'number' || endMs <= startMs) {
        throw new Error(`render_clip: ventana inválida [${startMs},${endMs}]`);
    }

    const tx = await getByIdAnyTenant(transmissionId);
    if (!tx) throw new Error(`Transmission ${transmissionId} no encontrada`);
    const tenantId = payload.tenantId ?? tx.tenantId;
    if (tenantId !== tx.tenantId) throw new Error('tenant mismatch en render_clip');

    // 1. Segmentos → piezas de corte (+ clamp + gap check + purgados)
    const { pieces, windowStartMs, windowEndMs } = await resolveCovering(transmissionId, startMs, endMs);
    for (const p of pieces) {
        if (!fs.existsSync(p.filePath)) {
            throw new Error(`segmento faltante en storage: ${p.filePath}`);
        }
    }
    const clipDurMs = windowEndMs - windowStartMs;

    // 2. Dimensiones + audio del footage
    const probe = await probeVideo(pieces[0].filePath);
    if (!probe) throw new Error(`ffprobe no pudo leer ${pieces[0].filePath}`);
    const { width: inW, height: inH, hasAudio } = probe;
    const cropW = Math.min(inW, Math.floor((inH * 9 / 16) / 2) * 2);
    const cropH = inH;
    const centeredX = Math.floor((inW - cropW) / 2);

    // 3. Tramos de crop por speaker dominante (bbox ponderado; fallback centrado)
    const tramos = await buildCropTramos(transmissionId, windowStartMs, windowEndMs, inW, inH);
    const xExpr = cropXExpression(tramos, centeredX);

    // 4. Branding + persona dominante de la ventana (lower-third, subs)
    const branding = await loadTenantBranding(tenantId).catch(() => ({
        logoBuffer: null, platformName: 'PeriodistApp', fontFamily: 'bebas_kai' as FontFamilyId, templateId: 'dark_gradient',
    }));
    const [program] = tx.programId
        ? await db.select({ name: programs.name }).from(programs).where(eq(programs.id, tx.programId)).limit(1)
        : [null];
    const programName = program?.name ?? branding.platformName;

    const dominant = await attributeWindow(transmissionId, windowStartMs, windowEndMs).catch(() => null);
    let dominantRole: string | null = null;
    if (dominant?.personId) {
        const [p] = await db.select({ role: persons.role }).from(persons).where(eq(persons.id, dominant.personId)).limit(1);
        dominantRole = p?.role ?? null;
    }

    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), `clipcut-${transmissionId.slice(0, 8)}-`));
    const outDir = path.join(MEDIA_ROOT, tenantId, transmissionId, 'clips');
    await fsp.mkdir(outDir, { recursive: true });
    const clipId = randomUUID().slice(0, 8);
    const outName = `clip_${clipId}.mp4`;
    const outPath = path.join(outDir, outName);
    const thumbPath = path.join(outDir, `clip_${clipId}.jpg`);

    try {
        // 5. Audio de la ventana → ASS subs (video-only si no hay audio o falla)
        let assPath: string | null = null;
        if (hasAudio) {
            const audioPath = path.join(workDir, 'window.mp3');
            try {
                // audio por piezas: misma semántica de concat del video
                if (pieces.length === 1) {
                    await execFileAsync(FFMPEG, [
                        '-hide_banner', '-loglevel', 'error',
                        '-ss', (pieces[0].cutOffsetMs / 1000).toFixed(3),
                        '-t', (pieces[0].durMs / 1000).toFixed(3),
                        '-i', pieces[0].filePath,
                        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-y', audioPath,
                    ], { timeout: 60_000 });
                } else {
                    const inputs: string[] = [];
                    const filters: string[] = [];
                    pieces.forEach((p, i) => {
                        inputs.push('-ss', (p.cutOffsetMs / 1000).toFixed(3), '-t', (p.durMs / 1000).toFixed(3), '-i', p.filePath);
                        filters.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}]`);
                    });
                    const concatIns = pieces.map((_, i) => `[a${i}]`).join('');
                    filters.push(`${concatIns}concat=n=${pieces.length}:v=0:a=1[acat]`);
                    await execFileAsync(FFMPEG, [
                        '-hide_banner', '-loglevel', 'error',
                        ...inputs,
                        '-filter_complex', filters.join(';'),
                        '-map', '[acat]',
                        '-ac', '1', '-ar', '16000', '-b:a', '64k', '-y', audioPath,
                    ], { timeout: 90_000 });
                }
            } catch (err) {
                console.warn('[ClipCutter] extracción de audio falló — clip sin subs:', err instanceof Error ? err.message : err);
            }
            if (fs.existsSync(audioPath)) {
                assPath = await buildAssSubs(
                    transmissionId, windowStartMs, windowEndMs, clipDurMs, audioPath,
                    branding.fontFamily as FontFamilyId, workDir,
                );
            }
        }

        // 6. Overlay Remotion (degradación: si falla, clip sin overlay)
        const logoDataUrl = branding.logoBuffer
            ? `data:image/png;base64,${branding.logoBuffer.toString('base64')}`
            : null;
        const overlayPath = await renderOverlay({
            durationMs: clipDurMs,
            personName: dominant?.personName ?? null,
            personRole: dominantRole,
            programName,
            platformName: branding.platformName,
            logoDataUrl,
            outPath: path.join(workDir, 'overlay.webm'),
        });

        // 7. UNA pasada ffmpeg: concat→crop→scale 1080x1920→subs→overlay
        const args: string[] = ['-hide_banner', '-loglevel', 'error'];
        pieces.forEach((p) => {
            args.push('-ss', (p.cutOffsetMs / 1000).toFixed(3), '-t', (p.durMs / 1000).toFixed(3), '-i', p.filePath);
        });
        const overlayIdx = overlayPath ? pieces.length : -1;
        if (overlayPath) args.push('-i', overlayPath);

        const vInputs = pieces.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS[v${i}]`);
        const aInputs = hasAudio ? pieces.map((_, i) => `[${i}:a]asetpts=PTS-STARTPTS[a${i}]`) : [];
        const filters: string[] = [...vInputs, ...aInputs];
        if (pieces.length > 1) {
            const seq = pieces.map((_, i) => (hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)).join('');
            filters.push(hasAudio
                ? `${seq}concat=n=${pieces.length}:v=1:a=1[catv][cata]`
                : `${seq}concat=n=${pieces.length}:v=1:a=0[catv]`);
        } else {
            filters.push('[v0]copy[catv]');
            if (hasAudio) filters.push('[a0]acopy[cata]');
        }
        filters.push(`[catv]crop=${cropW}:${cropH}:x='${xExpr}':y=0,scale=1080:1920[scaled]`);
        const lastV = assPath
            ? (filters.push(`[scaled]ass=subs.ass:fontsdir='${FONTS_DIR.replace(/\\/g, '/')}'[subv]`), '[subv]')
            : '[scaled]';
        let outLabel = lastV;
        if (overlayPath) {
            filters.push(`${lastV}[${overlayIdx}:v]overlay=0:0:format=auto[ovl]`);
            outLabel = '[ovl]';
        }

        args.push('-filter_complex', filters.join(';'));
        args.push('-map', outLabel);
        if (hasAudio) args.push('-map', '[cata]', '-c:a', 'aac', '-b:a', '160k');
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outPath);

        await execFileAsync(FFMPEG, args, { cwd: workDir, timeout: 300_000 });
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
            throw new Error('ffmpeg produjo un clip vacío');
        }

        // 8. Thumbnail
        try {
            await execFileAsync(FFMPEG, [
                '-hide_banner', '-loglevel', 'error',
                '-ss', '1', '-i', outPath,
                '-frames:v', '1', '-q:v', '4', '-y', thumbPath,
            ], { timeout: 30_000 });
        } catch {
            // thumb best-effort
        }

        // 9. Asset + versionado (re-cortes conservan historial)
        let editHistory: Record<string, unknown>[] = [];
        if (payload.recutOfAssetId) {
            const [prev] = await db.select({ editHistory: assets.editHistory, sourceWindow: assets.sourceWindow })
                .from(assets).where(eq(assets.id, payload.recutOfAssetId)).limit(1);
            const prevHistory = Array.isArray(prev?.editHistory) ? (prev.editHistory as Record<string, unknown>[]) : [];
            editHistory = [
                ...prevHistory,
                {
                    event: 'recut',
                    fromAssetId: payload.recutOfAssetId,
                    prevWindow: prev?.sourceWindow ?? null,
                    newWindow: { startMs, endMs },
                    at: new Date().toISOString(),
                },
            ];
        }

        const mediaRefs: Record<string, unknown> = {
            videoPath: relToMedia(outPath),
            ...(fs.existsSync(thumbPath) ? { thumbnailPath: relToMedia(thumbPath) } : {}),
            ...(assPath ? { subtitlesPath: relToMedia(path.join(outDir, `clip_${clipId}.ass`)) } : {}),
        };
        // Persistir una copia del .ass junto al clip (el de workDir se borra).
        if (assPath) {
            const assDest = path.join(outDir, `clip_${clipId}.ass`);
            await fsp.copyFile(assPath, assDest).catch(() => undefined);
        }

        const title = payload.hookText?.trim() || 'Clip';
        const [asset] = await db.insert(assets).values({
            tenantId,
            type: 'clip',
            status: 'pending_review',
            source: 'footage',
            title: title.slice(0, 255),
            mediaRefs,
            transmissionId,
            programId: tx.programId,
            sourceWindow: { startMs: windowStartMs, endMs: windowEndMs },
            editHistory,
            ...(payload.recutOfAssetId ? { legacyRef: { recutOf: payload.recutOfAssetId } } : {}),
        }).returning();

        // asset_persons: speakers atribuidos en la ventana
        const speakerIds = await personIdsInWindow(transmissionId, windowStartMs, windowEndMs).catch(() => [] as string[]);
        for (const pid of speakerIds) {
            await db.insert(assetPersons)
                .values({ assetId: asset.id, personId: pid, role: 'speaker' })
                .onConflictDoNothing();
        }

        // Vincular el momento/marca con el asset renderizado
        if (payload.transmissionSegmentId) {
            await db.execute(sql`
                UPDATE "transmission_segments"
                SET "payload" = COALESCE("payload", '{}'::jsonb) || ${JSON.stringify({ renderAssetId: asset.id })}::jsonb
                WHERE "id" = ${payload.transmissionSegmentId}
            `).catch(() => undefined);
        }

        emitToTenant(tenantId, 'transmission:clip_ready', {
            transmissionId,
            assetId: asset.id,
            title,
            durationMs: clipDurMs,
        });
        emitToTenant(tenantId, 'transmission:update', { transmissionId, clipReady: asset.id });
        void notify({
            tenantId,
            type: 'clip_ready',
            title: `Clip listo: ${title.slice(0, 80)}`,
            message: `Ventana ${Math.round(windowStartMs / 1000)}s–${Math.round(windowEndMs / 1000)}s del crudo`,
            icon: '🎬',
            metadata: { transmissionId, assetId: asset.id },
        });
        void audit({
            tenantId,
            action: 'clip.rendered',
            metadata: {
                transmissionId, assetId: asset.id,
                window: { startMs: windowStartMs, endMs: windowEndMs },
                pieces: pieces.length, subs: !!assPath, overlay: !!overlayPath,
                tramos: tramos?.length ?? 0, recutOf: payload.recutOfAssetId ?? null,
            },
        });
        console.log(`[ClipCutter] tx=${transmissionId} → asset=${asset.id} (${Math.round(clipDurMs / 1000)}s, ${pieces.length} seg, tramos=${tramos?.length ?? 0})`);
        return { assetId: asset.id };
    } finally {
        await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
