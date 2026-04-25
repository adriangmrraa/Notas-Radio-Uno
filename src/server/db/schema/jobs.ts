import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  numeric,
  date,
  index,
} from 'drizzle-orm/pg-core';
import { scheduleTypeEnum, jobExecutionStatusEnum } from './enums.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    createdById: uuid('created_by')
      .notNull()
      .references(() => users.id),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    streamUrl: text('stream_url').notNull(),
    scheduleType: scheduleTypeEnum('schedule_type').notNull(),
    daysOfWeek: integer('days_of_week').array().notNull().default([]),
    startTime: varchar('start_time', { length: 5 }).notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    timezone: varchar('timezone', { length: 50 }).notNull().default('America/Argentina/Buenos_Aires'),
    scheduledDate: date('scheduled_date'),
    pipelineConfig: jsonb('pipeline_config').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunStatus: varchar('last_run_status', { length: 20 }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    notifyOnComplete: boolean('notify_on_complete').notNull().default(true),
    notifyOnError: boolean('notify_on_error').notNull().default(true),
    notificationEmail: varchar('notification_email', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('scheduled_jobs_tenant_id_idx').on(t.tenantId),
    index('scheduled_jobs_next_run_at_is_active_idx').on(t.nextRunAt, t.isActive),
  ],
);

export const jobExecutions = pgTable(
  'job_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => scheduledJobs.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    status: jobExecutionStatusEnum('status').notNull().default('pending'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    publicationsGenerated: integer('publications_generated').notNull().default(0),
    transcriptionMinutes: numeric('transcription_minutes', { precision: 10, scale: 2 }).notNull().default('0'),
    topicsDetected: integer('topics_detected').notNull().default(0),
    errorMessage: text('error_message'),
    errorCount: integer('error_count').notNull().default(0),
    executionLog: jsonb('execution_log').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_executions_job_id_idx').on(t.jobId),
    index('job_executions_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);
