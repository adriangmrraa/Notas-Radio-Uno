/**
 * PG-07 — Canal de publicación por tenant: migración gradual legacy → Zernio.
 *
 * Un tenant puede estar en uno de tres modos (persistido en `settings` con la
 * clave `publish_channel_mode` — sin migración de esquema):
 *
 *   - 'hybrid'  : DEFAULT (y valor efectivo cuando no hay fila en settings).
 *                 Zernio para las plataformas ya conectadas; Meta/Twitter
 *                 directo para los portfolios/assets legacy que todavía no se
 *                 migraron. Es el comportamiento actual, así un tenant sin
 *                 config no ve ninguna regresión.
 *   - 'zernio'  : todo lo publicable va por Zernio; el camino legacy de
 *                 Meta/Twitter sólo corre bajo demanda explícita
 *                 (`forceLegacy` en el approve → "publicar por canal legacy").
 *   - 'legacy'  : Meta/Twitter siguen por el circuito directo
 *                 (publishService/metaPublishService/twitterService); las
 *                 plataformas nuevas (TikTok, YouTube, LinkedIn, …) publican
 *                 por Zernio cuando hay conexión.
 *
 * Resolución por plataforma (una sola fuente de verdad):
 *
 *   - Plataforma nueva (no Meta/Twitter): 'zernio' si hay conexión conectada;
 *     'none' con motivo en español si no — NUNCA legacy.
 *   - Meta/Twitter en 'hybrid'/'legacy': 'legacy' si tiene camino legacy
 *     (asset legacy activo del tipo que mapea la plataforma — o el bot
 *     tenant-agnóstico de Twitter por env para 'twitter'). En 'hybrid', si hay
 *     conexión Zernio Y ningún asset legacy activo está marcado `legacy-only`
 *     (business_assets.metadata.legacyOnly === true), gana 'zernio'.
 *   - Meta/Twitter en 'zernio': 'zernio' si hay conexión; 'none' si no
 *     (legacy queda explícito, vía forceLegacy).
 *   - forceLegacy (por publicación): Meta/Twitter con camino legacy →
 *     'legacy'; sin camino → 'none'. Las plataformas nuevas no cambian.
 *
 * "Camino legacy" = hay al menos un `business_assets` activo del tipo
 * legacy de la plataforma ('facebook_page'/'instagram_account'/
 * 'twitter_account'); para 'twitter' también cuenta el bot configurado por
 * variables de entorno (tenant-agnóstico, es lo que corre hoy). Si un asset
 * activo está marcado legacy-only, TODA la plataforma queda anclada a legacy
 * (publishToAllMeta publica a todos los assets activos del tipo — el split es
 * por plataforma, no por asset).
 *
 * Las consultas son tenant-scoped: settings por (tenant_id,key) y assets por
 * tenant_id. El store es inyectable para tests deterministas en memoria.
 */
import { and, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { businessAssets, settings } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import {
    AUTO_PUBLISH_PLATFORMS,
    type AutoPublishPlatform,
} from './autoPublishService.js';
import {
    listSocialConnections,
    type SocialConnectionRow,
} from './socialConnectionsService.js';

// ─── Constantes ──────────────────────────────────────────────────────────────

export const PUBLISH_CHANNEL_MODES = ['hybrid', 'zernio', 'legacy'] as const;
export type PublishChannelMode = (typeof PUBLISH_CHANNEL_MODES)[number];

export const PUBLISH_CHANNEL_MODE_KEY = 'publish_channel_mode';
/** Default efectivo cuando el tenant no tiene fila en settings. */
export const DEFAULT_PUBLISH_CHANNEL_MODE: PublishChannelMode = 'hybrid';

/** Clave en business_assets.metadata que ancla la plataforma al canal legacy. */
export const LEGACY_ONLY_METADATA_KEY = 'legacyOnly';

/**
 * Plataformas con canal legacy directo (Meta Graph + bot de Twitter por env).
 * Todo lo demás es "plataforma nueva" → sólo Zernio.
 */
export const LEGACY_PLATFORMS = ['facebook', 'instagram', 'twitter'] as const;
export type LegacyPlatform = (typeof LEGACY_PLATFORMS)[number];

export function isLegacyPlatform(platform: string): platform is LegacyPlatform {
    return (LEGACY_PLATFORMS as readonly string[]).includes(platform);
}

/** Tipo de business_asset que constituye el camino legacy de cada plataforma. */
export const LEGACY_ASSET_TYPE_BY_PLATFORM: Record<LegacyPlatform, string> = {
    facebook: 'facebook_page',
    instagram: 'instagram_account',
    twitter: 'twitter_account',
};

export function platformForLegacyAssetType(
    assetType: string,
): LegacyPlatform | null {
    for (const [platform, type] of Object.entries(
        LEGACY_ASSET_TYPE_BY_PLATFORM,
    ) as [LegacyPlatform, string][]) {
        if (type === assetType) return platform;
    }
    return null;
}

export type PublishChannel = 'zernio' | 'legacy' | 'none';

export function isPublishChannelMode(v: unknown): v is PublishChannelMode {
    return (
        typeof v === 'string' &&
        (PUBLISH_CHANNEL_MODES as readonly string[]).includes(v)
    );
}

// ─── Tipos del store ─────────────────────────────────────────────────────────

export interface PublishChannelAsset {
    id: string;
    tenantId: string;
    assetType: string;
    externalId: string;
    name: string | null;
    metadata: Record<string, unknown>;
    isActive: boolean;
}

export interface PublishChannelStore {
    getSetting(tenantId: string, key: string): Promise<string | null>;
    upsertSetting(tenantId: string, key: string, value: string): Promise<void>;
    /** Assets legacy activos del tenant (filtro tenant_id + is_active). */
    listActiveAssets(tenantId: string): Promise<PublishChannelAsset[]>;
    getAssetById(
        tenantId: string,
        assetId: string,
    ): Promise<PublishChannelAsset | null>;
    /** Reemplaza metadata (JSONB) — preserva el resto de la fila. */
    updateAssetMetadata(
        tenantId: string,
        assetId: string,
        metadata: Record<string, unknown>,
    ): Promise<PublishChannelAsset | null>;
}

export function createDrizzlePublishChannelStore(
    executor: Database = db,
): PublishChannelStore {
    return {
        async getSetting(tenantId, key) {
            const rows = await executor
                .select({ value: settings.value })
                .from(settings)
                .where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)))
                .limit(1);
            return rows[0]?.value ?? null;
        },

        async upsertSetting(tenantId, key, value) {
            await executor
                .insert(settings)
                .values({ tenantId, key, value })
                .onConflictDoUpdate({
                    target: [settings.tenantId, settings.key],
                    set: { value, updatedAt: new Date() },
                });
        },

        async listActiveAssets(tenantId) {
            const rows = await executor
                .select()
                .from(businessAssets)
                .where(
                    and(
                        eq(businessAssets.tenantId, tenantId),
                        eq(businessAssets.isActive, true),
                    ),
                );
            return rows.map((r) => ({
                id: r.id,
                tenantId: r.tenantId,
                assetType: r.assetType,
                externalId: r.externalId,
                name: r.name,
                metadata: (r.metadata ?? {}) as Record<string, unknown>,
                isActive: r.isActive,
            }));
        },

        async getAssetById(tenantId, assetId) {
            const rows = await executor
                .select()
                .from(businessAssets)
                .where(
                    and(
                        eq(businessAssets.tenantId, tenantId),
                        eq(businessAssets.id, assetId),
                    ),
                )
                .limit(1);
            const r = rows[0];
            return r
                ? {
                      id: r.id,
                      tenantId: r.tenantId,
                      assetType: r.assetType,
                      externalId: r.externalId,
                      name: r.name,
                      metadata: (r.metadata ?? {}) as Record<string, unknown>,
                      isActive: r.isActive,
                  }
                : null;
        },

        async updateAssetMetadata(tenantId, assetId, metadata) {
            const rows = await executor
                .update(businessAssets)
                .set({ metadata, updatedAt: new Date() })
                .where(
                    and(
                        eq(businessAssets.tenantId, tenantId),
                        eq(businessAssets.id, assetId),
                    ),
                )
                .returning();
            const r = rows[0];
            return r
                ? {
                      id: r.id,
                      tenantId: r.tenantId,
                      assetType: r.assetType,
                      externalId: r.externalId,
                      name: r.name,
                      metadata: (r.metadata ?? {}) as Record<string, unknown>,
                      isActive: r.isActive,
                  }
                : null;
        },
    };
}

// ─── Dependencias inyectables ────────────────────────────────────────────────

export interface PublishChannelDeps {
    store?: PublishChannelStore;
    /** Conexiones Zernio del tenant — default `listSocialConnections`. */
    listConnections?: (tenantId: string) => Promise<SocialConnectionRow[]>;
    /**
     * Bot de Twitter legacy configurado por env (tenant-agnóstico — es lo que
     * corre hoy cuando `publishToChannels` ve una URL de Drive). Default:
     * variables TWITTER_* completas.
     */
    envTwitterBot?: boolean;
}

function defaultEnvTwitterBot(): boolean {
    return Boolean(
        process.env.TWITTER_API_KEY &&
            process.env.TWITTER_API_SECRET &&
            process.env.TWITTER_ACCESS_TOKEN &&
            process.env.TWITTER_ACCESS_SECRET,
    );
}

function resolveStore(deps?: PublishChannelDeps): PublishChannelStore {
    return deps?.store ?? createDrizzlePublishChannelStore();
}

// ─── Modo del tenant ─────────────────────────────────────────────────────────

/**
 * Modo efectivo del tenant: la fila en settings si existe y es válida;
 * `DEFAULT_PUBLISH_CHANNEL_MODE` ('hybrid') en cualquier otro caso — así un
 * tenant sin config (o con un valor corrupto legado) conserva el
 * comportamiento actual.
 */
export async function getPublishChannelMode(
    tenantId: string,
    deps?: PublishChannelDeps,
): Promise<PublishChannelMode> {
    const raw = await resolveStore(deps).getSetting(
        tenantId,
        PUBLISH_CHANNEL_MODE_KEY,
    );
    return isPublishChannelMode(raw) ? raw : DEFAULT_PUBLISH_CHANNEL_MODE;
}

export async function setPublishChannelMode(
    tenantId: string,
    mode: PublishChannelMode,
    deps?: PublishChannelDeps,
): Promise<PublishChannelMode> {
    if (!isPublishChannelMode(mode)) {
        throw new AppError(
            `Modo inválido: '${mode}'. Valores: ${PUBLISH_CHANNEL_MODES.join(', ')}.`,
            400,
            'invalid_channel_mode',
        );
    }
    await resolveStore(deps).upsertSetting(
        tenantId,
        PUBLISH_CHANNEL_MODE_KEY,
        mode,
    );
    return mode;
}

// ─── Marca legacy-only sobre assets ──────────────────────────────────────────

export function isLegacyOnlyAsset(asset: {
    metadata: Record<string, unknown>;
}): boolean {
    return asset.metadata?.[LEGACY_ONLY_METADATA_KEY] === true;
}

/**
 * Marca/desmarca un asset legacy como `legacy-only` (explícito y persistido en
 * metadata.legacyOnly — nunca inferido). Sólo aplica a assets cuyo assetType
 * mapea a una plataforma legacy; cualquier otro tipo devuelve 400.
 */
export async function setAssetLegacyOnly(
    tenantId: string,
    assetId: string,
    legacyOnly: boolean,
    deps?: PublishChannelDeps,
): Promise<PublishChannelAsset> {
    const store = resolveStore(deps);
    const asset = await store.getAssetById(tenantId, assetId);
    if (!asset) {
        throw new AppError('Asset no encontrado.', 404, 'asset_not_found');
    }
    if (!platformForLegacyAssetType(asset.assetType)) {
        throw new AppError(
            `El asset '${asset.assetType}' no corresponde a un canal legacy (facebook_page/instagram_account/twitter_account).`,
            400,
            'invalid_legacy_asset',
        );
    }
    const metadata = { ...asset.metadata, [LEGACY_ONLY_METADATA_KEY]: legacyOnly };
    const updated = await store.updateAssetMetadata(tenantId, assetId, metadata);
    if (!updated) {
        throw new AppError('Asset no encontrado.', 404, 'asset_not_found');
    }
    return updated;
}

// ─── Resolución por plataforma ───────────────────────────────────────────────

export interface PublishChannelResolution {
    platform: string;
    channel: PublishChannel;
    /** Motivo en español cuando channel === 'none' (la UI lo muestra). */
    reason: string | null;
    /** La plataforma tiene camino legacy directo configurado (assets/env). */
    hasLegacyPath: boolean;
}

/**
 * Estado pre-calculado para resolver en O(1): todo lo que la resolución
 * necesita, ya cargado y filtrado por tenant.
 */
export interface PublishChannelSnapshot {
    mode: PublishChannelMode;
    /** Plataformas con al menos una conexión Zernio 'connected'. */
    zernioPlatforms: ReadonlySet<string>;
    /** Assets legacy activos agrupados por plataforma. */
    legacyAssetsByPlatform: ReadonlyMap<string, PublishChannelAsset[]>;
    envTwitterBot: boolean;
}

export interface PublishChannelPlan {
    mode: PublishChannelMode;
    forceLegacy: boolean;
    resolve: (platform: string) => PublishChannelResolution;
    /** Plataformas legacy-capable resueltas 'legacy' (post modo). */
    legacyPlatforms: string[];
}

/**
 * Resolver puro a partir del snapshot — exportado para tests y para que el
 * servicio de jobs construya planes sin volver a tocar la DB.
 */
export function createChannelPlan(
    snapshot: PublishChannelSnapshot,
    opts?: { forceLegacy?: boolean },
): PublishChannelPlan {
    const forceLegacy = opts?.forceLegacy === true;

    const resolve = (platform: string): PublishChannelResolution => {
        const hasZernio = snapshot.zernioPlatforms.has(platform);
        const legacyAssets = snapshot.legacyAssetsByPlatform.get(platform) ?? [];
        const anyMarkedLegacyOnly = legacyAssets.some(isLegacyOnlyAsset);
        const hasLegacyPath =
            isLegacyPlatform(platform) &&
            (legacyAssets.length > 0 ||
                (platform === 'twitter' && snapshot.envTwitterBot));

        if (!isLegacyPlatform(platform)) {
            // Plataforma nueva: sólo Zernio, nunca legacy.
            return hasZernio
                ? { platform, channel: 'zernio', hasLegacyPath: false, reason: null }
                : {
                      platform,
                      channel: 'none',
                      hasLegacyPath: false,
                      reason:
                          'Esta plataforma sólo publica por Zernio: conectá la cuenta en Conexiones.',
                  };
        }

        // Meta/Twitter — legacy-capable.
        if (forceLegacy) {
            return hasLegacyPath
                ? { platform, channel: 'legacy', hasLegacyPath, reason: null }
                : {
                      platform,
                      channel: 'none',
                      hasLegacyPath,
                      reason:
                          'No hay un canal legacy configurado para esta plataforma.',
                  };
        }

        switch (snapshot.mode) {
            case 'zernio':
                return hasZernio
                    ? { platform, channel: 'zernio', hasLegacyPath, reason: null }
                    : {
                          platform,
                          channel: 'none',
                          hasLegacyPath,
                          reason:
                              'Modo Zernio: el canal legacy queda sólo bajo demanda explícita. Conectá la cuenta en Conexiones o elegí "publicar por canal legacy" en la publicación.',
                      };
            case 'legacy':
                if (hasLegacyPath) {
                    return { platform, channel: 'legacy', hasLegacyPath, reason: null };
                }
                return hasZernio
                    ? { platform, channel: 'zernio', hasLegacyPath, reason: null }
                    : {
                          platform,
                          channel: 'none',
                          hasLegacyPath,
                          reason:
                              'Sin canal configurado: no hay asset legacy ni conexión Zernio para esta plataforma.',
                      };
            case 'hybrid':
            default:
                // Zernio gana si hay conexión y ningún asset ancló la plataforma.
                if (hasZernio && !anyMarkedLegacyOnly) {
                    return { platform, channel: 'zernio', hasLegacyPath, reason: null };
                }
                if (hasLegacyPath) {
                    return { platform, channel: 'legacy', hasLegacyPath, reason: null };
                }
                return hasZernio
                    ? { platform, channel: 'zernio', hasLegacyPath, reason: null }
                    : {
                          platform,
                          channel: 'none',
                          hasLegacyPath,
                          reason:
                              'Sin conexión Zernio ni canal legacy configurado: conectá la cuenta en Conexiones.',
                      };
        }
    };

    const legacyPlatforms = LEGACY_PLATFORMS.filter(
        (p) => resolve(p).channel === 'legacy',
    );

    return { mode: snapshot.mode, forceLegacy, resolve, legacyPlatforms };
}

/**
 * Carga el snapshot tenant-scoped (settings + conexiones + assets activos) y
 * devuelve el plan de resolución. Es la fuente única que usan el approve de
 * PG-05 y los endpoints de estado.
 */
export async function planPublishChannels(
    tenantId: string,
    deps?: PublishChannelDeps,
    opts?: { forceLegacy?: boolean },
): Promise<PublishChannelPlan> {
    const store = resolveStore(deps);
    const listConns = deps?.listConnections ?? listSocialConnections;
    const [mode, connections, assets] = await Promise.all([
        getPublishChannelMode(tenantId, deps),
        listConns(tenantId),
        store.listActiveAssets(tenantId),
    ]);

    const zernioPlatforms = new Set(
        connections
            .filter((c) => c.status === 'connected')
            .map((c) => c.platform),
    );

    const legacyAssetsByPlatform = new Map<string, PublishChannelAsset[]>();
    for (const asset of assets) {
        const platform = platformForLegacyAssetType(asset.assetType);
        if (!platform) continue;
        const bucket = legacyAssetsByPlatform.get(platform) ?? [];
        bucket.push(asset);
        legacyAssetsByPlatform.set(platform, bucket);
    }

    return createChannelPlan(
        {
            mode,
            zernioPlatforms,
            legacyAssetsByPlatform,
            envTwitterBot: deps?.envTwitterBot ?? defaultEnvTwitterBot(),
        },
        opts,
    );
}

/**
 * Resolución puntual (la firma que pide el brief):
 * `resolvePublishChannels({ tenantId, platform })` → canal elegido.
 */
export async function resolvePublishChannels(
    input: { tenantId: string; platform: string },
    deps?: PublishChannelDeps,
): Promise<PublishChannelResolution> {
    const plan = await planPublishChannels(input.tenantId, deps);
    return plan.resolve(input.platform);
}

// ─── Estado de migración para la UI ──────────────────────────────────────────

export interface PublishChannelPlatformStatus {
    platform: AutoPublishPlatform;
    channel: PublishChannel;
    reason: string | null;
    /** La plataforma tiene canal legacy directo (Meta/Twitter). */
    legacyCapable: boolean;
    /** Hay camino legacy configurado (assets activos y/o bot env de Twitter). */
    hasLegacyPath: boolean;
    zernioConnections: {
        id: string;
        username: string | null;
        displayName: string | null;
        accountId: string;
        status: string;
    }[];
    /** Assets legacy activos con su marca legacy-only (para el toggle UI). */
    legacyAssets: {
        id: string;
        name: string | null;
        assetType: string;
        externalId: string;
        legacyOnly: boolean;
    }[];
    /**
     * Hay assets legacy activos que todavía publican por el canal directo
     * (o que no tienen camino en modo zernio) — pendientes de migración.
     */
    pendingMigration: boolean;
}

export interface PublishChannelStatusResult {
    mode: PublishChannelMode;
    /** El default efectivo — se muestra cuando el tenant nunca configuró. */
    defaultMode: PublishChannelMode;
    /** El tenant tiene fila persistida en settings (false → default en uso). */
    configured: boolean;
    platforms: PublishChannelPlatformStatus[];
}

export async function getPublishChannelStatus(
    tenantId: string,
    deps?: PublishChannelDeps,
): Promise<PublishChannelStatusResult> {
    const store = resolveStore(deps);
    const listConns = deps?.listConnections ?? listSocialConnections;
    const [rawMode, connections, assets] = await Promise.all([
        store.getSetting(tenantId, PUBLISH_CHANNEL_MODE_KEY),
        listConns(tenantId),
        store.listActiveAssets(tenantId),
    ]);
    const mode = isPublishChannelMode(rawMode)
        ? rawMode
        : DEFAULT_PUBLISH_CHANNEL_MODE;

    const legacyAssetsByPlatform = new Map<string, PublishChannelAsset[]>();
    for (const asset of assets) {
        const platform = platformForLegacyAssetType(asset.assetType);
        if (!platform) continue;
        const bucket = legacyAssetsByPlatform.get(platform) ?? [];
        bucket.push(asset);
        legacyAssetsByPlatform.set(platform, bucket);
    }

    const plan = createChannelPlan({
        mode,
        zernioPlatforms: new Set(
            connections
                .filter((c) => c.status === 'connected')
                .map((c) => c.platform),
        ),
        legacyAssetsByPlatform,
        envTwitterBot: deps?.envTwitterBot ?? defaultEnvTwitterBot(),
    });

    const platforms: PublishChannelPlatformStatus[] = AUTO_PUBLISH_PLATFORMS.map(
        (platform) => {
            const resolution = plan.resolve(platform);
            const platformAssets = legacyAssetsByPlatform.get(platform) ?? [];
            return {
                platform,
                channel: resolution.channel,
                reason: resolution.reason,
                legacyCapable: isLegacyPlatform(platform),
                hasLegacyPath: resolution.hasLegacyPath,
                zernioConnections: connections
                    .filter((c) => c.platform === platform)
                    .map((c) => ({
                        id: c.id,
                        username: c.username,
                        displayName: c.displayName,
                        accountId: c.accountId,
                        status: c.status,
                    })),
                legacyAssets: platformAssets.map((a) => ({
                    id: a.id,
                    name: a.name,
                    assetType: a.assetType,
                    externalId: a.externalId,
                    legacyOnly: isLegacyOnlyAsset(a),
                })),
                pendingMigration:
                    platformAssets.length > 0 && resolution.channel !== 'zernio',
            };
        },
    );

    return {
        mode,
        defaultMode: DEFAULT_PUBLISH_CHANNEL_MODE,
        configured: isPublishChannelMode(rawMode),
        platforms,
    };
}
