/**
 * jobQueueWorker — loop de dispatch de la cola `job_queue` (PI-01, Épica I).
 *
 * Cada `POLL_MS` (default 10 s, env `JOB_QUEUE_WORKER_POLL_MS`) un tick
 * recorre los tenants y claimea UN job por tenant vía
 * `store.claimNext(tenantId, now)` — el claim es tenant-scoped como TODA
 * query de esta cola (§3.4 del brief): el worker NO adivina el tenant del
 * job, itera la tabla `tenants` (identidad de plataforma, no dato de
 * negocio) y claimea por tenant. Con N tenants y un tick se despachan hasta
 * N jobs (uno por tenant) — aislamiento justo: un tenant con mucha cola no
 * muere de hambre a otro.
 *
 * Handlers por `kind` — registro extensible:
 *   - `registerJobHandler(kind, handler)` suma un handler al mapa global
 *     `jobHandlers`. El único seed real de este slice:
 *       'retention.purge' → `purgeExpiredRecordings(now, { tenantId:
 *       job.tenantId, dryRun: false })` (reutiliza el servicio de retención
 *       de crudos existente — la cola ya nace con un consumidor real).
 *   - kind sin handler → `markFailed(jobId, tenantId, msg, { retry: false,
 *     category: 'unknown_kind' })` directo a `failed` terminal: reintentar
 *     lo que nadie sabe despachar es gastar attempts al pedo.
 *
 * Un error del handler → `markFailed` con `retryAt = now + backoffMs
 * (job.attempts)` (exponencial 60 s→1 h, ver jobQueueService). El claim ya
 * incrementó `attempts`, así que el primer fallo espera 60 s. `markFailed`
 * decide si vuelve a `pending` o queda `dead` terminal
 * (`attempts >= max_attempts`).
 *
 * Fire-and-forget por tick: el intervalo NO espera — en tests se llama
 * `worker.tick()` con await → determinista (sin timers, `now`/`backoffMs`
 * inyectados, `listTenantIds` y `handlers` inyectables).
 *
 * `io` es opcional: presente → emite por room `tenant:{tenantId}` (mismo
 * contrato que clipRenderWorker):
 *   - `job:queue:succeeded` — cuando un job termina OK.
 *   - `job:queue:dead` — SOLO cuando el job queda `dead` TERMINAL (un fallo
 *     que vuelve a `pending` para reintentar no es error de cara a la UI).
 *   - `job:queue:failed` — fallo terminal sin agotar reintentos
 *     (retry:false, p.ej. kind desconocido).
 *
 * Un solo worker por proceso: `initJobQueueWorker` ignora la segunda
 * llamada (guard) y `stopJobQueueWorker` limpia para tests.
 * `JOB_QUEUE_WORKER_ENABLED=0` lo apaga en procesos API-only (mismo patrón
 * que RENDER_WORKER_ENABLED / PUBLISH_WORKER_ENABLED).
 *
 * Dependencias inyectables: `{ store, listTenantIds, purgeExpired, handlers,
 * now, backoffMs }` con defaults reales — los tests corren sin DB y sin
 * timers.
 */
import type { Server } from 'socket.io';
import { asc } from 'drizzle-orm';

import { db } from '../db/index.js';
import { tenants } from '../db/schema/tenants.js';
import {
  backoffMs,
  createDrizzleJobQueueStore,
  type JobQueueJob,
  type JobQueueStore,
} from './jobQueueService.js';
import {
  purgeExpiredRecordings,
  type PurgeOutcome,
} from './rawRetentionService.js';

/** Intervalo de claim por default: 10 s (env `JOB_QUEUE_WORKER_POLL_MS`). */
export const POLL_MS = 10_000;

// ---------------------------------------------------------------------------
// Registro de handlers por kind
// ---------------------------------------------------------------------------

/**
 * Firma de un handler de la cola: recibe el job claimeado (ya `running`,
 * con `attempts` incrementado). Si resuelve → `succeeded`; si tira →
 * `markFailed` con backoff. El valor de retorno se descarta (el resultado
 * observable queda en los recursos que el handler tocó).
 */
export type JobQueueHandler = (job: JobQueueJob) => Promise<unknown>;

/**
 * Mapa global kind → handler. `registerJobHandler` es la vía pública de
 * extensión: un kind nuevo = una entrada en JOB_QUEUE_KINDS + un handler
 * registrado acá.
 */
export const jobHandlers = new Map<string, JobQueueHandler>();

export function registerJobHandler(
  kind: string,
  handler: JobQueueHandler,
): void {
  jobHandlers.set(kind, handler);
}

/** Quita un handler del registro (tests; unregistrar un kind en caliente). */
export function unregisterJobHandler(kind: string): void {
  jobHandlers.delete(kind);
}

/**
 * Seed real de PI-01: purga de crudos vencidos del tenant del job.
 * Factory que ata la dependencia inyectable — el default es el servicio de
 * retención real; los tests pasan un fake sin tocar el registro global
 * (`deps.handlers`).
 */
export function createRetentionPurgeHandler(
  purge: typeof purgeExpiredRecordings = purgeExpiredRecordings,
): JobQueueHandler {
  return async (job): Promise<PurgeOutcome> =>
    purge(new Date(), { tenantId: job.tenantId, dryRun: false });
}

// Seed global: procesos que inicializan el worker sin deps ya tienen el
// handler de retención registrado.
registerJobHandler('retention.purge', createRetentionPurgeHandler());

// ---------------------------------------------------------------------------
// Dependencias inyectables
// ---------------------------------------------------------------------------

/**
 * Subconjunto estructural de `socket.io.Server` que el worker necesita.
 * `Server` lo satisface; los tests pasan un fake sin levantar sockets.
 */
export interface JobQueueWorkerIo {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

export interface JobQueueWorkerDeps {
  store?: JobQueueStore;
  /**
   * Tenants a los que el tick les claimea (uno por tenant). Default: todos
   * los ids de la tabla `tenants` — identidad de plataforma, no dato de
   * negocio, es la ÚNICA lectura sin tenant_id del loop y no filtra jobs.
   */
  listTenantIds?: () => Promise<string[]>;
  /**
   * Mapa de handlers que el worker consulta. Default: el registro global
   * `jobHandlers` (registerJobHandler). Los tests pasan un mapa propio —
   * p.ej. `{ 'retention.purge': fake }` — sin mutar el global.
   */
  handlers?: ReadonlyMap<string, JobQueueHandler>;
  now?: () => Date;
  /** Backoff en ms según el nº de intento ya consumido. Default exponencial. */
  backoffMs?: (attempt: number) => number;
}

interface ResolvedWorkerDeps {
  store: JobQueueStore;
  listTenantIds: () => Promise<string[]>;
  handlers: ReadonlyMap<string, JobQueueHandler>;
  now: () => Date;
  backoffMs: (attempt: number) => number;
}

async function listAllTenantIds(): Promise<string[]> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.createdAt));
  return rows.map((r) => r.id);
}

function resolveDeps(deps: JobQueueWorkerDeps): ResolvedWorkerDeps {
  return {
    store: deps.store ?? createDrizzleJobQueueStore(),
    listTenantIds: deps.listTenantIds ?? listAllTenantIds,
    handlers: deps.handlers ?? jobHandlers,
    now: deps.now ?? (() => new Date()),
    backoffMs: deps.backoffMs ?? backoffMs,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitToTenant(
  io: JobQueueWorkerIo | undefined,
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!io) return;
  try {
    io.to(`tenant:${tenantId}`).emit(event, payload);
  } catch (err) {
    console.error(`[JobQueueWorker] emit ${event} falló:`, errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface JobQueueWorker {
  /**
   * Un tick: por cada tenant claimea UN job (claim atómico tenant-scoped)
   * y lo despacha. En tests se llama a mano — determinista.
   */
  tick(): Promise<void>;
}

export function createJobQueueWorker(
  deps: JobQueueWorkerDeps = {},
  io?: JobQueueWorkerIo,
): JobQueueWorker {
  const { store, listTenantIds, handlers, now, backoffMs: backoff } =
    resolveDeps(deps);

  async function dispatch(job: JobQueueJob): Promise<void> {
    const handler = handlers.get(job.kind);
    if (!handler) {
      const updated = await store.markFailed(
        job.id,
        job.tenantId,
        `unknown job kind: ${job.kind}`,
        { retry: false, category: 'unknown_kind' },
      );
      if (updated?.status === 'failed') {
        emitToTenant(io, job.tenantId, 'job:queue:failed', {
          jobId: job.id,
          kind: job.kind,
          error: updated.lastError,
        });
      }
      return;
    }

    try {
      await handler(job);
      const updated = await store.markSucceeded(job.id, job.tenantId);
      emitToTenant(io, job.tenantId, 'job:queue:succeeded', {
        jobId: job.id,
        kind: job.kind,
        status: updated?.status ?? 'succeeded',
      });
    } catch (err) {
      const msg = errorMessage(err);
      const retryAt = new Date(now().getTime() + backoff(job.attempts));
      const updated = await store.markFailed(job.id, job.tenantId, msg, {
        retryAt,
        category: 'handler_error',
      });
      if (updated?.status === 'dead') {
        emitToTenant(io, job.tenantId, 'job:queue:dead', {
          jobId: job.id,
          kind: job.kind,
          error: updated.lastError,
          attempts: updated.attempts,
          maxAttempts: updated.maxAttempts,
        });
      } else if (updated?.status === 'failed') {
        emitToTenant(io, job.tenantId, 'job:queue:failed', {
          jobId: job.id,
          kind: job.kind,
          error: updated.lastError,
        });
      }
    }
  }

  return {
    async tick() {
      for (const tenantId of await listTenantIds()) {
        const job = await store.claimNext(tenantId, now());
        if (!job) continue;
        await dispatch(job);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Init / stop (un solo worker por proceso)
// ---------------------------------------------------------------------------

let workerInterval: ReturnType<typeof setInterval> | null = null;

function resolvePollMs(): number {
  const raw = Number(process.env.JOB_QUEUE_WORKER_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : POLL_MS;
}

/**
 * Inicializa el worker de la cola (patrón `initClipRenderWorker`). Guard de
 * una sola instancia: una segunda llamada se ignora con warning — para
 * rearmar con otras deps hay que pasar por `stopJobQueueWorker` primero.
 */
export function initJobQueueWorker(
  io?: Server,
  deps: JobQueueWorkerDeps = {},
): void {
  if (workerInterval) {
    console.warn(
      '[JobQueueWorker] Ya inicializado — se ignora la segunda llamada',
    );
    return;
  }
  const worker = createJobQueueWorker(deps, io);
  const pollMs = resolvePollMs();
  workerInterval = setInterval(() => {
    // Fire-and-forget por tick: NO se espera — el próximo tick claimea
    // aunque un handler siga corriendo (concurrencia intencional).
    worker.tick().catch((err) => {
      console.error('[JobQueueWorker] Error en el tick:', err);
    });
  }, pollMs);
  console.log(`[JobQueueWorker] Inicializado — claim cada ${pollMs} ms`);
}

export function stopJobQueueWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
