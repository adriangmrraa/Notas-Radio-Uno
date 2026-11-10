/**
 * memoryRenderJobsStore — implementación en memoria de `ClipRenderQueueStore`
 * para los tests de la cola de render (PF-04). Sin DB: reproduce los MISMOS
 * filtros que la implementación drizzle:
 *
 *   - `claimNext` es tenant-agnóstico (excepción documentada del brief):
 *     toma el primer `pending` con `run_at <= now` ordenado por
 *     run_at/created_at y lo pasa a `running` con attempts+1.
 *   - `retry`/`cancel`/`getById` matchean por `id AND tenant_id`:
 *     un id ajeno al tenant no se encuentra → null/no-op (mismo WHERE que el
 *     UPDATE/SELECT drizzle). `listByClip` matchea por tenant AND
 *     (clip_id OR payload.recutOf) — el OR de PF-05 liga el recut job al
 *     clip origen.
 *   - `markFailed` mira `attempts >= maxAttempts` (o `retry === false`) para
 *     decidir `error` terminal vs vuelta a `pending` con `run_at = retryAt`.
 *
 * `now` inyectable: los defaults de columna que en drizzle son `defaultNow()`
 * (run_at del enqueue) y los timestamps de transición (finished_at) usan el
 * reloj inyectado — mismo contrato que las deps `now` del worker/scheduler,
 * así los tests son deterministas con un `T0` fijo.
 */
import type {
  ClipRenderJob,
  ClipRenderQueueStore,
} from '../../src/server/services/clipRenderQueueService';

export interface MemoryRenderJobsState {
  /** Filas vivas — mutables a propósito (los tests ajustan runAt/status). */
  jobs: ClipRenderJob[];
}

let seq = 0;

/** Fila completa como la devolvería `.returning()` del drizzle. */
export function makeMemoryJob(
  v: Partial<ClipRenderJob> & { tenantId: string; kind: string },
  now: () => Date = () => new Date(),
): ClipRenderJob {
  const t = now();
  return {
    id: v.id ?? `mem-job-${++seq}`,
    tenantId: v.tenantId,
    clipId: v.clipId ?? null,
    kind: v.kind,
    status: v.status ?? 'pending',
    payload: v.payload ?? {},
    attempts: v.attempts ?? 0,
    maxAttempts: v.maxAttempts ?? 3,
    lastError: v.lastError ?? null,
    runAt: v.runAt ?? t,
    startedAt: v.startedAt ?? null,
    finishedAt: v.finishedAt ?? null,
    createdAt: v.createdAt ?? t,
    updatedAt: v.updatedAt ?? t,
  };
}

export function createMemoryRenderJobsStore(opts?: {
  jobs?: Array<Partial<ClipRenderJob> & { tenantId: string; kind: string }>;
  /** Reloj para defaults `defaultNow` y timestamps de transición. */
  now?: () => Date;
}): { store: ClipRenderQueueStore; state: MemoryRenderJobsState } {
  const now = opts?.now ?? (() => new Date());
  const state: MemoryRenderJobsState = {
    jobs: (opts?.jobs ?? []).map((j) => makeMemoryJob(j, now)),
  };

  const byIdAndTenant = (jobId: string, tenantId: string) =>
    state.jobs.find((j) => j.id === jobId && j.tenantId === tenantId);

  const store: ClipRenderQueueStore = {
    async enqueue(v) {
      const row = makeMemoryJob(
        {
          tenantId: v.tenantId,
          clipId: v.clipId ?? null,
          kind: v.kind,
          payload: v.payload,
          maxAttempts: v.maxAttempts ?? 3,
        },
        now,
      );
      state.jobs.push(row);
      return row;
    },

    // Tenant-agnóstico igual que el drizzle: la cola es global (excepción
    // documentada) — el tenant viaja en la fila.
    async claimNext(at) {
      const candidate = state.jobs
        .filter(
          (j) => j.status === 'pending' && j.runAt.getTime() <= at.getTime(),
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

    async markDone(jobId, opts) {
      const job = state.jobs.find((j) => j.id === jobId);
      if (!job) return null;
      job.status = 'done';
      job.finishedAt = now();
      if (opts?.clipId) job.clipId = opts.clipId;
      return job;
    },

    async markFailed(jobId, error, opts) {
      const job = state.jobs.find((j) => j.id === jobId);
      if (!job) return null;
      const terminal = opts?.retry === false || job.attempts >= job.maxAttempts;
      job.lastError = error;
      if (terminal) {
        job.status = 'error';
        job.finishedAt = now();
      } else {
        job.status = 'pending';
        job.runAt = opts?.retryAt ?? now();
      }
      return job;
    },

    async retry(jobId, tenantId) {
      const job = byIdAndTenant(jobId, tenantId);
      // Mismo WHERE que el drizzle: sólo 'error' o 'cancelled' reabren.
      if (!job || (job.status !== 'error' && job.status !== 'cancelled')) {
        return null;
      }
      job.status = 'pending';
      job.attempts = 0;
      job.lastError = null;
      job.runAt = now();
      job.startedAt = null;
      job.finishedAt = null;
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

    async listByClip(clipId, tenantId) {
      // Mismo WHERE que el drizzle extendido (PF-05): tenant_id AND
      // (clip_id = :id OR payload->>'recutOf' = :id) — un recut job queda
      // ligado al clip origen por payload.recutOf aunque su clip_id apunte
      // al clip derivado cuando termina.
      return state.jobs
        .filter(
          (j) =>
            j.tenantId === tenantId &&
            (j.clipId === clipId ||
              (j.payload as { recutOf?: unknown }).recutOf === clipId),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async listPending(tenantId) {
      return state.jobs
        .filter(
          (j) =>
            j.status === 'pending' &&
            (tenantId === undefined || j.tenantId === tenantId),
        )
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    },
  };

  return { store, state };
}
