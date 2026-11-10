/**
 * liveAnalysisRunner — wiring de análisis en vivo (PE-04).
 *
 * Cuando `streamRecorderService` CIERRA un segmento de grabación (apareció
 * el siguiente, o la grabación finalizó), el hook `setSegmentFinalizedHook`
 * dispara `handleSegmentFinalized`, que corre
 * `analysisEngineService.processRecordingSegment` sobre ese segmento
 * (transcribe → escribe transcript/segments/moments/quotes → alertas) y, si
 * el segmento produjo contenido nuevo, notifica a la Sala "En vivo":
 *
 *   - `transmission:updated` al room `tenant:{id}` con la fila serializada
 *     fresca — el cliente (useTransmissionEvents/LiveRoomPage) refetchea la
 *     sala entera y los momentos/segmentos nuevos aparecen solos.
 *   - `transmission:moments` a `transmission:{id}` + `tenant:{id}` con
 *     `{transmissionId, summary}` — evento semántico nuevo: hoy nadie lo
 *     escucha, queda el contrato para una UI futura sin refetch completo.
 *
 * NUNCA rompe la grabación: el hook del recorder es fire-and-forget y un
 * error del engine se loguea `[live-analysis]` sin propagar.
 *
 * Mismo patrón que el resto del repo: `ioRef` como initNotificationService,
 * store propio + deps inyectables (engine/store/emit) — los tests corren
 * sin DB, sin sockets y sin APIs externas. TODA query filtra por tenant_id.
 */
import { and, eq } from 'drizzle-orm';
import type { Server } from 'socket.io';

import { db, type Database } from '../db/index.js';
import { transmissions } from '../db/schema/transmissions.js';
import {
  analysisEngineService,
  type ProcessRecordingSegmentInput,
  type ProcessSegmentSummary,
} from './analysisEngineService.js';
import {
  serializeTransmission,
  type TransmissionRow,
} from './transmissionService.js';
import {
  setSegmentFinalizedHook,
  type SegmentFinalizedInfo,
} from './streamRecorderService.js';

// ─── Deps inyectables ───────────────────────────────────────────────────────

/** El motor de PE-02 — en prod el singleton, en tests un stub. */
export interface LiveAnalysisEngine {
  processRecordingSegment(
    input: ProcessRecordingSegmentInput,
  ): Promise<ProcessSegmentSummary>;
}

/** Store del runner: la fila completa para `serializeTransmission`. */
export interface LiveAnalysisRunnerStore {
  getTransmission(
    tenantId: string,
    transmissionId: string,
  ): Promise<TransmissionRow | null>;
}

/**
 * Emisor de eventos a rooms — en prod encadena `io.to(room)...emit`, en
 * tests un stub que registra `{rooms, event, payload}`.
 */
export type LiveAnalysisEmit = (
  rooms: string[],
  event: string,
  payload: unknown,
) => void;

export interface LiveAnalysisRunnerDeps {
  engine?: LiveAnalysisEngine;
  store?: LiveAnalysisRunnerStore;
  emit?: LiveAnalysisEmit;
}

// ─── Store drizzle — todas las queries filtran por tenant_id ────────────────

export function createDrizzleRunnerStore(
  executor: Database = db,
): LiveAnalysisRunnerStore {
  return {
    async getTransmission(tenantId, transmissionId) {
      const [row] = await executor
        .select()
        .from(transmissions)
        .where(
          and(
            eq(transmissions.id, transmissionId),
            eq(transmissions.tenantId, tenantId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}

// ─── Emisión por socket — ioRef como initNotificationService ────────────────

let ioRef: Server | null = null;

const defaultEmit: LiveAnalysisEmit = (rooms, event, payload) => {
  if (!ioRef || rooms.length === 0) return;
  let chain = ioRef.to(rooms[0]);
  for (const room of rooms.slice(1)) chain = chain.to(room);
  chain.emit(event, payload);
};

// ─── Runner ─────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createLiveAnalysisRunner(deps: LiveAnalysisRunnerDeps = {}) {
  const engine = deps.engine ?? analysisEngineService;
  const store = deps.store ?? createDrizzleRunnerStore();
  const emit = deps.emit ?? defaultEmit;

  /**
   * Un segmento de grabación cerró → correr el engine sobre él y, si dejó
   * contenido nuevo (momentos/citas/segmentos temáticos), avisar a la sala.
   * Nunca lanza: un fallo del engine o de la lectura de la fila se loguea
   * `[live-analysis]` — la captura de video no se entera.
   */
  async function handleSegmentFinalized(
    info: SegmentFinalizedInfo,
  ): Promise<void> {
    const { tenantId, transmissionId, recordingId, sequence } = info;

    let summary: ProcessSegmentSummary;
    try {
      summary = await engine.processRecordingSegment({
        tenantId,
        transmissionId,
        recordingId,
        sequence,
      });
    } catch (err) {
      console.error(
        `[live-analysis] segmento ${recordingId}#${sequence} falló: ${errMsg(err)}`,
      );
      return;
    }

    const wroteNew =
      summary.momentsWritten > 0 ||
      summary.quotesWritten > 0 ||
      summary.segmentsWritten > 0;
    if (!wroteNew) return;

    // Fila fresca para el broadcast — si la lectura falla igual se emite
    // `transmission:moments` (los momentos YA están persistidos).
    const row = await store
      .getTransmission(tenantId, transmissionId)
      .catch((err) => {
        console.error(
          `[live-analysis] getTransmission ${transmissionId} falló: ${errMsg(err)}`,
        );
        return null;
      });
    if (row) {
      emit(
        [`tenant:${tenantId}`],
        'transmission:updated',
        serializeTransmission(row),
      );
    }
    emit(
      [`transmission:${transmissionId}`, `tenant:${tenantId}`],
      'transmission:moments',
      { transmissionId, summary },
    );
  }

  return { handleSegmentFinalized };
}

const defaultRunner = createLiveAnalysisRunner();

/**
 * Conecta el runner al `io` del proceso y registra el hook del recorder —
 * se llama en `index.ts` junto a los otros init. A partir de ahí, cada
 * segmento cerrado dispara análisis en vivo (fire-and-forget).
 */
export function initLiveAnalysisRunner(io: Server): void {
  ioRef = io;
  setSegmentFinalizedHook(defaultRunner.handleSegmentFinalized);
}
