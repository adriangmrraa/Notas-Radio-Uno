import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { assets } from './assets.js';
import { publications } from './publications.js';
import { socialConnections } from './socialConnections.js';

/**
 * publish_jobs — cola persistente de publicación vía Zernio (PG-05).
 *
 * Una fila por (pieza de contenido × red × cuenta): aprobar un asset o una
 * publicación encola UN job por cuenta Zernio destino. El `publishWorker`
 * claimea `queued` y publica contra POST /v1/posts con la `idempotency_key`
 * como header Idempotency-Key — reintentar nunca duplica el post en Zernio.
 *
 * NUNCA guarda credenciales sociales: `platform` + `account_id` son los ids
 * opacos que Zernio reporta (mismo criterio que social_connections); la
 * conexión origen queda en `connection_id` (SET NULL: desconectar la cuenta
 * no borra el historial del job).
 *
 * Ciclo de vida: `queued` → `publishing` (claim atómico) → `published` |
 * `partial` | `failed`; `failed`/`partial` → `queued` por reintento manual;
 * cualquier estado → `cancelled`. `scheduled_for` es el deseo del usuario;
 * `next_attempt_at` es el gate real del claim (semilla = scheduled_for ??
 * now, después el backoff del worker) — no se mezclan a propósito:
 * scheduled_for describe intención editorial, next_attempt_at es
 * maquinaria del worker (equivalente a run_at de clip_render_jobs).
 *
 * asset_id/publication_id anclan el origen (SET NULL: borrar la fuente no
 * borra el job ya ejecutado). `zernio_post_id` queda cuando Zernio creó el
 * post — es la llave para el retry remoto POST /v1/posts/{id}/retry.
 */
export const publishJobs = pgTable(
  'publish_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Origen editorial (ledger PG-01). NULL si el origen es una publication legacy. */
    assetId: uuid('asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),
    /** Origen legacy (nota del copiloto). NULL si el origen es un asset. */
    publicationId: uuid('publication_id').references(() => publications.id, {
      onDelete: 'set null',
    }),
    /** Conexión Zernio usada. NULL si la cuenta se desconectó después. */
    connectionId: uuid('connection_id').references(() => socialConnections.id, {
      onDelete: 'set null',
    }),
    platform: varchar('platform', { length: 32 }).notNull(),
    /** `_id` de la cuenta EN ZERNIO — id opaco, nunca un handle ni un token. */
    accountId: varchar('account_id', { length: 64 }).notNull(),
    /** 'queued' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled'. */
    status: varchar('status', { length: 20 }).notNull().default('queued'),
    /** `_id` del post en Zernio una vez creado (llave del retry remoto). */
    zernioPostId: varchar('zernio_post_id', { length: 64 }),
    /**
     * Clave idempotente del job lógico (uuid v5 determinista del origen +
     * plataforma + cuenta). UNIQUE: re-encolar cae en la misma fila; viaja
     * como header `Idempotency-Key` a Zernio (retry nunca duplica el post).
     */
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    content: text('content').notNull(),
    mediaUrls: jsonb('media_urls').$type<string[]>().notNull().default([]),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    /** errorCategory de Zernio o la categoría mapeada del HTTP de falla. */
    lastErrorCategory: varchar('last_error_category', { length: 32 }),
    /** 'user' | 'platform' | 'system' — origen del último error. */
    lastErrorSource: varchar('last_error_source', { length: 16 }),
    /** Cuándo quiere el usuario que salga (intención editorial, no el gate del worker). */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    platformPostUrl: text('platform_post_url'),
    /**
     * Gate del claim del worker: status='queued' AND next_attempt_at <= now.
     * Semilla = scheduled_for ?? now al encolar; el backoff de reintentos la
     * posterga. Equivalente a run_at de clip_render_jobs.
     */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('publish_jobs_tenant_id_idx').on(t.tenantId),
    index('publish_jobs_tenant_id_status_idx').on(t.tenantId, t.status),
    index('publish_jobs_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
    // Query del claim del worker: status='queued' AND next_attempt_at <= now.
    index('publish_jobs_status_next_attempt_idx').on(t.status, t.nextAttemptAt),
    unique('publish_jobs_idempotency_key_unique').on(t.idempotencyKey),
  ],
);
