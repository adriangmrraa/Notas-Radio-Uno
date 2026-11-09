/**
 * memoryRetentionStore — implementación en memoria de `RetentionStore` para
 * los tests de retención del crudo (PD-06). Sin DB: reproduce los MISMOS
 * filtros que la implementación drizzle:
 *
 *   - Candidata: recording `completed` + transmisión con `ended_at` +
 *     `ended_at + retention_days < now` (estricto) + al menos un segmento
 *     no `purged` + plan del tenant con `raw_retention_days > 0`.
 *   - Render pendiente: clip no terminal del mismo tenant con
 *     `metadata.transmissionId` = la transmisión, o `program_id` del mismo
 *     programa dentro de la ventana [started_at, ended_at + 24 h].
 *   - `finalizePurge` acotado por tenant_id: un recordingId ajeno al tenant
 *     no matchea → no-op (mismo WHERE que el UPDATE drizzle).
 */
import type {
  ExpiredRecordingRow,
  RetentionStore,
} from '../../src/server/services/rawRetentionService';
import { NON_TERMINAL_CLIP_STATUSES } from '../../src/server/services/rawRetentionService';

const MS_PER_DAY = 86_400_000;
const RENDER_WINDOW_GRACE_MS = 24 * 60 * 60 * 1000;

export interface MemoryRecordingRow {
  id: string;
  tenantId: string;
  transmissionId: string;
  storagePrefix: string;
  status: string;
  totalBytes: number;
  startedAt: Date;
  endedAt: Date | null;
}

export interface MemoryTransmissionRow {
  id: string;
  tenantId: string;
  programId: string | null;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  crudoRef: string | null;
}

export interface MemorySegmentRow {
  id: string;
  tenantId: string;
  recordingId: string;
  sequence: number;
  status: string;
  fileRef: string;
  bytes: number;
}

export interface MemorySubscriptionRow {
  tenantId: string;
  planId: string;
}

export interface MemoryPlanRow {
  id: string;
  rawRetentionDays: number | null;
}

export interface MemoryClipRow {
  id: string;
  tenantId: string;
  programId: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface MemoryRetentionState {
  recordings: MemoryRecordingRow[];
  transmissions: MemoryTransmissionRow[];
  segments: MemorySegmentRow[];
  subscriptions: MemorySubscriptionRow[];
  plans: MemoryPlanRow[];
  clips: MemoryClipRow[];
  /** Historial de finalizePurge aplicados (asserts de tests). */
  purges: Array<{ tenantId: string; recordingId: string; transmissionId: string }>;
}

export function createMemoryRetentionStore(seed: {
  recordings?: MemoryRecordingRow[];
  transmissions?: MemoryTransmissionRow[];
  segments?: MemorySegmentRow[];
  subscriptions?: MemorySubscriptionRow[];
  plans?: MemoryPlanRow[];
  clips?: MemoryClipRow[];
}): { store: RetentionStore; state: MemoryRetentionState } {
  const state: MemoryRetentionState = {
    recordings: (seed.recordings ?? []).map((r) => ({ ...r })),
    transmissions: (seed.transmissions ?? []).map((r) => ({ ...r })),
    segments: (seed.segments ?? []).map((r) => ({ ...r })),
    subscriptions: (seed.subscriptions ?? []).map((r) => ({ ...r })),
    plans: (seed.plans ?? []).map((r) => ({ ...r })),
    clips: (seed.clips ?? []).map((r) => ({ ...r })),
    purges: [],
  };

  const store: RetentionStore = {
    async findRawRetentionDays(tenantId) {
      const sub = state.subscriptions.find((s) => s.tenantId === tenantId);
      if (!sub) return null;
      const plan = state.plans.find((p) => p.id === sub.planId);
      return plan?.rawRetentionDays ?? null;
    },

    async listExpiredCandidates(now, opts) {
      const rows: ExpiredRecordingRow[] = [];
      for (const rec of state.recordings) {
        if (rec.status !== 'completed') continue;
        if (opts.tenantId && rec.tenantId !== opts.tenantId) continue;

        const tx = state.transmissions.find((t) => t.id === rec.transmissionId);
        if (!tx?.endedAt) continue;

        const retentionDays = await store.findRawRetentionDays(rec.tenantId);
        if (retentionDays === null || retentionDays <= 0) continue;

        // Estricto, igual que el SQL: ended_at + retention > now ⇒ no venció.
        if (tx.endedAt.getTime() + retentionDays * MS_PER_DAY >= now.getTime()) continue;

        // Ya purgada = ningún segmento sin 'purged'.
        const pending = state.segments.some(
          (s) => s.recordingId === rec.id && s.status !== 'purged',
        );
        if (!pending) continue;

        rows.push({
          recordingId: rec.id,
          tenantId: rec.tenantId,
          transmissionId: rec.transmissionId,
          storagePrefix: rec.storagePrefix,
          totalBytes: rec.totalBytes,
          endedAt: tx.endedAt,
          startedAt: tx.startedAt,
          programId: tx.programId,
          retentionDays,
        });
      }
      // Mismo ORDER BY ended_at ASC del drizzle: lo más viejo primero.
      rows.sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
      return rows.slice(0, opts.limit);
    },

    async hasPendingRender(candidate) {
      const windowStart = candidate.startedAt ?? candidate.endedAt;
      const windowEnd = candidate.endedAt.getTime() + RENDER_WINDOW_GRACE_MS;
      return state.clips.some(
        (clip) =>
          clip.tenantId === candidate.tenantId &&
          NON_TERMINAL_CLIP_STATUSES.includes(
            clip.status as (typeof NON_TERMINAL_CLIP_STATUSES)[number],
          ) &&
          (clip.metadata?.transmissionId === candidate.transmissionId ||
            (candidate.programId !== null &&
              clip.programId === candidate.programId &&
              clip.createdAt.getTime() >= windowStart.getTime() &&
              clip.createdAt.getTime() <= windowEnd)),
      );
    },

    async finalizePurge(tenantId, recordingId, transmissionId) {
      // WHERE recording_id AND tenant_id AND status <> 'purged' — una fila
      // con tenant distinto NO se toca (aislamiento por tenant).
      for (const seg of state.segments) {
        if (seg.recordingId === recordingId && seg.tenantId === tenantId && seg.status !== 'purged') {
          seg.status = 'purged';
        }
      }
      const tx = state.transmissions.find(
        (t) => t.id === transmissionId && t.tenantId === tenantId,
      );
      if (tx) tx.crudoRef = null;
      state.purges.push({ tenantId, recordingId, transmissionId });
    },
  };

  return { store, state };
}
