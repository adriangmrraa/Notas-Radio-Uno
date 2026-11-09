/**
 * memorySchedulerStore — implementación en memoria de `SchedulerStore` para
 * tests del scheduler de transmisiones (PD-03). Sin DB: los mismos filtros
 * que la implementación drizzle (`is_active` + `auto_start` + `next_run_at`
 * vencido para el descubrimiento; escrituras a `transmissions` siempre por
 * tenant_id — un id ajeno al tenant no se encuentra → no-op).
 */
import type {
  DueScheduled,
  ScheduledAdvancePatch,
  SchedulerRunInsert,
  SchedulerRunPatch,
  SchedulerRunRow,
  SchedulerStore,
  StaleRun,
} from '../../src/server/services/transmissionSchedulerService';

/** Fila de agenda en memoria: los campos del scheduler + los que filtra. */
export interface MemoryScheduled extends DueScheduled {
  isActive: boolean;
  autoStart: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastTransmissionId: string | null;
}

/** Corrida en memoria: fila base + campos que el scheduler parchea. */
export interface MemoryRun extends SchedulerRunRow {
  programId: string | null;
  source: string;
  endedAt: Date | null;
  errorMessage: string | null;
  pipelineConfig: unknown;
}

/** Recording mínima para el reconcile (sólo importa su status). */
export interface MemoryRecording {
  transmissionId: string;
  status: string;
}

export interface MemorySchedulerState {
  scheduled: MemoryScheduled[];
  runs: MemoryRun[];
  recordings: MemoryRecording[];
  /** Historial de patches aplicados a corridas (asserts de tests). */
  runPatches: Array<{ runId: string; patch: SchedulerRunPatch }>;
  /** Historial de avances de agenda. */
  advancePatches: Array<{ scheduledId: string; patch: ScheduledAdvancePatch }>;
}

const OPEN = new Set(['scheduled', 'waiting', 'live', 'processing']);

let seq = 0;

export function createMemorySchedulerStore(seed: {
  scheduled?: MemoryScheduled[];
  runs?: MemoryRun[];
  recordings?: MemoryRecording[];
}): { store: SchedulerStore; state: MemorySchedulerState } {
  const state: MemorySchedulerState = {
    scheduled: (seed.scheduled ?? []).map((s) => ({ ...s })),
    runs: (seed.runs ?? []).map((r) => ({ ...r })),
    recordings: (seed.recordings ?? []).map((r) => ({ ...r })),
    runPatches: [],
    advancePatches: [],
  };

  const store: SchedulerStore = {
    async findDueScheduled(now) {
      return state.scheduled
        .filter(
          (s) =>
            s.isActive &&
            s.autoStart &&
            s.nextRunAt !== null &&
            s.nextRunAt.getTime() <= now.getTime(),
        )
        .sort(
          (a, b) =>
            (a.nextRunAt?.getTime() ?? 0) - (b.nextRunAt?.getTime() ?? 0),
        );
    },

    async findOpenRunId(tenantId, scheduledTransmissionId) {
      const open = state.runs.find(
        (r) =>
          r.tenantId === tenantId &&
          r.scheduledTransmissionId === scheduledTransmissionId &&
          OPEN.has(r.status),
      );
      return open?.id ?? null;
    },

    async insertRun(v: SchedulerRunInsert) {
      const id = `mem-tx-${++seq}`;
      state.runs.push({
        id,
        tenantId: v.tenantId,
        programId: v.programId,
        scheduledTransmissionId: v.scheduledTransmissionId,
        source: v.source,
        status: v.status,
        streamUrl: v.streamUrl,
        startedAt: v.startedAt,
        waitingSince: null,
        durationMinutes: v.durationMinutes,
        endedAt: null,
        errorMessage: null,
        pipelineConfig: v.pipelineConfig,
      });
      return { id };
    },

    async updateRun(tenantId, runId, patch) {
      const run = state.runs.find(
        (r) => r.id === runId && r.tenantId === tenantId,
      );
      if (!run) return; // igual que drizzle: WHERE tenant_id no matchea → no-op
      Object.assign(run, patch);
      state.runPatches.push({ runId, patch });
    },

    async advanceScheduled(tenantId, scheduledId, patch) {
      const row = state.scheduled.find(
        (s) => s.id === scheduledId && s.tenantId === tenantId,
      );
      if (!row) return;
      Object.assign(row, patch);
      state.advancePatches.push({ scheduledId, patch });
    },

    async listPendingRuns() {
      return state.runs.filter(
        (r) => r.status === 'scheduled' || r.status === 'waiting',
      );
    },

    async countActiveRuns() {
      return state.runs.filter(
        (r) => r.status === 'live' || r.status === 'processing',
      ).length;
    },

    async listStaleRuns(): Promise<StaleRun[]> {
      return state.runs
        .filter((r) => r.status === 'live' || r.status === 'processing')
        .map((r) => ({
          ...r,
          recordingStatus:
            state.recordings.find((rec) => rec.transmissionId === r.id)
              ?.status ?? null,
        }));
    },
  };

  return { store, state };
}
