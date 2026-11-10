/**
 * Tests del slice PE-05: `attributedQuotesService` — citas
 * (`transmission_moments`, `kind='detected'`, `reason='quote'`) atribuidas
 * a persona con nombre + foto, computed-on-read.
 *
 * Deterministas: store en memoria con los mismos filtros por tenant que
 * la implementación drizzle. Cubre la elección de la utterance (mayor
 * overlap; empate → la que contiene el punto medio), la cascada
 * person → speaker → unattributed y la foto primaria con fallback a la
 * más antigua (misma regla que liveRoomService/faceEnrollmentService).
 *
 * El aislamiento por tenant es parte del contrato: momentos, utterances
 * y personas de otro tenant no se leen.
 */
import { describe, expect, it } from 'vitest';

import { createAttributedQuotesService } from '../src/server/services/attributedQuotesService';
import {
    createMemoryAttributedQuotesStore,
    type MemoryAttributedQuotesState,
} from './helpers/memoryAttributedQuotesStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TX_1 = 'tx-1';
const TX_2 = 'tx-2';

function makeService() {
    const { store, state } = createMemoryAttributedQuotesStore();
    return { service: createAttributedQuotesService(store), state };
}

function seedQuote(
    state: MemoryAttributedQuotesState,
    v: {
        id: string;
        startMs: number;
        endMs: number;
        text: string;
        tenantId?: string;
        transmissionId?: string;
    },
) {
    state.moments.push({
        id: v.id,
        tenantId: v.tenantId ?? T_A,
        transmissionId: v.transmissionId ?? TX_1,
        kind: 'detected',
        reason: 'quote',
        title: v.text,
        startMs: v.startMs,
        endMs: v.endMs,
        score: null,
    });
}

function seedUtterance(
    state: MemoryAttributedQuotesState,
    v: {
        id: string;
        startMs: number;
        endMs: number;
        speakerLabel?: string | null;
        personId?: string | null;
        tenantId?: string;
        transmissionId?: string;
    },
) {
    state.utterances.push({
        id: v.id,
        tenantId: v.tenantId ?? T_A,
        transmissionId: v.transmissionId ?? TX_1,
        startMs: v.startMs,
        endMs: v.endMs,
        speakerLabel: v.speakerLabel ?? null,
        personId: v.personId ?? null,
    });
}

function seedPerson(
    state: MemoryAttributedQuotesState,
    id: string,
    name: string,
    tenantId: string = T_A,
) {
    state.persons.push({ id, tenantId, name });
}

function seedPhoto(
    state: MemoryAttributedQuotesState,
    v: {
        id: string;
        personId: string;
        isPrimary?: boolean;
        createdAt?: number;
        tenantId?: string;
    },
) {
    state.photos.push({
        id: v.id,
        tenantId: v.tenantId ?? T_A,
        personId: v.personId,
        isPrimary: v.isPrimary ?? false,
        createdAt: v.createdAt ?? 0,
    });
}

describe('listAttributedQuotes — atribución computed-on-read', () => {
    it('cita cubierta por utterance con person_id → attribution=person con name + photoUrl', async () => {
        const { service, state } = makeService();

        seedQuote(state, { id: 'm-1', startMs: 10_000, endMs: 12_000, text: 'Hablemos de la inflación.' });
        seedUtterance(state, {
            id: 'u-1', startMs: 9_000, endMs: 13_000,
            speakerLabel: 'Speaker A', personId: 'p-1',
        });
        seedPerson(state, 'p-1', 'María Pérez');
        seedPhoto(state, { id: 'ph-1', personId: 'p-1', isPrimary: true });

        const quotes = await service.listAttributedQuotes(T_A, TX_1);
        expect(quotes).toHaveLength(1);
        expect(quotes[0]).toEqual({
            momentId: 'm-1',
            text: 'Hablemos de la inflación.',
            startMs: 10_000,
            endMs: 12_000,
            score: null,
            reason: 'quote',
            speakerLabel: 'Speaker A',
            personId: 'p-1',
            personName: 'María Pérez',
            personPhotoUrl: '/api/persons/p-1/photos/ph-1',
            attribution: 'person',
        });
    });

    it('utterance sin person_id → attribution=speaker con speakerLabel', async () => {
        const { service, state } = makeService();

        seedQuote(state, { id: 'm-1', startMs: 0, endMs: 1_000, text: 'Arrancamos.' });
        seedUtterance(state, {
            id: 'u-1', startMs: 0, endMs: 2_000, speakerLabel: 'Speaker B',
        });

        const [q] = await service.listAttributedQuotes(T_A, TX_1);
        expect(q.attribution).toBe('speaker');
        expect(q.speakerLabel).toBe('Speaker B');
        expect(q.personId).toBeNull();
        expect(q.personName).toBeNull();
        expect(q.personPhotoUrl).toBeNull();
    });

    it('cita sin utterance solapada → attribution=unattributed', async () => {
        const { service, state } = makeService();

        seedQuote(state, { id: 'm-1', startMs: 0, endMs: 1_000, text: 'Sin cobertura.' });
        // Overlap 0: la utterance arranca justo donde termina la cita.
        seedUtterance(state, {
            id: 'u-1', startMs: 1_000, endMs: 5_000,
            speakerLabel: 'Speaker A', personId: 'p-1',
        });

        const [q] = await service.listAttributedQuotes(T_A, TX_1);
        expect(q.attribution).toBe('unattributed');
        expect(q.speakerLabel).toBeNull();
        expect(q.personId).toBeNull();
        expect(q.personName).toBeNull();
        expect(q.personPhotoUrl).toBeNull();
    });

    it('la utterance de mayor overlap gana cuando hay 2 candidatas', async () => {
        const { service, state } = makeService();

        seedQuote(state, { id: 'm-1', startMs: 10_000, endMs: 12_000, text: 'Cita disputada.' });
        // u-1 solapa 500ms; u-2 solapa 1.500ms → gana u-2.
        seedUtterance(state, {
            id: 'u-1', startMs: 9_500, endMs: 10_500,
            speakerLabel: 'Speaker A', personId: 'p-1',
        });
        seedUtterance(state, {
            id: 'u-2', startMs: 10_500, endMs: 13_000,
            speakerLabel: 'Speaker B', personId: 'p-2',
        });
        seedPerson(state, 'p-1', 'Persona Uno');
        seedPerson(state, 'p-2', 'Persona Dos');

        const [q] = await service.listAttributedQuotes(T_A, TX_1);
        expect(q.attribution).toBe('person');
        expect(q.personId).toBe('p-2');
        expect(q.personName).toBe('Persona Dos');
        expect(q.speakerLabel).toBe('Speaker B');
    });

    it('empate de overlap → la utterance que contiene el punto medio', async () => {
        const { service, state } = makeService();

        // Punto medio de la cita: 11_000. Ambas solapan 1.000ms; u-2
        // contiene el medio ([11_000, 13_000)), u-1 no ([9_000, 11_000)).
        seedQuote(state, { id: 'm-1', startMs: 10_000, endMs: 12_000, text: 'Empate.' });
        seedUtterance(state, {
            id: 'u-1', startMs: 9_000, endMs: 11_000,
            speakerLabel: 'Speaker A', personId: 'p-1',
        });
        seedUtterance(state, {
            id: 'u-2', startMs: 11_000, endMs: 13_000,
            speakerLabel: 'Speaker B', personId: 'p-2',
        });
        seedPerson(state, 'p-1', 'Persona Uno');
        seedPerson(state, 'p-2', 'Persona Dos');

        const [q] = await service.listAttributedQuotes(T_A, TX_1);
        expect(q.personId).toBe('p-2');
        expect(q.personName).toBe('Persona Dos');
    });

    it('persona sin foto primaria → fallback a la más antigua; sin fotos → null', async () => {
        const { service, state } = makeService();

        seedQuote(state, { id: 'm-1', startMs: 0, endMs: 1_000, text: 'Uno.' });
        seedQuote(state, { id: 'm-2', startMs: 2_000, endMs: 3_000, text: 'Dos.' });
        seedUtterance(state, { id: 'u-1', startMs: 0, endMs: 1_000, personId: 'p-1' });
        seedUtterance(state, { id: 'u-2', startMs: 2_000, endMs: 3_000, personId: 'p-2' });
        seedPerson(state, 'p-1', 'Con Fotos');
        seedPerson(state, 'p-2', 'Sin Fotos');
        // ph-new es más reciente pero ph-old es la más antigua → gana ph-old.
        seedPhoto(state, { id: 'ph-new', personId: 'p-1', createdAt: 200 });
        seedPhoto(state, { id: 'ph-old', personId: 'p-1', createdAt: 100 });

        const quotes = await service.listAttributedQuotes(T_A, TX_1);
        expect(quotes[0].personPhotoUrl).toBe('/api/persons/p-1/photos/ph-old');
        expect(quotes[1].attribution).toBe('person');
        expect(quotes[1].personName).toBe('Sin Fotos');
        expect(quotes[1].personPhotoUrl).toBeNull();
    });

    it('ordena las citas por start_ms y devuelve [] sin momentos quote', async () => {
        const { service, state } = makeService();

        seedQuote(state, { id: 'm-2', startMs: 20_000, endMs: 21_000, text: 'Segunda.' });
        seedQuote(state, { id: 'm-1', startMs: 5_000, endMs: 6_000, text: 'Primera.' });
        // Un momento detected que NO es quote no entra en la lista.
        state.moments.push({
            id: 'm-x', tenantId: T_A, transmissionId: TX_1,
            kind: 'detected', reason: 'highlight', title: 'No es cita',
            startMs: 0, endMs: 1_000, score: 0.9,
        });
        // Ni un mark manual con reason='quote' por las dudas.
        state.moments.push({
            id: 'm-y', tenantId: T_A, transmissionId: TX_1,
            kind: 'mark', reason: 'quote', title: 'Mark manual',
            startMs: 0, endMs: 500, score: null,
        });

        const quotes = await service.listAttributedQuotes(T_A, TX_1);
        expect(quotes.map((q) => q.momentId)).toEqual(['m-1', 'm-2']);

        const { service: empty } = makeService();
        expect(await empty.listAttributedQuotes(T_A, TX_1)).toEqual([]);
    });
});

describe('aislamiento por tenant', () => {
    it('momentos, utterances y personas de otro tenant no se leen', async () => {
        const { service, state } = makeService();

        // tenant-b tiene la misma transmissionId con cita + utterance +
        // persona — tenant-a no debe ver nada de eso.
        seedQuote(state, {
            id: 'm-b', startMs: 0, endMs: 1_000, text: 'Cita de B.',
            tenantId: T_B,
        });
        seedUtterance(state, {
            id: 'u-b', startMs: 0, endMs: 1_000, personId: 'p-b',
            tenantId: T_B,
        });
        seedPerson(state, 'p-b', 'Persona de B', T_B);
        seedPhoto(state, { id: 'ph-b', personId: 'p-b', isPrimary: true, tenantId: T_B });

        expect(await service.listAttributedQuotes(T_A, TX_1)).toEqual([]);
        const [qB] = await service.listAttributedQuotes(T_B, TX_1);
        expect(qB.personPhotoUrl).toBe('/api/persons/p-b/photos/ph-b');
    });

    it('una cita de tenant-a no hereda utterances de tenant-b con la misma tx', async () => {
        const { service, state } = makeService();

        seedQuote(state, { id: 'm-a', startMs: 0, endMs: 1_000, text: 'Cita de A.' });
        // La única utterance solapada es de tenant-b → no aplica.
        seedUtterance(state, {
            id: 'u-b', startMs: 0, endMs: 1_000,
            speakerLabel: 'Speaker B', personId: 'p-b', tenantId: T_B,
        });
        seedPerson(state, 'p-b', 'Persona de B', T_B);

        const [q] = await service.listAttributedQuotes(T_A, TX_1);
        expect(q.attribution).toBe('unattributed');
        expect(q.personId).toBeNull();
        // Y otra transmisión del mismo tenant tampoco la ve.
        expect(await service.listAttributedQuotes(T_A, TX_2)).toEqual([]);
    });
});
