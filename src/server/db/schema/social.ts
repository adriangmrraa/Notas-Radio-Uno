import { pgTable, uuid, varchar, boolean, integer, timestamp, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const socialPortfolios = pgTable(
  'social_portfolios',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('social_portfolios_tenant_id_name_unique').on(t.tenantId, t.name),
    index('social_portfolios_tenant_id_idx').on(t.tenantId),
  ],
);

export const businessAssets = pgTable(
  'business_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    portfolioId: uuid('portfolio_id').references(() => socialPortfolios.id, { onDelete: 'set null' }),
    assetType: varchar('asset_type', { length: 50 }).notNull(),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    name: varchar('name', { length: 255 }),
    metadata: jsonb('metadata').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('business_assets_tenant_id_external_id_unique').on(t.tenantId, t.externalId),
    index('business_assets_tenant_id_idx').on(t.tenantId),
    index('business_assets_tenant_id_asset_type_idx').on(t.tenantId, t.assetType),
    index('business_assets_portfolio_id_idx').on(t.portfolioId),
  ],
);
