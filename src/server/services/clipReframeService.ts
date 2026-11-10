/**
 * clipReframeService — re-encuadre 9:16 inteligente de un clip existente (PF-02).
 *
 * PF-01 deja el clip crudo 16:9 en `clips.videoPath`; este servicio produce la
 * versión vertical `output/<clipId>_916.mp4` y la deja en el mismo clip:
 * `videoPath` pasa al archivo nuevo y el original queda auditable en
 * `metadata.sourceVideoPath`. Detrás va en el mismo jsonb `metadata.reframe`
 * la decisión de layout (`{layout, samples, facesDetected, centerX…}`) — NO
 * hay columna nueva (NO TOCAR del brief).
 *
 * Pipeline de `reframeClip({tenantId, clipId})`:
 *
 *   1. Load del clip acotado por tenant (404 tipado si no es del tenant) +
 *      `videoPath` requerido (`missing_source_video` si no hay fuente). Los
 *      errores de validación NO tocan la fila — como en PF-01.
 *   2. Status → 'generating' (mismo estado no-terminal que usa PF-01 para
 *      "render en vuelo") y de ahí en adelante TODA falla deja la fila en
 *      'error' con la razón en `metadata.error` — nada queda a medias.
 *   3. Probe de dimensiones del fuente (ffprobe inyectable — NO hardcodeado)
 *      + M=`sampleCount` frames uniformes sobre `clip.duration` (posiciones
 *      al centro de cada slot `(i+.5)/N`: evita el borde exacto 0/fin). El
 *      `frameExtractor` default corre ffmpeg a un jpg temp y se detecta con
 *      el `FaceDetector` real; un frame que no se puede extraer cuenta como
 *      sample sin caras (no mata el render); un detect() que falla SÍ —
 *      el detector entero caído es infra rota, no "frame sin cara".
 *   4. `decideLayout(samples)` (pura): centro del rostro dominante por frame
 *      (mayor área de bbox) + clustering 1-D de TODAS las posiciones x.
 *        - `center`: 0 caras en todo el clip → crop centrado estándar.
 *        - `split`: ≥2 clusters estables — cada uno presente en ≥30% de los
 *          frames CON cara (`SPLIT_MIN_SUPPORT`) y separados >25% del ancho
 *          (`SPLIT_MIN_SEPARATION`) → dos crops izq/der apilados en vertical.
 *        - `single` (default): crop ancho `ih*9/16` centrado en la MEDIANA de
 *          los centros dominantes (robusta a outliers; la media la arrastraría
 *          un frame ruidoso). x se clampea a `[0, iw−cropW]`.
 *   5. UNA invocación ffmpeg: `crop=…,scale=1080:1920` para single/center o
 *      `filter_complex` con dos `crop…,scale=1080:960` + `vstack` para split.
 *      `-c:a copy` (el audio del clip no se toca). Temps limpios en `finally`.
 *
 * bbox del detector: el contrato real de `DetectedFace.bbox` es
 * `[x1, y1, x2, y2]` (esquinas, coords de la imagen — ver
 * faceDetectionService.ts), NO `[x,y,w,h]`: el centro x es `(x1+x2)/2` y el
 * área `(x2−x1)·(y2−y1)`. El frame se extrae a resolución nativa, así que las
 * coords del bbox viven en los mismos píxeles que `iw`×`ih` del probe.
 *
 * Encolado (sin helper dedicado — la cola genérica ya lo soporta):
 *   `clipRenderQueueService.enqueue({tenantId, clipId, kind:'reframe',
 *   payload:{clipId}})` y el `clipRenderWorker` lo despacha a este servicio.
 *
 * Deps inyectables con defaults reales; `detector` se resuelve LAZY dentro de
 * `reframeClip` (`getFaceDetector()` descarga modelos ONNX — nunca en import
 * ni en construcción del servicio). TODA query del store filtra por tenant_id.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { clips } from '../db/schema/clips.js';
import { findBinary, PROJECT_ROOT } from '../lib/binaries.js';
import {
  createFfmpegRunner,
  msToSec,
  type FfmpegRunner,
} from './clipCutterService.js';
import {
  getFaceDetector,
  type DetectedFace,
  type FaceDetector,
} from './faceDetectionService.js';

// ─── Constantes ─────────────────────────────────────────────────────────────

/** Frames sampleados por clip (default; dentro del ~8-10 del brief). */
export const SAMPLE_COUNT = 9;
/** Un cluster cuenta como "persona estable" si aparece en ≥30% de los frames CON cara. */
export const SPLIT_MIN_SUPPORT = 0.3;
/** Dos posiciones x separadas >25% del ancho son personas distintas. */
export const SPLIT_MIN_SEPARATION = 0.25;
/** Salida vertical fija. */
export const OUTPUT_W = 1080;
export const OUTPUT_H = 1920;
/** Cada mitad del split: 1080×960 (9:8) apiladas → 1080×1920. */
export const SPLIT_HALF_H = 960;

// ─── API pública ────────────────────────────────────────────────────────────

export interface ReframeClipInput {
  tenantId: string;
  clipId: string;
}

export interface ReframeClipResult {
  clipId: string;
  /** Ruta local del MP4 9:16 (`output/<clipId>_916.mp4`). */
  videoPath: string;
  layout: ReframeLayoutKind;
  /** Frames sampleados (los sin cara también cuentan). */
  samples: number;
  /** Caras detectadas en total (suma de faceCount de los samples). */
  facesDetected: number;
}

// ─── Errores tipados ────────────────────────────────────────────────────────

export type ClipReframeErrorReason =
  | 'clip_not_found' // el clip no existe para ESTE tenant (404)
  | 'missing_source_video' // videoPath null — no hay fuente que reencuadrar
  | 'probe_failed' // ffprobe no pudo leer dimensiones del fuente
  | 'detector_unavailable' // el FaceDetector real falló (modelos/red)
  | 'ffmpeg_failed'; // extracción global o render final falló (fila 'error')

export class ClipReframeError extends Error {
  readonly reason: ClipReframeErrorReason;

  constructor(reason: ClipReframeErrorReason, message: string) {
    super(message);
    this.name = 'ClipReframeError';
    this.reason = reason;
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

/** Lo único del clip que el reframe necesita leer. */
export interface ReframeClipRow {
  id: string;
  tenantId: string;
  /** MP4 fuente 16:9 (de PF-01). null → `missing_source_video`. */
  videoPath: string | null;
  /** Duración en segundos (columna `clips.duration` — entera en s). */
  duration: number;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface ReframeClipPatch {
  videoPath?: string | null;
  status: string;
  /** Reemplazo COMPLETO de metadata (no merge — el servicio manda todo). */
  metadata?: Record<string, unknown>;
}

export interface ReframeStore {
  /** Clip por id acotado al tenant — null si no existe o es ajeno. */
  getClip(tenantId: string, clipId: string): Promise<ReframeClipRow | null>;
  /** Update por id acotado al tenant (mismo WHERE que getClip). */
  updateClip(
    tenantId: string,
    clipId: string,
    patch: ReframeClipPatch,
  ): Promise<void>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleReframeStore(
  executor: Database = db,
): ReframeStore {
  return {
    async getClip(tenantId, clipId) {
      const [row] = await executor
        .select({
          id: clips.id,
          tenantId: clips.tenantId,
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

/** Dimensiones del video fuente (probe real: ffprobe). */
export interface VideoDims {
  width: number;
  height: number;
  /** Duración del contenedor (ms) — fallback cuando `clips.duration` es 0. */
  durationMs: number | null;
}

export type VideoDimsProbe = (filePath: string) => Promise<VideoDims>;

/**
 * Extrae UN frame del video a jpeg y devuelve sus bytes. `destPath` lo elige
 * el servicio (bajo `tempDir`) y queda registrado para limpieza — el
 * extractor puede simplemente escribirlo o devolver el Buffer por otro medio.
 */
export type FrameExtractor = (
  videoPath: string,
  atMs: number,
  destPath: string,
) => Promise<Buffer>;

export interface ClipReframeDeps {
  /** Default: `getFaceDetector()` resuelto LAZY dentro de reframeClip. */
  detector?: FaceDetector;
  /** Runner ffmpeg (mismo contrato que PF-01). Default: spawn real. */
  ffmpegRunner?: FfmpegRunner;
  /** Default: extractor ffmpeg real a jpg temp sobre `ffmpegRunner`. */
  frameExtractor?: FrameExtractor;
  /** Default: ffprobe real (`createFfprobeDimsProbe`). */
  probe?: VideoDimsProbe;
  /** Dir de frames temp. Default `os.tmpdir()`. */
  tempDir?: string;
  /** Dir del MP4 final. Default `<repo>/output` (convención `videoPath`). */
  outputDir?: string;
  /** Frames a samplear. Default `SAMPLE_COUNT`. */
  sampleCount?: number;
  now?: () => Date;
  /** Generador de ids para temporales (determinista en tests). */
  newId?: () => string;
  ffmpegPath?: string;
  ffprobePath?: string;
}

/** Probe real: ffprobe JSON con el primer stream de video + duration. */
export function createFfprobeDimsProbe(
  ffprobePath: string = findBinary('ffprobe'),
): VideoDimsProbe {
  return (filePath) =>
    new Promise((resolve, reject) => {
      execFile(
        ffprobePath,
        [
          '-v', 'error',
          '-print_format', 'json',
          '-show_entries', 'stream=codec_type,width,height:format=duration',
          filePath,
        ],
        { timeout: 15_000 },
        (error, stdout) => {
          if (error) {
            reject(
              new Error(
                `ffprobe falló sobre ${filePath}: ${error.message}`,
              ),
            );
            return;
          }
          try {
            const info = JSON.parse(stdout.toString()) as {
              streams?: Array<{
                codec_type?: string;
                width?: number;
                height?: number;
              }>;
              format?: { duration?: string };
            };
            const video = (info.streams ?? []).find(
              (s) => s.codec_type === 'video',
            );
            const width = Number(video?.width);
            const height = Number(video?.height);
            if (
              !Number.isFinite(width) ||
              !Number.isFinite(height) ||
              width <= 0 ||
              height <= 0
            ) {
              reject(
                new Error(
                  `ffprobe no devolvió dimensiones de video para ${filePath}`,
                ),
              );
              return;
            }
            const seconds = Number.parseFloat(info.format?.duration ?? '');
            resolve({
              width,
              height,
              durationMs: Number.isFinite(seconds)
                ? Math.round(seconds * 1000)
                : null,
            });
          } catch (e) {
            reject(
              new Error(
                `No se pudo parsear la salida de ffprobe para ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
        },
      );
    });
}

/**
 * `frameExtractor` default: `ffmpeg -ss <t> -i <mp4> -frames:v 1 -vcodec
 * mjpeg -y <dest.jpg>` sobre el `ffmpegRunner` inyectado (mismo runner que el
 * render final — en tests ambos quedan capturados con sus args).
 */
export function createFfmpegFrameExtractor(
  ffmpegRunner: FfmpegRunner,
): FrameExtractor {
  return async (videoPath, atMs, destPath) => {
    await ffmpegRunner([
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', msToSec(atMs),
      '-i', videoPath,
      '-frames:v', '1',
      '-vcodec', 'mjpeg',
      '-y',
      destPath,
    ]);
    return fs.readFile(destPath);
  };
}

// ─── Timeline de rostros + decisión de layout (puras, exportadas) ──────────

/**
 * Un frame sampleado. `faceCount = 0` ⇒ `centerX = null`: el sample cuenta
 * para `samples`/`facesDetected` pero no aporta centro al timeline.
 */
export interface FrameSample {
  /** Offset del frame dentro del clip (ms). */
  t: number;
  /** centerX del rostro dominante (fracción 0-1 del ancho) — null si no hubo caras. */
  centerX: number | null;
  /** Caras detectadas en el frame. */
  faceCount: number;
  /** centerX (fracción 0-1) de TODAS las caras — base del clustering split. */
  faceCenters: number[];
}

export type ReframeLayoutKind = 'single' | 'split' | 'center';

export type ReframeLayout =
  | { kind: 'single'; centerX: number }
  | { kind: 'split'; leftX: number; rightX: number }
  | { kind: 'center' };

export interface FaceCluster {
  /** Posición media del cluster (fracción 0-1 del ancho). */
  centerX: number;
  /** Frames CON cara en los que el cluster aparece. */
  frames: number;
  /** `frames / framesConCara` — estabilidad de la "persona". */
  support: number;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Clustering 1-D de TODAS las posiciones x observadas: single-linkage con
 * umbral `SPLIT_MIN_SEPARATION` — dos centros a ≤25% del ancho son la misma
 * persona (o la misma persona moviéndose). Devuelve clusters ordenados por
 * support descendente; `support` = fracción de los frames CON cara en los
 * que el cluster tiene ≥1 rostro (un cluster existe por frame, no por suma
 * de caras — una cara grande no infla el conteo).
 */
export function clusterFacePositions(samples: FrameSample[]): FaceCluster[] {
  const faceFrames = samples.filter((s) => s.faceCount > 0);
  if (faceFrames.length === 0) return [];

  const positions = faceFrames
    .flatMap((s) => s.faceCenters)
    .sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const p of positions) {
    const g = groups[groups.length - 1];
    if (g && p - g[g.length - 1] <= SPLIT_MIN_SEPARATION) {
      g.push(p);
    } else {
      groups.push([p]);
    }
  }

  return groups
    .map((members) => {
      const lo = members[0];
      const hi = members[members.length - 1];
      const frames = faceFrames.filter((s) =>
        s.faceCenters.some((x) => x >= lo && x <= hi),
      ).length;
      return {
        centerX: members.reduce((a, b) => a + b, 0) / members.length,
        frames,
        support: frames / faceFrames.length,
      };
    })
    .sort((a, b) => b.support - a.support);
}

/**
 * Decisión de layout (pura — brief):
 *   - `center`: 0 frames con cara → crop centrado estándar.
 *   - `split`: ≥2 clusters con support ≥ `SPLIT_MIN_SUPPORT` separados
 *     > `SPLIT_MIN_SEPARATION` → los dos más soportados, ordenados izq/der.
 *   - `single`: resto → centro = MEDIANA de los centerX dominantes.
 */
export function decideLayout(samples: FrameSample[]): ReframeLayout {
  const faceFrames = samples.filter((s) => s.faceCount > 0);
  if (faceFrames.length === 0) return { kind: 'center' };

  const stable = clusterFacePositions(samples).filter(
    (c) => c.support >= SPLIT_MIN_SUPPORT,
  );
  if (stable.length >= 2) {
    const [a, b] = [stable[0], stable[1]].sort(
      (p, q) => p.centerX - q.centerX,
    );
    if (b.centerX - a.centerX > SPLIT_MIN_SEPARATION) {
      return { kind: 'split', leftX: a.centerX, rightX: b.centerX };
    }
  }

  const centers = faceFrames
    .map((s) => s.centerX)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  return { kind: 'single', centerX: median(centers) };
}

// ─── Geometría de crop + args de ffmpeg (puros, exportados) ────────────────

/** Piso par: libx264/yuv420p exige dimensiones y offsets de crop pares. */
function evenFloor(v: number): number {
  const f = Math.floor(v);
  return f - (f % 2);
}

export interface CropWindow {
  w: number;
  h: number;
  x: number;
  y: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Ventana de crop de ancho `aspect*ih` (9/16 single, 9/8 split) centrada en
 * `centerX`·iw y clampeada a `[0, iw−w]`. Si el fuente ya es más angosto que
 * el objetivo (video vertical viejo), el crop ocupa todo el ancho (w=iw,
 * x=0) y `scale` estira — nunca un x negativo ni un crop fuera de rango.
 */
export function cropWindowFor(
  iw: number,
  ih: number,
  centerX: number,
  aspect: number,
): CropWindow {
  const w = Math.min(iw, evenFloor(ih * aspect));
  const x = evenFloor(clamp(centerX * iw - w / 2, 0, iw - w));
  return { w, h: ih, x, y: 0 };
}

/** Ventana centrada estándar (layout `center`). */
export function centerCropWindow(
  iw: number,
  ih: number,
  aspect: number,
): CropWindow {
  return cropWindowFor(iw, ih, 0.5, aspect);
}

/**
 * Single/center: `-vf "crop=w:h:x:0,scale=1080:1920"` + `-c:a copy`.
 * Re-encode video obligatorio (crop es filtro); audio se copia tal cual.
 */
export function buildCropArgs(input: {
  inputPath: string;
  outputPath: string;
  window: CropWindow;
}): string[] {
  const { w, h, x } = input.window;
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input.inputPath,
    '-vf', `crop=${w}:${h}:${x}:0,scale=${OUTPUT_W}:${OUTPUT_H}`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    input.outputPath,
  ];
}

/**
 * Split: `[0:v]crop…→[t];[0:v]crop…→[b];[t][b]vstack` — dos crops horizontales
 * (uno por cluster) escalados a 1080×960 y apilados → 1080×1920. La salida
 * del vstack va sin etiqueta (auto-map como video) y el audio se copia por
 * selección default + `-c:a copy`.
 */
export function buildSplitArgs(input: {
  inputPath: string;
  outputPath: string;
  top: CropWindow;
  bottom: CropWindow;
}): string[] {
  const t = input.top;
  const b = input.bottom;
  const filterComplex =
    `[0:v]crop=${t.w}:${t.h}:${t.x}:0,scale=${OUTPUT_W}:${SPLIT_HALF_H}[t];` +
    `[0:v]crop=${b.w}:${b.h}:${b.x}:0,scale=${OUTPUT_W}:${SPLIT_HALF_H}[b];` +
    `[t][b]vstack=inputs=2`;
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', input.inputPath,
    '-filter_complex', filterComplex,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y',
    input.outputPath,
  ];
}

// ─── Servicio ───────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Área del bbox `[x1,y1,x2,y2]` — rostro dominante = mayor área. */
function faceArea(f: DetectedFace): number {
  return Math.max(0, f.bbox[2] - f.bbox[0]) * Math.max(0, f.bbox[3] - f.bbox[1]);
}

function faceCenterX(f: DetectedFace, iw: number): number {
  return clamp01((f.bbox[0] + f.bbox[2]) / 2 / iw);
}

export function createClipReframeService(
  store: ReframeStore = createDrizzleReframeStore(),
  deps: ClipReframeDeps = {},
) {
  const ffmpegRunner =
    deps.ffmpegRunner ??
    createFfmpegRunner(deps.ffmpegPath ?? findBinary('ffmpeg'));
  const frameExtractor =
    deps.frameExtractor ?? createFfmpegFrameExtractor(ffmpegRunner);
  const probe =
    deps.probe ?? createFfprobeDimsProbe(deps.ffprobePath ?? findBinary('ffprobe'));
  const tempDir = deps.tempDir ?? os.tmpdir();
  const outputDir = deps.outputDir ?? path.join(PROJECT_ROOT, 'output');
  const sampleCount = deps.sampleCount ?? SAMPLE_COUNT;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  async function reframeClip(
    input: ReframeClipInput,
  ): Promise<ReframeClipResult> {
    const { tenantId, clipId } = input;

    // 1. Clip del tenant + fuente presente. Errores de validación: la fila
    //    NO se toca (igual que las validaciones de PF-01).
    const clip = await store.getClip(tenantId, clipId);
    if (!clip) {
      throw new ClipReframeError(
        'clip_not_found',
        `Clip ${clipId} no encontrado para el tenant ${tenantId}`,
      );
    }
    if (!clip.videoPath) {
      throw new ClipReframeError(
        'missing_source_video',
        `Clip ${clipId} no tiene videoPath — nada que reencuadrar`,
      );
    }
    const sourcePath = clip.videoPath;
    const baseMetadata: Record<string, unknown> = { ...(clip.metadata ?? {}) };

    // 2. Render en vuelo — de acá en adelante cualquier falla deja la fila
    //    en 'error' con la razón (auditable, como PF-01).
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
      const dims = await probe(sourcePath).catch((err: unknown) => {
        throw new ClipReframeError(
          'probe_failed',
          `No se pudieron leer las dimensiones de ${sourcePath}: ${errorMessage(err)}`,
        );
      });

      // 4. Tiempos de muestreo uniformes: centro de cada slot `(i+.5)/N`
      //    sobre la duración del clip; fallback a la duración del contenedor
      //    si `clips.duration` es 0; si tampoco, un solo frame en t=0.
      const durationMs =
        clip.duration > 0 ? clip.duration * 1000 : (dims.durationMs ?? 0);
      const n = durationMs > 0 ? Math.max(1, sampleCount) : 1;
      const times = Array.from({ length: n }, (_, i) =>
        durationMs > 0 ? (durationMs * (i + 0.5)) / n : 0,
      );

      // Detector LAZY: se resuelve recién acá (descarga modelos ONNX la
      // primera vez — nunca en import ni en construcción del servicio).
      const detector = deps.detector ?? (await getFaceDetector());

      // 5. Sampling: un frame por tiempo → detect → centro dominante +
      //    posiciones de todas las caras. Un frame que no se puede extraer
      //    cuenta como sample sin caras; un detect() que tira es infra rota
      //    (detector caído) → aborta con error tipado.
      const uid = newId();
      await fs.mkdir(tempDir, { recursive: true });
      const samples: FrameSample[] = [];
      for (const [i, t] of times.entries()) {
        const destPath = path.join(tempDir, `pf02-frame-${uid}-${i}.jpg`);
        tempPaths.push(destPath);
        let buf: Buffer;
        try {
          buf = await frameExtractor(sourcePath, t, destPath);
        } catch {
          samples.push({ t, centerX: null, faceCount: 0, faceCenters: [] });
          continue;
        }
        let faces: DetectedFace[];
        try {
          faces = (await detector.detect(buf)).faces;
        } catch (err) {
          throw new ClipReframeError(
            'detector_unavailable',
            `El detector de rostros falló: ${errorMessage(err)}`,
          );
        }
        const faceCenters = faces.map((f) => faceCenterX(f, dims.width));
        const dominant = faces.reduce<DetectedFace | undefined>(
          (best, f) => (best === undefined || faceArea(f) > faceArea(best) ? f : best),
          undefined,
        );
        samples.push({
          t,
          centerX: dominant ? faceCenterX(dominant, dims.width) : null,
          faceCount: faces.length,
          faceCenters,
        });
      }

      // 6. Layout + geometría.
      const layout = decideLayout(samples);
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${clipId}_916.mp4`);
      const iw = dims.width;
      const ih = dims.height;

      // 7. Render — UNA invocación ffmpeg (audio se copia).
      if (layout.kind === 'split') {
        await ffmpegRunner(
          buildSplitArgs({
            inputPath: sourcePath,
            outputPath,
            top: cropWindowFor(iw, ih, layout.leftX, 9 / 8),
            bottom: cropWindowFor(iw, ih, layout.rightX, 9 / 8),
          }),
        );
      } else {
        const window =
          layout.kind === 'single'
            ? cropWindowFor(iw, ih, layout.centerX, 9 / 16)
            : centerCropWindow(iw, ih, 9 / 16);
        await ffmpegRunner(
          buildCropArgs({ inputPath: sourcePath, outputPath, window }),
        );
      }

      // 8. Éxito: videoPath → archivo nuevo; el anterior queda en
      //    metadata.sourceVideoPath y la decisión en metadata.reframe.
      const facesDetected = samples.reduce((a, s) => a + s.faceCount, 0);
      const dominantMedian = (() => {
        const centers = samples
          .map((s) => s.centerX)
          .filter((x): x is number => x !== null)
          .sort((a, b) => a - b);
        return centers.length ? median(centers) : 0.5;
      })();
      const metadata: Record<string, unknown> = {
        ...baseMetadata,
        sourceVideoPath: sourcePath,
        reframe: {
          layout: layout.kind,
          samples: samples.length,
          facesDetected,
          centerX: dominantMedian,
          ...(layout.kind === 'split'
            ? { leftX: layout.leftX, rightX: layout.rightX }
            : {}),
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
        layout: layout.kind,
        samples: samples.length,
        facesDetected,
      };
    } catch (err) {
      const reason = errorMessage(err);
      await markError(reason);
      if (err instanceof ClipReframeError) throw err;
      throw new ClipReframeError(
        'ffmpeg_failed',
        `Re-encuadre del clip ${clipId} falló: ${reason}`,
      );
    } finally {
      // Frames temp SIEMPRE se limpian — haya o no error.
      await Promise.all(
        tempPaths.map((p) => fs.rm(p, { force: true }).catch(() => {})),
      );
    }
  }

  return { reframeClip };
}

export const clipReframeService = createClipReframeService();
