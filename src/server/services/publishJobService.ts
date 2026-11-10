/**
 * publishJobService — cola persistente de publicación vía Zernio (PG-05).
 *
 * Modelo: UN publish job por (pieza de contenido × red × cuenta). Aprobar un
 * asset/publicación encola un job por cuenta Zernio destino; el
 * `publishWorker` claimea `queued`, llama `POST /v1/posts` con la
 * `idempotency_key` como header `Idempotency-Key` y deja el resultado
 * observable en la fila (status, attempts, error categorizado, zernio_post_id,
 * platform_post_url). NUNCA se guardan credenciales sociales — platform +
 * account_id son los ids opacos que Zernio reporta.
 *
 * Patrón store del repo: `PublishJobStore` + `createDrizzlePublishJobStore(db)`
 * + memory store en tests/helpers.
 *
 * REGLA tenant_id: TODA query filtra por tenant_id con DOS excepciones
 * documentadas — `claimNext` (el worker no sabe a priori qué tenant tiene
 * trabajo, igual que clipRenderQueueService) y `getJobByIdempotencyKey`
 * (lookup post-ON CONFLICT; la key ya lleva el tenantId dentro del hash y
 * la llamada siempre pasa tenantId además, por defensa).
 *
 * Idempotencia: `idempotency_key = uuidv5(tenantId|origen|platform|accountId)`
 * — re-encolar el mismo destino devuelve el job existente (ON CONFLICT DO
 * NOTHING), nunca duplica. La key viaja a Zernio como Idempotency-Key:
 * un reintento del worker tampoco duplica el post (Zernio responde 200
 * con el post original).
 *
 * Coexistencia con el legacy (publishService/metaPublishService/
 * twitterService): este servicio sólo entra en juego cuando el tenant tiene
 * conexiones Zernio — la decisión vive en `enqueueForApproval` y las rutas
 * de approve; sin conexiones el flujo legacy queda intacto.
 */
import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';

import { db, type Database } from '../db/index.js';
import { publishJobs, type PublishJobPayload } from '../db/schema/publishJobs.js';
import { persons } from '../db/schema/persons.js';
import { publications } from '../db/schema/publications.js';
import { assets } from '../db/schema/assets.js';
import { AppError } from '../lib/errors.js';
import {
    composePublishContent,
    normalizePublishHashtags,
    resolvePublishMentions,
    PUBLISH_TEXT_LIMITS,
    type PublishPlatform,
} from './mentionService.js';
import {
    extractPersonIds,
    type PersonSocialLinks,
    type ResolvedMention,
} from './networkVariantService.js';
import {
    listSocialConnections,
    type SocialConnectionRow,
} from './socialConnectionsService.js';
import {
    listAutoPublishConfigs,
    type AutoPublishConfigRow,
} from './autoPublishService.js';
import {
    LEGACY_PLATFORMS,
    planPublishChannels,
    type PublishChannelMode,
    type PublishChannelPlan,
    type PublishChannelStore,
} from './publishChannelService.js';
import { createZernioApi, type ZernioApi, type ZernioPublishResult } from './zernioService.js';

// ---------------------------------------------------------------------------
// Estados, transiciones y errores
// ---------------------------------------------------------------------------

export const PUBLISH_JOB_STATUSES = [
    'queued',
    'publishing',
    'published',
    'partial',
    'failed',
    'cancelled',
] as const;
export type PublishJobStatus = (typeof PUBLISH_JOB_STATUSES)[number];

export function isPublishJobStatus(v: string): v is PublishJobStatus {
    return (PUBLISH_JOB_STATUSES as readonly string[]).includes(v);
}

/**
 * Transiciones del ciclo de vida. `publishing → published|partial|failed`
 * las ejecuta el worker; `failed|partial → queued` es el reintento manual;
 * `partial → published` es el resultado del retry remoto de Zernio
 * (POST /posts/{id}/retry vuelve con el post ya publicado);
 * cualquier estado puede ir a `cancelled`.
 */
export const PUBLISH_JOB_TRANSITIONS: Record<
    PublishJobStatus,
    readonly PublishJobStatus[]
> = {
    queued: ['publishing', 'cancelled'],
    publishing: ['published', 'partial', 'failed', 'cancelled'],
    published: ['cancelled'],
    partial: ['queued', 'published', 'cancelled'],
    failed: ['queued', 'cancelled'],
    cancelled: [],
};

export function canTransitionPublishJob(
    from: PublishJobStatus,
    to: PublishJobStatus,
): boolean {
    return PUBLISH_JOB_TRANSITIONS[from].includes(to);
}

/**
 * Taxonomía de error de Zernio (BRIEF-ZERNIO-API) — queda en
 * `last_error_category` para que el operador vea el motivo real, nunca un
 * "error genérico". `source` deriva de la categoría: los errores de
 * plataforma/sistema son los reintentables.
 */
export const PUBLISH_ERROR_CATEGORIES = [
    'auth_expired',
    'user_content',
    'user_abuse',
    'platform_rate_limit',
    'quota_exhausted',
    'account_issue',
    'platform_rejected',
    'platform_error',
    'system_error',
    'unknown',
] as const;
export type PublishErrorCategory = (typeof PUBLISH_ERROR_CATEGORIES)[number];
export type PublishErrorSource = 'user' | 'platform' | 'system';

/** Categorías que vale la pena reintentar automáticamente (backoff). */
export const RETRYABLE_ERROR_CATEGORIES: readonly PublishErrorCategory[] = [
    'platform_rate_limit',
    'platform_error',
    'system_error',
];

export function isPublishErrorCategory(v: string): v is PublishErrorCategory {
    return (PUBLISH_ERROR_CATEGORIES as readonly string[]).includes(v);
}

export function publishErrorSource(category: string | null | undefined): PublishErrorSource | null {
    switch (category) {
        case 'auth_expired':
        case 'user_content':
        case 'user_abuse':
        case 'account_issue':
        case 'quota_exhausted':
            return 'user';
        case 'platform_rate_limit':
        case 'platform_rejected':
        case 'platform_error':
            return 'platform';
        case 'system_error':
        case 'unknown':
            return 'system';
        default:
            return null;
    }
}

/**
 * ¿Vale la pena reintentar? Reintentable = categoría de plataforma/sistema o
 * HTTP 429/503 (según el brief: `platform_error`, `system_error`,
 * `platform_rate_limit`, 429/503).
 */
export function isRetryablePublishError(
    category: PublishErrorCategory,
    httpStatus?: number | null,
): boolean {
    if (httpStatus === 429 || httpStatus === 503) return true;
    return RETRYABLE_ERROR_CATEGORIES.includes(category);
}

/**
 * Mapea un AppError de la API de Zernio a (categoría, source, retryable).
 * El `code` de la API decide cuando aporta (account_disconnected →
 * auth_expired; duplicate_content → user_content; idempotency_conflict →
 * reintentable: el original sigue procesando y el retry acierta).
 */
export function categorizePublishError(
    httpStatus: number | null | undefined,
    code: string | null | undefined,
): { category: PublishErrorCategory; source: PublishErrorSource; retryable: boolean } {
    let category: PublishErrorCategory;
    switch (httpStatus) {
        case 400:
        case 422:
            category = 'user_content';
            break;
        case 401:
            category = 'auth_expired';
            break;
        case 402:
            category = 'quota_exhausted';
            break;
        case 403:
            category =
                code === 'account_disconnected' ||
                code === 'auth_expired' ||
                code === 'needs_reconnection'
                    ? 'auth_expired'
                    : 'account_issue';
            break;
        case 404:
            category = 'account_issue';
            break;
        case 409:
            category = code === 'duplicate_content' ? 'user_content' : 'platform_error';
            break;
        case 429:
            category = 'platform_rate_limit';
            break;
        default:
            if (httpStatus !== null && httpStatus !== undefined && httpStatus >= 500) {
                category = 'system_error';
            } else {
                category = 'unknown';
            }
    }
    const source = publishErrorSource(category) ?? 'system';
    return {
        category,
        source,
        retryable: isRetryablePublishError(category, httpStatus),
    };
}

// ---------------------------------------------------------------------------
// Tipos + Store
// ---------------------------------------------------------------------------

export type PublishJob = typeof publishJobs.$inferSelect;

/** Un destino de publicación: cuenta Zernio + nuestra conexión origen. */
export interface PublishTarget {
    platform: string;
    /** `_id` de la cuenta EN ZERNIO — opaco, nunca un handle ni token. */
    accountId: string;
    /** FK a social_connections (trazabilidad; NULLABLE en la fila). */
    connectionId?: string | null;
}

export interface EnqueuePublishJobsInput {
    tenantId: string;
    /** Origen editorial — uno de los dos (o ninguno: encolado ad-hoc). */
    assetId?: string | null;
    publicationId?: string | null;
    targets: PublishTarget[];
    content: string;
    mediaUrls?: string[];
    /** Cuándo quiere el usuario que salga — gatea el claim del worker. */
    scheduledFor?: Date | null;
    /** Tope de intentos automáticos. Default 3 (columna). */
    maxAttempts?: number;
    /**
     * PG-06: lista explícita de personas a mencionar (uuid). Si no viene,
     * los personIds se extraen de `publications.quotes` del origen.
     */
    personIds?: string[];
    /**
     * PG-06: personIds excluidos de las menciones (toggle por persona en la
     * previsualización de la UI).
     */
    excludePersonIds?: string[];
    /** PG-06: etiquetas explícitas del request (se normalizan y deduplican). */
    hashtags?: string[];
}

export interface EnqueuePublishJobsResult {
    /** Todos los jobs del enqueue (creados + deduplicados ya existentes). */
    jobs: PublishJob[];
    /** Cuántos se crearon nuevos. */
    createdCount: number;
    /** Cuántos cayeron sobre un job existente (re-encolado idempotente). */
    deduplicatedCount: number;
}

export interface ListPublishJobsOptions {
    status?: PublishJobStatus;
    limit?: number;
    offset?: number;
}

export interface JobErrorInfo {
    message: string;
    category?: PublishErrorCategory | string | null;
    source?: PublishErrorSource | string | null;
    /** postId de Zernio si el post ya existía cuando falló. */
    zernioPostId?: string | null;
    platformPostUrl?: string | null;
}

export interface PublishJobStore {
    /**
     * Inserta un job (status 'queued', next_attempt_at = scheduled_for ?? now
     * — el service ya calcula `idempotencyKey`). ON CONFLICT
     * (idempotency_key) DO NOTHING → devuelve `{created:false}` con la fila
     * existente. Tenant va en la fila; la key es globalmente única.
     */
    enqueueJob(input: {
        tenantId: string;
        assetId: string | null;
        publicationId: string | null;
        connectionId: string | null;
        platform: string;
        accountId: string;
        idempotencyKey: string;
        content: string;
        mediaUrls: string[];
        /** Composición PG-06 persistida con el job (jsonb, default {}). */
        payload?: PublishJobPayload;
        scheduledFor: Date | null;
        nextAttemptAt: Date;
        maxAttempts?: number;
    }): Promise<{ job: PublishJob; created: boolean }>;

    /**
     * EXCEPCIÓN documentada a la regla tenant_id (como clipRenderQueueStore):
     * la cola es GLOBAL — el worker claimea el próximo `queued` con
     * next_attempt_at <= now de cualquier tenant. El tenant viaja EN la fila
     * y todas las demás queries sí filtran por tenant_id.
     *
     * Atómico sin FOR UPDATE SKIP LOCKED: UPDATE condicionado por
     * `status='queued'` — dos workers compiten y sólo uno gana la fila.
     * El claim incrementa `attempts` (es el intento que arranca).
     */
    claimNext(now: Date): Promise<PublishJob | null>;

    /** `queued`/`publishing` → `cancelled` (tenant-scoped). Null si estado inválido. */
    cancel(jobId: string, tenantId: string): Promise<PublishJob | null>;

    getById(jobId: string, tenantId: string): Promise<PublishJob | null>;
    list(tenantId: string, opts?: ListPublishJobsOptions): Promise<PublishJob[]>;
    count(tenantId: string, status?: PublishJobStatus): Promise<number>;
    /** Jobs anclados al mismo origen (sync del estado del asset/publication). */
    listBySource(
        tenantId: string,
        source: { assetId?: string | null; publicationId?: string | null },
    ): Promise<PublishJob[]>;

    /**
     * `publishing` informativa: el post ya existe en Zernio pero sigue en
     * curso (`scheduled`/`publishing`/202 awaiting_funding). Actualiza
     * zernio_post_id y la nota sin cerrar el job.
     */
    markPublishing(
        jobId: string,
        opts?: { zernioPostId?: string | null; note?: string | null },
    ): Promise<PublishJob | null>;

    /** Éxito terminal: `published` + published_at + platform_post_url. */
    markPublished(
        jobId: string,
        opts: {
            zernioPostId?: string | null;
            platformPostUrl?: string | null;
            publishedAt?: Date;
        },
    ): Promise<PublishJob | null>;

    /**
     * Éxito parcial (Zernio 207 / post.status='partial'): alguna plataforma
     * publicó y otra falló — queda el error de la fallida para el operador.
     */
    markPartial(
        jobId: string,
        opts: {
            zernioPostId?: string | null;
            platformPostUrl?: string | null;
            error?: JobErrorInfo | null;
        },
    ): Promise<PublishJob | null>;

    /**
     * Falla de un intento: si viene `requeueAt` y `attempts < max_attempts`
     * vuelve a `queued` con `next_attempt_at = requeueAt` (backoff del
     * worker); si no, `failed` terminal. Devuelve la fila — el status dice
     * el resultado.
     */
    markFailed(
        jobId: string,
        error: JobErrorInfo,
        opts?: { requeueAt?: Date },
    ): Promise<PublishJob | null>;

    markCancelled(jobId: string): Promise<PublishJob | null>;

    /**
     * `failed`/`partial` → `queued` (tenant-scoped) — el reintento manual sin
     * zernioPostId (el post nunca llegó a crearse). Respeta el tope afuera.
     */
    requeue(
        jobId: string,
        tenantId: string,
        opts: { nextAttemptAt: Date },
    ): Promise<PublishJob | null>;

    /** attempts += 1 — intento extra fuera del claim (retry remoto de Zernio). */
    recordAttempt(jobId: string): Promise<PublishJob | null>;
}

const MAX_CLAIM_ATTEMPTS = 3;

/** Implementación drizzle — regla tenant_id con las excepciones documentadas. */
export function createDrizzlePublishJobStore(
    executor: Database = db,
): PublishJobStore {
    return {
        async enqueueJob(input) {
            const [row] = await executor
                .insert(publishJobs)
                .values({
                    tenantId: input.tenantId,
                    assetId: input.assetId,
                    publicationId: input.publicationId,
                    connectionId: input.connectionId,
                    platform: input.platform,
                    accountId: input.accountId,
                    idempotencyKey: input.idempotencyKey,
                    content: input.content,
                    mediaUrls: input.mediaUrls,
                    ...(input.payload !== undefined
                        ? { payload: input.payload }
                        : {}),
                    scheduledFor: input.scheduledFor,
                    nextAttemptAt: input.nextAttemptAt,
                    ...(input.maxAttempts !== undefined
                        ? { maxAttempts: input.maxAttempts }
                        : {}),
                })
                .onConflictDoNothing({ target: publishJobs.idempotencyKey })
                .returning();
            if (row) return { job: row, created: true };

            const [existing] = await executor
                .select()
                .from(publishJobs)
                .where(eq(publishJobs.idempotencyKey, input.idempotencyKey))
                .limit(1);
            if (!existing) {
                throw new AppError(
                    'No se pudo encolar el job de publicación',
                    500,
                    'publish_enqueue_failed',
                );
            }
            return { job: existing, created: false };
        },

        // ÚNICA query sin filtro tenant_id — ver el contrato en la interface.
        async claimNext(now) {
            for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i++) {
                const [candidate] = await executor
                    .select({ id: publishJobs.id })
                    .from(publishJobs)
                    .where(
                        and(
                            eq(publishJobs.status, 'queued'),
                            or(
                                lte(publishJobs.nextAttemptAt, now),
                                sql`${publishJobs.nextAttemptAt} IS NULL`,
                            ),
                        ),
                    )
                    .orderBy(asc(publishJobs.nextAttemptAt), asc(publishJobs.createdAt))
                    .limit(1);
                if (!candidate) return null;

                const [claimed] = await executor
                    .update(publishJobs)
                    .set({
                        status: 'publishing',
                        attempts: sql`${publishJobs.attempts} + 1`,
                    })
                    .where(
                        and(
                            eq(publishJobs.id, candidate.id),
                            eq(publishJobs.status, 'queued'),
                        ),
                    )
                    .returning();
                if (claimed) return claimed;
            }
            return null;
        },

        async cancel(jobId, tenantId) {
            const [row] = await executor
                .update(publishJobs)
                .set({ status: 'cancelled' })
                .where(
                    and(
                        eq(publishJobs.id, jobId),
                        eq(publishJobs.tenantId, tenantId),
                        inArray(publishJobs.status, ['queued', 'publishing']),
                    ),
                )
                .returning();
            return row ?? null;
        },

        async getById(jobId, tenantId) {
            const [row] = await executor
                .select()
                .from(publishJobs)
                .where(
                    and(
                        eq(publishJobs.id, jobId),
                        eq(publishJobs.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async list(tenantId, opts = {}) {
            return executor
                .select()
                .from(publishJobs)
                .where(
                    and(
                        eq(publishJobs.tenantId, tenantId),
                        opts.status ? eq(publishJobs.status, opts.status) : undefined,
                    ),
                )
                .orderBy(asc(publishJobs.createdAt))
                .limit(opts.limit ?? 100)
                .offset(opts.offset ?? 0);
        },

        async count(tenantId, status) {
            const [row] = await executor
                .select({ n: sql<number>`count(*)::int` })
                .from(publishJobs)
                .where(
                    and(
                        eq(publishJobs.tenantId, tenantId),
                        status ? eq(publishJobs.status, status) : undefined,
                    ),
                );
            return row?.n ?? 0;
        },

        async listBySource(tenantId, source) {
            const sourceFilter = source.assetId
                ? eq(publishJobs.assetId, source.assetId)
                : source.publicationId
                  ? eq(publishJobs.publicationId, source.publicationId)
                  : undefined;
            if (!sourceFilter) return [];
            return executor
                .select()
                .from(publishJobs)
                .where(and(eq(publishJobs.tenantId, tenantId), sourceFilter))
                .orderBy(asc(publishJobs.createdAt));
        },

        async markPublishing(jobId, opts = {}) {
            const [row] = await executor
                .update(publishJobs)
                .set({
                    status: 'publishing',
                    ...(opts.zernioPostId !== undefined
                        ? { zernioPostId: opts.zernioPostId }
                        : {}),
                    ...(opts.note !== undefined ? { lastError: opts.note } : {}),
                })
                .where(eq(publishJobs.id, jobId))
                .returning();
            return row ?? null;
        },

        async markPublished(jobId, opts) {
            const [row] = await executor
                .update(publishJobs)
                .set({
                    status: 'published',
                    zernioPostId: opts.zernioPostId ?? null,
                    platformPostUrl: opts.platformPostUrl ?? null,
                    publishedAt: opts.publishedAt ?? new Date(),
                    lastError: null,
                    lastErrorCategory: null,
                    lastErrorSource: null,
                })
                .where(eq(publishJobs.id, jobId))
                .returning();
            return row ?? null;
        },

        async markPartial(jobId, opts) {
            const [row] = await executor
                .update(publishJobs)
                .set({
                    status: 'partial',
                    zernioPostId: opts.zernioPostId ?? null,
                    platformPostUrl: opts.platformPostUrl ?? null,
                    publishedAt: new Date(),
                    lastError: opts.error?.message ?? null,
                    lastErrorCategory: opts.error?.category ?? null,
                    lastErrorSource: opts.error?.source ?? null,
                })
                .where(eq(publishJobs.id, jobId))
                .returning();
            return row ?? null;
        },

        async markFailed(jobId, error, opts) {
            const [current] = await executor
                .select({
                    attempts: publishJobs.attempts,
                    maxAttempts: publishJobs.maxAttempts,
                })
                .from(publishJobs)
                .where(eq(publishJobs.id, jobId))
                .limit(1);
            if (!current) return null;

            const terminal =
                opts?.requeueAt === undefined || current.attempts >= current.maxAttempts;
            const [row] = await executor
                .update(publishJobs)
                .set({
                    status: terminal ? 'failed' : 'queued',
                    zernioPostId: error.zernioPostId ?? null,
                    platformPostUrl: error.platformPostUrl ?? null,
                    lastError: error.message,
                    lastErrorCategory: error.category ?? null,
                    lastErrorSource: error.source ?? null,
                    ...(terminal ? {} : { nextAttemptAt: opts?.requeueAt }),
                })
                .where(eq(publishJobs.id, jobId))
                .returning();
            return row ?? null;
        },

        async markCancelled(jobId) {
            const [row] = await executor
                .update(publishJobs)
                .set({ status: 'cancelled' })
                .where(eq(publishJobs.id, jobId))
                .returning();
            return row ?? null;
        },

        async requeue(jobId, tenantId, opts) {
            const [row] = await executor
                .update(publishJobs)
                .set({ status: 'queued', nextAttemptAt: opts.nextAttemptAt })
                .where(
                    and(
                        eq(publishJobs.id, jobId),
                        eq(publishJobs.tenantId, tenantId),
                        inArray(publishJobs.status, ['failed', 'partial']),
                    ),
                )
                .returning();
            return row ?? null;
        },

        async recordAttempt(jobId) {
            const [row] = await executor
                .update(publishJobs)
                .set({ attempts: sql`${publishJobs.attempts} + 1` })
                .where(eq(publishJobs.id, jobId))
                .returning();
            return row ?? null;
        },
    };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

/** Namespace propio para las idempotency keys (uuid v5 del job lógico). */
const PUBLISH_JOB_NAMESPACE = '7f3a1c2e-5b9d-4e8a-9c6f-1d2b3a4e5f60';

/**
 * idempotency_key del job lógico: uuid v5 DETERMINISTA de
 * (tenantId, origen, platform, accountId). El origen es `asset:{id}` |
 * `pub:{id}` | `adhoc:{hash contenido}` — dos enqueues del mismo destino
 * caen en la misma key y deduplican por el UNIQUE de la columna.
 */
export function deriveIdempotencyKey(input: {
    tenantId: string;
    assetId?: string | null;
    publicationId?: string | null;
    platform: string;
    accountId: string;
    /** Sólo discrimina jobs ad-hoc (sin asset ni publication). */
    contentFingerprint?: string | null;
}): string {
    const source = input.assetId
        ? `asset:${input.assetId}`
        : input.publicationId
          ? `pub:${input.publicationId}`
          : `adhoc:${input.contentFingerprint ?? 'none'}`;
    return `pj_${uuidv5(
        `${input.tenantId}|${source}|${input.platform}|${input.accountId}`,
        PUBLISH_JOB_NAMESPACE,
    )}`;
}

export interface PublishJobDeps {
    store?: PublishJobStore;
    /**
     * Conexiones Zernio del tenant (para resolver targets del approve).
     * Default: listSocialConnections(tenantId).
     */
    listConnections?: (tenantId: string) => Promise<SocialConnectionRow[]>;
    /** Configs auto-publish del tenant (filtro de targets). Default: listAutoPublishConfigs. */
    listAutoPublishConfigs?: (tenantId: string) => Promise<AutoPublishConfigRow[]>;
    /** API Zernio (sólo para el retry remoto). Los tests inyectan un fake. */
    zernio?: Pick<ZernioApi, 'publishPost' | 'retryPost'>;
    /** Write-through del asset al publicar (default: transitionAsset de PG-01). */
    transitionAssetTo?: (input: {
        tenantId: string;
        assetId: string;
        to: 'published';
    }) => Promise<unknown>;
    /** Write-through de la publication legacy (default: updatePublicationStatus). */
    markPublicationPublished?: (
        tenantId: string,
        publicationId: string,
    ) => Promise<unknown>;
    /**
     * PG-06: quotes + contentVariants del origen editorial (tenant-scoped).
     * Default: drizzle — publication directa o la del asset cuando el
     * asset viene de `publications` (note/post); otro origen → null.
     */
    getMentionSource?: (
        tenantId: string,
        source: { assetId?: string | null; publicationId?: string | null },
    ) => Promise<MentionSource | null>;
    /**
     * PG-06: `{id, name, socialLinks}` de las personas pedidas, una sola
     * query tenant-scoped (personas de otro tenant no se leen — igual
     * que `getPersonSocialLinks` de PF-09). Default: drizzle.
     */
    listMentionPersons?: (
        tenantId: string,
        personIds: string[],
    ) => Promise<PersonSocialLinks[]>;
    /**
     * PG-07: store del plan de canales (modo en `settings` + assets legacy
     * en `business_assets`). Default: drizzle.
     */
    channelStore?: PublishChannelStore;
    /**
     * PG-07: bot de Twitter legacy configurado por env (tenant-agnóstico).
     * Default: variables TWITTER_* completas.
     */
    envTwitterBot?: boolean;
    /** Reloj inyectable — los tests corren en tiempo falso. */
    now?: () => Date;
}

const resolveStore = (deps?: PublishJobDeps): PublishJobStore =>
    deps?.store ?? createDrizzlePublishJobStore();

const fingerprintContent = (content: string): string =>
    uuidv5(`content|${content}`, PUBLISH_JOB_NAMESPACE);

// ---------------------------------------------------------------------------
// PG-06 — menciones reales + etiquetas por red de publicación
// ---------------------------------------------------------------------------

/** Lo que el origen editorial aporta a la composición (tenant-scoped). */
export interface MentionSource {
    quotes: unknown;
    contentVariants: unknown;
}

/**
 * Default drizzle de `getMentionSource`: publication directa, o la del
 * asset cuando `assets.source_table = 'publications'` (note/post del
 * ledger). Otro origen (clip, flyer, ad-hoc) → null → sin menciones.
 * TODAS las queries filtran por tenant_id.
 */
const defaultGetMentionSource = async (
    tenantId: string,
    source: { assetId?: string | null; publicationId?: string | null },
): Promise<MentionSource | null> => {
    let publicationId = source.publicationId ?? null;
    if (!publicationId && source.assetId) {
        const [asset] = await db
            .select({
                sourceTable: assets.sourceTable,
                refId: assets.refId,
            })
            .from(assets)
            .where(
                and(
                    eq(assets.id, source.assetId),
                    eq(assets.tenantId, tenantId),
                ),
            )
            .limit(1);
        if (asset?.sourceTable === 'publications') {
            publicationId = asset.refId;
        }
    }
    if (!publicationId) return null;
    const [row] = await db
        .select({
            quotes: publications.quotes,
            contentVariants: publications.contentVariants,
        })
        .from(publications)
        .where(
            and(
                eq(publications.id, publicationId),
                eq(publications.tenantId, tenantId),
            ),
        )
        .limit(1);
    return row ?? null;
};

/** Default drizzle de `listMentionPersons` — eq tenant_id + inArray. */
const defaultListMentionPersons = (
    tenantId: string,
    personIds: string[],
): Promise<PersonSocialLinks[]> =>
    db
        .select({
            id: persons.id,
            name: persons.name,
            socialLinks: persons.socialLinks,
        })
        .from(persons)
        .where(
            and(
                eq(persons.tenantId, tenantId),
                inArray(persons.id, personIds),
            ),
        );

/**
 * Red de publicación → key de `contentVariants.extras` (PF-09). Las redes
 * que no son `NetworkVariantKey` (tiktok, facebook, threads, pinterest,
 * reddit, bluesky) no tienen extras de dónde sacar hashtags.
 */
const VARIANT_KEY_BY_PLATFORM: Partial<
    Record<PublishPlatform, 'twitter' | 'instagram' | 'linkedin' | 'youtube'>
> = {
    twitter: 'twitter',
    instagram: 'instagram',
    linkedin: 'linkedin',
    youtube: 'youtube',
};

/** `contentVariants.extras[red].hashtags` normalizados (o [] si no hay). */
function variantHashtagsFor(
    contentVariants: unknown,
    platform: string,
): string[] {
    const key = (VARIANT_KEY_BY_PLATFORM as Record<string, string | undefined>)[
        platform
    ];
    if (!key || !contentVariants || typeof contentVariants !== 'object') {
        return [];
    }
    const extras = (contentVariants as { extras?: unknown }).extras;
    const entry =
        extras && typeof extras === 'object'
            ? (extras as Record<string, unknown>)[key]
            : undefined;
    const raw =
        entry && typeof entry === 'object'
            ? (entry as { hashtags?: unknown }).hashtags
            : undefined;
    return normalizePublishHashtags(raw as readonly unknown[] | undefined);
}

/** Resultado de la composición por target (texto final + detalle jsonb). */
export interface PublishComposition {
    target: PublishTarget;
    /** Texto final: content persistido y enviado a Zernio. */
    content: string;
    /** Menciones resueltas para la red (tras exclusiones). */
    mentions: ResolvedMention[];
    /** '#tag' normalizados incluidos en la composición. */
    hashtags: string[];
    /** true si el límite de la plataforma truncó el texto base. */
    truncated: boolean;
}

type PublishCompositionInput = Pick<
    EnqueuePublishJobsInput,
    | 'tenantId'
    | 'assetId'
    | 'publicationId'
    | 'targets'
    | 'content'
    | 'personIds'
    | 'excludePersonIds'
    | 'hashtags'
>;

/**
 * Compone el texto por red para cada target:
 *   personIds (explícitos o de `quotes` del origen) → persons tenant-scoped
 *   → `resolvePublishMentions` por plataforma (excluyendo los toggles) →
 *   hashtags = extras de `contentVariants` (respetados) + explícitos del
 *   request → `composePublishContent` (determinista, límites por red).
 *
 * Los handles salen SIEMPRE de `persons.social_links` del tenant — jamás
 * del nombre ni del LLM. Personas sin handle en la red no se mencionan.
 */
async function composeForTargets(
    input: PublishCompositionInput,
    deps?: PublishJobDeps,
): Promise<PublishComposition[]> {
    const source =
        input.assetId || input.publicationId
            ? await (
                  deps?.getMentionSource ?? defaultGetMentionSource
              )(input.tenantId, {
                  assetId: input.assetId ?? null,
                  publicationId: input.publicationId ?? null,
              })
            : null;

    const personIds = input.personIds ?? extractPersonIds(source?.quotes);
    const personsList =
        personIds.length > 0
            ? await (
                  deps?.listMentionPersons ?? defaultListMentionPersons
              )(input.tenantId, personIds)
            : [];

    const excluded = new Set(input.excludePersonIds ?? []);
    const requestTags = input.hashtags ?? [];

    return input.targets.map((target) => {
        const mentions = resolvePublishMentions(personsList, target.platform, {
            exclude: excluded,
        });
        // Orden: primero las etiquetas del contenido (respetadas), después
        // las explícitas del request — dedupe case-insensitive por orden.
        const hashtags = normalizePublishHashtags([
            ...variantHashtagsFor(source?.contentVariants, target.platform),
            ...requestTags,
        ]);
        const composed = composePublishContent({
            baseText: input.content,
            platform: target.platform,
            mentions,
            hashtags,
        });
        return {
            target,
            content: composed.text,
            mentions,
            hashtags,
            truncated: composed.truncated,
        };
    });
}

/** jsonb persistido por job — la estructura detrás del `content` final. */
function payloadForComposition(
    composition: PublishComposition,
    excludePersonIds: readonly string[],
): PublishJobPayload | undefined {
    const { mentions, hashtags, truncated } = composition;
    if (mentions.length === 0 && hashtags.length === 0 && !truncated) {
        return undefined;
    }
    return {
        mentions: mentions.map((m) => ({
            personId: m.personId,
            name: m.name,
            handle: m.handle,
        })),
        hashtags,
        ...(excludePersonIds.length > 0
            ? { excludedPersonIds: [...excludePersonIds] }
            : {}),
        ...(truncated ? { truncated: true } : {}),
    };
}

/**
 * Encola UN job por target. Dedup por idempotency_key: re-encolar el mismo
 * (tenant, origen, plataforma, cuenta) devuelve el job existente — nunca
 * duplica. Todos los jobs comparten origen/contenido/schedule.
 *
 * PG-06: el `content` de cada job es el texto FINAL compuesto para su red
 * (menciones reales de `persons.social_links` + etiquetas), y `payload`
 * guarda la estructura (menciones/etiquetas/exclusiones/truncado) para la
 * UI. La idempotency_key no entra en la composición: re-aprobar con otras
 * exclusiones cae en el MISMO job (dedupe por origen×plataforma×cuenta).
 */
export async function enqueuePublishJobs(
    input: EnqueuePublishJobsInput,
    deps?: PublishJobDeps,
): Promise<EnqueuePublishJobsResult> {
    if (!input.tenantId) {
        throw new AppError('tenantId es obligatorio', 400, 'invalid_input');
    }
    if (!input.content || input.content.trim() === '') {
        throw new AppError('content es obligatorio', 400, 'invalid_content');
    }
    if (!Array.isArray(input.targets) || input.targets.length === 0) {
        throw new AppError('Se requiere al menos un destino (targets[])', 400, 'invalid_targets');
    }
    const store = resolveStore(deps);
    const now = deps?.now?.() ?? new Date();
    const mediaUrls = input.mediaUrls ?? [];
    const scheduledFor = input.scheduledFor ?? null;
    // El gate del claim: sale cuando el usuario quiso; sin schedule, ya.
    const nextAttemptAt = scheduledFor && scheduledFor.getTime() > now.getTime()
        ? scheduledFor
        : now;

    // PG-06: texto final por red (menciones + etiquetas) para cada target.
    const compositions = await composeForTargets(input, deps);
    const excludePersonIds = input.excludePersonIds ?? [];

    const jobs: PublishJob[] = [];
    let createdCount = 0;
    let deduplicatedCount = 0;
    const seenKeys = new Set<string>();

    for (const composition of compositions) {
        const { target } = composition;
        const idempotencyKey = deriveIdempotencyKey({
            tenantId: input.tenantId,
            assetId: input.assetId,
            publicationId: input.publicationId,
            platform: target.platform,
            accountId: target.accountId,
            contentFingerprint:
                input.assetId || input.publicationId
                    ? null
                    : fingerprintContent(input.content),
        });
        // Dos targets iguales en el mismo request → un solo job.
        if (seenKeys.has(idempotencyKey)) continue;
        seenKeys.add(idempotencyKey);

        const payload = payloadForComposition(composition, excludePersonIds);
        const { job, created } = await store.enqueueJob({
            tenantId: input.tenantId,
            assetId: input.assetId ?? null,
            publicationId: input.publicationId ?? null,
            connectionId: target.connectionId ?? null,
            platform: target.platform,
            accountId: target.accountId,
            idempotencyKey,
            content: composition.content,
            ...(payload !== undefined ? { payload } : {}),
            mediaUrls,
            scheduledFor,
            nextAttemptAt,
            ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        });
        jobs.push(job);
        if (created) createdCount += 1;
        else deduplicatedCount += 1;
    }
    return { jobs, createdCount, deduplicatedCount };
}

export async function listPublishJobs(
    tenantId: string,
    opts: ListPublishJobsOptions = {},
    deps?: PublishJobDeps,
): Promise<{ jobs: PublishJob[]; total: number }> {
    const store = resolveStore(deps);
    const [jobs, total] = await Promise.all([
        store.list(tenantId, opts),
        store.count(tenantId, opts.status),
    ]);
    return { jobs, total };
}

export async function getPublishJob(
    tenantId: string,
    id: string,
    deps?: PublishJobDeps,
): Promise<PublishJob | null> {
    return resolveStore(deps).getById(id, tenantId);
}

/**
 * Resuelve las cuentas destino al aprobar: todas las `social_connections`
 * con status='connected' del tenant, filtradas por las plataformas de la
 * config auto-publish `on_approval` cuando existe alguna activa
 * (mode='on_approval' significa literalmente "publicar al aprobar" — el
 * union de plataformas de esas configs es el filtro; sin config activa el
 * approve manual publica en todas las cuentas conectadas).
 *
 * PG-07: este paso sólo produce CANDIDATOS Zernio — qué plataforma usa qué
 * canal lo decide `planPublishChannels` dentro de `enqueueForApproval`.
 */
export async function resolvePublishTargets(
    tenantId: string,
    deps?: PublishJobDeps,
): Promise<{
    connections: SocialConnectionRow[];
    targets: PublishTarget[];
    onApproval: { active: boolean; platforms: Set<string> };
}> {
    const listConnectionsFn =
        deps?.listConnections ?? ((t: string) => listSocialConnections(t));
    const listConfigsFn =
        deps?.listAutoPublishConfigs ?? ((t: string) => listAutoPublishConfigs(t));
    const [connections, configs] = await Promise.all([
        listConnectionsFn(tenantId),
        listConfigsFn(tenantId),
    ]);
    const connected = connections.filter(
        // Doble filtro por tenant (defensa en profundidad): el store ya es
        // tenant-scoped, pero si una impl custom devolviera filas ajenas un
        // job apuntaría a una cuenta de OTRO tenant — inaceptable.
        (c) => c.tenantId === tenantId && c.status === 'connected',
    );

    const onApprovalPlatforms = new Set<string>();
    let hasOnApproval = false;
    for (const cfg of configs) {
        if (!cfg.isActive || cfg.mode !== 'on_approval') continue;
        hasOnApproval = true;
        for (const p of cfg.platforms) onApprovalPlatforms.add(p);
    }

    const targets = connected
        .filter((c) => !hasOnApproval || onApprovalPlatforms.has(c.platform))
        .map((c) => ({ platform: c.platform, accountId: c.accountId, connectionId: c.id }));
    return {
        connections: connected,
        targets,
        onApproval: { active: hasOnApproval, platforms: onApprovalPlatforms },
    };
}

export interface EnqueueForApprovalResult {
    /**
     * El circuito Zernio participa del approve: hay al menos una conexión
     * cuya plataforma resolvió 'zernio' (PG-07). false ⇒ la ruta sigue el
     * flujo legacy con `publishToChannels` — filtrado a `legacyPlatforms`
     * cuando hay alguna, o completo cuando no hay ninguna (exactamente el
     * comportamiento previo para un tenant sin config).
     */
    usedZernio: boolean;
    /** Conexiones 'connected' encontradas (antes del filtro de config). */
    connectionCount: number;
    /** Destinos Zernio efectivos (los que resolvieron canal 'zernio'). */
    targets: PublishTarget[];
    jobs: PublishJob[];
    createdCount: number;
    deduplicatedCount: number;
    /** PG-07: modo de canal efectivo del tenant ('hybrid' si no configuró). */
    channelMode: PublishChannelMode;
    /** PG-07: el request pidió explícitamente el canal legacy (Meta/Twitter). */
    forceLegacy: boolean;
    /**
     * PG-07: plataformas Meta/Twitter que deben publicar por el canal
     * directo (publishToChannels filtrado). Vacío ⇒ no hay tramo legacy.
     */
    legacyPlatforms: string[];
    /**
     * PG-07: plataformas con camino legacy que no tienen canal para esta
     * publicación (p.ej. modo 'zernio' sin conexión y sin forceLegacy) —
     * la ruta las informa, no las publica.
     */
    skipped: { platform: string; reason: string }[];
}

/**
 * Partición de la resolución: qué targets van por Zernio, qué plataformas
 * quedan en el canal legacy y qué candidatas no tienen camino. Compartida
 * por `enqueueForApproval` y `previewPublishEnqueue`.
 */
async function planApprovalChannels(
    tenantId: string,
    connections: SocialConnectionRow[],
    targets: PublishTarget[],
    onApproval: { active: boolean; platforms: Set<string> },
    input: { forceLegacy?: boolean },
    deps?: PublishJobDeps,
): Promise<{
    plan: PublishChannelPlan;
    zernioTargets: PublishTarget[];
    usedZernio: boolean;
    legacyPlatforms: string[];
    skipped: { platform: string; reason: string }[];
}> {
    const plan = await planPublishChannels(
        tenantId,
        {
            store: deps?.channelStore,
            // Reusa las conexiones ya resueltas — mismo set 'connected',
            // sin doble query.
            listConnections: async () => connections,
            envTwitterBot: deps?.envTwitterBot,
        },
        { forceLegacy: input.forceLegacy === true },
    );

    const zernioTargets = targets.filter(
        (t) => plan.resolve(t.platform).channel === 'zernio',
    );
    // engaged = alguna conexión conectada resolvió 'zernio' — aunque la
    // config on_approval después filtre sus targets (igual que antes).
    const usedZernio = connections.some(
        (c) => plan.resolve(c.platform).channel === 'zernio',
    );

    // La config on_approval (PG-03) también filtra el tramo legacy cuando
    // el circuito Zernio está en juego — nunca en modo 'legacy' (ahí la
    // publicación directa es la regla, como hoy) ni cuando no hay Zernio
    // (la config siempre fue del circuito Zernio).
    const legacyPlatforms =
        usedZernio && onApproval.active && plan.mode !== 'legacy'
            ? plan.legacyPlatforms.filter((p) => onApproval.platforms.has(p))
            : plan.legacyPlatforms;

    // Candidatas sin canal en esta publicación: plataformas legacy-capable
    // con camino que el modo deja fuera (modo 'zernio' sin conexión →
    // legacy sólo bajo demanda) y —bajo forceLegacy— las sin camino legacy
    // (el usuario pidió el canal directo y no existe).
    const skipped = LEGACY_PLATFORMS.map((p) => plan.resolve(p))
        .filter(
            (r) =>
                r.channel === 'none' &&
                (r.hasLegacyPath || plan.forceLegacy),
        )
        .map((r) => ({ platform: r.platform, reason: r.reason ?? '' }));

    return { plan, zernioTargets, usedZernio, legacyPlatforms, skipped };
}

/**
 * Circuito de aprobación real (PG-07): el plan de canales del tenant decide
 * qué va por Zernio (encola jobs) y qué queda en el tramo legacy
 * (`legacyPlatforms` → publishToChannels filtrado en la ruta). Sin camino
 * Zernio NI plataformas legacy resueltas → `usedZernio:false` +
 * `legacyPlatforms:[]` ⇒ la ruta hace el publishToChannels completo de
 * siempre (cero regresión para un tenant sin config).
 */
export async function enqueueForApproval(
    input: {
        tenantId: string;
        assetId?: string | null;
        publicationId?: string | null;
        content: string;
        mediaUrls?: string[];
        scheduledFor?: Date | null;
        /** PG-06: personas explícitas a mencionar (uuid). */
        personIds?: string[];
        /** PG-06: personas excluidas de las menciones (toggle de la UI). */
        excludePersonIds?: string[];
        /** PG-06: etiquetas explícitas del request de aprobación. */
        hashtags?: string[];
        /**
         * PG-07: fuerza el canal legacy para Meta/Twitter en ESTA
         * publicación (la única vía legacy en modo 'zernio').
         */
        forceLegacy?: boolean;
    },
    deps?: PublishJobDeps,
): Promise<EnqueueForApprovalResult> {
    const { connections, targets, onApproval } = await resolvePublishTargets(
        input.tenantId,
        deps,
    );
    const { plan, zernioTargets, usedZernio, legacyPlatforms, skipped } =
        await planApprovalChannels(
            input.tenantId,
            connections,
            targets,
            onApproval,
            input,
            deps,
        );

    if (zernioTargets.length === 0) {
        return {
            usedZernio,
            connectionCount: connections.length,
            targets: [],
            jobs: [],
            createdCount: 0,
            deduplicatedCount: 0,
            channelMode: plan.mode,
            forceLegacy: plan.forceLegacy,
            legacyPlatforms,
            skipped,
        };
    }
    const enqueued = await enqueuePublishJobs(
        {
            tenantId: input.tenantId,
            assetId: input.assetId ?? null,
            publicationId: input.publicationId ?? null,
            targets: zernioTargets,
            content: input.content,
            mediaUrls: input.mediaUrls,
            scheduledFor: input.scheduledFor,
            personIds: input.personIds,
            excludePersonIds: input.excludePersonIds,
            hashtags: input.hashtags,
        },
        deps,
    );
    return {
        usedZernio,
        connectionCount: connections.length,
        targets: zernioTargets,
        jobs: enqueued.jobs,
        createdCount: enqueued.createdCount,
        deduplicatedCount: enqueued.deduplicatedCount,
        channelMode: plan.mode,
        forceLegacy: plan.forceLegacy,
        legacyPlatforms,
        skipped,
    };
}

// ---------------------------------------------------------------------------
// PG-06 — previsualización antes de aprobar
// ---------------------------------------------------------------------------

/** Lo que la UI muestra por destino antes de confirmar la aprobación. */
export interface PublishPreviewItem {
    platform: string;
    accountId: string;
    connectionId: string | null;
    /** username/displayName de la conexión — label humano (nunca credencial). */
    accountLabel: string | null;
    /** Texto final que se va a mandar a la red (menciones + etiquetas). */
    content: string;
    mentions: ResolvedMention[];
    hashtags: string[];
    /** Límite de caracteres de la plataforma (null = sin límite aplicado). */
    textLimit: number | null;
    truncated: boolean;
}

export interface PublishPreviewResult {
    /** false ⇒ sin tramo Zernio — la ruta sigue el flujo legacy. */
    usedZernio: boolean;
    connectionCount: number;
    previews: PublishPreviewItem[];
    /** PG-07: modo de canal efectivo del tenant. */
    channelMode: PublishChannelMode;
    /** PG-07: plataformas Meta/Twitter que publicarían por el canal directo. */
    legacyPlatforms: string[];
    /** PG-07: candidatas con camino legacy sin canal en esta publicación. */
    skipped: { platform: string; reason: string }[];
}

/**
 * Previsualización del circuito de aprobación: resuelve los targets como
 * `enqueueForApproval` (mismo plan de canales PG-07 — los previews sólo
 * cubren los destinos Zernio; las plataformas legacy se informan en
 * `legacyPlatforms`) y compone el texto por red SIN encolar nada. La UI
 * lo llama antes de aprobar (con los `excludePersonIds` del toggle) para
 * mostrar menciones, etiquetas y el texto final por red.
 */
export async function previewPublishEnqueue(
    input: {
        tenantId: string;
        assetId?: string | null;
        publicationId?: string | null;
        content: string;
        personIds?: string[];
        excludePersonIds?: string[];
        hashtags?: string[];
        /** PG-07: fuerza el canal legacy para Meta/Twitter en el preview. */
        forceLegacy?: boolean;
    },
    deps?: PublishJobDeps,
): Promise<PublishPreviewResult> {
    const { connections, targets, onApproval } = await resolvePublishTargets(
        input.tenantId,
        deps,
    );
    const { plan, zernioTargets, usedZernio, legacyPlatforms, skipped } =
        await planApprovalChannels(
            input.tenantId,
            connections,
            targets,
            onApproval,
            input,
            deps,
        );
    if (zernioTargets.length === 0) {
        return {
            usedZernio,
            connectionCount: connections.length,
            previews: [],
            channelMode: plan.mode,
            legacyPlatforms,
            skipped,
        };
    }
    const compositions = await composeForTargets(
        { ...input, targets: zernioTargets },
        deps,
    );
    const labelOf = (target: PublishTarget): string | null => {
        const conn = connections.find(
            (c) =>
                c.id === target.connectionId ||
                (c.platform === target.platform &&
                    c.accountId === target.accountId),
        );
        return conn?.username ?? conn?.displayName ?? null;
    };
    return {
        usedZernio,
        connectionCount: connections.length,
        previews: compositions.map((c) => ({
            platform: c.target.platform,
            accountId: c.target.accountId,
            connectionId: c.target.connectionId ?? null,
            accountLabel: labelOf(c.target),
            content: c.content,
            mentions: c.mentions,
            hashtags: c.hashtags,
            textLimit:
                PUBLISH_TEXT_LIMITS[c.target.platform as PublishPlatform] ??
                null,
            truncated: c.truncated,
        })),
        channelMode: plan.mode,
        legacyPlatforms,
        skipped,
    };
}

// ---------------------------------------------------------------------------
// Validación del request de publicación (PG-06)
// ---------------------------------------------------------------------------

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opciones de publicación del body (approve / publish-preview / POST
 * /publish-jobs): `personIds` y `excludePersonIds` deben ser arrays de
 * uuid; `hashtags` un array de strings (máx 30, ≤100 chars c/u — se
 * normalizan a '#tag' y los que no dejan nada usable se descartan);
 * `forceLegacy` (PG-07) un booleano — el "publicar por canal legacy" bajo
 * demanda del modo 'zernio'.
 * Devuelve los campos presentes ya saneados; tira AppError 400 si vienen
 * mal tipados.
 */
export function validatePublishOptions(body: Record<string, unknown>): {
    personIds?: string[];
    excludePersonIds?: string[];
    hashtags?: string[];
    forceLegacy?: boolean;
} {
    const out: {
        personIds?: string[];
        excludePersonIds?: string[];
        hashtags?: string[];
        forceLegacy?: boolean;
    } = {};
    for (const field of ['personIds', 'excludePersonIds'] as const) {
        const value = body[field];
        if (value === undefined || value === null) continue;
        if (
            !Array.isArray(value) ||
            value.some(
                (v) => typeof v !== 'string' || !UUID_RE.test(v),
            )
        ) {
            throw new AppError(
                `${field} debe ser un array de uuid`,
                400,
                'invalid_persons',
            );
        }
        out[field] = [...new Set(value as string[])];
    }
    const hashtags = body.hashtags;
    if (hashtags !== undefined && hashtags !== null) {
        if (
            !Array.isArray(hashtags) ||
            hashtags.length > 30 ||
            hashtags.some(
                (v) => typeof v !== 'string' || v.length > 100,
            )
        ) {
            throw new AppError(
                'hashtags debe ser un array de hasta 30 strings (≤100 chars c/u)',
                400,
                'invalid_hashtags',
            );
        }
        out.hashtags = normalizePublishHashtags(
            hashtags as readonly unknown[],
        );
    }
    const forceLegacy = body.forceLegacy;
    if (forceLegacy !== undefined && forceLegacy !== null) {
        if (typeof forceLegacy !== 'boolean') {
            throw new AppError(
                'forceLegacy debe ser booleano',
                400,
                'invalid_channel',
            );
        }
        if (forceLegacy) out.forceLegacy = true;
    }
    return out;
}

/**
 * Reintento manual (tenant-scoped). Dos caminos:
 *   - el job tiene `zernio_post_id` (el post ya existe en Zernio) → retry
 *     remoto `POST /v1/posts/{postId}/retry`, que reintenta las plataformas
 *     fallidas del MISMO post (la semántica correcta para `partial`).
 *   - sin zernio_post_id (el post nunca llegó a crearse) → re-encola el job
 *     local para que el worker lo despache otra vez.
 * Respeta `max_attempts` en ambos caminos: cada reintento consume un intento.
 */
export async function retryPublishJob(
    tenantId: string,
    jobId: string,
    deps?: PublishJobDeps,
): Promise<PublishJob> {
    const store = resolveStore(deps);
    const job = await store.getById(jobId, tenantId);
    if (!job) {
        throw new AppError('Job de publicación no encontrado', 404, 'publish_job_not_found');
    }
    if (job.status !== 'failed' && job.status !== 'partial') {
        throw new AppError(
            `No se puede reintentar un job en estado '${job.status}'`,
            409,
            'invalid_transition',
        );
    }
    if (job.attempts >= job.maxAttempts) {
        throw new AppError(
            `El job alcanzó el máximo de intentos (${job.maxAttempts})`,
            409,
            'max_attempts_reached',
        );
    }

    if (job.zernioPostId) {
        // Consume un intento ANTES del retry remoto — respeta max_attempts
        // aunque la llamada a Zernio explote (429/503 quedan como AppError).
        const api = deps?.zernio ?? createZernioApi();
        await store.recordAttempt(job.id);
        const result = await api.retryPost(job.zernioPostId);
        const settled = await settleJobFromPublishResult(
            { ...job, attempts: job.attempts + 1 },
            result,
            deps,
        );
        return settled.job;
    }

    const now = deps?.now?.() ?? new Date();
    const requeued = await store.requeue(job.id, tenantId, { nextAttemptAt: now });
    if (!requeued) {
        throw new AppError(
            `No se puede reintentar un job en estado '${job.status}'`,
            409,
            'invalid_transition',
        );
    }
    return requeued;
}

/** Cancelación manual (tenant-scoped): sólo `queued`/`publishing`. */
export async function cancelPublishJob(
    tenantId: string,
    jobId: string,
    deps?: PublishJobDeps,
): Promise<PublishJob> {
    const store = resolveStore(deps);
    const job = await store.getById(jobId, tenantId);
    if (!job) {
        throw new AppError('Job de publicación no encontrado', 404, 'publish_job_not_found');
    }
    const cancelled = await store.cancel(job.id, tenantId);
    if (!cancelled) {
        throw new AppError(
            `No se puede cancelar un job en estado '${job.status}'`,
            409,
            'invalid_transition',
        );
    }
    return cancelled;
}

// ---------------------------------------------------------------------------
// Resultado de Zernio → estado del job (compartido worker/retry)
// ---------------------------------------------------------------------------

export type PublishOutcome = 'published' | 'partial' | 'failed' | 'inflight' | 'cancelled';

export interface SettledPublishJob {
    job: PublishJob;
    outcome: PublishOutcome;
}

/**
 * Elige el platform entry que corresponde a ESTE job (matchea accountId;
 * si no hay match toma el primero — nuestros jobs son single-plataforma).
 */
export function platformEntryFor(
    result: ZernioPublishResult,
    job: Pick<PublishJob, 'platform' | 'accountId'>,
) {
    const entries = result.post?.platforms ?? [];
    return (
        entries.find(
            (e) =>
                e.accountId === job.accountId &&
                e.platform === job.platform,
        ) ?? entries[0] ?? null
    );
}

const firstFailedEntry = (result: ZernioPublishResult) =>
    (result.post?.platforms ?? []).find((e) => e.status === 'failed') ?? null;

/**
 * Aplica el resultado de publishPost/retryPost a la fila del job:
 *   post.status 'published'        → markPublished (+url de la plataforma)
 *   'partial' | HTTP 207           → markPartial (+error de la entry fallida)
 *   'failed'                       → markFailed TERMINAL — el post ya existe
 *     en Zernio y re-publicar con la misma Idempotency-Key sólo repliquea el
 *     mismo post fallido: el retry correcto es POST /posts/{id}/retry
 *     (camino manual). Los fallos ANTES de crear el post (429/503/red) son
 *     los que el worker reintenta re-encolando.
 *   'scheduled'|'publishing'|… |202→ markPublishing + nota: el post existe
 *     pero sigue en curso (esperando fondos/agenda — un webhook o poll
 *     futuro lo cierra; el job queda observable en 'publishing').
 *   'cancelled'                    → markCancelled.
 */
export async function settleJobFromPublishResult(
    job: PublishJob,
    result: ZernioPublishResult,
    deps?: PublishJobDeps,
): Promise<SettledPublishJob> {
    const store = resolveStore(deps);
    const post = result.post;
    const zernioPostId = post?.id ?? job.zernioPostId ?? null;
    const entry = platformEntryFor(result, job);

    if (!post) {
        const updated = await store.markFailed(job.id, {
            message: 'Zernio respondió 2xx sin datos del post',
            category: 'system_error',
            source: 'system',
            zernioPostId,
        });
        return { job: updated ?? job, outcome: 'failed' };
    }

    // 202: creado pero X quedó esperando fondos — post existe, sigue en curso.
    if (result.httpStatus === 202) {
        const updated = await store.markPublishing(job.id, {
            zernioPostId,
            note: 'Post creado en Zernio — X pendiente de fondos (awaiting_funding)',
        });
        return { job: updated ?? job, outcome: 'inflight' };
    }

    switch (post.status) {
        case 'published': {
            const updated = await store.markPublished(job.id, {
                zernioPostId,
                platformPostUrl: entry?.platformPostUrl ?? null,
            });
            return { job: updated ?? job, outcome: 'published' };
        }
        case 'partial': {
            const failed = firstFailedEntry(result);
            const updated = await store.markPartial(job.id, {
                zernioPostId,
                platformPostUrl:
                    entry?.status === 'published' ? entry.platformPostUrl : null,
                error: failed
                    ? {
                          message:
                              failed.errorMessage ??
                              `La plataforma ${failed.platform} falló`,
                          category: failed.errorCategory,
                          source: failed.errorSource,
                      }
                    : {
                          message: 'Publicación parcial entre plataformas',
                          category: 'platform_error',
                          source: 'platform',
                      },
            });
            return { job: updated ?? job, outcome: 'partial' };
        }
        case 'failed': {
            const failed = firstFailedEntry(result) ?? entry;
            const category =
                failed?.errorCategory && isPublishErrorCategory(failed.errorCategory)
                    ? failed.errorCategory
                    : 'platform_error';
            const updated = await store.markFailed(job.id, {
                message: failed?.errorMessage ?? 'La publicación falló en Zernio',
                category,
                source: failed?.errorSource ?? publishErrorSource(category),
                zernioPostId,
            });
            return { job: updated ?? job, outcome: 'failed' };
        }
        case 'cancelled': {
            const updated = await store.markCancelled(job.id);
            return { job: updated ?? job, outcome: 'cancelled' };
        }
        default: {
            // scheduled | publishing | draft | pending_approval | desconocido.
            const updated = await store.markPublishing(job.id, {
                zernioPostId,
                note: `Post en curso en Zernio (status: ${post.status})`,
            });
            return { job: updated ?? job, outcome: 'inflight' };
        }
    }
}
