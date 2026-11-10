import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { transmissions } from './transmissions.js';

/**
 * assets — ledger editorial unificado (PF-10, Épica F — cierra la épica).
 *
 * Una fila por artefacto generado: `kind` = clip | note | flyer | post.
 * Es una CAPA NUEVA sobre `clips` y `publications` — no las reemplaza ni las
 * migra: los 9 slices anteriores siguen consumiendo las tablas legacy y el
 * ledger se puebla por `syncAssets` (write-through al transicionar). Un
 * merge destructivo tocaría todo lo que ya consume clips/publications
 * (blast radius enorme, fuera de los 5pts del slice).
 *
 * `(source_table, ref_id)` es la referencia estable a la fila origen:
 *   - clip  → 'clips'        + clips.id
 *   - note  → 'publications' + publications.id
 *   - flyer → 'publications' + uuid v5(publicationId + índice) — el flyer
 *             vive en `publications.quote_flyer_paths` (jsonb), NO es una
 *             fila: por eso `ref_id` NO tiene FK. La UNIQUE compuesta
 *             `(tenant_id, source_table, ref_id)` es el contrato de
 *             idempotencia del sync: el mismo artefacto siempre resuelve
 *             a la misma fila del ledger, re-correr nunca duplica.
 *
 * `parent_asset_id` (self-FK, SET NULL) enlaza sub-artefactos: flyer→nota,
 * variant/post→cualquiera. Si el padre se borra el hijo queda huérfano
 * (null), no se borra en cascada.
 *
 * `status` es el estado editorial CANÓNICO (draft | pending_review |
 * approved | published | archived) — la máquina vive en
 * `assetsService.ts`. El status legacy de la fila fuente se mapea al
 * canónico en el sync y se escribe de vuelta (write-through) en cada
 * transición.
 *
 * `payload` es kind-specific: clip→{videoPath, duration}, note→{content},
 * flyer→{flyerPath, quoteIndex}, post→{network, copy, hashtags}.
 */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(),
    sourceTable: varchar('source_table', { length: 24 }).notNull(),
    // SIN FK a propósito: para kind='flyer' no existe fila origen (el flyer
    // es un path dentro de un jsonb) — ver doc de la tabla.
    refId: uuid('ref_id').notNull(),
    parentAssetId: uuid('parent_asset_id').references(
      (): AnyPgColumn => assets.id,
      { onDelete: 'set null' },
    ),
    title: text('title'),
    status: varchar('status', { length: 20 }).notNull().default('draft'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // SET NULL: borrar la transmisión no borra el asset ya producido (misma
    // regla que clips.transmission_id en PD-05).
    transmissionId: uuid('transmission_id').references(() => transmissions.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('assets_tenant_id_idx').on(t.tenantId),
    index('assets_tenant_id_kind_idx').on(t.tenantId, t.kind),
    index('assets_tenant_id_status_idx').on(t.tenantId, t.status),
    index('assets_transmission_id_idx').on(t.transmissionId),
    // Contrato de idempotencia del sync — NO improvisar claves distintas.
    unique('assets_tenant_source_ref_unique').on(
      t.tenantId,
      t.sourceTable,
      t.refId,
    ),
  ],
);
