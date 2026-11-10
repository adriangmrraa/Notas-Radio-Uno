/**
 * memoryAnalysisEngineStore — implementación en memoria de
 * `AnalysisEngineStore` para tests del motor de análisis (PE-02). Sin DB:
 * los mismos filtros por tenant que la implementación drizzle (un id ajeno
 * al tenant no se encuentra → no se lee ni se escribe nada).
 *
 * `state.calls` loggea `{method, tenantId}` de cada llamada — el test de
 * aislamiento lo usa para verificar que TODA query va tenant-scoped.
 */
import type {
    AnalysisEngineStore,
    EngineRecording,
    EngineRecordingSegment,
    EngineTransmission,
    MomentInsert,
    TranscriptSegmentInsert,
} from '../../src/server/services/analysisEngineService';

export type MemoryTranscriptRow = TranscriptSegmentInsert & { tenantId: string };
export type MemoryMoment = MomentInsert & { tenantId: string; id: string };

export interface MemoryAnalysisEngineState {
    transmissions: Map<string, EngineTransmission>;
    recordings: Map<string, EngineRecording>;
    recordingSegments: EngineRecordingSegment[];
    transcriptSegments: MemoryTranscriptRow[];
    moments: MemoryMoment[];
    calls: Array<{ method: string; tenantId: string }>;
}

let momentSeq = 0;

export function createMemoryAnalysisEngineStore(seed: {
    transmissions?: EngineTransmission[];
    recordings?: EngineRecording[];
    recordingSegments?: EngineRecordingSegment[];
} = {}): { store: AnalysisEngineStore; state: MemoryAnalysisEngineState } {
    const state: MemoryAnalysisEngineState = {
        transmissions: new Map(
            (seed.transmissions ?? []).map((t) => [`${t.tenantId}/${t.id}`, { ...t }]),
        ),
        recordings: new Map(
            (seed.recordings ?? []).map((r) => [`${r.tenantId}/${r.id}`, { ...r }]),
        ),
        recordingSegments: (seed.recordingSegments ?? []).map((s) => ({ ...s })),
        transcriptSegments: [],
        moments: [],
        calls: [],
    };

    const store: AnalysisEngineStore = {
        async getTransmission(tenantId, transmissionId) {
            state.calls.push({ method: 'getTransmission', tenantId });
            return state.transmissions.get(`${tenantId}/${transmissionId}`) ?? null;
        },

        async getRecording(tenantId, recordingId) {
            state.calls.push({ method: 'getRecording', tenantId });
            return state.recordings.get(`${tenantId}/${recordingId}`) ?? null;
        },

        async listRecordings(tenantId, transmissionId) {
            state.calls.push({ method: 'listRecordings', tenantId });
            return [...state.recordings.values()].filter(
                (r) => r.tenantId === tenantId && r.transmissionId === transmissionId,
            );
        },

        async listRecordingSegments(tenantId, recordingId) {
            state.calls.push({ method: 'listRecordingSegments', tenantId });
            return state.recordingSegments
                .filter(
                    (s) => s.tenantId === tenantId && s.recordingId === recordingId,
                )
                .sort((a, b) => a.sequence - b.sequence);
        },

        async insertTranscriptSegments(tenantId, rows) {
            state.calls.push({ method: 'insertTranscriptSegments', tenantId });
            for (const r of rows) {
                state.transcriptSegments.push({ ...r, tenantId });
            }
        },

        async insertMoment(tenantId, v) {
            state.calls.push({ method: 'insertMoment', tenantId });
            const id = `moment-${++momentSeq}`;
            state.moments.push({ ...v, tenantId, id });
            return { id };
        },
    };

    return { store, state };
}
