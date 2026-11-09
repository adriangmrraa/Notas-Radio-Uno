import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { transmissionSourceEnum, transmissionStatusEnum } from './enums.js';
import { tenants } from './tenants.js';
import { programs } from './programs.js';

// ── transmissions — una corrida/estado de una transmisión ─────────────────────
export const transmissions = pgTable(
  'transmissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'set null' }),
    scheduledTransmissionId: uuid('scheduled_transmission_id').references(
      (): AnyPgColumn => scheduledTransmissions.id,
      { onDelete: 'set null' },
    ),
    source: transmissionSourceEnum('source').notNull(),
    status: transmissionStatusEnum('status').notNull().default('scheduled'),
    streamUrl: text('stream_url'),
    resolvedStreamUrl: text('resolved_stream_url'),
    crudoRef: text('crudo_ref'),
    durationMinutes: integer('duration_minutes'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    waitingSince: timestamp('waiting_since', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    pipelineConfig: jsonb('pipeline_config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('transmissions_tenant_status_idx').on(t.tenantId, t.status),
    index('transmissions_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
    index('transmissions_program_id_idx').on(t.programId),
    index('transmissions_scheduled_transmission_id_idx').on(t.scheduledTransmissionId),
  ],
);

// ── scheduled_transmissions — la agenda (recurrencia RRULE) ───────────────────
export const scheduledTransmissions = pgTable(
  'scheduled_transmissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    streamUrl: text('stream_url').notNull(),
    // Recurrencia iCalendar/RFC 5545, p.ej. 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0'.
    rrule: varchar('rrule', { length: 255 }).notNull(),
    // IANA: "qué día es hoy" se compara en ESTA zona, no en la del server.
    timezone: varchar('timezone', { length: 64 }).notNull().default('America/Argentina/Buenos_Aires'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    durationMinutes: integer('duration_minutes').notNull().default(60),
    autoStart: boolean('auto_start').notNull().default(true),
    pipelineConfig: jsonb('pipeline_config').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastTransmissionId: uuid('last_transmission_id').references(
      (): AnyPgColumn => transmissions.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('scheduled_transmissions_tenant_is_active_idx').on(t.tenantId, t.isActive),
    index('scheduled_transmissions_tenant_next_run_at_idx').on(t.tenantId, t.nextRunAt),
    index('scheduled_transmissions_program_id_idx').on(t.programId),
    index('scheduled_transmissions_last_transmission_id_idx').on(t.lastTransmissionId),
  ],
);
