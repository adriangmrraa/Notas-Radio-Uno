/**
 * publishWorker — loop de dispatch de la cola `publish_jobs` (PG-05).
 *
 * Cada `PUBLISH_WORKER_POLL_MS` (default 10 s) un tick claimea UN job vía
 * `store.claimNext(now)` (gate: `status='queued' AND next_attempt_at<=now`)
 * y lo publica contra Zernio:
 *
 *   1. Resuelve el perfil Zernio del tenant (`getZernioProfile`) — la API
 *      key es de la plataforma; el aislamiento es por profileId. Sin perfil
 *      → `failed` terminal con categoría `account_issue`.
 *   2. `publishPost({profileId, content, mediaUrls, platforms:[{platform,
 *      accountId}], publishNow|scheduledFor, idempotencyKey})` — la key
 *      persistente del job viaja como header Idempotency-Key, así un retry
 *      del worker NUNCA duplica el post (Zernio 200 replay).
 *   3. `settleJobFromPublishResult` mapea el resultado a la fila:
 *      published/partial/failed/in-flight (scheduled/publishing/202
 *      awaiting_funding quedan en `publishing` con nota — los cierra un
 *      webhook/poll futuro).
 *
 * Reintento automático: un AppError de la llamada se clasifica con
 * `categorizePublishError` — categoría/HTTP reintentable (platform_error,
 * system_error, platform_rate_limit, 429/503) y `attempts < max_attempts`
 * → vuelve a `queued` con `next_attempt_at = now + attempts*BACKOFF`
 * (lineal, 1 min por intento — el claim ya consumió el attempt). No
 * reintentable o tope alcanzado → `failed` terminal. Un post YA CREADO que
 * quedó `failed` nunca se re-encola (el retry correcto es
 * POST /posts/{id}/retry — camino manual): re-publicar con la misma
 * Idempotency-Key sólo repliquea el post fallido.
 *
 * Fire-and-forget como clipRenderWorker: el intervalo no espera el tick;
 * en tests se llama `worker.tick()` con await → determinista.
 *
 * `io` opcional emite por room `tenant:{tenantId}` eventos `publish:job:*`
 * sólo en outcomes terminales: `publish:job:published`, `publish:job:partial`,
 * `publish:job:failed`, `publish:job:cancelled`. Un job re-encolado o en
 * curso no emite (sigue en vuelo, no es terminal).
 *
 * syncSourceStatus: tras cada outcome terminal, si TODOS los jobs del mismo
 * origen (asset_id o publication_id) están `published` → el origen pasa a
 * `published` (asset: transición canónica PG-01 + write-through;
 * publication: status legacy directo). Cualquier `partial`/`failed`
 * terminal → el origen queda en `approved` (el operador decide).
 *
 * Un solo worker por proceso: `initPublishWorker` guard + `stopPublishWorker`.
 */
import type { Server } from 'socket.io';

import { AppError } from '../lib/errors.js';
import { transitionAsset } from './assetsService.js';
import { updatePublicationStatus } from './databaseService.js';
import { createDrizzleSocialConnectionsStore } from './socialConnectionsService.js';
import {
    createDrizzlePublishJobStore,
    categorizePublishError,
    settleJobFromPublishResult,
    type PublishJob,
    type PublishJobDeps,
    type PublishJobStore,
} from './publishJobService.js';
import { createZernioApi, type ZernioApi } from './zernioService.js';

/** Intervalo de claim por default: 10 s (env `PUBLISH_WORKER_POLL_MS`). */
export const POLL_MS = 10_000;
/** Backoff lineal: `attempts * 60_000` ms (1 min por intento). */
export const BACKOFF_STEP_MS = 60_000;

// ---------------------------------------------------------------------------
// Dependencias inyectables
// ---------------------------------------------------------------------------

/** Subconjunto estructural de `socket.io.Server` que el worker necesita. */
export interface PublishWorkerIo {
    to(room: string): { emit(event: string, payload: unknown): unknown };
}

export interface PublishWorkerDeps {
    store?: PublishJobStore;
    /** Default: createZernioApi() — los tests inyectan un fake. */
    zernio?: Pick<ZernioApi, 'publishPost' | 'retryPost'>;
    /** Perfil Zernio del tenant (aislamiento por profileId). Default: drizzle. */
    getZernioProfile?: (tenantId: string) => Promise<{ profileId: string } | null>;
    /**
     * Sync del estado del origen tras un outcome terminal. Default:
     * `syncSourceStatus` con los mismos stores del worker. Los tests lo
     * pisan para observar o aislar el write-through.
     */
    syncSourceStatus?: (job: PublishJob) => Promise<void>;
    /** Deps extra pasadas a settleJobFromPublishResult/syncSourceStatus. */
    publishDeps?: PublishJobDeps;
    now?: () => Date;
    /** Backoff en ms según el nº de intento ya consumido. Default lineal 1min. */
    backoffMs?: (attempts: number) => number;
}

interface ResolvedWorkerDeps {
    store: PublishJobStore;
    zernio: Pick<ZernioApi, 'publishPost' | 'retryPost'>;
    getZernioProfile: (tenantId: string) => Promise<{ profileId: string } | null>;
    syncSourceStatus: (job: PublishJob) => Promise<void>;
    publishDeps: PublishJobDeps;
    now: () => Date;
    backoffMs: (attempts: number) => number;
}

function resolveDeps(deps: PublishWorkerDeps): ResolvedWorkerDeps {
    const store = deps.store ?? createDrizzlePublishJobStore();
    const publishDeps: PublishJobDeps = { ...deps.publishDeps, store };
    return {
        store,
        zernio: deps.zernio ?? createZernioApi(),
        getZernioProfile:
            deps.getZernioProfile ??
            (async (tenantId) => {
                const profile = await createDrizzleSocialConnectionsStore().getZernioProfile(
                    tenantId,
                );
                return profile ? { profileId: profile.profileId } : null;
            }),
        publishDeps,
        syncSourceStatus:
            deps.syncSourceStatus ?? ((job) => syncSourceStatus(job, publishDeps)),
        now: deps.now ?? (() => new Date()),
        backoffMs: deps.backoffMs ?? ((attempts) => attempts * BACKOFF_STEP_MS),
    };
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function emitToTenant(
    io: PublishWorkerIo | undefined,
    tenantId: string,
    event: string,
    payload: Record<string, unknown>,
): void {
    if (!io) return;
    try {
        io.to(`tenant:${tenantId}`).emit(event, payload);
    } catch (err) {
        console.error(`[PublishWorker] emit ${event} falló:`, errorMessage(err));
    }
}

// ---------------------------------------------------------------------------
// syncSourceStatus — write-through del estado editorial del origen
// ---------------------------------------------------------------------------

/**
 * Tras un outcome terminal, si TODOS los jobs del mismo origen están
 * `published` → el origen pasa a `published`:
 *   - `asset_id` → transición canónica `approved → published` de PG-01
 *     (`transitionAsset` valida la arista y hace write-through a la tabla
 *     fuente; una transición inválida — p.ej. el asset no está 'approved' —
 *     se loguea y NO rompe el worker).
 *   - `publication_id` → `updatePublicationStatus` directo (fuente legacy).
 * Cualquier job `partial`/`failed` terminal o en vuelo → el origen queda en
 * `approved`: el operador revisa el error y decide retry/cancel.
 */
export async function syncSourceStatus(
    job: PublishJob,
    deps?: PublishJobDeps,
): Promise<void> {
    const store = deps?.store ?? createDrizzlePublishJobStore();
    const siblings = await store.listBySource(job.tenantId, {
        assetId: job.assetId,
        publicationId: job.publicationId,
    });
    if (siblings.length === 0 || !siblings.every((s) => s.status === 'published')) {
        return;
    }
    const transitionAssetTo =
        deps?.transitionAssetTo ?? ((input: { tenantId: string; assetId: string; to: 'published' }) => transitionAsset(input));
    const markPublicationPublished =
        deps?.markPublicationPublished ??
        ((tenantId: string, publicationId: string) =>
            updatePublicationStatus(publicationId, tenantId, 'published'));

    if (job.assetId) {
        try {
            await transitionAssetTo({
                tenantId: job.tenantId,
                assetId: job.assetId,
                to: 'published',
            });
        } catch (err) {
            console.warn(
                `[PublishWorker] syncSourceStatus: transición del asset ${job.assetId} a 'published' falló:`,
                errorMessage(err),
            );
        }
    }
    if (job.publicationId) {
        try {
            await markPublicationPublished(job.tenantId, job.publicationId);
        } catch (err) {
            console.warn(
                `[PublishWorker] syncSourceStatus: publication ${job.publicationId} a 'published' falló:`,
                errorMessage(err),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface PublishWorker {
    /**
     * Un tick: claim de UN job + dispatch. Resuelve cuando el job claimeado
     * terminó — el `init` lo llama fire-and-forget; los tests lo esperan.
     */
    tick(): Promise<void>;
}

export function createPublishWorker(
    deps: PublishWorkerDeps = {},
    io?: PublishWorkerIo,
): PublishWorker {
    const resolved = resolveDeps(deps);
    const { store, now } = resolved;

    const emitTerminal = (job: PublishJob, outcome: string): void => {
        const payload = {
            jobId: job.id,
            assetId: job.assetId,
            publicationId: job.publicationId,
            platform: job.platform,
            accountId: job.accountId,
            zernioPostId: job.zernioPostId,
            platformPostUrl: job.platformPostUrl,
            lastError: job.lastError,
            lastErrorCategory: job.lastErrorCategory,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
        };
        switch (outcome) {
            case 'published':
                emitToTenant(io, job.tenantId, 'publish:job:published', payload);
                break;
            case 'partial':
                emitToTenant(io, job.tenantId, 'publish:job:partial', payload);
                break;
            case 'failed':
                emitToTenant(io, job.tenantId, 'publish:job:failed', payload);
                break;
            case 'cancelled':
                emitToTenant(io, job.tenantId, 'publish:job:cancelled', payload);
                break;
        }
    };

    async function dispatch(job: PublishJob): Promise<void> {
        const profile = await resolved.getZernioProfile(job.tenantId);
        if (!profile) {
            // Sin perfil Zernio el post no puede crearse nunca → terminal.
            const updated = await store.markFailed(job.id, {
                message: 'El tenant no tiene perfil Zernio para publicar',
                category: 'account_issue',
                source: 'user',
            });
            if (updated?.status === 'failed') {
                emitTerminal(updated, 'failed');
                await resolved.syncSourceStatus(updated);
            }
            return;
        }

        try {
            // El claim ya garantizó next_attempt_at<=now: un job con
            // scheduled_for sale cuando llegó su hora → publishNow. El
            // scheduledFor remoto queda para el caso defensivo (clock skew).
            const scheduledInFuture =
                job.scheduledFor !== null &&
                job.scheduledFor.getTime() > now().getTime();
            const result = await resolved.zernio.publishPost({
                profileId: profile.profileId,
                content: job.content,
                platforms: [{ platform: job.platform, accountId: job.accountId }],
                ...(job.mediaUrls.length > 0 ? { mediaUrls: job.mediaUrls } : {}),
                ...(scheduledInFuture
                    ? { scheduledFor: job.scheduledFor!.toISOString() }
                    : { publishNow: true }),
                idempotencyKey: job.idempotencyKey,
            });
            const settled = await settleJobFromPublishResult(job, result, resolved.publishDeps);
            if (settled.outcome !== 'inflight') {
                emitTerminal(settled.job, settled.outcome);
                await resolved.syncSourceStatus(settled.job);
            }
        } catch (err) {
            const httpStatus = err instanceof AppError ? err.statusCode : null;
            const code = err instanceof AppError ? err.code : null;
            const { category, source, retryable } = categorizePublishError(httpStatus, code);
            const retryAt =
                retryable && job.attempts < job.maxAttempts
                    ? new Date(now().getTime() + resolved.backoffMs(job.attempts))
                    : undefined;
            const updated = await store.markFailed(
                job.id,
                {
                    message: errorMessage(err),
                    category,
                    source,
                    zernioPostId: job.zernioPostId,
                },
                retryAt ? { requeueAt: retryAt } : {},
            );
            if (updated?.status === 'failed') {
                emitTerminal(updated, 'failed');
                await resolved.syncSourceStatus(updated);
            }
        }
    }

    return {
        async tick() {
            const job = await store.claimNext(now());
            if (!job) return;
            await dispatch(job);
        },
    };
}

// ---------------------------------------------------------------------------
// Init / stop (un solo worker por proceso)
// ---------------------------------------------------------------------------

let workerInterval: ReturnType<typeof setInterval> | null = null;

function resolvePollMs(): number {
    const raw = Number(process.env.PUBLISH_WORKER_POLL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : POLL_MS;
}

/**
 * Inicializa el worker de publicación (patrón `initJobScheduler` /
 * `initClipRenderWorker`). Guard de una sola instancia: una segunda llamada
 * se ignora con warning — para rearmar con otras deps hay que pasar por
 * `stopPublishWorker` primero.
 */
export function initPublishWorker(io?: Server, deps: PublishWorkerDeps = {}): void {
    if (workerInterval) {
        console.warn('[PublishWorker] Ya inicializado — se ignora la segunda llamada');
        return;
    }
    const worker = createPublishWorker(deps, io);
    const pollMs = resolvePollMs();
    workerInterval = setInterval(() => {
        // Fire-and-forget por tick: NO se espera — el próximo tick claimea
        // aunque este job siga publicándose (el claim atómico evita dobles).
        worker.tick().catch((err) => {
            console.error('[PublishWorker] Error en el tick:', err);
        });
    }, pollMs);
    console.log(`[PublishWorker] Inicializado — claim cada ${pollMs} ms`);
}

export function stopPublishWorker(): void {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
    }
}
