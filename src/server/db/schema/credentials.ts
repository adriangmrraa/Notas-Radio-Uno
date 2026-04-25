import { pgTable, uuid, varchar, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    value: varchar('value').notNull(),
    category: varchar('category', { length: 50 }).notNull(),
    isValid: boolean('is_valid').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    unique('credentials_tenant_id_name_unique').on(t.tenantId, t.name),
    index('credentials_tenant_id_idx').on(t.tenantId),
    index('credentials_tenant_id_category_idx').on(t.tenantId, t.category),
  ],
);
