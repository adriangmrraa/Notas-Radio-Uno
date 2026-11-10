import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { programs } from './programs.js';

/**
 * auto_publish_configs — Configuración de auto-publicación por tenant/programa
 * (PG-03).
 *
 * Una fila por (tenant, programa) + una fila "global" por tenant que aplica a
 * todos los programas sin config específica.
 *
 * El problema: en Postgres un UNIQUE sobre (tenant_id, program_id) NO
 * deduplica cuando program_id es NULL (NULL != NULL), así que la config
 * global se podría insertar dos veces. Solución: `program_key` NOT NULL,
 * columna derivada que el servicio setea siempre — `program_id::text` cuando
 * hay programa, '__all__' cuando es la config global. La UNIQUE va sobre
 * (tenant_id, program_key) y cubre ambos casos de forma uniforme; además el
 * ON CONFLICT (tenant_id, program_key) del upsert queda trivial (un índice
 * parcial obligaría a dos conflict targets distintos según el caso).
 *
 * `program_id` conserva la FK real a programs ON DELETE CASCADE (borrar el
 * programa borra su config); `program_key` es sólo la clave de dedupe — el
 * servicio la calcula, nunca viene del cliente.
 *
 * `platforms` guarda plataformas OBJETIVO por nombre de red (instagram,
 * tiktok, …) — todavía no hay `social_connections` (eso es PG-04); PG-04/05
 * resolverán cada plataforma a cuentas conectadas del tenant.
 *
 * `mode`: 'off' (no publica), 'on_approval' (publica al aprobar el asset),
 * 'scheduled' (publica los `publish_days` a `publish_time` en `timezone`).
 * `publish_days`/`publish_time` sólo tienen sentido con mode='scheduled' —
 * el servicio los persiste como []/NULL en los otros modos.
 */
export const autoPublishConfigs = pgTable(
  'auto_publish_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id, {
      onDelete: 'cascade',
    }),
    /** Clave de dedupe: program_id::text o '__all__' para la config global. */
    programKey: varchar('program_key', { length: 40 }).notNull(),
    mode: varchar('mode', { length: 24 }).notNull().default('off'),
    platforms: jsonb('platforms')
      .$type<string[]>()
      .notNull()
      .default([]),
    publishDays: jsonb('publish_days')
      .$type<number[]>()
      .notNull()
      .default([]),
    publishTime: varchar('publish_time', { length: 5 }),
    timezone: varchar('timezone', { length: 64 })
      .notNull()
      .default('America/Argentina/Buenos_Aires'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('auto_publish_configs_tenant_id_idx').on(t.tenantId),
    index('auto_publish_configs_program_id_idx').on(t.programId),
    // Dedupe uniforme: cubre configs por programa Y la global ('__all__'),
    // cosa que un UNIQUE sobre (tenant_id, program_id) no logra con NULLs.
    unique('auto_publish_configs_tenant_program_unique').on(
      t.tenantId,
      t.programKey,
    ),
  ],
);
