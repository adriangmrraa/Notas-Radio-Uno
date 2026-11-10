/**
 * memoryPublishJobStore — implementación en memoria de `PublishJobStore`
 * para los tests de la cola de publicación (PG-05). Sin DB: reproduce los
 * MISMOS filtros que la implementación drizzle:
 *
 *   - `enqueueJob` deduplica por `idempotency_key` (UNIQUE): si ya existe
 *     devuelve `{created:false}` con la fila — igual que el
 *     ON CONFLICT DO NOTHING + select del drizzle.
 *   - `claimNext` es tenant-agnóstico (excepción documentada, igual que
 *     clipRenderQueueStore): toma el primer `queued` con
 *     `next_attempt_at <= now` ordenado por next_attempt_at/created_at y lo
 *     pasa a `publishing` con attempts+1.
 *   - `getById`/`cancel`/`requeue`/`list`/`count`/`listBySource` filtran por
 *     tenant_id — un job ajeno no existe (mismo WHERE que el drizzle).
 *   - `markFailed` mira `requeueAt` + `attempts >= maxAttempts` para decidir
 *     vuelta a `queued` (backoff) vs `failed` terminal.
 *
 * `now` inyectable: los defaults de columna (created_at/updated_at) y los
 * timestamps de transición (published_at) usan el reloj inyectado — tests
 * deterministas con un `T0` fijo.
 */
import type {
  JobErrorInfo,
  ListPublishJobsOptions,
  PublishJob,
  PublishJobStore,
} from '../../src/server/services/publishJobService';

export interface MemoryPublishJobsState {
  /** Filas vivas — mutables a propósito (los tests ajustan status/attempts). */
  jobs: PublishJob[];
}

let seq = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** Fila completa como la devolvería `.returning()` del drizzle. */
export function makeMemoryPublishJob(
  v: Partial<PublishJob> & {
    tenantId: string;
    platform: string;
    accountId: string;
    idempotencyKey: string;
    content: string;
  },
  now: () => Date = () => new Date(),
): PublishJob {
  const t = now();
  return {
    id: v.id ?? nextId(),
    tenantId: v.tenantId,
    assetId: v.assetId ?? null,
    publicationId: v.publicationId ?? null,
    connectionId: v.connectionId ?? null,
    platform: v.platform,
    accountId: v.accountId,
    status: v.status ?? 'queued',
    zernioPostId: v.zernioPostId ?? null,
    idempotencyKey: v.idempotencyKey,
    content: v.content,
    mediaUrls: v.mediaUrls ?? [],
    payload: v.payload ?? {},
    attempts: v.attempts ?? 0,
    maxAttempts: v.maxAttempts ?? 3,
    lastError: v.lastError ?? null,
    lastErrorCategory: v.lastErrorCategory ?? null,
    lastErrorSource: v.lastErrorSource ?? null,
    scheduledFor: v.scheduledFor ?? null,
    publishedAt: v.publishedAt ?? null,
    platformPostUrl: v.platformPostUrl ?? null,
    nextAttemptAt: v.nextAttemptAt ?? t,
    createdAt: v.createdAt ?? t,
    updatedAt: v.updatedAt ?? t,
  };
}

export function createMemoryPublishJobStore(opts?: {
  jobs?: Array<
    Partial<PublishJob> & {
      tenantId: string;
      platform: string;
      accountId: string;
      idempotencyKey: string;
      content: string;
    }
  >;
  /** Reloj para defaults `defaultNow` y timestamps de transición. */
  now?: () => Date;
}): { store: PublishJobStore; state: MemoryPublishJobsState } {
  const now = opts?.now ?? (() => new Date());
  const state: MemoryPublishJobsState = {
    jobs: (opts?.jobs ?? []).map((j) => makeMemoryPublishJob(j, now)),
  };

  const byId = (jobId: string) => state.jobs.find((j) => j.id === jobId);
  const byIdAndTenant = (jobId: string, tenantId: string) =>
    state.jobs.find((j) => j.id === jobId && j.tenantId === tenantId);
  const touch = (job: PublishJob) => {
    job.updatedAt = now();
  };

  const store: PublishJobStore = {
    async enqueueJob(input) {
      // Misma semántica que ON CONFLICT (idempotency_key) DO NOTHING.
      const existing = state.jobs.find(
        (j) => j.idempotencyKey === input.idempotencyKey,
      );
      if (existing) return { job: existing, created: false };

      const row = makeMemoryPublishJob(
        {
          tenantId: input.tenantId,
          assetId: input.assetId,
          publicationId: input.publicationId,
          connectionId: input.connectionId,
          platform: input.platform,
          accountId: input.accountId,
          idempotencyKey: input.idempotencyKey,
          content: input.content,
          mediaUrls: input.mediaUrls,
          payload: input.payload ?? {},
          scheduledFor: input.scheduledFor,
          nextAttemptAt: input.nextAttemptAt,
          maxAttempts: input.maxAttempts ?? 3,
        },
        now,
      );
      state.jobs.push(row);
      return { job: row, created: true };
    },

    // Tenant-agnóstico igual que el drizzle: la cola es global (excepción
    // documentada) — el tenant viaja en la fila.
    async claimNext(at) {
      const candidate = state.jobs
        .filter(
          (j) =>
            j.status === 'queued' &&
            (j.nextAttemptAt === null || j.nextAttemptAt.getTime() <= at.getTime()),
        )
        .sort(
          (a, b) =>
            (a.nextAttemptAt?.getTime() ?? 0) - (b.nextAttemptAt?.getTime() ?? 0) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )[0];
      if (!candidate) return null;
      candidate.status = 'publishing';
      candidate.attempts += 1;
      touch(candidate);
      return candidate;
    },

    async cancel(jobId, tenantId) {
      const job = byIdAndTenant(jobId, tenantId);
      if (!job || (job.status !== 'queued' && job.status !== 'publishing')) {
        return null;
      }
      job.status = 'cancelled';
      touch(job);
      return job;
    },

    async getById(jobId, tenantId) {
      return byIdAndTenant(jobId, tenantId) ?? null;
    },

    async list(tenantId, opts: ListPublishJobsOptions = {}) {
      const filtered = state.jobs
        .filter(
          (j) =>
            j.tenantId === tenantId &&
            (opts.status === undefined || j.status === opts.status),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return filtered.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 100));
    },

    async count(tenantId, status) {
      return state.jobs.filter(
        (j) => j.tenantId === tenantId && (status === undefined || j.status === status),
      ).length;
    },

    async listBySource(tenantId, source) {
      if (!source.assetId && !source.publicationId) return [];
      return state.jobs
        .filter(
          (j) =>
            j.tenantId === tenantId &&
            ((source.assetId !== undefined &&
              source.assetId !== null &&
              j.assetId === source.assetId) ||
              (source.publicationId !== undefined &&
                source.publicationId !== null &&
                j.publicationId === source.publicationId)),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async markPublishing(jobId, opts = {}) {
      const job = byId(jobId);
      if (!job) return null;
      job.status = 'publishing';
      if (opts.zernioPostId !== undefined) job.zernioPostId = opts.zernioPostId;
      if (opts.note !== undefined) job.lastError = opts.note;
      touch(job);
      return job;
    },

    async markPublished(jobId, opts) {
      const job = byId(jobId);
      if (!job) return null;
      job.status = 'published';
      job.zernioPostId = opts.zernioPostId ?? null;
      job.platformPostUrl = opts.platformPostUrl ?? null;
      job.publishedAt = opts.publishedAt ?? now();
      job.lastError = null;
      job.lastErrorCategory = null;
      job.lastErrorSource = null;
      touch(job);
      return job;
    },

    async markPartial(jobId, opts) {
      const job = byId(jobId);
      if (!job) return null;
      job.status = 'partial';
      job.zernioPostId = opts.zernioPostId ?? null;
      job.platformPostUrl = opts.platformPostUrl ?? null;
      job.publishedAt = now();
      job.lastError = opts.error?.message ?? null;
      job.lastErrorCategory = opts.error?.category ?? null;
      job.lastErrorSource = opts.error?.source ?? null;
      touch(job);
      return job;
    },

    async markFailed(jobId, error: JobErrorInfo, opts) {
      const job = byId(jobId);
      if (!job) return null;
      const terminal =
        opts?.requeueAt === undefined || job.attempts >= job.maxAttempts;
      job.status = terminal ? 'failed' : 'queued';
      job.zernioPostId = error.zernioPostId ?? null;
      job.platformPostUrl = error.platformPostUrl ?? null;
      job.lastError = error.message;
      job.lastErrorCategory = error.category ?? null;
      job.lastErrorSource = error.source ?? null;
      if (!terminal && opts?.requeueAt) job.nextAttemptAt = opts.requeueAt;
      touch(job);
      return job;
    },

    async markCancelled(jobId) {
      const job = byId(jobId);
      if (!job) return null;
      job.status = 'cancelled';
      touch(job);
      return job;
    },

    async requeue(jobId, tenantId, opts) {
      const job = byIdAndTenant(jobId, tenantId);
      // Mismo WHERE que el drizzle: sólo 'failed'/'partial' reabren.
      if (!job || (job.status !== 'failed' && job.status !== 'partial')) {
        return null;
      }
      job.status = 'queued';
      job.nextAttemptAt = opts.nextAttemptAt;
      touch(job);
      return job;
    },

    async recordAttempt(jobId) {
      const job = byId(jobId);
      if (!job) return null;
      job.attempts += 1;
      touch(job);
      return job;
    },
  };

  return { store, state };
}
