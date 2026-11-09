/**
 * transmissionStateMachine — máquina de estados PURA de una transmisión
 * (PD-04). Sin DB, sin IO, sin Socket.IO: sólo la tabla de aristas y los
 * motivos de rechazo. La testeabilidad vive acá; `transmissionService` es el
 * envoltorio que la aplica con persistencia + eventos.
 *
 * Grafo (spec `stream-recording`):
 *
 *   scheduled ──▶ waiting ──▶ live ──▶ processing ──▶ done
 *       │           │          │           │
 *       ▼           ▼          ▼           ▼
 *     error ◀───────┴──────────┴───────────┘        canceled (desde no-terminales)
 *
 * `done` y `canceled` son terminales estrictos (sin aristas salientes).
 * `error` es terminal salvo por SU auto-arista: `error → error` está
 * PERMITIDA — es el re-registro del mensaje (un watcher puede reportar el
 * mismo error con detalle nuevo). Es la única transición `from === to`
 * válida; el resto de las idénticas se rechazan.
 */
import type { TransmissionStatus } from '../db/schema/enums.js';

export interface TransitionContext {
    tenantId: string;
    transmissionId: string;
    from: TransmissionStatus;
    to: TransmissionStatus;
    now: Date;
    /** Datos de la transición (error, crudo_ref, started_at, etc.). */
    payload?: Record<string, unknown>;
}

export interface TransitionDecision {
    allowed: boolean;
    /** Razón del rechazo, en español. */
    reason?: string;
}

/**
 * Aristas permitidas por estado. `error` figura con su auto-arista — la
 * única identidad permitida — documentada en el header del archivo.
 */
export const TRANSMISSION_TRANSITIONS: Readonly<
    Record<TransmissionStatus, readonly TransmissionStatus[]>
> = {
    scheduled: ['waiting', 'live', 'error', 'canceled'],
    waiting: ['live', 'error', 'canceled'],
    live: ['processing', 'error', 'canceled'],
    processing: ['done', 'error'],
    done: [],
    error: ['error'],
    canceled: [],
} as const;

const TERMINAL_STATES: ReadonlySet<TransmissionStatus> = new Set([
    'done',
    'canceled',
]);

/**
 * Re-registro de error: la única transición idéntica permitida. Permite que
 * un proceso que ya marcó la corrida en `error` actualice `error_message`
 * con más detalle sin violar la FSM.
 */
export const ERROR_SELF_TRANSITION = true;

/** Forma rápida: lookup directo en la tabla de aristas. */
export function canTransition(
    from: TransmissionStatus,
    to: TransmissionStatus,
): boolean {
    return TRANSMISSION_TRANSITIONS[from].includes(to);
}

/**
 * Forma completa: además del sí/no devuelve el motivo del rechazo (español,
 * para propagarlo a `error_message` o a la respuesta de la API).
 */
export function transition(
    from: TransmissionStatus,
    to: TransmissionStatus,
): TransitionDecision {
    if (canTransition(from, to)) return { allowed: true };

    if (from === to) {
        return {
            allowed: false,
            reason: `la transición de '${from}' al mismo estado no está permitida`,
        };
    }
    if (TERMINAL_STATES.has(from)) {
        return {
            allowed: false,
            reason: `'${from}' es un estado terminal: no admite transiciones`,
        };
    }
    if (from === 'error') {
        return {
            allowed: false,
            reason: `'error' sólo admite la auto-transición 'error → error' (re-registro del mensaje)`,
        };
    }
    return {
        allowed: false,
        reason: `la transición de '${from}' a '${to}' no está permitida`,
    };
}
