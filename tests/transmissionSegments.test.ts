/**
 * Tests del slice PE-06: `transmissionSegmentsService` + tabla
 * `transmission_segments`.
 *
 * Deterministas: store en memoria con los mismos filtros por tenant que la
 * implementación drizzle. Cubre el camino que usa el motor de análisis
 * (PE-02): insertar unidades temáticas con ventana/speakers y listarlas en
 * orden de offset; y la atribución de identidad (PE-03): update de speakers.
 *
 * El aislamiento por tenant es parte del contrato: un segmento de otro
 * tenant no se lista ni se actualiza.
 */
import { describe, expect, it } from 'vitest';

import { createTransmissionSegmentsService } from '../src/server/services/transmissionSegmentsService';
import { createMemorySegmentsStore } from './helpers/memorySegmentsStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TX_1 = 'tx-1';
const TX_2 = 'tx-2';

function makeService() {
    const { store, state } = createMemorySegmentsStore();
    return { service: createTransmissionSegmentsService(store), state };
}

describe('recordSegment + listSegments', () => {
    it('inserta un segmento y lo lista ordenado por startMs', async () => {
        const { service } = makeService();

        await service.recordSegment({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 120_000,
            endMs: 180_000,
            topic: 'Economía',
            summary: 'Bloque sobre inflación y tarifas',
            speakers: [{ label: 'Speaker A', personId: 'person-1' }],
            confidence: 0.9,
        });
        await service.recordSegment({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 0,
            endMs: 60_000,
            topic: 'Apertura',
            summary: 'Presentación del día',
            speakers: [{ label: 'Speaker A' }, { label: 'Speaker B' }],
        });

        const list = await service.listSegments(T_A, TX_1);
        expect(list).toHaveLength(2);
        expect(list[0].startMs).toBe(0);
        expect(list[1].startMs).toBe(120_000);
        expect(list[0].topic).toBe('Apertura');
        expect(list[1].speakers).toEqual([{ label: 'Speaker A', personId: 'person-1' }]);
    });

    it('defaults: campos opcionales quedan null / speakers []', async () => {
        const { service, state } = makeService();

        const { id } = await service.recordSegment({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 0,
            endMs: 30_000,
        });

        const seg = state.segments.get(id)!;
        expect(seg.topic).toBeNull();
        expect(seg.summary).toBeNull();
        expect(seg.speakers).toEqual([]);
        expect(seg.confidence).toBeNull();
    });
});

describe('aislamiento por tenant', () => {
    it('no lista segmentos de otro tenant ni de otra transmisión', async () => {
        const { service } = makeService();

        await service.recordSegment({
            tenantId: T_A, transmissionId: TX_1, startMs: 0, endMs: 10_000, topic: 'A',
        });
        await service.recordSegment({
            tenantId: T_B, transmissionId: TX_1, startMs: 0, endMs: 10_000, topic: 'B',
        });
        await service.recordSegment({
            tenantId: T_A, transmissionId: TX_2, startMs: 0, endMs: 10_000, topic: 'A2',
        });

        const list = await service.listSegments(T_A, TX_1);
        expect(list).toHaveLength(1);
        expect(list[0].topic).toBe('A');
    });

    it('updateSegmentSpeakers no pisa un segmento de otro tenant', async () => {
        const { service, state } = makeService();

        const { id } = await service.recordSegment({
            tenantId: T_B,
            transmissionId: TX_1,
            startMs: 0,
            endMs: 10_000,
            speakers: [{ label: 'Speaker A' }],
        });

        // tenant-a intenta atribuir speakers sobre el segmento de tenant-b:
        await service.setSegmentSpeakers(T_A, id, [{ label: 'X', personId: 'p-x' }]);
        expect(state.segments.get(id)!.speakers).toEqual([{ label: 'Speaker A' }]);
    });
});

describe('setSegmentSpeakers — atribución de identidad (PE-03)', () => {
    it('persiste la resolución speaker→persona, incluida la corrección manual', async () => {
        const { service } = makeService();

        const { id } = await service.recordSegment({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 0,
            endMs: 10_000,
            speakers: [{ label: 'Speaker A' }, { label: 'Speaker B' }],
        });

        await service.setSegmentSpeakers(T_A, id, [
            { label: 'Speaker A', personId: 'person-1' },
            { label: 'Speaker B', personId: null },
        ]);

        const [seg] = await service.listSegments(T_A, TX_1);
        expect(seg.speakers).toEqual([
            { label: 'Speaker A', personId: 'person-1' },
            { label: 'Speaker B', personId: null },
        ]);
    });
});
