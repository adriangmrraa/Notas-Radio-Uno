/**
 * streamRecorderService — captura del crudo de VIDEO de un live (PD-02).
 *
 * Resuelve la URL del stream UNA sola vez con `resolveStreamUrl` (yt-dlp) y
 * graba con `ffmpeg -c copy -f segment` a MP4 segmentados dentro del
 * RawStorage del tenant — sin re-encode. Cada segmento queda anclado a
 * wall-clock de la ejecución: `start_ms`/`end_ms` son offsets en ms relativos
 * al `startedAt` de la grabación (el ancla), para alinearlos con
 * transcripción y rostros.
 *
 * Diseño (todas las dependencias son inyectables — los tests corren sin red,
 * sin ffmpeg y sin DB):
 *   - `RecorderStore`   — persistencia; `createDrizzleRecorderStore` en prod,
 *     store en memoria en tests. TODA query filtra por `tenantId` (regla dura).
 *   - `RawStorage`      — `getRawStorage()`; hoy filesystem, así que el
 *     recorder escribe sobre `storage.publicPath(prefix)` (D-1 self-hosted).
 *   - `resolver`        — `resolveStreamUrl` por defecto.
 *   - `spawnProcess`    — `spawn` real; en tests un fake que emite `close`.
 *   - `probeDuration`   — ffprobe para la duración del último segmento
 *     (best-effort; si no hay ffprobe se aproxima con wall-clock).
 *
 * Stream caído (PI-04 parcial): si ffmpeg sale con error antes de llegar al
 * límite de duración, se reintenta re-resolviendo la URL (hasta `maxRetries`,
 * backoff exponencial) DENTRO de la misma `stream_recording`: el
 * `recordingId` y el `storagePrefix` se mantienen, `sequence` sigue
 * incrementando y los huecos quedan reflejados en los offsets. Los segmentos
 * ya escritos NO se pierden.
 *
 * Anclaje temporal de segmentos: el nombre `seg-%Y%m%d-%H%M%S.mp4` (strftime)
 * codifica el wall-clock real de apertura — es el ancla preferida; si no se
 * puede parsear, se usa el mtime del archivo (fallback del brief). Se clampea
 * a `>= 0`. `end_ms` queda NULL mientras el segmento escribe y se fija cuando
 * aparece el siguiente (o al cerrar).
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { recordingSegments, streamRecordings } from '../db/schema/recordings.js';
import { transmissions } from '../db/schema/transmissions.js';
import type { TransmissionStatus } from '../db/schema/enums.js';
import { findBinary } from '../lib/binaries.js';
import { getRawStorage, type RawStorage } from './rawStorageService.js';
import {
  resolveStreamUrl,
  type ResolvedStream,
} from './streamSourceResolver.js';

// ─── API pública ────────────────────────────────────────────────────────────

export interface StartRecordingOptions {
  tenantId: string;
  transmissionId: string;
  streamUrl: string;
  /** Duración máxima en minutos (límite del plan). */
  maxDurationMinutes?: number;
  /** Duración del segmento en segundos. Default 60. */
  segmentSeconds?: number;
  /** Prefijo de storage. Default `${tenantId}/${transmissionId}`. */
  storagePrefix?: string;
}

export interface RecordingHandle {
  transmissionId: string;
  recordingId: string;
  /** Se resuelve cuando la grabación termina (por duración o por stream caído). */
  done: Promise<RecordingOutcome>;
  stop(): Promise<void>;
}

export interface RecordingOutcome {
  status: 'completed' | 'error';
  totalBytes: number;
  segmentCount: number;
  errorMessage: string | null;
}

// ─── Dependencias inyectables ───────────────────────────────────────────────

/** Proceso ffmpeg mínimo que el recorder necesita (spawn real o fake de test). */
export interface RecorderProcess {
  stdin: { write(chunk: string): void } | null;
  stderr: { on(event: 'data', cb: (data: Buffer | string) => void): unknown } | null;
  kill(signal?: string): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'close', cb: (code: number | null, signal: string | null) => void): unknown;
}

export type RecorderSpawner = (command: string, args: string[]) => RecorderProcess;

export interface RecorderTransmission {
  id: string;
  tenantId: string;
  status: string;
  durationMinutes: number | null;
}

export interface RecorderTransmissionPatch {
  status?: TransmissionStatus;
  startedAt?: Date;
  endedAt?: Date;
  resolvedStreamUrl?: string;
  lastHeartbeatAt?: Date;
  crudoRef?: string;
  errorMessage?: string | null;
}

export interface RecorderStore {
  getTransmission(
    tenantId: string,
    transmissionId: string,
  ): Promise<RecorderTransmission | null>;
  createRecording(v: {
    tenantId: string;
    transmissionId: string;
    storagePrefix: string;
    startedAt: Date;
  }): Promise<{ id: string }>;
  updateTransmission(
    tenantId: string,
    transmissionId: string,
    patch: RecorderTransmissionPatch,
  ): Promise<void>;
  insertSegment(v: {
    tenantId: string;
    recordingId: string;
    sequence: number;
    startMs: number;
    endMs: number | null;
    fileRef: string;
    bytes: number;
  }): Promise<void>;
  setSegmentEndMs(
    tenantId: string,
    recordingId: string,
    sequence: number,
    endMs: number,
  ): Promise<void>;
  finalizeRecording(
    tenantId: string,
    recordingId: string,
    patch: { status: 'completed' | 'error'; totalBytes: number; endedAt: Date },
  ): Promise<void>;
}

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleRecorderStore(executor: Database = db): RecorderStore {
  return {
    async getTransmission(tenantId, transmissionId) {
      const [row] = await executor
        .select({
          id: transmissions.id,
          tenantId: transmissions.tenantId,
          status: transmissions.status,
          durationMinutes: transmissions.durationMinutes,
        })
        .from(transmissions)
        .where(
          and(
            eq(transmissions.id, transmissionId),
            eq(transmissions.tenantId, tenantId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async createRecording(v) {
      const [row] = await executor
        .insert(streamRecordings)
        .values({
          tenantId: v.tenantId,
          transmissionId: v.transmissionId,
          storagePrefix: v.storagePrefix,
          status: 'recording',
          startedAt: v.startedAt,
        })
        .returning({ id: streamRecordings.id });
      return row;
    },

    async updateTransmission(tenantId, transmissionId, patch) {
      await executor
        .update(transmissions)
        .set(patch)
        .where(
          and(
            eq(transmissions.id, transmissionId),
            eq(transmissions.tenantId, tenantId),
          ),
        );
    },

    async insertSegment(v) {
      await executor.insert(recordingSegments).values({
        tenantId: v.tenantId,
        recordingId: v.recordingId,
        sequence: v.sequence,
        startMs: v.startMs,
        endMs: v.endMs,
        fileRef: v.fileRef,
        bytes: v.bytes,
        status: 'active',
      });
    },

    async setSegmentEndMs(tenantId, recordingId, sequence, endMs) {
      await executor
        .update(recordingSegments)
        .set({ endMs })
        .where(
          and(
            eq(recordingSegments.recordingId, recordingId),
            eq(recordingSegments.tenantId, tenantId),
            eq(recordingSegments.sequence, sequence),
          ),
        );
    },

    async finalizeRecording(tenantId, recordingId, patch) {
      await executor
        .update(streamRecordings)
        .set({
          status: patch.status,
          totalBytes: patch.totalBytes,
          endedAt: patch.endedAt,
        })
        .where(
          and(
            eq(streamRecordings.id, recordingId),
            eq(streamRecordings.tenantId, tenantId),
          ),
        );
    },
  };
}

export interface RecorderDeps {
  store?: RecorderStore;
  storage?: RawStorage;
  resolver?: typeof resolveStreamUrl;
  spawnProcess?: RecorderSpawner;
  /** ffprobe para la duración del último segmento. `null` desactiva el probe. */
  probeDuration?: ((filePath: string) => Promise<number | null>) | null;
  ffmpegPath?: string;
  proxyUrls?: string[];
  heartbeatMs?: number;
  pollMs?: number;
  /** Gracia entre 'q'/SIGTERM y SIGKILL al frenar ffmpeg. Default 10 s. */
  stopGraceMs?: number;
  /** Reintentos ante stream caído (re-resolviendo la URL). Default 3. */
  maxRetries?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// ─── Funciones puras (exportadas para tests) ────────────────────────────────

export interface FfmpegArgsInput {
  inputUrl: string;
  outputPattern: string;
  segmentSeconds: number;
  /**
   * `true` sólo cuando la entrada es un .m3u8 LOCAL (playlist file:// que
   * referencia segmentos remotos): verificado en este entorno (ffmpeg 8.1),
   * ahí sí hace falta `-protocol_whitelist` porque la whitelist por defecto
   * de un input local es 'file,crypto,data' y rechaza http. Para HLS remoto
   * (http/https) NO se agrega: la whitelist por defecto de URL ya incluye
   * http,https,tcp,tls,crypto y el flag sólo agregaría ruido.
   */
  localHlsInput?: boolean;
}

export function buildFfmpegArgs(input: FfmpegArgsInput): string[] {
  const args = ['-hide_banner', '-loglevel', 'warning'];
  if (input.localHlsInput) {
    args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto');
  }
  args.push(
    '-i', input.inputUrl,
    '-c', 'copy',
    '-f', 'segment',
    '-segment_time', String(input.segmentSeconds),
    '-reset_timestamps', '1',
    '-strftime', '1',
    input.outputPattern,
  );
  return args;
}

const SEGMENT_NAME_RE = /^seg-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/;

/**
 * Epoch ms del timestamp strftime del nombre (`seg-YYYYMMDD-HHMMSS…`).
 * Es el wall-clock real de apertura del segmento — mejor ancla que el mtime.
 */
export function segmentFileStartMs(fileName: string): number | null {
  const m = SEGMENT_NAME_RE.exec(path.basename(fileName));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * startMs de un segmento = ancla wall-clock (nombre strftime, si no mtime)
 * menos el startedAt de la grabación. Clampeado a >= 0: el reloj del archivo
 * puede quedar atrás del ancla.
 */
export function computeSegmentStartMs(input: {
  fileName: string;
  mtimeMs: number;
  startedAtMs: number;
}): number {
  const anchor = segmentFileStartMs(input.fileName) ?? input.mtimeMs;
  return Math.max(0, Math.round(anchor - input.startedAtMs));
}

/** Reintenta si ffmpeg salió con error, nadie pidió stop y quedan reintentos. */
export function shouldRetryFfmpeg(input: {
  exitCode: number | null;
  stopRequested: boolean;
  attempt: number;
  maxRetries: number;
}): boolean {
  if (input.stopRequested) return false;
  if (input.exitCode === 0) return false;
  return input.attempt < input.maxRetries;
}

/** Backoff por defecto: 2s, 4s, 8s… cap 30s. */
export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** attempt);
}

// ─── Servicio ───────────────────────────────────────────────────────────────

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function createFfprobeDurationProbe(
  ffprobePath: string,
): (filePath: string) => Promise<number | null> {
  return (filePath) =>
    new Promise((resolve) => {
      execFile(
        ffprobePath,
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          filePath,
        ],
        { timeout: 10_000 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const seconds = Number.parseFloat(stdout.toString().trim());
          resolve(Number.isFinite(seconds) ? Math.round(seconds * 1000) : null);
        },
      );
    });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startRecording(
  opts: StartRecordingOptions,
  deps: RecorderDeps = {},
): Promise<RecordingHandle> {
  const store = deps.store ?? createDrizzleRecorderStore();
  const storage = deps.storage ?? getRawStorage();
  const resolver = deps.resolver ?? resolveStreamUrl;
  const spawnProcess =
    deps.spawnProcess ??
    ((command, args) =>
      spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] }) as unknown as RecorderProcess);
  const ffmpegPath = deps.ffmpegPath ?? findBinary('ffmpeg');
  const probeDuration =
    deps.probeDuration === undefined
      ? createFfprobeDurationProbe(findBinary('ffprobe'))
      : deps.probeDuration;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const pollMs = deps.pollMs ?? 1_000;
  const stopGraceMs = deps.stopGraceMs ?? 10_000;
  const maxRetries = deps.maxRetries ?? 3;
  const backoffMs = deps.backoffMs ?? defaultBackoffMs;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  const { tenantId, transmissionId } = opts;
  const storagePrefix = opts.storagePrefix ?? `${tenantId}/${transmissionId}`;
  const segmentSeconds = opts.segmentSeconds ?? 60;

  const tx = await store.getTransmission(tenantId, transmissionId);
  if (!tx) {
    throw new Error(
      `Transmisión ${transmissionId} no encontrada para el tenant ${tenantId}`,
    );
  }

  // 1. Resolver la URL UNA vez.
  let resolved: ResolvedStream;
  try {
    resolved = await resolver(opts.streamUrl, { proxyUrls: deps.proxyUrls });
  } catch (err) {
    const msg = `No se pudo resolver la URL del stream: ${errorMessage(err)}`;
    await store
      .updateTransmission(tenantId, transmissionId, {
        status: 'error',
        errorMessage: msg,
      })
      .catch(() => {});
    throw err instanceof Error ? err : new Error(msg);
  }

  // 2. Fila stream_recordings + transmissions → live (startedAt = ancla wall-clock).
  const startedAtMs = now();
  const { id: recordingId } = await store.createRecording({
    tenantId,
    transmissionId,
    storagePrefix,
    startedAt: new Date(startedAtMs),
  });
  await store.updateTransmission(tenantId, transmissionId, {
    status: 'live',
    startedAt: new Date(startedAtMs),
    resolvedStreamUrl: resolved.url,
  });

  const segDir = storage.publicPath(storagePrefix);
  await fs.mkdir(segDir, { recursive: true });
  const outputPattern = path.join(segDir, 'seg-%Y%m%d-%H%M%S.mp4');

  // ── Estado interno ──
  let proc: RecorderProcess | null = null;
  let procSettled = true;
  let attempt = 0;
  let sequence = 0;
  let totalBytes = 0;
  let finished = false;
  let stopRequested = false;
  let stderrTail = '';
  let lastError: string | null = null;
  const segmentBytes = new Map<string, number>();
  const pendingSegments: Array<{
    sequence: number;
    fileName: string;
    startMs: number;
    closed: boolean;
  }> = [];

  let finishResolve!: (o: RecordingOutcome) => void;
  const done = new Promise<RecordingOutcome>((r) => {
    finishResolve = r;
  });

  const heartbeat = setInterval(() => {
    store
      .updateTransmission(tenantId, transmissionId, {
        lastHeartbeatAt: new Date(now()),
      })
      .catch(() => {});
  }, heartbeatMs);

  const durationCapMs = (() => {
    const minutes = opts.maxDurationMinutes ?? tx.durationMinutes;
    return minutes && minutes > 0 ? minutes * 60_000 : null;
  })();
  const capTimer =
    durationCapMs !== null ? setTimeout(() => void requestStop(), durationCapMs) : null;

  /** Inserta filas para los .mp4 nuevos; refresca bytes de los ya vistos. */
  async function pollSegments(): Promise<void> {
    if (finished) return;
    let files: string[];
    try {
      files = await fs.readdir(segDir);
    } catch {
      return;
    }
    const names = files.filter((f) => /^seg-.*\.mp4$/i.test(f)).sort();
    for (const name of names) {
      const stat = await fs.stat(path.join(segDir, name)).catch(() => null);
      if (!stat) continue;
      const prev = segmentBytes.get(name);
      if (prev !== undefined) {
        if (stat.size !== prev) segmentBytes.set(name, stat.size);
        continue;
      }
      segmentBytes.set(name, stat.size);
      const startMs = computeSegmentStartMs({
        fileName: name,
        mtimeMs: stat.mtimeMs,
        startedAtMs,
      });
      // El segmento anterior deja de escribir: endMs = inicio del nuevo.
      const prevPending = pendingSegments[pendingSegments.length - 1];
      if (prevPending) {
        await store
          .setSegmentEndMs(
            tenantId,
            recordingId,
            prevPending.sequence,
            Math.max(prevPending.startMs, startMs),
          )
          .catch((err) => console.error('[recorder] setSegmentEndMs falló:', errorMessage(err)));
        prevPending.closed = true;
      }
      const seq = sequence++;
      pendingSegments.push({ sequence: seq, fileName: name, startMs, closed: false });
      await store
        .insertSegment({
          tenantId,
          recordingId,
          sequence: seq,
          startMs,
          endMs: null,
          fileRef: name,
          bytes: stat.size,
        })
        .catch((err) => console.error('[recorder] insertSegment falló:', errorMessage(err)));
    }
  }

  const watcher = setInterval(() => void pollSegments(), pollMs);

  function spawnAttempt(inputUrl: string, kind: ResolvedStream['kind']): void {
    const localHlsInput =
      kind === 'file' && /\.m3u8(\?.*)?$/i.test(inputUrl);
    const args = buildFfmpegArgs({
      inputUrl,
      outputPattern,
      segmentSeconds,
      localHlsInput,
    });
    stderrTail = '';
    procSettled = false;
    const p = spawnProcess(ffmpegPath, args);
    proc = p;
    p.stderr?.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2_000);
    });
    p.on('error', (err) => {
      if (procSettled) return;
      procSettled = true;
      lastError = `Error al ejecutar ffmpeg: ${err.message}`;
      void onFfmpegExit(-1, null);
    });
    p.on('close', (code, signal) => {
      if (procSettled) return;
      procSettled = true;
      void onFfmpegExit(code, signal);
    });
  }

  async function onFfmpegExit(code: number | null, signal: string | null): Promise<void> {
    if (finished) return;
    await pollSegments();

    if (stopRequested || code === 0) {
      await finalize('completed', lastError);
      return;
    }

    lastError ??= `ffmpeg salió con código ${code ?? 'null'}${signal ? ` (señal ${signal})` : ''}: ${stderrTail.slice(-300)}`;

    // Stream caído: reintentar re-resolviendo la URL, mismo recordingId.
    if (shouldRetryFfmpeg({ exitCode: code, stopRequested, attempt, maxRetries })) {
      attempt += 1;
      console.warn(
        `[recorder] ffmpeg cayó (intento ${attempt}/${maxRetries}); re-resolviendo en ${backoffMs(attempt)} ms…`,
      );
      await sleep(backoffMs(attempt));
      if (finished || stopRequested) {
        await finalize(stopRequested ? 'completed' : 'error', lastError);
        return;
      }
      try {
        resolved = await resolver(opts.streamUrl, { proxyUrls: deps.proxyUrls });
        await store.updateTransmission(tenantId, transmissionId, {
          resolvedStreamUrl: resolved.url,
        });
      } catch (err) {
        lastError = `Re-resolución falló: ${errorMessage(err)}`;
        await finalize('error', lastError);
        return;
      }
      spawnAttempt(resolved.url, resolved.kind);
      return;
    }

    await finalize('error', lastError);
  }

  async function requestStop(): Promise<void> {
    stopRequested = true;
    const p = proc;
    if (p && !procSettled) {
      try {
        p.stdin?.write('q'); // stop suave de ffmpeg
      } catch {
        /* stdin cerrado */
      }
      setTimeout(() => {
        if (finished || proc !== p || procSettled) return;
        try {
          p.kill('SIGTERM');
        } catch {
          /* ya murió */
        }
      }, Math.min(stopGraceMs, 5_000));
      setTimeout(() => {
        if (finished || proc !== p || procSettled) return;
        try {
          p.kill('SIGKILL');
        } catch {
          /* ya murió */
        }
      }, stopGraceMs);
    }
  }

  async function finalize(
    status: 'completed' | 'error',
    errorMsg: string | null,
  ): Promise<void> {
    if (finished) return;
    finished = true;
    clearInterval(watcher);
    clearInterval(heartbeat);
    if (capTimer) clearTimeout(capTimer);
    await pollSegmentsAllowFinished();

    // Cerrar el último segmento: endMs = duración real (ffprobe) o wall-clock.
    const lastPending = pendingSegments.filter((s) => !s.closed).pop();
    if (lastPending) {
      const probed = probeDuration
        ? await probeDuration(path.join(segDir, lastPending.fileName)).catch(() => null)
        : null;
      const wallClockEnd = Math.max(0, now() - startedAtMs);
      const endMs = Math.max(
        lastPending.startMs,
        probed !== null ? lastPending.startMs + probed : wallClockEnd,
      );
      await store
        .setSegmentEndMs(tenantId, recordingId, lastPending.sequence, endMs)
        .catch(() => {});
    }

    totalBytes = [...segmentBytes.values()].reduce((a, b) => a + b, 0);
    const endedAt = new Date(now());

    await store
      .finalizeRecording(tenantId, recordingId, {
        status,
        totalBytes,
        endedAt,
      })
      .catch((err) => console.error('[recorder] finalizeRecording falló:', errorMessage(err)));

    await store
      .updateTransmission(
        tenantId,
        transmissionId,
        status === 'completed'
          ? { status: 'processing', endedAt, crudoRef: storagePrefix }
          : { status: 'error', endedAt, errorMessage: errorMsg },
      )
      .catch((err) => console.error('[recorder] updateTransmission falló:', errorMessage(err)));

    finishResolve({
      status,
      totalBytes,
      segmentCount: sequence,
      errorMessage: status === 'error' ? errorMsg : null,
    });
  }

  // pollSegments() se saltea cuando finished=true; acá el flush final.
  async function pollSegmentsAllowFinished(): Promise<void> {
    const wasFinished = finished;
    finished = false;
    await pollSegments();
    finished = wasFinished;
  }

  async function stop(): Promise<void> {
    await requestStop();
    if (procSettled && !finished) {
      await finalize('completed', null);
      return;
    }
    await done;
  }

  spawnAttempt(resolved.url, resolved.kind);

  return { transmissionId, recordingId, done, stop };
}
