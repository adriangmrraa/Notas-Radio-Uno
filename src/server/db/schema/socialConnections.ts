import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * zernio_profiles — Perfil Zernio del tenant (PG-04).
 *
 * Un perfil Zernio por tenant: `profileId` es la vía de aislamiento de todas
 * las llamadas a la API de Zernio y `externalId` del lado de Zernio vale
 * nuestro `tenant_id`. Es un recurso externo con vida propia — tabla propia
 * con FK/UNIQUE, no una fila de settings genéricos (decisión del brief).
 *
 * NUNCA guarda credenciales: sólo el id opaco del perfil que Zernio creó.
 */
export const zernioProfiles = pgTable(
  'zernio_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** `_id` del perfil en Zernio (ObjectId de 24 chars). */
    profileId: varchar('profile_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [unique('zernio_profiles_tenant_id_unique').on(t.tenantId)],
);

/**
 * social_connections — Cuentas sociales conectadas vía Zernio (PG-04).
 *
 * PeriodistApp nunca ve credenciales: el OAuth lo hospeda Zernio y acá sólo
 * quedan identificadores opacos (`account_id` = `_id` de la cuenta en Zernio,
 * NO el id que la red social le asigna). `platform` guarda el valor de la API
 * de Zernio (instagram, tiktok, linkedin, …).
 *
 * La UNIQUE (tenant_id, platform, account_id) es el contrato de dedupe del
 * callback y del sync: re-conectar la misma cuenta actualiza la fila en vez
 * de duplicarla (ON CONFLICT DO UPDATE en el servicio).
 */
export const socialConnections = pgTable(
  'social_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 32 }).notNull(),
    /** `_id` de la cuenta EN ZERNIO — no el id de la red social. */
    accountId: varchar('account_id', { length: 64 }).notNull(),
    username: varchar('username', { length: 255 }),
    displayName: varchar('display_name', { length: 255 }),
    /** 'connected' | 'disconnected' | 'error'. */
    status: varchar('status', { length: 20 }).notNull().default('connected'),
    /** Perfil Zernio dueño de la cuenta (aislante de las llamadas). */
    zernioProfileId: varchar('zernio_profile_id', { length: 64 }).notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('social_connections_tenant_id_idx').on(t.tenantId),
    index('social_connections_tenant_id_status_idx').on(t.tenantId, t.status),
    unique('social_connections_tenant_platform_account_unique').on(
      t.tenantId,
      t.platform,
      t.accountId,
    ),
  ],
);
