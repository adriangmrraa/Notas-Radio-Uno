/**
 * Tests del slice PC-09: dossier vinculado a la emisión de agenda.
 *
 * Sin DB, sin red:
 *   - `assertDossierTransmissionLink` (regla pura de `lib/dossierLink.ts`):
 *     emisión inexistente o de OTRO tenant ⇒ 404 "no encontrada" (no se
 *     distingue); programa distinto ⇒ 400; mismo programa ⇒ OK; emisión sin
 *     programa (program_id NULL) ⇒ OK.
 *   - `listDossiers` del servicio real con un origen de filas inyectado
 *     (patrón store de PC-04/PC-05): el filtro scheduledTransmissionId aplica
 *     y NUNCA se mezclan filas de otro tenant — incluso si el origen
 *     defectuoso devuelve filas ajenas.
 */
import { describe, expect, it } from 'vitest';

import { AppError } from '../src/server/lib/errors';
import {
    assertDossierTransmissionLink,
    dossierMatchesListFilters,
    type DossierListRow,
    type DossierTransmissionCandidate,
} from '../src/server/lib/dossierLink';
import { listDossiers, type DossierRowsSource } from '../src/server/services/dossierService';
import type { guestDossiers } from '../src/server/db/schema/dossiers';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const PROGRAM_A = '00000000-0000-4000-8000-0000000000a1';
const PROGRAM_B = '00000000-0000-4000-8000-0000000000b1';
const TRANSMISSION_1 = '00000000-0000-4000-8000-0000000000e1';
const TRANSMISSION_2 = '00000000-0000-4000-8000-0000000000e2';

type DossierRow = typeof guestDossiers.$inferSelect;

const makeTransmission = (
    over: Partial<DossierTransmissionCandidate> = {},
): DossierTransmissionCandidate => ({
    id: TRANSMISSION_1,
    tenantId: TENANT_A,
    programId: PROGRAM_A,
    ...over,
});

// ── assertDossierTransmissionLink — regla del vínculo ────────────────────────
describe('assertDossierTransmissionLink', () => {
    it('emisión inexistente ⇒ AppError 404 "no encontrada"', () => {
        try {
            assertDossierTransmissionLink(TENANT_A, PROGRAM_A, null);
            expect.unreachable('debió lanzar');
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).statusCode).toBe(404);
            expect((err as AppError).message).toMatch(/no encontrada/i);
        }
    });

    it('emisión de OTRO tenant ⇒ el mismo 404 (no se distingue de inexistente)', () => {
        try {
            assertDossierTransmissionLink(
                TENANT_A,
                PROGRAM_A,
                makeTransmission({ tenantId: TENANT_B }),
            );
            expect.unreachable('debió lanzar');
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).statusCode).toBe(404);
            expect((err as AppError).message).toMatch(/no encontrada/i);
        }
    });

    it('programa distinto ⇒ AppError 400 con mensaje de programa incompatible', () => {
        try {
            assertDossierTransmissionLink(
                TENANT_A,
                PROGRAM_A,
                makeTransmission({ programId: PROGRAM_B }),
            );
            expect.unreachable('debió lanzar');
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).statusCode).toBe(400);
            expect((err as AppError).message).toMatch(/programa/i);
        }
    });

    it('mismo tenant + mismo programa ⇒ OK (no lanza)', () => {
        expect(() =>
            assertDossierTransmissionLink(TENANT_A, PROGRAM_A, makeTransmission()),
        ).not.toThrow();
    });

    it('emisión sin programa (program_id NULL) ⇒ vínculo válido', () => {
        expect(() =>
            assertDossierTransmissionLink(
                TENANT_A,
                PROGRAM_A,
                makeTransmission({ programId: null }),
            ),
        ).not.toThrow();
    });
});

// ── dossierMatchesListFilters — predicado del listado ────────────────────────
describe('dossierMatchesListFilters', () => {
    const base: DossierListRow = {
        tenantId: TENANT_A,
        programId: PROGRAM_A,
        scheduledDate: '2026-11-10',
        scheduledTransmissionId: TRANSMISSION_1,
    };

    it('sin filtros ⇒ entran todas las filas del tenant', () => {
        expect(dossierMatchesListFilters(base, TENANT_A, {})).toBe(true);
    });

    it('fila de otro tenant NUNCA entra, aunque matchee los filtros', () => {
        const foreign: DossierListRow = { ...base, tenantId: TENANT_B };
        expect(
            dossierMatchesListFilters(foreign, TENANT_A, {
                scheduledTransmissionId: TRANSMISSION_1,
            }),
        ).toBe(false);
        expect(dossierMatchesListFilters(foreign, TENANT_A, {})).toBe(false);
    });

    it('scheduledTransmissionId filtra exacto; null sólo entra sin el filtro', () => {
        const sinEmision: DossierListRow = { ...base, scheduledTransmissionId: null };
        expect(
            dossierMatchesListFilters(base, TENANT_A, { scheduledTransmissionId: TRANSMISSION_1 }),
        ).toBe(true);
        expect(
            dossierMatchesListFilters(sinEmision, TENANT_A, { scheduledTransmissionId: TRANSMISSION_1 }),
        ).toBe(false);
        expect(dossierMatchesListFilters(sinEmision, TENANT_A, {})).toBe(true);
    });

    it('combina programId + date + scheduledTransmissionId (AND)', () => {
        const filters = {
            programId: PROGRAM_A,
            date: '2026-11-10',
            scheduledTransmissionId: TRANSMISSION_1,
        };
        expect(dossierMatchesListFilters(base, TENANT_A, filters)).toBe(true);
        expect(
            dossierMatchesListFilters({ ...base, scheduledDate: '2026-11-11' }, TENANT_A, filters),
        ).toBe(false);
        expect(
            dossierMatchesListFilters({ ...base, programId: PROGRAM_B }, TENANT_A, filters),
        ).toBe(false);
    });
});

// ── listDossiers — servicio real con origen inyectado (aislamiento tenant) ────
describe('listDossiers — filtro scheduledTransmissionId + aislamiento tenant', () => {
    const row = (over: Partial<DossierRow> & Pick<DossierRow, 'id' | 'tenantId'>): DossierRow =>
        ({
            guestId: 'g-1',
            programId: PROGRAM_A,
            guestName: 'Invitado',
            scheduledDate: '2026-11-10',
            scheduledTransmissionId: null,
            content: null,
            status: 'ready',
            generatedAt: null,
            createdAt: new Date('2026-11-01T00:00:00Z'),
            ...over,
        }) as DossierRow;

    const linkedA = row({ id: 'd-a-linked', tenantId: TENANT_A, scheduledTransmissionId: TRANSMISSION_1 });
    const looseA = row({ id: 'd-a-loose', tenantId: TENANT_A });
    const linkedB = row({ id: 'd-b-linked', tenantId: TENANT_B, programId: PROGRAM_B, scheduledTransmissionId: TRANSMISSION_1 });

    // Orden inyectado defectuoso a propósito: devuelve filas de AMBOS tenants.
    // El predicado del servicio tiene que re-verificar el tenant igual.
    const leakySource: DossierRowsSource = async () => [linkedA, looseA, linkedB];

    it('filtra por scheduledTransmissionId sin mezclar tenants', async () => {
        const out = await listDossiers(
            TENANT_A,
            { scheduledTransmissionId: TRANSMISSION_1 },
            leakySource,
        );
        expect(out.map((d) => d.id)).toEqual(['d-a-linked']);
    });

    it('el mismo filtro en tenant B devuelve sólo la fila de B', async () => {
        const out = await listDossiers(
            TENANT_B,
            { scheduledTransmissionId: TRANSMISSION_1 },
            leakySource,
        );
        expect(out.map((d) => d.id)).toEqual(['d-b-linked']);
    });

    it('sin filtros devuelve todas las filas del tenant (y sólo las suyas)', async () => {
        const out = await listDossiers(TENANT_A, {}, leakySource);
        expect(out.map((d) => d.id).sort()).toEqual(['d-a-linked', 'd-a-loose']);
    });

    it('scheduledTransmissionId sin matches ⇒ lista vacía', async () => {
        const out = await listDossiers(
            TENANT_A,
            { scheduledTransmissionId: TRANSMISSION_2 },
            leakySource,
        );
        expect(out).toEqual([]);
    });
});
