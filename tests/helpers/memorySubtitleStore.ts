/**
 * memorySubtitleStore — implementación en memoria de `SubtitleStore` para
 * los tests del quemado de subtítulos (PF-03). Sin DB: reproduce los
 * MISMOS filtros que la implementación drizzle:
 *
 *   - `getClip`/`updateClip` matchean por `tenantId AND id`: un clipId
 *     ajeno al tenant no se encuentra → `clip_not_found` / no-op (mismo
 *     WHERE tenant_id del SELECT/UPDATE drizzle).
 *   - `listUtterances` filtra por `tenant_id AND transmission_id` +
 *     overlap `seg.startMs < endMs AND seg.endMs > startMs`, ordenado por
 *     `startMs` — exactamente el WHERE/ORDER BY del drizzle.
 *   - `getPersonNames` matchea `tenant_id AND id IN personIds` y devuelve
 *     el Map id→name (ids ajenos al tenant no aparecen).
 *   - `updateClip` aplica el patch completo (metadata es reemplazo, no
 *     merge) y registra el historial en `patches` para los asserts.
 */
import type {
  SubtitleClipPatch,
  SubtitleClipRow,
  SubtitleStore,
  SubtitleUtterance,
} from '../../src/server/services/clipSubtitleService';

export interface MemorySubtitleClip extends SubtitleClipRow {
  /** Historial de patches aplicados (asserts de tests). */
  patches: SubtitleClipPatch[];
}

/** Fila de transcript_segments seedeable (con tenantId/transmissionId). */
export interface MemoryUtteranceRow extends SubtitleUtterance {
  tenantId: string;
  transmissionId: string;
}

export interface MemoryPersonRow {
  id: string;
  tenantId: string;
  name: string;
}

export interface MemorySubtitleState {
  clips: MemorySubtitleClip[];
  utterances: MemoryUtteranceRow[];
  persons: MemoryPersonRow[];
}

export function createMemorySubtitleStore(seed: {
  clips?: Array<Omit<MemorySubtitleClip, 'patches'>>;
  utterances?: MemoryUtteranceRow[];
  persons?: MemoryPersonRow[];
}): { store: SubtitleStore; state: MemorySubtitleState } {
  const state: MemorySubtitleState = {
    clips: (seed.clips ?? []).map((c) => ({
      ...c,
      metadata: c.metadata ? { ...c.metadata } : null,
      patches: [],
    })),
    utterances: (seed.utterances ?? []).map((u) => ({ ...u })),
    persons: (seed.persons ?? []).map((p) => ({ ...p })),
  };

  const byIdAndTenant = (tenantId: string, clipId: string) =>
    state.clips.find((c) => c.id === clipId && c.tenantId === tenantId);

  const store: SubtitleStore = {
    async getClip(tenantId, clipId) {
      return byIdAndTenant(tenantId, clipId) ?? null;
    },

    async listUtterances(tenantId, transmissionId, startMs, endMs) {
      // Mismo WHERE del drizzle: tenant + transmission + overlap, y el
      // mismo ORDER BY start_ms.
      return state.utterances
        .filter(
          (u) =>
            u.tenantId === tenantId &&
            u.transmissionId === transmissionId &&
            u.startMs < endMs &&
            u.endMs > startMs,
        )
        .sort((a, b) => a.startMs - b.startMs)
        .map(({ startMs: s, endMs: e, speakerLabel, personId, text }) => ({
          startMs: s,
          endMs: e,
          speakerLabel,
          personId,
          text,
        }));
    },

    async getPersonNames(tenantId, personIds) {
      const wanted = new Set(personIds);
      return new Map(
        state.persons
          .filter((p) => p.tenantId === tenantId && wanted.has(p.id))
          .map((p) => [p.id, p.name]),
      );
    },

    async updateClip(tenantId, clipId, patch) {
      const clip = byIdAndTenant(tenantId, clipId);
      if (!clip) return; // WHERE tenant_id no matchea → no-op
      if (patch.videoPath !== undefined) clip.videoPath = patch.videoPath;
      clip.status = patch.status;
      if (patch.metadata !== undefined) clip.metadata = { ...patch.metadata };
      clip.patches.push({ ...patch });
    },
  };

  return { store, state };
}
