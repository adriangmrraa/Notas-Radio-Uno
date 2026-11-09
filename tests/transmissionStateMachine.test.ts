/**
 * Tests de la FSM pura de transmisiones (PD-04). Sin DB, sin mocks: la
 * tabla de aristas y los motivos de rechazo en español.
 *
 * Cobertura:
 *   - Todas las aristas de la spec están permitidas.
 *   - Exhaustivo 7×7: toda combinación no listada queda rechazada.
 *   - Estados terminales sin aristas salientes (error sólo su auto-arista).
 *   - `error → error` permitido (re-registro); `done → done` rechazado.
 *   - El motivo del rechazo es un string en español no vacío.
 */
import { describe, expect, it } from 'vitest';

import { TransmissionStatus } from '../src/server/db/schema/enums';
import {
    canTransition,
    transition,
    TRANSMISSION_TRANSITIONS,
} from '../src/server/lib/transmissionStateMachine';

const STATUSES = Object.values(TransmissionStatus) as TransmissionStatus[];

// Tabla esperada, espejo de la spec `stream-recording` del brief.
const EXPECTED: Record<TransmissionStatus, TransmissionStatus[]> = {
    scheduled: ['waiting', 'live', 'error', 'canceled'],
    waiting: ['live', 'error', 'canceled'],
    live: ['processing', 'error', 'canceled'],
    processing: ['done', 'error'],
    done: [],
    error: ['error'], // auto-arista: re-registro del mensaje
    canceled: [],
};

describe('aristas permitidas (tabla de la spec)', () => {
    it('el mapa TRANSMISSION_TRANSITIONS es exactamente la tabla esperada', () => {
        expect(TRANSMISSION_TRANSITIONS).toEqual(EXPECTED);
    });

    it.each(Object.entries(EXPECTED).flatMap(([from, tos]) =>
        tos.map((to) => [from, to] as const),
    ))('%s → %s está permitida', (from, to) => {
        expect(canTransition(from, to)).toBe(true);
        expect(transition(from, to)).toEqual({ allowed: true });
    });
});

describe('matriz exhaustiva 7×7', () => {
    const allowed = new Set(
        Object.entries(EXPECTED).flatMap(([from, tos]) =>
            tos.map((to) => `${from}->${to}`),
        ),
    );

    it.each(STATUSES.flatMap((from) =>
        STATUSES.map((to) => [from, to] as const),
    ))('%s → %s', (from, to) => {
        const expectedAllowed = allowed.has(`${from}->${to}`);
        expect(canTransition(from, to)).toBe(expectedAllowed);
        const decision = transition(from, to);
        expect(decision.allowed).toBe(expectedAllowed);
        if (!expectedAllowed) {
            // Rechazo con motivo: string en español no vacío.
            expect(typeof decision.reason).toBe('string');
            expect(decision.reason!.length).toBeGreaterThan(0);
            expect(decision.reason).toMatch(/[a-záéíóúñ]/i);
        }
    });
});

describe('estados terminales', () => {
    it('done y canceled no tienen aristas salientes', () => {
        expect(TRANSMISSION_TRANSITIONS.done).toEqual([]);
        expect(TRANSMISSION_TRANSITIONS.canceled).toEqual([]);
    });

    it('error sólo admite su auto-arista (re-registro del mensaje)', () => {
        expect(TRANSMISSION_TRANSITIONS.error).toEqual(['error']);
        for (const to of STATUSES) {
            if (to === 'error') continue;
            expect(canTransition('error', to)).toBe(false);
            expect(transition('error', to).reason).toContain('error');
        }
    });
});

describe('transiciones idénticas (from === to)', () => {
    it('error → error permitida: actualización del mensaje de error', () => {
        expect(canTransition('error', 'error')).toBe(true);
        expect(transition('error', 'error').allowed).toBe(true);
    });

    it.each(
        STATUSES.filter((s) => s !== 'error').map((s) => [s, s] as const),
    )('%s → %s rechazada', (from, to) => {
        expect(from).toBe(to); // mismo literal: idénticas
        expect(canTransition(from, to)).toBe(false);
        const decision = transition(from, to);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBeTruthy();
    });

    it('done → done rechazada (terminal e idéntica)', () => {
        expect(canTransition('done', 'done')).toBe(false);
        expect(transition('done', 'done').allowed).toBe(false);
    });
});
