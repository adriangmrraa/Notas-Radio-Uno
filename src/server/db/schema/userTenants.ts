import { pgTable, uuid, varchar, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';
import { userRoleEnum } from './enums.js';
import { users } from './users.js';
import { tenants } from './tenants.js';

/**
 * user_tenants — membresía N:M usuario ↔ tenant (decisión B-2).
 *
 * Un mismo usuario puede ser owner del tenant A y viewer del tenant B: el rol
 * efectivo es SIEMPRE el de la membresía del tenant activo de la sesión, nunca
 * un rol global en `users`. `users.tenant_id` queda como legacy (primer tenant)
 * y `users.role` / `users.status` como datos históricos de la cuenta.
 *
 * `status`: 'active' | 'suspended'. Suspender una membresía corta el acceso a
 * ESE tenant en el siguiente request, sin tocar la cuenta (que puede seguir
 * operando en otros tenants).
 */
export const userTenants = pgTable(
  'user_tenants',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').notNull().default('viewer'),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tenantId] }),
    index('user_tenants_tenant_id_idx').on(t.tenantId),
    index('user_tenants_user_id_idx').on(t.userId),
  ],
);

export type UserTenant = typeof userTenants.$inferSelect;
export type NewUserTenant = typeof userTenants.$inferInsert;
