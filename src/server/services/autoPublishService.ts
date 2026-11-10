/**
 * autoPublishService — Configuración de auto-publicación por tenant/programa
 * (PG-03).
 *
 * Cada tenant puede tener UNA config global (program_id NULL, program_key
 * '__all__') y una por programa. La deduplicación NO puede ir sobre
 * (tenant_id, program_id) porque Postgres no deduplica NULLs en un UNIQUE —
 * por eso el schema trae `program_key` NOT NULL y la UNIQUE es
 * (tenant_id, program_key). El servicio es el único que calcula program_key
 * (nunca viene del cliente), así la invariante queda en un solo lugar.
 *
 * Respeto del plan (criterio de aceptación del brief):
 *   - El flag `auto_publish` debe estar habilitado para el tenant
 *     (tenant_features): si no, el upsert responde 403 `feature_disabled`
 *     y NO se guarda nada.
 *   - Si el plan define `plans.max_connected_platforms`, la unión de
 *     plataformas objetivo entre TODAS las configs activas del tenant que
 *     publican (mode != 'off') no puede superarlo → 403
 *     `plan_limit_exceeded`. NULL en el plan = sin tope.
 *   - Las configs con mode='off' no consumen cuota de plataformas (están
 *     guardadas pero no publican nada).
 *
 * `platforms` guarda nombres de red (instagram, tiktok, …) validados contra
 * AUTO_PUBLISH_PLATFORMS — la lista cerrada de destinos de publicación
 * (alineada con las redes de Zernio que PG-04 conectará a cuentas reales;
 * todavía no existe `social_connections`, así que acá sólo hay nombres).
 *
 * mode='scheduled' exige publish_days no vacío y publish_time HH:MM; en los
 * otros modos esos campos se ignoran y se persisten como []/NULL — la fila
 * guardada nunca arrastra un horario fantasma.
 *
 * Patrón del repo: `AutoPublishStore` + `createDrizzleAutoPublishStore` +
 * memory store en tests — TODA query filtra por tenant_id. Los límites del
 * plan y el flag son deps inyectables (`AutoPublishDeps`) para testear sin
 * Neon: isFeatureEnabled/getPlan defaultean a las reales (tenant_features +
 * subscriptions→plans).
 */
import { and, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { autoPublishConfigs } from '../db/schema/autoPublish.js';
import { plans, programs, subscriptions } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { isFeatureEnabled as isFeatureEnabledDb } from './tenantFeaturesService.js';

// ---------------------------------------------------------------------------
// Constantes del dominio
// ---------------------------------------------------------------------------

export const AUTO_PUBLISH_FEATURE_KEY = 'auto_publish';

/** program_key de la config global (program_id NULL). */
export const AUTO_PUBLISH_GLOBAL_KEY = '__all__';

export const AUTO_PUBLISH_DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

export const AUTO_PUBLISH_MODES = ['off', 'on_approval', 'scheduled'] as const;
export type AutoPublishMode = (typeof AUTO_PUBLISH_MODES)[number];

/**
 * Lista cerrada de plataformas objetivo. Son los nombres de red que PG-04
 * conectará a cuentas reales vía Zernio — el subconjunto que publica
 * contenido editorial (no incluye destinos de mensajería/identidad como
 * slack, whatsapp o microsoft).
 */
export const AUTO_PUBLISH_PLATFORMS = [
    'instagram',
    'facebook',
    'tiktok',
    'youtube',
    'linkedin',
    'twitter',
    'threads',
    'pinterest',
    'reddit',
    'bluesky',
] as const;
export type AutoPublishPlatform = (typeof AUTO_PUBLISH_PLATFORMS)[number];

export function isAutoPublishMode(v: string): v is AutoPublishMode {
    return (AUTO_PUBLISH_MODES as readonly string[]).includes(v);
}
export function isAutoPublishPlatform(v: string): v is AutoPublishPlatform {
    return (AUTO_PUBLISH_PLATFORMS as readonly string[]).includes(v);
}

/** program_id → program_key (la regla de dedupe vive acá y sólo acá). */
export function programKeyFor(programId: string | null | undefined): string {
    return programId ?? AUTO_PUBLISH_GLOBAL_KEY;
}

const PUBLISH_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEZONE_RE = /^[A-Za-z0-9_+\-/.]{1,64}$/;

// ---------------------------------------------------------------------------
// Tipos + Store
// ---------------------------------------------------------------------------

export interface AutoPublishConfigRow {
    id: string;
    tenantId: string;
    programId: string | null;
    programKey: string;
    mode: string;
    platforms: string[];
    publishDays: number[];
    publishTime: string | null;
    timezone: string;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface AutoPublishStore {
    /** Config del tenant para un program_key; null si no existe. */
    getConfig(tenantId: string, programKey: string): Promise<AutoPublishConfigRow | null>;
    /** Config del tenant por id; null si no existe o es ajena. */
    getConfigById(tenantId: string, id: string): Promise<AutoPublishConfigRow | null>;
    /** Todas las configs del tenant (global + programas). */
    listConfigs(tenantId: string): Promise<AutoPublishConfigRow[]>;
    /**
     * INSERT … ON CONFLICT (tenant_id, program_key) DO UPDATE — la clave
     * de dedupe cubre la global ('__all__') y las de programa.
     */
    upsertConfig(row: AutoPublishConfigWrite): Promise<AutoPublishConfigRow>;
    /** DELETE tenant-scoped; false si no existía/era ajena. */
    deleteConfig(tenantId: string, id: string): Promise<boolean>;
    /** true si el programa existe Y pertenece al tenant. */
    programExists(tenantId: string, programId: string): Promise<boolean>;
}

/** Lo que el store persiste — program_key YA calculada por el servicio. */
export interface AutoPublishConfigWrite {
    tenantId: string;
    programId: string | null;
    programKey: string;
    mode: string;
    platforms: string[];
    publishDays: number[];
    publishTime: string | null;
    timezone: string;
    isActive: boolean;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleAutoPublishStore(
    executor: Database = db,
): AutoPublishStore {
    return {
        async getConfig(tenantId, programKey) {
            const [row] = await executor
                .select()
                .from(autoPublishConfigs)
                .where(
                    and(
                        eq(autoPublishConfigs.tenantId, tenantId),
                        eq(autoPublishConfigs.programKey, programKey),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async getConfigById(tenantId, id) {
            const [row] = await executor
                .select()
                .from(autoPublishConfigs)
                .where(
                    and(
                        eq(autoPublishConfigs.id, id),
                        eq(autoPublishConfigs.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async listConfigs(tenantId) {
            return executor
                .select()
                .from(autoPublishConfigs)
                .where(eq(autoPublishConfigs.tenantId, tenantId))
                .orderBy(autoPublishConfigs.programKey, autoPublishConfigs.createdAt);
        },

        async upsertConfig(row) {
            const [saved] = await executor
                .insert(autoPublishConfigs)
                .values({
                    tenantId: row.tenantId,
                    programId: row.programId,
                    programKey: row.programKey,
                    mode: row.mode,
                    platforms: row.platforms,
                    publishDays: row.publishDays,
                    publishTime: row.publishTime,
                    timezone: row.timezone,
                    isActive: row.isActive,
                })
                .onConflictDoUpdate({
                    target: [autoPublishConfigs.tenantId, autoPublishConfigs.programKey],
                    set: {
                        programId: row.programId,
                        mode: row.mode,
                        platforms: row.platforms,
                        publishDays: row.publishDays,
                        publishTime: row.publishTime,
                        timezone: row.timezone,
                        isActive: row.isActive,
                        updatedAt: new Date(),
                    },
                })
                .returning();
            return saved;
        },

        async deleteConfig(tenantId, id) {
            const deleted = await executor
                .delete(autoPublishConfigs)
                .where(
                    and(
                        eq(autoPublishConfigs.id, id),
                        eq(autoPublishConfigs.tenantId, tenantId),
                    ),
                )
                .returning({ id: autoPublishConfigs.id });
            return deleted.length > 0;
        },

        async programExists(tenantId, programId) {
            const [row] = await executor
                .select({ id: programs.id })
                .from(programs)
                .where(
                    and(
                        eq(programs.id, programId),
                        eq(programs.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row !== undefined;
        },
    };
}

// ---------------------------------------------------------------------------
// Deps inyectables (flag + plan) — los tests los pisan sin Neon
// ---------------------------------------------------------------------------

export interface AutoPublishPlanInfo {
    name: string;
    maxConnectedPlatforms: number | null;
}

export interface AutoPublishDeps {
    store?: AutoPublishStore;
    isFeatureEnabled?: (tenantId: string, key: string) => Promise<boolean>;
    /** Plan del tenant con su límite de plataformas; null = sin plan. */
    getPlan?: (tenantId: string) => Promise<AutoPublishPlanInfo | null>;
}

const resolveStore = (deps?: AutoPublishDeps): AutoPublishStore =>
    deps?.store ?? createDrizzleAutoPublishStore();

const resolveIsFeatureEnabled = (deps?: AutoPublishDeps) =>
    deps?.isFeatureEnabled ?? isFeatureEnabledDb;

async function defaultGetPlan(tenantId: string): Promise<AutoPublishPlanInfo | null> {
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

const resolveGetPlan = (deps?: AutoPublishDeps) =>
    deps?.getPlan ?? defaultGetPlan;

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** Config del tenant para un programa (o la global si no se pasa programId). */
export async function getAutoPublishConfig(
    tenantId: string,
    programId?: string | null,
    deps: AutoPublishDeps = {},
): Promise<AutoPublishConfigRow | null> {
    return resolveStore(deps).getConfig(tenantId, programKeyFor(programId));
}

/** Todas las configs del tenant (global + programas). */
export async function listAutoPublishConfigs(
    tenantId: string,
    deps: AutoPublishDeps = {},
): Promise<AutoPublishConfigRow[]> {
    return resolveStore(deps).listConfigs(tenantId);
}

export interface AutoPublishPlanStatus {
    /** El flag auto_publish está habilitado para el tenant. */
    planAllowsAutoPublish: boolean;
    /** plans.max_connected_platforms (null = sin tope / sin plan). */
    maxPlatforms: number | null;
    /** Plataformas distintas usadas por configs activas que publican. */
    usedPlatforms: number;
}

/**
 * Estado del plan para la UI: si el flag está habilitado, el tope de
 * plataformas del plan y cuántas plataformas distintas ya consumen las
 * configs activas con mode != 'off'.
 */
export async function getAutoPublishPlanStatus(
    tenantId: string,
    deps: AutoPublishDeps = {},
): Promise<AutoPublishPlanStatus> {
    const [allowed, plan, configs] = await Promise.all([
        resolveIsFeatureEnabled(deps)(tenantId, AUTO_PUBLISH_FEATURE_KEY),
        resolveGetPlan(deps)(tenantId),
        resolveStore(deps).listConfigs(tenantId),
    ]);
    return {
        planAllowsAutoPublish: allowed,
        maxPlatforms: plan?.maxConnectedPlatforms ?? null,
        usedPlatforms: unionUsedPlatforms(configs).size,
    };
}

/**
 * Unión de plataformas objetivo entre las configs activas que publican
 * (mode != 'off'). `extra` suma las plataformas de la config que se está
 * guardando y `excludeProgramKey` saltea la fila que el upsert pisa.
 */
function unionUsedPlatforms(
    configs: AutoPublishConfigRow[],
    excludeProgramKey?: string,
    extra: readonly string[] = [],
): Set<string> {
    const set = new Set<string>(extra);
    for (const config of configs) {
        if (config.programKey === excludeProgramKey) continue;
        if (!config.isActive || config.mode === 'off') continue;
        for (const platform of config.platforms) set.add(platform);
    }
    return set;
}

// ---------------------------------------------------------------------------
// Escritura — upsert con validación + gates de plan
// ---------------------------------------------------------------------------

export interface UpsertAutoPublishConfigInput {
    tenantId: string;
    /** uuid de un programa DEL TENANT, o null/undefined = config global. */
    programId?: string | null;
    mode: string;
    platforms?: unknown;
    publishDays?: unknown;
    publishTime?: unknown;
    timezone?: unknown;
}

/**
 * Valida la entrada, aplica los gates de plan (feature flag + tope de
 * plataformas) y hace upsert por (tenant_id, program_key).
 *
 * Orden de los gates: el flag se chequea ANTES de tocar nada (un tenant sin
 * la feature no puede guardar configuración), después la validación de
 * entrada, la pertenencia del programa y por último el tope de plataformas
 * (que necesita la entrada ya saneada).
 *
 * Errores: 400 invalid_mode / invalid_platforms / invalid_publish_days /
 * invalid_publish_time / invalid_timezone / invalid_schedule /
 * invalid_program; 404 program_not_found; 403 feature_disabled /
 * plan_limit_exceeded.
 */
export async function upsertAutoPublishConfig(
    input: UpsertAutoPublishConfigInput,
    deps: AutoPublishDeps = {},
): Promise<AutoPublishConfigRow> {
    const store = resolveStore(deps);

    // Gate 1: el flag tiene que estar habilitado — si no, no se guarda nada.
    const enabled = await resolveIsFeatureEnabled(deps)(
        input.tenantId,
        AUTO_PUBLISH_FEATURE_KEY,
    );
    if (!enabled) {
        throw new AppError(
            'La auto-publicación no está disponible en tu plan',
            403,
            'feature_disabled',
        );
    }

    // Validación de entrada (antes de cualquier escritura).
    if (!isAutoPublishMode(input.mode)) {
        throw new AppError(
            `mode inválido: '${input.mode}'. Válidos: ${AUTO_PUBLISH_MODES.join(', ')}`,
            400,
            'invalid_mode',
        );
    }
    const mode = input.mode;

    const platforms = sanitizePlatforms(input.platforms);
    const publishDays = sanitizePublishDays(input.publishDays);
    const publishTime = sanitizePublishTime(input.publishTime);
    const timezone = sanitizeTimezone(input.timezone);

    const programId = input.programId ?? null;
    if (programId !== null && !UUID_RE.test(programId)) {
        throw new AppError('programId inválido (uuid)', 400, 'invalid_program');
    }

    if (mode === 'scheduled') {
        if (publishDays.length === 0 || publishTime === null) {
            throw new AppError(
                'El modo programado requiere publishDays no vacío y publishTime (HH:MM)',
                400,
                'invalid_schedule',
            );
        }
    }

    // El programa tiene que ser DEL TENANT (si no, 404 — no se distingue
    // "no existe" de "es de otro").
    if (programId !== null && !(await store.programExists(input.tenantId, programId))) {
        throw new AppError('Programa no encontrado', 404, 'program_not_found');
    }

    // Gate 2: tope de plataformas del plan. Cuenta la unión de plataformas
    // de todas las configs activas que publican + la que se está guardando.
    // mode='off' no consume cuota (guarda la config pero no publica).
    const plan = await resolveGetPlan(deps)(input.tenantId);
    const maxPlatforms = plan?.maxConnectedPlatforms ?? null;
    if (mode !== 'off' && maxPlatforms !== null) {
        const programKey = programKeyFor(programId);
        const configs = await store.listConfigs(input.tenantId);
        const total = unionUsedPlatforms(configs, programKey, platforms).size;
        if (total > maxPlatforms) {
            throw new AppError(
                `Tu plan permite hasta ${maxPlatforms} plataformas conectadas y la configuración las superaría (${total})`,
                403,
                'plan_limit_exceeded',
            );
        }
    }

    // Campos de agenda sólo en modo scheduled — los demás modos persisten
    // []/NULL para no arrastrar un horario que no corre.
    const scheduled = mode === 'scheduled';
    return store.upsertConfig({
        tenantId: input.tenantId,
        programId,
        programKey: programKeyFor(programId),
        mode,
        platforms,
        publishDays: scheduled ? publishDays : [],
        publishTime: scheduled ? publishTime : null,
        timezone,
        isActive: true,
    });
}

/** Borra una config del tenant; 404 si no existe o es ajena. */
export async function deleteAutoPublishConfig(
    tenantId: string,
    id: string,
    deps: AutoPublishDeps = {},
): Promise<void> {
    const store = resolveStore(deps);
    const deleted = await store.deleteConfig(tenantId, id);
    if (!deleted) {
        throw new AppError('Configuración no encontrada', 404, 'config_not_found');
    }
}

// ---------------------------------------------------------------------------
// Sanitizers estrictos — todo valor inválido es 400 (nunca se persiste).
// ---------------------------------------------------------------------------

function sanitizePlatforms(value: unknown): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new AppError('platforms debe ser un array de redes', 400, 'invalid_platforms');
    }
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string' || !isAutoPublishPlatform(item)) {
            throw new AppError(
                `Plataforma inválida: ${JSON.stringify(item)}. Válidas: ${AUTO_PUBLISH_PLATFORMS.join(', ')}`,
                400,
                'invalid_platforms',
            );
        }
        if (!out.includes(item)) out.push(item);
    }
    return out;
}

function sanitizePublishDays(value: unknown): number[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw new AppError('publishDays debe ser un array de días 0-6', 400, 'invalid_publish_days');
    }
    const out: number[] = [];
    for (const item of value) {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 6) {
            throw new AppError(
                `Día de publicación inválido: ${JSON.stringify(item)} (enteros 0-6)`,
                400,
                'invalid_publish_days',
            );
        }
        if (!out.includes(item)) out.push(item);
    }
    return out;
}

function sanitizePublishTime(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !PUBLISH_TIME_RE.test(value)) {
        throw new AppError('publishTime inválido (formato HH:MM)', 400, 'invalid_publish_time');
    }
    return value;
}

function sanitizeTimezone(value: unknown): string {
    if (value === undefined || value === null) return AUTO_PUBLISH_DEFAULT_TIMEZONE;
    if (typeof value !== 'string' || !TIMEZONE_RE.test(value)) {
        throw new AppError('timezone inválido', 400, 'invalid_timezone');
    }
    return value;
}
