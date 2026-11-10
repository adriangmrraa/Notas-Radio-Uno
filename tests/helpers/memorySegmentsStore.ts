/**
 * memorySegmentsStore — implementación en memoria de `SegmentsStore` para
 * tests de `transmissionSegmentsService` (PE-06). Sin DB: los mismos filtros
 * por tenant que la implementación drizzle (un id ajeno al tenant no se
 * encuentra → no se lee ni se escribe nada).
 */
import type {
    SegmentsStore,
    TransmissionSegment,
    TransmissionSegmentInsert,
} from '../../src/server/services/transmissionSegmentsService';
import type { TransmissionSegmentSpeaker } from '../../src/server/db/schema/live';

export interface MemorySegmentsState {
    segments: Map<string, TransmissionSegment>;
}

let seq = 0;

export function createMemorySegmentsStore(): {
    store: SegmentsStore;
    state: MemorySegmentsState;
} {
    const state: MemorySegmentsState = { segments: new Map() };

    const store: SegmentsStore = {
        async insertSegment(v: TransmissionSegmentInsert) {
            const id = `seg-${++seq}`;
            state.segments.set(id, {
                id,
                tenantId: v.tenantId,
                transmissionId: v.transmissionId,
                startMs: v.startMs,
                endMs: v.endMs,
                topic: v.topic ?? null,
                summary: v.summary ?? null,
                speakers: v.speakers ?? [],
                confidence: v.confidence ?? null,
                createdAt: new Date(),
            });
            return { id };
        },

        async listByTransmission(tenantId, transmissionId) {
            return [...state.segments.values()]
                .filter(
                    (s) =>
                        s.tenantId === tenantId && s.transmissionId === transmissionId,
                )
                .sort((a, b) => a.startMs - b.startMs);
        },

        async updateSegmentSpeakers(
            tenantId: string,
            segmentId: string,
            speakers: TransmissionSegmentSpeaker[],
        ) {
            const seg = state.segments.get(segmentId);
            if (!seg || seg.tenantId !== tenantId) return;
            seg.speakers = speakers;
        },
    };

    return { store, state };
}
