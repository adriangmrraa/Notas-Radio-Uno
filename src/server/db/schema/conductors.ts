import { pgTable, uuid, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { programs } from './programs.js';
import { bytea } from './customTypes.js';

export const conductors = pgTable(
  'conductors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    role: varchar('role', { length: 100 }),
    bio: text('bio'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('conductors_tenant_id_idx').on(t.tenantId),
    index('conductors_program_id_idx').on(t.programId),
  ],
);

export const conductorPhotos = pgTable(
  'conductor_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conductorId: uuid('conductor_id')
      .notNull()
      .references(() => conductors.id, { onDelete: 'cascade' }),
    photoData: bytea('photo_data').notNull(),
    mimeType: varchar('mime_type', { length: 20 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conductor_photos_conductor_id_idx').on(t.conductorId),
  ],
);
