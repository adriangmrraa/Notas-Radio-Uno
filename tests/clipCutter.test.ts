/**
 * Tests del slice PF-01: `clipCutterService.ts` (corte de ventana del crudo
 * real con ffmpeg) sobre `memoryClipCutterStore`.
 *
 * Deterministas: sin DB real, sin ffmpeg real, sin storage real. El store
 * corre en memoria con los MISMOS filtros por tenant que el drizzle; el
 * `runFfmpeg` stub captura los args y "produce" el archivo esperado (el
 * último arg = output `-y`) para que el videoPath exista en disco; el
 * storage fake resuelve `publicPath(key)` a una ruta predecible.
 *
 * Casos obligatorios del brief:
 *   1. Ventana dentro de UN segmento → 1 tramo, args ffmpeg correctos
 *      (`-ss` RELATIVO AL ARCHIVO), clip registrado.
 *   2. Ventana que cruza 2 segmentos → 2 tramos + concat, offsets
 *      relativos correctos por tramo.
 *   3. Ventana fuera de rango → error tipado, NO crea clip.
 *   4. ffmpeg que falla → error controlado (fila queda 'error').
 *   5. Aislamiento por tenant en las queries del store.
 *
 * Extras: ventana inválida, duración sobre el tope (default ~120 s y
 * override), hueco de cobertura en el medio de la ventana, segmento aún
 * grabando (`end_ms` null = cobertura abierta), limpieza de temporales.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock parcial del módulo DB (importarlo crea un Pool Neon y pediría
// DATABASE_URL): se preserva el resto de exports y se reemplaza `db`.
vi.mock('../src/server/db/index.js', async (io) => ({
  ...(await io()),
  db: {},
}));

import {
  ClipCutterError,
  buildConcatArgs,
  buildPartArgs,
  createClipCutterService,
  msToSec,
  resolveWindowParts,
} from '../src/server/services/clipCutterService';
import type { RawStorage } from '../src/server/services/rawStorageService';
import { createMemoryClipCutterStore } from './helpers/memoryClipCutterStore';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const TX_A = '11111111-1111-4111-8111-111111111111';
const REC_A = '22222222-2222-4222-8222-222222222222';
const PREFIX_A = `${TENANT_A}/${TX_A}`;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

let workDir: string;
let tempDir: string;
let outputDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf01-test-'));
  tempDir = path.join(workDir, 'tmp');
  outputDir = path.join(workDir, 'output');
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** RawStorage fake: publicPath = <root>/<key>; el resto no se usa. */
function makeFakeStorage() {
  const root = path.join(workDir, 'raw');
  const storage: RawStorage = {
    writeFile: async () => {},
    readFile: async () => Buffer.alloc(0),
    statFile: async () => null,
    deleteFile: async () => {},
    deletePrefix: async () => {},
    exists: async () => true,
    publicPath: (key) => path.join(root, key),
  };
  return { storage, root };
}

/**
 * ffmpeg stub: registra cada invocación (args completos) y escribe un MP4
 * falso en la ruta output (último arg tras `-y`). Puede fallar a pedido en
 * la llamada N (`failOnCalls`, 1-based) con `error`.
 */
function makeFakeFfmpeg(opts: { failOnCalls?: number[] } = {}) {
  const calls: string[][] = [];
  const failOn = new Set(opts.failOnCalls ?? []);
  const runFfmpeg = async (args: string[]) => {
    calls.push([...args]);
    if (failOn.has(calls.length)) {
      throw new Error('boom: simulated ffmpeg exit 1');
    }
    const outputPath = args[args.length - 1];
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from('FAKE-MP4'));
  };
  return { runFfmpeg, calls };
}

/** Valor que sigue a un flag en un array de args (`-ss` → '12.000'). */
function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Fixture: corrida de TENANT_A con grabación y N segmentos activos. */
function seedTxWithSegments(
  segments: Array<{ sequence: number; startMs: number; endMs: number | null; fileRef?: string }>,
) {
  return createMemoryClipCutterStore({
    transmissions: [
      {
        id: TX_A,
        tenantId: TENANT_A,
        programId: 'prog-1',
        status: 'done',
        startedAt: new Date(T0),
      },
    ],
    recordings: [
      {
        id: REC_A,
        tenantId: TENANT_A,
        transmissionId: TX_A,
        storagePrefix: PREFIX_A,
        status: 'completed',
      },
    ],
    segments: segments.map((s) => ({
      id: `seg-${s.sequence}`,
      tenantId: TENANT_A,
      recordingId: REC_A,
      sequence: s.sequence,
      startMs: s.startMs,
      endMs: s.endMs,
      fileRef: s.fileRef ?? `seg-0000${s.sequence}.mp4`,
      status: 'active',
    })),
  });
}

function makeService(store: ReturnType<typeof createMemoryClipCutterStore>['store']) {
  const { storage, root } = makeFakeStorage();
  const ffmpeg = makeFakeFfmpeg();
  const service = createClipCutterService(store, {
    runFfmpeg: ffmpeg.runFfmpeg,
    storage,
    tempDir,
    outputDir,
    newId: () => 'fixeduid',
  });
  return { service, ffmpeg, storageRoot: root };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('clipCutterService.cutRawWindow', () => {
  it('ventana dentro de UN segmento → 1 tramo, -ss relativo al archivo, clip registrado', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
    ]);
    const { service, ffmpeg, storageRoot } = makeService(store);

    const res = await service.cutRawWindow({
      tenantId: TENANT_A,
      transmissionId: TX_A,
      startMs: 10_000,
      endMs: 25_000,
    });

    // Un solo ffmpeg (camino rápido), directo al output final.
    expect(ffmpeg.calls).toHaveLength(1);
    const args = ffmpeg.calls[0];
    expect(argAfter(args, '-ss')).toBe('10.000'); // 10s - 0s del segmento
    expect(argAfter(args, '-i')).toBe(path.join(storageRoot, `${PREFIX_A}/seg-00000.mp4`));
    expect(argAfter(args, '-t')).toBe('15.000');
    expect(args).not.toContain('-f'); // sin concat demuxer
    expect(args[args.length - 1]).toBe(res.videoPath);

    // Resultado + fila registrada.
    expect(res.segmentsUsed).toBe(1);
    expect(res.durationSec).toBe(15);
    const clip = state.clips.find((c) => c.id === res.clipId);
    expect(clip).toBeDefined();
    expect(clip!.tenantId).toBe(TENANT_A);
    expect(clip!.transmissionId).toBe(TX_A);
    expect(clip!.programId).toBe('prog-1');
    expect(clip!.status).toBe('pending_review');
    expect(clip!.videoPath).toBe(res.videoPath);
    expect(clip!.duration).toBe(15);
    expect(clip!.metadata).toMatchObject({
      transmissionId: TX_A,
      window: { startMs: 10_000, endMs: 25_000 },
      sourceSegments: [`${PREFIX_A}/seg-00000.mp4`],
      strategy: 'single',
    });

    // El MP4 existe en disco (lo escribió el stub) bajo outputDir.
    const stat = await fs.stat(res.videoPath);
    expect(stat.isFile()).toBe(true);
    expect(path.dirname(res.videoPath)).toBe(outputDir);
  });

  it('ventana que cruza 2 segmentos → 2 tramos + concat con offsets relativos correctos', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
      { sequence: 1, startMs: 60_000, endMs: 120_000 },
    ]);
    const { service, ffmpeg, storageRoot } = makeService(store);

    // [50s, 80s): tramo1 = seg0[50s..60s), tramo2 = seg1[0s..20s).
    const res = await service.cutRawWindow({
      tenantId: TENANT_A,
      transmissionId: TX_A,
      startMs: 50_000,
      endMs: 80_000,
    });

    expect(res.segmentsUsed).toBe(2);
    expect(res.durationSec).toBe(30);
    expect(ffmpeg.calls).toHaveLength(3); // tramo0, tramo1, concat

    // Tramo 1: -ss 50s dentro de seg-00000.mp4, -t 10s.
    const part0 = ffmpeg.calls[0];
    expect(argAfter(part0, '-ss')).toBe('50.000');
    expect(argAfter(part0, '-i')).toBe(path.join(storageRoot, `${PREFIX_A}/seg-00000.mp4`));
    expect(argAfter(part0, '-t')).toBe('10.000');

    // Tramo 2: -ss 0s dentro de seg-00001.mp4, -t 20s.
    const part1 = ffmpeg.calls[1];
    expect(argAfter(part1, '-ss')).toBe('0.000');
    expect(argAfter(part1, '-i')).toBe(path.join(storageRoot, `${PREFIX_A}/seg-00001.mp4`));
    expect(argAfter(part1, '-t')).toBe('20.000');

    // Concat: demuxer + copia sin re-encode, output = videoPath final.
    const concat = ffmpeg.calls[2];
    expect(argAfter(concat, '-f')).toBe('concat');
    expect(argAfter(concat, '-safe')).toBe('0');
    expect(argAfter(concat, '-c')).toBe('copy');
    expect(concat[concat.length - 1]).toBe(res.videoPath);
    const listPath = argAfter(concat, '-i')!;
    expect(listPath).toContain('pf01-concat-fixeduid.txt');

    // Temporales limpiados en el finally (tramos + lista).
    expect(existsSync(listPath)).toBe(false);
    const leftovers = await fs.readdir(tempDir).catch(() => []);
    expect(leftovers).toEqual([]);

    const clip = state.clips.find((c) => c.id === res.clipId)!;
    expect(clip.status).toBe('pending_review');
    expect(clip.metadata).toMatchObject({
      window: { startMs: 50_000, endMs: 80_000 },
      sourceSegments: [`${PREFIX_A}/seg-00000.mp4`, `${PREFIX_A}/seg-00001.mp4`],
      strategy: 'concat',
    });
  });

  it('ventana fuera de rango → window_out_of_range, no crea clip ni corre ffmpeg', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
    ]);
    const { service, ffmpeg } = makeService(store);

    const err = await service
      .cutRawWindow({
        tenantId: TENANT_A,
        transmissionId: TX_A,
        startMs: 50_000,
        endMs: 90_000, // el crudo termina en 60s
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipCutterError);
    expect(err.reason).toBe('window_out_of_range');
    expect(state.clips).toHaveLength(0); // nada queda a medias
    expect(ffmpeg.calls).toHaveLength(0);
  });

  it('hueco de cobertura en el medio de la ventana → window_out_of_range', async () => {
    // Segunda captura retomó con delay: hueco [60s, 70s) sin video.
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
      { sequence: 1, startMs: 70_000, endMs: 120_000 },
    ]);
    const { service, ffmpeg } = makeService(store);

    const err = await service
      .cutRawWindow({
        tenantId: TENANT_A,
        transmissionId: TX_A,
        startMs: 50_000,
        endMs: 80_000,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipCutterError);
    expect(err.reason).toBe('window_out_of_range');
    expect(state.clips).toHaveLength(0);
    expect(ffmpeg.calls).toHaveLength(0);
  });

  it('ventana que arranca antes del crudo → window_out_of_range', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 5_000, endMs: 60_000 }, // hay 5s sin grabación
    ]);
    const { service } = makeService(store);

    const err = await service
      .cutRawWindow({ tenantId: TENANT_A, transmissionId: TX_A, startMs: 0, endMs: 10_000 })
      .catch((e) => e);

    expect(err.reason).toBe('window_out_of_range');
    expect(state.clips).toHaveLength(0);
  });

  it('segmento aún grabando (end_ms null) → cobertura abierta, corta igual', async () => {
    const { store } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: null }, // live: archivo en vuelo
    ]);
    const { service, ffmpeg } = makeService(store);

    const res = await service.cutRawWindow({
      tenantId: TENANT_A,
      transmissionId: TX_A,
      startMs: 30_000,
      endMs: 45_000,
    });

    expect(res.segmentsUsed).toBe(1);
    expect(argAfter(ffmpeg.calls[0], '-ss')).toBe('30.000');
    expect(argAfter(ffmpeg.calls[0], '-t')).toBe('15.000');
  });

  it('ffmpeg que falla → ffmpeg_failed tipado y la fila queda error', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
      { sequence: 1, startMs: 60_000, endMs: 120_000 },
    ]);
    const { storage } = makeFakeStorage();
    const ffmpeg = makeFakeFfmpeg({ failOnCalls: [2] }); // falla el 2º tramo
    const service = createClipCutterService(store, {
      runFfmpeg: ffmpeg.runFfmpeg,
      storage,
      tempDir,
      outputDir,
      newId: () => 'fixeduid',
    });

    const err = await service
      .cutRawWindow({
        tenantId: TENANT_A,
        transmissionId: TX_A,
        startMs: 50_000,
        endMs: 80_000,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipCutterError);
    expect(err.reason).toBe('ffmpeg_failed');
    expect(err.message).toContain('simulated ffmpeg exit 1');

    // La fila existe pero quedó 'error' con la razón en metadata (auditable).
    expect(state.clips).toHaveLength(1);
    const clip = state.clips[0];
    expect(clip.status).toBe('error');
    expect(clip.videoPath).toBeNull();
    expect(clip.metadata?.error).toContain('simulated ffmpeg exit 1');

    // Temporales limpiados aun con error (finally).
    const leftovers = await fs.readdir(tempDir).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('ventana inválida (endMs <= startMs) → invalid_window sin tocar nada', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
    ]);
    const { service, ffmpeg } = makeService(store);

    const err = await service
      .cutRawWindow({ tenantId: TENANT_A, transmissionId: TX_A, startMs: 30_000, endMs: 30_000 })
      .catch((e) => e);

    expect(err.reason).toBe('invalid_window');
    expect(state.clips).toHaveLength(0);
    expect(ffmpeg.calls).toHaveLength(0);
  });

  it('duración sobre el tope → duration_exceeded (default 120s; override respeta)', async () => {
    const { store } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 600_000 },
    ]);
    const { service } = makeService(store);

    const err = await service
      .cutRawWindow({ tenantId: TENANT_A, transmissionId: TX_A, startMs: 0, endMs: 121_000 })
      .catch((e) => e);
    expect(err.reason).toBe('duration_exceeded');

    // Con override a 5 min la misma ventana pasa.
    const res = await service.cutRawWindow({
      tenantId: TENANT_A,
      transmissionId: TX_A,
      startMs: 0,
      endMs: 121_000,
      maxDurationMs: 300_000,
    });
    expect(res.durationSec).toBe(121);
  });

  it('corrida sin grabación/segmentos → no_recording', async () => {
    const { store, state } = createMemoryClipCutterStore({
      transmissions: [
        { id: TX_A, tenantId: TENANT_A, programId: null, status: 'done', startedAt: new Date(T0) },
      ],
      recordings: [
        {
          id: REC_A,
          tenantId: TENANT_A,
          transmissionId: TX_A,
          storagePrefix: PREFIX_A,
          status: 'completed',
        },
      ],
      segments: [
        // Un segmento 'purged' no cuenta: el archivo ya no existe.
        { id: 's0', tenantId: TENANT_A, recordingId: REC_A, sequence: 0, startMs: 0, endMs: 60_000, fileRef: 'seg-00000.mp4', status: 'purged' },
      ],
    });
    const { service } = makeService(store);

    const err = await service
      .cutRawWindow({ tenantId: TENANT_A, transmissionId: TX_A, startMs: 0, endMs: 10_000 })
      .catch((e) => e);

    expect(err.reason).toBe('no_recording');
    expect(state.clips).toHaveLength(0);
  });
});

describe('aislamiento por tenant', () => {
  it('la corrida de otro tenant no se encuentra → transmission_not_found', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
    ]);
    const { service, ffmpeg } = makeService(store);

    const err = await service
      .cutRawWindow({
        tenantId: TENANT_B, // TENANT_B pide la corrida de TENANT_A
        transmissionId: TX_A,
        startMs: 0,
        endMs: 10_000,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipCutterError);
    expect(err.reason).toBe('transmission_not_found');
    expect(state.clips).toHaveLength(0);
    expect(ffmpeg.calls).toHaveLength(0);
  });

  it('los segmentos de otro tenant no se listan en la grabación', async () => {
    // Segmento huérfano con tenant B colgado de la grabación de A: el WHERE
    // tenant_id lo excluye igual que el drizzle.
    const { store } = createMemoryClipCutterStore({
      transmissions: [
        { id: TX_A, tenantId: TENANT_A, programId: null, status: 'done', startedAt: new Date(T0) },
      ],
      recordings: [
        { id: REC_A, tenantId: TENANT_A, transmissionId: TX_A, storagePrefix: PREFIX_A, status: 'completed' },
      ],
      segments: [
        { id: 'a0', tenantId: TENANT_A, recordingId: REC_A, sequence: 0, startMs: 0, endMs: 60_000, fileRef: 'seg-00000.mp4', status: 'active' },
        { id: 'b0', tenantId: TENANT_B, recordingId: REC_A, sequence: 1, startMs: 60_000, endMs: 120_000, fileRef: 'evil.mp4', status: 'active' },
      ],
    });

    const recs = await store.listRecordingsWithSegments(TENANT_A, TX_A);
    expect(recs).toHaveLength(1);
    expect(recs[0].segments.map((s) => s.fileRef)).toEqual(['seg-00000.mp4']);

    // Y para TENANT_B la corrida directamente no existe.
    expect(await store.getTransmission(TENANT_B, TX_A)).toBeNull();
    expect(await store.listRecordingsWithSegments(TENANT_B, TX_A)).toEqual([]);
  });

  it('setClipResult acotado por tenant no toca el clip de otro tenant', async () => {
    const { store, state } = seedTxWithSegments([
      { sequence: 0, startMs: 0, endMs: 60_000 },
    ]);
    const { service } = makeService(store);
    const res = await service.cutRawWindow({
      tenantId: TENANT_A,
      transmissionId: TX_A,
      startMs: 0,
      endMs: 10_000,
    });

    // Un patch con el tenant equivocado es un no-op silencioso.
    await store.setClipResult(TENANT_B, res.clipId, {
      status: 'error',
      videoPath: '/tmp/evil.mp4',
    });
    const clip = state.clips.find((c) => c.id === res.clipId)!;
    expect(clip.status).toBe('pending_review');
    expect(clip.videoPath).toBe(res.videoPath);
  });
});

describe('helpers puros', () => {
  it('resolveWindowParts deduplica segmentos solapados por cursor', () => {
    // Cobertura solapada: el segundo segmento pisa lo ya cubierto → su
    // tramo arranca en el cursor, no en el inicio de la ventana.
    const { parts, coveredEndMs } = resolveWindowParts(
      [
        { recordingId: 'r', storagePrefix: 'p', sequence: 0, startMs: 0, endMs: 60_000, fileRef: 'a.mp4' },
        { recordingId: 'r', storagePrefix: 'p', sequence: 1, startMs: 50_000, endMs: 120_000, fileRef: 'b.mp4' },
      ],
      40_000,
      80_000,
    );
    expect(parts).toEqual([
      expect.objectContaining({ fileRef: 'a.mp4', seekMs: 40_000, durationMs: 20_000 }),
      expect.objectContaining({ fileRef: 'b.mp4', seekMs: 10_000, durationMs: 20_000 }),
    ]);
    expect(coveredEndMs).toBe(80_000);
  });

  it('msToSec formatea con 3 decimales', () => {
    expect(msToSec(0)).toBe('0.000');
    expect(msToSec(12_345)).toBe('12.345');
  });

  it('buildPartArgs/buildConcatArgs arman los args documentados', () => {
    const part = buildPartArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', seekMs: 1_500, durationMs: 2_000 });
    expect(part).toContain('libx264');
    expect(argAfter(part, '-ss')).toBe('1.500');
    expect(part[part.length - 2]).toBe('-y');
    const concat = buildConcatArgs({ listPath: '/l.txt', outputPath: '/o.mp4' });
    expect(concat).toContain('-c');
    expect(concat).toContain('copy');
  });
});
