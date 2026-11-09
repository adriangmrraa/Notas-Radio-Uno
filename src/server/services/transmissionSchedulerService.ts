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
 *   para tests). Cada tick hace DOS fases:
 *     A) Descubrimiento: agendas vencidas (`is_active` + `auto_start` +
 *        `next_run_at <= now`) → crea la `transmission` (status `scheduled`,
 *        `source='live_capture'`), aplica los gates (suscripción activa +
 *        cuota del ciclo) y avanza `next_run_at`.
 *     B) Reintentos: TODA corrida en `scheduled|waiting` (las recién creadas
 *        incluidas — el primer intento es inmediato) re-evalúa: ¿ventana
 *        agotada? → `error`; ¿intento no vencido o concurrencia llena? →
 *        sigue `waiting`; si no → `detectLiveStream`: al aire → `live` +
 *        `startRecording` en background; no → `waiting`.
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
import type { Server } from 'socket.io';
import { and, asc, count, eq, inArray, isNotNull, lte } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { plans, subscriptions } from '../db/schema/billing.js';
import { streamRecordings } from '../db/schema/recordings.js';
import {
  scheduledTransmissions,
  transmissions,
} from '../db/schema/transmissions.js';
import type {
  TransmissionSource,
  TransmissionStatus,
} from '../db/schema/enums.js';
import { nextOccurrence } from '../lib/rrule.js';
import {
  detectLiveStream,
  type LiveDetectionResult,
} from './liveDetectorService.js';
import {
  startRecording,
  type RecordingHandle,
  type StartRecordingOptions,
} from './streamRecorderService.js';
import {
  consumeTransmission,
  releaseTransmission,
  type ConsumeResult,
} from './transmissionMeteringService.js';
import {
  transitionTransmission,
  type TransitionRunner,
} from './transmissionService.js';

// ─── API pública ────────────────────────────────────────────────────────────

export interface TransmissionSchedulerOptions {
  /** Ventana de espera por live, en minutos. Default 30. */
  waitingWindowMinutes?: number;
  /** Intervalo entre reintentos de detección, en ms. Default 2 min (120000). */
  retryIntervalMs?: number;
  /** Máximo de transmisiones concurrentes. Default 5. */
  maxConcurrent?: number;
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
        .select({ run: RUN_COLS, recordingStatus: streamRecordings.status })
        .from(transmissions)
        .leftJoin(
          streamRecordings,
          eq(streamRecordings.transmissionId, transmissions.id),
        )
        .where(inArray(transmissions.status, [...STALE_RUN_STATUSES]));
      return rows.map((r) => ({
        ...r.run,
        recordingStatus: r.recordingStatus ?? null,
      }));
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
    console.error(
      `[TransmissionScheduler] RRULE inválido (${rrule}, tz ${timezone}):`,
      errorMessage(err),
    );
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
        console.error(
          `[TransmissionScheduler] releaseQuota ${run.id} falló:`,
          errorMessage(err),
        ),
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
    console.error(
      `[TransmissionScheduler] detectLive falló para ${run.id}:`,
      errorMessage(err),
    );
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
      console.error(
        `[TransmissionScheduler] ${run.id}: no se pudo pasar a live: ${transitioned.reason}`,
      );
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
): void {
  void (async () => {
    try {
      const handle = await deps.startRecording({
        tenantId: run.tenantId,
        transmissionId: run.id,
        streamUrl: liveUrl ?? run.streamUrl ?? '',
        maxDurationMinutes: run.durationMinutes ?? undefined,
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
          console.error(
            `[TransmissionScheduler] transición final ${run.id} falló:`,
            errorMessage(err),
          );
          return { ok: false as const, reason: errorMessage(err) };
        });
      if (res && !res.ok) {
        console.error(
          `[TransmissionScheduler] ${run.id}: transición final rechazada: ${res.reason}`,
        );
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
    console.error(
      `[TransmissionScheduler] recorder ${run.id} falló:`,
      errorMessage(err),
    ),
  );
}

// ─── Reconciliación post-restart ────────────────────────────────────────────

/**
 * Al boot, toda corrida en `live|processing` es huérfana por definición: el
 * recorder (ffmpeg hijo del proceso) murió con el server. Se cierran sin
 * tocar los segmentos ya grabados:
 *   - `processing` → `done` (la captura ya había finalizado OK).
 *   - `live` con recording `completed` → `done`; como `live → done` no es
 *     arista de la FSM se hace el camino honesto `live → processing → done`
 *     (la captura había completado: el estado intermedio es real).
 *   - `live` sin recording o con recording abierta → `error` "servidor
 *     reiniciado durante la transmisión".
 * Las `waiting|scheduled` no se tocan: el scan las retoma respetando su
 * `waiting_since`/`started_at` original (la ventana no se reinicia).
 */
export async function reconcileOrphanedRuns(
  opts: TransmissionSchedulerOptions = {},
): Promise<void> {
  const deps = resolveDeps(opts);
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
      } else {
        await deps.transitionRun({
          tenantId: run.tenantId,
          transmissionId: run.id,
          to: 'error',
          errorMessage: 'El servidor se reinició durante la transmisión',
        });
      }
    } catch (err) {
      console.error(
        `[TransmissionScheduler] reconcile ${run.id} falló:`,
        errorMessage(err),
      );
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
        console.error(
          `[TransmissionScheduler] dispatch de ${scheduled.id} falló:`,
          errorMessage(err),
        );
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
        console.error(
          `[TransmissionScheduler] intento de ${run.id} falló:`,
          errorMessage(err),
        );
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
    console.error(
      '[TransmissionScheduler] Error en reconcileOrphanedRuns (startup):',
      err,
    );
  });

  schedulerInterval = setInterval(() => {
    checkAndRunScheduledTransmissions(storedOpts).catch((err) => {
      console.error('[TransmissionScheduler] Error en el loop:', err);
    });
  }, TICK_MS);

  console.log('[TransmissionScheduler] Inicializado — chequeo cada 60s');
}

export function stopTransmissionScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  lastAttemptAt.clear();
}
