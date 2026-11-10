/**
 * memoryAttributedQuotesStore — implementación en memoria de
 * `AttributedQuotesStore` para tests de `attributedQuotesService` (PE-05).
 * Sin DB: los mismos filtros por tenant que la implementación drizzle (un
 * momento/utterance/persona de otro tenant no se lista). El seed es
 * directo sobre `state` — el store real es de sólo lectura.
 */
import type {
    AttributedQuotesStore,
    QuoteMoment,
    QuotePersonRef,
    QuoteUtterance,
} from '../../src/server/services/attributedQuotesService';

export interface MemoryQuoteMomentRow {
    id: string;
    tenantId: string;
    transmissionId: string;
    kind: string;
    reason: string | null;
    title: string | null;
    startMs: number;
    endMs: number;
    score: number | null;
}

export interface MemoryUtteranceRow {
    id: string;
    tenantId: string;
    transmissionId: string;
    startMs: number;
    endMs: number;
    speakerLabel: string | null;
    personId: string | null;
}

export interface MemoryPersonRow {
    id: string;
    tenantId: string;
    name: string;
}

export interface MemoryPhotoRow {
    id: string;
    tenantId: string;
    personId: string;
    isPrimary: boolean;
    /** Epoch ms — ordena el fallback "la más antigua" (created_at ASC). */
    createdAt: number;
}

export interface MemoryAttributedQuotesState {
    moments: MemoryQuoteMomentRow[];
    utterances: MemoryUtteranceRow[];
    persons: MemoryPersonRow[];
    photos: MemoryPhotoRow[];
}

export function createMemoryAttributedQuotesStore(): {
    store: AttributedQuotesStore;
    state: MemoryAttributedQuotesState;
} {
    const state: MemoryAttributedQuotesState = {
        moments: [],
        utterances: [],
        persons: [],
        photos: [],
    };

    const store: AttributedQuotesStore = {
        async listQuoteMoments(tenantId, transmissionId) {
            return state.moments
                .filter(
                    (m) =>
                        m.tenantId === tenantId &&
                        m.transmissionId === transmissionId &&
                        m.kind === 'detected' &&
                        m.reason === 'quote',
                )
                .sort((a, b) => a.startMs - b.startMs)
                .map(
                    (m): QuoteMoment => ({
                        id: m.id,
                        startMs: m.startMs,
                        endMs: m.endMs,
                        text: m.title,
                        reason: m.reason,
                        score: m.score,
                    }),
                );
        },

        async listUtterances(tenantId, transmissionId) {
            return state.utterances
                .filter(
                    (u) =>
                        u.tenantId === tenantId &&
                        u.transmissionId === transmissionId,
                )
                .sort((a, b) => a.startMs - b.startMs)
                .map(
                    (u): QuoteUtterance => ({
                        id: u.id,
                        startMs: u.startMs,
                        endMs: u.endMs,
                        speakerLabel: u.speakerLabel,
                        personId: u.personId,
                    }),
                );
        },

        async listPersonsPhotos(tenantId, personIds) {
            return state.persons
                .filter(
                    (p) => p.tenantId === tenantId && personIds.includes(p.id),
                )
                .map((p): QuotePersonRef => {
                    // Misma regla que la query drizzle: is_primary DESC,
                    // created_at ASC → primaria o la más antigua.
                    const photo = state.photos
                        .filter(
                            (ph) =>
                                ph.tenantId === tenantId &&
                                ph.personId === p.id,
                        )
                        .sort(
                            (a, b) =>
                                Number(b.isPrimary) - Number(a.isPrimary) ||
                                a.createdAt - b.createdAt,
                        )[0];
                    return {
                        personId: p.id,
                        name: p.name,
                        primaryPhotoId: photo?.id ?? null,
                    };
                });
        },
    };

    return { store, state };
}
