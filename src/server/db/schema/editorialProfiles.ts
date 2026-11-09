import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { programs } from './programs.js';

/**
 * editorial_profiles — línea editorial del canal.
 *
 * `program_id = null` es el perfil del tenant (default). Una fila con
 * `program_id` no nula es el override de ese programa y gana campo a campo
 * sobre el default (ver editorialService).
 */
export const editorialProfiles = pgTable(
  'editorial_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 120 }),
    /** formal | informal | urgente | analitico | custom */
    tone: varchar('tone', { length: 40 }).notNull().default('formal'),
    toneDescription: text('tone_description'),
    styleGuide: text('style_guide'),
    /** Reglas duras: string[] (ej. "Nunca nombrar menores"). */
    rules: jsonb('rules').notNull().default([]),
    /** Ejemplos de referencia: [{ title, excerpt }]. */
    examples: jsonb('examples').notNull().default([]),
    industry: varchar('industry', { length: 80 }),
    /** Formatos activos: string[] (flash, corta, completa, cronica, twitter, ...). */
    activeFormats: jsonb('active_formats').notNull().default([]),
    /** Temas prohibidos / a evitar: string[]. */
    forbiddenTopics: jsonb('forbidden_topics').notNull().default([]),
    /** Firma o cierre característico del canal. */
    signature: text('signature'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('editorial_profiles_tenant_program_unique').on(t.tenantId, t.programId),
    uniqueIndex('editorial_profiles_tenant_default_unique')
      .on(t.tenantId)
      .where(sql`${t.programId} is null`),
    index('editorial_profiles_tenant_id_idx').on(t.tenantId),
    index('editorial_profiles_program_id_idx').on(t.programId),
  ],
);
