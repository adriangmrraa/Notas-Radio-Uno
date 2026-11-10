/**
 * clipRenderQueueService — cola persistente de jobs de render (PF-04).
 *
 * Desacopla "pedir un clip" de "renderizarlo": el productor encola
 * (`enqueue`), el `clipRenderWorker` claimea y despacha, y el resultado queda
 * auditable en la fila (status, attempts, last_error, timestamps). No es la
 * tabla de jobs recurrentes (`scheduled_jobs`/`job_executions` son de
 * programación de transmisiones) — es cola ad-hoc por render.
 *
 * Patrón store del repo: interface `ClipRenderQueueStore` +
 * `createDrizzleClipRenderQueueStore(db)` + memory store en tests/helpers.
 *
 * REGLA tenant_id: TODA query filtra por tenant_id con UNA excepción
 * documentada — `claimNext` (ver su comentario). `markDone`/`markFailed` no
 * llevan tenantId porque operan sobre el job que el worker YA claimeó
 * (posee la fila); las rutas externas — `getById`, `listByClip`, `retry`,
 * `cancel`, `listPending(tenantId)` — sí están acotadas por tenant.
 */
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { clipRenderJobs } from '../db/schema/renderJobs.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Estados del ciclo de vida del job (columna varchar — no enum de DB). */
export type ClipRenderJobStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled';

export type ClipRenderJob = typeof clipRenderJobs.$inferSelect;

export interface EnqueueRenderJobInput {
  tenantId: string;
  /**
   * Para kinds sobre un clip existente (reframe/subtitles futuros). NULL en
   * 'cut': el clip lo crea el cutter durante el render y el worker lo
   * rellena al hacer `markDone`.
   */
  clipId?: string | null;
  /** 'cut' en este slice; extensible a 'reframe'/'subtitles' (PF-02/03). */
  kind: string;
  /** Para 'cut': `{ transmissionId, startMs, endMs }`. */
  payload: Record<string, unknown>;
  /** Tope de intentos antes del `error` terminal. Default 3. */
  maxAttempts?: number;
}

export interface MarkDoneOptions {
  /** Rellena `clip_id` cuando el render produjo el clip (kind='cut'). */
  clipId?: string;
}

export interface MarkFailedOptions {
  /** `run_at` del reintento (backoff lo calcula el worker). */
  retryAt?: Date;
  /**
   * `false` = derecho a `error` terminal sin mirar attempts (kind
   * desconocido: no tiene sentido reintentar lo que nadie sabe despachar).
   */
  retry?: boolean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ClipRenderQueueStore {
  /** Encola un job: status 'pending', run_at = ahora (default de la columna). */
  enqueue(v: EnqueueRenderJobInput): Promise<ClipRenderJob>;

  /**
   * EXCEPCIÓN documentada a la regla tenant_id (única del store): la cola es
   * GLOBAL — el worker de cada proceso claimea el próximo job pendiente de
   * cualquier tenant. El tenant viaja EN la fila y todas las demás operaciones
   * sí filtran por tenant_id; el claim no puede filtrar porque el worker no
   * sabe a priori qué tenant tiene trabajo.
   *
   * Atómico sin FOR UPDATE SKIP LOCKED: UPDATE condicionado por
   * `status='pending'`. Dos workers que lean el mismo candidato disparan el
   * mismo UPDATE; Postgres serializa por fila y sólo uno ve status 'pending'
   * (el otro hace 0 filas → reintenta con la siguiente candidata).
   */
  claimNext(now: Date): Promise<ClipRenderJob | null>;

  /** `running` → `done` + finished_at; rellena clip_id si viene. */
  markDone(
    jobId: string,
    opts?: MarkDoneOptions,
  ): Promise<ClipRenderJob | null>;

  /**
   * Falla de un intento: si `attempts < max_attempts` (y `retry !== false`)
   * vuelve a `pending` con `run_at = retryAt` + `last_error`; si no, queda
   * `error` terminal + finished_at. Devuelve la fila actualizada — el status
   * resultante le dice al caller si fue terminal.
   */
  markFailed(
    jobId: string,
    error: string,
    opts?: MarkFailedOptions,
  ): Promise<ClipRenderJob | null>;

  /**
   * Reintento manual (tenant-scoped): sólo desde `error` o `cancelled`.
   * Resetea status→'pending', run_at→ahora, attempts→0, last_error→null y
   * limpia started_at/finished_at (corrida nueva). Otro estado → null (no-op).
   */
  retry(jobId: string, tenantId: string): Promise<ClipRenderJob | null>;

  /**
   * Cancelación manual (tenant-scoped): desde `pending` o `running` →
   * `cancelled` + finished_at. Un job `running` cancelado puede terminar su
   * render en curso igual — el markDone/markFailed posterior lo sobrescribe;
   * la cancelación es una marca, no mata el proceso ffmpeg en vuelo.
   */
  cancel(jobId: string, tenantId: string): Promise<ClipRenderJob | null>;

  getById(jobId: string, tenantId: string): Promise<ClipRenderJob | null>;
  /**
   * Jobs ligados a un clip, más viejos primero (tenant-scoped). Matchea por
   * DOS vías: `clip_id = clipId` (destino — reframe/subtitles y todo job
   * 'cut' terminado) OR `payload->>'recutOf' = clipId` (origen de un
   * re-corte — PF-05). Sin el OR, un job de re-corte desaparecería de la
   * lista del origen: su clip_id es NULL mientras corre y apunta al clip
   * NUEVO cuando termina; `recutOf` es el vínculo estable.
   */
  listByClip(clipId: string, tenantId: string): Promise<ClipRenderJob[]>;
  /**
   * Pendientes ordenados por run_at. Con `tenantId` filtra ese tenant; sin
   * argumento lista la cola global (vista de ops, misma excepción que el
   * claim — lectura solamente).
   */
  listPending(tenantId?: string): Promise<ClipRenderJob[]>;
}

/** Reintentos del claim si otro worker gana la carrera por la candidata. */
const MAX_CLAIM_ATTEMPTS = 3;

/** Implementación drizzle — regla tenant_id con la excepción de claimNext. */
export function createDrizzleClipRenderQueueStore(
  executor: Database = db,
): ClipRenderQueueStore {
  return {
    async enqueue(v) {
      const [row] = await executor
        .insert(clipRenderJobs)
        .values({
          tenantId: v.tenantId,
          clipId: v.clipId ?? null,
          kind: v.kind,
          payload: v.payload,
          ...(v.maxAttempts !== undefined
            ? { maxAttempts: v.maxAttempts }
            : {}),
        })
        .returning();
      return row;
    },

    // ÚNICA query sin filtro tenant_id — ver el contrato en la interface.
    async claimNext(now) {
      for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i++) {
        const [candidate] = await executor
          .select({ id: clipRenderJobs.id })
          .from(clipRenderJobs)
          .where(
            and(
              eq(clipRenderJobs.status, 'pending'),
              lte(clipRenderJobs.runAt, now),
            ),
          )
          .orderBy(asc(clipRenderJobs.runAt), asc(clipRenderJobs.createdAt))
          .limit(1);
        if (!candidate) return null;

        const [claimed] = await executor
          .update(clipRenderJobs)
          .set({
            status: 'running',
            attempts: sql`${clipRenderJobs.attempts} + 1`,
            startedAt: now,
          })
          .where(
            and(
              eq(clipRenderJobs.id, candidate.id),
              eq(clipRenderJobs.status, 'pending'),
            ),
          )
          .returning();
        if (claimed) return claimed;
        // Otro worker claimeó esta fila primero → probar con la siguiente.
      }
      return null;
    },

    async markDone(jobId, opts) {
      const [row] = await executor
        .update(clipRenderJobs)
        .set({
          status: 'done',
          finishedAt: new Date(),
          ...(opts?.clipId ? { clipId: opts.clipId } : {}),
        })
        .where(eq(clipRenderJobs.id, jobId))
        .returning();
      return row ?? null;
    },

    async markFailed(jobId, error, opts) {
      const [current] = await executor
        .select({
          attempts: clipRenderJobs.attempts,
          maxAttempts: clipRenderJobs.maxAttempts,
        })
        .from(clipRenderJobs)
        .where(eq(clipRenderJobs.id, jobId))
        .limit(1);
      if (!current) return null;

      const terminal =
        opts?.retry === false || current.attempts >= current.maxAttempts;
      const now = new Date();
      const [row] = await executor
        .update(clipRenderJobs)
        .set(
          terminal
            ? { status: 'error', lastError: error, finishedAt: now }
            : {
                status: 'pending',
                lastError: error,
                runAt: opts?.retryAt ?? now,
              },
        )
        .where(eq(clipRenderJobs.id, jobId))
        .returning();
      return row ?? null;
    },

    async retry(jobId, tenantId) {
      const [row] = await executor
        .update(clipRenderJobs)
        .set({
          status: 'pending',
          attempts: 0,
          lastError: null,
          runAt: new Date(),
          startedAt: null,
          finishedAt: null,
        })
        .where(
          and(
            eq(clipRenderJobs.id, jobId),
            eq(clipRenderJobs.tenantId, tenantId),
            inArray(clipRenderJobs.status, ['error', 'cancelled']),
          ),
        )
        .returning();
      return row ?? null;
    },

    async cancel(jobId, tenantId) {
      const [row] = await executor
        .update(clipRenderJobs)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(
          and(
            eq(clipRenderJobs.id, jobId),
            eq(clipRenderJobs.tenantId, tenantId),
            inArray(clipRenderJobs.status, ['pending', 'running']),
          ),
        )
        .returning();
      return row ?? null;
    },

    async getById(jobId, tenantId) {
      const [row] = await executor
        .select()
        .from(clipRenderJobs)
        .where(
          and(
            eq(clipRenderJobs.id, jobId),
            eq(clipRenderJobs.tenantId, tenantId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listByClip(clipId, tenantId) {
      return executor
        .select()
        .from(clipRenderJobs)
        .where(
          and(
            eq(clipRenderJobs.tenantId, tenantId),
            or(
              eq(clipRenderJobs.clipId, clipId),
              sql`${clipRenderJobs.payload} ->> 'recutOf' = ${clipId}`,
            ),
          ),
        )
        .orderBy(asc(clipRenderJobs.createdAt));
    },

    async listPending(tenantId) {
      return executor
        .select()
        .from(clipRenderJobs)
        .where(
          tenantId
            ? and(
                eq(clipRenderJobs.status, 'pending'),
                eq(clipRenderJobs.tenantId, tenantId),
              )
            : eq(clipRenderJobs.status, 'pending'),
        )
        .orderBy(asc(clipRenderJobs.runAt));
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

/**
 * Wrapper del store con el patrón de los demás servicios del repo. Hoy el
 * único consumidor es el worker (`clipRenderWorker`), pero el service queda
 * como punto de entrada para las rutas que encolen/reintenten jobs.
 */
export function createClipRenderQueueService(
  store: ClipRenderQueueStore = createDrizzleClipRenderQueueStore(),
) {
  return {
    enqueue(v: EnqueueRenderJobInput) {
      return store.enqueue(v);
    },
    getJob(jobId: string, tenantId: string) {
      return store.getById(jobId, tenantId);
    },
    listJobsByClip(clipId: string, tenantId: string) {
      return store.listByClip(clipId, tenantId);
    },
    listPending(tenantId?: string) {
      return store.listPending(tenantId);
    },
    retryJob(jobId: string, tenantId: string) {
      return store.retry(jobId, tenantId);
    },
    cancelJob(jobId: string, tenantId: string) {
      return store.cancel(jobId, tenantId);
    },
  };
}

export const clipRenderQueueService = createClipRenderQueueService();
