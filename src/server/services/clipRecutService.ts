/**
 * clipRecutService — re-corte MANUAL de un clip existente (PF-05).
 *
 * `recutClip({tenantId, clipId, startMs, endMs})` encola un job `kind='cut'`
 * en `clip_render_jobs` que produce un clip DERIVADO nuevo sobre el crudo de
 * la misma transmisión: el original NO se destruye mientras se regenera — el
 * worker lo reusa tal cual (`cutRawWindow` de PF-01, que escribe el nuevo
 * clip con `metadata.window` y rellena `job.clip_id` al terminar). El clip
 * origen queda linkeado al job vía `metadata.recutJobId` (merge jsonb
 * atómico) y el job lleva `payload.recutOf = clipId`, que es lo que permite
 * a `listByClip` seguir mostrándolo desde el origen aunque su `clip_id`
 * termine apuntando al clip nuevo.
 *
 * La diferencia con encolar un 'cut' a mano: el re-corte VALIDA ANTES de
 * encolar (feedback inmediato al usuario — si la ventana no existe en el
 * crudo, el job ni siquiera se crea). La cobertura se re-implementa liviana
 * (`listCoverage` + `isWindowCovered`, misma regla de unión contigua que
 * `resolveWindowParts` del cutter, que es NO TOCAR) en vez de llamar al
 * cutter — el cutter también crearía la fila y correría ffmpeg, y acá sólo
 * queremos el chequeo.
 *
 * Convención de la ventana: offsets en ms relativos al inicio de la
 * transmisión — la MISMA que `recording_segments.start_ms/end_ms` y que los
 * momentos/marks de la sala. Un `endMs` null en cobertura = segmento aún
 * grabando: cuenta como cubierto hasta `now().getTime()` (dep inyectable).
 * En producción `new Date().getTime()` (epoch) es ≫ cualquier offset real,
 * así que un segmento abierto cubre de facto igual que el +Inf del cutter —
 * si el usuario pide más allá del EOF real, ffmpeg corta en el fin de
 * archivo (mismo comportamiento que PF-01). En tests, un `now` chico hace
 * el límite determinista.
 *
 * Guarda anti-duplicado (`clip_rendering`): si ya hay un job 'cut'
 * pending/running ligado al clip (su `payload.recutOf` lo ata al origen —
 * `listByClip` lo matchea), se rechaza. Barato: una query tenant-scoped.
 *
 * Errores tipados `ClipRecutError.reason`; el mapeo a HTTP lo hacen las
 * rutas (`routes/clips.ts`).
 *
 * Patrón store del repo: interface `RecutStore` +
 * `createDrizzleRecutStore(db)` + memory store en tests/helpers. TODA query
 * filtra por `tenant_id` (regla dura).
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { clips } from '../db/schema/clips.js';
import { recordingSegments, streamRecordings } from '../db/schema/recordings.js';
// NO TOCAR: sólo se REUSA la constante exportada (mismo tope que PF-01).
import { DEFAULT_MAX_WINDOW_MS } from './clipCutterService.js';
import {
  clipRenderQueueService,
  type ClipRenderJob,
  type EnqueueRenderJobInput,
} from './clipRenderQueueService.js';

// ─── API pública ────────────────────────────────────────────────────────────

export interface RecutClipInput {
  tenantId: string;
  /** Clip ORIGEN del re-corte (tenant-scoped). */
  clipId: string;
  /** Nuevo inicio en ms — convención offset de la transmisión. */
  startMs: number;
  /** Nuevo fin en ms (exclusivo). */
  endMs: number;
}

export interface RecutClipResult {
  /** Job 'cut' encolado — su `clip_id` queda NULL hasta que el render cree
   *  el clip derivado (lo rellena el worker vía `markDone`). */
  job: ClipRenderJob;
}

// ─── Errores tipados ────────────────────────────────────────────────────────

export type ClipRecutErrorReason =
  | 'clip_not_found' // el clip no existe para ESTE tenant (→ 404)
  | 'no_transmission' // el clip perdió su transmisión origen (→ 422)
  | 'invalid_window' // endMs <= startMs, no finitos, > maxWindowMs (→ 422)
  | 'window_out_of_coverage' // la ventana no está cubierta por el crudo (→ 409)
  | 'clip_rendering'; // ya hay un 'cut' en vuelo para este clip (→ 409)

export class ClipRecutError extends Error {
  readonly reason: ClipRecutErrorReason;

  constructor(reason: ClipRecutErrorReason, message: string) {
    super(message);
    this.name = 'ClipRecutError';
    this.reason = reason;
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

/** Lo único del clip origen que el re-corte necesita. */
export interface RecutClipRow {
  id: string;
  /** NULL si la transmisión se borró (FK onDelete set null) → no_transmission. */
  transmissionId: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
}

/** Tramo de crudo grabado — misma convención de offsets que la ventana. */
export interface CoverageSegment {
  startMs: number;
  /** null = el segmento SIGUE grabando: cobertura abierta hasta `now`. */
  endMs: number | null;
}

export interface RecutStore {
  /** Clip por id acotado al tenant — null si no existe o es ajeno. */
  getClip(clipId: string, tenantId: string): Promise<RecutClipRow | null>;
  /**
   * Cobertura del crudo de la transmisión: `recording_segments` 'active'
   * (un 'purged' no tiene archivo detrás) joineados a `stream_recordings`
   * por (transmissionId, tenantId), ordenados por start_ms/sequence —
   * la MISMA fuente que usa el cutter para `resolveWindowParts`.
   */
  listCoverage(
    tenantId: string,
    transmissionId: string,
  ): Promise<CoverageSegment[]>;
  /**
   * Merge jsonb sobre `clips.metadata` acotado al tenant (el patch pisa
   * claves top-level, el resto queda — semántica del `||` de Postgres).
   */
  patchClipMetadata(
    clipId: string,
    tenantId: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleRecutStore(
  executor: Database = db,
): RecutStore {
  return {
    async getClip(clipId, tenantId) {
      const [row] = await executor
        .select({
          id: clips.id,
          transmissionId: clips.transmissionId,
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

    async listCoverage(tenantId, transmissionId) {
      return executor
        .select({
          startMs: recordingSegments.startMs,
          endMs: recordingSegments.endMs,
        })
        .from(recordingSegments)
        .innerJoin(
          streamRecordings,
          eq(recordingSegments.recordingId, streamRecordings.id),
        )
        .where(
          and(
            eq(streamRecordings.transmissionId, transmissionId),
            eq(streamRecordings.tenantId, tenantId),
            eq(recordingSegments.tenantId, tenantId),
            eq(recordingSegments.status, 'active'),
          ),
        )
        .orderBy(
          asc(recordingSegments.startMs),
          asc(recordingSegments.sequence),
        );
    },

    async patchClipMetadata(clipId, tenantId, metadata) {
      // Merge atómico server-side (`||` de jsonb) — mismo patrón que
      // databaseService; evita el read-modify-write de la fila.
      await executor
        .update(clips)
        .set({
          metadata: sql`COALESCE(${clips.metadata}, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb`,
        })
        .where(and(eq(clips.id, clipId), eq(clips.tenantId, tenantId)));
    },
  };
}

// ─── Cobertura (pura, exportada para tests) ─────────────────────────────────

/**
 * ¿[startMs, endMs) está contenida en la unión CONTIGUA de `coverage`?
 * Misma regla que `resolveWindowParts` del cutter (versión booleana, sin
 * armar los tramos): un cursor avanza por los segmentos ordenados; un hueco
 * (`segment.startMs > cursor`) corta la cobertura. `endMs` null (segmento
 * aún grabando) se acota a `nowMs` — el crudo no llega más allá del ahora.
 */
export function isWindowCovered(
  coverage: CoverageSegment[],
  startMs: number,
  endMs: number,
  nowMs: number,
): boolean {
  const sorted = [...coverage].sort((a, b) => a.startMs - b.startMs);
  let cursor = startMs;

  for (const seg of sorted) {
    if (cursor >= endMs) return true;
    if (seg.startMs > cursor) return false; // hueco: cobertura cortada
    const segEnd = seg.endMs ?? nowMs;
    const partEnd = Math.min(segEnd, endMs);
    if (partEnd <= cursor) continue; // no intersecta / ya cubierto
    cursor = partEnd;
  }

  return cursor >= endMs;
}

// ─── Dependencias inyectables ───────────────────────────────────────────────

export interface ClipRecutDeps {
  /** Default: `clipRenderQueueService.enqueue` real. */
  enqueue?: (v: EnqueueRenderJobInput) => Promise<ClipRenderJob>;
  /**
   * Para la guarda anti-duplicado. Default:
   * `clipRenderQueueService.listJobsByClip` real — con el matcheo extendido
   * por `payload.recutOf` encuentra también los recuts en vuelo (clip_id
   * NULL mientras el clip derivado no existe).
   */
  listJobsByClip?: (
    clipId: string,
    tenantId: string,
  ) => Promise<ClipRenderJob[]>;
  /** Reloj para acotar segmentos abiertos. Default `new Date()`. */
  now?: () => Date;
  /** Tope de duración de la ventana. Default `DEFAULT_MAX_WINDOW_MS` del cutter. */
  maxWindowMs?: number;
}

// ─── Servicio ───────────────────────────────────────────────────────────────

export function createClipRecutService(
  store: RecutStore = createDrizzleRecutStore(),
  deps: ClipRecutDeps = {},
) {
  const enqueue =
    deps.enqueue ?? ((v: EnqueueRenderJobInput) => clipRenderQueueService.enqueue(v));
  const listJobsByClip =
    deps.listJobsByClip ??
    ((clipId: string, tenantId: string) =>
      clipRenderQueueService.listJobsByClip(clipId, tenantId));
  const now = deps.now ?? (() => new Date());
  const maxWindowMs = deps.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;

  async function recutClip(input: RecutClipInput): Promise<RecutClipResult> {
    const { tenantId, clipId, startMs, endMs } = input;

    // 1. Clip tenant-scoped + su transmisión origen (sin ella no hay crudo).
    const clip = await store.getClip(clipId, tenantId);
    if (!clip) {
      throw new ClipRecutError(
        'clip_not_found',
        `Clip ${clipId} no encontrado para el tenant ${tenantId}`,
      );
    }
    if (!clip.transmissionId) {
      throw new ClipRecutError(
        'no_transmission',
        `El clip ${clipId} no tiene transmisión origen — no hay crudo que re-cortar`,
      );
    }

    // 2. Validación sintáctica de la ventana (mismas reglas del cutter:
    //    finitos, startMs >= 0, endMs > startMs, duración <= maxWindowMs —
    //    acá todo se pliega en `invalid_window`, no hay duration_exceeded).
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs <= startMs
    ) {
      throw new ClipRecutError(
        'invalid_window',
        `Ventana inválida [${startMs}, ${endMs}): se requiere 0 <= startMs < endMs`,
      );
    }
    if (endMs - startMs > maxWindowMs) {
      throw new ClipRecutError(
        'invalid_window',
        `La ventana de ${endMs - startMs} ms supera el máximo de ${maxWindowMs} ms`,
      );
    }

    // 3. Cobertura del crudo REAL: la ventana tiene que estar contenida y
    //    sin huecos en la unión de segmentos activos (feedback inmediato —
    //    sin este chequeo el job moriría en el worker minutos después).
    const coverage = await store.listCoverage(tenantId, clip.transmissionId);
    if (!isWindowCovered(coverage, startMs, endMs, now().getTime())) {
      throw new ClipRecutError(
        'window_out_of_coverage',
        `La ventana [${startMs}, ${endMs}) no está cubierta por el crudo ` +
          `de la transmisión ${clip.transmissionId}`,
      );
    }

    // 4. Anti-duplicado: un job 'cut' pending/running ligado al clip (vía
    //    payload.recutOf — ver listByClip) ⇒ re-corte ya en vuelo.
    const jobs = await listJobsByClip(clipId, tenantId);
    const inFlight = jobs.some(
      (j) =>
        j.kind === 'cut' &&
        (j.status === 'pending' || j.status === 'running'),
    );
    if (inFlight) {
      throw new ClipRecutError(
        'clip_rendering',
        `El clip ${clipId} ya tiene un re-corte en curso`,
      );
    }

    // 5. Encolar el 'cut'. payload.recutOf ata el job al clip ORIGEN (su
    //    clip_id queda NULL hasta que el render produzca el derivado — el
    //    worker lo rellena vía markDone con el clip NUEVO).
    const job = await enqueue({
      tenantId,
      kind: 'cut',
      payload: {
        transmissionId: clip.transmissionId,
        startMs,
        endMs,
        recutOf: clipId,
      },
    });

    // 6. El origen queda linkeado al job (merge jsonb — el resto de la
    //    metadata no se toca).
    await store.patchClipMetadata(clipId, tenantId, { recutJobId: job.id });

    return { job };
  }

  return { recutClip };
}

export const clipRecutService = createClipRecutService();
