/**
 * aiUsageService — ledger de consumo de IA por llamada (PI-03, Épica I).
 *
 * Tres piezas:
 *
 *   1) Registro: `recordAiUsageEvent` inserta una fila en `ai_usage_events`
 *      por llamada a modelo — NUNCA lanza (un fallo del ledger no puede
 *      romper la llamada IA: try/catch + log.warn). `withAiUsageRecording`
 *      envuelve una llamada: mide duración, registra éxito con tokens/costo
 *      o `success=false` con el error, y repropaga. Sin `usageCtx.tenantId`
 *      no hay evento — la escritura exige tenant (columna NOT NULL).
 *
 *   2) Pricing: `AI_MODEL_PRICING_USD_PER_1M` — constante versionada en
 *      código, fácil de actualizar (precios publicados por proveedor,
 *      aproximados al momento del slice). `estimateAiCostUsd` devuelve null
 *      para modelos sin precio cargado: costo desconocido > número
 *      inventado.
 *
 *   3) Agregación: `AiUsageStore.summarize` con filtros
 *      tenant/from/to/feature + group-bys (feature/provider/tenant/
 *      top-transmissions). La vista tenant siempre llega con tenantId; la
 *      cross-tenant sin él es la excepción documentada del panel admin
 *      (mismo criterio que admin jobs — lectura solamente).
 *
 * Patrón store del repo: interface + `createDrizzleAiUsageStore(db)` +
 * memory store en tests/helpers, inyectable vía `aiUsageDeps.store` —
 * mismo contrato que `jobQueueRouteDeps`/`adminJobsRouteDeps`.
 */
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { aiUsageEvents } from '../db/schema/aiUsage.js';
import type { AiUsageContext } from '../../shared/types.js';
import { log } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Pricing — USD por 1M tokens (input/output). Actualizar al cambiar precios.
// ---------------------------------------------------------------------------

/**
 * Precios de lista publicados por proveedor (aprox. al slice PI-03).
 *
 * deepseek-chat:   $0.27 / $1.10  (deepseek.com, cache-miss)
 * gemini-2.0-flash:$0.10 / $0.40  (ai.google.dev)
 * gemini-2.5-flash:$0.30 / $2.50  (ai.google.dev — path legacy aiService)
 * gpt-4o-mini:     $0.15 / $0.60  (openai.com)
 * gemini-3.0-flash:$0.30 / $2.50  (registry 'analysis' default — estimado a
 *                                  par de gemini-2.5-flash hasta publicación)
 * gpt-4o:          $2.50 / $10.00 (openai.com — 'openai-vision' del registry)
 *
 * Modelo no listado ⇒ costo null (se registra el evento igual).
 */
export const AI_MODEL_PRICING_USD_PER_1M: Record<
  string,
  { input: number; output: number }
> = {
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gemini-3.0-flash': { input: 0.3, output: 2.5 },
  'gpt-4o': { input: 2.5, output: 10 },
};

/** prompt*in + completion*out por 1M tokens. null si el modelo no tiene precio. */
export function estimateAiCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = AI_MODEL_PRICING_USD_PER_1M[model];
  if (!price) return null;
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Tokens — normalización de las formas de `usage` de cada path de IA
// ---------------------------------------------------------------------------

/** Conteo normalizado: lo que se persiste en la tabla. */
export interface AiTokenCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Aplana las formas de `usage` que devuelven los providers:
 *   - AI SDK v6:        { inputTokens, outputTokens, totalTokens }
 *   - AI SDK v4:        { promptTokens, completionTokens, totalTokens }
 *   - OpenAI REST:      { prompt_tokens, completion_tokens, total_tokens }
 *   - Gemini REST:      { promptTokenCount, candidatesTokenCount, totalTokenCount }
 * Total faltante ⇒ prompt+completion; sin nada ⇒ ceros (llamada fallida o
 * provider que no reporta uso — el evento se registra igual).
 */
export function normalizeTokenUsage(raw: unknown): AiTokenCounts {
  const r = (raw ?? {}) as Record<string, unknown>;
  const prompt =
    numOrUndef(r.promptTokens) ??
    numOrUndef(r.inputTokens) ??
    numOrUndef(r.prompt_tokens) ??
    numOrUndef(r.promptTokenCount) ??
    0;
  const completion =
    numOrUndef(r.completionTokens) ??
    numOrUndef(r.outputTokens) ??
    numOrUndef(r.completion_tokens) ??
    numOrUndef(r.candidatesTokenCount) ??
    0;
  const total =
    numOrUndef(r.totalTokens) ??
    numOrUndef(r.total_tokens) ??
    numOrUndef(r.totalTokenCount) ??
    prompt + completion;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

// ---------------------------------------------------------------------------
// Registro — nunca rompe la llamada IA
// ---------------------------------------------------------------------------

export interface RecordAiUsageInput {
  tenantId: string;
  transmissionId?: string | null;
  feature: string;
  provider: string;
  model: string;
  /** Cualquier forma de `usage` de provider — se normaliza acá. */
  usage?: unknown;
  success?: boolean;
  error?: string | null;
  durationMs?: number | null;
  /** createdAt inyectable (default now) — determinismo en tests. */
  createdAt?: Date;
}

/** Mensaje de error acotado — la columna es text pero no queremos stacks. */
const MAX_ERROR_LEN = 500;

function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > MAX_ERROR_LEN ? `${raw.slice(0, MAX_ERROR_LEN)}…` : raw;
}

/**
 * Deps inyectables (mismo contrato que adminJobsRouteDeps): los tests pisan
 * `store` con el memory store — sin DB, sin red.
 */
export const aiUsageDeps: { store?: AiUsageStore } = {};

let defaultStore: AiUsageStore | null = null;
const store = (): AiUsageStore =>
  aiUsageDeps.store ?? (defaultStore ??= createDrizzleAiUsageStore());

/** Normaliza el input a la fila a insertar (tokens + costo + error acotado). */
export function buildAiUsageEventRow(input: RecordAiUsageInput): NewAiUsageEvent {
  const tokens = normalizeTokenUsage(input.usage);
  const success = input.success ?? true;
  const costUsd = success
    ? estimateAiCostUsd(input.model, tokens.promptTokens, tokens.completionTokens)
    : null;
  return {
    tenantId: input.tenantId,
    transmissionId: input.transmissionId ?? null,
    feature: input.feature,
    provider: input.provider,
    model: input.model,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    totalTokens: tokens.totalTokens,
    estimatedCostUsd: costUsd === null ? null : costUsd.toFixed(6),
    success,
    error: input.error ? input.error.slice(0, MAX_ERROR_LEN) : null,
    durationMs: input.durationMs ?? null,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  };
}

async function writeEvent(s: AiUsageStore, input: RecordAiUsageInput): Promise<void> {
  try {
    await s.insertEvent(buildAiUsageEventRow(input));
  } catch (err) {
    log.warn('[AiUsage] no se pudo registrar el evento de uso', {
      err,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
    });
  }
}

/**
 * Inserta el evento. Siempre resuelve (nunca rechaza): el ledger es
 * best-effort — si la tabla falla se loguea warn y la llamada IA sigue.
 * Sin tenantId no se escribe nada (la columna es NOT NULL).
 */
export async function recordAiUsageEvent(input: RecordAiUsageInput): Promise<void> {
  if (!input.tenantId) {
    log.debug('[AiUsage] evento sin tenantId descartado', {
      feature: input.feature,
      provider: input.provider,
    });
    return;
  }
  await writeEvent(store(), input);
}

/**
 * Envuelve una llamada a provider: cronometra, registra éxito (tokens +
 * costo) o fallo (`success=false` + error truncado), y repropaga el error.
 * `run` devuelve `{ value, usage }` — usage en la forma cruda del provider.
 * El registro es awaited pero jamás lanza — la llamada IA no se rompe.
 */
export async function withAiUsageRecording<T>(
  meta: { provider: string; model: string; usageCtx?: AiUsageContext },
  run: () => Promise<{ value: T; usage?: unknown }>,
): Promise<T> {
  const ctx = meta.usageCtx;
  const startedAt = Date.now();
  try {
    const { value, usage } = await run();
    if (ctx) {
      await recordAiUsageEvent({
        tenantId: ctx.tenantId,
        transmissionId: ctx.transmissionId ?? null,
        feature: ctx.feature,
        provider: meta.provider,
        model: meta.model,
        usage,
        success: true,
        durationMs: Date.now() - startedAt,
      });
    }
    return value;
  } catch (err) {
    if (ctx) {
      await recordAiUsageEvent({
        tenantId: ctx.tenantId,
        transmissionId: ctx.transmissionId ?? null,
        feature: ctx.feature,
        provider: meta.provider,
        model: meta.model,
        success: false,
        error: errMsg(err),
        durationMs: Date.now() - startedAt,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Agregación — contrato compartido por el endpoint tenant y el admin
// ---------------------------------------------------------------------------

export interface AiUsageTotals {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Suma de estimated_cost_usd (filas con costo null no aportan). */
  costUsd: number;
}

export interface AiUsageSummaryFilter {
  /** Presente ⇒ vista tenant (siempre en el endpoint tenant). */
  tenantId?: string;
  feature?: string;
  /** Rango sobre created_at: [from, to). Defaults en la capa de rutas. */
  from?: Date;
  to?: Date;
  /** Tope del ranking de transmisiones por costo (default 10). */
  topTransmissionsLimit?: number;
}

export interface AiUsageSummary {
  totals: AiUsageTotals;
  /** Ordenado por costo desc. En vista tenant trae una sola fila. */
  byTenant: Array<AiUsageTotals & { tenantId: string }>;
  byFeature: Array<AiUsageTotals & { feature: string }>;
  byProvider: Array<AiUsageTotals & { provider: string }>;
  /** Top transmisiones por costo (transmission_id IS NOT NULL). */
  topTransmissions: Array<AiUsageTotals & { transmissionId: string; tenantId: string }>;
}

export type AiUsageEventRow = typeof aiUsageEvents.$inferSelect;
export type NewAiUsageEvent = typeof aiUsageEvents.$inferInsert;

export interface AiUsageStore {
  insertEvent(v: NewAiUsageEvent): Promise<AiUsageEventRow>;
  /**
   * `tenantId` presente ⇒ vista tenant; ausente ⇒ agregación cross-tenant
   * (excepción documentada del panel admin — lectura solamente).
   */
  summarize(filter: AiUsageSummaryFilter): Promise<AiUsageSummary>;
}

// ---------------------------------------------------------------------------
// Agregación pura compartida — el memory store la reutiliza para reproducir
// EXACTAMENTE la semántica de la implementación drizzle.
// ---------------------------------------------------------------------------

export type UsageRowLike = Pick<
  AiUsageEventRow,
  | 'tenantId'
  | 'transmissionId'
  | 'feature'
  | 'provider'
  | 'promptTokens'
  | 'completionTokens'
  | 'totalTokens'
  | 'estimatedCostUsd'
  | 'success'
  | 'createdAt'
>;

export function filterUsageRows(
  rows: UsageRowLike[],
  filter: AiUsageSummaryFilter,
): UsageRowLike[] {
  const fromMs = filter.from?.getTime();
  const toMs = filter.to?.getTime();
  return rows.filter(
    (r) =>
      (filter.tenantId === undefined || r.tenantId === filter.tenantId) &&
      (filter.feature === undefined || r.feature === filter.feature) &&
      (fromMs === undefined || r.createdAt.getTime() >= fromMs) &&
      (toMs === undefined || r.createdAt.getTime() < toMs),
  );
}

export function reduceToTotals(rows: UsageRowLike[]): AiUsageTotals {
  const t: AiUsageTotals = {
    calls: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  for (const r of rows) {
    t.calls += 1;
    if (!r.success) t.errors += 1;
    t.promptTokens += r.promptTokens;
    t.completionTokens += r.completionTokens;
    t.totalTokens += r.totalTokens;
    t.costUsd += Number(r.estimatedCostUsd ?? 0);
  }
  return t;
}

function groupBy<K extends string>(
  rows: UsageRowLike[],
  keyOf: (r: UsageRowLike) => K | null,
): Map<K, UsageRowLike[]> {
  const groups = new Map<K, UsageRowLike[]>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null) continue;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

const byCostDesc = (a: AiUsageTotals, b: AiUsageTotals): number =>
  b.costUsd - a.costUsd || b.totalTokens - a.totalTokens;

/** La agregación de referencia — mismo contrato que el SQL del drizzle store. */
export function summarizeUsageRows(
  rows: UsageRowLike[],
  filter: AiUsageSummaryFilter,
): AiUsageSummary {
  const scoped = filterUsageRows(rows, filter);
  const topLimit = filter.topTransmissionsLimit ?? 10;

  const byTenant = [...groupBy(scoped, (r) => r.tenantId).entries()]
    .map(([tenantId, rs]) => ({ tenantId, ...reduceToTotals(rs) }))
    .sort(byCostDesc);
  const byFeature = [...groupBy(scoped, (r) => r.feature).entries()]
    .map(([feature, rs]) => ({ feature, ...reduceToTotals(rs) }))
    .sort(byCostDesc);
  const byProvider = [...groupBy(scoped, (r) => r.provider).entries()]
    .map(([provider, rs]) => ({ provider, ...reduceToTotals(rs) }))
    .sort(byCostDesc);
  const topTransmissions = [
    ...groupBy(
      scoped,
      (r) => (r.transmissionId === null ? null : `${r.tenantId}::${r.transmissionId}`),
    ).entries(),
  ]
    .map(([key, rs]) => {
      const [tenantId, transmissionId] = key.split('::');
      return { tenantId, transmissionId, ...reduceToTotals(rs) };
    })
    .sort(byCostDesc)
    .slice(0, topLimit);

  return {
    totals: reduceToTotals(scoped),
    byTenant,
    byFeature,
    byProvider,
    topTransmissions,
  };
}

// ---------------------------------------------------------------------------
// Store drizzle — agregación en SQL (la tabla crece sin cota: los group-bys
// corren en Postgres, no en memoria del proceso).
// ---------------------------------------------------------------------------

const totalsCols = {
  calls: sql<number>`count(*)::int`,
  errors: sql<number>`count(*) filter (where ${aiUsageEvents.success} = false)::int`,
  promptTokens: sql<number>`coalesce(sum(${aiUsageEvents.promptTokens}), 0)::int`,
  completionTokens: sql<number>`coalesce(sum(${aiUsageEvents.completionTokens}), 0)::int`,
  totalTokens: sql<number>`coalesce(sum(${aiUsageEvents.totalTokens}), 0)::int`,
  costUsd: sql<number>`coalesce(sum(${aiUsageEvents.estimatedCostUsd}::float8), 0)::float8`,
};

export function createDrizzleAiUsageStore(
  executor: Database = db,
): AiUsageStore {
  const whereOf = (filter: AiUsageSummaryFilter) =>
    and(
      filter.tenantId ? eq(aiUsageEvents.tenantId, filter.tenantId) : undefined,
      filter.feature ? eq(aiUsageEvents.feature, filter.feature) : undefined,
      filter.from ? gte(aiUsageEvents.createdAt, filter.from) : undefined,
      filter.to ? lt(aiUsageEvents.createdAt, filter.to) : undefined,
    );

  const asTotals = (r: Record<string, unknown>): AiUsageTotals => ({
    calls: Number(r.calls ?? 0),
    errors: Number(r.errors ?? 0),
    promptTokens: Number(r.promptTokens ?? 0),
    completionTokens: Number(r.completionTokens ?? 0),
    totalTokens: Number(r.totalTokens ?? 0),
    costUsd: Number(r.costUsd ?? 0),
  });

  return {
    async insertEvent(v) {
      const [row] = await executor.insert(aiUsageEvents).values(v).returning();
      return row;
    },

    async summarize(filter) {
      const where = whereOf(filter);
      const topLimit = filter.topTransmissionsLimit ?? 10;

      const [totalsRows, byTenantRows, byFeatureRows, byProviderRows, topRows] =
        await Promise.all([
          executor.select(totalsCols).from(aiUsageEvents).where(where),
          executor
            .select({ tenantId: aiUsageEvents.tenantId, ...totalsCols })
            .from(aiUsageEvents)
            .where(where)
            .groupBy(aiUsageEvents.tenantId),
          executor
            .select({ feature: aiUsageEvents.feature, ...totalsCols })
            .from(aiUsageEvents)
            .where(where)
            .groupBy(aiUsageEvents.feature),
          executor
            .select({ provider: aiUsageEvents.provider, ...totalsCols })
            .from(aiUsageEvents)
            .where(where)
            .groupBy(aiUsageEvents.provider),
          executor
            .select({
              transmissionId: aiUsageEvents.transmissionId,
              tenantId: aiUsageEvents.tenantId,
              ...totalsCols,
            })
            .from(aiUsageEvents)
            .where(and(where, isNotNull(aiUsageEvents.transmissionId)))
            .groupBy(aiUsageEvents.transmissionId, aiUsageEvents.tenantId)
            .orderBy(
              desc(
                sql`coalesce(sum(${aiUsageEvents.estimatedCostUsd}::float8), 0)`,
              ),
            )
            .limit(topLimit),
        ]);

      return {
        totals: asTotals(totalsRows[0] ?? {}),
        byTenant: byTenantRows
          .map((r) => ({ tenantId: r.tenantId, ...asTotals(r) }))
          .sort(byCostDesc),
        byFeature: byFeatureRows
          .map((r) => ({ feature: r.feature, ...asTotals(r) }))
          .sort(byCostDesc),
        byProvider: byProviderRows
          .map((r) => ({ provider: r.provider, ...asTotals(r) }))
          .sort(byCostDesc),
        topTransmissions: topRows
          .filter((r) => r.transmissionId !== null)
          .map((r) => ({
            transmissionId: r.transmissionId as string,
            tenantId: r.tenantId,
            ...asTotals(r),
          })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio — wrapper fino del store (patrón repo, igual que jobQueueService)
// ---------------------------------------------------------------------------

export function createAiUsageService(
  s: AiUsageStore = store(),
) {
  return {
    /** Mismo contrato best-effort que `recordAiUsageEvent` (nunca rechaza). */
    recordEvent(v: RecordAiUsageInput) {
      if (!v.tenantId) return Promise.resolve();
      return writeEvent(s, v);
    },
    summarize(filter: AiUsageSummaryFilter) {
      return s.summarize(filter);
    },
  };
}

export type AiUsageService = ReturnType<typeof createAiUsageService>;
