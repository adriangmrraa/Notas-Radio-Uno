/**
 * socialConnectionsService — Conexión de cuentas sociales vía Zernio (PG-04).
 *
 * Flujo sin credenciales: el OAuth lo hospeda Zernio; PeriodistApp sólo
 * guarda identificadores opacos (`accountId` = `_id` de la cuenta en Zernio,
 * `profileId` del perfil del tenant). La API key de plataforma vive en el
 * cliente (`zernioService`) y nunca toca la DB, los logs ni las respuestas.
 *
 * Aislamiento multi-tenant:
 *   - Un perfil Zernio por tenant (`externalId = tenantId`); `profileId`
 *     aísla todas las llamadas. `ensureProfileForTenant` es idempotente:
 *     lee la fila local, si no existe hace POST /v1/profiles con
 *     Idempotency-Key y, si responde 409, recupera con
 *     GET /v1/profiles?externalId=.
 *   - El callback OAuth NO confía en nada que venga del query salvo el
 *     `state` firmado: HMAC-SHA256 compacto
 *     (`v1.<tenantId>.<platform>.<exp>.<sig>`) con secreto de servidor y
 *     expiración de 15 min. Sin state válido no se escribe nada; el
 *     `profileId` que devuelve Zernio debe además coincidir con el perfil
 *     del tenant.
 *
 * Límite de plan: `plans.max_connected_platforms` topa la cantidad de
 * plataformas DISTINTAS con status='connected' del tenant. Se chequea al
 * iniciar el connect (rechazo temprano) y otra vez en el callback antes
 * del upsert (el state no puede saltear el tope). NULL = sin tope.
 *
 * Patrón del repo: `SocialConnectionsStore` + `createDrizzleSocialConnectionsStore`
 * + memory store en tests — TODA query filtra por tenant_id. Plan, branding,
 * secreto del state y el cliente Zernio son deps inyectables.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, notInArray } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { socialConnections, zernioProfiles } from '../db/schema/socialConnections.js';
import { plans, subscriptions, tenants } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { loadTenantBranding } from './brandingService.js';
import { createZernioApi, type ZernioAccount, type ZernioApi } from './zernioService.js';

// ---------------------------------------------------------------------------
// Plataformas válidas — enum verificado del OpenAPI de Zernio
// (GET /v1/connect/{platform}). La UI sólo expone el subconjunto editorial
// (las de AUTO_PUBLISH_PLATFORMS); el servidor acepta el enum completo.
// ---------------------------------------------------------------------------

export const ZERNIO_PLATFORMS = [
    'facebook',
    'instagram',
    'linkedin',
    'twitter',
    'tiktok',
    'youtube',
    'threads',
    'reddit',
    'pinterest',
    'bluesky',
    'googlebusiness',
    'telegram',
    'snapchat',
    'discord',
    'slack',
    'whatsapp',
    'google',
    'microsoft',
] as const;
export type ZernioPlatform = (typeof ZERNIO_PLATFORMS)[number];

export function isZernioPlatform(v: string): v is ZernioPlatform {
    return (ZERNIO_PLATFORMS as readonly string[]).includes(v);
}

export const SOCIAL_CONNECTION_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type SocialConnectionStatus = (typeof SOCIAL_CONNECTION_STATUSES)[number];

/** TTL del state de conexión (15 min — criterio del brief). */
export const CONNECT_STATE_TTL_SEC = 15 * 60;

// ---------------------------------------------------------------------------
// State firmado — HMAC-SHA256 compacto
//   v1.<tenantId>.<platform>.<expEpochSec>.<sig>
// Compacto a propósito: el state viaja dentro del redirect_url de Zernio y
// para X (twitter) esa URL tiene un límite duro de ~258 chars URL-encoded —
// un JWT estándar no entraría. tenantId/platform/sig no contienen '.'
// ---------------------------------------------------------------------------

const resolveStateSecret = (deps?: SocialConnectionsDeps): string =>
    deps?.stateSecret ??
    process.env.ZERNIO_STATE_SECRET ??
    process.env.JWT_SECRET ??
    'dev-secret-change-in-production';

const b64url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const statePayloadOf = (tenantId: string, platform: string, exp: number): string =>
    `v1.${tenantId}.${platform}.${exp}`;

const stateSignature = (payload: string, secret: string): string =>
    b64url(createHmac('sha256', secret).update(payload).digest());

export function signConnectState(
    input: { tenantId: string; platform: string },
    secret: string,
    ttlSec: number = CONNECT_STATE_TTL_SEC,
    nowSec: number = Math.floor(Date.now() / 1000),
): string {
    const payload = statePayloadOf(input.tenantId, input.platform, nowSec + ttlSec);
    return `${payload}.${stateSignature(payload, secret)}`;
}

export interface ConnectStatePayload {
    tenantId: string;
    platform: string;
}

/**
 * Verifica firma + expiración. Devuelve null para cualquier state mal
 * formado, alterado o vencido — el callback no distingue el motivo.
 */
export function verifyConnectState(
    state: string,
    secret: string,
    nowSec: number = Math.floor(Date.now() / 1000),
): ConnectStatePayload | null {
    const parts = state.split('.');
    if (parts.length !== 5) return null;
    const [v, tenantId, platform, expRaw, sig] = parts;
    if (v !== 'v1' || !tenantId || !platform) return null;
    const exp = Number(expRaw);
    if (!Number.isInteger(exp) || exp <= nowSec) return null;
    const expected = stateSignature(statePayloadOf(tenantId, platform, exp), secret);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { tenantId, platform };
}

// ---------------------------------------------------------------------------
// Tipos + Store
// ---------------------------------------------------------------------------

export interface SocialConnectionRow {
    id: string;
    tenantId: string;
    platform: string;
    accountId: string;
    username: string | null;
    displayName: string | null;
    status: string;
    zernioProfileId: string;
    lastSyncedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ZernioProfileRow {
    id: string;
    tenantId: string;
    profileId: string;
    name: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface SocialConnectionWrite {
    tenantId: string;
    platform: string;
    accountId: string;
    username: string | null;
    displayName: string | null;
    status: string;
    zernioProfileId: string;
    lastSyncedAt: Date | null;
}

export interface ZernioProfileWrite {
    tenantId: string;
    profileId: string;
    name: string | null;
}

export interface SocialConnectionsStore {
    /** Todas las conexiones del tenant. */
    listConnections(tenantId: string): Promise<SocialConnectionRow[]>;
    /** Conexión por id; null si no existe o es ajena. */
    getConnectionById(tenantId: string, id: string): Promise<SocialConnectionRow | null>;
    /** INSERT … ON CONFLICT (tenant_id, platform, account_id) DO UPDATE. */
    upsertConnection(row: SocialConnectionWrite): Promise<SocialConnectionRow>;
    /**
     * Marca 'disconnected' las conexiones del tenant cuyo account_id Zernio
     * ya no reporta (status previo != 'disconnected'). Devuelve cuántas.
     */
    markMissingDisconnected(tenantId: string, keepAccountIds: string[], now: Date): Promise<number>;
    /** DELETE tenant-scoped; false si no existía/era ajena. */
    deleteConnection(tenantId: string, id: string): Promise<boolean>;
    /** Perfil Zernio del tenant; null si no existe. */
    getZernioProfile(tenantId: string): Promise<ZernioProfileRow | null>;
    /** INSERT … ON CONFLICT (tenant_id) DO UPDATE. */
    upsertZernioProfile(row: ZernioProfileWrite): Promise<ZernioProfileRow>;
    /** Nombre del tenant (para bautizar el perfil Zernio). */
    getTenantName(tenantId: string): Promise<string | null>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleSocialConnectionsStore(
    executor: Database = db,
): SocialConnectionsStore {
    return {
        async listConnections(tenantId) {
            return executor
                .select()
                .from(socialConnections)
                .where(eq(socialConnections.tenantId, tenantId))
                .orderBy(socialConnections.platform, socialConnections.createdAt);
        },

        async getConnectionById(tenantId, id) {
            const [row] = await executor
                .select()
                .from(socialConnections)
                .where(
                    and(
                        eq(socialConnections.id, id),
                        eq(socialConnections.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async upsertConnection(row) {
            const [saved] = await executor
                .insert(socialConnections)
                .values({
                    tenantId: row.tenantId,
                    platform: row.platform,
                    accountId: row.accountId,
                    username: row.username,
                    displayName: row.displayName,
                    status: row.status,
                    zernioProfileId: row.zernioProfileId,
                    lastSyncedAt: row.lastSyncedAt,
                })
                .onConflictDoUpdate({
                    target: [
                        socialConnections.tenantId,
                        socialConnections.platform,
                        socialConnections.accountId,
                    ],
                    set: {
                        username: row.username,
                        displayName: row.displayName,
                        status: row.status,
                        zernioProfileId: row.zernioProfileId,
                        lastSyncedAt: row.lastSyncedAt,
                        updatedAt: new Date(),
                    },
                })
                .returning();
            return saved;
        },

        async markMissingDisconnected(tenantId, keepAccountIds, now) {
            const conditions = [
                eq(socialConnections.tenantId, tenantId),
                eq(socialConnections.status, 'connected'),
            ];
            // notInArray con lista vacía marcaría todo — se resuelve aparte.
            if (keepAccountIds.length > 0) {
                conditions.push(notInArray(socialConnections.accountId, keepAccountIds));
            }
            const updated = await executor
                .update(socialConnections)
                .set({ status: 'disconnected', lastSyncedAt: now, updatedAt: now })
                .where(and(...conditions))
                .returning({ id: socialConnections.id });
            return updated.length;
        },

        async deleteConnection(tenantId, id) {
            const deleted = await executor
                .delete(socialConnections)
                .where(
                    and(
                        eq(socialConnections.id, id),
                        eq(socialConnections.tenantId, tenantId),
                    ),
                )
                .returning({ id: socialConnections.id });
            return deleted.length > 0;
        },

        async getZernioProfile(tenantId) {
            const [row] = await executor
                .select()
                .from(zernioProfiles)
                .where(eq(zernioProfiles.tenantId, tenantId))
                .limit(1);
            return row ?? null;
        },

        async upsertZernioProfile(row) {
            const [saved] = await executor
                .insert(zernioProfiles)
                .values({ tenantId: row.tenantId, profileId: row.profileId, name: row.name })
                .onConflictDoUpdate({
                    target: zernioProfiles.tenantId,
                    set: { profileId: row.profileId, name: row.name, updatedAt: new Date() },
                })
                .returning();
            return saved;
        },

        async getTenantName(tenantId) {
            const [row] = await executor
                .select({ name: tenants.name })
                .from(tenants)
                .where(eq(tenants.id, tenantId))
                .limit(1);
            return row?.name ?? null;
        },
    };
}

// ---------------------------------------------------------------------------
// Deps inyectables — los tests los pisan sin Neon ni red
// ---------------------------------------------------------------------------

export interface SocialConnectionsPlanInfo {
    name: string;
    maxConnectedPlatforms: number | null;
}

export interface SocialConnectionsBranding {
    brandName: string | null;
    logoUrl: string | null;
}

export interface SocialConnectionsDeps {
    store?: SocialConnectionsStore;
    /** Cliente Zernio — los tests inyectan un fake sin red. */
    zernio?: ZernioApi;
    /** Plan del tenant; null = sin plan / sin tope. */
    getPlan?: (tenantId: string) => Promise<SocialConnectionsPlanInfo | null>;
    /** Marca del tenant para la pantalla welcome de Zernio. */
    getBranding?: (tenantId: string) => Promise<SocialConnectionsBranding>;
    /** Secreto del state; default ZERNIO_STATE_SECRET ?? JWT_SECRET. */
    stateSecret?: string;
    /** Base pública de ESTA API para el callback; default env. */
    apiPublicUrl?: string;
    /** Frontend al que el callback redirige; default FRONTEND_URL. */
    frontendUrl?: string;
    /** Reloj inyectable (tests de expiración). */
    now?: () => Date;
}

const resolveStore = (deps?: SocialConnectionsDeps): SocialConnectionsStore =>
    deps?.store ?? createDrizzleSocialConnectionsStore();

const resolveZernio = (deps?: SocialConnectionsDeps): ZernioApi =>
    deps?.zernio ?? createZernioApi();

async function defaultGetPlan(tenantId: string): Promise<SocialConnectionsPlanInfo | null> {
    const [row] = await db
        .select({
            name: plans.name,
            maxConnectedPlatforms: plans.maxConnectedPlatforms,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
    return row ?? null;
}

const resolveGetPlan = (deps?: SocialConnectionsDeps) =>
    deps?.getPlan ?? defaultGetPlan;

async function defaultGetBranding(tenantId: string): Promise<SocialConnectionsBranding> {
    const branding = await loadTenantBranding(tenantId);
    return {
        brandName: branding.platformName || null,
        // El logo del tenant es un blob servido con auth — Zernio no podría
        // traerlo. logoUrl sólo si la plataforma publica una URL accesible.
        logoUrl: process.env.ZERNIO_BRAND_LOGO_URL ?? null,
    };
}

const resolveGetBranding = (deps?: SocialConnectionsDeps) =>
    deps?.getBranding ?? defaultGetBranding;

const resolveApiPublicUrl = (deps?: SocialConnectionsDeps): string =>
    (deps?.apiPublicUrl ??
        process.env.API_PUBLIC_URL ??
        process.env.FRONTEND_URL ??
        'http://localhost:3001'
    ).replace(/\/+$/, '');

const resolveFrontendUrl = (deps?: SocialConnectionsDeps): string =>
    (deps?.frontendUrl ?? process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

const resolveNow = (deps?: SocialConnectionsDeps): Date => deps?.now?.() ?? new Date();

// ---------------------------------------------------------------------------
// Perfil Zernio del tenant — idempotente (local → POST → 409 → GET)
// ---------------------------------------------------------------------------

/**
 * Devuelve el perfil Zernio del tenant, creándolo si hace falta.
 *
 * 1) Si la fila local existe, la devuelve (camino feliz).
 * 2) POST /v1/profiles {name, externalId=tenantId} + Idempotency-Key —
 *    un reintento con la misma key repite el 201 original.
 * 3) Si responde 409, GET /v1/profiles?externalId= y persiste lo hallado;
 *    si el GET tampoco lo trae, reintenta el alta UNA vez (carrera con un
 *    POST que aún procesa) y si sigue 409 → error honesto.
 */
export async function ensureProfileForTenant(
    tenantId: string,
    deps: SocialConnectionsDeps = {},
): Promise<ZernioProfileRow> {
    const store = resolveStore(deps);
    const local = await store.getZernioProfile(tenantId);
    if (local) return local;

    const api = resolveZernio(deps);
    const tenantName = (await store.getTenantName(tenantId)) ?? `Tenant ${tenantId.slice(0, 8)}`;

    const persist = async (profile: { id: string; name: string | null }) =>
        store.upsertZernioProfile({
            tenantId,
            profileId: profile.id,
            name: profile.name,
        });

    const recover = async (): Promise<ZernioProfileRow> => {
        const found = await api.findProfileByExternalId(tenantId);
        if (found) return persist(found);
        throw new AppError(
            'Zernio reportó un perfil duplicado pero no lo devolvió por externalId',
            502,
            'zernio_error',
        );
    };

    try {
        const created = await api.createProfile({
            name: tenantName,
            externalId: tenantId,
            idempotencyKey: `zernio-profile-${tenantId}`,
        });
        return await persist(created);
    } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 409) throw error;
        try {
            return await recover();
        } catch (recoveryError) {
            if (
                recoveryError instanceof AppError &&
                recoveryError.statusCode === 502 &&
                recoveryError.code === 'zernio_error'
            ) {
                // El GET no lo trajo: una sola reintenta de alta por si el
                // 409 era el "still processing" del Idempotency-Key.
                try {
                    const created = await api.createProfile({
                        name: tenantName,
                        externalId: tenantId,
                        idempotencyKey: `zernio-profile-${tenantId}`,
                    });
                    return await persist(created);
                } catch (retryError) {
                    if (retryError instanceof AppError && retryError.statusCode === 409) {
                        return recover();
                    }
                    throw retryError;
                }
            }
            throw recoveryError;
        }
    }
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function listSocialConnections(
    tenantId: string,
    deps: SocialConnectionsDeps = {},
): Promise<SocialConnectionRow[]> {
    return resolveStore(deps).listConnections(tenantId);
}

export interface SocialConnectionsPlanStatus {
    /** Tope de plataformas del plan; null = sin tope/sin plan. */
    maxPlatforms: number | null;
    /** Plataformas distintas con status='connected'. */
    usedPlatforms: number;
}

/** Tope del plan + uso actual — para la respuesta del GET. */
export async function getSocialConnectionsPlanStatus(
    tenantId: string,
    deps: SocialConnectionsDeps = {},
): Promise<SocialConnectionsPlanStatus> {
    const [plan, rows] = await Promise.all([
        resolveGetPlan(deps)(tenantId),
        resolveStore(deps).listConnections(tenantId),
    ]);
    return {
        maxPlatforms: plan?.maxConnectedPlatforms ?? null,
        usedPlatforms: new Set(
            rows.filter((r) => r.status === 'connected').map((r) => r.platform),
        ).size,
    };
}

/** Cuentas que Zernio reporta para el perfil del tenant (vista remota). */
export async function listRemoteAccounts(
    tenantId: string,
    deps: SocialConnectionsDeps = {},
): Promise<ZernioAccount[]> {
    const profile = await ensureProfileForTenant(tenantId, deps);
    const api = resolveZernio(deps);
    return api.listAccounts(profile.profileId);
}

// ---------------------------------------------------------------------------
// Límite de plan — plataformas distintas con status='connected'
// ---------------------------------------------------------------------------

/**
 * Si el plan define maxConnectedPlatforms, conectar una plataforma NUEVA
 * (sin conexiones activas previas) cuando el cupo está lleno → 403
 * `max_connected_platforms`. Re-conectar una plataforma ya en uso no suma.
 */
async function assertPlatformCapacity(
    tenantId: string,
    platform: string,
    deps: SocialConnectionsDeps,
): Promise<void> {
    const plan = await resolveGetPlan(deps)(tenantId);
    const max = plan?.maxConnectedPlatforms ?? null;
    if (max === null) return;
    const rows = await resolveStore(deps).listConnections(tenantId);
    const used = new Set(
        rows.filter((r) => r.status === 'connected').map((r) => r.platform),
    );
    if (!used.has(platform) && used.size >= max) {
        throw new AppError(
            `Tu plan permite hasta ${max} plataformas conectadas. Desconectá una o actualizá tu plan.`,
            403,
            'max_connected_platforms',
        );
    }
}

// ---------------------------------------------------------------------------
// Connect — authUrl con welcome + state firmado
// ---------------------------------------------------------------------------

export interface StartConnectResult {
    authUrl: string;
    state: string;
}

/**
 * Inicia el flujo OAuth hospedado por Zernio:
 *   plan gate → ensureProfile → branding del tenant →
 *   GET /v1/connect/{platform} con welcome=true + brandName/logoUrl →
 *   redirect_url = callback propio con state firmado (tenant + platform +
 *   exp 15 min).
 */
export async function startSocialConnect(
    tenantId: string,
    platform: string,
    deps: SocialConnectionsDeps = {},
): Promise<StartConnectResult> {
    if (!isZernioPlatform(platform)) {
        throw new AppError(
            `Plataforma inválida: '${platform}'. Válidas: ${ZERNIO_PLATFORMS.join(', ')}`,
            400,
            'invalid_platform',
        );
    }

    // Rechazo temprano por plan (el callback vuelve a chequear — el state
    // no puede saltear el tope).
    await assertPlatformCapacity(tenantId, platform, deps);

    const store = resolveStore(deps);
    const profile = await ensureProfileForTenant(tenantId, deps);
    const branding = await resolveGetBranding(deps)(tenantId);

    const secret = resolveStateSecret(deps);
    const state = signConnectState({ tenantId, platform }, secret);
    const callbackUrl =
        `${resolveApiPublicUrl(deps)}/api/social-connections/callback?state=${encodeURIComponent(state)}`;

    const api = resolveZernio(deps);
    const { authUrl } = await api.getConnectUrl({
        profileId: profile.profileId,
        platform,
        redirectUrl: callbackUrl,
        welcome: true,
        brandName: branding.brandName ?? undefined,
        logoUrl: branding.logoUrl ?? undefined,
    });

    return { authUrl, state };
}

// ---------------------------------------------------------------------------
// Callback — verifica state + profileId y recién ahí hace upsert
// ---------------------------------------------------------------------------

export interface CallbackQuery {
    state?: string;
    connected?: string;
    profileId?: string;
    accountId?: string;
    username?: string;
    error?: string;
    platform?: string;
    request_id?: string;
    stage?: string;
}

export interface CompleteConnectResult {
    platform: string;
    connection: SocialConnectionRow;
}

/** URL del frontend al que el callback redirige con el resultado. */
export function frontendUrlFor(deps: SocialConnectionsDeps = {}): string {
    return resolveFrontendUrl(deps);
}

/**
 * Procesa el retorno de Zernio al redirect_url propio.
 *
 * El `state` firmado es la única credencial: liga el callback a
 * tenantId + platform (15 min de vida). Nunca se acepta un tenantId del
 * query sin firmar, y el profileId devuelto debe coincidir con el perfil
 * del tenant. Recién después se valida `connected` y se hace el upsert
 * tenant-scoped (con el plan gate de nuevo).
 *
 * Errores (AppError): 400 invalid_state / connect_failed /
 * connection_not_confirmed / missing_account / invalid_state_platform;
 * 403 profile_mismatch / max_connected_platforms.
 */
export async function completeSocialConnect(
    query: CallbackQuery,
    deps: SocialConnectionsDeps = {},
): Promise<CompleteConnectResult> {
    const secret = resolveStateSecret(deps);
    const payload = query.state ? verifyConnectState(query.state, secret) : null;
    if (!payload) {
        throw new AppError('El enlace de conexión es inválido o expiró', 400, 'invalid_state');
    }
    const { tenantId, platform } = payload;

    // Zernio devuelve `error` + `platform` cuando el flujo falló o se negó.
    if (query.error) {
        throw new AppError(
            `La conexión con ${platform} no se completó (${query.error})`,
            400,
            'connect_failed',
        );
    }
    if (query.platform && query.platform !== platform) {
        throw new AppError('La plataforma del retorno no coincide', 400, 'invalid_state_platform');
    }

    // connected={platform} según el contrato de Zernio (se acepta 'true'
    // defensivamente — el platform autoritativo siempre es el del state).
    if (query.connected !== platform && query.connected !== 'true') {
        throw new AppError(
            'La conexión no fue confirmada por Zernio',
            400,
            'connection_not_confirmed',
        );
    }

    const profile = await ensureProfileForTenant(tenantId, deps);
    if (!query.profileId || query.profileId !== profile.profileId) {
        throw new AppError('El perfil devuelto no pertenece a tu organización', 403, 'profile_mismatch');
    }

    const accountId = query.accountId;
    if (!accountId) {
        throw new AppError('Zernio no devolvió la cuenta conectada', 400, 'missing_account');
    }

    // El plan gate corre también acá: el state no puede saltear el tope.
    await assertPlatformCapacity(tenantId, platform, deps);

    const connection = await resolveStore(deps).upsertConnection({
        tenantId,
        platform,
        accountId,
        username: query.username ?? null,
        displayName: null,
        status: 'connected',
        zernioProfileId: profile.profileId,
        lastSyncedAt: resolveNow(deps),
    });

    return { platform, connection };
}

// ---------------------------------------------------------------------------
// Disconnect — Zernio primero (propagando el error real), después local
// ---------------------------------------------------------------------------

export async function disconnectSocialConnection(
    tenantId: string,
    id: string,
    deps: SocialConnectionsDeps = {},
): Promise<void> {
    const store = resolveStore(deps);
    const connection = await store.getConnectionById(tenantId, id);
    if (!connection) {
        throw new AppError('Conexión no encontrada', 404, 'connection_not_found');
    }

    const api = resolveZernio(deps);
    try {
        await api.disconnectAccount(connection.accountId);
    } catch (error) {
        // 404 en Zernio = ya desconectada (1h de gracia) — la baja local sigue.
        const gone =
            error instanceof AppError &&
            (error.statusCode === 404 || error.code === 'account_not_found');
        if (!gone) throw error;
    }

    await store.deleteConnection(tenantId, id);
}

// ---------------------------------------------------------------------------
// Sync — re-sincroniza lo que Zernio reporta con la tabla local
// ---------------------------------------------------------------------------

export interface SyncResult {
    connections: SocialConnectionRow[];
    /** Cuentas remotas procesadas. */
    synced: number;
    /** Filas locales marcadas 'disconnected' por ausencia en Zernio. */
    markedDisconnected: number;
}

/**
 * Re-sincroniza el perfil del tenant: upsert de cada cuenta que Zernio
 * reporta (refleja su estado connected/disconnected) y marca
 * 'disconnected' las filas locales que Zernio ya no lista.
 *
 * No aplica el plan gate: el sync refleja la realidad remota; el tope de
 * plataformas se exige al CONECTAR vía nuestra UI, no al reconciliar.
 */
export async function syncSocialConnections(
    tenantId: string,
    deps: SocialConnectionsDeps = {},
): Promise<SyncResult> {
    const store = resolveStore(deps);
    const profile = await ensureProfileForTenant(tenantId, deps);
    const api = resolveZernio(deps);
    const remote = await api.listAccounts(profile.profileId);
    const now = resolveNow(deps);

    for (const account of remote) {
        await store.upsertConnection({
            tenantId,
            platform: account.platform,
            accountId: account.id,
            username: account.username,
            displayName: account.displayName,
            status: account.status,
            zernioProfileId: profile.profileId,
            lastSyncedAt: now,
        });
    }

    const markedDisconnected = await store.markMissingDisconnected(
        tenantId,
        remote.map((a) => a.id),
        now,
    );

    return {
        connections: await store.listConnections(tenantId),
        synced: remote.length,
        markedDisconnected,
    };
}
