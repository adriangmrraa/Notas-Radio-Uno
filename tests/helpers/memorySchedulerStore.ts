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
  SchedulerSegmentRow,
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

/**
 * Recording para el reconcile/sweep de ingesta (PI-04). `id`,
 * `storagePrefix` y `startedAt` son opcionales para no romper seeds viejos
 * que sólo modelan el status — el sweep los necesita (cae a null/default).
 */
export interface MemoryRecording {
  transmissionId: string;
  status: string;
  id?: string;
  /** Si está set, las queries por tenant_id filtran (misma regla que drizzle). */
  tenantId?: string;
  storagePrefix?: string;
  startedAt?: Date | null;
  endedAt?: Date | null;
}

/** Segmento de la grabación (sweep PI-04: cierre de abiertos). */
export interface MemorySegment extends SchedulerSegmentRow {
  recordingId: string;
}

export interface MemorySchedulerState {
  scheduled: MemoryScheduled[];
  runs: MemoryRun[];
  recordings: MemoryRecording[];
  segments: MemorySegment[];
  /** Historial de patches aplicados a corridas (asserts de tests). */
  runPatches: Array<{ runId: string; patch: SchedulerRunPatch }>;
  /** Historial de avances de agenda. */
  advancePatches: Array<{ scheduledId: string; patch: ScheduledAdvancePatch }>;
  /** Historial de patches a stream_recordings (sweep de ingesta). */
  recordingPatches: Array<{
    recordingId: string;
    patch: { status?: string; endedAt?: Date | null };
  }>;
}

const OPEN = new Set(['scheduled', 'waiting', 'live', 'processing']);

let seq = 0;

export function createMemorySchedulerStore(seed: {
  scheduled?: MemoryScheduled[];
  runs?: MemoryRun[];
  recordings?: MemoryRecording[];
  segments?: MemorySegment[];
}): { store: SchedulerStore; state: MemorySchedulerState } {
  const state: MemorySchedulerState = {
    scheduled: (seed.scheduled ?? []).map((s) => ({ ...s })),
    runs: (seed.runs ?? []).map((r) => ({ ...r })),
    recordings: (seed.recordings ?? []).map((r) => ({ ...r })),
    segments: (seed.segments ?? []).map((s) => ({ ...s })),
    runPatches: [],
    advancePatches: [],
    recordingPatches: [],
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
        .map((r) => {
          const rec = state.recordings.find(
            (rec) => rec.transmissionId === r.id,
          );
          return {
            ...r,
            recordingStatus: rec?.status ?? null,
            recordingId: rec?.id ?? null,
            recordingStartedAt: rec?.startedAt ?? null,
            storagePrefix: rec?.storagePrefix ?? null,
          };
        });
    },

    async listSegments(tenantId, recordingId) {
      // Mismo filtro tenant que drizzle: un recordingId ajeno no devuelve nada.
      const rec = state.recordings.find((r) => r.id === recordingId);
      if (rec?.tenantId !== undefined && rec.tenantId !== tenantId) return [];
      return state.segments
        .filter((s) => s.recordingId === recordingId)
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => ({
          sequence: s.sequence,
          fileRef: s.fileRef,
          startMs: s.startMs,
          endMs: s.endMs,
          bytes: s.bytes,
        }));
    },

    async setSegmentEndMs(tenantId, recordingId, sequence, endMs) {
      const rec = state.recordings.find((r) => r.id === recordingId);
      if (rec?.tenantId !== undefined && rec.tenantId !== tenantId) return;
      const seg = state.segments.find(
        (s) => s.recordingId === recordingId && s.sequence === sequence,
      );
      // Idempotente como el drizzle (WHERE end_ms IS NULL).
      if (seg && seg.endMs === null) seg.endMs = endMs;
    },

    async updateRecording(tenantId, recordingId, patch) {
      const rec = state.recordings.find((r) => r.id === recordingId);
      if (!rec) return;
      if (rec.tenantId !== undefined && rec.tenantId !== tenantId) return;
      if (patch.status !== undefined) rec.status = patch.status;
      if (patch.endedAt !== undefined) rec.endedAt = patch.endedAt;
      state.recordingPatches.push({ recordingId, patch });
    },
  };

  return { store, state };
}
