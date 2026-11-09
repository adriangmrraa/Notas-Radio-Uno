import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  timestamp,
  index,
  uniqueIndex,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { transmissions } from './transmissions.js';

/**
 * stream_recordings — la grabación cruda de una transmisión (PD-01).
 *
 * Una fila por transmisión (UNIQUE en transmission_id): el recorder del slice
 * siguiente la crea al arrancar la captura y va appendeando segmentos en
 * `recording_segments`. `storage_prefix` es la raíz dentro del RawStorage
 * (ej. `{tenantId}/{transmissionId}`) donde viven los archivos físicos.
 *
 * `start_ms`/`end_ms` de los segmentos son offsets wall-clock en milisegundos
 * relativos a `started_at` — así la ventana de un clip se resuelve con un
 * BETWEEN sobre start_ms sin tocar timestamps.
 */
export const streamRecordings = pgTable(
  'stream_recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => transmissions.id, { onDelete: 'cascade' }),
    storagePrefix: text('storage_prefix').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('recording'),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('stream_recordings_tenant_id_idx').on(t.tenantId),
    // 1 grabación por transmisión: el índice único ES el lookup por
    // transmission_id — no agregar un índice aparte.
    uniqueIndex('stream_recordings_transmission_id_idx').on(t.transmissionId),
  ],
);

/**
 * recording_segments — segmentos físicos (archivos) de una grabación.
 *
 * `sequence` ordena los segmentos dentro de la grabación (UNIQUE junto a
 * recording_id). `end_ms` queda NULL mientras el segmento sigue escribiendo.
 * `file_ref` es la clave relativa dentro del storage (ej. `seg-00001.mp4`).
 */
export const recordingSegments = pgTable(
  'recording_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => streamRecordings.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }),
    fileRef: text('file_ref').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('recording_segments_recording_id_sequence_unique').on(t.recordingId, t.sequence),
    index('recording_segments_tenant_id_idx').on(t.tenantId),
    index('recording_segments_recording_id_idx').on(t.recordingId),
    // Lookup de la ventana de clip: segmentos de una grabación ordenados por
    // offset de inicio.
    index('recording_segments_recording_id_start_ms_idx').on(t.recordingId, t.startMs),
  ],
);
