import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { featureSourceEnum } from './enums.js';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { plans } from './billing.js';

/**
 * tenant_features — Feature flags efectivos por tenant.
 *
 * Cada fila representa el valor EFECTIVO de un flag para un tenant, no el
 * catálogo global. El catálogo de flags vive en `tenantFeaturesService.ts`.
 *
 * Reglas:
 *  - `source = 'plan'`     → la fila se recalcula cuando el tenant cambia de plan.
 *  - `source = 'override'` → la pisó el owner del tenant; un cambio de plan NO la toca.
 *  - `source = 'admin'`    → la pisó un super admin; tampoco se toca por cambio de plan.
 *
 * `plan_default_enabled` guarda el valor que el plan otorga, para poder mostrar
 * en la UI "esto viene del plan" y para restaurar el default al quitar el override.
 */
export const tenantFeatures = pgTable(
  'tenant_features',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    featureKey: varchar('feature_key', { length: 64 }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    limitValue: integer('limit_value'),
    source: featureSourceEnum('source').notNull().default('plan'),
    planId: uuid('plan_id').references(() => plans.id, { onDelete: 'set null' }),
    planDefaultEnabled: boolean('plan_default_enabled').notNull().default(false),
    overriddenByUserId: uuid('overridden_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    overriddenAt: timestamp('overridden_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('tenant_features_tenant_id_feature_key_unique').on(t.tenantId, t.featureKey),
    index('tenant_features_tenant_id_idx').on(t.tenantId),
    index('tenant_features_feature_key_idx').on(t.featureKey),
  ],
);

/**
 * impersonation_sessions — Sesiones auditadas de "ver como" de un super admin.
 *
 * El access token de impersonación es un JWT de vida corta (30 min) con el claim
 * `imp` = id de esta fila. Cada request que lo usa deja rastro en `audit_log`.
 */
export const impersonationSessions = pgTable(
  'impersonation_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    impersonatedUserId: uuid('impersonated_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    index('impersonation_sessions_tenant_id_idx').on(t.tenantId),
    index('impersonation_sessions_admin_user_id_idx').on(t.adminUserId),
    index('impersonation_sessions_expires_at_idx').on(t.expiresAt),
  ],
);
