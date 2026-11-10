/**
 * memoryPersonIdentityStore — implementación en memoria de
 * `PersonIdentityStore` para tests de PE-03 (speaker_label → person_id).
 * Sin DB: los mismos filtros por tenant que la implementación drizzle (un
 * id ajeno al tenant no se encuentra → no se lee ni se escribe nada), y
 * `assignPersonToSpeaker` replica el `WHERE person_id IS NULL` — clave
 * para verificar que la resolución automática no pisa correcciones.
 *
 * `matchEmbedding` calcula la distancia coseno real (`1 − cos`) sobre los
 * embeddings seedeados — equivalente al `<=>` de pgvector para vectores
 * normalizados.
 *
 * `state.calls` loggea `{method, tenantId}` de cada llamada — el test de
 * aislamiento verifica que TODA query va tenant-scoped.
 */
import type {
    EmbeddingMatch,
    IdentityRecordingSegment,
    IdentityTransmission,
    PersonIdentityStore,
    UnresolvedSpeaker,
} from '../../src/server/services/personIdentityService';

export interface MemoryTranscriptRow {
    id: string;
    tenantId: string;
    transmissionId: string;
    startMs: number;
    endMs: number;
    speakerLabel: string | null;
    personId: string | null;
}

export interface MemoryRecordingSegment extends IdentityRecordingSegment {
    tenantId: string;
    transmissionId: string;
}

export interface MemoryPerson {
    id: string;
    tenantId: string;
    name: string;
}

export interface MemoryFaceEmbedding {
    id: string;
    tenantId: string;
    personId: string;
    embedding: number[];
}

export interface MemoryPersonIdentityState {
    transmissions: Map<string, IdentityTransmission>;
    transcriptSegments: MemoryTranscriptRow[];
    recordingSegments: MemoryRecordingSegment[];
    persons: Map<string, MemoryPerson>;
    embeddings: MemoryFaceEmbedding[];
    calls: Array<{ method: string; tenantId: string }>;
}

/** Distancia coseno `1 − cos(a,b)` — equivalente a `<=>` de pgvector. */
function cosineDistance(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 1 : 1 - dot / denom;
}

export function createMemoryPersonIdentityStore(seed: {
    transmissions?: IdentityTransmission[];
    transcriptSegments?: MemoryTranscriptRow[];
    recordingSegments?: MemoryRecordingSegment[];
    persons?: MemoryPerson[];
    embeddings?: MemoryFaceEmbedding[];
} = {}): { store: PersonIdentityStore; state: MemoryPersonIdentityState } {
    const state: MemoryPersonIdentityState = {
        transmissions: new Map(
            (seed.transmissions ?? []).map((t) => [`${t.tenantId}/${t.id}`, { ...t }]),
        ),
        transcriptSegments: (seed.transcriptSegments ?? []).map((r) => ({ ...r })),
        recordingSegments: (seed.recordingSegments ?? []).map((s) => ({ ...s })),
        persons: new Map((seed.persons ?? []).map((p) => [p.id, { ...p }])),
        embeddings: (seed.embeddings ?? []).map((e) => ({ ...e })),
        calls: [],
    };

    const store: PersonIdentityStore = {
        async getTransmission(tenantId, transmissionId) {
            state.calls.push({ method: 'getTransmission', tenantId });
            return state.transmissions.get(`${tenantId}/${transmissionId}`) ?? null;
        },

        async listUnresolvedSpeakers(tenantId, transmissionId) {
            state.calls.push({ method: 'listUnresolvedSpeakers', tenantId });
            const byLabel = new Map<string, UnresolvedSpeaker>();
            for (const r of state.transcriptSegments) {
                if (
                    r.tenantId !== tenantId ||
                    r.transmissionId !== transmissionId ||
                    r.personId !== null ||
                    r.speakerLabel === null
                ) {
                    continue;
                }
                const entry = byLabel.get(r.speakerLabel);
                if (!entry) {
                    byLabel.set(r.speakerLabel, {
                        speakerLabel: r.speakerLabel,
                        startMs: r.startMs,
                        endMs: r.endMs,
                        segmentCount: 1,
                    });
                } else {
                    entry.startMs = Math.min(entry.startMs, r.startMs);
                    entry.endMs = Math.max(entry.endMs, r.endMs);
                    entry.segmentCount++;
                }
            }
            return [...byLabel.values()].sort((a, b) => a.startMs - b.startMs);
        },

        async listRecordingSegments(tenantId, transmissionId) {
            state.calls.push({ method: 'listRecordingSegments', tenantId });
            return state.recordingSegments
                .filter(
                    (s) => s.tenantId === tenantId && s.transmissionId === transmissionId,
                )
                .sort((a, b) => a.startMs - b.startMs || a.sequence - b.sequence);
        },

        async matchEmbedding(tenantId, embedding, limit) {
            state.calls.push({ method: 'matchEmbedding', tenantId });
            const matches: EmbeddingMatch[] = [];
            for (const e of state.embeddings) {
                if (e.tenantId !== tenantId) continue;
                const person = state.persons.get(e.personId);
                if (!person || person.tenantId !== tenantId) continue;
                matches.push({
                    personId: e.personId,
                    personName: person.name,
                    distance: cosineDistance(embedding, e.embedding),
                });
            }
            return matches
                .sort((a, b) => a.distance - b.distance)
                .slice(0, Math.max(1, limit));
        },

        async assignPersonToSpeaker(tenantId, transmissionId, speakerLabel, personId) {
            state.calls.push({ method: 'assignPersonToSpeaker', tenantId });
            let updated = 0;
            for (const r of state.transcriptSegments) {
                // Mismo WHERE que drizzle: tenant + tx + label + person_id IS NULL.
                if (
                    r.tenantId === tenantId &&
                    r.transmissionId === transmissionId &&
                    r.speakerLabel === speakerLabel &&
                    r.personId === null
                ) {
                    r.personId = personId;
                    updated++;
                }
            }
            return { updated };
        },

        async overrideSpeakerPerson(tenantId, transmissionId, speakerLabel, personId) {
            state.calls.push({ method: 'overrideSpeakerPerson', tenantId });
            let updated = 0;
            for (const r of state.transcriptSegments) {
                if (
                    r.tenantId === tenantId &&
                    r.transmissionId === transmissionId &&
                    r.speakerLabel === speakerLabel
                ) {
                    r.personId = personId;
                    updated++;
                }
            }
            return { updated };
        },
    };

    return { store, state };
}
