import { pgTable, uuid, varchar, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { userRoleEnum, userStatusEnum } from './enums.js';
import { tenants } from './tenants.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    fullName: varchar('full_name', { length: 255 }).notNull(),
    avatarUrl: text('avatar_url'),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').notNull().default('owner'),
    status: userStatusEnum('status').notNull().default('pending'),
    isVerified: boolean('is_verified').notNull().default(false),
    verificationToken: uuid('verification_token'),
    verificationTokenExpiresAt: timestamp('verification_token_expires_at', { withTimezone: true }),
    resetPasswordToken: uuid('reset_password_token'),
    resetPasswordExpiresAt: timestamp('reset_password_expires_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('users_email_idx').on(t.email),
    index('users_tenant_id_idx').on(t.tenantId),
    index('users_verification_token_idx').on(t.verificationToken),
    index('users_reset_password_token_idx').on(t.resetPasswordToken),
  ],
);
