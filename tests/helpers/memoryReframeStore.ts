/**
 * memoryReframeStore — implementación en memoria de `ReframeStore` para los
 * tests del re-encuadre 9:16 (PF-02). Sin DB: reproduce los MISMOS filtros
 * que la implementación drizzle:
 *
 *   - `getClip`/`updateClip` matchean por `tenantId AND id`: un clipId ajeno
 *     al tenant no se encuentra → `clip_not_found` / no-op — mismo efecto
 *     que el `WHERE tenant_id` del SELECT/UPDATE drizzle.
 *   - `updateClip` aplica el patch completo (metadata es reemplazo, no
 *     merge — igual que `ClipResultPatch` del cutter) y registra el
 *     historial de patches en `patches` para los asserts de tests.
 */
import type {
  ReframeClipPatch,
  ReframeClipRow,
  ReframeStore,
} from '../../src/server/services/clipReframeService';

export interface MemoryReframeClip extends ReframeClipRow {
  /** Historial de patches aplicados (asserts de tests). */
  patches: ReframeClipPatch[];
}

export interface MemoryReframeState {
  clips: MemoryReframeClip[];
}

export function createMemoryReframeStore(seed: {
  clips?: Array<Omit<MemoryReframeClip, 'patches'>>;
}): { store: ReframeStore; state: MemoryReframeState } {
  const state: MemoryReframeState = {
    clips: (seed.clips ?? []).map((c) => ({
      ...c,
      metadata: c.metadata ? { ...c.metadata } : null,
      patches: [],
    })),
  };

  const byIdAndTenant = (tenantId: string, clipId: string) =>
    state.clips.find((c) => c.id === clipId && c.tenantId === tenantId);

  const store: ReframeStore = {
    async getClip(tenantId, clipId) {
      return byIdAndTenant(tenantId, clipId) ?? null;
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
