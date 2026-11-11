/**
 * jobQueueService — cola de trabajo GENÉRICA persistente (PI-01, Épica I).
 *
 * A diferencia de las colas de dominio (`clip_render_jobs`, `publish_jobs`),
 * esta cola es transversal: cualquier proceso encola trabajo diferible con
 * reintentos exponenciales y dead-letter sin crear una tabla por dominio.
 * La dead-letter es un ESTADO terminal en la misma fila (`status='dead'` +
 * `dead_lettered_at`), no una cola separada — MVP Postgres (decisión D-6).
 *
 * Patrón store del repo: interface `JobQueueStore` +
 * `createDrizzleJobQueueStore(db)` + memory store en tests/helpers. El
 * service (`createJobQueueService`) es un wrapper fino; el worker y las
 * rutas consumen el store a través de él.
 *
 * REGLA tenant_id — SIN EXCEPCIONES en el acceso tenant: TODA query filtra
 * por `tenant_id`, INCLUIDO el claim (`claimNext(tenantId, now)` — a
 * diferencia del claim global de clip_render_jobs). Un `job_id` de otro
 * tenant ⇒ `null`, nunca el dato ajeno.
 *
 * Únicas operaciones cross-tenant (excepciones documentadas para el panel
 * admin de plataforma — mismo criterio que `listPending()` global de
 * clipRenderQueueService y `adminService.ts`):
 *   - `listAll` — listado con filtros, tenantId opcional.
 *   - `getByIdGlobal` — lookup por id sin tenant (el admin luego usa el
 *     tenantId de la fila para operar tenant-scoped).
 *   - `countByStatus` sin tenantId — conteos globales.
 * Son de LECTURA salvo que el retry admin reutiliza `retry(jobId, tenantId)`
 * con el tenantId ya resuelto — ninguna mutación bypasea tenant_id.
 *
 * Backoff: `backoffMs(attempt)` exponencial determinista — 60 s × 2^(n-1)
 * con tope de 1 h (60 s, 2 min, 4 min, 8 min, …). Función pura exportada:
 * el worker lo inyecta para `retryAt` y los tests lo verifican sin timers.
 */
import { and, asc, desc, eq, inArray, lte, sql, count } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { jobQueue } from '../db/schema/jobQueue.js';

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

/** Estados del ciclo de vida (columna varchar — no enum de DB). */
export const JOB_QUEUE_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
] as const;

export type JobQueueStatus = (typeof JOB_QUEUE_STATUSES)[number];

/**
 * Kinds conocidos de la cola. 'retention.purge' es el seed de PI-01 (purga
 * de crudos vencidos vía rawRetentionService). Extensible: agregar un kind
 * nuevo es sumarlo acá + registrar su handler en el worker — sin migración.
 */
export const JOB_QUEUE_KINDS = ['retention.purge'] as const;

export type JobQueueKind = (typeof JOB_QUEUE_KINDS)[number];

export function isJobQueueStatus(v: string): v is JobQueueStatus {
  return (JOB_QUEUE_STATUSES as readonly string[]).includes(v);
}

export function isJobQueueKind(v: string): v is JobQueueKind {
  return (JOB_QUEUE_KINDS as readonly string[]).includes(v);
}

export type JobQueueJob = typeof jobQueue.$inferSelect;

/** Record completo por estado (estados sin jobs cuentan 0). */
export type JobQueueStatusCounts = Record<JobQueueStatus, number>;

export interface EnqueueJobInput {
  tenantId: string;
  /** Debe ser uno de `JOB_QUEUE_KINDS` — la API valida antes de llegar acá. */
  kind: string;
  payload?: Record<string, unknown>;
  /** Tope de intentos antes de `dead`. Default de columna: 5. */
  maxAttempts?: number;
}

export interface ListJobsFilter {
  status?: JobQueueStatus;
  kind?: string;
  limit: number;
  offset: number;
}

/** Filtros del listado admin — `tenantId` opcional (cross-tenant). */
export interface ListAllJobsFilter extends ListJobsFilter {
  tenantId?: string;
}

export interface ListJobsResult {
  jobs: JobQueueJob[];
  total: number;
}

export interface MarkFailedOptions {
  /** Categoría corta del error (varchar(32)) para agrupar en el panel. */
  category?: string;
  /** `run_at` del reintento — el worker lo calcula con `backoffMs`. */
  retryAt?: Date;
  /**
   * `false` = directo a `failed` terminal sin mirar attempts (kind
   * desconocido: no tiene sentido reintentar lo que nadie sabe despachar).
   */
  retry?: boolean;
}

export interface JobQueueStore {
  /** Encola: status 'pending', attempts 0, run_at = ahora (default columna). */
  enqueue(v: EnqueueJobInput): Promise<JobQueueJob>;

  /**
   * Claim ATÓMICO y TENANT-SCOPED: `WHERE tenant_id AND status='pending'
   * AND run_at <= now`, la candidata más vieja primero. Sin
   * FOR UPDATE SKIP LOCKED (patrón de clipRenderQueueService): select de la
   * candidata + `UPDATE ... WHERE id AND status='pending' AND tenant_id` —
   * si otro worker ganó la carrera el UPDATE hace 0 filas y se prueba la
   * siguiente (máx `MAX_CLAIM_ATTEMPTS`). `running` + attempts+1 + started_at.
   */
  claimNext(tenantId: string, now: Date): Promise<JobQueueJob | null>;

  /** `running` → `succeeded` + finished_at (tenant-scoped). */
  markSucceeded(
    jobId: string,
    tenantId: string,
  ): Promise<JobQueueJob | null>;

  /**
   * Falla de un intento (tenant-scoped): si `attempts < max_attempts` (y
   * `retry !== false`) vuelve a `pending` con `run_at = retryAt` +
   * `last_error`; si agotó los intentos queda `dead` terminal +
   * `dead_lettered_at` + finished_at; con `retry === false` queda `failed`
   * terminal + finished_at. Siempre preserva `last_error` y `error_category`.
   */
  markFailed(
    jobId: string,
    tenantId: string,
    error: string,
    opts?: MarkFailedOptions,
  ): Promise<JobQueueJob | null>;

  /**
   * Reintento manual (tenant-scoped): desde `dead`/`failed`/`cancelled` →
   * `pending`, attempts=0, run_at=now, last_error=null, error_category=null,
   * dead_lettered_at=null, started/finished=null (corrida nueva). Otro
   * estado → `null` (no-op — la API lo traduce a 409).
   */
  retry(jobId: string, tenantId: string): Promise<JobQueueJob | null>;

  /**
   * Cancelación manual (tenant-scoped): desde `pending`/`running` →
   * `cancelled` + finished_at. Un job `running` puede terminar su handler en
   * vuelo igual — la cancelación es una marca, no mata el proceso.
   */
  cancel(jobId: string, tenantId: string): Promise<JobQueueJob | null>;

  getById(jobId: string, tenantId: string): Promise<JobQueueJob | null>;

  /** Lista tenant-scoped con filtros + paginación (más nuevos primero). */
  listByTenant(
    tenantId: string,
    filter: ListJobsFilter,
  ): Promise<ListJobsResult>;

  /** Dead-letter del tenant: status='dead', más recientes primero. */
  listDeadLetters(
    tenantId: string,
    opts: { limit: number; offset: number },
  ): Promise<ListJobsResult>;

  /**
   * Conteos por estado sobre los filtros dados (tenantId y/o kind
   * opcionales). Record completo: los estados sin filas cuentan 0.
   * Con `tenantId` es la vista tenant; sin él, cross-tenant (admin).
   */
  countByStatus(opts?: {
    tenantId?: string;
    kind?: string;
  }): Promise<JobQueueStatusCounts>;

  /**
   * EXCEPCIÓN cross-tenant documentada (panel admin — mismo criterio que
   * adminService.ts: el guard es requirePlatformAdmin, no tenant_id).
   * Lectura solamente: lista con filtros, `tenantId` opcional.
   */
  listAll(filter: ListAllJobsFilter): Promise<ListJobsResult>;

  /**
   * EXCEPCIÓN cross-tenant documentada: lookup por id sin tenant — el
   * handler admin lo usa para RESOLVER el tenant de la fila y después opera
   * tenant-scoped (`retry(jobId, job.tenantId)`). Nunca devuelve la fila a
   * un caller tenant-scoped.
   */
  getByIdGlobal(jobId: string): Promise<JobQueueJob | null>;
}

/** Reintentos del claim si otro worker gana la carrera por la candidata. */
const MAX_CLAIM_ATTEMPTS = 3;

/** Estados que el retry manual puede reabrir. */
const RETRYABLE_STATUSES: JobQueueStatus[] = ['dead', 'failed', 'cancelled'];
/** Estados desde los que se puede cancelar. */
const CANCELLABLE_STATUSES: JobQueueStatus[] = ['pending', 'running'];

// ---------------------------------------------------------------------------
// Backoff — puro y exportado
// ---------------------------------------------------------------------------

/** Base del backoff exponencial: 60 s. */
export const BACKOFF_BASE_MS = 60_000;
/** Tope del backoff: 1 h. */
export const BACKOFF_CAP_MS = 3_600_000;

/**
 * `backoffMs(attempt)` = min(60 s × 2^(attempt-1), 1 h):
 * 60 s, 2 min, 4 min, 8 min, 16 min, 32 min, 1 h, 1 h, …
 * `attempt` es el número de intento YA consumido (el claim incrementa
 * `attempts` antes de despachar — el primer fallo espera 60 s).
 */
export function backoffMs(attempt: number): number {
  if (attempt < 1) return BACKOFF_BASE_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------------------
// Store drizzle — regla tenant_id sin excepciones salvo las documentadas
// ---------------------------------------------------------------------------

export function createDrizzleJobQueueStore(
  executor: Database = db,
): JobQueueStore {
  const tenantFilter = (tenantId?: string, kind?: string) =>
    and(
      tenantId ? eq(jobQueue.tenantId, tenantId) : undefined,
      kind ? eq(jobQueue.kind, kind) : undefined,
    );

  return {
    async enqueue(v) {
      const [row] = await executor
        .insert(jobQueue)
        .values({
          tenantId: v.tenantId,
          kind: v.kind,
          payload: v.payload ?? {},
          ...(v.maxAttempts !== undefined
            ? { maxAttempts: v.maxAttempts }
            : {}),
        })
        .returning();
      return row;
    },

    // Tenant-scoped como TODA query de esta cola — ver §3.4 del brief.
    async claimNext(tenantId, now) {
      for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i++) {
        const [candidate] = await executor
          .select({ id: jobQueue.id })
          .from(jobQueue)
          .where(
            and(
              eq(jobQueue.tenantId, tenantId),
              eq(jobQueue.status, 'pending'),
              lte(jobQueue.runAt, now),
            ),
          )
          .orderBy(asc(jobQueue.runAt), asc(jobQueue.createdAt))
          .limit(1);
        if (!candidate) return null;

        const [claimed] = await executor
          .update(jobQueue)
          .set({
            status: 'running',
            attempts: sql`${jobQueue.attempts} + 1`,
            startedAt: now,
          })
          .where(
            and(
              eq(jobQueue.id, candidate.id),
              eq(jobQueue.tenantId, tenantId),
              eq(jobQueue.status, 'pending'),
            ),
          )
          .returning();
        if (claimed) return claimed;
        // Otro worker claimeó esta fila primero → probar con la siguiente.
      }
      return null;
    },

    async markSucceeded(jobId, tenantId) {
      const [row] = await executor
        .update(jobQueue)
        .set({ status: 'succeeded', finishedAt: new Date() })
        .where(and(eq(jobQueue.id, jobId), eq(jobQueue.tenantId, tenantId)))
        .returning();
      return row ?? null;
    },

    async markFailed(jobId, tenantId, error, opts) {
      const [current] = await executor
        .select({
          attempts: jobQueue.attempts,
          maxAttempts: jobQueue.maxAttempts,
        })
        .from(jobQueue)
        .where(and(eq(jobQueue.id, jobId), eq(jobQueue.tenantId, tenantId)))
        .limit(1);
      if (!current) return null;

      const now = new Date();
      const category = opts?.category ?? null;
      const exhausted = current.attempts >= current.maxAttempts;
      const [row] = await executor
        .update(jobQueue)
        .set(
          exhausted
            ? {
                status: 'dead',
                lastError: error,
                errorCategory: category,
                deadLetteredAt: now,
                finishedAt: now,
              }
            : opts?.retry === false
              ? {
                  status: 'failed',
                  lastError: error,
                  errorCategory: category,
                  finishedAt: now,
                }
              : {
                  status: 'pending',
                  lastError: error,
                  errorCategory: category,
                  runAt: opts?.retryAt ?? now,
                },
        )
        .where(and(eq(jobQueue.id, jobId), eq(jobQueue.tenantId, tenantId)))
        .returning();
      return row ?? null;
    },

    async retry(jobId, tenantId) {
      const [row] = await executor
        .update(jobQueue)
        .set({
          status: 'pending',
          attempts: 0,
          lastError: null,
          errorCategory: null,
          runAt: new Date(),
          startedAt: null,
          finishedAt: null,
          deadLetteredAt: null,
        })
        .where(
          and(
            eq(jobQueue.id, jobId),
            eq(jobQueue.tenantId, tenantId),
            inArray(jobQueue.status, RETRYABLE_STATUSES),
          ),
        )
        .returning();
      return row ?? null;
    },

    async cancel(jobId, tenantId) {
      const [row] = await executor
        .update(jobQueue)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(
          and(
            eq(jobQueue.id, jobId),
            eq(jobQueue.tenantId, tenantId),
            inArray(jobQueue.status, CANCELLABLE_STATUSES),
          ),
        )
        .returning();
      return row ?? null;
    },

    async getById(jobId, tenantId) {
      const [row] = await executor
        .select()
        .from(jobQueue)
        .where(and(eq(jobQueue.id, jobId), eq(jobQueue.tenantId, tenantId)))
        .limit(1);
      return row ?? null;
    },

    async listByTenant(tenantId, filter) {
      const where = and(
        eq(jobQueue.tenantId, tenantId),
        filter.status ? eq(jobQueue.status, filter.status) : undefined,
        filter.kind ? eq(jobQueue.kind, filter.kind) : undefined,
      );
      const [jobs, [{ total }]] = await Promise.all([
        executor
          .select()
          .from(jobQueue)
          .where(where)
          .orderBy(desc(jobQueue.createdAt), desc(jobQueue.id))
          .limit(filter.limit)
          .offset(filter.offset),
        executor.select({ total: count() }).from(jobQueue).where(where),
      ]);
      return { jobs, total };
    },

    async listDeadLetters(tenantId, opts) {
      const where = and(
        eq(jobQueue.tenantId, tenantId),
        eq(jobQueue.status, 'dead'),
      );
      const [jobs, [{ total }]] = await Promise.all([
        executor
          .select()
          .from(jobQueue)
          .where(where)
          .orderBy(desc(jobQueue.deadLetteredAt), desc(jobQueue.id))
          .limit(opts.limit)
          .offset(opts.offset),
        executor.select({ total: count() }).from(jobQueue).where(where),
      ]);
      return { jobs, total };
    },

    async countByStatus(opts) {
      const rows = await executor
        .select({ status: jobQueue.status, n: count() })
        .from(jobQueue)
        .where(tenantFilter(opts?.tenantId, opts?.kind))
        .groupBy(jobQueue.status);
      const counts = Object.fromEntries(
        JOB_QUEUE_STATUSES.map((s) => [s, 0]),
      ) as JobQueueStatusCounts;
      for (const row of rows) {
        if (isJobQueueStatus(row.status)) counts[row.status] = row.n;
      }
      return counts;
    },

    // EXCEPCIÓN cross-tenant documentada — panel admin (lectura).
    async listAll(filter) {
      const where = and(
        filter.tenantId ? eq(jobQueue.tenantId, filter.tenantId) : undefined,
        filter.status ? eq(jobQueue.status, filter.status) : undefined,
        filter.kind ? eq(jobQueue.kind, filter.kind) : undefined,
      );
      const [jobs, [{ total }]] = await Promise.all([
        executor
          .select()
          .from(jobQueue)
          .where(where)
          .orderBy(desc(jobQueue.createdAt), desc(jobQueue.id))
          .limit(filter.limit)
          .offset(filter.offset),
        executor.select({ total: count() }).from(jobQueue).where(where),
      ]);
      return { jobs, total };
    },

    // EXCEPCIÓN cross-tenant documentada — resuelve el tenant de la fila.
    async getByIdGlobal(jobId) {
      const [row] = await executor
        .select()
        .from(jobQueue)
        .where(eq(jobQueue.id, jobId))
        .limit(1);
      return row ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio — wrapper fino del store (patrón repo)
// ---------------------------------------------------------------------------

export function createJobQueueService(
  store: JobQueueStore = createDrizzleJobQueueStore(),
) {
  return {
    enqueue(v: EnqueueJobInput) {
      return store.enqueue(v);
    },
    getJob(jobId: string, tenantId: string) {
      return store.getById(jobId, tenantId);
    },
    listJobs(tenantId: string, filter: ListJobsFilter) {
      return store.listByTenant(tenantId, filter);
    },
    listDeadLetters(tenantId: string, opts: { limit: number; offset: number }) {
      return store.listDeadLetters(tenantId, opts);
    },
    countByStatus(opts?: { tenantId?: string; kind?: string }) {
      return store.countByStatus(opts);
    },
    retryJob(jobId: string, tenantId: string) {
      return store.retry(jobId, tenantId);
    },
    cancelJob(jobId: string, tenantId: string) {
      return store.cancel(jobId, tenantId);
    },
    /** Listado cross-tenant — sólo lo invoca el router admin. */
    listAllJobs(filter: ListAllJobsFilter) {
      return store.listAll(filter);
    },
    /** Lookup global por id — sólo lo invoca el router admin. */
    getJobGlobal(jobId: string) {
      return store.getByIdGlobal(jobId);
    },
  };
}

export type JobQueueService = ReturnType<typeof createJobQueueService>;

export const jobQueueService = createJobQueueService();
