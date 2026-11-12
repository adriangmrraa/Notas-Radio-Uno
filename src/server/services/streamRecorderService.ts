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
 * Stream caído (PI-04): si ffmpeg sale con error antes de llegar al límite
 * de duración, se reintenta re-resolviendo la URL (hasta `maxRetries`,
 * backoff exponencial) DENTRO de la misma `stream_recording`: el
 * `recordingId` y el `storagePrefix` se mantienen, `sequence` sigue
 * incrementando y los huecos quedan reflejados en los offsets. Los segmentos
 * ya escritos NO se pierden.
 *
 * Stall watchdog (PI-04): un corte de red upstream deja a ffmpeg COLGADO —
 * nunca emite `close`, así que el retry por salida no disparaba. El watcher
 * que pollea segmentos también mira progreso: si el proceso no produce NI
 * crecimiento de archivo NI output en stderr por `stallTimeoutMs`, se lo
 * mata (SIGTERM → SIGKILL → salida forzada si tampoco reporta muerte) y el
 * intento cuenta como fallido → entra al mismo camino de reintento.
 * "Progreso" = cualquiera de las dos señales: con `-loglevel warning` un
 * ffmpeg sano puede estar callado minutos, así que exigir output solo
 * generaría kills falsos.
 *
 * Reanudación post-restart (PI-04): `opts.resume` NO crea fila nueva — la
 * UNIQUE de `stream_recordings.transmission_id` fuerza la reanudación sobre
 * la MISMA grabación (y además es lo correcto: la ancla `started_at` original
 * sigue gobernando los offsets, el corte queda como hueco entre el `end_ms`
 * del último segmento viejo y el `start_ms` del primero nuevo). El sweeper
 * del scheduler marca la grabación `interrupted`, cierra los segmentos
 * abiertos y llama a `startRecording({ resume })`: la fila vuelve a
 * `'recording'` (`resumeRecording`), los segmentos previos se seed-ean en
 * `segmentBytes`/`pendingSegments` para que el watcher no los re-inserte, y
 * `sequence` continúa desde `nextSequence`.
 *
 * Anclaje temporal de segmentos: el nombre `seg-%Y%m%d-%H%M%S.mp4` (strftime)
 * codifica el wall-clock real de apertura — es el ancla preferida; si no se
 * puede parsear, se usa el mtime del archivo (fallback del brief). Se clampea
 * a `>= 0`. `end_ms` queda NULL mientras el segmento escribe y se fija cuando
 * aparece el siguiente (o al cerrar).
 *
 * Estados (PD-04): TODO cambio de `transmissions.status` pasa por
 * `deps.transitionRun` (`transitionTransmission` en prod) — la FSM valida la
 * arista y los eventos se emiten por rooms tras el commit. El
 * `updateTransmission` del store queda sólo para parches SIN cambio de
 * estado: heartbeat, `resolved_stream_url`, y el re-ancla de `started_at`
 * cuando la corrida ya está `live` (el scheduler la fijó al detectar para
 * reservar el slot de concurrencia; el recorder re-ancla al instante real
 * de inicio de la captura).
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';

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
import { canTransition } from '../lib/transmissionStateMachine.js';
import { log } from '../lib/logger.js';
import { notify } from './notificationService.js';
import {
  transitionTransmission,
  type TransitionOptions,
  type TransitionRunner,
} from './transmissionService.js';

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
  /**
   * PI-04 — reanudar una grabación `interrupted`: misma fila, misma ancla,
   * mismo prefijo (el scheduler pasa `storagePrefix` explícito). Sin esto la
   * llamada crea una `stream_recordings` nueva.
   */
  resume?: ResumeRecordingOptions;
}

/** Parámetros de reanudación sobre la MISMA `stream_recordings` (PI-04). */
export interface ResumeRecordingOptions {
  /** Id de la grabación interrumpida a reanudar. */
  recordingId: string;
  /**
   * `started_at` ORIGINAL de la grabación — los offsets `start_ms`/`end_ms`
   * de segmentos (viejos y nuevos) se miden contra esta ancla.
   */
  startedAt: Date;
  /** `max(sequence) + 1` de `recording_segments` — la secuencia continúa. */
  nextSequence: number;
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

// ─── Hook de segmento cerrado (PE-04) ───────────────────────────────────────

/**
 * Identifica el segmento de grabación que acaba de CERRAR (end_ms fijado):
 * lo consume el runner de análisis en vivo (`liveAnalysisRunner`) para
 * disparar `processRecordingSegment` apenas hay audio completo que
 * transcribir.
 */
export interface SegmentFinalizedInfo {
  tenantId: string;
  transmissionId: string;
  recordingId: string;
  sequence: number;
}

export type SegmentFinalizedHook = (info: SegmentFinalizedInfo) => unknown;

let segmentFinalizedHook: SegmentFinalizedHook | null = null;

/**
 * Registra (o limpia con `null`) el hook que se dispara cuando un segmento
 * cierra — en los dos puntos de cierre del loop: `prevPending.closed = true`
 * en `pollSegments` y el cierre del último pending en `finalize`. Es
 * fire-and-forget: el recorder NUNCA lo awaita ni deja que un error del hook
 * rompa la captura. Default `null` = comportamiento idéntico a hoy.
 */
export function setSegmentFinalizedHook(fn: SegmentFinalizedHook | null): void {
  segmentFinalizedHook = fn;
}

/** Dispara el hook si hay uno registrado — errores logueados, nunca propagan. */
function fireSegmentFinalized(info: SegmentFinalizedInfo): void {
  if (!segmentFinalizedHook) return;
  try {
    Promise.resolve(segmentFinalizedHook(info)).catch((err) =>
      log.error('[recorder] segmentFinalizedHook falló', {
        tenantId: info.tenantId,
        transmissionId: info.transmissionId,
        recordingId: info.recordingId,
        sequence: info.sequence,
        err,
      }),
    );
  } catch (err) {
    log.error('[recorder] segmentFinalizedHook falló', {
      tenantId: info.tenantId,
      transmissionId: info.transmissionId,
      recordingId: info.recordingId,
      sequence: info.sequence,
      err,
    });
  }
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

/**
 * Parche SIN cambio de estado sobre `transmissions`. El `status` no está en
 * este tipo a propósito: todo cambio de estado pasa por `transitionRun`
 * (FSM + eventos) — PD-04.
 */
export interface RecorderTransmissionPatch {
  startedAt?: Date;
  endedAt?: Date;
  resolvedStreamUrl?: string;
  lastHeartbeatAt?: Date;
  crudoRef?: string;
  errorMessage?: string | null;
}

/** Fila mínima de `stream_recordings` que devuelve `resumeRecording`. */
export interface RecorderRecordingRow {
  id: string;
  transmissionId: string;
  storagePrefix: string;
  startedAt: Date;
}

/** Fila mínima de `recording_segments` que el recorder consume. */
export interface RecorderSegmentRow {
  sequence: number;
  fileRef: string;
  startMs: number;
  endMs: number | null;
  bytes: number;
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
  /**
   * Reanuda una grabación `interrupted` (PI-04): vuelve a `'recording'` y
   * limpia `ended_at`. El UPDATE filtra por tenant Y transmisión: devuelve
   * la fila reanudada o `null` si no existe / no es de esa corrida — un
   * resume con referencia errada no puede tocar la grabación de otra.
   */
  resumeRecording(
    tenantId: string,
    transmissionId: string,
    recordingId: string,
  ): Promise<RecorderRecordingRow | null>;
  /**
   * Todos los segmentos de la grabación ordenados por `sequence` — el seed
   * de la reanudación (los archivos ya conocidos no se re-insertan).
   */
  listSegments(
    tenantId: string,
    recordingId: string,
  ): Promise<RecorderSegmentRow[]>;
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

    async resumeRecording(tenantId, transmissionId, recordingId) {
      const [row] = await executor
        .update(streamRecordings)
        .set({ status: 'recording', endedAt: null })
        .where(
          and(
            eq(streamRecordings.id, recordingId),
            eq(streamRecordings.tenantId, tenantId),
            eq(streamRecordings.transmissionId, transmissionId),
          ),
        )
        .returning({
          id: streamRecordings.id,
          transmissionId: streamRecordings.transmissionId,
          storagePrefix: streamRecordings.storagePrefix,
          startedAt: streamRecordings.startedAt,
        });
      return row ?? null;
    },

    async listSegments(tenantId, recordingId) {
      return executor
        .select({
          sequence: recordingSegments.sequence,
          fileRef: recordingSegments.fileRef,
          startMs: recordingSegments.startMs,
          endMs: recordingSegments.endMs,
          bytes: recordingSegments.bytes,
        })
        .from(recordingSegments)
        .where(
          and(
            eq(recordingSegments.recordingId, recordingId),
            eq(recordingSegments.tenantId, tenantId),
          ),
        )
        .orderBy(asc(recordingSegments.sequence));
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
  /**
   * Watchdog de estancamiento (PI-04): si el proceso no muestra progreso
   * (ni crecen los segmentos ni hay output en stderr) por este tiempo, se
   * lo mata y el intento cuenta como fallido. Default 30 s; <= 0 lo apaga.
   */
  stallTimeoutMs?: number;
  /**
   * Notificación al tenant al terminar en error (PI-04 — fanout de
   * `notificationService.notify`, mismo canal que usan las alertas PE-07).
   * Fire-and-forget: nunca rompe el finalize.
   */
  notifyFn?: typeof notify;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Ejecutor de transiciones de estado (default: `transitionTransmission`
   * con el reloj inyectado del recorder) — PD-04. Los cambios de
   * `transmissions.status` no van por el store: van por acá.
   */
  transitionRun?: TransitionRunner;
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
  const stallTimeoutMs = deps.stallTimeoutMs ?? 30_000;
  const notifyFn = deps.notifyFn ?? notify;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  // Los cambios de estado de la corrida van por la FSM (PD-04): el reloj
  // inyectado gobierna también los timestamps que fija la transición.
  const transitionRun: TransitionRunner =
    deps.transitionRun ??
    ((o: TransitionOptions) =>
      transitionTransmission(o, { now: () => new Date(now()) }));

  const { tenantId, transmissionId } = opts;
  const segmentSeconds = opts.segmentSeconds ?? 60;

  const tx = await store.getTransmission(tenantId, transmissionId);
  if (!tx) {
    throw new Error(
      `Transmisión ${transmissionId} no encontrada para el tenant ${tenantId}`,
    );
  }
  // La corrida tiene que poder salir al aire: ya `live` (el scheduler la
  // fijó al detectar) o en un estado con arista a `live`. Una terminal
  // (done/error/canceled) no se graba: es un dispatch inconsistente.
  if (
    tx.status !== 'live' &&
    !canTransition(tx.status as TransmissionStatus, 'live')
  ) {
    throw new Error(
      `La transmisión ${transmissionId} no puede pasar a live desde '${tx.status}'`,
    );
  }

  // 1. Resolver la URL UNA vez.
  let resolved: ResolvedStream;
  try {
    resolved = await resolver(opts.streamUrl, { proxyUrls: deps.proxyUrls });
  } catch (err) {
    const msg = `No se pudo resolver la URL del stream: ${errorMessage(err)}`;
    await transitionRun({
      tenantId,
      transmissionId,
      to: 'error',
      errorMessage: msg,
    }).catch(() => {});
    throw err instanceof Error ? err : new Error(msg);
  }

  // 2. Fila stream_recordings + corrida `live` (startedAt = ancla wall-clock).
  //    PI-04: con `opts.resume` NO hay fila nueva — se reanuda la misma
  //    grabación conservando la ancla original (los offsets de los segmentos
  //    previos siguen valiendo y el corte queda como hueco entre end_ms y el
  //    start_ms del próximo segmento).
  const resuming = opts.resume ?? null;
  let recordingId: string;
  let storagePrefix = opts.storagePrefix ?? `${tenantId}/${transmissionId}`;
  let startedAtMs: number;
  if (resuming) {
    // interrupted → recording de nuevo (ended_at a NULL): la captura sigue.
    // El UPDATE filtra por tenant+transmisión y devuelve la fila — una
    // referencia errada falla acá, ANTES de spawnear o insertar segmentos.
    const row = await store.resumeRecording(tenantId, transmissionId, resuming.recordingId);
    if (!row) {
      throw new Error(
        `La grabación ${resuming.recordingId} no existe para reanudar ` +
          `(transmisión ${transmissionId}, tenant ${tenantId})`,
      );
    }
    recordingId = row.id;
    // La fila es autoritativa: prefijo y ancla de la captura ORIGINAL.
    storagePrefix = row.storagePrefix;
    startedAtMs = row.startedAt.getTime();
  } else {
    startedAtMs = now();
    recordingId = (
      await store.createRecording({
        tenantId,
        transmissionId,
        storagePrefix,
        startedAt: new Date(startedAtMs),
      })
    ).id;
  }
  if (tx.status === 'live') {
    // El scheduler ya la pasó a live al detectar: sólo se re-anclan los
    // campos al instante real de captura (parche sin cambio de estado). En
    // reanudación la ancla NO se toca: `started_at` sigue siendo el de la
    // captura original (los offsets de segmentos dependen de él).
    const patch: RecorderTransmissionPatch = {
      resolvedStreamUrl: resolved.url,
    };
    if (!resuming) patch.startedAt = new Date(startedAtMs);
    await store.updateTransmission(tenantId, transmissionId, patch);
  } else {
    // Camino directo (p.ej. disparo manual sin scheduler): la transición a
    // live va por la FSM y lleva los mismos campos en el mismo paso.
    const res = await transitionRun({
      tenantId,
      transmissionId,
      to: 'live',
      patch: {
        startedAt: new Date(startedAtMs),
        resolvedStreamUrl: resolved.url,
      },
    });
    if (!res.ok) {
      throw new Error(
        `La transmisión ${transmissionId} no pudo pasar a live: ${res.reason}`,
      );
    }
  }

  const segDir = storage.publicPath(storagePrefix);
  await fs.mkdir(segDir, { recursive: true });
  const outputPattern = path.join(segDir, 'seg-%Y%m%d-%H%M%S.mp4');

  // PI-02: logger derivado con trazabilidad — TODA línea del recorder lleva
  // tenantId/transmissionId/recordingId sin repetir los campos por call-site.
  const rlog = log.child({ tenantId, transmissionId, recordingId });

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

  // Seed de reanudación (PI-04): los segmentos ya persistidos se cargan como
  // "conocidos" para que el watcher no los re-inserte (los archivos están en
  // el mismo segDir) y `sequence` continúa donde quedó. Un archivo en disco
  // sin fila (escrito y no comiteado antes del crash) SÍ se inserta de nuevo
  // con su ancla strftime — recuperación honesta del último tramo.
  if (resuming) {
    const prior = await store
      .listSegments(tenantId, recordingId)
      .catch(() => [] as RecorderSegmentRow[]);
    for (const s of prior) {
      segmentBytes.set(s.fileRef, s.bytes);
      pendingSegments.push({
        sequence: s.sequence,
        fileName: s.fileRef,
        startMs: s.startMs,
        closed: s.endMs !== null,
      });
    }
    sequence = Math.max(
      resuming.nextSequence,
      prior.reduce((m, s) => Math.max(m, s.sequence + 1), 0),
    );
  }

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

  // El cap de duración se ancla en el started_at ORIGINAL también en
  // reanudación: una corrida de 60 min retomada al minuto 55 tiene 5 min de
  // margen, no 60. Si ya venció, el stop cae inmediatamente.
  const capEndsAtMs = (() => {
    const minutes = opts.maxDurationMinutes ?? tx.durationMinutes;
    return minutes && minutes > 0 ? startedAtMs + minutes * 60_000 : null;
  })();
  const capTimer =
    capEndsAtMs !== null
      ? setTimeout(() => void requestStop(), Math.max(0, capEndsAtMs - now()))
      : null;

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
        if (stat.size !== prev) {
          segmentBytes.set(name, stat.size);
          lastProgressAt = now(); // el segmento abierto sigue creciendo
        }
        continue;
      }
      segmentBytes.set(name, stat.size);
      lastProgressAt = now(); // segmento nuevo = progreso
      const startMs = computeSegmentStartMs({
        fileName: name,
        mtimeMs: stat.mtimeMs,
        startedAtMs,
      });
      // El segmento anterior deja de escribir: endMs = inicio del nuevo. El
      // guard `!closed` importa en reanudación (PI-04): los segmentos
      // seed-eados ya vienen cerrados y no hay que re-cerrarlos.
      const prevPending = pendingSegments[pendingSegments.length - 1];
      if (prevPending && !prevPending.closed) {
        await store
          .setSegmentEndMs(
            tenantId,
            recordingId,
            prevPending.sequence,
            Math.max(prevPending.startMs, startMs),
          )
          .catch((err) =>
            rlog.error('[recorder] setSegmentEndMs falló', {
              sequence: prevPending.sequence,
              err,
            }),
          );
        prevPending.closed = true;
        // PE-04: el segmento cerró → análisis en vivo (fire-and-forget).
        fireSegmentFinalized({
          tenantId,
          transmissionId,
          recordingId,
          sequence: prevPending.sequence,
        });
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
        .catch((err) =>
          rlog.error('[recorder] insertSegment falló', {
            sequence: seq,
            fileName: name,
            err,
          }),
        );
    }
  }

  /**
   * Último instante con progreso observable del proceso (epoch ms, reloj
   * inyectado): crece un segmento, aparece uno nuevo o hay output en stderr.
   * Se resetea en cada spawnAttempt — cada intento arranca "vivo".
   */
  let lastProgressAt = now();
  /**
   * Latch del watchdog por intento (PI-04): una vez detectado el stall se
   * dispara la escalera SIGTERM→SIGKILL→salida forzada UNA vez. Sin latch,
   * cada tick del watcher re-dispara kills y acumula timers hasta que el
   * proceso reporte muerte.
   */
  let stallLatched = false;

  const watcher = setInterval(() => {
    void pollSegments();
    checkStall();
  }, pollMs);

  /**
   * Watchdog de estancamiento (PI-04): un corte de red upstream deja a
   * ffmpeg colgado SIN salir — el retry por `close` nunca disparaba. Si no
   * hay progreso por `stallTimeoutMs` se mata el proceso y el intento cuenta
   * como fallido: SIGTERM (deja cerrar el segmento abierto) → SIGKILL →
   * salida forzada si ni así reportó muerte (garantiza el reintento).
   */
  function checkStall(): void {
    if (finished || stopRequested || !proc || procSettled || stallLatched) return;
    if (stallTimeoutMs <= 0) return;
    if (now() - lastProgressAt < stallTimeoutMs) return;
    stallLatched = true;
    const p = proc;
    lastError = `ffmpeg estancado: sin progreso en ${stallTimeoutMs} ms (el segmento abierto no crece y no hay output en stderr)`;
    rlog.warn(
      '[recorder] ffmpeg estancado — matando el proceso para reintentar',
      { attempt, maxRetries, stallTimeoutMs },
    );
    try {
      p.kill('SIGTERM');
    } catch {
      /* ya murió */
    }
    setTimeout(() => {
      if (finished || proc !== p || procSettled) return;
      try {
        p.kill('SIGKILL');
      } catch {
        /* ya murió */
      }
    }, Math.min(stopGraceMs, 5_000));
    setTimeout(() => {
      if (finished || proc !== p || procSettled) return;
      // Ni SIGTERM ni SIGKILL produjeron 'close'/'error': forzar la salida
      // lógica para que el intento cuente como fallido y entre al retry.
      procSettled = true;
      void onFfmpegExit(null, 'SIGKILL');
    }, Math.min(stopGraceMs, 5_000) + stopGraceMs);
  }

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
    stallLatched = false;
    lastProgressAt = now(); // el intento arranca "vivo"
    const p = spawnProcess(ffmpegPath, args);
    proc = p;
    // Los handlers filtran por identidad del proceso (`proc !== p`): un
    // zombie del intento anterior que tarde en morir NO puede contarse
    // como salida del intento nuevo (PI-04 — race real con el forced-exit
    // del watchdog, que respawnea sin esperar el 'close' del viejo).
    p.stderr?.on('data', (d) => {
      if (proc !== p) return;
      stderrTail = (stderrTail + d.toString()).slice(-2_000);
      lastProgressAt = now(); // output = signo de vida del proceso
    });
    p.on('error', (err) => {
      if (proc !== p || procSettled) return;
      procSettled = true;
      lastError = `Error al ejecutar ffmpeg: ${err.message}`;
      void onFfmpegExit(-1, null);
    });
    p.on('close', (code, signal) => {
      if (proc !== p || procSettled) return;
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
      rlog.warn(
        `[recorder] ffmpeg cayó (intento ${attempt}/${maxRetries}); re-resolviendo en ${backoffMs(attempt)} ms…`,
        { attempt, maxRetries },
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

    // Reintentos agotados (PI-04): transición honesta — la grabación queda
    // en su estado terminal 'error', el último segmento abierto se cierra en
    // finalize, la transmisión va a 'error' por FSM y se notifica al tenant.
    rlog.error('[recorder] reintentos agotados — grabación terminada con error', {
      attempt,
      maxRetries,
      lastError,
    });
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
      lastPending.closed = true;
      // PE-04: el último segmento cerró → análisis en vivo (fire-and-forget).
      fireSegmentFinalized({
        tenantId,
        transmissionId,
        recordingId,
        sequence: lastPending.sequence,
      });
    }

    totalBytes = [...segmentBytes.values()].reduce((a, b) => a + b, 0);
    const endedAt = new Date(now());

    await store
      .finalizeRecording(tenantId, recordingId, {
        status,
        totalBytes,
        endedAt,
      })
      .catch((err) =>
        rlog.error('[recorder] finalizeRecording falló', {
          status,
          totalBytes,
          err,
        }),
      );

    // La transición final (live → processing con crudo_ref, o → error) va
    // por la FSM y emite los eventos tras el commit. Si es rechazada (p.ej.
    // la corrida fue cancelada externamente) se loguea y `done` se resuelve
    // igual: la grabación física terminó, el estado es decisión de la FSM.
    await transitionRun(
      status === 'completed'
        ? {
            tenantId,
            transmissionId,
            to: 'processing',
            patch: { endedAt, crudoRef: storagePrefix },
          }
        : {
            tenantId,
            transmissionId,
            to: 'error',
            errorMessage: errorMsg ?? undefined,
            patch: { endedAt },
          },
    )
      .then((res) => {
        if (!res.ok) {
          rlog.error('[recorder] transición final rechazada', {
            to: status === 'completed' ? 'processing' : 'error',
            reason: res.reason,
          });
        }
      })
      .catch((err) => rlog.error('[recorder] transitionRun falló', { err }));

    // PI-04: la falla de ingesta llega al tenant como notificación (mismo
    // fanout que las alertas PE-07 usan para entregar). Best-effort: jamás
    // rompe el finalize ni cambia el outcome.
    if (status === 'error') {
      try {
        void Promise.resolve(
          notifyFn({
            tenantId,
            type: 'ingest_recording_failed',
            title: 'Grabación interrumpida',
            message:
              errorMsg ?? 'La captura del crudo terminó con error',
            icon: '📡',
            metadata: {
              transmissionId,
              recordingId,
              totalBytes,
              segmentCount: sequence,
            },
          }),
        ).catch((err) =>
          rlog.error('[recorder] notifyFn falló', { err }),
        );
      } catch (err) {
        rlog.error('[recorder] notifyFn falló', { err });
      }
    }

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
