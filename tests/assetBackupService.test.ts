/**
 * Tests del slice PI-05: `assetBackupService.ts` (espejo incremental de
 * assets derivados + manifest `asset_backup_entries`), su handler
 * `backup.sync` en `jobQueueWorker` y su fase D en
 * `transmissionSchedulerService`.
 *
 * Deterministas: sin DB real, sin storage real, sin timers. El `now` es
 * inyectado; `BackupStore` corre sobre `memoryBackupStore` con los MISMOS
 * filtros que el drizzle (dedupe por (tenant, source_path) incluido) y los
 * dos `BackupStorage` son fakes en memoria (la fuente precargada, el
 * destino que registra `writeFile`).
 *
 * Casos obligatorios del brief (numerados como ahí):
 *   1. Primera corrida copia todo (entries `backed_up` + checksum).
 *   2. Segunda corrida es no-op (size+mtime iguales → `skipped`).
 *   3. Archivo nuevo se copia en la corrida siguiente.
 *   4. `dryRun` no escribe archivos ni manifest, pero devuelve conteos.
 *   5. Tenant A no ve ni toca lo de tenant B (aislamiento por tenant).
 *   6. Un error en un asset no aborta el job (va a `errors[]` y sigue).
 *
 * Extras: fuente ausente → `missing` sin pisar el último respaldo bueno;
 * modificación (mtime/size) → re-copia; `resolveSourceKey` (absoluta,
 * `output/` prefijada, nombre suelto, traversal); fuera de raíz → `errors`;
 * `getBackupStatus` cobertura por tenant + lastRunAt; el handler
 * `backup.sync` llama con tenantId + dryRun:false; fase D del scheduler
 * (catch-up primer tick, intervalo por env, flag de apagado).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock parcial del módulo DB (importarlo crea un Pool Neon y pediría
// DATABASE_URL): se preserva el resto de exports y se reemplaza `db`.
vi.mock('../src/server/db/index.js', async (io) => ({
  ...(await io()),
  db: {},
}));

import path from 'node:path';
import {
  getBackupStatus,
  resolveSourceKey,
  syncAssetBackups,
  type BackupEntry,
  type BackupStorage,
} from '../src/server/services/assetBackupService';
import { createBackupSyncHandler } from '../src/server/services/jobQueueWorker';
import type { LiveDetectionResult } from '../src/server/services/liveDetectorService';
import type { RecordingHandle } from '../src/server/services/streamRecorderService';
import type { JobQueueJob } from '../src/server/services/jobQueueService';
import {
  createMemoryBackupStore,
  type MemoryClipAssetRow,
  type MemoryPublicationAssetRow,
} from './helpers/memoryBackupStore';
import { createMemorySchedulerStore } from './helpers/memorySchedulerStore';
import { createMemoryTransitionRunner } from './helpers/memoryTransitionRunner';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0); // 2026-11-11 12:00 UTC
const NOW = new Date(T0);

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

// ─── Fakes de storage ────────────────────────────────────────────────────────

interface FakeFile {
  data: Buffer;
  mtimeMs: number;
}

/**
 * BackupStorage fake: la FUENTE se precarga con archivos (key → contenido +
 * mtime); el DESTINO registra `writeFile`. `failOn` hace fallar stat/read/
 * write de las keys listadas (test de error-no-aborta).
 */
function makeFakeStorage(
  files: Record<string, { data?: Buffer | string; mtimeMs?: number }> = {},
  opts: { failOn?: string[] } = {},
) {
  const map = new Map<string, FakeFile>();
  for (const [key, f] of Object.entries(files)) {
    map.set(key, {
      data: typeof f.data === 'string' ? Buffer.from(f.data) : (f.data ?? Buffer.alloc(4)),
      mtimeMs: f.mtimeMs ?? T0 - 60_000,
    });
  }
  const writes: Array<{ key: string; data: Buffer }> = [];
  const failOn = new Set(opts.failOn ?? []);
  const storage: BackupStorage = {
    async writeFile(key, data) {
      if (failOn.has(key)) throw new Error(`write falló en ${key}`);
      writes.push({ key, data });
      map.set(key, { data, mtimeMs: T0 });
    },
    async readFile(key) {
      if (failOn.has(key)) throw new Error(`read falló en ${key}`);
      const f = map.get(key);
      if (!f) throw new Error(`no existe ${key}`);
      return f.data;
    },
    async statFile(key) {
      if (failOn.has(key)) throw new Error(`stat falló en ${key}`);
      const f = map.get(key);
      return f ? { size: f.data.length, mtimeMs: f.mtimeMs } : null;
    },
    async deletePrefix() {},
    async exists(key) {
      return map.has(key);
    },
    publicPath: (key) => `/fake/${key}`,
  };
  return { storage, map, writes };
}

function makeClip(over: Partial<MemoryClipAssetRow> = {}): MemoryClipAssetRow {
  return {
    id: id('clip'),
    tenantId: TENANT_A,
    videoPath: `output/clip_${id('v')}.mp4`,
    ...over,
  };
}

function makePub(
  over: Partial<MemoryPublicationAssetRow> = {},
): MemoryPublicationAssetRow {
  return { id: id('pub'), tenantId: TENANT_A, ...over };
}

function makeEntry(over: Partial<BackupEntry> = {}): BackupEntry {
  return {
    tenantId: TENANT_A,
    sourcePath: 'output/x.mp4',
    sourceRef: 'clip:c1:video_path',
    backupPath: `${TENANT_A}/x.mp4`,
    bytes: 4,
    sourceMtimeMs: T0 - 60_000,
    checksum: 'abc',
    status: 'backed_up',
    lastError: null,
    backedUpAt: new Date(T0 - 3_600_000),
    ...over,
  };
}

/** Seed típico: un clip con video+subs y una publicación con imagen+flyer. */
function seedBase() {
  return createMemoryBackupStore({
    clips: [
      makeClip({
        id: 'clip-1',
        videoPath: 'output/clip_1.mp4',
        subtitlesPath: 'output/clip_1_sub.mp4',
      }),
    ],
    publications: [
      makePub({
        id: 'pub-1',
        imagePath: 'output/img_1.png',
        flyerPaths: ['output/flyer_1.jpg'],
      }),
    ],
  });
}

const SOURCE_FILES = {
  'clip_1.mp4': { data: 'video-1' },
  'clip_1_sub.mp4': { data: 'subs-1' },
  'img_1.png': { data: 'img-1' },
  'flyer_1.jpg': { data: 'flyer-1' },
};

// ─── 1-3. El sync incremental ────────────────────────────────────────────────

describe('syncAssetBackups', () => {
  it('1. primera corrida copia todo: backup escrito, manifest backed_up con checksum', async () => {
    const { store, state } = seedBase();
    const source = makeFakeStorage(SOURCE_FILES);
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      {},
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome).toMatchObject({
      scanned: 4,
      copied: 4,
      skipped: 0,
      missing: 0,
      bytesCopied:
        'video-1'.length + 'subs-1'.length + 'img-1'.length + 'flyer-1'.length,
      errors: [],
    });
    // Las 4 keys tenant-scoped se escribieron en el backup.
    expect(writes(backup).sort()).toEqual(
      [
        `${TENANT_A}/clip_1.mp4`,
        `${TENANT_A}/clip_1_sub.mp4`,
        `${TENANT_A}/img_1.png`,
        `${TENANT_A}/flyer_1.jpg`,
      ].sort(),
    );
    // Manifest: 4 entradas backed_up del tenant con checksum sha256.
    expect(state.entries.size).toBe(4);
    const clipEntry = state.entries.get(`${TENANT_A}output/clip_1.mp4`)!;
    expect(clipEntry).toMatchObject({
      tenantId: TENANT_A,
      sourcePath: 'output/clip_1.mp4',
      sourceRef: 'clip:clip-1:video_path',
      backupPath: `${TENANT_A}/clip_1.mp4`,
      bytes: 'video-1'.length,
      status: 'backed_up',
      lastError: null,
    });
    expect(clipEntry.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(clipEntry.backedUpAt).toEqual(NOW);
  });

  it('2. segunda corrida es no-op: size+mtime iguales → skipped, nada se escribe', async () => {
    const { store, state } = seedBase();
    const source = makeFakeStorage(SOURCE_FILES);
    const backup = makeFakeStorage();
    const deps = { store, source: source.storage, backup: backup.storage };

    await syncAssetBackups(NOW, {}, deps);
    const outcome = await syncAssetBackups(new Date(T0 + 60_000), {}, deps);

    expect(outcome).toMatchObject({ scanned: 4, copied: 0, skipped: 4, missing: 0, errors: [] });
    expect(backup.writes).toHaveLength(4); // sólo los de la primera corrida
    expect(state.entries.size).toBe(4);
  });

  it('3. archivo nuevo en la fila origen se copia en la corrida siguiente', async () => {
    const { store, state } = seedBase();
    const source = makeFakeStorage(SOURCE_FILES);
    const backup = makeFakeStorage();
    const deps = { store, source: source.storage, backup: backup.storage };

    await syncAssetBackups(NOW, {}, deps);

    // Un flyer nuevo aparece en la publicación + el archivo en disco.
    state.publications[0].flyerPaths!.push('output/flyer_2.jpg');
    source.map.set('flyer_2.jpg', { data: Buffer.from('flyer-2'), mtimeMs: T0 });

    const outcome = await syncAssetBackups(new Date(T0 + 60_000), {}, deps);

    expect(outcome).toMatchObject({ scanned: 5, copied: 1, skipped: 4, errors: [] });
    expect(backup.writes.map((w) => w.key)).toContain(`${TENANT_A}/flyer_2.jpg`);
    expect(state.entries.get(`${TENANT_A}output/flyer_2.jpg`)?.status).toBe('backed_up');
  });

  it('un archivo MODIFICADO (mtime o size) se re-copia; igual no-op si nada cambió', async () => {
    const { store } = createMemoryBackupStore({
      clips: [makeClip({ id: 'clip-1', videoPath: 'output/clip_1.mp4' })],
    });
    const source = makeFakeStorage({ 'clip_1.mp4': { data: 'video-1', mtimeMs: T0 - 60_000 } });
    const backup = makeFakeStorage();
    const deps = { store, source: source.storage, backup: backup.storage };

    await syncAssetBackups(NOW, {}, deps);

    // Cambia el contenido y el mtime → re-copia.
    source.map.set('clip_1.mp4', { data: Buffer.from('video-1-V2!'), mtimeMs: T0 });
    const outcome = await syncAssetBackups(new Date(T0 + 60_000), {}, deps);
    expect(outcome).toMatchObject({ copied: 1, skipped: 0 });
    expect(backup.writes).toHaveLength(2);
    expect(backup.map.get(`${TENANT_A}/clip_1.mp4`)!.data.toString()).toBe('video-1-V2!');
  });

  it('4. dryRun: no escribe backup ni manifest, devuelve lo que haría', async () => {
    const { store, state } = seedBase();
    const source = makeFakeStorage(SOURCE_FILES);
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      { dryRun: true },
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome).toMatchObject({ scanned: 4, copied: 4, skipped: 0, missing: 0, errors: [] });
    expect(backup.writes).toHaveLength(0);
    expect(state.entries.size).toBe(0);
    expect(state.writes).toHaveLength(0);
  });

  it('5. tenant A no ve ni toca lo del tenant B (scan acotado + keys por tenant)', async () => {
    const { store, state } = createMemoryBackupStore({
      clips: [
        makeClip({ id: 'clip-a', tenantId: TENANT_A, videoPath: 'output/clip_a.mp4' }),
        makeClip({ id: 'clip-b', tenantId: TENANT_B, videoPath: 'output/clip_b.mp4' }),
      ],
      publications: [makePub({ id: 'pub-b', tenantId: TENANT_B, imagePath: 'output/img_b.png' })],
    });
    const source = makeFakeStorage({
      'clip_a.mp4': { data: 'A' },
      'clip_b.mp4': { data: 'B' },
      'img_b.png': { data: 'B2' },
    });
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      { tenantId: TENANT_A },
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome).toMatchObject({ scanned: 1, copied: 1 });
    expect(backup.writes.map((w) => w.key)).toEqual([`${TENANT_A}/clip_a.mp4`]);
    // Nada del tenant B quedó en el manifest ni en el backup.
    expect(state.entries.size).toBe(1);
    expect([...state.entries.keys()].every((k) => k.startsWith(TENANT_A))).toBe(true);
    expect(backup.map.has(`${TENANT_B}/clip_b.mp4`)).toBe(false);
  });

  it('5b. corrida global respeta el tenant de CADA fila (backup_path tenant-scoped)', async () => {
    const { store, state } = createMemoryBackupStore({
      clips: [
        makeClip({ id: 'clip-a', tenantId: TENANT_A, videoPath: 'output/clip_a.mp4' }),
        makeClip({ id: 'clip-b', tenantId: TENANT_B, videoPath: 'output/clip_b.mp4' }),
      ],
    });
    const source = makeFakeStorage({ 'clip_a.mp4': { data: 'A' }, 'clip_b.mp4': { data: 'B' } });
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(NOW, {}, { store, source: source.storage, backup: backup.storage });

    expect(outcome.copied).toBe(2);
    // Cada archivo quedó bajo el prefijo de SU tenant — regla dura cumplida
    // aunque el job corra global.
    expect(writes(backup).sort()).toEqual(
      [`${TENANT_A}/clip_a.mp4`, `${TENANT_B}/clip_b.mp4`].sort(),
    );
    expect(state.entries.get(`${TENANT_B}output/clip_b.mp4`)?.tenantId).toBe(TENANT_B);
  });

  it('6. un error en un asset NO aborta el job: va a errors[] y sigue', async () => {
    const { store, state } = createMemoryBackupStore({
      clips: [
        makeClip({ id: 'clip-ok', videoPath: 'output/ok.mp4' }),
        makeClip({ id: 'clip-bad', videoPath: 'output/bad.mp4' }),
      ],
    });
    const source = makeFakeStorage({ 'ok.mp4': { data: 'ok' } }, { failOn: ['bad.mp4'] });
    source.map.set('bad.mp4', { data: Buffer.from('bad'), mtimeMs: T0 });
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      {},
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome.scanned).toBe(2);
    expect(outcome.copied).toBe(1);
    expect(outcome.errors).toEqual([
      { sourcePath: 'output/bad.mp4', message: 'stat falló en bad.mp4' },
    ]);
    // El sano se copió y el fallido quedó 'error' en el manifest para reintentar.
    expect(state.entries.get(`${TENANT_A}output/ok.mp4`)?.status).toBe('backed_up');
    expect(state.entries.get(`${TENANT_A}output/bad.mp4`)?.status).toBe('error');
  });

  it('fuente ausente en disco → missing, conserva el último respaldo bueno', async () => {
    const { store, state } = createMemoryBackupStore({
      clips: [makeClip({ id: 'clip-1', videoPath: 'output/gone.mp4' })],
      entries: [
        makeEntry({
          sourcePath: 'output/gone.mp4',
          backupPath: `${TENANT_A}/gone.mp4`,
          bytes: 99,
          checksum: 'deadbeef',
        }),
      ],
    });
    const source = makeFakeStorage(); // vacío: el archivo ya no existe
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      {},
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome).toMatchObject({ scanned: 1, copied: 0, missing: 1 });
    const e = state.entries.get(`${TENANT_A}output/gone.mp4`)!;
    expect(e.status).toBe('missing');
    // bytes/checksum describen el último respaldo bueno, no la fuente ausente.
    expect(e.bytes).toBe(99);
    expect(e.checksum).toBe('deadbeef');
    expect(e.backedUpAt).toEqual(NOW);
  });

  it('path fuera de la raíz derivada → errors[], no se copia', async () => {
    const { store } = createMemoryBackupStore({
      clips: [makeClip({ id: 'clip-x', videoPath: '../secret/key.pem' })],
    });
    const source = makeFakeStorage();
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      {},
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome.copied).toBe(0);
    expect(outcome.errors[0].message).toContain('fuera de la raíz');
    expect(backup.writes).toHaveLength(0);
  });

  it('metadata.sourceVideoPath (render anterior auditable) también se respalda', async () => {
    const { store } = createMemoryBackupStore({
      clips: [
        makeClip({
          id: 'clip-1',
          videoPath: 'output/clip_1_916.mp4',
          sourceVideoPath: 'output/clip_1.mp4',
        }),
      ],
    });
    const source = makeFakeStorage({
      'clip_1.mp4': { data: 'original' },
      'clip_1_916.mp4': { data: 'reframed' },
    });
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      {},
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome.copied).toBe(2);
    expect(writes(backup).sort()).toEqual(
      [`${TENANT_A}/clip_1.mp4`, `${TENANT_A}/clip_1_916.mp4`].sort(),
    );
  });

  it('dos refs al mismo archivo dedupan dentro de la corrida', async () => {
    const { store } = createMemoryBackupStore({
      clips: [
        // El mismo path llega como video_path Y como flyer de una pub.
        makeClip({ id: 'clip-1', videoPath: 'output/shared.jpg' }),
      ],
      publications: [makePub({ id: 'pub-1', imagePath: 'output/shared.jpg' })],
    });
    const source = makeFakeStorage({ 'shared.jpg': { data: 'x' } });
    const backup = makeFakeStorage();

    const outcome = await syncAssetBackups(
      NOW,
      {},
      { store, source: source.storage, backup: backup.storage },
    );

    expect(outcome.scanned).toBe(1);
    expect(outcome.copied).toBe(1);
    expect(backup.writes).toHaveLength(1);
  });
});

function writes(fake: { writes: Array<{ key: string }> }): string[] {
  return fake.writes.map((w) => w.key);
}

// ─── resolveSourceKey ────────────────────────────────────────────────────────

describe('resolveSourceKey', () => {
  const root = path.resolve('output');

  it('relativa con prefijo output/ → quita el prefijo', () => {
    expect(resolveSourceKey('output/clip_1.mp4', root)).toBe('clip_1.mp4');
  });

  it('nombre suelto → se conserva', () => {
    expect(resolveSourceKey('clip_1.mp4', root)).toBe('clip_1.mp4');
  });

  it('absoluta bajo la raíz → relativa', () => {
    expect(resolveSourceKey(path.join(root, 'sub', 'x.mp4'), root)).toBe('sub/x.mp4');
  });

  it('absoluta fuera de la raíz → null', () => {
    expect(resolveSourceKey(path.resolve('data', 'raw', 'seg.mp4'), root)).toBeNull();
  });

  it('path traversal relativo → null', () => {
    expect(resolveSourceKey('../x', root)).toBeNull();
    expect(resolveSourceKey('output/../x', root)).toBeNull();
  });

  it('vacía → null', () => {
    expect(resolveSourceKey('', root)).toBeNull();
  });
});

// ─── getBackupStatus ─────────────────────────────────────────────────────────

describe('getBackupStatus', () => {
  it('cobertura por tenant: entries/bytes sólo backed_up + missing/errors aparte', async () => {
    const { store } = createMemoryBackupStore({
      entries: [
        makeEntry({ tenantId: TENANT_A, sourcePath: 'a/1', bytes: 10 }),
        makeEntry({ tenantId: TENANT_A, sourcePath: 'a/2', bytes: 20 }),
        makeEntry({ tenantId: TENANT_A, sourcePath: 'a/3', status: 'missing', bytes: 5 }),
        makeEntry({ tenantId: TENANT_B, sourcePath: 'b/1', status: 'error', bytes: 0 }),
        makeEntry({
          tenantId: TENANT_B,
          sourcePath: 'b/2',
          bytes: 7,
          backedUpAt: new Date(T0 + 60_000),
        }),
      ],
    });

    const status = await getBackupStatus({}, { store });

    expect(status.tenants).toHaveLength(2);
    const a = status.tenants.find((t) => t.tenantId === TENANT_A)!;
    const b = status.tenants.find((t) => t.tenantId === TENANT_B)!;
    expect(a).toMatchObject({ entries: 2, bytes: 30, missing: 1, errors: 0 });
    expect(b).toMatchObject({ entries: 1, bytes: 7, missing: 0, errors: 1 });
    // lastRunAt = el backed_up_at más reciente de TODAS las entradas.
    expect(status.lastRunAt).toEqual(new Date(T0 + 60_000));
  });

  it('tenantId acota la cobertura a ese tenant', async () => {
    const { store } = createMemoryBackupStore({
      entries: [
        makeEntry({ tenantId: TENANT_A, sourcePath: 'a/1' }),
        makeEntry({ tenantId: TENANT_B, sourcePath: 'b/1' }),
      ],
    });
    const status = await getBackupStatus({ tenantId: TENANT_A }, { store });
    expect(status.tenants).toHaveLength(1);
    expect(status.tenants[0].tenantId).toBe(TENANT_A);
  });
});

// ─── Handler backup.sync (job_queue) ─────────────────────────────────────────

describe('backup.sync en jobQueueWorker', () => {
  it('el seed llama syncAssetBackups con tenantId del job + dryRun:false', async () => {
    const calls: Array<{ opts: unknown }> = [];
    const handler = createBackupSyncHandler(async (_now, opts) => {
      calls.push({ opts });
      return { scanned: 0, copied: 0, skipped: 0, missing: 0, bytesCopied: 0, errors: [] };
    });
    const job = { tenantId: TENANT_A, kind: 'backup.sync' } as JobQueueJob;
    await handler(job);
    expect(calls).toEqual([{ opts: { tenantId: TENANT_A, dryRun: false } }]);
  });
});

// ─── Fase D del scheduler ────────────────────────────────────────────────────

describe('backup de assets en el tick del scheduler', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['BACKUP_SYNC_ENABLED', 'BACKUP_SYNC_INTERVAL_MINUTES']) {
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
    const backupCalls: Date[] = [];
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
      purgeRetention: async () => ({
        scanned: 0, purged: 0, skipped: 0, bytesFreed: 0, errors: [],
      }),
      syncBackup: async (now: Date) => {
        backupCalls.push(now);
        return { scanned: 0, copied: 0, skipped: 0, missing: 0, bytesCopied: 0, errors: [] };
      },
    };
    return { deps, backupCalls };
  }

  // Los contadores de las fases C/D viven a nivel MÓDULO del scheduler:
  // cada test re-importa el módulo fresco para aislarlos.
  async function freshScheduler() {
    vi.resetModules();
    return import('../src/server/services/transmissionSchedulerService');
  }

  it('corre el backup en el primer tick (catch-up post-boot) y no en el siguiente', async () => {
    const { checkAndRunScheduledTransmissions: tick } = await freshScheduler();
    const w = makeSchedulerWorld();
    const now = () => new Date(T0);
    await tick({ now, deps: w.deps });
    expect(w.backupCalls).toHaveLength(1);

    await tick({ now, deps: w.deps });
    expect(w.backupCalls).toHaveLength(1);
  });

  it('respeta BACKUP_SYNC_INTERVAL_MINUTES y BACKUP_SYNC_ENABLED', async () => {
    const { checkAndRunScheduledTransmissions: tick } = await freshScheduler();
    const w = makeSchedulerWorld();
    let nowMs = T0;
    const now = () => new Date(nowMs);

    await tick({ now, deps: w.deps });
    expect(w.backupCalls).toHaveLength(1);

    process.env.BACKUP_SYNC_INTERVAL_MINUTES = '2';
    nowMs += 3 * 60_000;
    await tick({ now, deps: w.deps }); // contador=1 < 2 → no corre
    expect(w.backupCalls).toHaveLength(1);
    await tick({ now, deps: w.deps }); // contador=2, reloj=3min → corre
    expect(w.backupCalls).toHaveLength(2);

    process.env.BACKUP_SYNC_ENABLED = 'false';
    nowMs += 10 * 60_000;
    await tick({ now, deps: w.deps });
    await tick({ now, deps: w.deps });
    expect(w.backupCalls).toHaveLength(2);
  });

  it('un backup que lanza no tumba el scheduler', async () => {
    const { checkAndRunScheduledTransmissions: tick } = await freshScheduler();
    const w = makeSchedulerWorld();
    w.deps.syncBackup = async () => {
      throw new Error('storage caído');
    };
    const now = () => new Date(T0);
    await expect(tick({ now, deps: w.deps })).resolves.toBeUndefined();
  });
});
