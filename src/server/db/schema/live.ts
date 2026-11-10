import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  real,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { transmissions } from './transmissions.js';
import { persons } from './persons.js';
import { clips } from './clips.js';

/**
 * transcript_segments — utterances de la transcripción en vivo (PD-05).
 *
 * Es la fuente del timeline de la Sala "En vivo" y la tabla que la Épica E
 * (motor de análisis) alimenta a medida que transcribe/diariza. Los offsets
 * `start_ms`/`end_ms` son milisegundos relativos a `transmissions.started_at`
 * — la misma convención wall-clock que `recording_segments`.
 *
 * `person_id` queda NULL hasta que la atribución resuelve al speaker contra
 * `persons`; sin atribución la sala muestra `speaker_label` genérico
 * ("Speaker A") — degradado, nunca error.
 */
export const transcriptSegments = pgTable(
  'transcript_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => transmissions.id, { onDelete: 'cascade' }),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }).notNull(),
    speakerLabel: varchar('speaker_label', { length: 80 }),
    personId: uuid('person_id').references(() => persons.id, {
      onDelete: 'set null',
    }),
    text: text('text').notNull(),
    confidence: real('confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transcript_segments_tenant_id_idx').on(t.tenantId),
    // Timeline de la sala: utterances de UNA transmisión ordenadas por offset.
    index('transcript_segments_transmission_id_start_ms_idx').on(
      t.transmissionId,
      t.startMs,
    ),
    index('transcript_segments_person_id_idx').on(t.personId),
  ],
);

/**
 * transmission_moments — momentos relevantes de una transmisión (PD-05).
 *
 * `kind`:
 *   - 'detected' → lo inserta el motor de análisis (Épica E) con `score`/`reason`.
 *   - 'mark'     → mark manual del editor desde la Sala "En vivo"; con
 *                  `clip_id` es el mark que disparó un clip, sin `clip_id` es
 *                  una nota de bloque.
 *
 * `clip_id` vincula el mark al clip generado (SET NULL: borrar el clip no
 * borra el mark histórico). Los `start_ms`/`end_ms` comparten la convención
 * de offsets relativos a `transmissions.started_at`.
 */
export const transmissionMoments = pgTable(
  'transmission_moments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => transmissions.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull().default('detected'),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }).notNull(),
    title: text('title'),
    reason: text('reason'),
    score: real('score'),
    clipId: uuid('clip_id').references(() => clips.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transmission_moments_tenant_id_idx').on(t.tenantId),
    index('transmission_moments_transmission_id_start_ms_idx').on(
      t.transmissionId,
      t.startMs,
    ),
  ],
);

/**
 * transmission_segments — segmentos editoriales de una transmisión (PE-06).
 *
 * Distinta de `transcript_segments` (utterances crudos, uno por frase
 * diarizada): un segmento es una UNIDAD TEMÁTICA que el motor de análisis
 * (PE-02) produce al agrupar la transcripción — tema, resumen, speakers
 * presentes y ventana temporal. `transmission_moments` tampoco es lo mismo:
 * son puntos clipables/marks, no el relato segmentado completo.
 *
 * `speakers` es jsonb `{ label: string; personId?: string | null }[]`:
 * los speaker labels del segmento con su resolución de identidad cuando ya
 * exista (PE-03 la escribe; `personId` null = speaker sin atribuir).
 * `start_ms`/`end_ms` comparten la convención de offsets relativos a
 * `transmissions.started_at`.
 */
export interface TransmissionSegmentSpeaker {
  label: string;
  personId?: string | null;
}

export const transmissionSegments = pgTable(
  'transmission_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => transmissions.id, { onDelete: 'cascade' }),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }).notNull(),
    topic: varchar('topic', { length: 200 }),
    summary: text('summary'),
    speakers: jsonb('speakers')
      .$type<TransmissionSegmentSpeaker[]>()
      .notNull()
      .default([]),
    confidence: real('confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transmission_segments_tenant_id_idx').on(t.tenantId),
    // Timeline editorial: segmentos de UNA transmisión ordenados por offset.
    index('transmission_segments_transmission_id_start_ms_idx').on(
      t.transmissionId,
      t.startMs,
    ),
  ],
);
