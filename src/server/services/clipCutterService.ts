/**
 * clipCutterService — corta una ventana del crudo REAL con ffmpeg (PF-01).
 *
 * `cutRawWindow({tenantId, transmissionId, startMs, endMs})` extrae la ventana
 * pedida del video crudo grabado por el recorder (decisión D-1: NUNCA clips
 * sintéticos) y la registra como fila en `clips`. La ventana usa la misma
 * convención que `transcript_segments`/momentos: offsets en ms relativos al
 * inicio de la transmisión. Los `recording_segments.start_ms/end_ms` ya viven
 * en esa convención — el recorder re-ancla `stream_recordings.started_at` a
 * `transmissions.started_at` y el motor de análisis los trata como el mismo
 * espacio (`segment.startMs + u.start` = offset absoluto), así que la ventana
 * se compara DIRECTAMENTE contra los offsets de segmento, sin corrimientos.
 *
 * El punto no trivial: la ventana puede cubrir VARIOS `recording_segments`.
 * `resolveWindowParts` camina la cobertura ordenada por `start_ms`/`sequence`
 * y devuelve un tramo por segmento intersectado, cada uno con `seekMs` =
 * `partStart - segment.startMs` (el `-ss` RELATIVO AL ARCHIVO). Si la ventana
 * cae entera en UN segmento hay camino rápido: un solo ffmpeg directo al
 * output. Si no, se extrae cada tramo a un MP4 temp y se concatenan con el
 * demuxer (`-f concat -safe 0 -c copy`) en UN MP4 final.
 *
 * Precisión de corte: `-ss` ANTES de `-i` + re-encode corto por tramo
 * (`-c:v libx264 -c:a aac`). Justificación: input-seek salta al keyframe
 * previo y decodifica sólo hasta el objetivo → frame-accurate y rápido; en
 * cambio `-c copy` cortaría en el borde de keyframe más cercano (impreciso).
 * Re-encodar cada tramo con parámetros uniformes ADEMÁS homogeneiza codec
 * y timebase entre archivos de distintos segmentos — requisito del concat
 * demuxer con `-c copy`. El costo queda acotado por `maxDurationMs` (120 s).
 *
 * Fila `clips`: se crea en estado `generating` ANTES de tocar ffmpeg — es el
 * estado no terminal que `rawRetentionService.hasPendingRender` reconoce
 * (contrato PD-06: `clips.metadata->>'transmissionId'` apunta al crudo que
 * protege de la purga mientras el render está en vuelo). En éxito queda
 * `pending_review` (mismo estado que fija `clipService.updateClipVideoPath`);
 * en falla de ffmpeg queda `error` con la razón en `metadata.error` — nada
 * queda a medias y el intento queda auditable. Los errores de validación
 * (ventana inválida, fuera de rango, sin cobertura) NO crean fila.
 *
 * `createClip`/`updateClipVideoPath` de `clipService.ts` NO se reusan como
 * store: `createClip` no acepta `transmissionId` (columna que este slice sí
 * escribe) y `updateClipVideoPath` no actualiza `duration` ni `metadata`.
 * Se respetan en cambio sus convenciones de estado (`generating` →
 * `pending_review`/`error`) y de `videoPath` = ruta local bajo `output/`.
 *
 * Dependencias inyectables (`deps`): `runFfmpeg` (spawn real o stub de test
 * que captura args), `storage` (`RawStorage`; `publicPath(key)` resuelve la
 * ruta local del MP4 fuente), `tempDir`/`outputDir`, `maxDurationMs` y
 * `newId`. TODA query del store filtra por `tenant_id` (regla dura). Los
 * temporales se borran SIEMPRE en `finally`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { clips } from '../db/schema/clips.js';
import { recordingSegments, streamRecordings } from '../db/schema/recordings.js';
import { transmissions } from '../db/schema/transmissions.js';
import { findBinary, PROJECT_ROOT } from '../lib/binaries.js';
import { getRawStorage, type RawStorage } from './rawStorageService.js';

// ─── API pública ────────────────────────────────────────────────────────────

export interface CutRawWindowInput {
  tenantId: string;
  transmissionId: string;
  /** Offset de inicio en ms — convención relativa al inicio de la corrida. */
  startMs: number;
  /** Offset de fin en ms (exclusivo). */
  endMs: number;
  /** Rótulo opcional; default derivado de la ventana. */
  title?: string;
  /** Texto gancho (columna NOT NULL — default `''`). */
  hookText?: string;
  /** Tope de duración de la ventana en ms. Default `DEFAULT_MAX_WINDOW_MS`. */
  maxDurationMs?: number;
}

export interface CutRawWindowResult {
  clipId: string;
  /** Ruta local del MP4 — convención `output/` (se sirve como `/output/…`). */
  videoPath: string;
  /** Duración en segundos (la columna `clips.duration` es entera en s). */
  durationSec: number;
  /** Cuántos `recording_segments` aportaron video al clip. */
  segmentsUsed: number;
}

// ─── Errores tipados ────────────────────────────────────────────────────────

export type ClipCutterErrorReason =
  | 'transmission_not_found' // la corrida no existe para ESTE tenant
  | 'invalid_window' // endMs <= startMs, negativos o no finitos
  | 'duration_exceeded' // la ventana supera maxDurationMs
  | 'no_recording' // la corrida no tiene grabación con segmentos activos
  | 'window_out_of_range' // ningún tramo/hueco: la ventana no está cubierta
  | 'ffmpeg_failed'; // la extracción/concat falló (fila queda 'error')

export class ClipCutterError extends Error {
  readonly reason: ClipCutterErrorReason;

  constructor(reason: ClipCutterErrorReason, message: string) {
    super(message);
    this.name = 'ClipCutterError';
    this.reason = reason;
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

export interface CutterTransmission {
  id: string;
  tenantId: string;
  programId: string | null;
  status: string;
  /** Ancla de la convención de offsets (puede ser null en corridas viejas). */
  startedAt: Date | null;
}

export interface CutterSegment {
  id: string;
  recordingId: string;
  sequence: number;
  /** Offset de inicio del segmento (misma convención que la ventana). */
  startMs: number;
  /** null = el segmento SIGUE grabando: cobertura abierta (ver header). */
  endMs: number | null;
  /** Relativo a `stream_recordings.storage_prefix` — no es la key completa. */
  fileRef: string;
}

export interface CutterRecording {
  id: string;
  tenantId: string;
  transmissionId: string;
  storagePrefix: string;
  status: string;
  /** Segmentos 'active' ordenados por startMs/sequence (lo arma el store). */
  segments: CutterSegment[];
}

export interface ClipRowInsert {
  tenantId: string;
  transmissionId: string;
  programId: string | null;
  title: string;
  hookText: string;
  duration: number;
  status: string;
  metadata: Record<string, unknown>;
}

export interface ClipResultPatch {
  videoPath?: string | null;
  duration?: number;
  status: string;
  /** Reemplazo COMPLETO de metadata (no merge — el servicio manda todo). */
  metadata?: Record<string, unknown>;
}

export interface ClipCutterStore {
  getTransmission(
    tenantId: string,
    transmissionId: string,
  ): Promise<CutterTransmission | null>;
  /** Grabaciones de la corrida con sus segmentos 'active' ordenados. */
  listRecordingsWithSegments(
    tenantId: string,
    transmissionId: string,
  ): Promise<CutterRecording[]>;
  createClipRow(v: ClipRowInsert): Promise<{ id: string }>;
  setClipResult(
    tenantId: string,
    clipId: string,
    patch: ClipResultPatch,
  ): Promise<void>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleClipCutterStore(
  executor: Database = db,
): ClipCutterStore {
  return {
    async getTransmission(tenantId, transmissionId) {
      const [row] = await executor
        .select({
          id: transmissions.id,
          tenantId: transmissions.tenantId,
          programId: transmissions.programId,
          status: transmissions.status,
          startedAt: transmissions.startedAt,
        })
        .from(transmissions)
        .where(
          and(
            eq(transmissions.id, transmissionId),
            eq(transmissions.tenantId, tenantId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listRecordingsWithSegments(tenantId, transmissionId) {
      const recs = await executor
        .select({
          id: streamRecordings.id,
          tenantId: streamRecordings.tenantId,
          transmissionId: streamRecordings.transmissionId,
          storagePrefix: streamRecordings.storagePrefix,
          status: streamRecordings.status,
        })
        .from(streamRecordings)
        .where(
          and(
            eq(streamRecordings.transmissionId, transmissionId),
            eq(streamRecordings.tenantId, tenantId),
          ),
        )
        .orderBy(asc(streamRecordings.startedAt));
      if (recs.length === 0) return [];

      // Sólo 'active': un segmento 'purged' no tiene archivo detrás.
      const segRows = await executor
        .select({
          id: recordingSegments.id,
          recordingId: recordingSegments.recordingId,
          sequence: recordingSegments.sequence,
          startMs: recordingSegments.startMs,
          endMs: recordingSegments.endMs,
          fileRef: recordingSegments.fileRef,
        })
        .from(recordingSegments)
        .where(
          and(
            eq(recordingSegments.tenantId, tenantId),
            inArray(
              recordingSegments.recordingId,
              recs.map((r) => r.id),
            ),
            eq(recordingSegments.status, 'active'),
          ),
        )
        .orderBy(asc(recordingSegments.startMs), asc(recordingSegments.sequence));

      return recs.map((rec) => ({
        ...rec,
        segments: segRows.filter((s) => s.recordingId === rec.id),
      }));
    },

    async createClipRow(v) {
      const [row] = await executor
        .insert(clips)
        .values({
          tenantId: v.tenantId,
          transmissionId: v.transmissionId,
          programId: v.programId,
          title: v.title,
          hookText: v.hookText,
          duration: v.duration,
          status: v.status,
          metadata: v.metadata,
        })
        .returning({ id: clips.id });
      return row;
    },

    async setClipResult(tenantId, clipId, patch) {
      await executor
        .update(clips)
        .set({
          ...(patch.videoPath !== undefined ? { videoPath: patch.videoPath } : {}),
          ...(patch.duration !== undefined ? { duration: patch.duration } : {}),
          status: patch.status,
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        })
        .where(and(eq(clips.id, clipId), eq(clips.tenantId, tenantId)));
    },
  };
}

// ─── Dependencias inyectables ───────────────────────────────────────────────

/** Corre ffmpeg hasta exit 0; rechaza con el tail de stderr si no. */
export type FfmpegRunner = (args: string[]) => Promise<void>;

export interface ClipCutterDeps {
  runFfmpeg?: FfmpegRunner;
  storage?: RawStorage;
  ffmpegPath?: string;
  /** Dir de temporales (tramos + concat list). Default `os.tmpdir()`. */
  tempDir?: string;
  /** Dir del MP4 final. Default `<repo>/output` (convención de `videoPath`). */
  outputDir?: string;
  /** Tope de duración de la ventana. Default `DEFAULT_MAX_WINDOW_MS`. */
  maxDurationMs?: number;
  /** Generador de ids para temporales (determinista en tests). */
  newId?: () => string;
}

/** Tope default de la ventana: ~2 min (brief PF-01, configurable). */
export const DEFAULT_MAX_WINDOW_MS = 120_000;

/** ffmpeg real: spawn + captura de stderr; exit ≠ 0 → reject con el tail. */
export function createFfmpegRunner(ffmpegPath = findBinary('ffmpeg')): FfmpegRunner {
  return (args) =>
    new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegPath, args);
      let stderr = '';
      proc.stderr?.on('data', (d: Buffer | string) => {
        stderr += d.toString();
      });
      proc.on('error', (err: Error) => {
        reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`));
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `ffmpeg salió con código ${code ?? 'null'}: ${stderr.slice(-300)}`,
            ),
          );
        }
      });
    });
}

// ─── Resolución de tramos (pura, exportada para tests) ─────────────────────

/** Un segmento ya aplanado con el prefijo de su grabación. */
export interface TimelineSegment {
  recordingId: string;
  storagePrefix: string;
  sequence: number;
  startMs: number;
  endMs: number | null;
  fileRef: string;
}

export interface SourcePart {
  recordingId: string;
  storagePrefix: string;
  sequence: number;
  fileRef: string;
  /** `-ss` RELATIVO AL ARCHIVO: offset del tramo dentro de este segmento. */
  seekMs: number;
  /** `-t`: duración del tramo a extraer de este segmento. */
  durationMs: number;
}

export interface WindowResolution {
  parts: SourcePart[];
  /**
   * Hasta dónde quedó cubierta la ventana de forma CONTIGUA desde startMs.
   * Si es < endMs la ventana NO está cubierta (arranca fuera de rango o hay
   * un hueco de grabación en el medio — el video literal no existe ahí).
   */
  coveredEndMs: number;
}

/**
 * Camina la cobertura ordenada por startMs/sequence y devuelve un tramo por
 * segmento intersectado. Un `endMs` null (segmento aún grabando) cuenta como
 * cobertura abierta: ffmpeg corta en el EOF real si el archivo aún no llegó.
 * Tramos solapados se deduplican por `cursor` (el primero en orden gana);
 * un hueco (`segment.startMs > cursor`) corta la cobertura contigua.
 */
export function resolveWindowParts(
  segments: TimelineSegment[],
  startMs: number,
  endMs: number,
): WindowResolution {
  const sorted = [...segments].sort(
    (a, b) => a.startMs - b.startMs || a.sequence - b.sequence,
  );
  const parts: SourcePart[] = [];
  let cursor = startMs;

  for (const seg of sorted) {
    if (cursor >= endMs) break;
    if (seg.startMs > cursor) break; // hueco antes del cursor: cobertura cortada
    const segEnd = seg.endMs ?? Number.POSITIVE_INFINITY;
    const partStart = Math.max(seg.startMs, cursor, startMs);
    const partEnd = Math.min(segEnd, endMs);
    if (partEnd <= partStart) continue; // no intersecta / ya cubierto
    parts.push({
      recordingId: seg.recordingId,
      storagePrefix: seg.storagePrefix,
      sequence: seg.sequence,
      fileRef: seg.fileRef,
      seekMs: partStart - seg.startMs,
      durationMs: partEnd - partStart,
    });
    cursor = partEnd;
  }

  return { parts, coveredEndMs: cursor };
}

// ─── Args de ffmpeg (puros, exportados para tests) ──────────────────────────

/** ms → segundos con 3 decimales (`12.345`) — precisión suficiente para -ss/-t. */
export function msToSec(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Tramo individual: `-ss` input-seek (rápido) + re-encode corto uniforme
 * (frame-accurate; ver justificación en el header). `-movflags +faststart`
 * adelanta el moov — el clip se sirve por HTTP directo.
 */
export function buildPartArgs(input: {
  inputPath: string;
  outputPath: string;
  seekMs: number;
  durationMs: number;
}): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', msToSec(input.seekMs),
    '-i', input.inputPath,
    '-t', msToSec(input.durationMs),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-y',
    input.outputPath,
  ];
}

/** Concat demuxer sobre tramos ya re-encodados uniformes → `-c copy` seguro. */
export function buildConcatArgs(input: {
  listPath: string;
  outputPath: string;
}): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'concat',
    '-safe', '0',
    '-i', input.listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y',
    input.outputPath,
  ];
}

/**
 * Entrada `file '…'` del concat demuxer: normaliza separadores a `/`
 * (el demuxer trata `\` como escape — en Windows rompería la línea) y
 * escapa comillas simples.
 */
export function concatListEntry(filePath: string): string {
  const normalized = filePath.split(path.sep).join('/');
  return `file '${normalized.replace(/'/g, `'\\''`)}'`;
}

// ─── Servicio ───────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createClipCutterService(
  store: ClipCutterStore = createDrizzleClipCutterStore(),
  deps: ClipCutterDeps = {},
) {
  const storage = deps.storage ?? getRawStorage();
  const runFfmpeg =
    deps.runFfmpeg ?? createFfmpegRunner(deps.ffmpegPath ?? findBinary('ffmpeg'));
  const tempDir = deps.tempDir ?? os.tmpdir();
  const outputDir = deps.outputDir ?? path.join(PROJECT_ROOT, 'output');
  const newId = deps.newId ?? randomUUID;

  async function cutRawWindow(
    input: CutRawWindowInput,
  ): Promise<CutRawWindowResult> {
    const { tenantId, transmissionId, startMs, endMs } = input;

    // 1. Validación sintáctica de la ventana (sin tocar nada todavía).
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs <= startMs
    ) {
      throw new ClipCutterError(
        'invalid_window',
        `Ventana inválida [${startMs}, ${endMs}): se requiere 0 <= startMs < endMs`,
      );
    }
    const maxDurationMs =
      input.maxDurationMs ?? deps.maxDurationMs ?? DEFAULT_MAX_WINDOW_MS;
    if (endMs - startMs > maxDurationMs) {
      throw new ClipCutterError(
        'duration_exceeded',
        `La ventana de ${endMs - startMs} ms supera el máximo de ${maxDurationMs} ms`,
      );
    }

    // 2. La corrida existe para ESTE tenant.
    const tx = await store.getTransmission(tenantId, transmissionId);
    if (!tx) {
      throw new ClipCutterError(
        'transmission_not_found',
        `Transmisión ${transmissionId} no encontrada para el tenant ${tenantId}`,
      );
    }

    // 3. Crudo real: grabaciones + segmentos activos de la corrida.
    const recordings = await store.listRecordingsWithSegments(
      tenantId,
      transmissionId,
    );
    const timeline: TimelineSegment[] = recordings.flatMap((r) =>
      r.segments.map((s) => ({
        recordingId: r.id,
        storagePrefix: r.storagePrefix,
        sequence: s.sequence,
        startMs: s.startMs,
        endMs: s.endMs,
        fileRef: s.fileRef,
      })),
    );
    if (timeline.length === 0) {
      throw new ClipCutterError(
        'no_recording',
        `La transmisión ${transmissionId} no tiene grabación con segmentos activos`,
      );
    }

    // 4. Cobertura: la ventana tiene que estar CONTENIDA y sin huecos.
    const { parts, coveredEndMs } = resolveWindowParts(timeline, startMs, endMs);
    if (parts.length === 0 || coveredEndMs < endMs) {
      throw new ClipCutterError(
        'window_out_of_range',
        `La ventana [${startMs}, ${endMs}) no está cubierta por el crudo ` +
          `(cobertura contigua hasta ${coveredEndMs} ms)`,
      );
    }

    const durationSec = Math.round((endMs - startMs) / 1000);
    const strategy = parts.length === 1 ? 'single' : 'concat';
    const metadata: Record<string, unknown> = {
      // Contrato PD-06: el render en vuelo se reconoce por metadata.transmissionId.
      transmissionId,
      window: { startMs, endMs },
      sourceSegments: parts.map((p) => `${p.storagePrefix}/${p.fileRef}`),
      parts: parts.map((p) => ({
        fileRef: p.fileRef,
        sequence: p.sequence,
        seekMs: p.seekMs,
        durationMs: p.durationMs,
      })),
      strategy,
    };

    // 5. Fila 'generating' ANTES del render (protege el crudo de la purga).
    const clip = await store.createClipRow({
      tenantId,
      transmissionId,
      programId: tx.programId,
      title:
        input.title ??
        `Clip ${Math.round(startMs / 1000)}s-${Math.round(endMs / 1000)}s`,
      hookText: input.hookText ?? '',
      duration: durationSec,
      status: 'generating',
      metadata,
    });

    // 6. Extracción. Camino rápido: la ventana entera cae en UN segmento →
    //    un solo ffmpeg directo al output. Si no: un MP4 temp por tramo +
    //    concat demuxer → MP4 único.
    const outputPath = path.join(outputDir, `clip_${clip.id}.mp4`);
    const tempPaths: string[] = [];
    const inputPath = (p: SourcePart) =>
      storage.publicPath(`${p.storagePrefix}/${p.fileRef}`);

    try {
      await fs.mkdir(outputDir, { recursive: true });
      if (parts.length === 1) {
        const p = parts[0];
        await runFfmpeg(
          buildPartArgs({
            inputPath: inputPath(p),
            outputPath,
            seekMs: p.seekMs,
            durationMs: p.durationMs,
          }),
        );
      } else {
        await fs.mkdir(tempDir, { recursive: true });
        const uid = newId();
        const partPaths: string[] = [];
        for (const [i, p] of parts.entries()) {
          const partPath = path.join(tempDir, `pf01-part-${uid}-${i}.mp4`);
          tempPaths.push(partPath);
          partPaths.push(partPath);
          await runFfmpeg(
            buildPartArgs({
              inputPath: inputPath(p),
              outputPath: partPath,
              seekMs: p.seekMs,
              durationMs: p.durationMs,
            }),
          );
        }
        const listPath = path.join(tempDir, `pf01-concat-${uid}.txt`);
        tempPaths.push(listPath);
        await fs.writeFile(
          listPath,
          `ffconcat version 1.0\n${partPaths.map(concatListEntry).join('\n')}\n`,
        );
        await runFfmpeg(buildConcatArgs({ listPath, outputPath }));
      }
    } catch (err) {
      // Nada queda a medias: la fila queda 'error' con la razón y el throw
      // es tipado. Si marcar el error falla, no se enmascara el original.
      const reason = errorMessage(err);
      await store
        .setClipResult(tenantId, clip.id, {
          status: 'error',
          metadata: { ...metadata, error: reason },
        })
        .catch(() => {});
      throw new ClipCutterError(
        'ffmpeg_failed',
        `ffmpeg falló cortando la ventana [${startMs}, ${endMs}): ${reason}`,
      );
    } finally {
      // Temporales SIEMPRE se limpian — haya o no error.
      await Promise.all(
        tempPaths.map((p) => fs.rm(p, { force: true }).catch(() => {})),
      );
    }

    // 7. Éxito: videoPath + duración + 'pending_review' (convención clips).
    await store.setClipResult(tenantId, clip.id, {
      videoPath: outputPath,
      duration: durationSec,
      status: 'pending_review',
    });

    return {
      clipId: clip.id,
      videoPath: outputPath,
      durationSec,
      segmentsUsed: parts.length,
    };
  }

  return { cutRawWindow };
}

export const clipCutterService = createClipCutterService();
