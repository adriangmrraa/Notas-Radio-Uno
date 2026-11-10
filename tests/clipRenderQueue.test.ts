/**
 * Tests del slice PF-04: cola de render de clips — `clipRenderQueueService`
 * (store) + `clipRenderWorker` (loop de dispatch) sobre
 * `memoryRenderJobsStore`.
 *
 * Deterministas: sin DB real (store en memoria con los MISMOS filtros por
 * tenant que el drizzle), sin ffmpeg (el `cutRawWindow` fake devuelve un clip
 * o tira a pedido), sin timers (`now`/`backoffMs` inyectados y `worker.tick()`
 * se llama a mano) y sin sockets (io fake que registra emits).
 *
 * Casos obligatorios del brief:
 *   1. enqueue → claimNext devuelve job (running, attempts=1).
 *   2. claimNext respeta run_at futuro.
 *   3. markFailed con attempts < max → 'pending' con run_at=retryAt.
 *   4. markFailed con attempts = max → 'error' terminal.
 *   5. retry() manual desde 'error' → 'pending', attempts 0.
 *   6. tick con cutRawWindow fake → markDone con clipId rellenado.
 *   7. tick con cutter que tira → markFailed + backoff lineal.
 *   8. Aislamiento por tenant en getById/listByClip/retry.
 *   9. cancel + listPending.
 * Extras: kind desconocido → terminal sin reintento, orden del claim por
 * run_at, eventos io (done siempre / error sólo terminal), guard de un solo
 * worker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock parcial del módulo DB (importarlo crea un Pool Neon y pediría
// DATABASE_URL): se preserva el resto de exports y se reemplaza `db`.
vi.mock('../src/server/db/index.js', async (io) => ({
  ...(await io()),
  db: {},
}));

import {
  createClipRenderWorker,
  initClipRenderWorker,
  stopClipRenderWorker,
  type RenderWorkerIo,
} from '../src/server/services/clipRenderWorker';
import type { CutRawWindowInput } from '../src/server/services/clipCutterService';
import type { ClipRenderJob } from '../src/server/services/clipRenderQueueService';
import { createMemoryRenderJobsStore } from './helpers/memoryRenderJobsStore';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const CLIP_X = '33333333-3333-4333-8333-333333333333';
const T0 = new Date('2026-11-09T12:00:00.000Z');

const CUT_PAYLOAD = { transmissionId: 'tx-1', startMs: 0, endMs: 5_000 };

/**
 * Store en memoria con reloj fijado en T0: los `run_at` defaultNow del
 * enqueue y los timestamps de transición quedan deterministas (los jobs son
 * reclaimeables en T0 inmediatamente tras encolarlos).
 */
function makeStore(opts?: {
  jobs?: Array<Partial<ClipRenderJob> & { tenantId: string; kind: string }>;
}) {
  return createMemoryRenderJobsStore({ ...opts, now: () => T0 });
}

afterEach(() => {
  stopClipRenderWorker();
  vi.restoreAllMocks();
});

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** io fake: registra {room, event, payload} de cada emit. */
function makeFakeIo() {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io: RenderWorkerIo = {
    to: (room) => ({
      emit: (event, payload) => {
        emitted.push({ room, event, payload });
        return true;
      },
    }),
  };
  return { io, emitted };
}

// ─── Store: enqueue + claim ─────────────────────────────────────────────────

describe('clipRenderQueueStore', () => {
  it('enqueue → job pending con defaults; claimNext lo pasa a running con attempts=1', async () => {
    const { store } = makeStore();

    const job = await store.enqueue({
      tenantId: TENANT_A,
      kind: 'cut',
      payload: CUT_PAYLOAD,
    });
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.payload).toEqual(CUT_PAYLOAD);
    expect(job.clipId).toBeNull();

    const claimed = await store.claimNext(T0);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe('running');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.startedAt).toEqual(T0);

    // Ya claimeado: el siguiente claim no lo vuelve a tomar.
    expect(await store.claimNext(T0)).toBeNull();
  });

  it('claimNext respeta run_at futuro y ordena por run_at', async () => {
    const { store, state } = makeStore();
    const future = new Date(T0.getTime() + 60_000);

    const late = await store.enqueue({
      tenantId: TENANT_A,
      kind: 'cut',
      payload: {},
    });
    state.jobs.find((j) => j.id === late.id)!.runAt = future;

    // No venció → no se claimea.
    expect(await store.claimNext(T0)).toBeNull();

    // Con dos vencidos gana el de run_at menor (aunque se encoló después).
    const early = await store.enqueue({
      tenantId: TENANT_A,
      kind: 'cut',
      payload: {},
    });
    state.jobs.find((j) => j.id === early.id)!.runAt = new Date(
      T0.getTime() - 5_000,
    );

    const first = await store.claimNext(future);
    expect(first!.id).toBe(early.id);
    const second = await store.claimNext(future);
    expect(second!.id).toBe(late.id);
  });

  it('claimNext es global (excepción documentada): claimea jobs de cualquier tenant', async () => {
    const { store } = makeStore({
      jobs: [{ tenantId: TENANT_B, kind: 'cut', payload: CUT_PAYLOAD }],
    });
    const claimed = await store.claimNext(T0);
    expect(claimed).not.toBeNull();
    expect(claimed!.tenantId).toBe(TENANT_B);
  });
});

// ─── Store: markFailed / retry / cancel / listPending ───────────────────────

describe('markFailed', () => {
  it('attempts < max → vuelve a pending con run_at=retryAt y last_error', async () => {
    const { store, state } = makeStore();
    const job = await store.enqueue({
      tenantId: TENANT_A,
      kind: 'cut',
      payload: {},
    });
    await store.claimNext(T0); // attempts=1 < max=3

    const retryAt = new Date(T0.getTime() + 60_000);
    const updated = await store.markFailed(job.id, 'ffmpeg boom', { retryAt });

    expect(updated!.status).toBe('pending');
    expect(updated!.runAt).toEqual(retryAt);
    expect(updated!.lastError).toBe('ffmpeg boom');
    expect(updated!.finishedAt).toBeNull();

    // El reintento queda reclaimeable cuando vence run_at.
    state.jobs[0].runAt = new Date(T0.getTime() - 1);
    const reclaimed = await store.claimNext(T0);
    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(2);
  });

  it('attempts = max → error terminal con finished_at', async () => {
    const { store, state } = makeStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'cut',
          status: 'running',
          attempts: 3,
          maxAttempts: 3,
        },
      ],
    });
    const job = state.jobs[0];

    const updated = await store.markFailed(job.id, 'último intento falló');
    expect(updated!.status).toBe('error');
    expect(updated!.lastError).toBe('último intento falló');
    expect(updated!.finishedAt).not.toBeNull();

    // Terminal: el claim no lo toca.
    expect(await store.claimNext(T0)).toBeNull();
  });

  it('retry:false → error terminal aunque queden attempts (kind desconocido)', async () => {
    const { store, state } = makeStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'reframe',
          status: 'running',
          attempts: 1,
          maxAttempts: 3,
        },
      ],
    });
    const updated = await store.markFailed(
      state.jobs[0].id,
      'unknown render job kind: reframe',
      { retry: false },
    );
    expect(updated!.status).toBe('error');
    expect(updated!.finishedAt).not.toBeNull();
  });
});

describe('retry y cancel (tenant-scoped)', () => {
  it('retry desde error → pending, attempts 0, last_error null, started/finished limpios', async () => {
    const { store, state } = makeStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'cut',
          status: 'error',
          attempts: 3,
          lastError: 'boom',
          startedAt: T0,
          finishedAt: T0,
        },
      ],
    });
    const job = state.jobs[0];

    const retried = await store.retry(job.id, TENANT_A);
    expect(retried).not.toBeNull();
    expect(retried!.status).toBe('pending');
    expect(retried!.attempts).toBe(0);
    expect(retried!.lastError).toBeNull();
    expect(retried!.startedAt).toBeNull();
    expect(retried!.finishedAt).toBeNull();

    // Y vuelve a ser reclaimeable.
    const claimed = await store.claimNext(T0);
    expect(claimed!.id).toBe(job.id);
  });

  it('retry desde cancelled también reabre; desde running/done es no-op', async () => {
    const { store, state } = makeStore({
      jobs: [
        { id: 'j-cancelled', tenantId: TENANT_A, kind: 'cut', status: 'cancelled', attempts: 1 },
        { id: 'j-running', tenantId: TENANT_A, kind: 'cut', status: 'running', attempts: 1 },
        { id: 'j-done', tenantId: TENANT_A, kind: 'cut', status: 'done', attempts: 1 },
      ],
    });
    const cancelled = await store.retry('j-cancelled', TENANT_A);
    expect(cancelled!.status).toBe('pending');
    expect(await store.retry('j-running', TENANT_A)).toBeNull();
    expect(await store.retry('j-done', TENANT_A)).toBeNull();
    expect(state.jobs.find((j) => j.id === 'j-done')!.status).toBe('done');
  });

  it('cancel desde pending/running → cancelled; desde estados terminales es no-op', async () => {
    const { store, state } = makeStore({
      jobs: [
        { id: 'j-p', tenantId: TENANT_A, kind: 'cut', status: 'pending' },
        { id: 'j-r', tenantId: TENANT_A, kind: 'cut', status: 'running' },
        { id: 'j-e', tenantId: TENANT_A, kind: 'cut', status: 'error' },
      ],
    });
    expect((await store.cancel('j-p', TENANT_A))!.status).toBe('cancelled');
    expect((await store.cancel('j-r', TENANT_A))!.status).toBe('cancelled');
    expect(state.jobs.find((j) => j.id === 'j-p')!.finishedAt).not.toBeNull();
    expect(await store.cancel('j-e', TENANT_A)).toBeNull();
    expect(state.jobs.find((j) => j.id === 'j-e')!.status).toBe('error');
  });

  it('listPending filtra por status y opcionalmente por tenant', async () => {
    const { store } = makeStore({
      jobs: [
        { id: 'a1', tenantId: TENANT_A, kind: 'cut', status: 'pending' },
        { id: 'a2', tenantId: TENANT_A, kind: 'cut', status: 'running' },
        { id: 'b1', tenantId: TENANT_B, kind: 'cut', status: 'pending' },
      ],
    });
    expect((await store.listPending(TENANT_A)).map((j) => j.id)).toEqual(['a1']);
    expect((await store.listPending()).map((j) => j.id).sort()).toEqual([
      'a1',
      'b1',
    ]);
  });
});

describe('aislamiento por tenant', () => {
  it('getById/listByClip/retry/cancel con tenant ajeno → null / no-op', async () => {
    const { store, state } = makeStore({
      jobs: [
        {
          id: 'j-a',
          tenantId: TENANT_A,
          kind: 'cut',
          status: 'error',
          clipId: CLIP_X,
          attempts: 3,
        },
      ],
    });

    // El job existe pero NO para TENANT_B — igual que el WHERE tenant_id.
    expect(await store.getById('j-a', TENANT_B)).toBeNull();
    expect(await store.listByClip(CLIP_X, TENANT_B)).toEqual([]);
    expect(await store.retry('j-a', TENANT_B)).toBeNull();
    expect(await store.cancel('j-a', TENANT_B)).toBeNull();
    expect(state.jobs[0].status).toBe('error'); // no lo tocó

    // Con su tenant sí.
    expect((await store.getById('j-a', TENANT_A))!.id).toBe('j-a');
    expect((await store.listByClip(CLIP_X, TENANT_A))[0].id).toBe('j-a');
    expect((await store.retry('j-a', TENANT_A))!.status).toBe('pending');
  });
});

// ─── Worker ─────────────────────────────────────────────────────────────────

describe('clipRenderWorker', () => {
  it('tick con cutRawWindow fake → markDone rellena clipId y emite clip:render:done', async () => {
    const { store, state } = makeStore();
    const { io, emitted } = makeFakeIo();
    const cutCalls: CutRawWindowInput[] = [];

    await store.enqueue({
      tenantId: TENANT_A,
      kind: 'cut',
      payload: CUT_PAYLOAD,
    });

    const worker = createClipRenderWorker(
      {
        store,
        now: () => T0,
        cutRawWindow: async (input) => {
          cutCalls.push(input);
          return {
            clipId: CLIP_X,
            videoPath: '/out/clip.mp4',
            durationSec: 5,
            segmentsUsed: 1,
          };
        },
      },
      io,
    );

    await worker.tick();

    // El dispatch recibió tenantId del job + el payload tal cual.
    expect(cutCalls).toEqual([
      { tenantId: TENANT_A, transmissionId: 'tx-1', startMs: 0, endMs: 5_000 },
    ]);

    const job = state.jobs[0];
    expect(job.status).toBe('done');
    expect(job.clipId).toBe(CLIP_X); // el worker rellena la FK nullable
    expect(job.finishedAt).not.toBeNull();

    expect(emitted).toEqual([
      {
        room: `tenant:${TENANT_A}`,
        event: 'clip:render:done',
        payload: expect.objectContaining({ jobId: job.id, clipId: CLIP_X }),
      },
    ]);
  });

  it('tick con cutter que tira → markFailed con backoff lineal (run_at = now + attempts*60s)', async () => {
    const { store, state } = makeStore({
      jobs: [{ tenantId: TENANT_A, kind: 'cut', payload: CUT_PAYLOAD, maxAttempts: 3 }],
    });
    const { io, emitted } = makeFakeIo();
    const backoffCalls: number[] = [];

    const worker = createClipRenderWorker(
      {
        store,
        now: () => T0,
        backoffMs: (attempts) => {
          backoffCalls.push(attempts);
          return attempts * 60_000;
        },
        cutRawWindow: async () => {
          throw new Error('ffmpeg salió con código 1');
        },
      },
      io,
    );

    await worker.tick();

    const job = state.jobs[0];
    // attempts=1 tras el claim → backoff de 1 min → vuelve a pending.
    expect(backoffCalls).toEqual([1]);
    expect(job.status).toBe('pending');
    expect(job.lastError).toBe('ffmpeg salió con código 1');
    expect(job.runAt.getTime()).toBe(T0.getTime() + 60_000);

    // Fallo retriable: NO se emite clip:render:error (el job sigue en vuelo).
    expect(emitted.filter((e) => e.event === 'clip:render:error')).toEqual([]);
  });

  it('último intento fallido → error terminal + clip:render:error al tenant', async () => {
    const { store, state } = makeStore({
      jobs: [{ tenantId: TENANT_A, kind: 'cut', payload: CUT_PAYLOAD, maxAttempts: 1 }],
    });
    const { io, emitted } = makeFakeIo();

    const worker = createClipRenderWorker(
      {
        store,
        now: () => T0,
        cutRawWindow: async () => {
          throw new Error('boom terminal');
        },
      },
      io,
    );

    await worker.tick(); // claim → attempts=1 = maxAttempts → falla terminal

    const job = state.jobs[0];
    expect(job.status).toBe('error');
    expect(job.finishedAt).not.toBeNull();

    expect(emitted).toEqual([
      {
        room: `tenant:${TENANT_A}`,
        event: 'clip:render:error',
        payload: expect.objectContaining({
          jobId: job.id,
          error: 'boom terminal',
          attempts: 1,
          maxAttempts: 1,
        }),
      },
    ]);
  });

  it('kind desconocido → error terminal sin llamar al cutter ni reintentar', async () => {
    const { store, state } = makeStore({
      jobs: [{ tenantId: TENANT_A, kind: 'reframe', payload: {}, maxAttempts: 3 }],
    });
    const { io, emitted } = makeFakeIo();
    const cutCalls: CutRawWindowInput[] = [];

    const worker = createClipRenderWorker(
      {
        store,
        now: () => T0,
        cutRawWindow: async (input) => {
          cutCalls.push(input);
          return { clipId: 'x', videoPath: '', durationSec: 0, segmentsUsed: 0 };
        },
      },
      io,
    );

    await worker.tick();

    expect(cutCalls).toEqual([]); // nunca despachó
    const job = state.jobs[0];
    expect(job.status).toBe('error'); // terminal directo, attempts quedaban
    expect(job.lastError).toContain('unknown render job kind');
    expect(emitted.some((e) => e.event === 'clip:render:error')).toBe(true);
  });

  it('cola vacía → tick no hace nada', async () => {
    const { store } = makeStore();
    const cutCalls: CutRawWindowInput[] = [];
    const worker = createClipRenderWorker({
      store,
      now: () => T0,
      cutRawWindow: async (i) => {
        cutCalls.push(i);
        return { clipId: 'x', videoPath: '', durationSec: 0, segmentsUsed: 0 };
      },
    });
    await worker.tick();
    expect(cutCalls).toEqual([]);
  });

  it('initClipRenderWorker tiene guard de una sola instancia por proceso', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store } = makeStore();

    initClipRenderWorker(undefined, { store });
    initClipRenderWorker(undefined, { store }); // segunda llamada → ignorada

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Ya inicializado'),
    );
    stopClipRenderWorker(); // el intervalo real queda limpio (afterEach también)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('claim cada'),
    );
  });
});
