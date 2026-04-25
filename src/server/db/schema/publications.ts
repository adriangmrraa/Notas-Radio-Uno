import { pgTable, uuid, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { publicationSourceEnum } from './enums.js';
import { tenants } from './tenants.js';

export const publications = pgTable(
  'publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    title: text('title'),
    content: text('content'),
    imagePath: text('image_path'),
    imageUrl: text('image_url'),
    source: publicationSourceEnum('source').notNull().default('manual'),
    publishResults: jsonb('publish_results').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('publications_tenant_id_idx').on(t.tenantId),
    index('publications_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);

export const transcriptions = pgTable(
  'transcriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    audioFile: text('audio_file'),
    source: publicationSourceEnum('source').notNull().default('manual'),
    durationSeconds: integer('duration_seconds'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('transcriptions_tenant_id_idx').on(t.tenantId),
    index('transcriptions_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);
