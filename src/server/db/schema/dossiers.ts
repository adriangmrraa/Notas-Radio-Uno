import { pgTable, uuid, varchar, text, timestamp, date, index, jsonb } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { programs } from './programs.js';
import { guests } from './guests.js';

export const guestDossiers = pgTable(
  'guest_dossiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guestId: uuid('guest_id')
      .notNull()
      .references(() => guests.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    guestName: varchar('guest_name', { length: 200 }).notNull(),
    scheduledDate: date('scheduled_date').notNull(),
    content: jsonb('content'),
    status: varchar('status', { length: 30 }).notNull().default('generating'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('guest_dossiers_guest_id_idx').on(t.guestId),
    index('guest_dossiers_tenant_id_idx').on(t.tenantId),
    index('guest_dossiers_program_date_idx').on(t.programId, t.scheduledDate),
  ],
);
