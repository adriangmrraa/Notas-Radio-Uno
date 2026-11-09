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
  bigint,
  date,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import {
  subscriptionStatusEnum,
  invoiceStatusEnum,
  usageCycleStatusEnum,
  quotaOperationStatusEnum,
  addonPurchaseStatusEnum,
} from './enums.js';
import { tenants } from './tenants.js';

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 50 }).notNull().unique(),
  displayName: varchar('display_name', { length: 100 }).notNull(),
  description: text('description'),
  priceUsd: numeric('price_usd', { precision: 10, scale: 2 }).notNull().default('0'),
  priceUsdYearly: numeric('price_usd_yearly', { precision: 10, scale: 2 }),
  priceArs: numeric('price_ars', { precision: 10, scale: 2 }),
  priceArsYearly: numeric('price_ars_yearly', { precision: 10, scale: 2 }),
  stripePriceIdMonthly: varchar('stripe_price_id_monthly', { length: 255 }),
  stripePriceIdYearly: varchar('stripe_price_id_yearly', { length: 255 }),
  mpPlanIdMonthly: varchar('mp_plan_id_monthly', { length: 255 }),
  mpPlanIdYearly: varchar('mp_plan_id_yearly', { length: 255 }),
  // ── Modelo por transmisiones (Épica B) ─────────────────────────────────────
  /** Transmisiones incluidas por ciclo. NULL = ilimitado (enterprise). */
  transmissionsPerCycle: integer('transmissions_per_cycle'),
  /** Duración máxima de una transmisión, en minutos. */
  maxTransmissionMinutes: integer('max_transmission_minutes'),
  /** Máximo de clips generables por transmisión. */
  maxClipsPerTransmission: integer('max_clips_per_transmission'),
  /** Máximo de personas en la biblioteca del tenant. */
  maxPeople: integer('max_people'),
  /** Días de retención del material crudo capturado. */
  rawRetentionDays: integer('raw_retention_days'),
  maxPipelineHoursPerMonth: integer('max_pipeline_hours_per_month'),
  maxPublicationsPerMonth: integer('max_publications_per_month'),
  maxScheduledJobs: integer('max_scheduled_jobs'),
  maxCustomAgents: integer('max_custom_agents'),
  maxTeamMembers: integer('max_team_members').notNull().default(1),
  maxConnectedPlatforms: integer('max_connected_platforms'),
  maxStorageGb: integer('max_storage_gb').notNull().default(5),
  features: jsonb('features').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatusEnum('status').notNull().default('trialing'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    billingPeriod: varchar('billing_period', { length: 20 }).default('monthly'),
    paymentProvider: varchar('payment_provider', { length: 20 }),
    externalSubscriptionId: varchar('external_subscription_id', { length: 255 }),
    externalCustomerId: varchar('external_customer_id', { length: 255 }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    // ── Dunning y gracia (Épica B) ──────────────────────────────────────────
    /** Primer fallo de pago del ciclo de dunning actual. */
    pastDueSince: timestamp('past_due_since', { withTimezone: true }),
    /** Fin del período de gracia: el servicio sigue activo hasta esta fecha. */
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }),
    dunningAttempts: integer('dunning_attempts').notNull().default(0),
    lastDunningAt: timestamp('last_dunning_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    /** Transmisiones que incluye el trial (default 2; un admin puede extenderlo). */
    trialTransmissionsIncluded: integer('trial_transmissions_included').notNull().default(2),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('subscriptions_status_idx').on(t.status),
    index('subscriptions_external_subscription_id_idx').on(t.externalSubscriptionId),
  ],
);

export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    pipelineHoursUsed: numeric('pipeline_hours_used', { precision: 10, scale: 2 }).notNull().default('0'),
    publicationsCount: integer('publications_count').notNull().default(0),
    transcriptionMinutes: numeric('transcription_minutes', { precision: 10, scale: 2 }).notNull().default('0'),
    aiTokensUsed: bigint('ai_tokens_used', { mode: 'number' }).notNull().default(0),
    storageUsedMb: numeric('storage_used_mb', { precision: 10, scale: 2 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [unique('usage_records_tenant_id_period_start_unique').on(t.tenantId, t.periodStart)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    planName: varchar('plan_name', { length: 100 }),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    status: invoiceStatusEnum('status').notNull().default('pending'),
    paymentProvider: varchar('payment_provider', { length: 20 }),
    externalInvoiceId: varchar('external_invoice_id', { length: 255 }),
    externalPaymentId: varchar('external_payment_id', { length: 255 }),
    billingPeriodStart: timestamp('billing_period_start', { withTimezone: true }),
    billingPeriodEnd: timestamp('billing_period_end', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('invoices_tenant_id_created_at_idx').on(t.tenantId, t.createdAt)],
);

/**
 * usage_cycles — Ciclo de medición de transmisiones por tenant.
 * Una fila por período de facturación (o mes calendario si el tenant no tiene
 * suscripción con períodos). Los add-ons comprados viven en `addonTransmissions`
 * y EXPIRAN SOLOS: el ciclo siguiente arranca en 0.
 */
export const usageCycles = pgTable(
  'usage_cycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    includedTransmissions: integer('included_transmissions').notNull().default(0),
    addonTransmissions: integer('addon_transmissions').notNull().default(0),
    transmissionsUsed: integer('transmissions_used').notNull().default(0),
    status: usageCycleStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('usage_cycles_tenant_id_period_start_unique').on(t.tenantId, t.periodStart),
    index('usage_cycles_tenant_id_status_idx').on(t.tenantId, t.status),
  ],
);

/**
 * quota_operations — Operaciones de cuota, con idempotencia por
 * (tenant_id, operation_id). Un `consumed` descuenta; un `released` devuelve
 * (arranque fallido dentro de la ventana u operación stale liberada).
 */
export const quotaOperations = pgTable(
  'quota_operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    usageCycleId: uuid('usage_cycle_id').references(() => usageCycles.id, { onDelete: 'cascade' }),
    operationId: varchar('operation_id', { length: 120 }).notNull(),
    kind: varchar('kind', { length: 40 }).notNull().default('transmission_start'),
    status: quotaOperationStatusEnum('status').notNull().default('consumed'),
    transmissionRef: varchar('transmission_ref', { length: 160 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: varchar('release_reason', { length: 40 }),
  },
  (t) => [
    unique('quota_operations_tenant_id_operation_id_unique').on(t.tenantId, t.operationId),
    index('quota_operations_tenant_id_status_idx').on(t.tenantId, t.status),
  ],
);

/** Catálogo de add-ons comprables (hoy sólo transmisiones sueltas). */
export const planAddons = pgTable('plan_addons', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: varchar('kind', { length: 40 }).notNull().default('transmissions'),
  name: varchar('name', { length: 40 }).notNull().unique(),
  transmissions: integer('transmissions').notNull(),
  priceUsd: numeric('price_usd', { precision: 10, scale: 2 }).notNull(),
  priceArs: numeric('price_ars', { precision: 10, scale: 2 }),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  mpPreferencePlanId: varchar('mp_preference_plan_id', { length: 255 }),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * addon_purchases — Compras de add-ons. Idempotentes por (provider, external_id):
 * el webhook que confirma el pago aplica la compra una sola vez.
 */
export const addonPurchases = pgTable(
  'addon_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    usageCycleId: uuid('usage_cycle_id').references(() => usageCycles.id, { onDelete: 'set null' }),
    addonId: uuid('addon_id')
      .notNull()
      .references(() => planAddons.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull().default(1),
    transmissionsGranted: integer('transmissions_granted').notNull(),
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    provider: varchar('provider', { length: 20 }),
    externalId: varchar('external_id', { length: 255 }),
    status: addonPurchaseStatusEnum('status').notNull().default('pending'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    /** Fin del ciclo en el que se compró: el add-on expira con el ciclo. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('addon_purchases_provider_external_id_unique').on(t.provider, t.externalId),
    index('addon_purchases_tenant_id_idx').on(t.tenantId),
  ],
);

/**
 * billing_events — Eventos de facturación append-only. También actúa de tabla
 * de dedupe para webhooks: (provider, external_event_id) es único y el insert
 * previo al procesamiento hace que un reintento no reprocese.
 */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Nullable: el dedupe del webhook corre ANTES de resolver el tenant. */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 60 }).notNull(),
    provider: varchar('provider', { length: 20 }),
    externalEventId: varchar('external_event_id', { length: 255 }),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('billing_events_provider_external_event_id_unique').on(t.provider, t.externalEventId),
    index('billing_events_tenant_id_idx').on(t.tenantId),
  ],
);
