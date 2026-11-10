/**
 * transmissionSegmentsService — camino de escritura/lectura de
 * `transmission_segments` (PE-06).
 *
 * La tabla la alimenta el motor de análisis (PE-02): cada segmento es una
 * unidad temática (tema + resumen + speakers + ventana temporal). Este
 * servicio NO analiza: es el store tipado con filtro por `tenant_id` en
 * toda query — el mismo contrato de `streamRecorderService` (RecorderStore
 * + impl drizzle + factory para tests con store en memoria).
 */
import { and, asc, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import {
  transmissionSegments,
  type TransmissionSegmentSpeaker,
} from '../db/schema/live.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface TransmissionSegmentInsert {
  tenantId: string;
  transmissionId: string;
  startMs: number;
  endMs: number;
  topic?: string | null;
  summary?: string | null;
  speakers?: TransmissionSegmentSpeaker[];
  confidence?: number | null;
}

export interface TransmissionSegment {
  id: string;
  tenantId: string;
  transmissionId: string;
  startMs: number;
  endMs: number;
  topic: string | null;
  summary: string | null;
  speakers: TransmissionSegmentSpeaker[];
  confidence: number | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SegmentsStore {
  /** Inserta un segmento; devuelve su id. */
  insertSegment(v: TransmissionSegmentInsert): Promise<{ id: string }>;
  /** Segmentos de una transmisión ordenados por `start_ms` (timeline). */
  listByTransmission(
    tenantId: string,
    transmissionId: string,
  ): Promise<TransmissionSegment[]>;
  /**
   * Actualiza la resolución de speakers del segmento (PE-03 escribe las
   * atribuciones y la corrección manual las pisa — ambas persisten acá).
   */
  updateSegmentSpeakers(
    tenantId: string,
    segmentId: string,
    speakers: TransmissionSegmentSpeaker[],
  ): Promise<void>;
}

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleSegmentsStore(executor: Database = db): SegmentsStore {
  return {
    async insertSegment(v) {
      const [row] = await executor
        .insert(transmissionSegments)
        .values({
          tenantId: v.tenantId,
          transmissionId: v.transmissionId,
          startMs: v.startMs,
          endMs: v.endMs,
          topic: v.topic ?? null,
          summary: v.summary ?? null,
          speakers: v.speakers ?? [],
          confidence: v.confidence ?? null,
        })
        .returning({ id: transmissionSegments.id });
      return row;
    },

    async listByTransmission(tenantId, transmissionId) {
      return executor
        .select()
        .from(transmissionSegments)
        .where(
          and(
            eq(transmissionSegments.transmissionId, transmissionId),
            eq(transmissionSegments.tenantId, tenantId),
          ),
        )
        .orderBy(asc(transmissionSegments.startMs));
    },

    async updateSegmentSpeakers(tenantId, segmentId, speakers) {
      await executor
        .update(transmissionSegments)
        .set({ speakers })
        .where(
          and(
            eq(transmissionSegments.id, segmentId),
            eq(transmissionSegments.tenantId, tenantId),
          ),
        );
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createTransmissionSegmentsService(store: SegmentsStore = createDrizzleSegmentsStore()) {
  return {
    /** El motor de análisis escribe un segmento ya resuelto. */
    recordSegment(v: TransmissionSegmentInsert) {
      return store.insertSegment(v);
    },

    /** Timeline editorial completo de una transmisión, ordenado por offset. */
    listSegments(tenantId: string, transmissionId: string) {
      return store.listByTransmission(tenantId, transmissionId);
    },

    /** Atribución/corrección de identidad sobre un segmento existente. */
    setSegmentSpeakers(
      tenantId: string,
      segmentId: string,
      speakers: TransmissionSegmentSpeaker[],
    ) {
      return store.updateSegmentSpeakers(tenantId, segmentId, speakers);
    },
  };
}

export const transmissionSegmentsService = createTransmissionSegmentsService();
