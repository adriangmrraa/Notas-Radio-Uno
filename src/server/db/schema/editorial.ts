import { pgTable, uuid, varchar, text, integer, timestamp, jsonb, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';

// ── editorial_profiles — perfil editorial por tenant (1:1) ────────────────────
export const approvalPolicyValues = ['review', 'auto'] as const;
export type ApprovalPolicy = (typeof approvalPolicyValues)[number];

export const editorialProfiles = pgTable(
  'editorial_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    tone: varchar('tone', { length: 30 }),
    toneExamples: jsonb('tone_examples').notNull().default([]),
    rules: jsonb('rules').notNull().default({}),
    rubro: varchar('rubro', { length: 50 }),
    audience: text('audience'),
    activeFormats: jsonb('active_formats').notNull().default({}),
    approvalPolicy: varchar('approval_policy', { length: 10 })
      .notNull()
      .default('review')
      .$type<ApprovalPolicy>(),
    defaultImageModel: varchar('default_image_model', { length: 50 }),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('editorial_profiles_tenant_id_idx').on(t.tenantId),
  ],
);

// ── editorial_profile_versions — historial append-only del perfil ─────────────
export const editorialProfileVersions = pgTable(
  'editorial_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => editorialProfiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('editorial_profile_versions_profile_id_version_unique').on(t.profileId, t.version),
  ],
);
