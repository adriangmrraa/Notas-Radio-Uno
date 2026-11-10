/**
 * Tests del slice PF-02: `clipReframeService.ts` (re-encuadre 9:16
 * inteligente de un clip existente) sobre `memoryReframeStore` + wiring del
 * `clipRenderWorker` para `kind: 'reframe'`.
 *
 * Deterministas: sin DB real (store en memoria con los MISMOS filtros por
 * tenant que el drizzle), sin ffmpeg (el `ffmpegRunner` stub captura args y
 * "produce" el output), sin ffprobe (probe inyectado), sin ONNX (`detector`
 * fake con cola de caras por llamada) y sin frames reales (`frameExtractor`
 * stub que escribe el jpg temp para verificar la limpieza).
 *
 * Casos obligatorios del brief:
 *   - `decideLayout`: single (1 cluster), split (2 clusters estables),
 *     center (0 caras), single si el 2do rostro es minoritario (<30% frames).
 *   - crop args single: `crop=<ih*9/16>:<ih>:<x>:0` con x clampeado a bordes.
 *   - split: filter_complex con vstack + 2 scales 1080x960.
 *   - reframeClip completo: 'generating'→'pending_review', videoPath nuevo,
 *     metadata.sourceVideoPath + metadata.reframe.layout.
 *   - ffmpeg failure → status 'error' + metadata.error, temps limpios.
 *   - missing videoPath → error tipado, sin tocar ffmpeg.
 *   - tenant isolation (clip de otro tenant → clip_not_found).
 *   - worker dispatch: kind 'reframe' llama reframeClip con el clipId del
 *     payload.
 *
 * OJO — el bbox del detector real es `[x1,y1,x2,y2]` (esquinas), no
 * `[x,y,w,h]`: los helpers `faceAt` construyen esquinas.
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
  ClipReframeError,
  buildCropArgs,
  buildSplitArgs,
  centerCropWindow,
  createClipReframeService,
  cropWindowFor,
  decideLayout,
  type FrameSample,
  type FrameExtractor,
} from '../src/server/services/clipReframeService';
import { createClipRenderWorker } from '../src/server/services/clipRenderWorker';
import type {
  DetectedFace,
  FaceDetector,
} from '../src/server/services/faceDetectionService';
import {
  createMemoryReframeStore,
  type MemoryReframeClip,
} from './helpers/memoryReframeStore';
import { createMemoryRenderJobsStore } from './helpers/memoryRenderJobsStore';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const CLIP_A = '33333333-3333-4333-8333-333333333333';
const T0 = new Date('2026-11-09T12:00:00.000Z');

const IW = 1920;
const IH = 1080;
/** evenFloor(1080 * 9/16) = evenFloor(607.5) = 606 — ancho del crop single. */
const CROP_W = 606;

let workDir: string;
let tempDir: string;
let outputDir: string;
let sourcePath: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf02-test-'));
  tempDir = path.join(workDir, 'tmp');
  outputDir = path.join(workDir, 'output');
  sourcePath = path.join(workDir, 'src', 'clip.mp4');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, Buffer.from('FAKE-SOURCE-MP4'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** Cara con centro en `centerFrac` del ancho IW. bbox = [x1,y1,x2,y2]. */
function faceAt(centerFrac: number, w = 160, h = 180): DetectedFace {
  const cx = centerFrac * IW;
  return {
    bbox: [cx - w / 2, 100, cx + w / 2, 100 + h],
    detScore: 0.95,
    embedding: [0],
  };
}

/**
 * Detector fake: la llamada N (1-based) devuelve `facesPerCall[N-1]`; llegada
 * la última entrada la repite para las llamadas restantes. `calls` registra
 * los buffers recibidos.
 */
function makeDetector(facesPerCall: DetectedFace[][]) {
  const queue = [...facesPerCall];
  const calls: Buffer[] = [];
  const detector: FaceDetector = {
    async detect(buf) {
      calls.push(buf);
      const faces =
        queue.length > 1 ? queue.shift()! : (queue[0] ?? []);
      return { faces, model: 'fake-detector' };
    },
  };
  return { detector, calls };
}

/**
 * Extractor fake: registra {videoPath, atMs, destPath}, ESCRIBE el jpg temp
 * (así el finally tiene algo que limpiar y el test lo verifica) y devuelve
 * sus bytes. `failOnCalls` (1-based) hace fallar llamadas puntuales.
 */
function makeExtractor(opts: { failOnCalls?: number[] } = {}) {
  const calls: Array<{ videoPath: string; atMs: number; destPath: string }> =
    [];
  const failOn = new Set(opts.failOnCalls ?? []);
  const fn: FrameExtractor = async (videoPath, atMs, destPath) => {
    calls.push({ videoPath, atMs, destPath });
    if (failOn.has(calls.length)) throw new Error('extract boom');
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const buf = Buffer.from('FAKE-JPEG');
    await fs.writeFile(destPath, buf);
    return buf;
  };
  return { fn, calls };
}

/**
 * ffmpegRunner stub: registra args y escribe el output (último arg tras
 * `-y`). `failOnCalls` (1-based) tira en la llamada N.
 */
function makeFakeFfmpeg(opts: { failOnCalls?: number[] } = {}) {
  const calls: string[][] = [];
  const failOn = new Set(opts.failOnCalls ?? []);
  const run = async (args: string[]) => {
    calls.push([...args]);
    if (failOn.has(calls.length)) {
      throw new Error('boom: simulated ffmpeg exit 1');
    }
    const outputPath = args[args.length - 1];
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from('FAKE-MP4-916'));
  };
  return { run, calls };
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Clip fixture de TENANT_A: MP4 16:9 ya cortado por PF-01 (18 s). */
function seedClip(overrides: Partial<Omit<MemoryReframeClip, 'patches'>> = {}) {
  return createMemoryReframeStore({
    clips: [
      {
        id: CLIP_A,
        tenantId: TENANT_A,
        videoPath: sourcePath,
        duration: 18,
        status: 'pending_review',
        metadata: {
          transmissionId: 'tx-1',
          window: { startMs: 0, endMs: 18_000 },
          strategy: 'single',
        },
        ...overrides,
      },
    ],
  });
}

function makeService(
  store: ReturnType<typeof createMemoryReframeStore>['store'],
  opts: {
    facesPerCall?: DetectedFace[][];
    probe?: (filePath: string) => Promise<{ width: number; height: number; durationMs: number | null }>;
    extractor?: ReturnType<typeof makeExtractor>;
    ffmpeg?: ReturnType<typeof makeFakeFfmpeg>;
  } = {},
) {
  const ffmpeg = opts.ffmpeg ?? makeFakeFfmpeg();
  const extractor = opts.extractor ?? makeExtractor();
  const { detector, calls: detectCalls } = makeDetector(
    opts.facesPerCall ?? [],
  );
  const service = createClipReframeService(store, {
    ffmpegRunner: ffmpeg.run,
    frameExtractor: extractor.fn,
    detector,
    probe:
      opts.probe ??
      (async () => ({ width: IW, height: IH, durationMs: 18_000 })),
    tempDir,
    outputDir,
    newId: () => 'fixeduid',
    now: () => T0,
  });
  return { service, ffmpeg, extractor, detectCalls };
}

/** Helper de samples para los tests puros de decideLayout. */
function sample(centerX: number | null, faceCenters: number[], t = 0): FrameSample {
  return { t, centerX, faceCount: faceCenters.length, faceCenters };
}

// ─── decideLayout (pura) ────────────────────────────────────────────────────

describe('decideLayout', () => {
  it('un solo cluster de rostros → single con centerX = mediana de dominantes', () => {
    const layout = decideLayout([
      sample(0.58, [0.58]),
      sample(0.6, [0.6]),
      sample(0.62, [0.62]),
      sample(null, []), // frame sin cara: cuenta como sample, no aporta centro
    ]);
    expect(layout).toEqual({ kind: 'single', centerX: 0.6 });
  });

  it('2 clusters estables (≥30% frames c/u, separación >25%) → split izq/der', () => {
    // Dos personas fijas: en TODOS los frames hay cara en 0.25 y en 0.75.
    const layout = decideLayout(
      Array.from({ length: 10 }, () => sample(0.25, [0.25, 0.75])),
    );
    expect(layout).toEqual({
      kind: 'split',
      leftX: expect.closeTo(0.25),
      rightX: expect.closeTo(0.75),
    });
  });

  it('0 caras en todo el clip → center (fallback)', () => {
    const layout = decideLayout([
      sample(null, []),
      sample(null, []),
      sample(null, []),
    ]);
    expect(layout).toEqual({ kind: 'center' });
  });

  it('segundo rostro minoritario (<30% de frames con cara) → single', () => {
    // 10 frames: la cara de 0.9 aparece sólo en 2 (support 0.2 < 0.30).
    const samples = Array.from({ length: 10 }, (_, i) =>
      i < 2 ? sample(0.5, [0.5, 0.9]) : sample(0.5, [0.5]),
    );
    const layout = decideLayout(samples);
    expect(layout).toEqual({ kind: 'single', centerX: 0.5 });
  });

  it('segundo cluster exactamente al 30% → split (umbral inclusivo)', () => {
    // La cara de 0.85 aparece en 3 de 10 frames con cara (support = 0.30).
    const samples = Array.from({ length: 10 }, (_, i) =>
      i < 3 ? sample(0.4, [0.4, 0.85]) : sample(0.4, [0.4]),
    );
    expect(decideLayout(samples).kind).toBe('split');
  });

  it('dos caras juntas (<25% separación) son UNA persona → single', () => {
    // Pareja pegada en el mismo plano: 0.45 y 0.62 distan 0.17 < 0.25 →
    // single-linkage los fusiona en un cluster.
    const layout = decideLayout(
      Array.from({ length: 10 }, () => sample(0.45, [0.45, 0.62])),
    );
    expect(layout.kind).toBe('single');
  });
});

// ─── Geometría de crop + args (puros) ──────────────────────────────────────

describe('cropWindowFor / args de ffmpeg', () => {
  it('single: crop=<ih*9/16>:<ih>:<x>:0 con x centrado en el rostro', () => {
    // Rostro en 0.5 → x = evenFloor(960 − 303) = 656.
    const w = cropWindowFor(IW, IH, 0.5, 9 / 16);
    expect(w).toEqual({ w: CROP_W, h: IH, x: 656, y: 0 });
    const args = buildCropArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', window: w });
    expect(argAfter(args, '-vf')).toBe(
      `crop=${CROP_W}:${IH}:656:0,scale=1080:1920`,
    );
    expect(argAfter(args, '-c:a')).toBe('copy');
  });

  it('x se clampea al borde izquierdo (rostro en el borde → x=0)', () => {
    const w = cropWindowFor(IW, IH, 0.02, 9 / 16);
    expect(w.x).toBe(0);
  });

  it('x se clampea al borde derecho (rostro al fondo → x=iw-cropW)', () => {
    const w = cropWindowFor(IW, IH, 1.0, 9 / 16);
    expect(w.x).toBe(IW - CROP_W);
  });

  it('center layout: ventana centrada estándar', () => {
    expect(centerCropWindow(IW, IH, 9 / 16)).toEqual({
      w: CROP_W,
      h: IH,
      x: 656,
      y: 0,
    });
  });

  it('split: filter_complex con dos crops 1080x960 escalados + vstack', () => {
    const top = cropWindowFor(IW, IH, 0.25, 9 / 8); // w = evenFloor(1215)=1214
    const bottom = cropWindowFor(IW, IH, 0.75, 9 / 8);
    const args = buildSplitArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      top,
      bottom,
    });
    const fc = argAfter(args, '-filter_complex')!;
    expect(fc).toContain(`crop=${top.w}:${IH}:${top.x}:0,scale=1080:960[t]`);
    expect(fc).toContain(`crop=${bottom.w}:${IH}:${bottom.x}:0,scale=1080:960[b]`);
    expect(fc).toContain('[t][b]vstack');
    expect(argAfter(args, '-c:a')).toBe('copy');
    expect(args[args.length - 1]).toBe('/out.mp4');
  });
});

// ─── reframeClip (integración con fakes) ───────────────────────────────────

describe('reframeClip', () => {
  it('single: generating→pending_review, videoPath nuevo, metadata.reframe completo', async () => {
    const { store, state } = seedClip();
    const { service, ffmpeg, extractor, detectCalls } = makeService(store, {
      facesPerCall: [[faceAt(0.6)]],
    });

    const res = await service.reframeClip({ tenantId: TENANT_A, clipId: CLIP_A });

    // Resultado + output en outputDir con convención <clipId>_916.mp4.
    expect(res.layout).toBe('single');
    expect(res.samples).toBe(9);
    expect(res.facesDetected).toBe(9);
    expect(res.videoPath).toBe(path.join(outputDir, `${CLIP_A}_916.mp4`));
    expect(existsSync(res.videoPath)).toBe(true);

    // 9 samples uniformes: t = 18000·(i+.5)/9 = 1000, 3000, …, 17000.
    expect(extractor.calls).toHaveLength(9);
    expect(extractor.calls.map((c) => c.atMs)).toEqual([
      1000, 3000, 5000, 7000, 9000, 11_000, 13_000, 15_000, 17_000,
    ]);
    expect(extractor.calls[0].videoPath).toBe(sourcePath);
    expect(detectCalls).toHaveLength(9);

    // UNA invocación ffmpeg de render: crop 9:16 + scale + audio copy.
    expect(ffmpeg.calls).toHaveLength(1);
    const args = ffmpeg.calls[0];
    expect(argAfter(args, '-i')).toBe(sourcePath);
    // Rostro en 0.6 → x = evenFloor(0.6·1920 − 303) = 848.
    expect(argAfter(args, '-vf')).toBe(`crop=${CROP_W}:${IH}:848:0,scale=1080:1920`);
    expect(argAfter(args, '-c:a')).toBe('copy');
    expect(args[args.length - 1]).toBe(res.videoPath);

    // Fila: 'generating' al empezar → 'pending_review' con videoPath nuevo.
    const clip = state.clips[0];
    expect(clip.patches.map((p) => p.status)).toEqual([
      'generating',
      'pending_review',
    ]);
    expect(clip.videoPath).toBe(res.videoPath);
    // metadata previa preservada + sourceVideoPath + bloque reframe.
    expect(clip.metadata).toMatchObject({
      transmissionId: 'tx-1',
      window: { startMs: 0, endMs: 18_000 },
      sourceVideoPath: sourcePath,
      reframe: {
        layout: 'single',
        samples: 9,
        facesDetected: 9,
        centerX: expect.closeTo(0.6),
        renderedAt: T0.toISOString(),
      },
    });

    // Temps limpios en el finally.
    const leftovers = await fs.readdir(tempDir).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('split: dos personas estables → filter_complex vstack + metadata leftX/rightX', async () => {
    const { store, state } = seedClip();
    const { service, ffmpeg } = makeService(store, {
      facesPerCall: [[faceAt(0.25, 300, 300), faceAt(0.75, 300, 300)]],
    });

    const res = await service.reframeClip({ tenantId: TENANT_A, clipId: CLIP_A });

    expect(res.layout).toBe('split');
    const args = ffmpeg.calls[0];
    const fc = argAfter(args, '-filter_complex')!;
    expect(fc).toContain('vstack=inputs=2');
    expect(fc.match(/scale=1080:960/g)).toHaveLength(2);
    expect(argAfter(args, '-c:a')).toBe('copy');

    expect(state.clips[0].status).toBe('pending_review');
    expect(state.clips[0].metadata?.reframe).toMatchObject({
      layout: 'split',
      samples: 9,
      facesDetected: 18, // 2 caras × 9 frames
      leftX: expect.closeTo(0.25),
      rightX: expect.closeTo(0.75),
    });
  });

  it('center: clip sin caras → crop centrado estándar (x=(iw−w)/2)', async () => {
    const { store } = seedClip();
    const { service, ffmpeg } = makeService(store, {
      facesPerCall: [[]], // todos los frames sin cara
    });

    const res = await service.reframeClip({ tenantId: TENANT_A, clipId: CLIP_A });

    expect(res.layout).toBe('center');
    expect(res.facesDetected).toBe(0);
    expect(argAfter(ffmpeg.calls[0], '-vf')).toBe(
      `crop=${CROP_W}:${IH}:656:0,scale=1080:1920`,
    );
  });

  it('frame que no se puede extraer cuenta como sample sin caras', async () => {
    const { store } = seedClip();
    const extractor = makeExtractor({ failOnCalls: [1, 2] });
    const { service, ffmpeg } = makeService(store, {
      extractor,
      facesPerCall: [[faceAt(0.5)]],
    });

    const res = await service.reframeClip({ tenantId: TENANT_A, clipId: CLIP_A });

    // 9 intentos de extracción, 7 caras detectadas, layout single igual.
    expect(extractor.calls).toHaveLength(9);
    expect(res.samples).toBe(9);
    expect(res.facesDetected).toBe(7);
    expect(res.layout).toBe('single');
    expect(ffmpeg.calls).toHaveLength(1);
  });

  it('ffmpeg que falla → ffmpeg_failed, fila error + metadata.error, videoPath intacto', async () => {
    const { store, state } = seedClip();
    const ffmpeg = makeFakeFfmpeg({ failOnCalls: [1] });
    const { service } = makeService(store, {
      ffmpeg,
      facesPerCall: [[faceAt(0.5)]],
    });

    const err = await service
      .reframeClip({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipReframeError);
    expect(err.reason).toBe('ffmpeg_failed');
    expect(err.message).toContain('simulated ffmpeg exit 1');

    const clip = state.clips[0];
    expect(clip.status).toBe('error');
    expect(clip.videoPath).toBe(sourcePath); // nunca se pisó
    expect(clip.patches.map((p) => p.status)).toEqual(['generating', 'error']);
    expect(clip.metadata?.error).toContain('simulated ffmpeg exit 1');
    // El metadata previo sigue ahí (auditable) y NO hay videoPath nuevo.
    expect(clip.metadata?.transmissionId).toBe('tx-1');

    const leftovers = await fs.readdir(tempDir).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('clip sin videoPath → missing_source_video sin tocar ffmpeg ni la fila', async () => {
    const { store, state } = seedClip({ videoPath: null });
    const { service, ffmpeg, extractor } = makeService(store);

    const err = await service
      .reframeClip({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipReframeError);
    expect(err.reason).toBe('missing_source_video');
    expect(ffmpeg.calls).toHaveLength(0);
    expect(extractor.calls).toHaveLength(0);
    // La fila no se tocó: ni 'generating' ni 'error'.
    expect(state.clips[0].status).toBe('pending_review');
    expect(state.clips[0].patches).toEqual([]);
  });

  it('clip de otro tenant → clip_not_found (aislamiento por tenant)', async () => {
    const { store, state } = seedClip();
    const { service, ffmpeg, extractor } = makeService(store);

    const err = await service
      .reframeClip({ tenantId: TENANT_B, clipId: CLIP_A }) // TENANT_B pide el clip de A
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipReframeError);
    expect(err.reason).toBe('clip_not_found');
    expect(ffmpeg.calls).toHaveLength(0);
    expect(extractor.calls).toHaveLength(0);
    expect(state.clips[0].patches).toEqual([]);
  });

  it('probe que falla → probe_failed y la fila queda error', async () => {
    const { store, state } = seedClip();
    const { service, extractor } = makeService(store, {
      probe: async () => {
        throw new Error('ffprobe no está');
      },
    });

    const err = await service
      .reframeClip({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipReframeError);
    expect(err.reason).toBe('probe_failed');
    expect(state.clips[0].status).toBe('error');
    expect(state.clips[0].metadata?.error).toContain('ffprobe no está');
    expect(extractor.calls).toHaveLength(0); // ni un frame se extrajo
  });

  it('detector que falla → detector_unavailable y la fila queda error', async () => {
    const { store, state } = seedClip();
    const broken: FaceDetector = {
      async detect() {
        throw new Error('modelos ONNX no descargados');
      },
    };
    const ffmpeg = makeFakeFfmpeg();
    const extractor = makeExtractor();
    const service = createClipReframeService(store, {
      ffmpegRunner: ffmpeg.run,
      frameExtractor: extractor.fn,
      detector: broken,
      probe: async () => ({ width: IW, height: IH, durationMs: null }),
      tempDir,
      outputDir,
    });

    const err = await service
      .reframeClip({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipReframeError);
    expect(err.reason).toBe('detector_unavailable');
    expect(state.clips[0].status).toBe('error');
    expect(ffmpeg.calls).toHaveLength(0); // el render nunca arrancó
  });
});

// ─── Worker dispatch (kind 'reframe') ──────────────────────────────────────

describe('clipRenderWorker dispatch reframe', () => {
  it('kind reframe → reframeClip con el clipId del payload → markDone + done emit', async () => {
    const { store, state } = createMemoryRenderJobsStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'reframe',
          clipId: CLIP_A,
          payload: { clipId: CLIP_A },
          maxAttempts: 3,
        },
      ],
      now: () => T0,
    });
    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    const io = {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ room, event, payload });
          return true;
        },
      }),
    };
    const reframeCalls: Array<{ tenantId: string; clipId: string }> = [];
    const worker = createClipRenderWorker(
      {
        store,
        now: () => T0,
        reframeClip: async (input) => {
          reframeCalls.push(input);
          return {
            clipId: input.clipId,
            videoPath: '/out/x_916.mp4',
            layout: 'single',
            samples: 9,
            facesDetected: 4,
          };
        },
        cutRawWindow: async () => {
          throw new Error('no debería llamarse');
        },
      },
      io,
    );

    await worker.tick();

    expect(reframeCalls).toEqual([{ tenantId: TENANT_A, clipId: CLIP_A }]);
    const job = state.jobs[0];
    expect(job.status).toBe('done');
    expect(emitted).toEqual([
      {
        room: `tenant:${TENANT_A}`,
        event: 'clip:render:done',
        payload: expect.objectContaining({
          clipId: CLIP_A,
          kind: 'reframe',
          layout: 'single',
        }),
      },
    ]);
  });

  it('payload sin clipId → fallback a job.clipId de la fila', async () => {
    const { store } = createMemoryRenderJobsStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'reframe',
          clipId: CLIP_A, // el enqueue rellenó la FK pero no el payload
          payload: {},
        },
      ],
      now: () => T0,
    });
    const reframeCalls: Array<{ tenantId: string; clipId: string }> = [];
    const worker = createClipRenderWorker({
      store,
      now: () => T0,
      reframeClip: async (input) => {
        reframeCalls.push(input);
        return {
          clipId: input.clipId,
          videoPath: '/out/x_916.mp4',
          layout: 'center',
          samples: 9,
          facesDetected: 0,
        };
      },
    });

    await worker.tick();
    expect(reframeCalls).toEqual([{ tenantId: TENANT_A, clipId: CLIP_A }]);
  });

  it('reframe que tira → markFailed con backoff (mismo contrato que cut)', async () => {
    const { store, state } = createMemoryRenderJobsStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'reframe',
          payload: { clipId: CLIP_A },
          maxAttempts: 3,
        },
      ],
      now: () => T0,
    });
    const worker = createClipRenderWorker({
      store,
      now: () => T0,
      reframeClip: async () => {
        throw new ClipReframeError('missing_source_video', 'sin video');
      },
    });

    await worker.tick();

    const job = state.jobs[0];
    // attempts=1 tras el claim → backoff 1min → vuelve a pending.
    expect(job.status).toBe('pending');
    expect(job.lastError).toContain('sin video');
    expect(job.runAt.getTime()).toBe(T0.getTime() + 60_000);
  });
});
