/**
 * clipSubtitleService — quema subtítulos + branding sobre el videoPath actual
 * de un clip (PF-03).
 *
 * El clip ya pasó por `cut` (16:9, PF-01) y opcionalmente `reframe` (9:16,
 * PF-02): este servicio toma el `videoPath` vigente — post-reframe si existe,
 * post-cut si no — y produce `output/<clipId>_sub.mp4` con, en UNA sola
 * invocación ffmpeg:
 *
 *   1. `subtitles=<ass>:fontsdir=<fonts>` — cues ASS generados de
 *      `transcript_segments` que se solapan con `metadata.window` (tiempos
 *      absolutos vs `transmissions.started_at`; el cue relativo es
 *      `seg.startMs − window.startMs`, clampeado a [0, duración del clip]).
 *      El estilo del cue (fuente real del tenant, paleta del template) se
 *      deriva de `loadTenantBranding` — dep inyectable, NO re-implementada.
 *   2. Overlay del logo del tenant (PNG temp desde `logoBuffer` bytea):
 *      `[1:v]scale=<13% del ancho>:-1[lg];[..][lg]overlay=W-w-m:m` top-right
 *      con margen ~3% del ancho.
 *   3. `drawbox` barra de progreso fina arriba (`w='t/dur*iw'`, color =
 *      accent del template @0.9).
 *
 * Formato: ASS (Advanced SubStation Alpha), no SRT — SRT no soporta estilo,
 * y el brief exige subs con la identidad del tenant quemada en el video.
 * Los cues `Dialogue` usan estilo `Default` (Alignment=2, bottom-center) y
 * los lower-thirds usan un segundo estilo `LowerThird` (Alignment=1 +
 * `\pos`, fondo BorderStyle=3 con alpha 0x3A) que se emite por CAMBIO de
 * speaker los primeros ~3.5 s de su turno — nombre de `persons.name`
 * (vía `personId`; fallback `speakerLabel` cuando no hay persona resuelta).
 *
 * Paletas: mapeadas de los templates REALES de `templateService.ts` —
 * `dark_gradient`/`solid_bar` ponen el texto sobre caja oscura → los cues
 * llevan BorderStyle=3 con el alpha del template; `minimal`/`split`/
 * `vignette` usan texto libre con sombra → BorderStyle=1 con outline+sombra
 * proporcionales. Todos los templates usan texto blanco y acento blanco:
 * NO se inventan colores (NO TOCAR del brief).
 *
 * Pipeline de `burnSubtitles({tenantId, clipId})` — mismo contrato de
 * estados que PF-02:
 *
 *   - Load tenant-scoped; `videoPath` requerido (`missing_source_video`) y
 *     `metadata.window` requerido (`missing_window` — clip viejo sin la
 *     ventana que escribe PF-01). Errores de validación: la fila NO se toca.
 *   - Status → 'generating'; de ahí en adelante toda falla → 'error' con la
 *     razón en `metadata.error` (auditable, nada a medias).
 *   - `transmissionId` null o 0 utterances solapadas → render IGUAL con
 *     cues=0 (clip sin subs, no es error — degradado).
 *   - Éxito → `videoPath` pasa al MP4 nuevo, el anterior queda en
 *     `metadata.sourceVideoPath` y el detalle en `metadata.subtitles`
 *     (`{cues, lowerThirds, styled, logo, progressBar, renderedAt}`) —
 *     cero columnas nuevas, todo jsonb (NO TOCAR schemas).
 *
 * Encolado: `clipRenderQueueService.enqueue({tenantId, clipId,
 * kind:'subtitles', payload:{clipId}})` — el `clipRenderWorker` despacha a
 * este servicio igual que 'reframe'.
 *
 * Deps inyectables `{store, ffmpegRunner, probe, loadBranding, tempDir,
 * outputDir, fontsDir, now, newId, ffmpegPath, ffprobePath}` — tests sin
 * DB, sin ffmpeg y sin fonts reales. TODA query del store filtra por
 * tenant_id.
 *
 * WINDOWS: los paths dentro del filtergraph viajan con forward slashes y
 * el `:` del drive escapado (`C\:/dir/file.ass`) entre comillas simples —
 * `escapeFilterPath()` se aplica a assPath y fontsDir.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { clips } from '../db/schema/clips.js';
import { transcriptSegments } from '../db/schema/live.js';
import { persons } from '../db/schema/persons.js';
import { findBinary, PROJECT_ROOT } from '../lib/binaries.js';
import type { BrandingConfig, TemplateId } from '../../shared/types.js';
import { loadTenantBranding } from './brandingService.js';
import { FONT_REGISTRY } from './fontService.js';
import {
  createFfmpegRunner,
  msToSec,
  type FfmpegRunner,
} from './clipCutterService.js';
import {
  createFfprobeDimsProbe,
  type VideoDims,
  type VideoDimsProbe,
} from './clipReframeService.js';

// ─── Constantes ─────────────────────────────────────────────────────────────

/** Tope de caracteres por línea de cue (wrap manual con `\N`). */
export const CUE_WRAP_CHARS = 42;
/** Segundos que el lower-third permanece visible al inicio de cada turno. */
export const LOWER_THIRD_SECONDS = 3.5;
/**
 * Alto de la barra de progreso como fracción del alto del video (≈7px en
 * 1080p, ≈13px en 1920) — fina, no tapa el frame.
 */
export const PROGRESS_BAR_H_FRAC = 0.007;
/** Mínimo absoluto del alto de la barra de progreso (px). */
export const PROGRESS_BAR_H_MIN = 5;
/** Ancho del logo como fracción del ancho del video (rango brief 12-15%). */
export const LOGO_WIDTH_FRAC = 0.13;
/** Margen del logo al borde como fracción del ancho del video (~3%). */
export const LOGO_MARGIN_FRAC = 0.03;
/** Margen vertical/lateral de los cues como fracción del alto. */
export const CUE_MARGIN_V_FRAC = 0.05;
/** Margen lateral (L/R) de los cues como fracción del ancho. */
export const CUE_MARGIN_L_FRAC = 0.05;
/**
 * Posición Y del lower-third (ancla bottom-left): 70% del alto — encima de
 * la zona de subtítulos (que ocupa ~95%→abajo) sin tocar el logo top-right.
 */
export const LOWER_THIRD_Y_FRAC = 0.7;
/** Fontsize del estilo Default como fracción de min(w,h) (~65px en 1080p). */
export const FONT_SIZE_FRAC = 0.06;
/** Fontsize del lower-third respecto del Default. */
export const LOWER_THIRD_FONT_RATIO = 0.78;

// ─── API pública ────────────────────────────────────────────────────────────

export interface BurnSubtitlesInput {
  tenantId: string;
  clipId: string;
}

export interface BurnSubtitlesResult {
  clipId: string;
  /** MP4 con subs+branding quemados (`output/<clipId>_sub.mp4`). */
  videoPath: string;
  /** Cues efectivamente quemados (post-overlap/clamp; 0 = clip sin subs). */
  cues: number;
  /** Eventos lower-third emitidos (cambios de speaker con nombre). */
  lowerThirds: number;
  /** Se quemó el logo del tenant. */
  logo: boolean;
  /** Se quemó la barra de progreso. */
  progressBar: boolean;
}

// ─── Errores tipados ────────────────────────────────────────────────────────

export type ClipSubtitlesErrorReason =
  | 'clip_not_found' // el clip no existe para ESTE tenant (404)
  | 'missing_source_video' // videoPath null — no hay fuente que quemar
  | 'missing_window' // metadata.window ausente/inválido (clip viejo)
  | 'probe_failed' // ffprobe no pudo leer dimensiones del fuente
  | 'ffmpeg_failed'; // render final falló (fila 'error')

export class ClipSubtitlesError extends Error {
  readonly reason: ClipSubtitlesErrorReason;

  constructor(reason: ClipSubtitlesErrorReason, message: string) {
    super(message);
    this.name = 'ClipSubtitlesError';
    this.reason = reason;
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

/** Lo único del clip que la quemada necesita leer. */
export interface SubtitleClipRow {
  id: string;
  tenantId: string;
  /** Transmisión origen (PF-01 la escribe). null → sin utterances posibles. */
  transmissionId: string | null;
  /** MP4 fuente vigente (post-cut o post-reframe). null → missing_source_video. */
  videoPath: string | null;
  /** Duración en segundos (columna `clips.duration`). */
  duration: number;
  status: string;
  /** jsonb — `metadata.window={startMs,endMs}` absolutos la escribe PF-01. */
  metadata: Record<string, unknown> | null;
}

/** Utterance de transcript_segments solapada con la ventana del clip. */
export interface SubtitleUtterance {
  /** Absolutos vs transmissions.started_at (bigint en schema). */
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  personId: string | null;
  text: string;
}

export interface SubtitleClipPatch {
  videoPath?: string | null;
  status: string;
  /** Reemplazo COMPLETO de metadata (no merge — el servicio manda todo). */
  metadata?: Record<string, unknown>;
}

export interface SubtitleStore {
  /** Clip por id acotado al tenant — null si no existe o es ajeno. */
  getClip(tenantId: string, clipId: string): Promise<SubtitleClipRow | null>;
  /**
   * Utterances de `transmissionId` que se SOLAPAN con [startMs, endMs)
   * (`seg.startMs < endMs AND seg.endMs > startMs`), ordenadas por startMs.
   * Tiempos absolutos — el shift a relativos lo hace `buildAssFile`.
   */
  listUtterances(
    tenantId: string,
    transmissionId: string,
    startMs: number,
    endMs: number,
  ): Promise<SubtitleUtterance[]>;
  /** Map personId → persons.name para los ids dados (tenant-scoped). */
  getPersonNames(
    tenantId: string,
    personIds: string[],
  ): Promise<Map<string, string>>;
  /** Update por id acotado al tenant (mismo WHERE que getClip). */
  updateClip(
    tenantId: string,
    clipId: string,
    patch: SubtitleClipPatch,
  ): Promise<void>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleSubtitleStore(
  executor: Database = db,
): SubtitleStore {
  return {
    async getClip(tenantId, clipId) {
      const [row] = await executor
        .select({
          id: clips.id,
          tenantId: clips.tenantId,
          transmissionId: clips.transmissionId,
          videoPath: clips.videoPath,
          duration: clips.duration,
          status: clips.status,
          metadata: clips.metadata,
        })
        .from(clips)
        .where(and(eq(clips.id, clipId), eq(clips.tenantId, tenantId)))
        .limit(1);
      if (!row) return null;
      return {
        ...row,
        metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      };
    },

    async listUtterances(tenantId, transmissionId, startMs, endMs) {
      const rows = await executor
        .select({
          startMs: transcriptSegments.startMs,
          endMs: transcriptSegments.endMs,
          speakerLabel: transcriptSegments.speakerLabel,
          personId: transcriptSegments.personId,
          text: transcriptSegments.text,
        })
        .from(transcriptSegments)
        .where(
          and(
            eq(transcriptSegments.tenantId, tenantId),
            eq(transcriptSegments.transmissionId, transmissionId),
            // Overlap: empieza antes de que cierre la ventana Y termina
            // después de que abre (toca el borde → cuenta).
            lt(transcriptSegments.startMs, endMs),
            gt(transcriptSegments.endMs, startMs),
          ),
        )
        .orderBy(asc(transcriptSegments.startMs));
      return rows;
    },

    async getPersonNames(tenantId, personIds) {
      if (personIds.length === 0) return new Map();
      const rows = await executor
        .select({ id: persons.id, name: persons.name })
        .from(persons)
        .where(and(eq(persons.tenantId, tenantId), inArray(persons.id, personIds)));
      return new Map(rows.map((r) => [r.id, r.name]));
    },

    async updateClip(tenantId, clipId, patch) {
      await executor
        .update(clips)
        .set({
          ...(patch.videoPath !== undefined
            ? { videoPath: patch.videoPath }
            : {}),
          status: patch.status,
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        })
        .where(and(eq(clips.id, clipId), eq(clips.tenantId, tenantId)));
    },
  };
}

// ─── Dependencias inyectables ───────────────────────────────────────────────

/** Branding del tenant — default `loadTenantBranding` (PF-03 lo consume). */
export type LoadBranding = (tenantId: string) => Promise<BrandingConfig>;

export interface ClipSubtitlesDeps {
  /** Runner ffmpeg (mismo contrato que PF-01/02). Default: spawn real. */
  ffmpegRunner?: FfmpegRunner;
  /** Default: ffprobe real (reusa `createFfprobeDimsProbe` de PF-02). */
  probe?: VideoDimsProbe;
  /** Default: `loadTenantBranding` real (cache 5 min incluido). */
  loadBranding?: LoadBranding;
  /** Dir del .ass + logo.png temp. Default `os.tmpdir()`. */
  tempDir?: string;
  /** Dir del MP4 final. Default `<repo>/output` (convención `videoPath`). */
  outputDir?: string;
  /** Dir de las fuentes TTF del proyecto. Default `<repo>/fonts`. */
  fontsDir?: string;
  now?: () => Date;
  /** Generador de ids para temporales (determinista en tests). */
  newId?: () => string;
  ffmpegPath?: string;
  ffprobePath?: string;
}

// ─── Estilo por template (puro — mapeo de templateService.ts REAL) ─────────

/**
 * Estilo resuelto para el clip. Colores en formato ASS `&HAABBGGRR`
 * (alpha invertido: 00=opaco, FF=transparente; orden BGR).
 */
export interface SubtitleStyle {
  /** Familia real para `FontName` (FONT_REGISTRY[fontFamily].family). */
  fontName: string;
  /** Tamaño del estilo Default (~6% de min(w,h)). */
  fontSize: number;
  /** Texto de los cues — siempre blanco (todos los templates usan blanco). */
  primary: string;
  /** Color del outline/sombra — negro (sombra oscura de los templates). */
  outline: string;
  /** Grosor del outline en px (BorderStyle=1 lo usa; en 3 es el borde de caja). */
  outlineWidth: number;
  /**
   * Alpha (0-255) del fondo de caja cuando `borderStyle=3`
   * (dark_gradient/solid_bar); ignorado con BorderStyle=1.
   */
  boxAlpha: number;
  /** 1 = outline+sombra (templates sin caja), 3 = caja opaca (\bord). */
  borderStyle: 1 | 3;
  /** Blur/sombra en px (vignette usa sombra fuerte → 3). */
  shadow: number;
  /** Color de acento para drawbox/lower-third — ASS `&HAABBGGRR`. */
  accentAss: string;
  /** Mismo acento para ffmpeg drawbox (`white@0.9` etc.). */
  accentDrawbox: string;
  /** MarginV del estilo Default (~5% del alto). */
  marginV: number;
  /** MarginL/R (~5% del ancho). */
  marginL: number;
  /** Tamaño de fuente del lower-third. */
  lowerThirdFontSize: number;
  /** Coordenada Y del `\pos` del lower-third (ancla bottom-left, ~70% alto). */
  lowerThirdY: number;
}

interface TemplatePalette {
  /** BackColour alpha para BorderStyle=3 (null → estilo sin caja). */
  boxAlpha: number | null;
  outline: number;
  shadow: number;
}

/**
 * Paletas derivadas de `templateService.ts` (fuente única — NO inventadas):
 *
 *  - dark_gradient: título sobre `rgba(0,0,0,0.7)` → caja ASS alpha 0x4C
 *    ((1−0.7)·255 ≈ 76). Texto blanco.
 *  - solid_bar: barra opaca `rgba(0,0,0,0.85)` + línea blanca → caja más
 *    densa (alpha 0x26 ≈ (1−0.85)·255). Texto blanco.
 *  - minimal: sin caja (solo oscurecido global 0.45) → BorderStyle=1 con
 *    outline grueso para mantener legibilidad sin fondo.
 *  - split: texto libre sobre gradiente lateral → BorderStyle=1, outline
 *    medio + sombra leve.
 *  - vignette: `shadowColor rgba(0,0,0,0.9)` + blur 12 → BorderStyle=1 con
 *    sombra fuerte (Shadow=3), outline medio.
 *
 * En TODOS los templates el texto y el acento son blancos → primary, accent
 * y el color de la barra de progreso son `&H00FFFFFF`/`white`.
 */
export const TEMPLATE_PALETTES: Record<TemplateId, TemplatePalette> = {
  dark_gradient: { boxAlpha: 0x4c, outline: 1.5, shadow: 0.5 },
  solid_bar: { boxAlpha: 0x26, outline: 1.5, shadow: 0.5 },
  minimal: { boxAlpha: null, outline: 3, shadow: 1 },
  split: { boxAlpha: null, outline: 2, shadow: 1 },
  vignette: { boxAlpha: null, outline: 2, shadow: 3 },
};

const FALLBACK_FONT_NAME = 'Arial';

/**
 * Resuelve el estilo de los cues desde el branding del tenant + dimensiones
 * del video (pura — brief). `fontName` sale de `FONT_REGISTRY` (family real
 * del TTF, sin comillas — ASS quiere el nombre de familia); colores por
 * `templateId` desde `TEMPLATE_PALETTES`.
 */
export function resolveSubtitleStyle(
  branding: Pick<BrandingConfig, 'fontFamily' | 'templateId'>,
  dims: { width: number; height: number },
): SubtitleStyle {
  const palette = TEMPLATE_PALETTES[branding.templateId] ?? TEMPLATE_PALETTES.dark_gradient;
  const fontName =
    FONT_REGISTRY[branding.fontFamily]?.family ?? FALLBACK_FONT_NAME;
  const base = Math.min(dims.width, dims.height);
  const fontSize = Math.max(20, Math.round(base * FONT_SIZE_FRAC));
  return {
    fontName,
    fontSize,
    primary: '&H00FFFFFF', // blanco — todos los templates
    outline: '&H00000000', // negro — sombra/borde de los templates
    outlineWidth: palette.outline,
    boxAlpha: palette.boxAlpha ?? 0x80,
    borderStyle: palette.boxAlpha === null ? 1 : 3,
    shadow: palette.shadow,
    accentAss: '&H00FFFFFF',
    accentDrawbox: 'white',
    marginV: Math.round(dims.height * CUE_MARGIN_V_FRAC),
    marginL: Math.round(dims.width * CUE_MARGIN_L_FRAC),
    lowerThirdFontSize: Math.max(
      16,
      Math.round(fontSize * LOWER_THIRD_FONT_RATIO),
    ),
    lowerThirdY: Math.round(dims.height * LOWER_THIRD_Y_FRAC),
  };
}

// ─── Generación ASS (puras, exportadas) ─────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** ms → timestamp ASS `h:mm:ss.cc` (centésimas, floor — nunca 100). */
export function msToAssTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1_000) % 60;
  const cc = Math.floor((total % 1_000) / 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cc)}`;
}

/**
 * Escape del texto de un cue: `\` → `\\` primero (para no re-escapar lo que
 * agregamos después), luego `{`/`}` → `\{`/`\}` — las llaves abren bloques
 * de override ASS y romperían el cue (brief).
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

/**
 * Wrap manual a ~`maxChars` por línea uniendo con `\N` (salto duro ASS).
 * No corta palabras; una palabra más larga que maxChars queda entera en su
 * línea. Devuelve las líneas ya unidas.
 */
export function wrapCueText(text: string, maxChars = CUE_WRAP_CHARS): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const lines: string[] = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    if (line.length + 1 + word.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line += ' ' + word;
    }
  }
  lines.push(line);
  return lines.join('\\N');
}

/** Utterance ya convertida a tiempos relativos del clip (ms). */
export interface RelativeUtterance extends SubtitleUtterance {
  relStartMs: number;
  relEndMs: number;
}

/**
 * Cue relativo al clip: `seg.startMs − windowStartMs` clampeado a
 * [0, durationMs]. Descarta utterances que quedan FUERA de la ventana
 * (`relEnd <= 0` o `relStart >= durationMs`) o con duración ≤ 0 tras clamp.
 * (Pura — el store devuelve absolutos; el shift vive acá, testeable.)
 */
export function toRelativeUtterances(
  utterances: SubtitleUtterance[],
  windowStartMs: number,
  durationMs: number,
): RelativeUtterance[] {
  const out: RelativeUtterance[] = [];
  for (const u of utterances) {
    const relStartMs = clamp(u.startMs - windowStartMs, 0, durationMs);
    const relEndMs = clamp(u.endMs - windowStartMs, 0, durationMs);
    if (relEndMs <= relStartMs) continue;
    out.push({ ...u, relStartMs, relEndMs });
  }
  return out;
}

/** Evento lower-third resuelto (uno por CAMBIO de speaker con nombre). */
export interface LowerThirdEvent {
  relStartMs: number;
  relEndMs: number;
  /** Texto ya en mayúsculas (NOMBRE PERSONA / SPEAKER LABEL). */
  label: string;
}

/**
 * Runs de speaker consecutivos → eventos lower-third (pura).
 *
 * La "identidad" del speaker es `personId ?? speakerLabel` (mismo contrato
 * que la Sala): un cambio de identidad abre un turno nuevo y emite un
 * lower-third desde el inicio del turno durante `LOWER_THIRD_SECONDS`
 * (o hasta el fin del turno si es más corto). El nombre mostrado es
 * `personNames[personId]`, con fallback a `speakerLabel` cuando la persona
 * no resolvió nombre; turnos sin ninguna identidad no emiten evento.
 */
export function lowerThirdEvents(
  utterances: RelativeUtterance[],
  personNames: ReadonlyMap<string, string>,
  durationMs: number,
  visibleMs = LOWER_THIRD_SECONDS * 1000,
): LowerThirdEvent[] {
  const events: LowerThirdEvent[] = [];
  let runKey: string | null = null;
  let runStart = 0;
  let runEnd = 0;
  let runLabel: string | null = null;

  const flush = () => {
    if (runKey === null || runLabel === null) return;
    const end = Math.min(runStart + visibleMs, runEnd, durationMs);
    if (end > runStart) {
      events.push({ relStartMs: runStart, relEndMs: end, label: runLabel });
    }
  };

  for (const u of utterances) {
    const name = u.personId ? personNames.get(u.personId) : undefined;
    const label = (name ?? u.speakerLabel) || null;
    const key = u.personId ?? u.speakerLabel ?? '';
    if (key !== runKey) {
      flush();
      runKey = key;
      runStart = u.relStartMs;
      runLabel = label;
    } else {
      // Mismo turno: si la primera utterance no tenía nombre pero esta sí
      // (personId resuelto a mitad del turno), se adopta — el run no se
      // corta, solo se completa la identidad.
      runLabel ??= label;
    }
    runEnd = u.relEndMs;
  }
  flush();
  return events
    .filter((e) => e.label)
    .map((e) => ({ ...e, label: e.label.toUpperCase() }));
}

export interface BuildAssFileInput {
  utterances: SubtitleUtterance[];
  /** `metadata.window.startMs` del clip — base del shift a relativo. */
  windowStartMs: number;
  /** Duración real del video del clip (ms) para el clamp final. */
  durationMs: number;
  style: SubtitleStyle;
  /** personId → nombre (store.getPersonNames). */
  personNames: ReadonlyMap<string, string>;
  /** PlayResX/Y — dims del video (default 1080×1920 si no se pasan). */
  playResX?: number;
  playResY?: number;
}

export interface BuiltAssFile {
  /** Contenido completo del .ass. */
  content: string;
  /** Cues `Default` efectivamente emitidos. */
  cues: number;
  /** Eventos `LowerThird` emitidos. */
  lowerThirds: number;
}

/**
 * Genera el .ass completo (pura — el corazón del slice):
 *
 *  - `[V4+ Styles]` con `Default` (Alignment=2 bottom-center, fuente y
 *    colores del tenant) y `LowerThird` (BorderStyle=3, fondo `3a` alpha).
 *  - `[Events]` con un `Dialogue` por utterance solapada, tiempos relativos
 *    `h:mm:ss.cc`, texto escapado + wrap `\N` — ordenados por start.
 *  - Los lower-thirds son `Dialogue` del estilo `LowerThird` con
 *    `{\pos(x,y)}` sobre la zona de subs.
 */
export function buildAssFile(input: BuildAssFileInput): BuiltAssFile {
  const { utterances, windowStartMs, durationMs, style, personNames } = input;
  const resX = input.playResX ?? 1080;
  const resY = input.playResY ?? 1920;

  const backColour = `&H${style.boxAlpha.toString(16).toUpperCase().padStart(2, '0')}000000`;
  const lowerThirdBack = '&H3A000000'; // fondo 0x3A alpha (brief)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${resX}`,
    `PlayResY: ${resY}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Default: subs bottom-center (Alignment=2) con el estilo del tenant.
    `Style: Default,${style.fontName},${style.fontSize},${style.primary},&H000000FF,${style.outline},${backColour},-1,0,0,0,100,100,0,0,${style.borderStyle},${style.outlineWidth},${style.shadow},2,${style.marginL},${style.marginL},${style.marginV},1`,
    // LowerThird: caja con fondo alpha 0x3A + \pos (Alignment=1 bottom-left).
    `Style: LowerThird,${style.fontName},${style.lowerThirdFontSize},${style.accentAss},&H000000FF,${style.outline},${lowerThirdBack},-1,0,0,0,100,100,0,0,3,2,0,1,${style.marginL},${style.marginL},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const relative = toRelativeUtterances(utterances, windowStartMs, durationMs);
  const lines: string[] = [];

  for (const u of relative) {
    const text = wrapCueText(escapeAssText(u.text));
    if (!text) continue;
    lines.push(
      `Dialogue: 0,${msToAssTime(u.relStartMs)},${msToAssTime(u.relEndMs)},Default,,0,0,0,,${text}`,
    );
  }

  const thirds = lowerThirdEvents(relative, personNames, durationMs);
  for (const e of thirds) {
    const label = escapeAssText(e.label);
    lines.push(
      `Dialogue: 0,${msToAssTime(e.relStartMs)},${msToAssTime(e.relEndMs)},LowerThird,,0,0,0,,{\\pos(${style.marginL},${style.lowerThirdY})}${label}`,
    );
  }

  return {
    content: header.concat(lines).join('\r\n') + '\r\n',
    cues: lines.length - thirds.length,
    lowerThirds: thirds.length,
  };
}

// ─── Filter graph ffmpeg (puros, exportados) ────────────────────────────────

/**
 * Path de archivo → valor seguro dentro del filtergraph: forward slashes,
 * `:` del drive escapado `\:` y `'` escapado — listo para envolver en
 * comillas simples (`subtitles='C\:/dir/f.ass'`). Windows-safe por brief.
 */
export function escapeFilterPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

/**
 * `drawbox` de la barra de progreso (pura): franja fina en el borde
 * superior que crece con el tiempo — `w='t/<dur>s*iw'` llega a `iw`
 * exactamente en el último frame. `color=<accent>@0.9` (leve transparencia
 * del brief).
 */
export function buildProgressFilter(
  durationSec: number,
  dims: { width: number; height: number },
  accent: string,
): string {
  const barH = Math.max(
    PROGRESS_BAR_H_MIN,
    Math.round(dims.height * PROGRESS_BAR_H_FRAC),
  );
  const dur = durationSec > 0 ? durationSec : 1;
  return `drawbox=x=0:y=0:w='t/${dur.toFixed(3)}*iw':h=${barH}:color=${accent}@0.9:t=fill`;
}

export interface BuildBurnArgsInput {
  inputPath: string;
  outputPath: string;
  /** Path del .ass temp — se escapa acá adentro. */
  assPath: string;
  /** Dir de fuentes para `fontsdir=` — se escapa acá adentro. */
  fontsDir: string;
  /** PNG temp del logo; null → sin overlay. */
  logoPath: string | null;
  /** Duración del video (s) para la expresión de progreso. */
  durationSec: number;
  dims: { width: number; height: number };
  /** Acento para drawbox (`style.accentDrawbox`). */
  accent: string;
}

/**
 * Args de la ÚNICA invocación ffmpeg (pura). Orden del brief:
 * subtitles → overlay logo → drawbox progreso; `-c:a copy`.
 *
 * Sin logo la cadena es `[0:v]subtitles=…[s0];[s0]drawbox=…` (salida sin
 * etiqueta → auto-map como video, igual que el vstack de PF-02). Con logo
 * se agrega el segundo input `[1:v]scale=<13%>:-1[lg]` y el overlay
 * `W-w-m:m` (margen ~3%). Re-encode obligatorio (filtros queman pixels);
 * audio copiado sin tocar.
 */
export function buildBurnArgs(input: BuildBurnArgsInput): string[] {
  const ass = escapeFilterPath(input.assPath);
  const fonts = escapeFilterPath(input.fontsDir);
  const subtitlesFilter = `subtitles='${ass}':fontsdir='${fonts}'`;
  const progress = buildProgressFilter(input.durationSec, input.dims, input.accent);

  let filterComplex: string;
  const argv: string[] = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input.inputPath,
  ];

  if (input.logoPath) {
    argv.push('-i', input.logoPath);
    const logoW = Math.round(input.dims.width * LOGO_WIDTH_FRAC);
    const margin = Math.round(input.dims.width * LOGO_MARGIN_FRAC);
    filterComplex =
      `[0:v]${subtitlesFilter}[s0];` +
      `[1:v]scale=${logoW}:-1[lg];` +
      `[s0][lg]overlay=W-w-${margin}:${margin}[s1];` +
      `[s1]${progress}`;
  } else {
    filterComplex = `[0:v]${subtitlesFilter}[s0];[s0]${progress}`;
  }

  argv.push(
    '-filter_complex',
    filterComplex,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    '-y',
    input.outputPath,
  );
  return argv;
}

// ─── Servicio ───────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** metadata.window como la escribe PF-01: `{startMs,endMs}` absolutos. */
interface ClipWindow {
  startMs: number;
  endMs: number;
}

function readWindow(
  metadata: Record<string, unknown> | null,
): ClipWindow | null {
  const w = metadata?.window as { startMs?: unknown; endMs?: unknown } | undefined;
  const startMs = Number(w?.startMs);
  const endMs = Number(w?.endMs);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs ||
    startMs < 0
  ) {
    return null;
  }
  return { startMs, endMs };
}

export function createClipSubtitleService(
  store: SubtitleStore = createDrizzleSubtitleStore(),
  deps: ClipSubtitlesDeps = {},
) {
  const ffmpegRunner =
    deps.ffmpegRunner ??
    createFfmpegRunner(deps.ffmpegPath ?? findBinary('ffmpeg'));
  const probe =
    deps.probe ??
    createFfprobeDimsProbe(deps.ffprobePath ?? findBinary('ffprobe'));
  const loadBranding = deps.loadBranding ?? loadTenantBranding;
  const tempDir = deps.tempDir ?? os.tmpdir();
  const outputDir = deps.outputDir ?? path.join(PROJECT_ROOT, 'output');
  const fontsDir = deps.fontsDir ?? path.join(PROJECT_ROOT, 'fonts');
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  async function burnSubtitles(
    input: BurnSubtitlesInput,
  ): Promise<BurnSubtitlesResult> {
    const { tenantId, clipId } = input;

    // 1. Clip del tenant + fuente + ventana. Errores de validación: la fila
    //    NO se toca (mismo contrato que PF-01/02).
    const clip = await store.getClip(tenantId, clipId);
    if (!clip) {
      throw new ClipSubtitlesError(
        'clip_not_found',
        `Clip ${clipId} no encontrado para el tenant ${tenantId}`,
      );
    }
    if (!clip.videoPath) {
      throw new ClipSubtitlesError(
        'missing_source_video',
        `Clip ${clipId} no tiene videoPath — nada que quemar`,
      );
    }
    const window = readWindow(clip.metadata);
    if (!window) {
      throw new ClipSubtitlesError(
        'missing_window',
        `Clip ${clipId} no tiene metadata.window — sin ventana no hay cues`,
      );
    }
    const sourcePath = clip.videoPath;
    const baseMetadata: Record<string, unknown> = { ...(clip.metadata ?? {}) };

    // 2. Render en vuelo — de acá en adelante cualquier falla deja la fila
    //    en 'error' con la razón (auditable, como PF-01/02).
    await store.updateClip(tenantId, clipId, { status: 'generating' });

    const tempPaths: string[] = [];
    const markError = async (reason: string) => {
      await store
        .updateClip(tenantId, clipId, {
          status: 'error',
          metadata: { ...baseMetadata, error: reason },
        })
        .catch(() => {}); // nunca enmascarar el error original
    };

    try {
      // 3. Dimensiones del fuente (probe inyectable — nunca hardcodeadas).
      const dims: VideoDims = await probe(sourcePath).catch((err: unknown) => {
        throw new ClipSubtitlesError(
          'probe_failed',
          `No se pudieron leer las dimensiones de ${sourcePath}: ${errorMessage(err)}`,
        );
      });

      // 4. Utterances solapadas con la ventana + nombres de personas.
      //    Sin transmissionId → clip sin subs posibles (render igual, cues=0).
      const utterances = clip.transmissionId
        ? await store.listUtterances(
            tenantId,
            clip.transmissionId,
            window.startMs,
            window.endMs,
          )
        : [];
      const personIds = [
        ...new Set(
          utterances
            .map((u) => u.personId)
            .filter((id): id is string => id !== null),
        ),
      ];
      const personNames = await store.getPersonNames(tenantId, personIds);

      // 5. Branding del tenant (dep inyectable — la query vive en
      //    brandingService) + estilo resuelto para las dims reales.
      const branding = await loadBranding(tenantId);
      const style = resolveSubtitleStyle(branding, {
        width: dims.width,
        height: dims.height,
      });

      // 6. Duración real del clip para clamp + expresión de progreso:
      //    clips.duration (s) si está; fallback a la duración del contenedor
      //    del probe; última instancia, el largo de la ventana.
      const durationMs =
        clip.duration > 0
          ? clip.duration * 1000
          : (dims.durationMs ?? window.endMs - window.startMs);

      // 7. ASS a temp + logo a PNG temp si hay buffer.
      const uid = newId();
      await fs.mkdir(tempDir, { recursive: true });
      const assPath = path.join(tempDir, `pf03-subs-${uid}.ass`);
      tempPaths.push(assPath);
      const built = buildAssFile({
        utterances,
        windowStartMs: window.startMs,
        durationMs,
        style,
        personNames,
        playResX: dims.width,
        playResY: dims.height,
      });
      await fs.writeFile(assPath, built.content, 'utf8');

      let logoPath: string | null = null;
      if (branding.logoBuffer) {
        logoPath = path.join(tempDir, `pf03-logo-${uid}.png`);
        tempPaths.push(logoPath);
        await fs.writeFile(logoPath, branding.logoBuffer);
      }

      // 8. UNA invocación ffmpeg: subtitles → logo → progreso, `-c:a copy`.
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${clipId}_sub.mp4`);
      await ffmpegRunner(
        buildBurnArgs({
          inputPath: sourcePath,
          outputPath,
          assPath,
          fontsDir,
          logoPath,
          durationSec: durationMs / 1000,
          dims,
          accent: style.accentDrawbox,
        }),
      );

      // 9. Éxito: videoPath → archivo nuevo; el anterior auditable en
      //    metadata.sourceVideoPath + detalle en metadata.subtitles.
      const metadata: Record<string, unknown> = {
        ...baseMetadata,
        sourceVideoPath: sourcePath,
        subtitles: {
          cues: built.cues,
          lowerThirds: built.lowerThirds,
          styled: true,
          logo: logoPath !== null,
          progressBar: true,
          renderedAt: now().toISOString(),
        },
      };
      await store.updateClip(tenantId, clipId, {
        videoPath: outputPath,
        status: 'pending_review',
        metadata,
      });

      return {
        clipId,
        videoPath: outputPath,
        cues: built.cues,
        lowerThirds: built.lowerThirds,
        logo: logoPath !== null,
        progressBar: true,
      };
    } catch (err) {
      const reason = errorMessage(err);
      await markError(reason);
      if (err instanceof ClipSubtitlesError) throw err;
      throw new ClipSubtitlesError(
        'ffmpeg_failed',
        `Quemado de subtítulos del clip ${clipId} falló: ${reason}`,
      );
    } finally {
      // Temps (.ass, logo.png) SIEMPRE se limpian — haya o no error.
      await Promise.all(
        tempPaths.map((p) => fs.rm(p, { force: true }).catch(() => {})),
      );
    }
  }

  return { burnSubtitles };
}

export const clipSubtitleService = createClipSubtitleService();
