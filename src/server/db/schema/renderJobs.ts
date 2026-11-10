import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { clips } from './clips.js';

/**
 * clip_render_jobs — cola de render de clips (PF-04, Épica F).
 *
 * Desacopla "pedir un clip" de "renderizarlo": cada fila es un job ad-hoc con
 * estado persistente y reintento automático. Distinta de `scheduled_jobs` /
 * `job_executions`, que son para jobs RECURRENTES de programación de
 * transmisiones — esta tabla es para renders bajo demanda.
 *
 * `kind` discrimina el tipo de render ('cut' en este slice; PF-02 'reframe'
 * y PF-03 'subtitles' vendrán después — varchar, no enum, para agregar kinds
 * sin migración). `payload` lleva los parámetros del kind: para 'cut' es
 * `{ transmissionId, startMs, endMs }`.
 *
 * `clip_id` es NULLABLE: para kind='cut' el clip lo crea el cutter DURANTE el
 * render — el worker lo rellena vía `markDone(jobId, { clipId })`. Para kinds
 * que operan sobre un clip existente (reframe/subtitles) puede venir desde
 * el enqueue. ON DELETE cascade: borrar el clip borra sus jobs de render.
 *
 * Ciclo de vida: `pending` → (`claimNext` atómico) → `running` → `done` |
 * `error` | de vuelta a `pending` con `run_at` diferido (backoff). `cancelled`
 * es terminal desde `pending|running`; `retry` manual reabre `error|cancelled`.
 * `run_at` es "cuándo PUEDE correr" — el backoff lo posterga; el índice
 * compuesto (status, run_at) es la query exacta del claim.
 */
export const clipRenderJobs = pgTable(
  'clip_render_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    clipId: uuid('clip_id').references(() => clips.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('clip_render_jobs_tenant_id_idx').on(t.tenantId),
    index('clip_render_jobs_clip_id_idx').on(t.clipId),
    // Query del claim del worker: status='pending' AND run_at <= now
    // ORDER BY run_at — el compuesto cubre filtro y orden.
    index('clip_render_jobs_status_run_at_idx').on(t.status, t.runAt),
  ],
);
