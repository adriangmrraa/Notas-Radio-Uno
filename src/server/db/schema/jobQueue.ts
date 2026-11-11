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

/**
 * job_queue — cola de trabajo GENÉRICA persistente (PI-01, Épica I).
 *
 * Distinta de las colas de dominio ya existentes: `clip_render_jobs` (renders
 * ffmpeg bajo demanda) y `publish_jobs` (posts Zernio) modelan cada una su
 * propio ciclo de vida; distinta también de `scheduled_jobs`/`job_executions`,
 * que son jobs RECURRENTES de programación de transmisiones. Esta tabla es la
 * cola transversal de la plataforma: cualquier proceso encola trabajo
 * diferible con reintentos y dead-letter sin crear una tabla por dominio.
 *
 * `kind` discrimina el tipo de job ('retention.purge' es el seed de este
 * slice; varchar — no enum de DB — para agregar kinds sin migración, misma
 * convención que clip_render_jobs/publish_jobs). `payload` lleva los
 * parámetros del kind.
 *
 * Ciclo de vida: `pending` → (`claimNext` atómico y tenant-scoped) →
 * `running` → `succeeded` | vuelta a `pending` con `run_at` diferido
 * (backoff exponencial) | `dead` al agotar `max_attempts` | `failed`
 * (fallo terminal sin reintento, p.ej. kind desconocido). `cancelled` es
 * terminal desde `pending|running`; `retry` manual reabre
 * `dead|failed|cancelled`.
 *
 * `run_at` es "cuándo PUEDE correr" — el gate exacto del claim es
 * `status='pending' AND run_at <= now` (índice compuesto status+run_at).
 * `dead_lettered_at` marca cuándo el job agotó sus reintentos: la dead-letter
 * es una FILA en la misma tabla (MVP Postgres, decisión D-6), no una cola
 * separada — el panel admin la lista filtrando status='dead'.
 *
 * Aislamiento: sin RLS en este repo — TODA query filtra por `tenant_id`,
 * incluido el claim (a diferencia del claim global de clip_render_jobs).
 * ON DELETE cascade: borrar el tenant borra su cola.
 */
export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    /**
     * 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled'
     * (varchar, no enum: agregar estados no exige migración).
     */
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    /**
     * Gate del claim: `status='pending' AND run_at <= now`. Semilla = now al
     * encolar (default de columna); el backoff del worker la posterga.
     */
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Cuándo agotó los reintentos y pasó a 'dead' (dead-letter). */
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Categoría corta del último error para agrupar en el panel de jobs. */
    errorCategory: varchar('error_category', { length: 32 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('job_queue_tenant_id_idx').on(t.tenantId),
    // Listados del panel/API: tenant_id + status.
    index('job_queue_tenant_id_status_idx').on(t.tenantId, t.status),
    // Query exacta del claim: status='pending' AND run_at <= now ORDER BY run_at.
    index('job_queue_status_run_at_idx').on(t.status, t.runAt),
    index('job_queue_tenant_id_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);
