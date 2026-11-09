import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  primaryKey,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums.js';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { subscriptions } from './billing.js';
import { transmissions } from './transmissions.js';

// ── user_tenants — membresía usuario↔tenant con rol (multi-tenant-auth) ───────
export const membershipStatusValues = ['active', 'suspended'] as const;
export type MembershipStatus = (typeof membershipStatusValues)[number];

export const userTenants = pgTable(
  'user_tenants',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').notNull().default('viewer'),
    status: varchar('status', { length: 20 }).notNull().default('active').$type<MembershipStatus>(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tenantId] }),
    index('user_tenants_tenant_id_idx').on(t.tenantId),
  ],
);

// ── tenant_quotas — contadores por período YYYY-MM (TZ del tenant) ────────────
export const tenantQuotas = pgTable(
  'tenant_quotas',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    period: varchar('period', { length: 7 }).notNull(),
    transmissionsCount: integer('transmissions_count').notNull().default(0),
    pipelineHours: numeric('pipeline_hours', { precision: 10, scale: 2 }).notNull().default('0'),
    extraTransmissions: integer('extra_transmissions').notNull().default(0),
    storageMb: numeric('storage_mb', { precision: 10, scale: 2 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.period] }),
  ],
);

// ── quota_operations — idempotencia por operation_id (consume/release/grant) ──
export const quotaOperationKindValues = ['consume', 'release', 'grant'] as const;
export type QuotaOperationKind = (typeof quotaOperationKindValues)[number];

export const quotaOperations = pgTable(
  'quota_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationId: varchar('operation_id', { length: 120 }).notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    period: varchar('period', { length: 7 }).notNull(),
    kind: varchar('kind', { length: 10 }).notNull().$type<QuotaOperationKind>(),
    metric: varchar('metric', { length: 30 }).notNull().default('transmission'),
    delta: numeric('delta', { precision: 10, scale: 2 }).notNull(),
    resultingCount: numeric('resulting_count', { precision: 10, scale: 2 }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('quota_operations_operation_id_unique').on(t.operationId),
    index('quota_operations_tenant_id_period_idx').on(t.tenantId, t.period),
  ],
);

// ── billing_events — append-only, dedup webhooks por external_id ──────────────
export const billingEvents = pgTable(
  'billing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    type: varchar('type', { length: 40 }).notNull(),
    provider: varchar('provider', { length: 20 }),
    externalId: varchar('external_id', { length: 255 }),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('billing_events_external_id_unique').on(t.externalId),
    index('billing_events_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);

// ── tenant_features — overrides de flags por tenant ───────────────────────────
export const tenantFeatures = pgTable(
  'tenant_features',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 100 }).notNull(),
    value: jsonb('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.key] }),
  ],
);

// ── jobs_queue — cola Postgres con SKIP LOCKED + dead-letter ──────────────────
export const jobQueueStatusValues = ['pending', 'running', 'done', 'failed', 'dead'] as const;
export type JobQueueStatus = (typeof jobQueueStatusValues)[number];

export const jobsQueue = pgTable(
  'jobs_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 40 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 10 }).notNull().default('pending').$type<JobQueueStatus>(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: varchar('locked_by', { length: 60 }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    dedupKey: varchar('dedup_key', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('jobs_queue_dedup_key_unique').on(t.dedupKey),
    index('jobs_queue_status_run_at_idx').on(t.status, t.runAt),
    index('jobs_queue_tenant_id_status_idx').on(t.tenantId, t.status),
  ],
);

// ── ai_cost_records — métricas de costo IA por tenant/transmisión ─────────────
export const aiCostKindValues = ['video_analysis', 'transcription', 'image', 'text', 'face'] as const;
export type AiCostKind = (typeof aiCostKindValues)[number];

export const aiCostUnitValues = ['tokens', 'minutes', 'images', 'frames'] as const;
export type AiCostUnit = (typeof aiCostUnitValues)[number];

export const aiCostRecords = pgTable(
  'ai_cost_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id').references(() => transmissions.id, { onDelete: 'set null' }),
    provider: varchar('provider', { length: 30 }),
    kind: varchar('kind', { length: 30 }).$type<AiCostKind>(),
    units: numeric('units', { precision: 14, scale: 4 }),
    unit: varchar('unit', { length: 20 }).$type<AiCostUnit>(),
    costEstimateUsd: numeric('cost_estimate_usd', { precision: 10, scale: 5 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_cost_records_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
    index('ai_cost_records_transmission_id_idx').on(t.transmissionId),
  ],
);

// ── admin_impersonations — sesiones de impersonación (30 min) ─────────────────
export const adminImpersonations = pgTable(
  'admin_impersonations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('admin_impersonations_admin_user_id_idx').on(t.adminUserId),
    index('admin_impersonations_tenant_id_idx').on(t.tenantId),
  ],
);
