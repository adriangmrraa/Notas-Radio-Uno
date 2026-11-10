/**
 * memoryRecutStore — implementación en memoria de `RecutStore` para los
 * tests del re-corte manual (PF-05). Sin DB: reproduce los MISMOS filtros
 * que la implementación drizzle:
 *
 *   - `getClip` matchea por `clipId AND tenantId`: un clip ajeno al tenant
 *     no se encuentra → `clip_not_found` (mismo efecto que el WHERE).
 *   - `listCoverage` replica el JOIN recording_segments→stream_recordings:
 *     segmentos cuyo `recordingId` pertenece a una grabación de la
 *     transmisión pedida, filtrados por tenant en AMBAS tablas y por
 *     `status === 'active'`, ordenados por `startMs`/`sequence`.
 *   - `patchClipMetadata` hace el merge jsonb del `||` de Postgres: las
 *     claves del patch pisan las existentes (top-level), el resto queda —
 *     acotado por `clipId AND tenantId` (un clip ajeno → no-op).
 */
import type {
  CoverageSegment,
  RecutClipRow,
  RecutStore,
} from '../../src/server/services/clipRecutService';

export interface MemoryRecutClip extends RecutClipRow {
  tenantId: string;
}

export interface MemoryRecutRecording {
  id: string;
  tenantId: string;
  transmissionId: string;
}

export interface MemoryRecutSegment {
  tenantId: string;
  recordingId: string;
  sequence: number;
  startMs: number;
  /** null = segmento abierto (sigue grabando). */
  endMs: number | null;
  /** Default 'active' — un 'purged' queda fuera de la cobertura. */
  status?: string;
}

export interface MemoryRecutState {
  clips: MemoryRecutClip[];
  recordings: MemoryRecutRecording[];
  segments: MemoryRecutSegment[];
}

export function createMemoryRecutStore(seed: {
  clips?: MemoryRecutClip[];
  recordings?: MemoryRecutRecording[];
  segments?: MemoryRecutSegment[];
}): { store: RecutStore; state: MemoryRecutState } {
  const state: MemoryRecutState = {
    clips: (seed.clips ?? []).map((c) => ({
      ...c,
      metadata: c.metadata ? { ...c.metadata } : null,
    })),
    recordings: (seed.recordings ?? []).map((r) => ({ ...r })),
    segments: (seed.segments ?? []).map((s) => ({ ...s })),
  };

  const store: RecutStore = {
    async getClip(clipId, tenantId) {
      const clip = state.clips.find(
        (c) => c.id === clipId && c.tenantId === tenantId,
      );
      if (!clip) return null;
      const { tenantId: _t, ...row } = clip;
      return row;
    },

    async listCoverage(tenantId, transmissionId) {
      const recIds = new Set(
        state.recordings
          .filter(
            (r) =>
              r.transmissionId === transmissionId && r.tenantId === tenantId,
          )
          .map((r) => r.id),
      );
      const coverage: CoverageSegment[] = state.segments
        .filter(
          (s) =>
            recIds.has(s.recordingId) &&
            s.tenantId === tenantId &&
            (s.status ?? 'active') === 'active',
        )
        .sort((a, b) => a.startMs - b.startMs || a.sequence - b.sequence)
        .map(({ startMs, endMs }) => ({ startMs, endMs }));
      return coverage;
    },

    async patchClipMetadata(clipId, tenantId, metadata) {
      const clip = state.clips.find(
        (c) => c.id === clipId && c.tenantId === tenantId,
      );
      if (!clip) return; // WHERE tenant_id no matchea → no-op
      // Semántica del `||` jsonb: merge top-level, el patch gana.
      clip.metadata = { ...(clip.metadata ?? {}), ...metadata };
    },
  };

  return { store, state };
}
