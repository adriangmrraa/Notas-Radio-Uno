import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  jsonb,
  date,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { programs } from './programs.js';
import { scheduledJobs } from './jobs.js';
import { persons } from './people.js';

// ── transmissions — una corrida de captura/transmisión ────────────────────────
export const transmissionSourceValues = ['live_capture', 'vod_upload', 'manual'] as const;
export type TransmissionSource = (typeof transmissionSourceValues)[number];

export const transmissionStatusValues = [
  'scheduled',
  'waiting',
  'live',
  'processing',
  'done',
  'error',
  'canceled',
] as const;
export type TransmissionStatus = (typeof transmissionStatusValues)[number];

export const transmissions = pgTable(
  'transmissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'set null' }),
    scheduledJobId: uuid('scheduled_job_id').references(() => scheduledJobs.id, { onDelete: 'set null' }),
    source: varchar('source', { length: 20 }).notNull().$type<TransmissionSource>(),
    status: varchar('status', { length: 20 }).notNull().default('scheduled').$type<TransmissionStatus>(),
    streamUrl: text('stream_url'),
    resolvedStreamUrl: text('resolved_stream_url'),
    crudoRef: text('crudo_ref'),
    durationMinutes: integer('duration_minutes'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    waitingSince: timestamp('waiting_since', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    operationId: varchar('operation_id', { length: 120 }),
    /** Config del audio-tap/pipeline para esta corrida (tono, estructura, autoPublish, segmentDuration…). Heredada del scheduled_job o del request manual. */
    pipelineConfig: jsonb('pipeline_config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('transmissions_tenant_status_idx').on(t.tenantId, t.status),
    index('transmissions_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);

// ── stream_recordings — 1 grabación por transmisión ───────────────────────────
export const streamRecordingStatusValues = ['recording', 'completed', 'error'] as const;
export type StreamRecordingStatus = (typeof streamRecordingStatusValues)[number];

export const streamRecordings = pgTable(
  'stream_recordings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transmissionId: uuid('transmission_id')
      .notNull()
      .unique()
      .references(() => transmissions.id, { onDelete: 'cascade' }),
    storagePrefix: text('storage_prefix').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('recording').$type<StreamRecordingStatus>(),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
);

// ── recording_segments — segmentos MP4 del crudo, wall-clock ──────────────────
export const recordingSegmentStatusValues = ['active', 'corrupt', 'purged'] as const;
export type RecordingSegmentStatus = (typeof recordingSegmentStatusValues)[number];

export const recordingSegments = pgTable(
  'recording_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => streamRecordings.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }),
    fileRef: text('file_ref').notNull(),
    bytes: bigint('bytes', { mode: 'number' }),
    status: varchar('status', { length: 20 }).notNull().default('active').$type<RecordingSegmentStatus>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('recording_segments_recording_id_sequence_unique').on(t.recordingId, t.sequence),
    index('recording_segments_recording_id_start_ms_idx').on(t.recordingId, t.startMs),
  ],
);

// ── transmission_segments — topics/moments/marks del pipeline ─────────────────
export const transmissionSegmentKindValues = ['topic', 'moment', 'mark'] as const;
export type TransmissionSegmentKind = (typeof transmissionSegmentKindValues)[number];

export const transmissionSegments = pgTable(
  'transmission_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => transmissions.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull().$type<TransmissionSegmentKind>(),
    title: text('title'),
    summary: text('summary'),
    startMs: bigint('start_ms', { mode: 'number' }),
    endMs: bigint('end_ms', { mode: 'number' }),
    speakers: jsonb('speakers'),
    score: numeric('score', { precision: 10, scale: 3 }),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transmission_segments_transmission_id_start_ms_idx').on(t.transmissionId, t.startMs),
    index('transmission_segments_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);

// ── person_appearances — apariciones de personas en la transmisión ────────────
export const appearanceSourceValues = ['face', 'fusion', 'manual'] as const;
export type AppearanceSource = (typeof appearanceSourceValues)[number];

export const personAppearances = pgTable(
  'person_appearances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transmissionId: uuid('transmission_id')
      .notNull()
      .references(() => transmissions.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => persons.id, { onDelete: 'set null' }),
    speakerLabel: varchar('speaker_label', { length: 10 }),
    source: varchar('source', { length: 10 }).notNull().$type<AppearanceSource>(),
    startMs: bigint('start_ms', { mode: 'number' }).notNull(),
    endMs: bigint('end_ms', { mode: 'number' }).notNull(),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    bbox: jsonb('bbox'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('person_appearances_transmission_id_idx').on(t.transmissionId),
    index('person_appearances_tenant_id_person_id_idx').on(t.tenantId, t.personId),
  ],
);

// ── person_transmission — invitado puntual por fecha/transmisión ──────────────
export const personTransmission = pgTable(
  'person_transmission',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id').references(() => transmissions.id, { onDelete: 'set null' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'set null' }),
    scheduledDate: date('scheduled_date'),
    role: varchar('role', { length: 20 }).notNull().default('guest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('person_transmission_tenant_id_scheduled_date_idx').on(t.tenantId, t.scheduledDate),
    index('person_transmission_tenant_id_transmission_id_idx').on(t.tenantId, t.transmissionId),
    uniqueIndex('person_transmission_person_id_transmission_id_unique')
      .on(t.personId, t.transmissionId)
      .where(sql`${t.transmissionId} is not null`),
  ],
);
