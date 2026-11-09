/**
 * startLiveService — disparo manual de una fuente live (PD-07, Parte D).
 *
 * Crea la corrida en `transmissions` con `source='live_capture'` y
 * `status='waiting'` (ancla `waiting_since`/`started_at` en el instante del
 * disparo). NO llama al recorder desde la request HTTP — una request no se
 * bloquea grabando una hora:
 *
 *   TODO (enganche PD-03): el scan de pendientes del scheduler
 *   (`listPendingRuns` incluye `waiting`) toma esta corrida en el próximo
 *   tick, corre `detectLiveStream` sobre `stream_url` y — si hay live al
 *   aire — la transiciona a `live` y arranca `startRecording` en
 *   background. El scheduler también aplica ventana de espera, cap de
 *   concurrencia y la cuota del ciclo.
 *
 * Si el body referencia una `scheduled_transmission_id` del tenant, la
 * agenda se avanza en la misma transacción (`last_run_at`,
 * `last_transmission_id`, `next_run_at` por `nextOccurrence`) — igual que
 * el disparo manual existente en `POST /scheduled/:id/start`.
 *
 * Reglas duras (Parte E): tenantId del token, toda query filtra por
 * tenant_id, un programId/scheduledId ajeno ⇒ 404.
 */
import { and, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { programs } from '../db/schema/programs.js';
import {
  scheduledTransmissions,
  transmissions,
} from '../db/schema/transmissions.js';
import type { TransmissionRow } from './transmissionService.js';
import { AppError } from '../lib/errors.js';
import { nextOccurrence } from '../lib/rrule.js';
import {
  detectStreamSource,
  isHttpUrl,
  type StreamSourceKind,
} from '../lib/streamSources.js';
import { MAX_DURATION_MINUTES, MIN_DURATION_MINUTES } from '../lib/scheduleRules.js';

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface StartLiveInput {
  tenantId: string;
  streamUrl: string;
  programId?: string | null;
  /** Agenda origen (opcional) — tiene que pertenecer al tenant. */
  scheduledTransmissionId?: string | null;
  durationMinutes?: number | null;
}

export interface StartLiveResult {
  transmission: TransmissionRow;
  /** Kind detectado por el registry (informativo — siempre ≠ 'upload'). */
  sourceKind: StreamSourceKind;
}

/** Store del disparo manual — TODA operación filtra por tenant_id. */
export interface StartLiveStore {
  programBelongsToTenant(tenantId: string, programId: string): Promise<boolean>;
  findScheduled(
    tenantId: string,
    scheduledId: string,
  ): Promise<{
    id: string;
    tenantId: string;
    rrule: string;
    timezone: string;
  } | null>;
  /**
   * Inserta la corrida (status 'waiting') y, si viene de una agenda, la
   * avanza — todo en UNA transacción. Devuelve la fila creada.
   */
  createLiveRun(v: {
    tenantId: string;
    programId: string | null;
    scheduledTransmissionId: string | null;
    streamUrl: string;
    durationMinutes: number | null;
    startedAt: Date;
    waitingSince: Date;
    /** Patch de agenda (si hay scheduledTransmissionId). */
    advance: { lastRunAt: Date; lastTransmissionId?: string; nextRunAt: Date | null } | null;
  }): Promise<TransmissionRow>;
}

export interface StartLiveDeps {
  store?: StartLiveStore;
  now?: () => Date;
}

// ─── Store drizzle ──────────────────────────────────────────────────────────

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleStartLiveStore(executor: Database = db): StartLiveStore {
  return {
    async programBelongsToTenant(tenantId, programId) {
      const [row] = await executor
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
        .limit(1);
      return !!row;
    },

    async findScheduled(tenantId, scheduledId) {
      const [row] = await executor
        .select({
          id: scheduledTransmissions.id,
          tenantId: scheduledTransmissions.tenantId,
          rrule: scheduledTransmissions.rrule,
          timezone: scheduledTransmissions.timezone,
        })
        .from(scheduledTransmissions)
        .where(
          and(
            eq(scheduledTransmissions.id, scheduledId),
            eq(scheduledTransmissions.tenantId, tenantId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async createLiveRun(v) {
      return executor.transaction(async (tx) => {
        const [t] = await tx
          .insert(transmissions)
          .values({
            tenantId: v.tenantId,
            programId: v.programId,
            scheduledTransmissionId: v.scheduledTransmissionId,
            source: 'live_capture',
            status: 'waiting',
            streamUrl: v.streamUrl,
            durationMinutes: v.durationMinutes,
            startedAt: v.startedAt,
            waitingSince: v.waitingSince,
          })
          .returning();

        if (v.scheduledTransmissionId && v.advance) {
          await tx
            .update(scheduledTransmissions)
            .set({
              lastRunAt: v.advance.lastRunAt,
              lastTransmissionId: t.id,
              nextRunAt: v.advance.nextRunAt,
            })
            .where(
              and(
                eq(scheduledTransmissions.id, v.scheduledTransmissionId),
                eq(scheduledTransmissions.tenantId, v.tenantId),
              ),
            );
        }

        return t;
      });
    },
  };
}

// ─── Caso de uso ────────────────────────────────────────────────────────────

/**
 * Valida la URL contra el registry y crea la corrida `waiting`. Errores de
 * validación salen como AppError con su status (400/404) — la ruta los
 * mapea tal cual.
 */
export async function startLiveTransmission(
  input: StartLiveInput,
  deps: StartLiveDeps = {},
): Promise<StartLiveResult> {
  const store = deps.store ?? createDrizzleStartLiveStore();
  const now = deps.now?.() ?? new Date();

  const streamUrl = (input.streamUrl ?? '').trim();
  const source = detectStreamSource(streamUrl);
  if (source.kind === 'upload') {
    throw new AppError(
      'La fuente `upload` se ingiere por /api/transmissions/vod-upload, no por start-live',
      400,
    );
  }
  if (!isHttpUrl(streamUrl)) {
    throw new AppError('streamUrl tiene que ser una URL http/https', 400);
  }

  if (
    input.durationMinutes != null &&
    (!Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < MIN_DURATION_MINUTES ||
      input.durationMinutes > MAX_DURATION_MINUTES)
  ) {
    throw new AppError(
      `durationMinutes tiene que ser un entero entre ${MIN_DURATION_MINUTES} y ${MAX_DURATION_MINUTES}`,
      400,
    );
  }

  const programId = input.programId ?? null;
  if (programId && !(await store.programBelongsToTenant(input.tenantId, programId))) {
    throw new AppError('Programa no encontrado', 404);
  }

  const scheduledId = input.scheduledTransmissionId ?? null;
  let advance: { lastRunAt: Date; nextRunAt: Date | null } | null = null;
  if (scheduledId) {
    const scheduled = await store.findScheduled(input.tenantId, scheduledId);
    if (!scheduled) {
      throw new AppError('Transmisión programada no encontrada', 404);
    }
    advance = {
      lastRunAt: now,
      // La ocurrencia manual consume el slot actual: la próxima es la de la
      // regla (puntual ⇒ null).
      nextRunAt: nextOccurrence(scheduled.rrule, now, scheduled.timezone),
    };
  }

  const transmission = await store.createLiveRun({
    tenantId: input.tenantId,
    programId,
    scheduledTransmissionId: scheduledId,
    streamUrl,
    durationMinutes: input.durationMinutes ?? null,
    startedAt: now,
    waitingSince: now,
    advance,
  });

  return { transmission, sourceKind: source.kind };
}
