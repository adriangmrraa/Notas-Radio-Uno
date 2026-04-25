import { pgTable, uuid, varchar, text, boolean, timestamp, date, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { programs } from './programs.js';
import { bytea } from './customTypes.js';

export const guests = pgTable(
  'guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    role: varchar('role', { length: 100 }).notNull(),
    bio: text('bio'),
    scheduledDate: date('scheduled_date').notNull(),
    scheduledTimeStart: varchar('scheduled_time_start', { length: 5 }),
    scheduledTimeEnd: varchar('scheduled_time_end', { length: 5 }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('guests_tenant_id_idx').on(t.tenantId),
    index('guests_program_id_idx').on(t.programId),
    index('guests_tenant_program_date_idx').on(t.tenantId, t.programId, t.scheduledDate),
  ],
);

export const guestPhotos = pgTable(
  'guest_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guestId: uuid('guest_id')
      .notNull()
      .references(() => guests.id, { onDelete: 'cascade' }),
    photoData: bytea('photo_data').notNull(),
    mimeType: varchar('mime_type', { length: 20 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('guest_photos_guest_id_idx').on(t.guestId),
  ],
);
