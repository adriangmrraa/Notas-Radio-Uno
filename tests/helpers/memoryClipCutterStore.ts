/**
 * memoryClipCutterStore — implementación en memoria de `ClipCutterStore`
 * para los tests del clip-cutter (PF-01). Sin DB: reproduce los MISMOS
 * filtros que la implementación drizzle:
 *
 *   - `getTransmission`/`listRecordingsWithSegments` matchean por
 *     `${tenantId}/${id}`: un id ajeno al tenant no se encuentra →
 *     `transmission_not_found`, mismo efecto que el WHERE tenant_id.
 *   - Los segmentos se filtran a `status === 'active'` y se ordenan por
 *     `startMs`/`sequence` dentro de cada grabación.
 *   - `setClipResult` acotado por tenant_id: un clipId de otro tenant no
 *     matchea → no-op (mismo WHERE que el UPDATE drizzle).
 */
import type {
  ClipCutterStore,
  ClipResultPatch,
  ClipRowInsert,
  CutterRecording,
  CutterTransmission,
} from '../../src/server/services/clipCutterService';

export interface MemoryCutterRecording {
  id: string;
  tenantId: string;
  transmissionId: string;
  storagePrefix: string;
  status: string;
}

export interface MemoryCutterSegment {
  id: string;
  tenantId: string;
  recordingId: string;
  sequence: number;
  startMs: number;
  endMs: number | null;
  fileRef: string;
  status: string;
}

export interface MemoryClipRow extends ClipRowInsert {
  id: string;
  videoPath: string | null;
  /** Historial de patches aplicados (asserts de tests). */
  resultPatches: ClipResultPatch[];
}

export interface MemoryClipCutterState {
  transmissions: Map<string, CutterTransmission>;
  recordings: MemoryCutterRecording[];
  segments: MemoryCutterSegment[];
  clips: MemoryClipRow[];
}

let clipSeq = 0;

export function createMemoryClipCutterStore(seed: {
  transmissions?: CutterTransmission[];
  recordings?: MemoryCutterRecording[];
  segments?: MemoryCutterSegment[];
}): { store: ClipCutterStore; state: MemoryClipCutterState } {
  const state: MemoryClipCutterState = {
    transmissions: new Map(
      (seed.transmissions ?? []).map((t) => [`${t.tenantId}/${t.id}`, { ...t }]),
    ),
    recordings: (seed.recordings ?? []).map((r) => ({ ...r })),
    segments: (seed.segments ?? []).map((s) => ({ ...s })),
    clips: [],
  };

  const store: ClipCutterStore = {
    async getTransmission(tenantId, transmissionId) {
      return state.transmissions.get(`${tenantId}/${transmissionId}`) ?? null;
    },

    async listRecordingsWithSegments(tenantId, transmissionId) {
      // Mismo filtro que el drizzle: recording por (transmission, tenant) y
      // segmentos por (tenant, recording, status='active') ordenados.
      const recs = state.recordings.filter(
        (r) => r.transmissionId === transmissionId && r.tenantId === tenantId,
      );
      const result: CutterRecording[] = [];
      for (const rec of recs) {
        const segments = state.segments
          .filter(
            (s) =>
              s.recordingId === rec.id &&
              s.tenantId === tenantId &&
              s.status === 'active',
          )
          .sort((a, b) => a.startMs - b.startMs || a.sequence - b.sequence)
          .map(({ id, recordingId, sequence, startMs, endMs, fileRef }) => ({
            id,
            recordingId,
            sequence,
            startMs,
            endMs,
            fileRef,
          }));
        result.push({ ...rec, segments });
      }
      return result;
    },

    async createClipRow(v) {
      const row: MemoryClipRow = {
        ...v,
        metadata: { ...v.metadata },
        id: `mem-clip-${++clipSeq}`,
        videoPath: null,
        resultPatches: [],
      };
      state.clips.push(row);
      return { id: row.id };
    },

    async setClipResult(tenantId, clipId, patch) {
      const clip = state.clips.find(
        (c) => c.id === clipId && c.tenantId === tenantId,
      );
      if (!clip) return; // WHERE tenant_id no matchea → no-op
      if (patch.videoPath !== undefined) clip.videoPath = patch.videoPath;
      if (patch.duration !== undefined) clip.duration = patch.duration;
      clip.status = patch.status;
      if (patch.metadata !== undefined) clip.metadata = { ...patch.metadata };
      clip.resultPatches.push({ ...patch });
    },
  };

  return { store, state };
}
