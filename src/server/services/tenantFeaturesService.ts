/**
 * tenantFeaturesService.ts — Feature flags por tenant
 *
 * Fuente única del catálogo de features de la plataforma y de los valores
 * efectivos por tenant. El valor efectivo SIEMPRE vive en la tabla
 * `tenant_features` (una fila por tenant+flag), con `source` indicando si el
 * valor viene del plan, de un override del owner o de un override del super admin.
 *
 * Regla de oro: un cambio de plan recalcula sólo las filas con `source = 'plan'`.
 * Los overrides nunca se pisan solos.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plans, subscriptions, tenantFeatures } from '../db/schema/index.js';
import type { FeatureSource } from '../db/schema/enums.js';
import { AppError } from '../lib/errors.js';

// ── Catálogo ──────────────────────────────────────────────────────────────────

export interface FeatureDefinition {
  key: string;
  name: string;
  description: string;
  /** Valor por defecto según el `name` del plan contratado. */
  byPlan: Record<string, boolean>;
  /** Valor cuando el plan no está en `byPlan` (o el tenant no tiene plan). */
  fallback: boolean;
}

/**
 * Catálogo de features vendibles. El orden es el que ve el admin.
 * Los nombres de plan siguen el seed de Épica B: trial, creator, media,
 * network, enterprise.
 */
export const FEATURE_CATALOG: readonly FeatureDefinition[] = [
  {
    key: 'pipeline_editor',
    name: 'Editor de pipeline',
    description: 'Configurar pasos y agentes del pipeline editorial.',
    byPlan: { trial: true, creator: true, media: true, network: true, enterprise: true },
    fallback: true,
  },
  {
    key: 'content_multiplier',
    name: 'Multiplicador de contenido',
    description: 'Generar versiones para redes a partir de una nota.',
    byPlan: { trial: false, creator: true, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'clips',
    name: 'Auto-clips verticales',
    description: 'Cortes verticales con subtítulos a partir del audio.',
    byPlan: { trial: false, creator: true, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'public_surfaces',
    name: 'Páginas públicas y RSS',
    description: 'Publicar el programa en la web y en feeds.',
    byPlan: { trial: false, creator: true, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'live_alerts',
    name: 'Alertas en vivo',
    description: 'Detección de keywords en vivo con avisos en tiempo real.',
    byPlan: { trial: false, creator: false, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'guest_dossiers',
    name: 'Dossiers de invitados',
    description: 'Investigación automática y dossier por invitado.',
    byPlan: { trial: false, creator: false, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'white_label',
    name: 'Marca propia',
    description: 'Branding propio (logo, tipografía, plantillas).',
    byPlan: { trial: false, creator: true, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'multi_program',
    name: 'Multi-programa',
    description: 'Administrar más de un programa en el mismo tenant.',
    byPlan: { trial: false, creator: false, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'api_access',
    name: 'Acceso por API',
    description: 'API keys propias y webhooks salientes.',
    byPlan: { trial: false, creator: false, media: false, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'priority_support',
    name: 'Soporte prioritario',
    description: 'Canal directo y SLA de respuesta.',
    byPlan: { trial: false, creator: false, media: false, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'ai_image_models',
    name: 'Modelos de imagen IA',
    description: 'Generación de imágenes con provider seleccionable y fallback.',
    byPlan: { trial: false, creator: true, media: true, network: true, enterprise: true },
    fallback: false,
  },
  {
    key: 'auto_publish',
    name: 'Auto-publicación',
    description: 'Publicación automática del contenido aprobado según configuración por programa.',
    byPlan: { trial: false, creator: true, media: true, network: true, enterprise: true },
    fallback: false,
  },
] as const;

export const FEATURE_KEYS = FEATURE_CATALOG.map((f) => f.key);

export function getFeatureDefinition(key: string): FeatureDefinition | undefined {
  return FEATURE_CATALOG.find((f) => f.key === key);
}

export function assertFeatureKey(key: string): FeatureDefinition {
  const def = getFeatureDefinition(key);
  if (!def) throw new AppError(`Feature desconocido: ${key}`, 400, 'UNKNOWN_FEATURE');
  return def;
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

export type PlanLike = { id: string; name: string; features?: unknown } | null;

export interface FeatureState {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  limitValue: number | null;
  source: FeatureSource;
  planDefaultEnabled: boolean;
  overriddenAt: Date | null;
  updatedAt: Date | null;
}

// ── Resolución de defaults ────────────────────────────────────────────────────

/**
 * Resuelve el valor que corresponde a cada flag según el plan.
 * Prioridad: `plans.features` (jsonb, editable desde admin) → `byPlan` → `fallback`.
 */
export function resolvePlanFeatureDefaults(plan: PlanLike): Record<string, boolean> {
  const configured: Record<string, unknown> =
    plan && plan.features && typeof plan.features === 'object'
      ? (plan.features as Record<string, unknown>)
      : {};

  const out: Record<string, boolean> = {};
  for (const def of FEATURE_CATALOG) {
    const explicit = configured[def.key];
    const fromPlan = plan ? def.byPlan[plan.name] : undefined;
    out[def.key] = typeof explicit === 'boolean' ? explicit : (fromPlan ?? def.fallback);
  }
  return out;
}

/** Filas listas para insertar al crear un tenant (defaults del plan). */
export function buildFeatureRowsForPlan(tenantId: string, plan: PlanLike) {
  const defaults = resolvePlanFeatureDefaults(plan);
  return FEATURE_CATALOG.map((def) => ({
    tenantId,
    featureKey: def.key,
    enabled: defaults[def.key],
    planDefaultEnabled: defaults[def.key],
    planId: plan?.id ?? null,
    source: 'plan' as FeatureSource,
  }));
}

// ── Lectura ───────────────────────────────────────────────────────────────────

export async function getTenantPlan(tenantId: string): Promise<PlanLike> {
  const rows = await db
    .select({ plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  return rows[0]?.plan ?? null;
}

/** Mapa completo (catálogo + estado efectivo) para un tenant. */
export async function getTenantFeatureMap(tenantId: string): Promise<Record<string, FeatureState>> {
  const rows = await db
    .select()
    .from(tenantFeatures)
    .where(eq(tenantFeatures.tenantId, tenantId));

  const byKey = new Map(rows.map((r) => [r.featureKey, r]));

  const out: Record<string, FeatureState> = {};
  for (const def of FEATURE_CATALOG) {
    const row = byKey.get(def.key);
    out[def.key] = {
      key: def.key,
      name: def.name,
      description: def.description,
      enabled: row?.enabled ?? def.fallback,
      limitValue: row?.limitValue ?? null,
      source: (row?.source ?? 'plan') as FeatureSource,
      planDefaultEnabled: row?.planDefaultEnabled ?? def.fallback,
      overriddenAt: row?.overriddenAt ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  }
  return out;
}

/**
 * Chequeo puntual de un flag. `tenantId` es obligatorio: nunca se consulta
 * sin tenant para no filtrar features entre organizaciones.
 */
export async function isFeatureEnabled(tenantId: string, key: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: tenantFeatures.enabled })
    .from(tenantFeatures)
    .where(and(eq(tenantFeatures.tenantId, tenantId), eq(tenantFeatures.featureKey, key)))
    .limit(1);
  return row?.enabled ?? false;
}

// ── Escritura ─────────────────────────────────────────────────────────────────

/**
 * Recalcula las filas `source = 'plan'` según el plan actual del tenant.
 * Idempotente: se puede llamar en cada cambio de plan, en el registro y desde
 * un job de reconciliación. Nunca toca overrides.
 */
export async function syncTenantFeaturesForTenant(tenantId: string): Promise<void> {
  const plan = await getTenantPlan(tenantId);
  const defaults = resolvePlanFeatureDefaults(plan);
  const rows = await db
    .select({ id: tenantFeatures.id, featureKey: tenantFeatures.featureKey, source: tenantFeatures.source })
    .from(tenantFeatures)
    .where(eq(tenantFeatures.tenantId, tenantId));
  const byKey = new Map(rows.map((r) => [r.featureKey, r]));

  for (const def of FEATURE_CATALOG) {
    const enabled = defaults[def.key];
    const existing = byKey.get(def.key);

    if (!existing) {
      await db
        .insert(tenantFeatures)
        .values({
          tenantId,
          featureKey: def.key,
          enabled,
          planDefaultEnabled: enabled,
          planId: plan?.id ?? null,
          source: 'plan',
        })
        .onConflictDoNothing();
      continue;
    }

    if (existing.source !== 'plan') continue;

    await db
      .update(tenantFeatures)
      .set({ enabled, planDefaultEnabled: enabled, planId: plan?.id ?? null })
      .where(eq(tenantFeatures.id, existing.id));
  }
}

export interface SetFeatureFlagInput {
  tenantId: string;
  featureKey: string;
  enabled: boolean;
  /** 'override' = owner del tenant; 'admin' = super admin de plataforma. */
  source: Exclude<FeatureSource, 'plan'>;
  changedByUserId: string;
  limitValue?: number | null;
  notes?: string | null;
}

/**
 * Pisa el valor efectivo de un flag. Sólo para owners (override) y super admins
 * (admin) — la autorización se valida en la ruta, acá se persiste.
 */
export async function setFeatureFlag(input: SetFeatureFlagInput): Promise<FeatureState> {
  const def = assertFeatureKey(input.featureKey);
  const { tenantId, featureKey, enabled, source, changedByUserId } = input;

  const [existing] = await db
    .select()
    .from(tenantFeatures)
    .where(and(eq(tenantFeatures.tenantId, tenantId), eq(tenantFeatures.featureKey, featureKey)))
    .limit(1);

  if (existing) {
    await db
      .update(tenantFeatures)
      .set({
        enabled,
        source,
        limitValue: input.limitValue === undefined ? existing.limitValue : input.limitValue,
        notes: input.notes === undefined ? existing.notes : input.notes,
        overriddenByUserId: changedByUserId,
        overriddenAt: new Date(),
      })
      .where(eq(tenantFeatures.id, existing.id));
  } else {
    const plan = await getTenantPlan(tenantId);
    const defaults = resolvePlanFeatureDefaults(plan);
    await db
      .insert(tenantFeatures)
      .values({
        tenantId,
        featureKey,
        enabled,
        planDefaultEnabled: defaults[featureKey] ?? def.fallback,
        planId: plan?.id ?? null,
        source,
        limitValue: input.limitValue ?? null,
        notes: input.notes ?? null,
        overriddenByUserId: changedByUserId,
        overriddenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [tenantFeatures.tenantId, tenantFeatures.featureKey],
        set: { enabled, source, overriddenByUserId: changedByUserId, overriddenAt: new Date() },
      });
  }

  const map = await getTenantFeatureMap(tenantId);
  return map[featureKey];
}

/**
 * Vuelve un flag al valor del plan (borra el override).
 * Usado por el super admin y por el owner cuando "restaura default".
 */
export async function resetFeatureOverride(
  tenantId: string,
  featureKey: string,
  changedByUserId: string,
): Promise<FeatureState> {
  assertFeatureKey(featureKey);

  const plan = await getTenantPlan(tenantId);
  const defaults = resolvePlanFeatureDefaults(plan);
  const enabled = defaults[featureKey] ?? false;

  const [existing] = await db
    .select({ id: tenantFeatures.id })
    .from(tenantFeatures)
    .where(and(eq(tenantFeatures.tenantId, tenantId), eq(tenantFeatures.featureKey, featureKey)))
    .limit(1);

  if (existing) {
    await db
      .update(tenantFeatures)
      .set({
        enabled,
        planDefaultEnabled: enabled,
        planId: plan?.id ?? null,
        source: 'plan',
        overriddenByUserId: changedByUserId,
        overriddenAt: new Date(),
      })
      .where(eq(tenantFeatures.id, existing.id));
  } else {
    await db
      .insert(tenantFeatures)
      .values({
        tenantId,
        featureKey,
        enabled,
        planDefaultEnabled: enabled,
        planId: plan?.id ?? null,
        source: 'plan',
      })
      .onConflictDoNothing();
  }

  const map = await getTenantFeatureMap(tenantId);
  return map[featureKey];
}

/** Cuenta de flags activos por tenant — usado por el listado de super admin. */
export async function countEnabledFeatures(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(tenantFeatures)
    .where(and(eq(tenantFeatures.tenantId, tenantId), eq(tenantFeatures.enabled, true)));
  return row?.total ?? 0;
}
