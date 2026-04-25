import { pgTable, uuid, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const programUrlTypeValues = ['youtube', 'facebook', 'kick', 'twitch', 'radio_stream', 'website', 'other'] as const;

export const programs = pgTable(
  'programs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    schedule: varchar('schedule', { length: 255 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('programs_tenant_id_idx').on(t.tenantId),
  ],
);

export const programUrls = pgTable(
  'program_urls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 30 }).notNull(),
    url: text('url').notNull(),
    label: varchar('label', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('program_urls_program_id_idx').on(t.programId),
  ],
);
