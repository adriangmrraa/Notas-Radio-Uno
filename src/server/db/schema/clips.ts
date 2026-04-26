import { pgTable, uuid, text, integer, jsonb, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const clips = pgTable(
  'clips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    publicationId: uuid('publication_id'),
    programId: uuid('program_id'),
    title: varchar('title', { length: 255 }).notNull(),
    hookText: text('hook_text').notNull(),
    audioPath: text('audio_path'),
    videoPath: text('video_path'),
    subtitlesPath: text('subtitles_path'),
    duration: integer('duration').notNull().default(0),
    status: varchar('status', { length: 30 }).notNull().default('generating'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('clips_tenant_id_idx').on(t.tenantId),
    index('clips_tenant_id_status_idx').on(t.tenantId, t.status),
    index('clips_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);
