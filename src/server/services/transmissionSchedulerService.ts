/**
 * transmissionSchedulerService — worker de `scheduled_transmissions` (PD-03).
 *
 * Dispara las corridas de la agenda según `next_run_at` (la recurrencia ya
 * viene resuelta en esa columna — `nextOccurrence` la avanza tras cada
 * disparo). Cuando el live NO está todavía al aire la corrida queda en
 * `waiting` y el mismo loop la reintenta cada `retryIntervalMs` hasta que
 * aparece o se agota la ventana de espera (`waitingWindowMinutes`, default
 * 30). La ventana se ancla en `waiting_since` (o `started_at` si aún no se
 * fijó): un reinicio del server NO reinicia la espera.
 *
 * Modelo de ejecución — ticks, no timers por corrida:
 *   `setInterval(60s)` llama `checkAndRunScheduledTransmissions` (exportado
 *   para tests). Cada tick hace TRES fases:
 *     A) Descubrimiento: agendas vencidas (`is_active` + `auto_start` +
 *        `next_run_at <= now`) → crea la `transmission` (status `scheduled`,
 *        `source='live_capture'`), aplica los gates (suscripción activa +
 *        cuota del ciclo) y avanza `next_run_at`.
 *     B) Reintentos: TODA corrida en `scheduled|waiting` (las recién creadas
 *        incluidas — el primer intento es inmediato) re-evalúa: ¿ventana
 *        agotada? → `error`; ¿intento no vencido o concurrencia llena? →
 *        sigue `waiting`; si no → `detectLiveStream`: al aire → `live` +
 *        `startRecording` en background; no → `waiting`.
 *     C) Purga de retención del crudo (PD-06): una vez cada
 *        `RETENTION_PURGE_INTERVAL_MINUTES` (default 1440) corre
 *        `purgeExpiredRecordings` global — contador de ticks + marca de
 *        última ejecución, todo try/catch (nunca tumba el loop).
 *
 * Decisiones documentadas:
 *   - `started_at`: se fija al disparar la ocurrencia (auditoría del dispatch)
 *     y el recorder lo re-ancla al instante real de inicio de la captura
 *     cuando el live aparece (el scheduler también lo escribe al pasar a
 *     `live`, mismo `now` — el valor definitivo es el del recorder).
 *   - Suscripción inactiva o cuota agotada → la corrida se crea y queda en
 *     `error` con mensaje descriptivo (la ocurrencia se consume igual:
 *     `next_run_at` avanza, `last_transmission_id` apunta a la corrida).
 *   - Cuota: `consumeTransmission` (Épica B) con `operationId=schedrun:{txId}`
 *     — idempotente por corrida. Si la ventana se agota sin live, la unidad
 *     se devuelve vía `releaseTransmission` (arranque fallido). Además se lee
 *     `plans.max_transmission_minutes` en el gate y se pasa a `startRecording`
 *     como `maxDurationMinutes` (min con `duration_minutes` de la agenda).
 *   - Concurrencia: `maxConcurrent` cuenta corridas en `live|processing`
 *     (global — el límite es de capacidad del server). Alcanzado → la corrida
 *     sigue `waiting`, jamás se descarta.
 *   - Reconciliación post-restart: `live` → `error` (ffmpeg murió con el
 *     proceso; los segmentos grabados quedan `active` para retención) —
 *     salvo que su recording ya esté `completed`, caso en el que pasa a
 *     `done`. `processing` → `done` (en este slice `processing` sólo lo
 *     escribe el recorder tras finalizar la captura OK). `waiting` y
 *     `scheduled` huérfanas las retoma el scan de la fase B (no tienen
 *     crudo en juego y la ventana sigue anclada en `waiting_since`/`started_at`).
 *   - Idempotencia: una corrida abierta (`scheduled|waiting|live|processing`)
 *     para la agenda ⇒ no se duplica; `next_run_at` avanza igual porque la
 *     ocurrencia vencida ya la consumió la corrida existente.
 *
 * Dependencias inyectables (`opts.deps`): store de DB, detector de live,
 * recorder, gate de suscripción, cuota y el ejecutor de transiciones — los
 * tests corren sin DB, sin red y sin timers reales (inyectan `now` y llaman
 * al tick).
 *
 * TODO cambio de `transmissions.status` pasa por `deps.transitionRun`
 * (`transitionTransmission` en prod — PD-04): la FSM valida la arista y los
 * eventos `transmission:status`/`transmission:updated` se emiten por rooms
 * tras el commit. El `updateRun` del store queda sólo para parches SIN
 * cambio de estado (p.ej. fijar `waiting_since` en una corrida ya waiting).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Server } from 'socket.io';
import { and, asc, count, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { plans, subscriptions } from '../db/schema/billing.js';
import {
  recordingSegments,
  streamRecordings,
} from '../db/schema/recordings.js';
import {
  scheduledTransmissions,
  transmissions,
} from '../db/schema/transmissions.js';
import type {
  TransmissionSource,
  TransmissionStatus,
} from '../db/schema/enums.js';
import { nextOccurrence } from '../lib/rrule.js';
import { log } from '../lib/logger.js';
import {
  detectLiveStream,
  type LiveDetectionResult,
} from './liveDetectorService.js';
import {
  startRecording,
  type RecordingHandle,
  type StartRecordingOptions,
} from './streamRecorderService.js';
import { getRawStorage } from './rawStorageService.js';
import { notify } from './notificationService.js';
import {
  consumeTransmission,
  releaseTransmission,
  type ConsumeResult,
} from './transmissionMeteringService.js';
import {
  transitionTransmission,
  type TransitionRunner,
} from './transmissionService.js';
import {
  purgeExpiredRecordings,
  type PurgeOutcome,
} from './rawRetentionService.js';

// ─── API pública ────────────────────────────────────────────────────────────

export interface TransmissionSchedulerOptions {
  /** Ventana de espera por live, en minutos. Default 30. */
  waitingWindowMinutes?: number;
  /** Intervalo entre reintentos de detección, en ms. Default 2 min (120000). */
  retryIntervalMs?: number;
  /** Máximo de transmisiones concurrentes. Default 5. */
  maxConcurrent?: number;
  /**
   * PI-04 — ventana de reanudación de crudo tras un restart, en minutos.
   * Si el corte de ingesta (último byte escrito → ahora) la excede, la
   * grabación huérfana queda `interrupted` terminal y la corrida va a
   * `error` con la razón — sin reintentos infinitos. Default 30.
   */
  resumeWindowMinutes?: number;
  /** Inyectable para tests. */
  now?: () => Date;
  /** Dependencias inyectables para tests (prod usa los defaults). */
  deps?: TransmissionSchedulerDeps;
}

/** Estados en los que una corrida sigue "abierta" (idempotencia + scans). */
const OPEN_RUN_STATUSES = ['scheduled', 'waiting', 'live', 'processing'] as const;
/** Estados que consume el scan de reintentos de la fase B. */
const PENDING_RUN_STATUSES = ['scheduled', 'waiting'] as const;
/** Estados que ocupan un slot de `maxConcurrent`. */
const ACTIVE_RUN_STATUSES = ['live', 'processing'] as const;
/** Estados reconciliados al boot (el proceso anterior murió con ellos). */
const STALE_RUN_STATUSES = ['live', 'processing'] as const;

const TICK_MS = 60_000;

// ─── Job de purga de retención (PD-06) ──────────────────────────────────────
// El tick es de 60 s ⇒ `intervalMinutes` minutos equivalen a esa cantidad de
// ticks. Configurable por env para poder apagarlo/afinarlo sin deploy.
const DEFAULT_PURGE_INTERVAL_MINUTES = 1440; // 24 h

/** `RETENTION_PURGE_ENABLED` — default true ('false'/'0' lo apagan). */
function retentionPurgeEnabled(): boolean {
  const raw = process.env.RETENTION_PURGE_ENABLED?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}

/** `RETENTION_PURGE_INTERVAL_MINUTES` — default 1440; mínimo 1. */
function retentionPurgeIntervalMinutes(): number {
  const raw = Number(process.env.RETENTION_PURGE_INTERVAL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, raw) : DEFAULT_PURGE_INTERVAL_MINUTES;
}

// ─── Filas mínimas que el scheduler lee (contrato del store) ───────────────

/** Campos de `scheduled_transmissions` que el scheduler necesita. */
export interface DueScheduled {
  id: string;
  tenantId: string;
  programId: string | null;
  streamUrl: string;
  rrule: string;
  timezone: string;
  durationMinutes: number;
  pipelineConfig: unknown;
}

/** Campos de `transmissions` que el scheduler necesita. */
export interface SchedulerRunRow {
  id: string;
  tenantId: string;
  status: string;
  streamUrl: string | null;
  startedAt: Date | null;
  waitingSince: Date | null;
  durationMinutes: number | null;
  scheduledTransmissionId: string | null;
}

export interface SchedulerRunInsert {
  tenantId: string;
  programId: string | null;
  scheduledTransmissionId: string | null;
  source: TransmissionSource;
  status: TransmissionStatus;
  streamUrl: string | null;
  durationMinutes: number | null;
  pipelineConfig: unknown;
  startedAt: Date;
}

/**
 * Parche SIN cambio de estado sobre `transmissions`. El `status` no está en
 * este tipo a propósito: todo cambio de estado pasa por `transitionRun`
 * (FSM + eventos) — PD-04.
 */
export interface SchedulerRunPatch {
  waitingSince?: Date;
  startedAt?: Date;
  endedAt?: Date;
  errorMessage?: string | null;
}

/** Avance de la agenda tras consumir una ocurrencia. */
export interface ScheduledAdvancePatch {
  lastRunAt?: Date;
  lastTransmissionId?: string | null;
  nextRunAt: Date | null;
}

export interface StaleRun extends SchedulerRunRow {
  /** `stream_recordings.status` si la corrida tiene grabación, si no null. */
  recordingStatus: string | null;
  /** `stream_recordings.id` (UNIQUE por transmisión), si existe. */
  recordingId: string | null;
  /** `stream_recordings.started_at` — ancla de offsets de segmentos. */
  recordingStartedAt: Date | null;
  /** `stream_recordings.storage_prefix` — raíz de los archivos del crudo. */
  storagePrefix: string | null;
}

/** Fila de `recording_segments` que el sweep de ingesta necesita (PI-04). */
export interface SchedulerSegmentRow {
  sequence: number;
  fileRef: string;
  startMs: number;
  endMs: number | null;
  bytes: number;
}

export interface SchedulerStore {
  /** Agendas vencidas: activas, auto_start, con next_run_at en el pasado. */
  findDueScheduled(now: Date): Promise<DueScheduled[]>;
  /** Id de una corrida abierta para la agenda (idempotencia), o null. */
  findOpenRunId(
    tenantId: string,
    scheduledTransmissionId: string,
  ): Promise<string | null>;
  insertRun(v: SchedulerRunInsert): Promise<{ id: string }>;
  /** TODA escritura sobre `transmissions` filtra por tenant_id. */
  updateRun(
    tenantId: string,
    runId: string,
    patch: SchedulerRunPatch,
  ): Promise<void>;
  advanceScheduled(
    tenantId: string,
    scheduledId: string,
    patch: ScheduledAdvancePatch,
  ): Promise<void>;
  /** Corridas en `scheduled|waiting` — el scan de reintentos. */
  listPendingRuns(): Promise<SchedulerRunRow[]>;
  /** Corridas en `live|processing` — ocupación del límite de concurrencia. */
  countActiveRuns(): Promise<number>;
  /** Corridas en `live|processing` + estado de su recording (reconcile). */
  listStaleRuns(): Promise<StaleRun[]>;
  /**
   * Segmentos de una grabación ordenados por `sequence` (sweep PI-04: cierre
   * de los abiertos + `nextSequence` de la reanudación).
   */
  listSegments(
    tenantId: string,
    recordingId: string,
  ): Promise<SchedulerSegmentRow[]>;
  /** Fija `end_ms` de un segmento abierto (cierre por sweep post-restart). */
  setSegmentEndMs(
    tenantId: string,
    recordingId: string,
    sequence: number,
    endMs: number,
  ): Promise<void>;
  /**
   * Parche sobre `stream_recordings` — el sweep marca `interrupted` +
   * `ended_at`. Filtra por tenant_id.
   */
  updateRecording(
    tenantId: string,
    recordingId: string,
    patch: { status?: string; endedAt?: Date | null },
  ): Promise<void>;
}

// ─── Dependencias inyectables ───────────────────────────────────────────────

/** Gate de suscripción/plan previo al dispatch. */
export interface DispatchGateResult {
  ok: boolean;
  /** Motivo legible cuando ok=false (va a transmissions.error_message). */
  reason?: string;
  /** `plans.max_transmission_minutes` — cap de duración de la captura. */
  maxTransmissionMinutes?: number | null;
}

export interface TransmissionSchedulerDeps {
  store?: SchedulerStore;
  detectLive?: (url: string) => Promise<LiveDetectionResult>;
  startRecording?: (opts: StartRecordingOptions) => Promise<RecordingHandle>;
  checkDispatchable?: (
    tenantId: string,
    now: Date,
  ) => Promise<DispatchGateResult>;
  consumeQuota?: (input: {
    tenantId: string;
    operationId: string;
    transmissionRef?: string;
    kind?: string;
  }) => Promise<ConsumeResult>;
  releaseQuota?: (input: {
    tenantId: string;
    operationId: string;
    reason: string;
  }) => Promise<unknown>;
  /**
   * Ejecutor de transiciones de estado (default: `transitionTransmission`).
   * Valida la FSM y emite `transmission:status`/`transmission:updated` por
   * rooms tras el commit — es la única vía de cambio de estado (PD-04).
   */
  transitionRun?: TransitionRunner;
  /**
   * Job de purga del crudo por retención de plan (PD-06). Default:
   * `purgeExpiredRecordings` global — borra archivos vencidos y marca los
   * segmentos `purged`. Inyectable para tests (spy, sin storage real).
   */
  purgeRetention?: (now: Date) => Promise<PurgeOutcome>;
  /**
   * PI-04 — mtime (epoch ms) de un archivo físico del crudo, null si no se
   * puede stat-ear. El sweep lo usa para cerrar segmentos abiertos con su
   * última escritura real. Default: `fs.stat`.
   */
  fileMtimeMs?: (filePath: string) => Promise<number | null>;
  /**
   * PI-04 — prefijo de storage → path físico. Default:
   * `getRawStorage().publicPath` (misma convención que el recorder).
   */
  storagePath?: (prefix: string) => string;
  /**
   * PI-04 — notificación al tenant ante corte/reanudación del crudo
   * (`notificationService.notify` en prod — mismo fanout que PE-07 usa para
   * entregar alertas). Best-effort: los callers la catchean.
   */
  notifyFn?: typeof notify;
}

interface ResolvedDeps {
  store: SchedulerStore;
  detectLive: (url: string) => Promise<LiveDetectionResult>;
  startRecording: (opts: StartRecordingOptions) => Promise<RecordingHandle>;
  checkDispatchable: (
    tenantId: string,
    now: Date,
  ) => Promise<DispatchGateResult>;
  consumeQuota: NonNullable<TransmissionSchedulerDeps['consumeQuota']>;
  releaseQuota: NonNullable<TransmissionSchedulerDeps['releaseQuota']>;
  transitionRun: TransitionRunner;
  purgeRetention: (now: Date) => Promise<PurgeOutcome>;
  fileMtimeMs: (filePath: string) => Promise<number | null>;
  storagePath: (prefix: string) => string;
  notifyFn: typeof notify;
}

// ─── Implementación drizzle del store ───────────────────────────────────────

const RUN_COLS = {
  id: transmissions.id,
  tenantId: transmissions.tenantId,
  status: transmissions.status,
  streamUrl: transmissions.streamUrl,
  startedAt: transmissions.startedAt,
  waitingSince: transmissions.waitingSince,
  durationMinutes: transmissions.durationMinutes,
  scheduledTransmissionId: transmissions.scheduledTransmissionId,
} as const;

/** Implementación drizzle — las escrituras a `transmissions` filtran tenant. */
export function createDrizzleSchedulerStore(
  executor: Database = db,
): SchedulerStore {
  return {
    async findDueScheduled(now) {
      return executor
        .select({
          id: scheduledTransmissions.id,
          tenantId: scheduledTransmissions.tenantId,
          programId: scheduledTransmissions.programId,
          streamUrl: scheduledTransmissions.streamUrl,
          rrule: scheduledTransmissions.rrule,
          timezone: scheduledTransmissions.timezone,
          durationMinutes: scheduledTransmissions.durationMinutes,
          pipelineConfig: scheduledTransmissions.pipelineConfig,
        })
        .from(scheduledTransmissions)
        .where(
          and(
            eq(scheduledTransmissions.isActive, true),
            eq(scheduledTransmissions.autoStart, true),
            isNotNull(scheduledTransmissions.nextRunAt),
            lte(scheduledTransmissions.nextRunAt, now),
          ),
        )
        .orderBy(asc(scheduledTransmissions.nextRunAt));
    },

    async findOpenRunId(tenantId, scheduledTransmissionId) {
      const [row] = await executor
        .select({ id: transmissions.id })
        .from(transmissions)
        .where(
          and(
            eq(transmissions.tenantId, tenantId),
            eq(transmissions.scheduledTransmissionId, scheduledTransmissionId),
            inArray(transmissions.status, [...OPEN_RUN_STATUSES]),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    },

    async insertRun(v) {
      const [row] = await executor
        .insert(transmissions)
        .values({
          tenantId: v.tenantId,
          programId: v.programId,
          scheduledTransmissionId: v.scheduledTransmissionId,
          source: v.source,
          status: v.status,
          streamUrl: v.streamUrl,
          durationMinutes: v.durationMinutes,
          pipelineConfig: v.pipelineConfig as Record<string, unknown>,
          startedAt: v.startedAt,
        })
        .returning({ id: transmissions.id });
      return row;
    },

    async updateRun(tenantId, runId, patch) {
      await executor
        .update(transmissions)
        .set(patch)
        .where(
          and(
            eq(transmissions.id, runId),
            eq(transmissions.tenantId, tenantId),
          ),
        );
    },

    async advanceScheduled(tenantId, scheduledId, patch) {
      await executor
        .update(scheduledTransmissions)
        .set(patch)
        .where(
          and(
            eq(scheduledTransmissions.id, scheduledId),
            eq(scheduledTransmissions.tenantId, tenantId),
          ),
        );
    },

    async listPendingRuns() {
      return executor
        .select(RUN_COLS)
        .from(transmissions)
        .where(inArray(transmissions.status, [...PENDING_RUN_STATUSES]));
    },

    async countActiveRuns() {
      const [row] = await executor
        .select({ n: count() })
        .from(transmissions)
        .where(inArray(transmissions.status, [...ACTIVE_RUN_STATUSES]));
      return row?.n ?? 0;
    },

    async listStaleRuns() {
      const rows = await executor
        .select({
          run: RUN_COLS,
          recordingStatus: streamRecordings.status,
          recordingId: streamRecordings.id,
          recordingStartedAt: streamRecordings.startedAt,
          storagePrefix: streamRecordings.storagePrefix,
        })
        .from(transmissions)
        .leftJoin(
          streamRecordings,
          eq(streamRecordings.transmissionId, transmissions.id),
        )
        .where(inArray(transmissions.status, [...STALE_RUN_STATUSES]));
      return rows.map((r) => ({
        ...r.run,
        recordingStatus: r.recordingStatus ?? null,
        recordingId: r.recordingId ?? null,
        recordingStartedAt: r.recordingStartedAt ?? null,
        storagePrefix: r.storagePrefix ?? null,
      }));
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

    async setSegmentEndMs(tenantId, recordingId, sequence, endMs) {
      await executor
        .update(recordingSegments)
        .set({ endMs })
        .where(
          and(
            eq(recordingSegments.recordingId, recordingId),
            eq(recordingSegments.tenantId, tenantId),
            eq(recordingSegments.sequence, sequence),
            // Sólo abiertos: un end_ms ya fijado no se pisa (idempotente).
            isNull(recordingSegments.endMs),
          ),
        );
    },

    async updateRecording(tenantId, recordingId, patch) {
      await executor
        .update(streamRecordings)
        .set(patch)
        .where(
          and(
            eq(streamRecordings.id, recordingId),
            eq(streamRecordings.tenantId, tenantId),
          ),
        );
    },
  };
}

// ─── Gate de suscripción + plan (misma semántica que requireActiveSubscription)

async function checkDispatchableSubscription(
  tenantId: string,
  now: Date,
): Promise<DispatchGateResult> {
  const [row] = await db
    .select({ sub: subscriptions, maxMin: plans.maxTransmissionMinutes })
    .from(subscriptions)
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);

  const maxTransmissionMinutes = row?.maxMin ?? null;
  if (!row?.sub) {
    return { ok: false, reason: 'el tenant no tiene suscripción', maxTransmissionMinutes };
  }

  const sub = row.sub;
  if (sub.status === 'active') return { ok: true, maxTransmissionMinutes };
  if (sub.status === 'trialing') {
    return !sub.trialEndsAt || sub.trialEndsAt > now
      ? { ok: true, maxTransmissionMinutes }
      : { ok: false, reason: 'el período de prueba expiró', maxTransmissionMinutes };
  }
  if (sub.status === 'past_due') {
    return sub.graceEndsAt && sub.graceEndsAt > now
      ? { ok: true, maxTransmissionMinutes }
      : { ok: false, reason: 'pago vencido y período de gracia agotado', maxTransmissionMinutes };
  }
  return {
    ok: false,
    reason: `suscripción en estado ${sub.status}`,
    maxTransmissionMinutes,
  };
}

// ─── Estado del proceso ─────────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let loopRunning = false;
let storedOpts: TransmissionSchedulerOptions = {};

/** Último intento de detección por corrida (ms epoch, reloj inyectado). */
const lastAttemptAt = new Map<string, number>();

// ─── Estado del job de purga de retención (PD-06) ───────────────────────────
// Mismo patrón que `MAINTENANCE_EVERY_N_TICKS` del scheduler legacy: contador
// de ticks + marca de última ejecución en memoria. La purga NO corre en cada
// tick (es I/O pesada): corre cuando vence el intervalo, y el primer tick del
// proceso también (catch-up post-boot — es idempotente: re-correr no borra
// dos veces porque la candidata exige segmentos aún no `purged`).
let retentionPurgeTicks = 0;
let lastRetentionPurgeAt: number | null = null;

function resolveDeps(opts: TransmissionSchedulerOptions): ResolvedDeps {
  const d = opts.deps ?? {};
  return {
    store: d.store ?? createDrizzleSchedulerStore(),
    detectLive: d.detectLive ?? detectLiveStream,
    startRecording:
      d.startRecording ??
      ((o: StartRecordingOptions) => startRecording(o)),
    checkDispatchable: d.checkDispatchable ?? checkDispatchableSubscription,
    consumeQuota: d.consumeQuota ?? consumeTransmission,
    releaseQuota: d.releaseQuota ?? releaseTransmission,
    // El reloj inyectado del scheduler también gobierna los timestamps que
    // fija la transición (started_at, ended_at, waiting_since...).
    transitionRun:
      d.transitionRun ??
      ((o) => transitionTransmission(o, { now: opts.now })),
    purgeRetention: d.purgeRetention ?? ((now) => purgeExpiredRecordings(now)),
    fileMtimeMs:
      d.fileMtimeMs ??
      ((p) =>
        fs
          .stat(p)
          .then((s) => s.mtimeMs)
          .catch(() => null)),
    storagePath:
      d.storagePath ?? ((prefix) => getRawStorage().publicPath(prefix)),
    notifyFn: d.notifyFn ?? notify,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** nextOccurrence a prueba de reglas rotas: null y un log, nunca tumba el tick. */
function safeNextOccurrence(
  rrule: string,
  from: Date,
  timezone: string,
): Date | null {
  try {
    return nextOccurrence(rrule, from, timezone);
  } catch (err) {
    log.error('[TransmissionScheduler] RRULE inválido', { rrule, timezone, err });
    return null;
  }
}

// ─── Fase A: descubrimiento y dispatch ──────────────────────────────────────

/**
 * Consume la ocurrencia vencida de una agenda: crea la corrida, aplica los
 * gates (suscripción, cuota) y avanza `next_run_at` SIEMPRE — la ocurrencia
 * queda consumida aunque la corrida nazca en `error` o ya exista una abierta.
 * Devuelve la corrida lista para su primer intento de detección, o null.
 */
async function dispatchScheduled(
  scheduled: DueScheduled,
  now: Date,
  deps: ResolvedDeps,
): Promise<SchedulerRunRow | null> {
  const { store } = deps;
  const nextRunAt = safeNextOccurrence(
    scheduled.rrule,
    now,
    scheduled.timezone,
  );

  // Idempotencia: una corrida abierta ya consumió esta ocurrencia — no se
  // duplica, pero la agenda avanza igual o quedaría vencida para siempre.
  const openId = await store.findOpenRunId(scheduled.tenantId, scheduled.id);
  if (openId) {
    await store.advanceScheduled(scheduled.tenantId, scheduled.id, {
      nextRunAt,
    });
    return null;
  }

  const inserted = await store.insertRun({
    tenantId: scheduled.tenantId,
    programId: scheduled.programId,
    scheduledTransmissionId: scheduled.id,
    source: 'live_capture',
    status: 'scheduled',
    streamUrl: scheduled.streamUrl,
    durationMinutes: scheduled.durationMinutes,
    pipelineConfig: scheduled.pipelineConfig,
    startedAt: now,
  });
  const runId = inserted.id;

  const fail = async (reason: string): Promise<null> => {
    await deps.transitionRun({
      tenantId: scheduled.tenantId,
      transmissionId: runId,
      to: 'error',
      errorMessage: reason,
    });
    await store.advanceScheduled(scheduled.tenantId, scheduled.id, {
      lastRunAt: now,
      lastTransmissionId: runId,
      nextRunAt,
    });
    return null;
  };

  // Gate 1 — suscripción activa (nunca se corta una transmisión activa: acá
  // todavía no arrancó nada, así que el gate va antes de la captura).
  const gate = await deps.checkDispatchable(scheduled.tenantId, now);
  if (!gate.ok) {
    return fail(
      `Sin suscripción activa al disparar la transmisión programada: ${gate.reason ?? 'inactiva'}`,
    );
  }

  // Gate 2 — cuota del ciclo (consumeTransmission es atómico e idempotente
  // por operationId; si el cupo está agotado no registra consumo).
  const operationId = `schedrun:${runId}`;
  const quota = await deps.consumeQuota({
    tenantId: scheduled.tenantId,
    operationId,
    transmissionRef: runId,
    kind: 'transmission_start',
  });
  if (!quota.allowed) {
    const plan = quota.quota?.planName ? ` (plan ${quota.quota.planName})` : '';
    return fail(`Cupo de transmisiones del ciclo agotado${plan}`);
  }

  await store.advanceScheduled(scheduled.tenantId, scheduled.id, {
    lastRunAt: now,
    lastTransmissionId: runId,
    nextRunAt,
  });

  // Cap de duración del plan: la captura no puede exceder
  // max_transmission_minutes aunque la agenda pida más.
  const planCap = gate.maxTransmissionMinutes;
  const durationMinutes =
    planCap !== null && planCap !== undefined && planCap > 0
      ? Math.min(scheduled.durationMinutes, planCap)
      : scheduled.durationMinutes;

  return {
    id: runId,
    tenantId: scheduled.tenantId,
    status: 'scheduled',
    streamUrl: scheduled.streamUrl,
    startedAt: now,
    waitingSince: null,
    durationMinutes,
    scheduledTransmissionId: scheduled.id,
  };
}

// ─── Fase B: ventana de espera + reintentos ─────────────────────────────────

/**
 * Evalúa una corrida pendiente. Devuelve 1 si consumió un slot de
 * concurrencia (pasó a `live`), 0 en cualquier otro caso.
 */
async function attemptRun(
  run: SchedulerRunRow,
  inFlight: number,
  opts: Required<
    Pick<
      TransmissionSchedulerOptions,
      'waitingWindowMinutes' | 'retryIntervalMs' | 'maxConcurrent'
    >
  >,
  deps: ResolvedDeps,
  now: Date,
): Promise<0 | 1> {
  const { store } = deps;
  // Ancla de la ventana: waiting_since si ya se fijó, si no el disparo
  // (started_at). Nunca se reinicia — sobrevive al retry y al restart.
  const anchor = run.waitingSince ?? run.startedAt ?? now;
  const elapsedMs = now.getTime() - anchor.getTime();
  const windowMs = opts.waitingWindowMinutes * 60_000;

  if (elapsedMs >= windowMs) {
    await deps.transitionRun({
      tenantId: run.tenantId,
      transmissionId: run.id,
      to: 'error',
      errorMessage: `No se detectó live en la ventana de espera de ${opts.waitingWindowMinutes} minutos (stream: ${run.streamUrl ?? 'sin URL'})`,
    });
    lastAttemptAt.delete(run.id);
    // El live nunca arrancó: se devuelve la unidad consumida al despachar.
    await deps
      .releaseQuota({
        tenantId: run.tenantId,
        operationId: `schedrun:${run.id}`,
        reason: 'start_failed',
      })
      .catch((err) =>
        log.error('[TransmissionScheduler] releaseQuota falló', {
          tenantId: run.tenantId,
          transmissionId: run.id,
          err,
        }),
      );
    return 0;
  }

  const last = lastAttemptAt.get(run.id);
  if (last !== undefined && now.getTime() - last < opts.retryIntervalMs) {
    return 0; // reintento todavía no vence
  }

  if (inFlight >= opts.maxConcurrent) {
    // Concurrencia llena: queda waiting sin consumir intento ni anclar
    // ventana nueva (el ancla es la original). Nunca se descarta.
    if (run.status !== 'waiting') {
      await deps.transitionRun({
        tenantId: run.tenantId,
        transmissionId: run.id,
        to: 'waiting',
        patch: { waitingSince: run.waitingSince ?? anchor },
      });
    } else if (!run.waitingSince) {
      // Ya está waiting pero sin ancla: es un parche de columna, no una
      // transición (waiting→waiting no es arista de la FSM).
      await store.updateRun(run.tenantId, run.id, { waitingSince: anchor });
    }
    return 0;
  }

  lastAttemptAt.set(run.id, now.getTime());

  let result: LiveDetectionResult | null = null;
  try {
    result = await deps.detectLive(run.streamUrl ?? '');
  } catch (err) {
    // Un detector que lanza equivale a "no encontrado": se reintenta dentro
    // de la ventana igual que un found:false.
    log.error('[TransmissionScheduler] detectLive falló', {
      tenantId: run.tenantId,
      transmissionId: run.id,
      err,
    });
  }

  if (result?.found) {
    const transitioned = await deps.transitionRun({
      tenantId: run.tenantId,
      transmissionId: run.id,
      to: 'live',
      patch: { startedAt: now },
    });
    if (!transitioned.ok) {
      // La FSM rechazó (p.ej. la corrida cambió de estado entre el scan y
      // el intento): no se arranca la grabación sobre un estado inválido.
      log.error('[TransmissionScheduler] no se pudo pasar a live', {
        tenantId: run.tenantId,
        transmissionId: run.id,
        reason: transitioned.reason,
      });
      return 0;
    }
    lastAttemptAt.delete(run.id);
    void runRecordingInBackground(run, result.liveUrl ?? run.streamUrl, deps);
    return 1;
  }

  if (run.status !== 'waiting') {
    await deps.transitionRun({
      tenantId: run.tenantId,
      transmissionId: run.id,
      to: 'waiting',
      patch: { waitingSince: run.waitingSince ?? anchor },
    });
  } else if (!run.waitingSince) {
    await store.updateRun(run.tenantId, run.id, { waitingSince: anchor });
  }
  return 0;
}

/**
 * Arranca la captura sin bloquear el loop: `startRecording` resuelve y graba
 * de forma async (puede tardar horas). Cuando `done` se resuelve, la corrida
 * pasa a `done` (el recorder ya la dejó en `processing` con `crudo_ref`) o a
 * `error` con el mensaje del recorder.
 */
function runRecordingInBackground(
  run: SchedulerRunRow,
  liveUrl: string | null,
  deps: ResolvedDeps,
  recorderOpts: Pick<StartRecordingOptions, 'storagePrefix' | 'resume'> = {},
): void {
  void (async () => {
    try {
      const handle = await deps.startRecording({
        tenantId: run.tenantId,
        transmissionId: run.id,
        streamUrl: liveUrl ?? run.streamUrl ?? '',
        maxDurationMinutes: run.durationMinutes ?? undefined,
        ...recorderOpts,
      });
      const outcome = await handle.done;
      const res = await deps
        .transitionRun({
          tenantId: run.tenantId,
          transmissionId: run.id,
          to: outcome.status === 'completed' ? 'done' : 'error',
          errorMessage:
            outcome.status === 'completed'
              ? undefined
              : (outcome.errorMessage ?? 'La grabación terminó con error'),
        })
        .catch((err: unknown) => {
          log.error('[TransmissionScheduler] transición final falló', {
            tenantId: run.tenantId,
            transmissionId: run.id,
            err,
          });
          return { ok: false as const, reason: errorMessage(err) };
        });
      if (res && !res.ok) {
        log.error('[TransmissionScheduler] transición final rechazada', {
          tenantId: run.tenantId,
          transmissionId: run.id,
          reason: res.reason,
        });
      }
    } catch (err) {
      await deps
        .transitionRun({
          tenantId: run.tenantId,
          transmissionId: run.id,
          to: 'error',
          errorMessage: `No se pudo iniciar la grabación: ${errorMessage(err)}`,
        })
        .catch(() => {});
    }
  })().catch((err) =>
    log.error('[TransmissionScheduler] recorder falló', {
      tenantId: run.tenantId,
      transmissionId: run.id,
      err,
    }),
  );
}

// ─── Reconciliación post-restart ────────────────────────────────────────────

/** Ventana de reanudación de crudo por defecto (PI-04), en minutos. */
export const DEFAULT_RESUME_WINDOW_MINUTES = 30;

export interface OrphanRecoveryDecision {
  resume: boolean;
  /** Razón de NO reanudar (español — compone el `error_message` del run). */
  reason?: string;
}

/**
 * Decide si una grabación huérfana se reanuda o se cierra para siempre
 * (PI-04). Dos cortes independientes — cualquiera basta para el terminal:
 *   1. ventana live del run: `startedAt + durationMinutes` ya pasó — el
 *      programa terminó aunque la captura hubiera seguido.
 *   2. corte largo: el tiempo sin escribir (`outageMs`, anclado en el
 *      último `end_ms`/mtime real) excede `resumeWindowMs`.
 * Sin loops infinitos: cada reanudación exige ambas ventanas vivas y el
 * ancla del corte es el último byte real, no un contador reseteable.
 */
export function decideOrphanRecovery(input: {
  outageMs: number;
  resumeWindowMs: number;
  /** Fin de la ventana live del run (epoch ms) — null = corrida sin cap. */
  liveWindowEndMs: number | null;
  nowMs: number;
}): OrphanRecoveryDecision {
  if (input.liveWindowEndMs !== null && input.nowMs >= input.liveWindowEndMs) {
    return {
      resume: false,
      reason: 'la ventana live de la transmisión ya había terminado',
    };
  }
  if (input.outageMs > input.resumeWindowMs) {
    const mins = Math.round(input.outageMs / 60_000);
    const win = Math.round(input.resumeWindowMs / 60_000);
    return {
      resume: false,
      reason: `el corte de ingesta duró ${mins} min y excede la ventana de reanudación de ${win} min`,
    };
  }
  return { resume: true };
}

/**
 * PI-04 — recuperación de una grabación huérfana al boot.
 *
 * La fila `stream_recordings` quedó en `recording` (o `interrupted` de un
 * sweep anterior que no alcanzó a reanudar) pero el ffmpeg dueño murió con
 * el proceso anterior. Pasos:
 *   1. Cerrar segmentos abiertos: `end_ms` = última escritura real (mtime
 *      del archivo) menos el `started_at` de la grabación. Si el archivo no
 *      stat-ea, el segmento colapsa a su `start_ms` — no podemos probar
 *      contenido posterior: honesto antes que inflado.
 *   2. Marcar la grabación `interrupted` + `ended_at` — el corte SÍ pasó.
 *   3. `decideOrphanRecovery`:
 *      - reanudable → MISMA grabación con intento nuevo (la UNIQUE de
 *        `transmission_id` lo fuerza, y conserva la ancla de offsets): la
 *        fila vuelve a `recording` dentro de `startRecording({resume})`, la
 *        corrida sigue `live` — nunca salió de ese estado.
 *      - terminal → la corrida va a `error` por FSM con la razón, y el
 *        tenant recibe notificación `ingest_interrupted`.
 */
async function recoverOrphanedRecording(
  run: StaleRun,
  deps: ResolvedDeps,
  now: Date,
  resumeWindowMs: number,
): Promise<void> {
  const { store } = deps;
  const recordingId = run.recordingId as string;
  const storagePrefix = run.storagePrefix ?? `${run.tenantId}/${run.id}`;
  const recStartedAtMs =
    run.recordingStartedAt?.getTime() ?? run.startedAt?.getTime() ?? now.getTime();

  // 1) Cierre de segmentos abiertos — end_ms anclado al mtime real.
  const segments = await store.listSegments(run.tenantId, recordingId);
  let lastAliveMs = recStartedAtMs;
  let nextSequence = 0;
  let openClosed = 0;
  for (const seg of segments) {
    nextSequence = Math.max(nextSequence, seg.sequence + 1);
    if (seg.endMs === null) {
      const mtimeMs = await deps.fileMtimeMs(
        path.join(deps.storagePath(storagePrefix), seg.fileRef),
      );
      const endMs =
        mtimeMs !== null
          ? Math.max(seg.startMs, Math.round(mtimeMs - recStartedAtMs))
          : seg.startMs;
      await store.setSegmentEndMs(run.tenantId, recordingId, seg.sequence, endMs);
      openClosed += 1;
      lastAliveMs = Math.max(lastAliveMs, recStartedAtMs + endMs);
    } else {
      lastAliveMs = Math.max(lastAliveMs, recStartedAtMs + seg.endMs);
    }
  }
  const outageMs = Math.max(0, now.getTime() - lastAliveMs);

  // 2) La grabación queda 'interrupted' — si se reanuda vuelve a 'recording'.
  await store.updateRecording(run.tenantId, recordingId, {
    status: 'interrupted',
    endedAt: now,
  });
  log.warn('[TransmissionScheduler] grabación huérfana → interrupted', {
    tenantId: run.tenantId,
    transmissionId: run.id,
    recordingId,
    openSegmentsClosed: openClosed,
    outageMs,
  });

  // 3) Reanudar o cerrar para siempre (ventana live + corte largo).
  const liveWindowEndMs =
    run.durationMinutes && run.durationMinutes > 0
      ? (run.startedAt?.getTime() ?? recStartedAtMs) +
        run.durationMinutes * 60_000
      : null;
  const decision = decideOrphanRecovery({
    outageMs,
    resumeWindowMs,
    liveWindowEndMs,
    nowMs: now.getTime(),
  });

  if (!decision.resume) {
    const reason = `El servidor se reinició durante la transmisión y ${decision.reason}`;
    await deps.transitionRun({
      tenantId: run.tenantId,
      transmissionId: run.id,
      to: 'error',
      errorMessage: reason,
    });
    await deps
      .notifyFn({
        tenantId: run.tenantId,
        type: 'ingest_interrupted',
        title: 'Grabación interrumpida',
        message: reason,
        icon: '📡',
        metadata: { transmissionId: run.id, recordingId, outageMs },
      })
      .catch(() => {});
    return;
  }

  log.info('[TransmissionScheduler] reanudando grabación huérfana', {
    tenantId: run.tenantId,
    transmissionId: run.id,
    recordingId,
    outageMs,
    nextSequence,
  });
  runRecordingInBackground(run, run.streamUrl, deps, {
    storagePrefix,
    resume: {
      recordingId,
      startedAt: run.recordingStartedAt ?? new Date(recStartedAtMs),
      nextSequence,
    },
  });
  await deps
    .notifyFn({
      tenantId: run.tenantId,
      type: 'ingest_resumed',
      title: 'Grabación reanudada',
      message: `La captura del crudo se reanudó tras un corte de ${Math.round(outageMs / 1000)} s`,
      icon: '📡',
      metadata: { transmissionId: run.id, recordingId, outageMs },
    })
    .catch(() => {});
}

/**
 * Al boot, toda corrida en `live|processing` es huérfana por definición: el
 * recorder (ffmpeg hijo del proceso) murió con el server. Se cierran sin
 * tocar los segmentos ya grabados:
 *   - `processing` → `done` (la captura ya había finalizado OK).
 *   - `live` con recording `completed` → `done`; como `live → done` no es
 *     arista de la FSM se hace el camino honesto `live → processing → done`
 *     (la captura había completado: el estado intermedio es real).
 *   - `live` con recording abierta (`recording`/`interrupted`) → sweep de
 *     ingesta PI-04: cierra segmentos, marca `interrupted` y REANUDA el
 *     crudo si el corte está dentro de la ventana — si no, `error` con la
 *     razón (`recoverOrphanedRecording`).
 *   - `live` sin recording → `error` "servidor reiniciado durante la
 *     transmisión".
 * Las `waiting|scheduled` no se tocan: el scan las retoma respetando su
 * `waiting_since`/`started_at` original (la ventana no se reinicia).
 */
export async function reconcileOrphanedRuns(
  opts: TransmissionSchedulerOptions = {},
): Promise<void> {
  const deps = resolveDeps(opts);
  const now = opts.now?.() ?? new Date();
  const resumeWindowMs =
    (opts.resumeWindowMinutes ?? DEFAULT_RESUME_WINDOW_MINUTES) * 60_000;
  const stale = await deps.store.listStaleRuns();
  for (const run of stale) {
    try {
      const captured =
        run.status === 'processing' || run.recordingStatus === 'completed';
      if (captured) {
        if (run.status === 'live') {
          await deps.transitionRun({
            tenantId: run.tenantId,
            transmissionId: run.id,
            to: 'processing',
          });
        }
        await deps.transitionRun({
          tenantId: run.tenantId,
          transmissionId: run.id,
          to: 'done',
        });
      } else if (
        run.status === 'live' &&
        run.recordingId !== null &&
        (run.recordingStatus === 'recording' ||
          run.recordingStatus === 'interrupted')
      ) {
        await recoverOrphanedRecording(run, deps, now, resumeWindowMs);
      } else {
        await deps.transitionRun({
          tenantId: run.tenantId,
          transmissionId: run.id,
          to: 'error',
          errorMessage: 'El servidor se reinició durante la transmisión',
        });
      }
    } catch (err) {
      log.error('[TransmissionScheduler] reconcile falló', {
        tenantId: run.tenantId,
        transmissionId: run.id,
        err,
      });
    }
  }
}

// ─── Loop principal ─────────────────────────────────────────────────────────

/**
 * Un tick del scheduler: descubre agendas vencidas, crea sus corridas con los
 * gates aplicados y re-evalúa TODA corrida pendiente (waiting window +
 * reintentos). Envuelta por el caller en try/catch — una falla nunca tumba el
 * scheduler. Reentrada protegida: si un tick sigue corriendo, el siguiente se
 * saltea.
 */
export async function checkAndRunScheduledTransmissions(
  opts: TransmissionSchedulerOptions = {},
): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  try {
    const deps = resolveDeps(opts);
    const now = opts.now?.() ?? new Date();
    const resolved = {
      waitingWindowMinutes: opts.waitingWindowMinutes ?? 30,
      retryIntervalMs: opts.retryIntervalMs ?? 120_000,
      maxConcurrent: opts.maxConcurrent ?? 5,
    };

    // Fase A — descubrimiento.
    const due = await deps.store.findDueScheduled(now);
    const fresh: SchedulerRunRow[] = [];
    for (const scheduled of due) {
      try {
        const run = await dispatchScheduled(scheduled, now, deps);
        if (run) fresh.push(run);
      } catch (err) {
        log.error('[TransmissionScheduler] dispatch falló', {
          tenantId: scheduled.tenantId,
          scheduledTransmissionId: scheduled.id,
          err,
        });
      }
    }

    // Fase B — scan de pendientes (las viejas primero, las nuevas al final).
    const pending = await deps.store.listPendingRuns();
    const byId = new Map<string, SchedulerRunRow>(
      pending.map((r) => [r.id, r]),
    );
    for (const run of fresh) byId.set(run.id, run);

    // Poda del mapa de intentos: sólo ids todavía pendientes.
    for (const id of lastAttemptAt.keys()) {
      if (!byId.has(id)) lastAttemptAt.delete(id);
    }

    let inFlight = await deps.store.countActiveRuns();
    for (const run of byId.values()) {
      try {
        inFlight += await attemptRun(run, inFlight, resolved, deps, now);
      } catch (err) {
        log.error('[TransmissionScheduler] intento falló', {
          tenantId: run.tenantId,
          transmissionId: run.id,
          err,
        });
      }
    }

    // Fase C — purga de retención del crudo (PD-06). Una vez por día (env
    // `RETENTION_PURGE_INTERVAL_MINUTES`, default 1440) y al primer tick del
    // proceso. Doble guardia — contador de ticks Y marca de última ejecución:
    // ninguna sola condición basta, así un `now` inyectado raro o un restart
    // no disparan purgas extra. Todo en try/catch: jamás tumba el scheduler.
    retentionPurgeTicks += 1;
    const purgeIntervalMinutes = retentionPurgeIntervalMinutes();
    const purgeDueByTicks =
      lastRetentionPurgeAt === null ||
      retentionPurgeTicks >= Math.max(1, Math.round(purgeIntervalMinutes));
    const purgeDueByClock =
      lastRetentionPurgeAt === null ||
      now.getTime() - lastRetentionPurgeAt >= purgeIntervalMinutes * 60_000;
    if (retentionPurgeEnabled() && purgeDueByTicks && purgeDueByClock) {
      retentionPurgeTicks = 0;
      lastRetentionPurgeAt = now.getTime();
      try {
        const outcome = await deps.purgeRetention(now);
        if (outcome.purged > 0 || outcome.errors.length > 0) {
          log.info('[TransmissionScheduler] purga de retención', {
            purged: outcome.purged,
            scanned: outcome.scanned,
            bytesFreed: outcome.bytesFreed,
            skipped: outcome.skipped,
            errors: outcome.errors.length,
          });
        }
      } catch (err) {
        log.error('[TransmissionScheduler] purga de retención falló', { err });
      }
    }
  } finally {
    loopRunning = false;
  }
}

// ─── Init / stop ────────────────────────────────────────────────────────────

/**
 * Inicializa el scheduler de transmisiones: reconcilia huérfanas del proceso
 * anterior y arranca el loop de 60 s. Envuelto en try/catch por fase — una
 * falla nunca tumba el boot del server.
 */
export function initTransmissionScheduler(
  io: Server,
  opts: TransmissionSchedulerOptions = {},
): void {
  // `io` no se usa directo: los eventos salen por `transitionTransmission`,
  // que tiene su propio ioRef (initTransmissionService). Se conserva el
  // parámetro por compatibilidad de la firma pública.
  void io;
  storedOpts = opts;

  if (schedulerInterval) clearInterval(schedulerInterval);

  reconcileOrphanedRuns(opts).catch((err) => {
    log.error('[TransmissionScheduler] Error en reconcileOrphanedRuns (startup)', { err });
  });

  schedulerInterval = setInterval(() => {
    checkAndRunScheduledTransmissions(storedOpts).catch((err) => {
      log.error('[TransmissionScheduler] Error en el loop', { err });
    });
  }, TICK_MS);

  log.info('[TransmissionScheduler] Inicializado — chequeo cada 60s', { tickMs: TICK_MS });
}

export function stopTransmissionScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  lastAttemptAt.clear();
  // La fase C vuelve al estado "recién booteado": próximo init, primer
  // tick = catch-up de purga otra vez.
  retentionPurgeTicks = 0;
  lastRetentionPurgeAt = null;
}
