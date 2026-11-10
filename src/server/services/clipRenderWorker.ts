/**
 * clipRenderWorker — loop de dispatch de la cola `clip_render_jobs` (PF-04).
 *
 * Cada `POLL_MS` (default 10 s, env `RENDER_WORKER_POLL_MS`) un tick claimea
 * UN job vía `store.claimNext(now)` y lo despacha según `kind`:
 *
 *   - 'cut' → `clipCutterService.cutRawWindow({ tenantId, ...payload })`
 *     (`payload = { transmissionId, startMs, endMs }`). Éxito →
 *     `markDone(jobId, { clipId })` — el clip lo creó el cutter durante el
 *     render y acá se rellena la FK nullable del job.
 *   - kind desconocido → `markFailed(jobId, 'unknown kind', { retry: false })`
 *     directo a `error` terminal: reintentar lo que nadie sabe despachar es
 *     gastar attempts al pedo.
 *
 * Un error del render → `markFailed(jobId, msg, { retryAt })` con backoff
 * LINEAL de 1 min por intento (`retryAt = now + attempts * 60_000`; el claim
 * ya incrementó `attempts`, así que el primer fallo espera 1 min, el segundo
 * 2, etc.). `markFailed` decide si vuelve a `pending` o queda `error`
 * terminal (`attempts >= max_attempts`).
 *
 * Fire-and-forget: el intervalo NO espera el tick — un render largo no
 * bloquea el claim del próximo tick (varios jobs pueden estar `running` en
 * paralelo; el claim atómico garantiza que nunca dos workers agarren el mismo
 * job). En tests se llama `worker.tick()` con await → determinista.
 *
 * `io` es opcional: presente → emite por room `tenant:{tenantId}` (mismo
 * contrato que transmission:moments / liveAlerts):
 *   - `clip:render:done`  — siempre que un job termina OK.
 *   - `clip:render:error` — SOLO cuando el job queda `error` TERMINAL (un
 *     fallo que vuelve a `pending` para reintentar no es error de cara a la
 *     UI; el job sigue en vuelo).
 *
 * Un solo worker por proceso: `initClipRenderWorker` ignora la segunda
 * llamada (guard) y `stopClipRenderWorker` limpia para tests.
 *
 * Dependencias inyectables: `{ store, cutRawWindow, now, backoffMs }` con
 * defaults reales — los tests corren sin DB, sin ffmpeg y sin timers.
 */
import type { Server } from 'socket.io';

import {
  createDrizzleClipRenderQueueStore,
  type ClipRenderJob,
  type ClipRenderQueueStore,
} from './clipRenderQueueService.js';
import {
  clipCutterService,
  type CutRawWindowInput,
  type CutRawWindowResult,
} from './clipCutterService.js';

/** Intervalo de claim por default: 10 s (env `RENDER_WORKER_POLL_MS`). */
export const POLL_MS = 10_000;
/** Backoff lineal: `attempts * 60_000` ms (1 min por intento). */
export const BACKOFF_STEP_MS = 60_000;

// ---------------------------------------------------------------------------
// Dependencias inyectables
// ---------------------------------------------------------------------------

/**
 * Subconjunto estructural de `socket.io.Server` que el worker necesita.
 * `Server` lo satisface; los tests pasan un fake sin levantar sockets.
 */
export interface RenderWorkerIo {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

export interface ClipRenderWorkerDeps {
  store?: ClipRenderQueueStore;
  /** Default: `clipCutterService.cutRawWindow` (PF-01, ffmpeg real). */
  cutRawWindow?: (input: CutRawWindowInput) => Promise<CutRawWindowResult>;
  now?: () => Date;
  /** Backoff en ms según el nº de intento ya consumido. Default lineal 1min. */
  backoffMs?: (attempts: number) => number;
}

interface ResolvedWorkerDeps {
  store: ClipRenderQueueStore;
  cutRawWindow: (input: CutRawWindowInput) => Promise<CutRawWindowResult>;
  now: () => Date;
  backoffMs: (attempts: number) => number;
}

function resolveDeps(deps: ClipRenderWorkerDeps): ResolvedWorkerDeps {
  return {
    store: deps.store ?? createDrizzleClipRenderQueueStore(),
    cutRawWindow:
      deps.cutRawWindow ?? ((input) => clipCutterService.cutRawWindow(input)),
    now: deps.now ?? (() => new Date()),
    backoffMs: deps.backoffMs ?? ((attempts) => attempts * BACKOFF_STEP_MS),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitToTenant(
  io: RenderWorkerIo | undefined,
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!io) return;
  try {
    io.to(`tenant:${tenantId}`).emit(event, payload);
  } catch (err) {
    console.error(`[ClipRenderWorker] emit ${event} falló:`, errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface ClipRenderWorker {
  /**
   * Un tick: claim de UN job + dispatch. Resuelve cuando el job claimeado
   * terminó (done/error/pending-retry) — el `init` lo llama fire-and-forget
   * así un render no bloquea el claim del siguiente tick; los tests lo
   * esperan con await.
   */
  tick(): Promise<void>;
}

export function createClipRenderWorker(
  deps: ClipRenderWorkerDeps = {},
  io?: RenderWorkerIo,
): ClipRenderWorker {
  const resolved = resolveDeps(deps);
  const { store, now } = resolved;

  async function dispatch(job: ClipRenderJob): Promise<void> {
    if (job.kind !== 'cut') {
      // Kind desconocido → terminal sin reintento (retry:false). PF-02/03
      // agregarán 'reframe'/'subtitles' a este switch.
      const updated = await store.markFailed(
        job.id,
        `unknown render job kind: ${job.kind}`,
        { retry: false },
      );
      if (updated?.status === 'error') {
        emitToTenant(io, job.tenantId, 'clip:render:error', {
          jobId: job.id,
          clipId: job.clipId,
          kind: job.kind,
          error: updated.lastError,
          attempts: updated.attempts,
          maxAttempts: updated.maxAttempts,
        });
      }
      return;
    }

    try {
      const result = await resolved.cutRawWindow({
        tenantId: job.tenantId,
        ...job.payload,
      } as CutRawWindowInput);
      await store.markDone(job.id, { clipId: result.clipId });
      emitToTenant(io, job.tenantId, 'clip:render:done', {
        jobId: job.id,
        clipId: result.clipId,
        kind: job.kind,
        videoPath: result.videoPath,
        durationSec: result.durationSec,
      });
    } catch (err) {
      const retryAt = new Date(now().getTime() + resolved.backoffMs(job.attempts));
      const updated = await store.markFailed(job.id, errorMessage(err), {
        retryAt,
      });
      if (updated?.status === 'error') {
        emitToTenant(io, job.tenantId, 'clip:render:error', {
          jobId: job.id,
          clipId: job.clipId,
          kind: job.kind,
          error: updated.lastError,
          attempts: updated.attempts,
          maxAttempts: updated.maxAttempts,
        });
      }
    }
  }

  return {
    async tick() {
      const job = await store.claimNext(now());
      if (!job) return;
      await dispatch(job);
    },
  };
}

// ---------------------------------------------------------------------------
// Init / stop (un solo worker por proceso)
// ---------------------------------------------------------------------------

let workerInterval: ReturnType<typeof setInterval> | null = null;

function resolvePollMs(): number {
  const raw = Number(process.env.RENDER_WORKER_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : POLL_MS;
}

/**
 * Inicializa el worker de render (patrón `initJobScheduler`). Guard de una
 * sola instancia: una segunda llamada se ignora con warning — para rearmar
 * con otras deps hay que pasar por `stopClipRenderWorker` primero.
 */
export function initClipRenderWorker(
  io?: Server,
  deps: ClipRenderWorkerDeps = {},
): void {
  if (workerInterval) {
    console.warn(
      '[ClipRenderWorker] Ya inicializado — se ignora la segunda llamada',
    );
    return;
  }
  const worker = createClipRenderWorker(deps, io);
  const pollMs = resolvePollMs();
  workerInterval = setInterval(() => {
    // Fire-and-forget por tick: NO se espera — el próximo tick claimea aunque
    // este job siga renderizando (concurrencia intencional).
    worker.tick().catch((err) => {
      console.error('[ClipRenderWorker] Error en el tick:', err);
    });
  }, pollMs);
  console.log(`[ClipRenderWorker] Inicializado — claim cada ${pollMs} ms`);
}

export function stopClipRenderWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
