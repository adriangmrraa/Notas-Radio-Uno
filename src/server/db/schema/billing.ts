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
import { subscriptionStatusEnum, invoiceStatusEnum } from './enums.js';
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
