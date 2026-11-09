/**
 * Tests del slice PD-06: `rawRetentionService.ts` (retención del crudo por
 * plan + job de purga) y su enganche en `transmissionSchedulerService.ts`.
 *
 * Deterministas: sin DB real, sin storage real, sin timers. El `now` es
 * inyectado; `RetentionStore` corre sobre `memoryRetentionStore` con los
 * MISMOS filtros que el drizzle (tenant_id en cada escritura incluido) y el
 * storage es un `RawStorage` fake que registra los `deletePrefix` recibidos.
 *
 * Casos obligatorios del brief (numerados como ahí):
 *   1. Política: plan 30 días → 30; sin plan → null; plan null → null;
 *      plan 0 → null (sin límite — interpretación documentada).
 *   2. Recording en curso (`recording`) → no candidata.
 *   3. Transmisión sin `ended_at` → no candidata.
 *   4. Completada hace 31 días con retención 30 → candidata.
 *   5. Frontera exacta: 30 días justos → NO candidata.
 *   6. Purga real: deletePrefix con el storage_prefix, segmentos `purged`
 *      (no borrados), `transmissions.crudo_ref` = null.
 *   7. Los clips derivados sobreviven (ni DELETE ni UPDATE sobre `clips`).
 *   8. Render pendiente (`generating`) → candidata `skipped`, no se borra.
 *   9. `dryRun`: no borra ni actualiza, pero devuelve los conteos.
 *  10. Tenant safety: el UPDATE de segmentos está acotado por `tenant_id`.
 *
 * Extras: ya purgada → no candidata (idempotencia), una falla no aborta el
 * job, `describeRetention`, y el enganche del job en el tick del scheduler
 * (catch-up en el primer tick, intervalo por env, flag de apagado).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock parcial del módulo DB (importarlo crea un Pool Neon y pediría
// DATABASE_URL): se preserva el resto de exports y se reemplaza `db`.
vi.mock('../src/server/db/index.js', async (io) => ({
  ...(await io()),
  db: {},
}));

import {
  describeRetention,
  findExpiredRecordings,
  getRetentionPolicy,
  purgeExpiredRecordings,
} from '../src/server/services/rawRetentionService';
import type { RawStorage } from '../src/server/services/rawStorageService';
import type { LiveDetectionResult } from '../src/server/services/liveDetectorService';
import type { RecordingHandle } from '../src/server/services/streamRecorderService';
import {
  createMemoryRetentionStore,
  type MemoryClipRow,
  type MemoryRecordingRow,
  type MemorySegmentRow,
  type MemoryTransmissionRow,
} from './helpers/memoryRetentionStore';
import { createMemorySchedulerStore } from './helpers/memorySchedulerStore';
import { createMemoryTransitionRunner } from './helpers/memoryTransitionRunner';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const TENANT_C = '00000000-0000-4000-8000-00000000000c';
const TENANT_D = '00000000-0000-4000-8000-00000000000d';

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09 12:00 UTC
const NOW = new Date(T0);
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(T0 - n * DAY);

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** RawStorage fake: registra los `deletePrefix` y puede fallar a pedido. */
function makeFakeStorage(opts: { failOn?: string[] } = {}) {
  const deletedPrefixes: string[] = [];
  const failOn = new Set(opts.failOn ?? []);
  const storage: RawStorage = {
    writeFile: async () => {},
    readFile: async () => Buffer.alloc(0),
    statFile: async () => null,
    deleteFile: async () => {},
    deletePrefix: async (prefix) => {
      if (failOn.has(prefix)) throw new Error(`storage falló en ${prefix}`);
      deletedPrefixes.push(prefix);
    },
    exists: async () => false,
    publicPath: (key) => `/fake/${key}`,
  };
  return { storage, deletedPrefixes };
}

function makeRecording(over: Partial<MemoryRecordingRow> = {}): MemoryRecordingRow {
  return {
    id: id('rec'),
    tenantId: TENANT_A,
    transmissionId: id('tx'),
    storagePrefix: `${TENANT_A}/tx-1`,
    status: 'completed',
    totalBytes: 500,
    startedAt: daysAgo(32),
    endedAt: daysAgo(31),
    ...over,
  };
}

function makeTransmission(over: Partial<MemoryTransmissionRow> = {}): MemoryTransmissionRow {
  return {
    id: id('tx'),
    tenantId: TENANT_A,
    programId: 'prog-1',
    status: 'done',
    startedAt: daysAgo(32),
    endedAt: daysAgo(31),
    crudoRef: `${TENANT_A}/tx-1`,
    ...over,
  };
}

function makeSegment(over: Partial<MemorySegmentRow> = {}): MemorySegmentRow {
  return {
    id: id('seg'),
    tenantId: TENANT_A,
    recordingId: 'rec-1',
    sequence: 1,
    status: 'active',
    fileRef: 'seg-00001.mp4',
    bytes: 500,
    ...over,
  };
}

function makeClip(over: Partial<MemoryClipRow> = {}): MemoryClipRow {
  return {
    id: id('clip'),
    tenantId: TENANT_A,
    programId: 'prog-1',
    status: 'ready',
    metadata: null,
    createdAt: daysAgo(31),
    ...over,
  };
}

const PLAN_30 = { id: 'plan-30', rawRetentionDays: 30 };

/** Seed mínimo: tenant A con plan de 30 días + un par grabación/transmisión. */
function seedBase() {
  const tx = makeTransmission({
    id: 'tx-a1',
    tenantId: TENANT_A,
    crudoRef: `${TENANT_A}/tx-a1`,
  });
  const rec = makeRecording({
    id: 'rec-a1',
    tenantId: TENANT_A,
    transmissionId: 'tx-a1',
    storagePrefix: `${TENANT_A}/tx-a1`,
  });
  const segments = [
    makeSegment({ id: 'seg-1', tenantId: TENANT_A, recordingId: 'rec-a1', sequence: 1 }),
    makeSegment({ id: 'seg-2', tenantId: TENANT_A, recordingId: 'rec-a1', sequence: 2 }),
  ];
  return createMemoryRetentionStore({
    recordings: [rec],
    transmissions: [tx],
    segments,
    subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
    plans: [PLAN_30],
  });
}

// ─── 1. Política de retención ───────────────────────────────────────────────

describe('getRetentionPolicy', () => {
  const { store } = createMemoryRetentionStore({
    subscriptions: [
      { tenantId: TENANT_A, planId: 'plan-30' },
      { tenantId: TENANT_C, planId: 'plan-null' },
      { tenantId: TENANT_D, planId: 'plan-0' },
    ],
    plans: [
      PLAN_30,
      { id: 'plan-null', rawRetentionDays: null },
      { id: 'plan-0', rawRetentionDays: 0 },
    ],
  });

  it('tenant con plan de 30 días → retentionDays = 30', async () => {
    const policy = await getRetentionPolicy(TENANT_A, { store });
    expect(policy).toEqual({ tenantId: TENANT_A, retentionDays: 30 });
  });

  it('tenant sin suscripción → null (sin límite: nunca se purga)', async () => {
    const policy = await getRetentionPolicy(TENANT_B, { store });
    expect(policy.retentionDays).toBeNull();
  });

  it('plan con raw_retention_days = null → null', async () => {
    const policy = await getRetentionPolicy(TENANT_C, { store });
    expect(policy.retentionDays).toBeNull();
  });

  it('plan con raw_retention_days = 0 → null (sin límite, documentado)', async () => {
    const policy = await getRetentionPolicy(TENANT_D, { store });
    expect(policy.retentionDays).toBeNull();
  });
});

describe('describeRetention', () => {
  it('etiqueta legible: días / singular / sin límite', () => {
    expect(describeRetention({ tenantId: 't', retentionDays: 30 })).toBe('30 días');
    expect(describeRetention({ tenantId: 't', retentionDays: 1 })).toBe('1 día');
    expect(describeRetention({ tenantId: 't', retentionDays: null })).toBe('sin límite');
  });
});

// ─── 2-5. Candidatas de la expiración ───────────────────────────────────────

describe('findExpiredRecordings', () => {
  it('2. grabación en curso (status=recording) → NO es candidata', async () => {
    const world = createMemoryRetentionStore({
      recordings: [makeRecording({ id: 'rec-x', transmissionId: 'tx-x', status: 'recording' })],
      transmissions: [makeTransmission({ id: 'tx-x' })],
      segments: [makeSegment({ recordingId: 'rec-x' })],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
    });
    const found = await findExpiredRecordings(NOW, {}, { store: world.store });
    expect(found).toHaveLength(0);
  });

  it('3. transmisión sin ended_at → NO es candidata', async () => {
    const world = createMemoryRetentionStore({
      recordings: [makeRecording({ id: 'rec-x', transmissionId: 'tx-x' })],
      transmissions: [makeTransmission({ id: 'tx-x', endedAt: null })],
      segments: [makeSegment({ recordingId: 'rec-x' })],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
    });
    const found = await findExpiredRecordings(NOW, {}, { store: world.store });
    expect(found).toHaveLength(0);
  });

  it('4. completada hace 31 días con retención 30 → ES candidata', async () => {
    const { store } = seedBase(); // ended_at = T0 - 31d, retention 30
    const found = await findExpiredRecordings(NOW, {}, { store });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      recordingId: 'rec-a1',
      tenantId: TENANT_A,
      storagePrefix: `${TENANT_A}/tx-a1`,
      daysOverdue: 1,
    });
    expect(found[0].endedAt).toEqual(daysAgo(31));
  });

  it('5. frontera exacta: terminada hace EXACTAMENTE 30 días → NO candidata', async () => {
    const world = createMemoryRetentionStore({
      recordings: [makeRecording({ id: 'rec-x', transmissionId: 'tx-x' })],
      transmissions: [makeTransmission({ id: 'tx-x', endedAt: daysAgo(30) })],
      segments: [makeSegment({ recordingId: 'rec-x' })],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
    });
    const found = await findExpiredRecordings(NOW, {}, { store: world.store });
    expect(found).toHaveLength(0);
  });

  it('tenant sin plan → sus grabaciones vencidas NO son candidatas', async () => {
    const world = createMemoryRetentionStore({
      recordings: [makeRecording({ id: 'rec-x', transmissionId: 'tx-x', tenantId: TENANT_B })],
      transmissions: [makeTransmission({ id: 'tx-x', tenantId: TENANT_B })],
      segments: [makeSegment({ recordingId: 'rec-x', tenantId: TENANT_B })],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
    });
    const found = await findExpiredRecordings(NOW, {}, { store: world.store });
    expect(found).toHaveLength(0);
  });

  it('ya purgada (todos los segmentos purged) → NO es candidata (idempotente)', async () => {
    const world = createMemoryRetentionStore({
      recordings: [makeRecording({ id: 'rec-x', transmissionId: 'tx-x' })],
      transmissions: [makeTransmission({ id: 'tx-x' })],
      segments: [
        makeSegment({ id: 's1', recordingId: 'rec-x', status: 'purged' }),
        makeSegment({ id: 's2', recordingId: 'rec-x', sequence: 2, status: 'purged' }),
      ],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
    });
    const found = await findExpiredRecordings(NOW, {}, { store: world.store });
    expect(found).toHaveLength(0);
  });
});

// ─── 6-10. La purga ─────────────────────────────────────────────────────────

describe('purgeExpiredRecordings', () => {
  it('6. purga real: deletePrefix del prefijo, segmentos `purged` (no borrados), crudo_ref null', async () => {
    const { store, state } = seedBase();
    const { storage, deletedPrefixes } = makeFakeStorage();

    const outcome = await purgeExpiredRecordings(NOW, {}, { store, storage });

    expect(outcome).toMatchObject({ scanned: 1, purged: 1, skipped: 0, bytesFreed: 500, errors: [] });
    // Los archivos se borraron por el prefijo exacto del recording.
    expect(deletedPrefixes).toEqual([`${TENANT_A}/tx-a1`]);
    // Los segmentos quedaron como metadato `purged` — NO se borraron.
    expect(state.segments).toHaveLength(2);
    expect(state.segments.map((s) => s.status)).toEqual(['purged', 'purged']);
    // crudo_ref liberado: el crudo ya no existe.
    expect(state.transmissions.find((t) => t.id === 'tx-a1')?.crudoRef).toBeNull();
    // La grabación sigue `completed` (historial visible).
    expect(state.recordings[0].status).toBe('completed');
    expect(state.purges).toEqual([
      { tenantId: TENANT_A, recordingId: 'rec-a1', transmissionId: 'tx-a1' },
    ]);
  });

  it('7. los clips derivados sobreviven intactos (ni UPDATE ni DELETE)', async () => {
    const clip = makeClip({ id: 'clip-1', status: 'ready' });
    const { store, state } = createMemoryRetentionStore({
      ...(() => {
        const tx = makeTransmission({ id: 'tx-a1' });
        const rec = makeRecording({ id: 'rec-a1', transmissionId: 'tx-a1', storagePrefix: `${TENANT_A}/tx-a1` });
        return {
          recordings: [rec],
          transmissions: [tx],
          segments: [makeSegment({ recordingId: 'rec-a1' })],
        };
      })(),
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
      clips: [clip],
    });
    const clipsBefore = JSON.parse(JSON.stringify(state.clips));

    const { storage } = makeFakeStorage();
    const outcome = await purgeExpiredRecordings(NOW, {}, { store, storage });

    expect(outcome.purged).toBe(1);
    // La tabla clips quedó EXACTAMENTE igual — la purga no la toca jamás.
    expect(JSON.parse(JSON.stringify(state.clips))).toEqual(clipsBefore);
  });

  it('8. render pendiente (`generating`) → candidata `skipped`, no se borra nada', async () => {
    const txB = makeTransmission({ id: 'tx-b1', tenantId: TENANT_B, crudoRef: `${TENANT_B}/tx-b1` });
    const recB = makeRecording({
      id: 'rec-b1',
      tenantId: TENANT_B,
      transmissionId: 'tx-b1',
      storagePrefix: `${TENANT_B}/tx-b1`,
    });
    const world = createMemoryRetentionStore({
      recordings: [recB],
      transmissions: [txB],
      segments: [makeSegment({ recordingId: 'rec-b1', tenantId: TENANT_B })],
      subscriptions: [{ tenantId: TENANT_B, planId: PLAN_30.id }],
      plans: [PLAN_30],
      clips: [
        // Clip renderizándose AHORA desde ESTA transmisión (link explícito).
        makeClip({
          id: 'clip-gen',
          tenantId: TENANT_B,
          status: 'generating',
          metadata: { transmissionId: 'tx-b1' },
          createdAt: new Date(T0),
        }),
      ],
    });
    const { storage, deletedPrefixes } = makeFakeStorage();

    const outcome = await purgeExpiredRecordings(NOW, {}, { store: world.store, storage });

    expect(outcome).toMatchObject({ scanned: 1, purged: 0, skipped: 1, bytesFreed: 0, errors: [] });
    expect(deletedPrefixes).toHaveLength(0);
    expect(world.state.segments[0].status).toBe('active');
    expect(world.state.transmissions[0].crudoRef).toBe(`${TENANT_B}/tx-b1`);
  });

  it('8b. un clip terminal (`ready`) de la misma transmisión NO bloquea la purga', async () => {
    const tx = makeTransmission({ id: 'tx-a1' });
    const rec = makeRecording({ id: 'rec-a1', transmissionId: 'tx-a1', storagePrefix: `${TENANT_A}/tx-a1` });
    const world = createMemoryRetentionStore({
      recordings: [rec],
      transmissions: [tx],
      segments: [makeSegment({ recordingId: 'rec-a1' })],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
      clips: [
        makeClip({ id: 'clip-done', status: 'ready', metadata: { transmissionId: 'tx-a1' } }),
      ],
    });
    const { storage, deletedPrefixes } = makeFakeStorage();
    const outcome = await purgeExpiredRecordings(NOW, {}, { store: world.store, storage });
    expect(outcome.purged).toBe(1);
    expect(deletedPrefixes).toEqual([`${TENANT_A}/tx-a1`]);
  });

  it('8c. clip `generating` del mismo programa DENTRO de la ventana del crudo → skip', async () => {
    // Heurística programa+ventana: el clip no trae transmissionId en metadata
    // pero es del mismo programa y se creó mientras el crudo existía.
    const tx = makeTransmission({ id: 'tx-a1', programId: 'prog-1', startedAt: daysAgo(32), endedAt: daysAgo(31) });
    const rec = makeRecording({ id: 'rec-a1', transmissionId: 'tx-a1', storagePrefix: `${TENANT_A}/tx-a1` });
    const world = createMemoryRetentionStore({
      recordings: [rec],
      transmissions: [tx],
      segments: [makeSegment({ recordingId: 'rec-a1' })],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
      clips: [
        makeClip({ id: 'clip-w', programId: 'prog-1', status: 'generating', createdAt: daysAgo(31) }),
      ],
    });
    const { storage, deletedPrefixes } = makeFakeStorage();
    const outcome = await purgeExpiredRecordings(NOW, {}, { store: world.store, storage });
    expect(outcome.skipped).toBe(1);
    expect(deletedPrefixes).toHaveLength(0);
  });

  it('9. dryRun: no borra archivos ni actualiza filas, devuelve los conteos', async () => {
    const { store, state } = seedBase();
    const { storage, deletedPrefixes } = makeFakeStorage();

    const outcome = await purgeExpiredRecordings(NOW, { dryRun: true }, { store, storage });

    expect(outcome).toMatchObject({ scanned: 1, purged: 1, skipped: 0, bytesFreed: 500, errors: [] });
    expect(deletedPrefixes).toHaveLength(0);
    expect(state.segments.map((s) => s.status)).toEqual(['active', 'active']);
    expect(state.transmissions[0].crudoRef).toBe(`${TENANT_A}/tx-a1`);
    expect(state.purges).toHaveLength(0);
  });

  it('10. tenant safety: el UPDATE de segmentos queda acotado por tenant_id', async () => {
    // Segmento "cruzado": mismo recordingId que el de A pero tenantId B.
    // El WHERE tenant_id del UPDATE (replicado por el memory store) NO lo toca.
    const tx = makeTransmission({ id: 'tx-a1' });
    const rec = makeRecording({ id: 'rec-a1', transmissionId: 'tx-a1', storagePrefix: `${TENANT_A}/tx-a1` });
    const world = createMemoryRetentionStore({
      recordings: [rec],
      transmissions: [tx],
      segments: [
        makeSegment({ id: 'seg-a', tenantId: TENANT_A, recordingId: 'rec-a1' }),
        makeSegment({ id: 'seg-cross', tenantId: TENANT_B, recordingId: 'rec-a1', sequence: 99 }),
      ],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
    });
    const { storage } = makeFakeStorage();
    const outcome = await purgeExpiredRecordings(NOW, {}, { store: world.store, storage });

    expect(outcome.purged).toBe(1);
    expect(world.state.segments.find((s) => s.id === 'seg-a')?.status).toBe('purged');
    // La fila de OTRO tenant con el mismo recording_id NO se tocó.
    expect(world.state.segments.find((s) => s.id === 'seg-cross')?.status).toBe('active');
    // Y la purga se registró con el tenant de la grabación, no otro.
    expect(world.state.purges[0].tenantId).toBe(TENANT_A);
  });

  it('una falla NO aborta el job: el error se registra y sigue la próxima', async () => {
    const tx1 = makeTransmission({ id: 'tx-1', crudoRef: 'p/tx-1' });
    const rec1 = makeRecording({ id: 'rec-1', transmissionId: 'tx-1', storagePrefix: 'p/tx-1', totalBytes: 100 });
    const tx2 = makeTransmission({ id: 'tx-2', crudoRef: 'p/tx-2', endedAt: daysAgo(40) });
    const rec2 = makeRecording({ id: 'rec-2', transmissionId: 'tx-2', storagePrefix: 'p/tx-2', totalBytes: 200 });
    const world = createMemoryRetentionStore({
      recordings: [rec1, rec2],
      transmissions: [tx1, tx2],
      segments: [
        makeSegment({ recordingId: 'rec-1' }),
        makeSegment({ recordingId: 'rec-2' }),
      ],
      subscriptions: [{ tenantId: TENANT_A, planId: PLAN_30.id }],
      plans: [PLAN_30],
    });
    // tx-2 es la más vieja (40d) → se purga primero; tx-1 falla el storage.
    const { storage } = makeFakeStorage({ failOn: ['p/tx-1'] });

    const outcome = await purgeExpiredRecordings(NOW, {}, { store: world.store, storage });

    expect(outcome.scanned).toBe(2);
    expect(outcome.purged).toBe(1);
    expect(outcome.errors).toEqual([{ recordingId: 'rec-1', message: 'storage falló en p/tx-1' }]);
    expect(world.state.segments.find((s) => s.recordingId === 'rec-2')?.status).toBe('purged');
    expect(world.state.segments.find((s) => s.recordingId === 'rec-1')?.status).toBe('active');
  });

  it('tenantId del opt: la purga manual sólo toca lo del tenant', async () => {
    const txA = makeTransmission({ id: 'tx-a1', tenantId: TENANT_A, crudoRef: 'a/tx' });
    const recA = makeRecording({ id: 'rec-a1', tenantId: TENANT_A, transmissionId: 'tx-a1', storagePrefix: 'a/tx' });
    const txB = makeTransmission({ id: 'tx-b1', tenantId: TENANT_B, crudoRef: 'b/tx' });
    const recB = makeRecording({ id: 'rec-b1', tenantId: TENANT_B, transmissionId: 'tx-b1', storagePrefix: 'b/tx' });
    const world = createMemoryRetentionStore({
      recordings: [recA, recB],
      transmissions: [txA, txB],
      segments: [
        makeSegment({ recordingId: 'rec-a1', tenantId: TENANT_A }),
        makeSegment({ recordingId: 'rec-b1', tenantId: TENANT_B }),
      ],
      subscriptions: [
        { tenantId: TENANT_A, planId: PLAN_30.id },
        { tenantId: TENANT_B, planId: PLAN_30.id },
      ],
      plans: [PLAN_30],
    });
    const { storage, deletedPrefixes } = makeFakeStorage();

    const outcome = await purgeExpiredRecordings(NOW, { tenantId: TENANT_A }, { store: world.store, storage });

    expect(outcome).toMatchObject({ scanned: 1, purged: 1 });
    expect(deletedPrefixes).toEqual(['a/tx']);
    expect(world.state.segments.find((s) => s.recordingId === 'rec-b1')?.status).toBe('active');
    expect(world.state.transmissions.find((t) => t.id === 'tx-b1')?.crudoRef).toBe('b/tx');
  });
});

// ─── Enganche del job en el scheduler (PD-06, parte 2) ─────────────────────

describe('purga de retención en el tick del scheduler', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['RETENTION_PURGE_ENABLED', 'RETENTION_PURGE_INTERVAL_MINUTES']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function makeSchedulerWorld() {
    const { store, state } = createMemorySchedulerStore({});
    const transitionRun = createMemoryTransitionRunner({
      find: (tenantId, txId) => state.runs.find((r) => r.id === txId && r.tenantId === tenantId),
    });
    const purgeCalls: Date[] = [];
    const deps = {
      store,
      detectLive: async (): Promise<LiveDetectionResult> => ({
        found: false,
        liveUrl: null,
        title: null,
        platform: 'youtube',
        error: 'no live',
      }),
      startRecording: async (): Promise<RecordingHandle> => {
        throw new Error('no debería grabar en este test');
      },
      checkDispatchable: async () => ({ ok: true }),
      transitionRun,
      purgeRetention: async (now: Date) => {
        purgeCalls.push(now);
        return { scanned: 0, purged: 0, skipped: 0, bytesFreed: 0, errors: [] };
      },
    };
    return { deps, state, purgeCalls };
  }

  // El contador de ticks / lastRun de la fase C viven a nivel MÓDULO del
  // scheduler: para aislarlos, cada test re-importa el módulo fresco.
  async function freshScheduler() {
    vi.resetModules();
    return import('../src/server/services/transmissionSchedulerService');
  }

  it('corre la purga en el primer tick (catch-up post-boot) y no en el siguiente', async () => {
    const { checkAndRunScheduledTransmissions: tick } = await freshScheduler();
    const w = makeSchedulerWorld();
    const now = () => new Date(T0);
    await tick({ now, deps: w.deps });
    expect(w.purgeCalls).toHaveLength(1);

    // Segundo tick inmediato: ni el contador ni el reloj vencieron → no corre.
    await tick({ now, deps: w.deps });
    expect(w.purgeCalls).toHaveLength(1);
  });

  it('respeta RETENTION_PURGE_INTERVAL_MINUTES y RETENTION_PURGE_ENABLED', async () => {
    const { checkAndRunScheduledTransmissions: tick } = await freshScheduler();
    const w = makeSchedulerWorld();
    let nowMs = T0;
    const now = () => new Date(nowMs);

    // Primer tick del proceso: catch-up → corre.
    await tick({ now, deps: w.deps });
    expect(w.purgeCalls).toHaveLength(1);

    // Intervalo corto: 2 minutos ⇒ vencen los DOS guardias: 2 ticks Y 2 min.
    process.env.RETENTION_PURGE_INTERVAL_MINUTES = '2';
    nowMs += 3 * 60_000;
    await tick({ now, deps: w.deps }); // tick 2: contador=1 < 2 → no corre
    expect(w.purgeCalls).toHaveLength(1);
    await tick({ now, deps: w.deps }); // tick 3: contador=2, reloj=3min → corre
    expect(w.purgeCalls).toHaveLength(2);

    // Apagada por env: aunque venza todo, no corre.
    process.env.RETENTION_PURGE_ENABLED = 'false';
    nowMs += 10 * 60_000;
    await tick({ now, deps: w.deps });
    await tick({ now, deps: w.deps });
    expect(w.purgeCalls).toHaveLength(2);
  });

  it('una purga que lanza no tumba el scheduler', async () => {
    const { checkAndRunScheduledTransmissions: tick } = await freshScheduler();
    const w = makeSchedulerWorld();
    w.deps.purgeRetention = async () => {
      throw new Error('DB caída');
    };
    const now = () => new Date(T0);
    await expect(tick({ now, deps: w.deps })).resolves.toBeUndefined();
  });
});
