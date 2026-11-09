/**
 * transmissionService — ÚNICA puerta para cambiar `transmissions.status`
 * (PD-04). Todo cambio de estado pasa por `transitionTransmission`:
 *
 *   1. Lee la fila filtrando por `tenant_id` + `id` (nunca revela si el id
 *      existe pero pertenece a otro tenant: siempre "no encontrada").
 *   2. Valida la arista con la FSM pura (`transmissionStateMachine`) — una
 *      transición inválida no toca la DB ni emite eventos.
 *   3. Aplica el UPDATE dentro de `db.transaction` (status + patch + las
 *      reglas de timestamps/error_message de la spec).
 *   4. Emite los eventos Socket.IO DESPUÉS del commit — jamás un estado que
 *      no quedó persistido.
 *
 * Reglas de campos al transicionar (spec del brief):
 *   - → live       : `started_at = now` (si el patch no lo trae).
 *   - → waiting    : `waiting_since = now` SÓLO si estaba en NULL — es el
 *                    ancla de la ventana de espera, nunca se reinicia.
 *   - → processing : `ended_at = now` (si el patch no lo trae).
 *   - → done/error/canceled : `ended_at = now` (ídem).
 *   - → error      : `error_message = errorMessage` (si no viene mensaje, la
 *                    columna queda como estaba — drizzle omite `undefined`).
 *
 * Los parches SIN cambio de estado (heartbeat, resolved_stream_url,
 * started_at del recorder cuando la corrida ya está live) NO pasan por acá:
 * son escrituras de columnas, no transiciones de la FSM.
 *
 * Dependencias inyectables (`deps`): executor drizzle, emisor de eventos y
 * reloj — los tests corren contra PGlite en memoria con un emisor fake.
 */
import { and, eq } from 'drizzle-orm';
import type { Server } from 'socket.io';

import { db, type Database } from '../db/index.js';
import { transmissions } from '../db/schema/transmissions.js';
import type { TransmissionStatus } from '../db/schema/enums.js';
import { transition } from '../lib/transmissionStateMachine.js';

// ─── API pública ────────────────────────────────────────────────────────────

export type TransmissionRow = typeof transmissions.$inferSelect;

export interface TransitionOptions {
    tenantId: string;
    transmissionId: string;
    to: TransmissionStatus;
    /** Mensaje de error (para `to='error'`). */
    errorMessage?: string;
    /**
     * Campos extra a setear en la misma transaction (crudo_ref,
     * started_at, ended_at, resolved_stream_url, ...). Los campos con
     * `undefined` se omiten; `null` se escribe como NULL.
     */
    patch?: Partial<{
        crudoRef: string | null;
        resolvedStreamUrl: string | null;
        startedAt: Date | null;
        endedAt: Date | null;
        waitingSince: Date | null;
        lastHeartbeatAt: Date | null;
        durationMinutes: number | null;
    }>;
}

export interface TransitionResult {
    ok: boolean;
    reason?: string;
    transmission?: TransmissionRow;
}

/**
 * Firma de los ejecutores de transición que inyectan los servicios
 * consumidores (scheduler, recorder): en prod es `transitionTransmission`,
 * en tests un fake sobre el store en memoria.
 */
export type TransitionRunner = (
    opts: TransitionOptions,
) => Promise<TransitionResult>;

export interface EmitTransmissionEventsInput {
    tenantId: string;
    transmission: TransmissionRow;
    previousStatus: TransmissionStatus;
}

export type EmitTransmissionEvents = (
    input: EmitTransmissionEventsInput,
) => void;

export interface TransitionServiceDeps {
    executor?: Database;
    emit?: EmitTransmissionEvents;
    now?: () => Date;
}

// ─── Reglas puras del UPDATE (compartidas con los fakes de test) ───────────

export interface TransmissionUpdateSet {
    status: TransmissionStatus;
    crudoRef?: string | null;
    resolvedStreamUrl?: string | null;
    startedAt?: Date | null;
    endedAt?: Date | null;
    waitingSince?: Date | null;
    lastHeartbeatAt?: Date | null;
    durationMinutes?: number | null;
    errorMessage?: string | null;
    updatedAt: Date;
}

/**
 * Compone el SET del UPDATE aplicando patch + reglas de estado. Nunca
 * incluye claves con `undefined`: drizzle las omite y los fakes de test no
 * deben pisar campos con undefined.
 */
export function computeTransitionUpdate(input: {
    currentStatus: TransmissionStatus;
    currentWaitingSince: Date | null;
    to: TransmissionStatus;
    errorMessage?: string;
    patch?: TransitionOptions['patch'];
    now: Date;
}): TransmissionUpdateSet {
    const { to, patch, now } = input;
    const set: TransmissionUpdateSet = { status: to, updatedAt: now };

    if (patch?.crudoRef !== undefined) set.crudoRef = patch.crudoRef;
    if (patch?.resolvedStreamUrl !== undefined) {
        set.resolvedStreamUrl = patch.resolvedStreamUrl;
    }
    if (patch?.startedAt !== undefined) set.startedAt = patch.startedAt;
    if (patch?.endedAt !== undefined) set.endedAt = patch.endedAt;
    if (patch?.waitingSince !== undefined) {
        set.waitingSince = patch.waitingSince;
    }
    if (patch?.lastHeartbeatAt !== undefined) {
        set.lastHeartbeatAt = patch.lastHeartbeatAt;
    }
    if (patch?.durationMinutes !== undefined) {
        set.durationMinutes = patch.durationMinutes;
    }

    if (to === 'live' && set.startedAt === undefined) set.startedAt = now;
    if (
        to === 'waiting' &&
        set.waitingSince === undefined &&
        input.currentWaitingSince === null
    ) {
        set.waitingSince = now;
    }
    if (
        (to === 'processing' ||
            to === 'done' ||
            to === 'error' ||
            to === 'canceled') &&
        set.endedAt === undefined
    ) {
        set.endedAt = now;
    }
    if (to === 'error' && input.errorMessage !== undefined) {
        set.errorMessage = input.errorMessage;
    }
    return set;
}

// ─── Transición con DB + eventos ────────────────────────────────────────────

export async function transitionTransmission(
    opts: TransitionOptions,
    deps: TransitionServiceDeps = {},
): Promise<TransitionResult> {
    const executor = deps.executor ?? db;
    const emit = deps.emit ?? emitTransmissionEvents;
    const now = deps.now?.() ?? new Date();

    const [row] = await executor
        .select()
        .from(transmissions)
        .where(
            and(
                eq(transmissions.id, opts.transmissionId),
                eq(transmissions.tenantId, opts.tenantId),
            ),
        )
        .limit(1);
    if (!row) {
        // Id inexistente o de otro tenant: misma respuesta — nunca se revela.
        return { ok: false, reason: 'transmisión no encontrada' };
    }

    const decision = transition(row.status, opts.to);
    if (!decision.allowed) {
        return { ok: false, reason: decision.reason };
    }

    const update = computeTransitionUpdate({
        currentStatus: row.status,
        currentWaitingSince: row.waitingSince,
        to: opts.to,
        errorMessage: opts.errorMessage,
        patch: opts.patch,
        now,
    });

    const updated = await executor.transaction(async (tx) => {
        const [u] = await tx
            .update(transmissions)
            .set(update)
            .where(
                and(
                    eq(transmissions.id, opts.transmissionId),
                    eq(transmissions.tenantId, opts.tenantId),
                ),
            )
            .returning();
        return u;
    });
    if (!updated) {
        // La fila desapareció entre el SELECT y el UPDATE (borrado en carrera).
        return { ok: false, reason: 'transmisión no encontrada' };
    }

    // DESPUÉS del commit: nunca se emite un estado no persistido.
    emit({
        tenantId: opts.tenantId,
        transmission: updated,
        previousStatus: row.status,
    });
    return { ok: true, transmission: updated };
}

// ─── Eventos Socket.IO ──────────────────────────────────────────────────────

let ioRef: Server | null = null;

/** Conecta el servicio al `io` del proceso (como notificationService). */
export function initTransmissionService(io: Server): void {
    ioRef = io;
}

/**
 * Serialización de la fila para broadcast. `resolvedStreamUrl` se EXCLUYE a
 * propósito: es una URL resuelta efímera que puede venir firmada (CDN con
 * firma/expiración) y los eventos no llevan URLs firmadas ni credenciales.
 * El resto de la fila viaja completo, con fechas en ISO.
 */
export function serializeTransmission(row: TransmissionRow) {
    return {
        id: row.id,
        tenantId: row.tenantId,
        programId: row.programId,
        scheduledTransmissionId: row.scheduledTransmissionId,
        source: row.source,
        status: row.status,
        streamUrl: row.streamUrl,
        crudoRef: row.crudoRef,
        durationMinutes: row.durationMinutes,
        startedAt: row.startedAt?.toISOString() ?? null,
        endedAt: row.endedAt?.toISOString() ?? null,
        waitingSince: row.waitingSince?.toISOString() ?? null,
        lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
        errorMessage: row.errorMessage,
        pipelineConfig: row.pipelineConfig,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export interface TransmissionStatusPayload {
    transmissionId: string;
    tenantId: string;
    status: TransmissionStatus;
    previousStatus: TransmissionStatus;
    startedAt: string | null;
    endedAt: string | null;
    errorMessage: string | null;
    crudoRef: string | null;
    updatedAt: string;
}

/**
 * Emisor canónico (resuelve el TODO del scheduler): en cada transición,
 * `transmission:status` al room de la transmisión + al del tenant, y
 * `transmission:updated` (fila completa serializada) sólo al room del tenant.
 */
export function emitTransmissionEvents(
    input: EmitTransmissionEventsInput,
): void {
    if (!ioRef) return;
    const { tenantId, transmission, previousStatus } = input;

    const statusPayload: TransmissionStatusPayload = {
        transmissionId: transmission.id,
        tenantId,
        status: transmission.status,
        previousStatus,
        startedAt: transmission.startedAt?.toISOString() ?? null,
        endedAt: transmission.endedAt?.toISOString() ?? null,
        errorMessage: transmission.errorMessage,
        crudoRef: transmission.crudoRef,
        updatedAt: transmission.updatedAt.toISOString(),
    };

    ioRef
        .to(`transmission:${transmission.id}`)
        .to(`tenant:${tenantId}`)
        .emit('transmission:status', statusPayload);
    ioRef
        .to(`tenant:${tenantId}`)
        .emit('transmission:updated', serializeTransmission(transmission));
}
