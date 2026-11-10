/**
 * memoryNoteFactoryStore — implementación en memoria de `NoteFactoryStore`
 * para tests de `noteFactoryService` (PF-06). Sin DB: los mismos filtros
 * por tenant que la implementación drizzle (una transmisión/segmento de
 * otro tenant no se lee; la publicación insertada queda en `state` para
 * las aserciones).
 */
import type {
    InsertNotePublicationInput,
    NoteFactoryStore,
    NotePublication,
    NoteSegment,
    NoteTransmission,
} from '../../src/server/services/noteFactoryService';
import type { TransmissionSegmentSpeaker } from '../../src/server/db/schema/live';
import type { PublicationSource } from '../../src/server/db/schema/enums';

export interface MemoryNoteTransmissionRow extends NoteTransmission {
    tenantId: string;
}

export interface MemoryNoteSegmentRow extends NoteSegment {
    tenantId: string;
    transmissionId: string;
}

export interface MemoryNoteFactoryState {
    transmissions: MemoryNoteTransmissionRow[];
    segments: MemoryNoteSegmentRow[];
    /** Filas insertadas por `insertPublication` — la escritura es observable. */
    publications: NotePublication[];
}

let seq = 0;

export function createMemoryNoteFactoryStore(): {
    store: NoteFactoryStore;
    state: MemoryNoteFactoryState;
} {
    const state: MemoryNoteFactoryState = {
        transmissions: [],
        segments: [],
        publications: [],
    };

    const store: NoteFactoryStore = {
        async getTransmission(tenantId, transmissionId) {
            // WHERE id AND tenant_id — un id ajeno NO se encuentra.
            const row = state.transmissions.find(
                (t) => t.id === transmissionId && t.tenantId === tenantId,
            );
            return row
                ? { id: row.id, programId: row.programId, status: row.status }
                : null;
        },

        async listSegments(tenantId, transmissionId) {
            return state.segments
                .filter(
                    (s) =>
                        s.tenantId === tenantId &&
                        s.transmissionId === transmissionId,
                )
                .sort((a, b) => a.startMs - b.startMs)
                .map(
                    (s): NoteSegment => ({
                        id: s.id,
                        startMs: s.startMs,
                        endMs: s.endMs,
                        topic: s.topic,
                        summary: s.summary,
                        speakers: s.speakers,
                    }),
                );
        },

        async insertPublication(v: InsertNotePublicationInput) {
            const row: NotePublication = {
                id: `pub-${++seq}`,
                tenantId: v.tenantId,
                title: v.title,
                content: v.content,
                imagePath: null,
                imageUrl: null,
                source: v.source as PublicationSource,
                publishResults: {},
                quotes: v.quotes,
                status: v.status,
                editHistory: [],
                quoteFlyerPaths: [],
                contentVariants: null,
                createdAt: new Date(),
            };
            state.publications.push(row);
            return row;
        },
    };

    return { store, state };
}

/** Atajo de seeding con defaults del tenant/transmisión del test. */
export function seedNoteSegment(
    state: MemoryNoteFactoryState,
    v: {
        id: string;
        startMs: number;
        endMs: number;
        topic?: string | null;
        summary?: string | null;
        speakers?: TransmissionSegmentSpeaker[];
        tenantId: string;
        transmissionId: string;
    },
): void {
    state.segments.push({
        id: v.id,
        tenantId: v.tenantId,
        transmissionId: v.transmissionId,
        startMs: v.startMs,
        endMs: v.endMs,
        topic: v.topic ?? null,
        summary: v.summary ?? null,
        speakers: v.speakers ?? [],
    });
}
