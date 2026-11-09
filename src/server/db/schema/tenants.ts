import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb } from 'drizzle-orm/pg-core';
// timestamp imported for suspended_at/onboarding columns below
import { bytea } from './customTypes.js';

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  ownerId: uuid('owner_id'),
  platformName: varchar('platform_name', { length: 255 }),
  logoUrl: text('logo_url'),
  logoData: bytea('logo_data'),
  logoMimeType: varchar('logo_mime_type', { length: 20 }),
  fontFamily: varchar('font_family', { length: 30 }).notNull().default('bebas_kai'),
  templateId: varchar('template_id', { length: 30 }).notNull().default('dark_gradient'),
  timezone: varchar('timezone', { length: 50 }).notNull().default('America/Argentina/Buenos_Aires'),
  config: jsonb('config').notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspensionReason: text('suspension_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
});
