/**
 * Tests del slice PD-03: `transmissionSchedulerService.ts`.
 *
 * Deterministas: sin DB real, sin red, sin timers reales. El `now` es
 * inyectado y cada `checkAndRunScheduledTransmissions` es UN tick — el test
 * avanza el reloj a mano entre llamadas. El detector de live, el recorder,
 * el gate de suscripción, la cuota y el store son mocks/fakes (store en
 * memoria con los mismos filtros por tenant que el drizzle). Los cambios de
 * `transmissions.status` van por `createMemoryTransitionRunner` — la FSM
 * REAL validando aristas y emitiendo eventos al fake `onEmit`, igual que
 * `transitionTransmission` hace post-commit en prod.
 *
 * Casos obligatorios del brief:
 *   1. Stream al aire → live + startRecording con el tenantId correcto.
 *   2. AC: stream 10 min tarde → sigue `waiting` (no error) y al detectar
 *      pasa a `live` + grabación. ← el AC del slice.
 *   3. Ventana agotada → `error` con mensaje de la ventana de espera.
 *   4. Idempotencia → no duplica la corrida abierta.
 *   5. is_active=false / auto_start=false → no se dispara.
 *   6. next_run_at avanza con nextOccurrence; puntual (COUNT=1) → null.
 *   7. tenant_id de la corrida = tenant de la agenda.
 *   8. maxConcurrent alcanzado → queda `waiting` (no se descarta ni erra).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';

// Mock parcial del módulo DB (importarlo crea un Pool Neon y pediría
// DATABASE_URL): se preserva el resto de exports y se reemplaza `db`.
vi.mock('../src/server/db/index.js', async (io) => ({
  ...(await io()),
  db: {},
}));

import { nextOccurrence } from '../src/server/lib/rrule';
import {
  checkAndRunScheduledTransmissions,
  decideOrphanRecovery,
  initTransmissionScheduler,
  reconcileOrphanedRuns,
  stopTransmissionScheduler,
  type DispatchGateResult,
  type TransmissionSchedulerDeps,
} from '../src/server/services/transmissionSchedulerService';
import type { notify } from '../src/server/services/notificationService';
import type { LiveDetectionResult } from '../src/server/services/liveDetectorService';
import type {
  RecordingHandle,
  RecordingOutcome,
  StartRecordingOptions,
} from '../src/server/services/streamRecorderService';
import type { ConsumeResult } from '../src/server/services/transmissionMeteringService';
import {
  createMemorySchedulerStore,
  type MemoryRun,
  type MemoryScheduled,
} from './helpers/memorySchedulerStore';
import { createMemoryTransitionRunner } from './helpers/memoryTransitionRunner';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09 12:00 UTC

const MIN = 60_000;
const RETRY = 2 * MIN;
const WINDOW_MIN = 30;

// ─── Fakes ──────────────────────────────────────────────────────────────────

const det = (found: boolean): LiveDetectionResult => ({
  found,
  liveUrl: found ? 'https://cdn.example.com/live.m3u8' : null,
  title: found ? 'Show en vivo' : null,
  platform: 'youtube',
  error: found ? null : 'No hay live activo',
});

/** found:false durante `liveAfter` llamadas; found:true desde la siguiente. */
const seqDetector = (liveAfter: number) => {
  let calls = 0;
  return async () => det(++calls > liveAfter);
};

function makeScheduled(over: Partial<MemoryScheduled> = {}): MemoryScheduled {
  return {
    id: 'sched-1',
    tenantId: TENANT_A,
    programId: 'prog-1',
    streamUrl: 'https://www.youtube.com/@canaluno',
    rrule: 'FREQ=DAILY;BYHOUR=12;BYMINUTE=0',
    timezone: 'America/Argentina/Buenos_Aires',
    durationMinutes: 60,
    pipelineConfig: { tone: 'formal' },
    isActive: true,
    autoStart: true,
    nextRunAt: new Date(T0),
    lastRunAt: null,
    lastTransmissionId: null,
    ...over,
  };
}

function makeRun(over: Partial<MemoryRun> = {}): MemoryRun {
  return {
    id: 'tx-old-1',
    tenantId: TENANT_A,
    programId: 'prog-1',
    scheduledTransmissionId: 'sched-1',
    source: 'live_capture',
    status: 'waiting',
    streamUrl: 'https://www.youtube.com/@canaluno',
    startedAt: new Date(T0),
    waitingSince: new Date(T0),
    durationMinutes: 60,
    endedAt: null,
    errorMessage: null,
    pipelineConfig: {},
    ...over,
  };
}

interface World {
  deps: TransmissionSchedulerDeps;
  state: ReturnType<typeof createMemorySchedulerStore>['state'];
  detectCalls: string[];
  setDetect: (fn: (url: string) => Promise<LiveDetectionResult>) => void;
  recCalls: StartRecordingOptions[];
  resolveDone: (index: number, outcome: RecordingOutcome) => void;
  events: Array<{ tenantId: string; event: string; payload: Record<string, unknown> }>;
  consumeCalls: Array<{ tenantId: string; operationId: string }>;
  releaseCalls: Array<{ tenantId: string; operationId: string; reason: string }>;
  setConsume: (fn: () => Promise<ConsumeResult>) => void;
  gate: { result: DispatchGateResult };
  /** PI-04: notificaciones de ingesta (interrupted/resumed) al tenant. */
  notifyCalls: Array<Record<string, unknown>>;
  /** PI-04: mtimes falsos del storage crudo — clave = fileRef (match por sufijo). */
  fileMtimes: Map<string, number>;
}

function makeWorld(seed: Parameters<typeof createMemorySchedulerStore>[0]): World {
  const { store, state } = createMemorySchedulerStore(seed);

  const detectCalls: string[] = [];
  let detectImpl: (url: string) => Promise<LiveDetectionResult> = async () =>
    det(true);

  const recCalls: StartRecordingOptions[] = [];
  const doneResolvers: Array<(o: RecordingOutcome) => void> = [];

  const consumeCalls: World['consumeCalls'] = [];
  let consumeImpl: () => Promise<ConsumeResult> = async () => ({
    allowed: true,
    quota: {} as ConsumeResult['quota'],
  });
  const releaseCalls: World['releaseCalls'] = [];

  const events: World['events'] = [];
  const gate: World['gate'] = {
    result: { ok: true, maxTransmissionMinutes: null },
  };
  const notifyCalls: World['notifyCalls'] = [];
  const fileMtimes: World['fileMtimes'] = new Map();

  // El ejecutor de transiciones replica la semántica real: FSM + UPDATE +
  // eventos post-commit (los captura `events` vía onEmit).
  const transitionRun = createMemoryTransitionRunner({
    find: (tenantId, id) =>
      state.runs.find((r) => r.id === id && r.tenantId === tenantId),
    onEmit: (e) => events.push(e),
    now,
  });

  const deps: TransmissionSchedulerDeps = {
    store,
    detectLive: (url) => {
      detectCalls.push(url);
      return detectImpl(url);
    },
    startRecording: async (opts) => {
      recCalls.push(opts);
      const done = new Promise<RecordingOutcome>((r) =>
        doneResolvers.push(r),
      );
      const handle: RecordingHandle = {
        transmissionId: opts.transmissionId,
        recordingId: `rec-${recCalls.length}`,
        done,
        stop: async () => {},
      };
      return handle;
    },
    checkDispatchable: async () => gate.result,
    consumeQuota: async (input) => {
      consumeCalls.push(input);
      return consumeImpl();
    },
    releaseQuota: async (input) => {
      releaseCalls.push(input);
      return { released: true };
    },
    transitionRun,
    // PI-04 — deps del sweep de ingesta: storage en memoria (mtime por
    // fileRef) y notify fake que registra en vez de tocar `notifications`.
    storagePath: (prefix) => `/mem/${prefix}`,
    fileMtimeMs: async (filePath) => {
      for (const [fileRef, mtime] of fileMtimes) {
        if (filePath.endsWith(fileRef)) return mtime;
      }
      return null;
    },
    notifyFn: (async (p: Record<string, unknown>) => {
      notifyCalls.push(p);
      return {} as never;
    }) as typeof notify,
  };

  return {
    deps,
    state,
    detectCalls,
    setDetect: (fn) => {
      detectImpl = fn;
    },
    recCalls,
    resolveDone: (index, outcome) => {
      // El recorder real deja la corrida en `processing` (o `error`) en su
      // finalize ANTES de resolver `done`: se replica para que la
      // transición final del scheduler (done/error) sea una arista válida.
      const opts = recCalls[index];
      void transitionRun({
        tenantId: opts.tenantId,
        transmissionId: opts.transmissionId,
        to: outcome.status === 'completed' ? 'processing' : 'error',
        errorMessage: outcome.errorMessage ?? undefined,
        patch:
          outcome.status === 'completed'
            ? { crudoRef: `mem/${opts.transmissionId}` }
            : undefined,
      }).finally(() => doneResolvers[index](outcome));
    },
    events,
    consumeCalls,
    releaseCalls,
    setConsume: (fn) => {
      consumeImpl = fn;
    },
    gate,
    notifyCalls,
    fileMtimes,
  };
}

let nowMs = T0;
const now = () => new Date(nowMs);

function tick(
  world: World,
  over: Partial<Parameters<typeof checkAndRunScheduledTransmissions>[0]> = {},
) {
  return checkAndRunScheduledTransmissions({
    now,
    waitingWindowMinutes: WINDOW_MIN,
    retryIntervalMs: RETRY,
    maxConcurrent: 5,
    deps: world.deps,
    ...over,
  });
}

const runOf = (world: World, id: string) =>
  world.state.runs.find((r) => r.id === id)!;

const lastRun = (world: World) => world.state.runs[world.state.runs.length - 1];

beforeEach(() => {
  nowMs = T0;
});

// ─── 1. Stream al aire → live + grabación ───────────────────────────────────

describe('dispatch con live al aire', () => {
  it('crea la corrida live_capture, la pasa a live y arranca la grabación', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });
    w.setDetect(async () => det(true));

    await tick(w);

    const run = lastRun(w);
    expect(run.source).toBe('live_capture');
    expect(run.status).toBe('live');
    expect(run.scheduledTransmissionId).toBe('sched-1');
    expect(run.streamUrl).toBe('https://www.youtube.com/@canaluno');
    expect(run.pipelineConfig).toEqual({ tone: 'formal' });

    expect(w.recCalls).toHaveLength(1);
    expect(w.recCalls[0].tenantId).toBe(TENANT_A);
    expect(w.recCalls[0].transmissionId).toBe(run.id);
    expect(w.recCalls[0].streamUrl).toBe('https://cdn.example.com/live.m3u8');
    expect(w.recCalls[0].maxDurationMinutes).toBe(60);

    // La agenda quedó consumida.
    const sched = w.state.scheduled[0];
    expect(sched.lastRunAt).toEqual(new Date(T0));
    expect(sched.lastTransmissionId).toBe(run.id);

    // La transición a live emitió los dos eventos del service por rooms:
    // transmission:status (room transmisión + tenant) y transmission:updated
    // (room tenant). Esto reemplaza al viejo `transmission-update` manual.
    expect(w.events).toHaveLength(2);
    expect(w.events[0].event).toBe('transmission:status');
    expect(w.events[0].tenantId).toBe(TENANT_A);
    expect(w.events[0].payload.transmissionId).toBe(run.id);
    expect(w.events[0].payload.status).toBe('live');
    expect(w.events[0].payload.previousStatus).toBe('scheduled');
    expect(w.events[1].event).toBe('transmission:updated');
    expect(w.events[1].tenantId).toBe(TENANT_A);
    expect(w.events[1].payload.id).toBe(run.id);
    expect(w.events[1].payload.status).toBe('live');
  });

  it('cuando el recorder termina OK la corrida pasa a done; si falla, a error', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });

    await tick(w);
    const run = lastRun(w);
    expect(run.status).toBe('live');

    w.resolveDone(0, {
      status: 'completed',
      totalBytes: 1000,
      segmentCount: 3,
      errorMessage: null,
    });
    await vi.waitFor(() => expect(runOf(w, run.id).status).toBe('done'));
  });

  it('outcome error del recorder → corrida en error con su mensaje', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });

    await tick(w);
    const run = lastRun(w);
    w.resolveDone(0, {
      status: 'error',
      totalBytes: 0,
      segmentCount: 0,
      errorMessage: 'ffmpeg murió',
    });
    await vi.waitFor(() => expect(runOf(w, run.id).status).toBe('error'));
    expect(runOf(w, run.id).errorMessage).toBe('ffmpeg murió');
  });
});

// ─── 2. AC — el stream arranca 10 minutos tarde y se captura igual ─────────

describe('AC: live tardío dentro de la ventana de espera', () => {
  it('sigue waiting durante los reintentos y al aparecer el live pasa a live + graba', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });
    // found:false en los primeros 5 intentos; el live aparece al 6º (10 min).
    w.setDetect(seqDetector(5));

    await tick(w); // t0 — dispatch + intento 1
    const run = lastRun(w);
    expect(run.status).toBe('waiting');
    expect(run.waitingSince).toEqual(new Date(T0));

    nowMs += 1 * MIN;
    await tick(w); // t0+1 — el reintento todavía no vence (retry=2min)
    expect(run.status).toBe('waiting');
    expect(w.detectCalls).toHaveLength(1);

    nowMs += 1 * MIN;
    await tick(w); // t0+2 — intento 2
    nowMs += RETRY;
    await tick(w); // t0+4 — intento 3
    nowMs += RETRY;
    await tick(w); // t0+6 — intento 4
    nowMs += RETRY;
    await tick(w); // t0+8 — intento 5

    // El AC: 8 minutos después la corrida NO está en error — sigue waiting
    // y el ancla de la ventana no se movió.
    expect(run.status).toBe('waiting');
    expect(run.errorMessage).toBeNull();
    expect(run.waitingSince).toEqual(new Date(T0));
    expect(w.detectCalls).toHaveLength(5);
    expect(w.recCalls).toHaveLength(0);

    nowMs += RETRY;
    await tick(w); // t0+10 — intento 6: el live apareció

    expect(run.status).toBe('live');
    expect(w.recCalls).toHaveLength(1);
    expect(w.recCalls[0].tenantId).toBe(TENANT_A);
  });

  it('la ventana NUNCA se reinicia entre reintentos (waiting_since se conserva)', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });
    w.setDetect(async () => det(false));

    await tick(w);
    const run = lastRun(w);
    expect(run.waitingSince).toEqual(new Date(T0));

    nowMs += RETRY;
    await tick(w);
    nowMs += RETRY;
    await tick(w);
    expect(run.waitingSince).toEqual(new Date(T0)); // intacta tras reintentos
  });
});

// ─── 3. Ventana agotada → error descriptivo ─────────────────────────────────

describe('ventana de espera agotada', () => {
  it('pasa a error con mensaje de la ventana y devuelve la cuota consumida', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });
    w.setDetect(async () => det(false));

    await tick(w, { waitingWindowMinutes: 5 }); // t0 — waiting
    nowMs += RETRY;
    await tick(w, { waitingWindowMinutes: 5 }); // t0+2 — waiting
    nowMs += RETRY;
    await tick(w, { waitingWindowMinutes: 5 }); // t0+4 — waiting (4<5)

    const run = lastRun(w);
    expect(run.status).toBe('waiting');

    nowMs += RETRY;
    await tick(w, { waitingWindowMinutes: 5 }); // t0+6 — ventana agotada

    expect(run.status).toBe('error');
    expect(run.errorMessage).toMatch(/ventana de espera de 5 minutos/);
    expect(run.errorMessage).toContain('youtube.com');
    expect(run.endedAt).toEqual(new Date(T0 + 6 * MIN));

    // La unidad de cuota consumida al despachar se devuelve (arranque fallido).
    expect(w.releaseCalls).toHaveLength(1);
    expect(w.releaseCalls[0].operationId).toBe(`schedrun:${run.id}`);
    expect(w.releaseCalls[0].reason).toBe('start_failed');
  });
});

// ─── 4. Idempotencia ────────────────────────────────────────────────────────

describe('idempotencia', () => {
  it('con una corrida abierta para la agenda no crea otra (y avanza next_run_at)', async () => {
    const w = makeWorld({
      scheduled: [makeScheduled()],
      runs: [
        makeRun({
          id: 'tx-ya-abierta',
          status: 'waiting',
          waitingSince: new Date(T0 - 60_000),
          startedAt: new Date(T0 - 60_000),
        }),
      ],
    });
    w.setDetect(async () => det(false));

    await tick(w);

    const linked = w.state.runs.filter(
      (r) => r.scheduledTransmissionId === 'sched-1',
    );
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe('tx-ya-abierta');
    // No se pisó last_transmission_id (la corrida no la creó este tick).
    expect(w.state.scheduled[0].lastTransmissionId).toBeNull();
    // Pero la ocurrencia vencida se consumió: next_run_at avanzó.
    expect(w.state.scheduled[0].nextRunAt!.getTime()).toBeGreaterThan(T0);
  });

  it('un segundo tick en el mismo minuto tampoco duplica', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });
    w.setDetect(async () => det(false));

    await tick(w);
    await tick(w); // mismo now: la agenda ya avanzó, no vuelve a vencer
    expect(w.state.runs).toHaveLength(1);
    expect(w.detectCalls).toHaveLength(1);
  });
});

// ─── 5. Flags de la agenda ─────────────────────────────────────────────────

describe('agendas no disparables', () => {
  it('is_active=false y auto_start=false nunca despachan', async () => {
    const w = makeWorld({
      scheduled: [
        makeScheduled({ id: 's-off', isActive: false }),
        makeScheduled({ id: 's-manual', autoStart: false }),
      ],
    });

    await tick(w);

    expect(w.state.runs).toHaveLength(0);
    expect(w.detectCalls).toHaveLength(0);
    expect(w.recCalls).toHaveLength(0);
  });

  it('next_run_at futuro tampoco dispara todavía', async () => {
    const w = makeWorld({
      scheduled: [makeScheduled({ nextRunAt: new Date(T0 + 10 * MIN) })],
    });

    await tick(w);
    expect(w.state.runs).toHaveLength(0);
  });
});

// ─── 6. Avance de next_run_at ──────────────────────────────────────────────

describe('avance de next_run_at', () => {
  it('usa nextOccurrence(rrule, now, timezone) de la regla', async () => {
    const sched = makeScheduled({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18;BYMINUTE=30',
      timezone: 'America/Argentina/Buenos_Aires',
    });
    const w = makeWorld({ scheduled: [sched] });
    w.setDetect(async () => det(false));

    await tick(w);

    const expected = nextOccurrence(
      sched.rrule,
      new Date(T0),
      sched.timezone,
    );
    expect(w.state.scheduled[0].nextRunAt).toEqual(expected);
    expect(w.state.scheduled[0].lastRunAt).toEqual(new Date(T0));
    expect(w.state.scheduled[0].lastTransmissionId).toBe(lastRun(w).id);
  });

  it('regla puntual (COUNT=1): la única ocurrencia consumida → next_run_at null', async () => {
    const w = makeWorld({
      scheduled: [makeScheduled({ rrule: 'FREQ=DAILY;COUNT=1' })],
    });
    w.setDetect(async () => det(false));

    await tick(w);
    expect(w.state.scheduled[0].nextRunAt).toBeNull();
    expect(w.state.runs).toHaveLength(1);
  });
});

// ─── 7. Tenant safety ──────────────────────────────────────────────────────

describe('tenant safety', () => {
  it('la corrida hereda el tenant_id de la agenda (nunca del contexto)', async () => {
    const w = makeWorld({
      scheduled: [
        makeScheduled({ id: 'sa', tenantId: TENANT_A }),
        makeScheduled({ id: 'sb', tenantId: TENANT_B }),
      ],
    });
    w.setDetect(async () => det(true));

    await tick(w);

    const runA = w.state.runs.find((r) => r.scheduledTransmissionId === 'sa')!;
    const runB = w.state.runs.find((r) => r.scheduledTransmissionId === 'sb')!;
    expect(runA.tenantId).toBe(TENANT_A);
    expect(runB.tenantId).toBe(TENANT_B);
    // La cuota también se consumió por tenant correcto.
    expect(w.consumeCalls.map((c) => c.tenantId).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );
    // Y cada grabación arrancó con SU tenant.
    expect(w.recCalls.find((c) => c.transmissionId === runA.id)!.tenantId).toBe(
      TENANT_A,
    );
    expect(w.recCalls.find((c) => c.transmissionId === runB.id)!.tenantId).toBe(
      TENANT_B,
    );
  });
});

// ─── 8. Concurrencia ────────────────────────────────────────────────────────

describe('límite de concurrencia', () => {
  it('con maxConcurrent alcanzado la corrida queda waiting (nunca descartada)', async () => {
    const w = makeWorld({
      scheduled: [makeScheduled()],
      runs: [
        makeRun({ id: 'tx-viva', status: 'live', scheduledTransmissionId: null }),
      ],
    });

    await tick(w, { maxConcurrent: 1 });

    const run = lastRun(w);
    expect(run.id).not.toBe('tx-viva');
    expect(run.status).toBe('waiting'); // no error, no descartada
    expect(w.detectCalls).toHaveLength(0); // ni siquiera intentó detectar
    expect(w.recCalls).toHaveLength(0);

    // Cuando se libera el slot, el siguiente tick sí la levanta.
    runOf(w, 'tx-viva').status = 'done';
    nowMs += MIN;
    await tick(w, { maxConcurrent: 1 });
    expect(runOf(w, run.id).status).toBe('live');
    expect(w.recCalls).toHaveLength(1);
  });
});

// ─── Gates: suscripción y cuota ────────────────────────────────────────────

describe('gates previos al dispatch', () => {
  it('sin suscripción activa → corrida en error, sin consumir cuota ni detectar', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });
    w.gate.result = { ok: false, reason: 'el período de prueba expiró' };

    await tick(w);

    const run = lastRun(w);
    expect(run.status).toBe('error');
    expect(run.errorMessage).toMatch(/suscripción activa/i);
    expect(run.errorMessage).toContain('período de prueba expiró');
    expect(w.consumeCalls).toHaveLength(0); // la cuota ni se consultó
    expect(w.detectCalls).toHaveLength(0);
    expect(w.recCalls).toHaveLength(0);
    // La ocurrencia se consumió igual: last_transmission_id apunta al error.
    expect(w.state.scheduled[0].lastTransmissionId).toBe(run.id);
    expect(w.state.scheduled[0].nextRunAt!.getTime()).toBeGreaterThan(T0);
  });

  it('cuota agotada → corrida en error con el plan en el mensaje', async () => {
    const w = makeWorld({ scheduled: [makeScheduled()] });
    w.setConsume(async () => ({
      allowed: false,
      reason: 'QUOTA_EXCEEDED',
      quota: { planName: 'Start' } as ConsumeResult['quota'],
    }));

    await tick(w);

    const run = lastRun(w);
    expect(run.status).toBe('error');
    expect(run.errorMessage).toMatch(/Cupo de transmisiones del ciclo agotado/);
    expect(run.errorMessage).toContain('Start');
    expect(w.detectCalls).toHaveLength(0);
    expect(w.releaseCalls).toHaveLength(0); // el consume falló → nada que liberar
  });

  it('max_transmission_minutes del plan capea la duración de la captura', async () => {
    const w = makeWorld({
      scheduled: [makeScheduled({ durationMinutes: 120 })],
    });
    w.gate.result = { ok: true, maxTransmissionMinutes: 45 };

    await tick(w);

    expect(w.recCalls).toHaveLength(1);
    expect(w.recCalls[0].maxDurationMinutes).toBe(45);
  });
});

// ─── Reconciliación post-restart ────────────────────────────────────────────

describe('reconcileOrphanedRuns', () => {
  it('live sin recording → error restart; completed → done; waiting intacta', async () => {
    const w = makeWorld({
      runs: [
        makeRun({ id: 'tx-huerfana', status: 'live' }),
        makeRun({ id: 'tx-done', status: 'live' }),
        makeRun({ id: 'tx-proc', status: 'processing' }),
        makeRun({ id: 'tx-espera', status: 'waiting' }),
      ],
      recordings: [{ transmissionId: 'tx-done', status: 'completed' }],
    });

    await reconcileOrphanedRuns({ now, deps: w.deps });

    expect(runOf(w, 'tx-huerfana').status).toBe('error');
    expect(runOf(w, 'tx-huerfana').errorMessage).toMatch(/reinici/);
    expect(runOf(w, 'tx-done').status).toBe('done');
    expect(runOf(w, 'tx-proc').status).toBe('done');
    // La waiting la retoma el scan: no se toca en el reconcile.
    expect(runOf(w, 'tx-espera').status).toBe('waiting');
  });

  it('live con grabación abierta dentro de la ventana → cierra segmentos, interrupted→reanuda MISMO recording y la corrida sigue live', async () => {
    const rec0 = T0 - 10 * MIN;
    const w = makeWorld({
      runs: [
        makeRun({
          id: 'tx-viva',
          status: 'live',
          startedAt: new Date(rec0),
          durationMinutes: 60,
        }),
      ],
      recordings: [
        {
          id: 'rec-1',
          transmissionId: 'tx-viva',
          tenantId: TENANT_A,
          status: 'recording',
          storagePrefix: `${TENANT_A}/tx-viva`,
          startedAt: new Date(rec0),
        },
      ],
      segments: [
        {
          recordingId: 'rec-1',
          sequence: 0,
          fileRef: 'seg-a.mp4',
          startMs: 0,
          endMs: 300_000,
          bytes: 100,
        },
        {
          recordingId: 'rec-1',
          sequence: 1,
          fileRef: 'seg-b.mp4',
          startMs: 300_000,
          endMs: null,
          bytes: 50,
        },
      ],
    });
    // El archivo abierto se escribió por última vez hace 2 min (el crash).
    w.fileMtimes.set('seg-b.mp4', T0 - 2 * MIN);

    await reconcileOrphanedRuns({ now, deps: w.deps, resumeWindowMinutes: 30 });

    // El segmento abierto cierra al mtime real, no a "ahora".
    const seg1 = w.state.segments.find((s) => s.sequence === 1)!;
    expect(seg1.endMs).toBe(T0 - 2 * MIN - rec0);
    // La grabación quedó interrupted + ended_at; al reanudar vuelve a recording
    // (la llamada a startRecording{resume} lo hace el recorder real — acá el
    // fake no la toca, el patch queda evidenciado).
    const rec = w.state.recordings[0];
    expect(rec.status).toBe('interrupted');
    expect(rec.endedAt).not.toBeNull();
    // Reanudación sobre la MISMA fila: mismo recordingId/prefijo, seq continúa.
    await vi.waitFor(() => expect(w.recCalls).toHaveLength(1));
    expect(w.recCalls[0].transmissionId).toBe('tx-viva');
    expect(w.recCalls[0].storagePrefix).toBe(`${TENANT_A}/tx-viva`);
    expect(w.recCalls[0].resume).toEqual({
      recordingId: 'rec-1',
      startedAt: new Date(rec0),
      nextSequence: 2,
    });
    // La corrida NUNCA salió de live (la captura sigue al aire).
    expect(runOf(w, 'tx-viva').status).toBe('live');
    expect(w.notifyCalls.some((n) => n.type === 'ingest_resumed')).toBe(true);
    expect(w.notifyCalls.some((n) => n.type === 'ingest_interrupted')).toBe(false);
  });

  it('corte largo (> ventana) → interrupted terminal, corrida a error con razón, NO reanuda', async () => {
    const rec0 = T0 - 120 * MIN;
    const w = makeWorld({
      runs: [
        makeRun({
          id: 'tx-corte',
          status: 'live',
          startedAt: new Date(rec0),
          durationMinutes: 180, // la ventana live sigue abierta
        }),
      ],
      recordings: [
        {
          id: 'rec-2',
          transmissionId: 'tx-corte',
          tenantId: TENANT_A,
          status: 'recording',
          storagePrefix: `${TENANT_A}/tx-corte`,
          startedAt: new Date(rec0),
        },
      ],
      segments: [
        {
          recordingId: 'rec-2',
          sequence: 0,
          fileRef: 'seg-x.mp4',
          startMs: 0,
          endMs: null,
          bytes: 10,
        },
      ],
    });
    // Última escritura hace 60 min → corte de 60 > ventana de 30.
    w.fileMtimes.set('seg-x.mp4', T0 - 60 * MIN);

    await reconcileOrphanedRuns({ now, deps: w.deps, resumeWindowMinutes: 30 });

    expect(w.recCalls).toHaveLength(0);
    const run = runOf(w, 'tx-corte');
    expect(run.status).toBe('error');
    expect(run.errorMessage).toMatch(/corte de ingesta duró 60 min/);
    expect(run.errorMessage).toMatch(/30 min/);
    expect(w.state.recordings[0].status).toBe('interrupted');
    expect(w.state.segments[0].endMs).toBe(60 * MIN);
    expect(
      w.notifyCalls.some(
        (n) => n.type === 'ingest_interrupted' && n.tenantId === TENANT_A,
      ),
    ).toBe(true);
  });

  it('ventana live ya vencida → terminal aunque el corte sea corto', async () => {
    const rec0 = T0 - 70 * MIN;
    const w = makeWorld({
      runs: [
        makeRun({
          id: 'tx-vencida',
          status: 'live',
          startedAt: new Date(rec0),
          durationMinutes: 60, // la ventana terminó hace 10 min
        }),
      ],
      recordings: [
        {
          id: 'rec-3',
          transmissionId: 'tx-vencida',
          tenantId: TENANT_A,
          status: 'recording',
          storagePrefix: `${TENANT_A}/tx-vencida`,
          startedAt: new Date(rec0),
        },
      ],
      segments: [
        {
          recordingId: 'rec-3',
          sequence: 0,
          fileRef: 'seg-y.mp4',
          startMs: 0,
          endMs: null,
          bytes: 10,
        },
      ],
    });
    // Corte de 1 min: dentro de la ventana de reanudación — no alcanza.
    w.fileMtimes.set('seg-y.mp4', T0 - 1 * MIN);

    await reconcileOrphanedRuns({ now, deps: w.deps, resumeWindowMinutes: 30 });

    expect(w.recCalls).toHaveLength(0);
    const run = runOf(w, 'tx-vencida');
    expect(run.status).toBe('error');
    expect(run.errorMessage).toMatch(/ventana live/);
    expect(w.notifyCalls.some((n) => n.type === 'ingest_interrupted')).toBe(true);
  });

  it('segmento abierto sin archivo (stat falla) colapsa a start_ms y el corte se ancla ahí', async () => {
    const rec0 = T0 - 10 * MIN;
    const w = makeWorld({
      runs: [
        makeRun({
          id: 'tx-stat',
          status: 'live',
          startedAt: new Date(rec0),
          durationMinutes: 60,
        }),
      ],
      recordings: [
        {
          id: 'rec-4',
          transmissionId: 'tx-stat',
          tenantId: TENANT_A,
          status: 'recording',
          storagePrefix: `${TENANT_A}/tx-stat`,
          startedAt: new Date(rec0),
        },
      ],
      segments: [
        {
          recordingId: 'rec-4',
          sequence: 0,
          fileRef: 'seg-perdido.mp4',
          startMs: 300_000,
          endMs: null,
          bytes: 10,
        },
      ],
    });
    // Sin mtime (archivo ilegible): end_ms = start_ms, outage = 5 min → reanuda.
    await reconcileOrphanedRuns({ now, deps: w.deps, resumeWindowMinutes: 30 });

    expect(w.state.segments[0].endMs).toBe(300_000);
    await vi.waitFor(() => expect(w.recCalls).toHaveLength(1));
    expect(w.recCalls[0].resume?.nextSequence).toBe(1);
  });

  it('una grabación interrupted de un sweep previo se reanuda igual (idempotente)', async () => {
    const rec0 = T0 - 10 * MIN;
    const w = makeWorld({
      runs: [
        makeRun({
          id: 'tx-reint',
          status: 'live',
          startedAt: new Date(rec0),
          durationMinutes: 60,
        }),
      ],
      recordings: [
        {
          id: 'rec-5',
          transmissionId: 'tx-reint',
          tenantId: TENANT_A,
          status: 'interrupted', // quedó del boot anterior sin reanudar
          storagePrefix: `${TENANT_A}/tx-reint`,
          startedAt: new Date(rec0),
        },
      ],
      segments: [
        {
          recordingId: 'rec-5',
          sequence: 0,
          fileRef: 'seg-z.mp4',
          startMs: 0,
          endMs: 120_000,
          bytes: 10,
        },
      ],
    });

    await reconcileOrphanedRuns({ now, deps: w.deps, resumeWindowMinutes: 30 });

    // Nada abierto que cerrar; outage anclada al end_ms (T0-8min) < 30 → reanuda.
    expect(w.state.segments[0].endMs).toBe(120_000);
    await vi.waitFor(() => expect(w.recCalls).toHaveLength(1));
    expect(w.recCalls[0].resume?.recordingId).toBe('rec-5');
    expect(runOf(w, 'tx-reint').status).toBe('live');
  });
});

describe('decideOrphanRecovery', () => {
    const base = {
      outageMs: 5 * MIN,
      resumeWindowMs: 30 * MIN,
      liveWindowEndMs: T0 + 50 * MIN,
      nowMs: T0,
    };

    it('reanuda sólo si las dos ventanas están vivas', () => {
      expect(decideOrphanRecovery(base)).toEqual({ resume: true });
    });

    it('ventana live vencida → terminal (independiente del corte)', () => {
      const d = decideOrphanRecovery({ ...base, liveWindowEndMs: T0 - 1 });
      expect(d.resume).toBe(false);
      expect(d.reason).toMatch(/ventana live/);
    });

    it('corrida sin cap de duración → la ventana live no corta', () => {
      expect(
        decideOrphanRecovery({ ...base, liveWindowEndMs: null }),
      ).toEqual({ resume: true });
    });

    it('outage > ventana → terminal con la duración del corte en la razón', () => {
      const d = decideOrphanRecovery({ ...base, outageMs: 45 * MIN });
      expect(d.resume).toBe(false);
      expect(d.reason).toMatch(/45 min/);
      expect(d.reason).toMatch(/30 min/);
    });

    it('outage exactamente igual a la ventana → reanuda (el corte es >, no >=)', () => {
      expect(
        decideOrphanRecovery({ ...base, outageMs: 30 * MIN }),
      ).toEqual({ resume: true });
    });
});

// ─── init / stop ────────────────────────────────────────────────────────────

describe('initTransmissionScheduler / stopTransmissionScheduler', () => {
  it('init registra el intervalo y stop lo limpia sin lanzar', () => {
    const fakeIo = { to: () => ({ emit: () => {} }) } as unknown as Server;
    expect(() =>
      initTransmissionScheduler(fakeIo, { deps: makeWorld({}).deps }),
    ).not.toThrow();
    expect(() => stopTransmissionScheduler()).not.toThrow();
  });
});
