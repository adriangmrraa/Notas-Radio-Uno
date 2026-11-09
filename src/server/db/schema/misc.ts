import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  bigint,
  integer,
  numeric,
  date,
  primaryKey,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userRoleEnum, invitationStatusEnum } from './enums.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// ── Setting — composite PK (tenant_id, key) ───────────────────────────────────
export const settings = pgTable(
  'settings',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 100 }).notNull(),
    value: text('value'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

// ── Notification ──────────────────────────────────────────────────────────────
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id'),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    message: text('message'),
    icon: varchar('icon', { length: 10 }),
    metadata: jsonb('metadata').notNull().default({}),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
    index('notifications_tenant_id_is_read_idx').on(t.tenantId, t.isRead),
  ],
);

// ── AuditLog ──────────────────────────────────────────────────────────────────
// `audit_log` es el nombre físico histórico (migración 0000) y se mantiene para
// no reescribir una tabla ya desplegada. Registra acciones sensibles:
// login, publish, cambios de admin/billing, impersonación, etc.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(),
    /** Rol del actor al momento de la acción (owner/editor/viewer/platform_admin). */
    actorRole: varchar('actor_role', { length: 20 }),
    actorEmail: varchar('actor_email', { length: 255 }),
    /** Entidad afectada, para poder reconstruir "qué se tocó". */
    entityType: varchar('entity_type', { length: 60 }),
    entityId: varchar('entity_id', { length: 100 }),
    /** success | denied | error */
    outcome: varchar('outcome', { length: 20 }).notNull().default('success'),
    /** Super admin que estaba impersonando al actor, si aplica. */
    impersonatedByUserId: uuid('impersonated_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tenant_id_idx').on(t.tenantId),
    index('audit_log_created_at_idx').on(t.createdAt),
    index('audit_log_tenant_id_action_created_at_idx').on(t.tenantId, t.action, t.createdAt),
    index('audit_log_user_id_idx').on(t.userId),
  ],
);

// ── DailyMetric ───────────────────────────────────────────────────────────────
export const dailyMetrics = pgTable(
  'daily_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    metricDate: date('metric_date').notNull(),
    pipelineRuns: integer('pipeline_runs').notNull().default(0),
    pipelineMinutes: numeric('pipeline_minutes', { precision: 10, scale: 2 }).notNull().default('0'),
    scheduledRuns: integer('scheduled_runs').notNull().default(0),
    scheduledMinutes: numeric('scheduled_minutes', { precision: 10, scale: 2 }).notNull().default('0'),
    publicationsGenerated: integer('publications_generated').notNull().default(0),
    publicationsAuto: integer('publications_auto').notNull().default(0),
    publicationsManual: integer('publications_manual').notNull().default(0),
    publicationsScheduled: integer('publications_scheduled').notNull().default(0),
    transcriptionChunks: integer('transcription_chunks').notNull().default(0),
    transcriptionMinutes: numeric('transcription_minutes', { precision: 10, scale: 2 }).notNull().default('0'),
    topicsDetected: integer('topics_detected').notNull().default(0),
    aiTokensUsed: bigint('ai_tokens_used', { mode: 'number' }).notNull().default(0),
    agentsExecuted: integer('agents_executed').notNull().default(0),
    twitterPosts: integer('twitter_posts').notNull().default(0),
    facebookPosts: integer('facebook_posts').notNull().default(0),
    instagramPosts: integer('instagram_posts').notNull().default(0),
    webhookCalls: integer('webhook_calls').notNull().default(0),
    pipelineErrors: integer('pipeline_errors').notNull().default(0),
    publishErrors: integer('publish_errors').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('daily_metrics_tenant_id_metric_date_unique').on(t.tenantId, t.metricDate),
    index('daily_metrics_tenant_id_metric_date_idx').on(t.tenantId, t.metricDate),
  ],
);

// ── TeamInvitation ────────────────────────────────────────────────────────────
// `team_invitations` es el nombre físico histórico; cumple el rol de `team_invites`.
// Un invite nace `pending`, expira a las 72 h y puede revocarse o reenviarse.
export const teamInvitations = pgTable(
  'team_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    invitedById: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    email: varchar('email', { length: 255 }).notNull(),
    role: userRoleEnum('role').notNull().default('editor'),
    token: uuid('token').notNull().defaultRandom(),
    status: invitationStatusEnum('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** Usuario creado al aceptar la invitación. */
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Último envío del mail (para reenvíos y rate limit). */
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('team_invitations_token_idx').on(t.token),
    index('team_invitations_tenant_id_idx').on(t.tenantId),
    index('team_invitations_tenant_id_status_idx').on(t.tenantId, t.status),
    // Un solo invite pendiente por email dentro del tenant.
    uniqueIndex('team_invitations_tenant_id_email_pending_unique')
      .on(t.tenantId, t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);

// ── RefreshToken ──────────────────────────────────────────────────────────────
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    isRevoked: boolean('is_revoked').notNull().default(false),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_token_hash_idx').on(t.tokenHash),
  ],
);
