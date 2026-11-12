/**
 * memoryRecorderStore — implementación en memoria de `RecorderStore` para
 * tests del recorder de video (PD-02). Sin DB ni procesos: los mismos
 * filtros por tenant que la implementación drizzle (un id ajeno al tenant no
 * se encuentra → no se lee ni se escribe nada).
 */
import type {
    RecorderStore,
    RecorderTransmission,
    RecorderTransmissionPatch,
} from '../../src/server/services/streamRecorderService';

export interface MemoryRecording {
    id: string;
    tenantId: string;
    transmissionId: string;
    storagePrefix: string;
    status: string;
    totalBytes: number;
    startedAt: Date;
    endedAt: Date | null;
}

export interface MemorySegment {
    tenantId: string;
    recordingId: string;
    sequence: number;
    startMs: number;
    endMs: number | null;
    fileRef: string;
    bytes: number;
}

/** Transmisión en memoria: fila base + campos que el recorder parchea. */
export type MemoryTransmission = Omit<RecorderTransmission, 'status'> &
    Omit<RecorderTransmissionPatch, 'status'> & { status: string };

export interface MemoryRecorderState {
    transmissions: Map<string, MemoryTransmission>;
    transmissionPatches: Array<{ transmissionId: string; patch: RecorderTransmissionPatch }>;
    recordings: Map<string, MemoryRecording>;
    segments: MemorySegment[];
}

let seq = 0;

export function createMemoryRecorderStore(seed: {
    transmissions?: RecorderTransmission[];
}): { store: RecorderStore; state: MemoryRecorderState } {
    const state: MemoryRecorderState = {
        transmissions: new Map<string, MemoryTransmission>(
            (seed.transmissions ?? []).map((t) => [`${t.tenantId}/${t.id}`, { ...t }]),
        ),
        transmissionPatches: [],
        recordings: new Map(),
        segments: [],
    };

    const store: RecorderStore = {
        async getTransmission(tenantId, transmissionId) {
            return state.transmissions.get(`${tenantId}/${transmissionId}`) ?? null;
        },

        async createRecording(v) {
            const id = `mem-rec-${++seq}`;
            state.recordings.set(`${v.tenantId}/${id}`, {
                id,
                tenantId: v.tenantId,
                transmissionId: v.transmissionId,
                storagePrefix: v.storagePrefix,
                status: 'recording',
                totalBytes: 0,
                startedAt: v.startedAt,
                endedAt: null,
            });
            return { id };
        },

        async resumeRecording(tenantId, transmissionId, recordingId) {
            const rec = state.recordings.get(`${tenantId}/${recordingId}`);
            // Mismos filtros que drizzle: tenant + transmisión dueña.
            if (!rec || rec.transmissionId !== transmissionId) return null;
            rec.status = 'recording';
            rec.endedAt = null;
            return {
                id: rec.id,
                transmissionId: rec.transmissionId,
                storagePrefix: rec.storagePrefix,
                startedAt: rec.startedAt,
            };
        },

        async listSegments(tenantId, recordingId) {
            return state.segments
                .filter(
                    (s) =>
                        s.tenantId === tenantId &&
                        s.recordingId === recordingId,
                )
                .sort((a, b) => a.sequence - b.sequence)
                .map((s) => ({
                    sequence: s.sequence,
                    fileRef: s.fileRef,
                    startMs: s.startMs,
                    endMs: s.endMs,
                    bytes: s.bytes,
                }));
        },

        async updateTransmission(tenantId, transmissionId, patch) {
            const key = `${tenantId}/${transmissionId}`;
            const tx = state.transmissions.get(key);
            if (!tx) return; // misma regla que drizzle: WHERE tenant_id no matchea → no-op
            state.transmissions.set(key, { ...tx, ...patch });
            state.transmissionPatches.push({ transmissionId, patch });
        },

        async insertSegment(v) {
            state.segments.push({ ...v });
        },

        async setSegmentEndMs(tenantId, recordingId, sequence, endMs) {
            const seg = state.segments.find(
                (s) =>
                    s.tenantId === tenantId &&
                    s.recordingId === recordingId &&
                    s.sequence === sequence,
            );
            if (seg) seg.endMs = endMs;
        },

        async finalizeRecording(tenantId, recordingId, patch) {
            const rec = state.recordings.get(`${tenantId}/${recordingId}`);
            if (!rec) return;
            rec.status = patch.status;
            rec.totalBytes = patch.totalBytes;
            rec.endedAt = patch.endedAt;
        },
    };

    return { store, state };
}
