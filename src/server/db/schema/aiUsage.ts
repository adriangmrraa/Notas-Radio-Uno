import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { transmissions } from './transmissions.js';

/**
 * ai_usage_events — ledger de consumo de IA por llamada (PI-03, Épica I).
 *
 * Una fila por llamada a un modelo de IA que pasa por los gateways
 * instrumentados (`aiSdkService`, `aiService` legacy, `scraperService`,
 * `analysisEngineService.callAnalysisProvider`): proveedor, modelo, tokens
 * consumidos y costo estimado en USD calculado contra la tabla de pricing
 * de `aiUsageService` (constante en código, versionada — no hace falta
 * migración para ajustar precios).
 *
 * `feature` discrimina el call-site ('news-generate', 'asset-edit',
 * 'live-analysis', …) — varchar, no enum, para sumar features sin migración
 * (misma convención que job_queue.kind).
 *
 * `transmission_id` es nullable: muchas llamadas (review, dossiers,
 * variants) no anclan a una transmisión. ON DELETE set null — borrar la
 * transmisión no puede borrar el costo, que sigue perteneciendo al tenant.
 * `tenant_id` cascade: borrar el tenant borra su historial.
 *
 * `success=false` registra intentos fallidos de provider (con `error`
 * truncado) — los tokens quedan en 0 y el costo en null.
 * `estimated_cost_usd` nullable: modelos fuera de la tabla de pricing se
 * registran con costo desconocido antes que con un número inventado.
 *
 * Aislamiento: sin RLS — TODA query filtra por `tenant_id` salvo las
 * agregaciones cross-tenant documentadas del panel de plataforma (guard
 * requirePlatformAdmin, mismo criterio que admin jobs).
 */
export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    transmissionId: uuid('transmission_id').references(
      () => transmissions.id,
      { onDelete: 'set null' },
    ),
    /** Call-site lógico: 'news-generate', 'asset-edit', 'live-analysis', … */
    feature: varchar('feature', { length: 64 }).notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    model: varchar('model', { length: 64 }).notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    /**
     * Costo estimado en USD = prompt*in + completion*out de la tabla de
     * pricing. Null cuando el modelo no tiene precio cargado o la llamada
     * falló antes de consumir tokens.
     */
    estimatedCostUsd: numeric('estimated_cost_usd', {
      precision: 14,
      scale: 6,
    }),
    success: boolean('success').notNull().default(true),
    /** Mensaje de error truncado del intento (provider caído, timeout, …). */
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Resúmenes por tenant y rango — la query del endpoint tenant/admin.
    index('ai_usage_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    // Agregación por transmisión (top transmisiones por costo).
    index('ai_usage_events_transmission_idx').on(t.transmissionId),
  ],
);
