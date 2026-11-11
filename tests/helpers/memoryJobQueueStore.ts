/**
 * memoryJobQueueStore — implementación en memoria de `JobQueueStore` para
 * los tests de la cola genérica (PI-01). Sin DB: reproduce los MISMOS
 * filtros que la implementación drizzle:
 *
 *   - `claimNext` es TENANT-SCOPED (a diferencia de la cola de render):
 *     toma el primer `pending` del tenant con `run_at <= now` ordenado por
 *     run_at/created_at y lo pasa a `running` con attempts+1 + started_at.
 *   - `getById`/`retry`/`cancel`/`markSucceeded`/`markFailed` matchean por
 *     `id AND tenant_id` — un job ajeno no existe (mismo WHERE que el
 *     UPDATE/SELECT drizzle).
 *   - `markFailed` decide `dead` terminal (attempts >= maxAttempts, con
 *     dead_lettered_at) vs `failed` terminal (retry === false) vs vuelta a
 *     `pending` con `run_at = retryAt`.
 *   - `listByTenant`/`listDeadLetters`/`countByStatus` filtran por
 *     tenant_id; `listAll`/`getByIdGlobal` son las excepciones cross-tenant
 *     documentadas del panel admin.
 *
 * `now` inyectable: los defaults de columna (run_at del enqueue,
 * created_at/updated_at) y los timestamps de transición usan el reloj
 * inyectado — tests deterministas con un `T0` fijo.
 */
import type {
  EnqueueJobInput,
  JobQueueJob,
  JobQueueStatus,
  JobQueueStatusCounts,
  JobQueueStore,
  ListAllJobsFilter,
  ListJobsFilter,
} from '../../src/server/services/jobQueueService';
import { JOB_QUEUE_STATUSES } from '../../src/server/services/jobQueueService';

export interface MemoryJobQueueState {
  /** Filas vivas — mutables a propósito (los tests ajustan runAt/status). */
  jobs: JobQueueJob[];
}

let seq = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** Fila completa como la devolvería `.returning()` del drizzle. */
export function makeMemoryJob(
  v: Partial<JobQueueJob> & { tenantId: string; kind: string },
  now: () => Date = () => new Date(),
): JobQueueJob {
  const t = now();
  return {
    id: v.id ?? nextId(),
    tenantId: v.tenantId,
    kind: v.kind,
    status: v.status ?? 'pending',
    payload: v.payload ?? {},
    attempts: v.attempts ?? 0,
    maxAttempts: v.maxAttempts ?? 5,
    runAt: v.runAt ?? t,
    startedAt: v.startedAt ?? null,
    finishedAt: v.finishedAt ?? null,
    deadLetteredAt: v.deadLetteredAt ?? null,
    lastError: v.lastError ?? null,
    errorCategory: v.errorCategory ?? null,
    createdAt: v.createdAt ?? t,
    updatedAt: v.updatedAt ?? t,
  };
}

export function createMemoryJobQueueStore(opts?: {
  jobs?: Array<Partial<JobQueueJob> & { tenantId: string; kind: string }>;
  /** Reloj para defaults `defaultNow` y timestamps de transición. */
  now?: () => Date;
}): { store: JobQueueStore; state: MemoryJobQueueState } {
  const now = opts?.now ?? (() => new Date());
  const state: MemoryJobQueueState = {
    jobs: (opts?.jobs ?? []).map((j) => makeMemoryJob(j, now)),
  };

  const byIdAndTenant = (jobId: string, tenantId: string) =>
    state.jobs.find((j) => j.id === jobId && j.tenantId === tenantId);

  const applyListFilters = (
    rows: JobQueueJob[],
    filter: ListJobsFilter & { tenantId?: string },
  ) =>
    rows.filter(
      (j) =>
        (filter.tenantId === undefined || j.tenantId === filter.tenantId) &&
        (filter.status === undefined || j.status === filter.status) &&
        (filter.kind === undefined || j.kind === filter.kind),
    );

  const newestFirst = (rows: JobQueueJob[]) =>
    [...rows].sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    );

  const store: JobQueueStore = {
    async enqueue(v: EnqueueJobInput) {
      const row = makeMemoryJob(
        {
          tenantId: v.tenantId,
          kind: v.kind,
          payload: v.payload ?? {},
          maxAttempts: v.maxAttempts ?? 5,
        },
        now,
      );
      state.jobs.push(row);
      return row;
    },

    // Tenant-scoped igual que el drizzle: la candidata más vieja del tenant
    // con run_at <= now.
    async claimNext(tenantId, at) {
      const candidate = state.jobs
        .filter(
          (j) =>
            j.tenantId === tenantId &&
            j.status === 'pending' &&
            j.runAt.getTime() <= at.getTime(),
        )
        .sort(
          (a, b) =>
            a.runAt.getTime() - b.runAt.getTime() ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )[0];
      if (!candidate) return null;
      candidate.status = 'running';
      candidate.attempts += 1;
      candidate.startedAt = at;
      return candidate;
    },

    async markSucceeded(jobId, tenantId) {
      const job = byIdAndTenant(jobId, tenantId);
      if (!job) return null;
      job.status = 'succeeded';
      job.finishedAt = now();
      return job;
    },

    async markFailed(jobId, tenantId, error, opts) {
      const job = byIdAndTenant(jobId, tenantId);
      if (!job) return null;
      job.lastError = error;
      job.errorCategory = opts?.category ?? null;
      if (job.attempts >= job.maxAttempts) {
        job.status = 'dead';
        job.deadLetteredAt = now();
        job.finishedAt = now();
      } else if (opts?.retry === false) {
        job.status = 'failed';
        job.finishedAt = now();
      } else {
        job.status = 'pending';
        job.runAt = opts?.retryAt ?? now();
      }
      return job;
    },

    async retry(jobId, tenantId) {
      const job = byIdAndTenant(jobId, tenantId);
      // Mismo WHERE que el drizzle: sólo dead/failed/cancelled reabren.
      if (
        !job ||
        (job.status !== 'dead' &&
          job.status !== 'failed' &&
          job.status !== 'cancelled')
      ) {
        return null;
      }
      job.status = 'pending';
      job.attempts = 0;
      job.lastError = null;
      job.errorCategory = null;
      job.runAt = now();
      job.startedAt = null;
      job.finishedAt = null;
      job.deadLetteredAt = null;
      return job;
    },

    async cancel(jobId, tenantId) {
      const job = byIdAndTenant(jobId, tenantId);
      if (!job || (job.status !== 'pending' && job.status !== 'running')) {
        return null;
      }
      job.status = 'cancelled';
      job.finishedAt = now();
      return job;
    },

    async getById(jobId, tenantId) {
      return byIdAndTenant(jobId, tenantId) ?? null;
    },

    async listByTenant(tenantId, filter: ListJobsFilter) {
      const rows = newestFirst(
        applyListFilters(state.jobs, { ...filter, tenantId }),
      );
      return {
        jobs: rows.slice(filter.offset, filter.offset + filter.limit),
        total: rows.length,
      };
    },

    async listDeadLetters(tenantId, opts) {
      const rows = state.jobs
        .filter((j) => j.tenantId === tenantId && j.status === 'dead')
        .sort(
          (a, b) =>
            (b.deadLetteredAt?.getTime() ?? 0) -
              (a.deadLetteredAt?.getTime() ?? 0) || b.id.localeCompare(a.id),
        );
      return {
        jobs: rows.slice(opts.offset, opts.offset + opts.limit),
        total: rows.length,
      };
    },

    async countByStatus(o) {
      const counts = Object.fromEntries(
        JOB_QUEUE_STATUSES.map((s) => [s, 0]),
      ) as JobQueueStatusCounts;
      for (const j of state.jobs) {
        if (o?.tenantId !== undefined && j.tenantId !== o.tenantId) continue;
        if (o?.kind !== undefined && j.kind !== o.kind) continue;
        if ((JOB_QUEUE_STATUSES as readonly string[]).includes(j.status)) {
          counts[j.status as JobQueueStatus] += 1;
        }
      }
      return counts;
    },

    // Cross-tenant igual que el drizzle (excepción documentada — admin).
    async listAll(filter: ListAllJobsFilter) {
      const rows = newestFirst(applyListFilters(state.jobs, filter));
      return {
        jobs: rows.slice(filter.offset, filter.offset + filter.limit),
        total: rows.length,
      };
    },

    // Cross-tenant igual que el drizzle (excepción documentada — admin).
    async getByIdGlobal(jobId) {
      return state.jobs.find((j) => j.id === jobId) ?? null;
    },
  };

  return { store, state };
}
