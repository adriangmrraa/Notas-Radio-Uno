import { db } from '../db/index.js';
import { tenantFeatures, subscriptions, plans } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// featureFlagService — flags por tenant con precedencia (spec feature-flags)
//   override vigente (tenant_features, expires_at no vencido)
//   → plan (plans.features jsonb)
//   → default de plataforma (FEATURE_DEFAULTS)
// Caché con invalidación explícita (invalidateFeature al escribir overrides).
// ---------------------------------------------------------------------------

/** Catálogo de flags conocidos — default seguro: superficie nueva OFF. */
export const FEATURE_DEFAULTS: Record<string, unknown> = {
    live_video: false,
    face_attribution: false,
    zernio_publishing: false,
    auto_publish: false,
    image_models_multi: false,
    admin_console: false,
};

export type FeatureKey = keyof typeof FEATURE_DEFAULTS | (string & {});

type FeatureValue = unknown;

// Caché: `${tenantId}:${key}` → value resuelto (incluye capa plan+default).
const cache = new Map<string, FeatureValue>();
const warnedUnknownKeys = new Set<string>();

function cacheKey(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
}

/**
 * Resuelve el valor efectivo de un flag para un tenant:
 * override vigente → plan → default. Flags desconocidos → default seguro (off)
 * + warning una sola vez por key.
 */
export async function resolveFeature(tenantId: string, key: FeatureKey): Promise<FeatureValue> {
    const ck = cacheKey(tenantId, key);
    if (cache.has(ck)) return cache.get(ck);

    const value = await resolveUncached(tenantId, key);
    cache.set(ck, value);
    return value;
}

async function resolveUncached(tenantId: string, key: string): Promise<FeatureValue> {
    // 1) Override vigente del tenant (expires_at null o futuro)
    const [override] = await db.select().from(tenantFeatures)
        .where(and(eq(tenantFeatures.tenantId, tenantId), eq(tenantFeatures.key, key)))
        .limit(1);

    if (override && (!override.expiresAt || override.expiresAt > new Date())) {
        return override.value;
    }

    // 2) Capa plan: plans.features[key]
    const [subRow] = await db.select({ features: plans.features })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);

    const planFeatures = (subRow?.features ?? {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(planFeatures, key)) {
        return planFeatures[key];
    }

    // 3) Default de plataforma
    if (Object.prototype.hasOwnProperty.call(FEATURE_DEFAULTS, key)) {
        return FEATURE_DEFAULTS[key];
    }

    if (!warnedUnknownKeys.has(key)) {
        warnedUnknownKeys.add(key);
        console.warn(`[FeatureFlags] flag desconocido '${key}' — resolviendo default seguro (off)`);
    }
    return false;
}

/** Un flag está habilitado si es `true` o un objeto de config con `enabled !== false`. */
export function isEnabled(value: FeatureValue): boolean {
    if (value === true) return true;
    if (value && typeof value === 'object') {
        return (value as { enabled?: boolean }).enabled !== false;
    }
    return false;
}

export async function featureEnabled(tenantId: string, key: FeatureKey): Promise<boolean> {
    return isEnabled(await resolveFeature(tenantId, key));
}

/**
 * Escribe/actualiza un override de tenant e invalida caché (switch inmediato).
 */
export async function setTenantFeature(
    tenantId: string,
    key: string,
    value: unknown,
    opts: { expiresAt?: Date | null; setBy?: string | null } = {},
): Promise<void> {
    await db.insert(tenantFeatures)
        .values({
            tenantId,
            key,
            value,
            expiresAt: opts.expiresAt ?? null,
            setBy: opts.setBy ?? null,
        })
        .onConflictDoUpdate({
            target: [tenantFeatures.tenantId, tenantFeatures.key],
            set: {
                value,
                expiresAt: opts.expiresAt ?? null,
                setBy: opts.setBy ?? null,
            },
        });
    invalidateFeature(tenantId, key);
}

export async function deleteTenantFeature(tenantId: string, key: string): Promise<void> {
    await db.delete(tenantFeatures)
        .where(and(eq(tenantFeatures.tenantId, tenantId), eq(tenantFeatures.key, key)));
    invalidateFeature(tenantId, key);
}

/** Invalida caché — por (tenant,key) puntual, todo el tenant, o todo. */
export function invalidateFeature(tenantId?: string, key?: string): void {
    if (!tenantId) {
        cache.clear();
        return;
    }
    if (!key) {
        for (const ck of cache.keys()) {
            if (ck.startsWith(`${tenantId}:`)) cache.delete(ck);
        }
        return;
    }
    cache.delete(cacheKey(tenantId, key));
}

/** Devuelve todos los flags efectivos del tenant (para /me o useFeature). */
export async function resolveAllFeatures(tenantId: string): Promise<Record<string, unknown>> {
    const keys = new Set<string>(Object.keys(FEATURE_DEFAULTS));

    const [overrides, subRow] = await Promise.all([
        db.select({ key: tenantFeatures.key }).from(tenantFeatures)
            .where(eq(tenantFeatures.tenantId, tenantId)),
        db.select({ features: plans.features }).from(subscriptions)
            .innerJoin(plans, eq(subscriptions.planId, plans.id))
            .where(eq(subscriptions.tenantId, tenantId))
            .limit(1),
    ]);

    for (const o of overrides) keys.add(o.key);
    for (const k of Object.keys((subRow[0]?.features ?? {}) as Record<string, unknown>)) keys.add(k);

    const out: Record<string, unknown> = {};
    for (const key of keys) {
        out[key] = await resolveFeature(tenantId, key);
    }
    return out;
}

/**
 * Middleware: exige flag habilitado para el tenant activo → 403 FEATURE_DISABLED.
 * El guard server-side es la autoridad (ocultar en UI no es enforcement).
 */
export function requireFeature(key: FeatureKey) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!req.auth?.tenantId) {
            res.status(401).json({ error: 'No autenticado' });
            return;
        }
        try {
            const value = await resolveFeature(req.auth.tenantId, key);
            if (!isEnabled(value)) {
                res.status(403).json({
                    error: 'Funcionalidad no habilitada para tu plan/tenant',
                    code: 'FEATURE_DISABLED',
                    feature: key,
                });
                return;
            }
            next();
        } catch (err) {
            console.error(`[FeatureFlags] requireFeature('${key}') error:`, err);
            res.status(500).json({ error: 'Error evaluando feature flag' });
        }
    };
}
