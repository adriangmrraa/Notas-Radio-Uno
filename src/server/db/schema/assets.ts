import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  jsonb,
  primaryKey,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { programs } from './programs.js';
import { transmissions } from './transmissions.js';
import { persons } from './people.js';
import { socialPortfolios } from './social.js';

// ── assets — modelo unificado de contenido derivado ───────────────────────────
export const assetTypeValues = ['clip', 'nota', 'flyer', 'quote_card', 'post'] as const;
export type AssetType = (typeof assetTypeValues)[number];

export const assetStatusValues = [
  'generating',
  'ready',
  'pending_review',
  'approved',
  'rejected',
  'published',
  'failed',
] as const;
export type AssetStatus = (typeof assetStatusValues)[number];

export const assetSourceValues = ['footage', 'synthetic'] as const;
export type AssetSource = (typeof assetSourceValues)[number];

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 15 }).notNull().$type<AssetType>(),
    status: varchar('status', { length: 20 }).notNull().default('generating').$type<AssetStatus>(),
    source: varchar('source', { length: 10 }).notNull().default('footage').$type<AssetSource>(),
    title: varchar('title', { length: 255 }),
    content: text('content'),
    mediaRefs: jsonb('media_refs').notNull().default({}),
    transmissionId: uuid('transmission_id').references(() => transmissions.id, { onDelete: 'set null' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'set null' }),
    sourceWindow: jsonb('source_window'),
    quotes: jsonb('quotes'),
    contentVariants: jsonb('content_variants'),
    editHistory: jsonb('edit_history').notNull().default([]),
    profileVersion: integer('profile_version'),
    deliveryStatus: jsonb('delivery_status').notNull().default({}),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    legacyRef: jsonb('legacy_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('assets_tenant_id_status_idx').on(t.tenantId, t.status),
    index('assets_tenant_id_type_idx').on(t.tenantId, t.type),
    index('assets_transmission_id_idx').on(t.transmissionId),
  ],
);

// ── asset_persons — personas atribuidas/mencionadas en el asset ───────────────
export const assetPersonRoleValues = ['speaker', 'mentioned', 'cited'] as const;
export type AssetPersonRole = (typeof assetPersonRoleValues)[number];

export const assetPersons = pgTable(
  'asset_persons',
  {
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 10 }).notNull().$type<AssetPersonRole>(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.personId, t.role] }),
    index('asset_persons_person_id_idx').on(t.personId),
  ],
);

// ── social_connections — conexiones de publicación unificadas ─────────────────
export const socialConnectionProviderValues = [
  'zernio',
  'meta_legacy',
  'twitter_legacy',
  'webhook',
  'drive',
] as const;
export type SocialConnectionProvider = (typeof socialConnectionProviderValues)[number];

export const socialConnections = pgTable(
  'social_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 15 }).notNull().$type<SocialConnectionProvider>(),
    platform: varchar('platform', { length: 30 }).notNull(),
    externalAccountId: varchar('external_account_id', { length: 255 }),
    portfolioId: uuid('portfolio_id').references(() => socialPortfolios.id, { onDelete: 'set null' }),
    displayName: varchar('display_name', { length: 255 }),
    metadata: jsonb('metadata').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('social_connections_tenant_provider_platform_account_unique').on(
      t.tenantId,
      t.provider,
      t.platform,
      t.externalAccountId,
    ),
    index('social_connections_tenant_id_idx').on(t.tenantId),
  ],
);

// ── publish_jobs — una entrega de asset por conexión ──────────────────────────
export const publishJobStatusValues = ['queued', 'sending', 'published', 'failed'] as const;
export type PublishJobStatus = (typeof publishJobStatusValues)[number];

export const publishJobs = pgTable(
  'publish_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    socialConnectionId: uuid('social_connection_id')
      .notNull()
      .references(() => socialConnections.id),
    payload: jsonb('payload').notNull().default({}),
    status: varchar('status', { length: 10 }).notNull().default('queued').$type<PublishJobStatus>(),
    attempts: integer('attempts').notNull().default(0),
    externalPostId: varchar('external_post_id', { length: 255 }),
    lastError: text('last_error'),
    dedupKey: varchar('dedup_key', { length: 160 }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('publish_jobs_dedup_key_unique').on(t.dedupKey),
    index('publish_jobs_status_idx').on(t.status),
    index('publish_jobs_asset_id_idx').on(t.assetId),
  ],
);

// ── image_models — catálogo global de modelos de imagen ───────────────────────
export const imageModels = pgTable(
  'image_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: varchar('key', { length: 50 }).notNull(),
    provider: varchar('provider', { length: 30 }),
    displayName: varchar('display_name', { length: 100 }),
    capabilities: jsonb('capabilities'),
    costPerImage: numeric('cost_per_image', { precision: 10, scale: 5 }),
    isEnabled: boolean('is_enabled').notNull().default(true),
    planGating: jsonb('plan_gating'),
    sortOrder: integer('sort_order'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('image_models_key_unique').on(t.key),
  ],
);
