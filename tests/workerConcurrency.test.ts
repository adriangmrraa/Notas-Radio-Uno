/**
 * Tests del slice PJ-04 (Épica J): concurrencia controlada.
 *
 *   1. `envInt` — parseo de env vars enteras (válida, ausente, inválida,
 *      <= 0, float → floor).
 *   2. `parseProcessRole` / `isWorkerRole` — roles api|worker|all, default
 *      all ante valor ausente/inválido (fail-open documentado).
 *   3. Semáforos `maxInFlight` en los tres workers de colas:
 *      - cap lleno ⇒ el tick NO claimea (el job queda pending).
 *      - el dispatch que termina (OK o error) libera el slot.
 *      - cap también puede llegar por env (RENDER_MAX_IN_FLIGHT).
 *      - jobQueueWorker: el cap es por PROCESO — cruza tenants.
 *
 * Deterministas: stores en memoria, dispatches colgados con deferreds que el
 * test resuelve/rechaza a mano, `now` inyectado, sin timers ni sockets.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Misma guardia que el resto de tests: el módulo db crea un Pool Neon.
vi.mock('../src/server/db/index.js', async (io) => ({
  ...(await io()),
  db: {},
}));

import { envInt } from '../src/server/lib/envInt';
import {
  isWorkerRole,
  parseProcessRole,
} from '../src/server/lib/processRole';
import {
  createClipRenderWorker,
} from '../src/server/services/clipRenderWorker';
import {
  createPublishWorker,
} from '../src/server/services/publishWorker';
import {
  createJobQueueWorker,
} from '../src/server/services/jobQueueWorker';
import { createMemoryRenderJobsStore } from './helpers/memoryRenderJobsStore';
import { createMemoryPublishJobStore } from './helpers/memoryPublishJobStore';
import { createMemoryJobQueueStore } from './helpers/memoryJobQueueStore';

const T_A = '00000000-0000-4000-8000-00000000000a';
const T_B = '00000000-0000-4000-8000-00000000000b';
const T0 = new Date('2026-11-17T12:00:00.000Z');

const ENV_KEYS = [
  'RENDER_MAX_IN_FLIGHT',
  'PUBLISH_MAX_IN_FLIGHT',
  'JOB_QUEUE_MAX_IN_FLIGHT',
  'MAX_CONCURRENT_TRANSMISSIONS',
  'PROCESS_ROLE',
  'TEST_INT_VAR',
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush de microtasks + una macrotarea: deja correr claim→dispatch. */
const flush = () => new Promise((r) => setImmediate(r));

// ─── envInt ─────────────────────────────────────────────────────────────────

describe('envInt', () => {
  it('devuelve el default cuando la var no existe', () => {
    expect(envInt('TEST_INT_VAR', 7)).toBe(7);
  });

  it('parsea un entero válido', () => {
    process.env.TEST_INT_VAR = '4';
    expect(envInt('TEST_INT_VAR', 7)).toBe(4);
  });

  it('float → floor', () => {
    process.env.TEST_INT_VAR = '3.9';
    expect(envInt('TEST_INT_VAR', 7)).toBe(3);
  });

  it('inválida / cero / negativa / vacía → default (nunca NaN ni 0)', () => {
    for (const bad of ['abc', '0', '-2', '']) {
      process.env.TEST_INT_VAR = bad;
      expect(envInt('TEST_INT_VAR', 7)).toBe(7);
    }
  });
});

// ─── PROCESS_ROLE ───────────────────────────────────────────────────────────

describe('parseProcessRole / isWorkerRole', () => {
  it('roles válidos', () => {
    expect(parseProcessRole('api')).toBe('api');
    expect(parseProcessRole('worker')).toBe('worker');
    expect(parseProcessRole('all')).toBe('all');
  });

  it('normaliza case y espacios', () => {
    expect(parseProcessRole('  API ')).toBe('api');
    expect(parseProcessRole('Worker')).toBe('worker');
  });

  it('ausente o inválido → all (fail-open documentado)', () => {
    expect(parseProcessRole(undefined)).toBe('all');
    expect(parseProcessRole('')).toBe('all');
    expect(parseProcessRole('banana')).toBe('all');
  });

  it('isWorkerRole: sólo api excluye workers', () => {
    expect(isWorkerRole('api')).toBe(false);
    expect(isWorkerRole('worker')).toBe(true);
    expect(isWorkerRole('all')).toBe(true);
  });
});

// ─── clipRenderWorker: semáforo ─────────────────────────────────────────────

describe('clipRenderWorker — semáforo maxInFlight', () => {
  it('cap lleno ⇒ el tick no claimea; al terminar libera el slot', async () => {
    const gate = deferred<{ clipId: string; videoPath: string; durationSec: number }>();
    const cutRawWindow = vi.fn(() => gate.promise);
    const { store, state } = createMemoryRenderJobsStore({
      now: () => T0,
      jobs: [
        { tenantId: T_A, kind: 'cut', payload: { transmissionId: 'tx-1', startMs: 0, endMs: 1000 } },
        { tenantId: T_A, kind: 'cut', payload: { transmissionId: 'tx-2', startMs: 0, endMs: 1000 } },
      ],
    });
    const worker = createClipRenderWorker({
      store,
      maxInFlight: 1,
      cutRawWindow,
      now: () => T0,
    });

    // Tick 1: claimea job-1 y queda colgado en el render.
    const t1 = worker.tick();
    await flush();
    expect(worker.inFlight()).toBe(1);
    expect(state.jobs[0].status).toBe('running');

    // Tick 2 con cap lleno: NO claimea — job-2 sigue pending.
    await worker.tick();
    expect(cutRawWindow).toHaveBeenCalledTimes(1);
    expect(state.jobs[1].status).toBe('pending');

    // El render termina → libera → el siguiente tick claimea job-2.
    gate.resolve({ clipId: 'clip-1', videoPath: '/v.mp4', durationSec: 1 });
    await t1;
    expect(worker.inFlight()).toBe(0);
    expect(state.jobs[0].status).toBe('done');

    const gate2 = deferred<{ clipId: string; videoPath: string; durationSec: number }>();
    cutRawWindow.mockImplementation(() => gate2.promise);
    const t3 = worker.tick();
    await flush();
    expect(cutRawWindow).toHaveBeenCalledTimes(2);
    expect(state.jobs[1].status).toBe('running');
    gate2.resolve({ clipId: 'clip-2', videoPath: '/v2.mp4', durationSec: 1 });
    await t3;
  });

  it('un dispatch que FALLA también libera el slot', async () => {
    const gate = deferred<never>();
    const cutRawWindow = vi.fn(() => gate.promise);
    const { store, state } = createMemoryRenderJobsStore({
      now: () => T0,
      jobs: [{ tenantId: T_A, kind: 'cut', payload: {} }],
    });
    const worker = createClipRenderWorker({
      store,
      maxInFlight: 1,
      cutRawWindow,
      now: () => T0,
      backoffMs: () => 60_000,
    });

    const t1 = worker.tick();
    await flush();
    expect(worker.inFlight()).toBe(1);
    gate.reject(new Error('ffmpeg explotó'));
    await t1;
    expect(worker.inFlight()).toBe(0);
    // Falló → pending con retry (no terminal en attempt 1).
    expect(state.jobs[0].status).toBe('pending');
  });

  it('el cap puede venir de la env RENDER_MAX_IN_FLIGHT', async () => {
    process.env.RENDER_MAX_IN_FLIGHT = '1';
    const gate = deferred<{ clipId: string; videoPath: string; durationSec: number }>();
    const { store, state } = createMemoryRenderJobsStore({
      now: () => T0,
      jobs: [
        { tenantId: T_A, kind: 'cut', payload: {} },
        { tenantId: T_A, kind: 'cut', payload: {} },
      ],
    });
    const worker = createClipRenderWorker({
      store,
      cutRawWindow: () => gate.promise,
      now: () => T0,
    });

    const t1 = worker.tick();
    await flush();
    await worker.tick(); // cap=1 desde env → no claimea el segundo
    expect(state.jobs[1].status).toBe('pending');
    gate.resolve({ clipId: 'c', videoPath: '/v', durationSec: 1 });
    await t1;
  });
});

// ─── publishWorker: semáforo ────────────────────────────────────────────────

describe('publishWorker — semáforo maxInFlight', () => {
  const jobSeed = (suffix: string) => ({
    tenantId: T_A,
    platform: 'instagram',
    accountId: 'acc-1',
    idempotencyKey: `idem-${suffix}`,
    content: 'post',
  });

  it('cap lleno ⇒ el tick no claimea; al terminar libera', async () => {
    const gate1 = deferred<never>();
    const gate2 = deferred<never>();
    const gates = [gate1, gate2];
    const publishPost = vi.fn((() => gates.shift()!.promise) as () => Promise<never>);
    const { store, state } = createMemoryPublishJobStore({
      now: () => T0,
      jobs: [jobSeed('1'), jobSeed('2')],
    });
    const worker = createPublishWorker({
      store,
      maxInFlight: 1,
      zernio: { publishPost, retryPost: vi.fn() },
      getZernioProfile: async () => ({ profileId: 'zprof-1' }),
      now: () => T0,
    });

    const t1 = worker.tick();
    await flush();
    expect(worker.inFlight()).toBe(1);
    expect(state.jobs[0].status).toBe('publishing');

    await worker.tick();
    expect(publishPost).toHaveBeenCalledTimes(1);
    expect(state.jobs[1].status).toBe('queued');

    // Error de Zernio → libera el slot igual.
    gate1.reject(new Error('zernio 500'));
    await t1;
    expect(worker.inFlight()).toBe(0);

    const t3 = worker.tick();
    await flush();
    expect(publishPost).toHaveBeenCalledTimes(2);
    expect(state.jobs[1].status).toBe('publishing');
    gate2.reject(new Error('cleanup'));
    await t3;
    expect(worker.inFlight()).toBe(0);
  });
});

// ─── jobQueueWorker: semáforo por proceso (cruza tenants) ───────────────────

describe('jobQueueWorker — semáforo maxInFlight (por proceso)', () => {
  it('cap lleno ⇒ corta el loop de tenants sin claimear; al liberar sigue', async () => {
    const gate = deferred<unknown>();
    const handler = vi.fn(() => gate.promise);
    const { store, state } = createMemoryJobQueueStore({
      now: () => T0,
      jobs: [
        { tenantId: T_A, kind: 'retention.purge' },
        { tenantId: T_B, kind: 'retention.purge' },
      ],
    });
    const worker = createJobQueueWorker({
      store,
      maxInFlight: 1,
      listTenantIds: async () => [T_A, T_B],
      handlers: new Map([['retention.purge', handler]]),
      now: () => T0,
    });

    // Tick 1: claimea el job del tenant A y cuelga en el handler — el loop
    // interno ni llega al tenant B mientras el dispatch está en vuelo.
    const t1 = worker.tick();
    await flush();
    expect(worker.inFlight()).toBe(1);
    expect(state.jobs[0].status).toBe('running');
    expect(state.jobs[1].status).toBe('pending');

    // Tick 2 con cap lleno: early-return antes de iterar tenants.
    await worker.tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(state.jobs[1].status).toBe('pending');

    // El handler termina → el MISMO tick 1 continúa y claimea el job de B
    // (el cap permite un nuevo claim porque el slot se liberó).
    gate.resolve(undefined);
    await t1;
    expect(worker.inFlight()).toBe(0);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(state.jobs[1].status).toBe('succeeded');
  });
});
