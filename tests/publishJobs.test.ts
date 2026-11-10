/**
 * Tests del slice PG-05: cola de publicación vía Zernio —
 * `publishJobService` (store + enqueue + retry/cancel + error taxonomy) y
 * `publishWorker` (loop de dispatch) sobre `memoryPublishJobStore`, más las
 * rutas `/api/publish-jobs` montadas en una app express efímera con auth
 * mockeado (x-test-tenant).
 *
 * Deterministas: sin DB real (store en memoria con los MISMOS filtros por
 * tenant que el drizzle), sin red (Zernio fake graba las llamadas y devuelve
 * respuestas prefabricadas — el `Idempotency-Key` se inspecciona en el fake),
 * sin timers (`now`/`backoffMs` inyectados y `worker.tick()` se llama a mano)
 * y sin sockets (io fake que registra emits).
 *
 * Casos obligatorios del brief:
 *   (a) aprobar encola un job por red/cuenta.
 *   (b) el worker manda Idempotency-Key de la fila.
 *   (c) mapea Zernio 201/200/207/202 según `post.status`.
 *   (d) 429/503 son reintentables (vuelve a queued con backoff).
 *   (e) 4xx de contenido → `failed` terminal con categoría real.
 *   (f) sin conexiones → approve legacy intacto (en publishApprove.test.ts).
 *   (g) retry manual respeta max_attempts y canTransition.
 *   (h) aislamiento: un tenant no ve los jobs de otro.
 * Extras: claim global del worker, 202 awaiting_funding → in-flight, eventos
 * publish:job:* sólo en outcomes terminales, sync del estado del origen,
 * validación de body/params en rutas y 401 sin auth.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock parcial del módulo DB (importarlo crea un Pool Neon y pediría
// DATABASE_URL): se preserva el resto de exports y se reemplaza `db`.
vi.mock('../src/server/db/index.js', async (io) => ({
    ...(await io()),
    db: {},
}));

// ─── Mock parcial de auth (mismo contrato que autoPublish.test.ts) ──────────
vi.mock('../src/server/middleware/auth.js', async (io) => {
    const actual =
        await io<typeof import('../src/server/middleware/auth.js')>();
    const fakeRequireAuth = (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        const tenant = req.headers['x-test-tenant'];
        if (typeof tenant !== 'string' || tenant.length === 0) {
            res.status(401).json({
                error: 'Token de autenticacion requerido',
            });
            return;
        }
        req.auth = {
            userId: '00000000-0000-4000-8000-000000000011',
            activeTenantId: tenant,
            tenantId: tenant,
            email: 'test@example.com',
            role: 'owner',
        };
        next();
    };
    return { ...actual, requireAuth: fakeRequireAuth };
});

import { AppError } from '../src/server/lib/errors';
import {
    canTransitionPublishJob,
    cancelPublishJob,
    categorizePublishError,
    deriveIdempotencyKey,
    enqueueForApproval,
    enqueuePublishJobs,
    getPublishJob,
    isPublishJobStatus,
    isRetryablePublishError,
    listPublishJobs,
    publishErrorSource,
    retryPublishJob,
    settleJobFromPublishResult,
    type PublishJobDeps,
} from '../src/server/services/publishJobService';
import {
    createPublishWorker,
    initPublishWorker,
    stopPublishWorker,
    type PublishWorkerIo,
} from '../src/server/services/publishWorker';
import { publishJobsRouter, publishJobsRouteDeps } from '../src/server/routes/publishJobs';
import type {
    ZernioPublishInput,
    ZernioPublishResult,
} from '../src/server/services/zernioService';
import type { AutoPublishConfigRow } from '../src/server/services/autoPublishService';
import type { SocialConnectionRow } from '../src/server/services/socialConnectionsService';
import {
    createMemoryPublishJobStore,
    makeMemoryPublishJob,
} from './helpers/memoryPublishJobStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const PUB_ID = '22222222-2222-4222-8222-222222222222';
const ASSET_ID = '44444444-4444-4444-8444-444444444444';
const CONN_IG = '55555555-5555-4555-8555-555555555551';
const CONN_TK = '55555555-5555-4555-8555-555555555552';
const JOB_ID = '66666666-6666-4666-8666-666666666661';
const T0 = new Date('2026-11-10T12:00:00.000Z');

const makeConn = (
    v: Partial<SocialConnectionRow> & {
        tenantId: string;
        platform: string;
        accountId: string;
    },
): SocialConnectionRow => ({
    id: v.id ?? CONN_IG,
    tenantId: v.tenantId,
    platform: v.platform,
    accountId: v.accountId,
    username: v.username ?? 'radio.uno',
    displayName: v.displayName ?? 'Radio Uno',
    status: v.status ?? 'connected',
    zernioProfileId: v.zernioProfileId ?? 'zprof_1',
    lastSyncedAt: v.lastSyncedAt ?? null,
    createdAt: v.createdAt ?? T0,
    updatedAt: v.updatedAt ?? T0,
});

const makeConfig = (
    v: Partial<AutoPublishConfigRow> & { tenantId: string },
): AutoPublishConfigRow => ({
    id: v.id ?? '77777777-7777-4777-8777-777777777777',
    tenantId: v.tenantId,
    programId: v.programId ?? null,
    programKey: v.programKey ?? '__all__',
    mode: v.mode ?? 'on_approval',
    platforms: v.platforms ?? [],
    publishDays: v.publishDays ?? [],
    publishTime: v.publishTime ?? null,
    timezone: v.timezone ?? 'America/Argentina/Buenos_Aires',
    isActive: v.isActive ?? true,
    createdAt: v.createdAt ?? T0,
    updatedAt: v.updatedAt ?? T0,
});

const makeDeps = (
    store: PublishJobDeps['store'],
    extra: Partial<PublishJobDeps> = {},
): PublishJobDeps => ({
    store,
    now: () => T0,
    // PG-06: sin origen de menciones — estos tests ejercitan el circuito
    // PG-05; la composición por red se cubre en publishMentions.test.ts.
    getMentionSource: async () => null,
    listMentionPersons: async () => [],
    ...extra,
});

/** io fake: registra {room, event, payload} de cada emit. */
function makeFakeIo() {
    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    const io: PublishWorkerIo = {
        to: (room) => ({
            emit: (event, payload) => {
                emitted.push({ room, event, payload });
                return true;
            },
        }),
    };
    return { io, emitted };
}

/** Zernio fake: encola respuestas a medida o tira AppError. */
function makeFakeZernio() {
    const calls: ZernioPublishInput[] = [];
    const retryCalls: string[] = [];
    let next: ZernioPublishResult | Error | null = null;
    let retryNext: ZernioPublishResult | Error | null = null;
    return {
        calls,
        retryCalls,
        queue(result: ZernioPublishResult | Error) {
            next = result;
        },
        queueRetry(result: ZernioPublishResult | Error) {
            retryNext = result;
        },
        api: {
            async publishPost(input: ZernioPublishInput): Promise<ZernioPublishResult> {
                calls.push(input);
                if (next instanceof Error) throw next;
                if (next) return next;
                return {
                    httpStatus: 201,
                    idempotentReplay: false,
                    post: {
                        id: 'zpost_1',
                        status: 'published',
                        platforms: [
                            {
                                platform: input.platforms[0]?.platform ?? 'instagram',
                                accountId: input.platforms[0]?.accountId ?? null,
                                status: 'published',
                                platformPostUrl: 'https://ig.test/p/abc',
                                errorMessage: null,
                                errorCategory: null,
                                errorSource: null,
                            },
                        ],
                    },
                };
            },
            async retryPost(postId: string): Promise<ZernioPublishResult> {
                retryCalls.push(postId);
                if (retryNext instanceof Error) throw retryNext;
                if (retryNext) return retryNext;
                return {
                    httpStatus: 200,
                    idempotentReplay: false,
                    post: {
                        id: postId,
                        status: 'published',
                        platforms: [
                            {
                                platform: 'instagram',
                                accountId: 'zacc_1',
                                status: 'published',
                                platformPostUrl: 'https://ig.test/p/abc',
                                errorMessage: null,
                                errorCategory: null,
                                errorSource: null,
                            },
                        ],
                    },
                };
            },
        },
    };
}

const publishedPost = (status = 'published'): ZernioPublishResult => ({
    httpStatus: 201,
    idempotentReplay: false,
    post: {
        id: 'zpost_9',
        status,
        platforms: [
            {
                platform: 'instagram',
                accountId: 'zacc_1',
                status: 'published',
                platformPostUrl: 'https://ig.test/p/xyz',
                errorMessage: null,
                errorCategory: null,
                errorSource: null,
            },
        ],
    },
});

afterEach(() => {
    stopPublishWorker();
    vi.restoreAllMocks();
    for (const key of Object.keys(publishJobsRouteDeps) as Array<
        keyof PublishJobDeps
    >) {
        delete publishJobsRouteDeps[key];
    }
});

// ─── enqueuePublishJobs — un job por destino + dedup idempotente ─────────────

describe('enqueuePublishJobs — un job por cuenta + idempotencia', () => {
    it('crea un job por target con idempotency_key determinista', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const deps = makeDeps(store);
        const result = await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [
                    { platform: 'instagram', accountId: 'zacc_1', connectionId: CONN_IG },
                    { platform: 'tiktok', accountId: 'zacc_2', connectionId: CONN_TK },
                ],
                content: 'Contenido de la nota',
                mediaUrls: ['https://cdn.test/img.png'],
            },
            deps,
        );
        expect(result.createdCount).toBe(2);
        expect(result.deduplicatedCount).toBe(0);
        expect(result.jobs).toHaveLength(2);
        expect(result.jobs[0].status).toBe('queued');
        expect(result.jobs[0].tenantId).toBe(T_A);
        expect(result.jobs[0].publicationId).toBe(PUB_ID);
        expect(result.jobs[0].mediaUrls).toEqual(['https://cdn.test/img.png']);
        // La key es derivada y estable:
        expect(result.jobs[0].idempotencyKey).toBe(
            deriveIdempotencyKey({
                tenantId: T_A,
                publicationId: PUB_ID,
                platform: 'instagram',
                accountId: 'zacc_1',
            }),
        );
        expect(result.jobs[1].idempotencyKey).not.toBe(result.jobs[0].idempotencyKey);
    });

    it('re-encolar el mismo destino no duplica (UNIQUE idempotency_key)', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const deps = makeDeps(store);
        const input = {
            tenantId: T_A,
            publicationId: PUB_ID,
            targets: [{ platform: 'instagram', accountId: 'zacc_1' }],
            content: 'Contenido',
        };
        const first = await enqueuePublishJobs(input, deps);
        const second = await enqueuePublishJobs(input, deps);
        expect(first.createdCount).toBe(1);
        expect(second.createdCount).toBe(0);
        expect(second.deduplicatedCount).toBe(1);
        expect(second.jobs[0].id).toBe(first.jobs[0].id);
        expect(state.jobs).toHaveLength(1);
    });

    it('scheduledFor en el futuro gatea el claim vía next_attempt_at', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const later = new Date(T0.getTime() + 3600_000);
        const result = await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [{ platform: 'instagram', accountId: 'zacc_1' }],
                content: 'Agendado',
                scheduledFor: later,
            },
            makeDeps(store),
        );
        expect(result.jobs[0].scheduledFor?.getTime()).toBe(later.getTime());
        expect(result.jobs[0].nextAttemptAt?.getTime()).toBe(later.getTime());
        expect(state.jobs[0].status).toBe('queued');
    });

    it('rechaza content vacío y targets vacíos', async () => {
        const { store } = createMemoryPublishJobStore();
        const deps = makeDeps(store);
        await expect(
            enqueuePublishJobs(
                { tenantId: T_A, targets: [{ platform: 'instagram', accountId: 'a' }], content: ' ' },
                deps,
            ),
        ).rejects.toMatchObject({ code: 'invalid_content' });
        await expect(
            enqueuePublishJobs({ tenantId: T_A, targets: [], content: 'x' }, deps),
        ).rejects.toMatchObject({ code: 'invalid_targets' });
    });
});

// ─── enqueueForApproval — circuito de approve ────────────────────────────────

describe('enqueueForApproval — un job por red/cuenta del tenant', () => {
    const connections = [
        makeConn({ id: CONN_IG, tenantId: T_A, platform: 'instagram', accountId: 'zacc_1' }),
        makeConn({ id: CONN_TK, tenantId: T_A, platform: 'tiktok', accountId: 'zacc_2' }),
        makeConn({ tenantId: T_A, platform: 'youtube', accountId: 'zacc_3', status: 'disconnected' }),
        makeConn({ tenantId: T_B, platform: 'instagram', accountId: 'zacc_9' }),
    ];

    it('(a) encola un job por cuenta conectada (las disconnected no cuentan)', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_ID, content: 'Nota aprobada' },
            makeDeps(store, {
                listConnections: async () => connections,
                listAutoPublishConfigs: async () => [],
            }),
        );
        expect(result.usedZernio).toBe(true);
        expect(result.jobs).toHaveLength(2);
        expect(new Set(result.jobs.map((j) => j.platform))).toEqual(
            new Set(['instagram', 'tiktok']),
        );
        expect(state.jobs.every((j) => j.tenantId === T_A)).toBe(true);
    });

    it('la config on_approval de PG-03 filtra las plataformas destino', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_ID, content: 'Nota' },
            makeDeps(store, {
                listConnections: async () => connections,
                listAutoPublishConfigs: async () => [
                    makeConfig({ tenantId: T_A, mode: 'on_approval', platforms: ['instagram'] }),
                ],
            }),
        );
        expect(result.usedZernio).toBe(true);
        expect(result.jobs).toHaveLength(1);
        expect(result.jobs[0].platform).toBe('instagram');
    });

    it('config on_approval activa pero sin plataformas conectadas → 0 jobs', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_ID, content: 'Nota' },
            makeDeps(store, {
                listConnections: async () => connections,
                listAutoPublishConfigs: async () => [
                    makeConfig({ tenantId: T_A, mode: 'on_approval', platforms: ['reddit'] }),
                ],
            }),
        );
        expect(result.usedZernio).toBe(true);
        expect(result.jobs).toHaveLength(0);
    });

    it('(f) sin conexiones Zernio → usedZernio=false (la ruta sigue legacy)', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_ID, content: 'Nota' },
            makeDeps(store, {
                listConnections: async () => [],
                listAutoPublishConfigs: async () => [],
            }),
        );
        expect(result.usedZernio).toBe(false);
        expect(result.jobs).toHaveLength(0);
    });
});

// ─── publishWorker — dispatch, Idempotency-Key y mapping de estados ───────────

describe('publishWorker — claim + publishPost + mapping Zernio', () => {
    const queuedJob = (over: Partial<Parameters<typeof makeMemoryPublishJob>[0]> = {}) =>
        makeMemoryPublishJob(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                platform: 'instagram',
                accountId: 'zacc_1',
                connectionId: CONN_IG,
                idempotencyKey: 'pj_test_key_1',
                content: 'Contenido del post',
                mediaUrls: ['https://cdn.test/img.png'],
                ...over,
            },
            () => T0,
        );

    it('(b) publica mandando la Idempotency-Key de la fila y content/media/target', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
        });
        await worker.tick();
        expect(zernio.calls).toHaveLength(1);
        const call = zernio.calls[0];
        expect(call.idempotencyKey).toBe('pj_test_key_1');
        expect(call.profileId).toBe('zprof_1');
        expect(call.content).toBe('Contenido del post');
        expect(call.mediaUrls).toEqual(['https://cdn.test/img.png']);
        expect(call.platforms).toEqual([{ platform: 'instagram', accountId: 'zacc_1' }]);
        expect(call.publishNow).toBe(true);
        expect(state.jobs[0].status).toBe('published');
        expect(state.jobs[0].zernioPostId).toBe('zpost_1');
        expect(state.jobs[0].platformPostUrl).toBe('https://ig.test/p/abc');
        expect(state.jobs[0].publishedAt).not.toBeNull();
        expect(state.jobs[0].attempts).toBe(1);
    });

    it('(c) 200 replay idempotente → publica igual (post.status published)', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue({
            httpStatus: 200,
            idempotentReplay: true,
            post: publishedPost('published').post,
        });
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('published');
        expect(state.jobs[0].zernioPostId).toBe('zpost_9');
    });

    it('(c) 207 / post.status=partial → markPartial con el error de la entry fallida', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue({
            httpStatus: 207,
            idempotentReplay: false,
            post: {
                id: 'zpost_p',
                status: 'partial',
                platforms: [
                    {
                        platform: 'instagram',
                        accountId: 'zacc_1',
                        status: 'published',
                        platformPostUrl: 'https://ig.test/p/ok',
                        errorMessage: null,
                        errorCategory: null,
                        errorSource: null,
                    },
                    {
                        platform: 'instagram',
                        accountId: 'zacc_1',
                        status: 'failed',
                        platformPostUrl: null,
                        errorMessage: 'Media rejected by platform',
                        errorCategory: 'platform_rejected',
                        errorSource: 'platform',
                    },
                ],
            },
        });
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('partial');
        expect(state.jobs[0].zernioPostId).toBe('zpost_p');
        expect(state.jobs[0].lastError).toBe('Media rejected by platform');
        expect(state.jobs[0].lastErrorCategory).toBe('platform_rejected');
        expect(state.jobs[0].lastErrorSource).toBe('platform');
    });

    it('(c) 202 awaiting_funding → queda in-flight (publishing + nota)', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue({
            httpStatus: 202,
            idempotentReplay: false,
            post: { id: 'zpost_af', status: 'scheduled', platforms: [] },
        });
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('publishing');
        expect(state.jobs[0].zernioPostId).toBe('zpost_af');
        expect(state.jobs[0].lastError).toContain('awaiting_funding');
    });

    it('(d) 429 → reintento: vuelve a queued con next_attempt_at = now+backoff', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue(new AppError('rate limit', 429, 'platform_rate_limit'));
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
            backoffMs: (attempts) => attempts * 60_000,
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('queued');
        expect(state.jobs[0].lastErrorCategory).toBe('platform_rate_limit');
        expect(state.jobs[0].nextAttemptAt?.getTime()).toBe(T0.getTime() + 60_000);
    });

    it('(d) 503 → reintentable igual que 429', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue(new AppError('upstream', 503, 'zernio_unavailable'));
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('queued');
        expect(state.jobs[0].lastErrorCategory).toBe('system_error');
    });

    it('(e) 400 de contenido → failed TERMINAL con categoría real', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue(new AppError('content invalid for platform', 400, 'validation_error'));
        const { io, emitted } = makeFakeIo();
        const worker = createPublishWorker(
            {
                store,
                zernio: zernio.api,
                getZernioProfile: async () => ({ profileId: 'zprof_1' }),
                now: () => T0,
            },
            io,
        );
        await worker.tick();
        expect(state.jobs[0].status).toBe('failed');
        expect(state.jobs[0].lastErrorCategory).toBe('user_content');
        expect(state.jobs[0].lastErrorSource).toBe('user');
        // fallo terminal → evento publish:job:failed al room del tenant
        expect(emitted).toHaveLength(1);
        expect(emitted[0].room).toBe(`tenant:${T_A}`);
        expect(emitted[0].event).toBe('publish:job:failed');
    });

    it('(e) post.status=failed ya creado → failed terminal SIN re-encolar (el retry remoto es manual)', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue({
            httpStatus: 201,
            idempotentReplay: false,
            post: {
                id: 'zpost_f',
                status: 'failed',
                platforms: [
                    {
                        platform: 'instagram',
                        accountId: 'zacc_1',
                        status: 'failed',
                        platformPostUrl: null,
                        errorMessage: 'account disabled',
                        errorCategory: 'account_issue',
                        errorSource: 'user',
                    },
                ],
            },
        });
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('failed');
        expect(state.jobs[0].zernioPostId).toBe('zpost_f');
        expect(state.jobs[0].lastErrorCategory).toBe('account_issue');
    });

    it('(g) agotar max_attempts en error reintentable → failed terminal', async () => {
        const job = queuedJob({ attempts: 2, maxAttempts: 2 });
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue(new AppError('rate limit', 429, 'platform_rate_limit'));
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
        });
        await worker.tick();
        // El claim lo puso en attempts=3 > max=2? No: claim hace +1 → 3; el
        // store markFailed mira attempts>=max → terminal.
        expect(state.jobs[0].status).toBe('failed');
        expect(state.jobs[0].lastErrorCategory).toBe('platform_rate_limit');
    });

    it('sin perfil Zernio → failed terminal account_issue sin llamar a la API', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => null,
            now: () => T0,
        });
        await worker.tick();
        expect(zernio.calls).toHaveLength(0);
        expect(state.jobs[0].status).toBe('failed');
        expect(state.jobs[0].lastErrorCategory).toBe('account_issue');
    });

    it('el claim es global pero respeta next_attempt_at futuro', async () => {
        const future = new Date(T0.getTime() + 3600_000);
        const jobA = queuedJob({ id: 'job-a', tenantId: T_A, nextAttemptAt: future });
        const jobB = queuedJob({ id: 'job-b', tenantId: T_B });
        const { store, state } = createMemoryPublishJobStore({ jobs: [jobA, jobB], now: () => T0 });
        const zernio = makeFakeZernio();
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_x' }),
            now: () => T0,
        });
        await worker.tick();
        // El job de T_B (sin espera) se despacha aunque el de T_A esté agendado.
        expect(state.jobs.find(j => j.id === 'job-b')!.status).toBe('published');
        expect(state.jobs.find(j => j.id === 'job-a')!.status).toBe('queued');
    });

    it('syncSourceStatus: todos published → el origen legacy pasa a published', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        const marked: Array<{ tenantId: string; publicationId: string }> = [];
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
            publishDeps: {
                markPublicationPublished: async (tenantId, publicationId) => {
                    marked.push({ tenantId, publicationId });
                },
            },
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('published');
        expect(marked).toEqual([{ tenantId: T_A, publicationId: PUB_ID }]);
    });

    it('syncSourceStatus: job partial → el origen NO se toca (queda approved)', async () => {
        const job = queuedJob();
        const { store, state } = createMemoryPublishJobStore({ jobs: [job], now: () => T0 });
        const zernio = makeFakeZernio();
        zernio.queue({
            httpStatus: 207,
            idempotentReplay: false,
            post: { id: 'zpost_p', status: 'partial', platforms: [] },
        });
        const marked: unknown[] = [];
        const worker = createPublishWorker({
            store,
            zernio: zernio.api,
            getZernioProfile: async () => ({ profileId: 'zprof_1' }),
            now: () => T0,
            publishDeps: {
                markPublicationPublished: async () => {
                    marked.push(1);
                },
            },
        });
        await worker.tick();
        expect(state.jobs[0].status).toBe('partial');
        expect(marked).toHaveLength(0);
    });
});

// ─── retryPublishJob + cancelPublishJob ──────────────────────────────────────

describe('retry/cancel — transiciones del job', () => {
    it('(g) retry de un failed SIN zernio_post_id → vuelve a queued', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'zacc_1',
                    idempotencyKey: 'k1',
                    content: 'c',
                    status: 'failed',
                    attempts: 1,
                },
                () => T0,
            ),
        );
        const job = await retryPublishJob(T_A, state.jobs[0].id, makeDeps(store));
        expect(state.jobs[0].status).toBe('queued');
        expect(state.jobs[0].nextAttemptAt?.getTime()).toBe(T0.getTime());
    });

    it('(g) retry con zernio_post_id → POST /posts/{id}/retry y consume un intento', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'zacc_1',
                    idempotencyKey: 'k2',
                    content: 'c',
                    status: 'partial',
                    attempts: 1,
                    zernioPostId: 'zpost_7',
                },
                () => T0,
            ),
        );
        const zernio = makeFakeZernio();
        const job = await retryPublishJob(
            T_A,
            state.jobs[0].id,
            makeDeps(store, { zernio: zernio.api }),
        );
        expect(zernio.retryCalls).toEqual(['zpost_7']);
        expect(state.jobs[0].status).toBe('published');
        expect(state.jobs[0].attempts).toBe(2);
        // partial → published por el retry remoto (transición válida).
        expect(canTransitionPublishJob('partial', 'published')).toBe(true);
    });

    it('(g) retry respeta max_attempts → 409 max_attempts_reached', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'zacc_1',
                    idempotencyKey: 'k3',
                    content: 'c',
                    status: 'failed',
                    attempts: 3,
                    maxAttempts: 3,
                },
                () => T0,
            ),
        );
        await expect(
            retryPublishJob(T_A, state.jobs[0].id, makeDeps(store)),
        ).rejects.toMatchObject({ statusCode: 409, code: 'max_attempts_reached' });
    });

    it('(g) retry desde estado inválido → 409 invalid_transition; canTransition lo respeta', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'zacc_1',
                    idempotencyKey: 'k4',
                    content: 'c',
                    status: 'published',
                },
                () => T0,
            ),
        );
        await expect(
            retryPublishJob(T_A, state.jobs[0].id, makeDeps(store)),
        ).rejects.toMatchObject({ statusCode: 409, code: 'invalid_transition' });
        // La máquina documentada:
        expect(canTransitionPublishJob('queued', 'publishing')).toBe(true);
        expect(canTransitionPublishJob('publishing', 'published')).toBe(true);
        expect(canTransitionPublishJob('publishing', 'partial')).toBe(true);
        expect(canTransitionPublishJob('publishing', 'failed')).toBe(true);
        expect(canTransitionPublishJob('failed', 'queued')).toBe(true);
        expect(canTransitionPublishJob('partial', 'queued')).toBe(true);
        expect(canTransitionPublishJob('published', 'cancelled')).toBe(true);
        expect(canTransitionPublishJob('published', 'queued')).toBe(false);
        expect(canTransitionPublishJob('cancelled', 'queued')).toBe(false);
    });

    it('retry de un job ajeno → 404 (aislamiento)', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'zacc_1',
                    idempotencyKey: 'k5',
                    content: 'c',
                    status: 'failed',
                },
                () => T0,
            ),
        );
        await expect(
            retryPublishJob(T_B, state.jobs[0].id, makeDeps(store)),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('cancel desde queued/publishing → cancelled; desde terminal → 409', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'zacc_1',
                    idempotencyKey: 'k6',
                    content: 'c',
                    status: 'queued',
                },
                () => T0,
            ),
        );
        const cancelled = await cancelPublishJob(T_A, state.jobs[0].id, makeDeps(store));
        expect(cancelled.status).toBe('cancelled');

        state.jobs[0].status = 'published';
        await expect(
            cancelPublishJob(T_A, state.jobs[0].id, makeDeps(store)),
        ).rejects.toMatchObject({ statusCode: 409, code: 'invalid_transition' });
    });
});

// ─── taxonomy de errores ────────────────────────────────────────────────────

describe('categorizePublishError — taxonomía observable', () => {
    it('mapea HTTP + code a categoría/source/retryable', () => {
        expect(categorizePublishError(400, 'validation')).toMatchObject({
            category: 'user_content',
            source: 'user',
            retryable: false,
        });
        expect(categorizePublishError(401, 'unauthorized')).toMatchObject({
            category: 'auth_expired',
            retryable: false,
        });
        expect(categorizePublishError(403, 'platform_account_limit')).toMatchObject({
            category: 'account_issue',
            retryable: false,
        });
        expect(categorizePublishError(403, 'account_disconnected')).toMatchObject({
            category: 'auth_expired',
            retryable: false,
        });
        expect(categorizePublishError(409, 'duplicate_content')).toMatchObject({
            category: 'user_content',
            retryable: false,
        });
        expect(categorizePublishError(409, 'idempotency_conflict')).toMatchObject({
            category: 'platform_error',
            retryable: true,
        });
        expect(categorizePublishError(429, 'rate_limit')).toMatchObject({
            category: 'platform_rate_limit',
            source: 'platform',
            retryable: true,
        });
        expect(categorizePublishError(503, 'upstream')).toMatchObject({
            category: 'system_error',
            retryable: true,
        });
        expect(categorizePublishError(null, 'zernio_unavailable')).toMatchObject({
            category: 'unknown',
            retryable: false,
        });
        expect(publishErrorSource('quota_exhausted')).toBe('user');
        expect(isRetryablePublishError('platform_error')).toBe(true);
        expect(isRetryablePublishError('user_content')).toBe(false);
        expect(isPublishJobStatus('queued')).toBe(true);
        expect(isPublishJobStatus('bogus')).toBe(false);
    });
});

// ─── settleJobFromPublishResult (unidad compartida worker/retry) ─────────────

describe('settleJobFromPublishResult — mapping post.status → job', () => {
    const baseJob = () =>
        makeMemoryPublishJob(
            {
                id: JOB_ID,
                tenantId: T_A,
                platform: 'instagram',
                accountId: 'zacc_1',
                idempotencyKey: 'k',
                content: 'c',
                status: 'publishing',
                attempts: 1,
            },
            () => T0,
        );

    it('2xx sin post → failed system_error (respuesta anómala)', async () => {
        const { store } = createMemoryPublishJobStore({ jobs: [baseJob()], now: () => T0 });
        const settled = await settleJobFromPublishResult(
            baseJob(),
            { httpStatus: 200, idempotentReplay: false, post: null },
            makeDeps(store),
        );
        expect(settled.outcome).toBe('failed');
        expect(settled.job.status).toBe('failed');
    });

    it('post.status scheduled → in-flight (publishing + nota)', async () => {
        const { store } = createMemoryPublishJobStore({ jobs: [baseJob()], now: () => T0 });
        const settled = await settleJobFromPublishResult(
            baseJob(),
            { httpStatus: 201, idempotentReplay: false, post: { id: 'z1', status: 'scheduled', platforms: [] } },
            makeDeps(store),
        );
        expect(settled.outcome).toBe('inflight');
        expect(settled.job.status).toBe('publishing');
        expect(settled.job.zernioPostId).toBe('z1');
    });
});

// ─── Rutas /api/publish-jobs — express efímera + auth mockeado ───────────────

describe('rutas /api/publish-jobs', () => {
    let server: Server | null = null;
    let baseUrl = '';

    const startApp = async () => {
        // PG-06: las rutas encolan sin origen de menciones — el enqueue va
        // por los deps inyectados; la composición se prueba aparte.
        publishJobsRouteDeps.getMentionSource = async () => null;
        publishJobsRouteDeps.listMentionPersons = async () => [];
        const app = express();
        app.use(express.json());
        app.use('/api/publish-jobs', publishJobsRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    };

    const api = (path: string, init?: RequestInit, tenant = T_A) =>
        fetch(`${baseUrl}${path}`, {
            ...init,
            headers: {
                'content-type': 'application/json',
                'x-test-tenant': tenant,
                ...(init?.headers ?? {}),
            },
        });

    afterEach(async () => {
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    it('(h) lista tenant-scoped: T_B no ve los jobs de T_A; filtro status + paginación', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        publishJobsRouteDeps.store = store;
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [
                    { platform: 'instagram', accountId: 'z1' },
                    { platform: 'tiktok', accountId: 'z2' },
                ],
                content: 'Post A',
            },
            makeDeps(store),
        );
        await startApp();

        const resA = await api('/api/publish-jobs?status=queued&limit=1');
        expect(resA.status).toBe(200);
        const bodyA = (await resA.json()) as { jobs: unknown[]; total: number };
        expect(bodyA.total).toBe(2);
        expect(bodyA.jobs).toHaveLength(1);

        const resB = await api('/api/publish-jobs', undefined, T_B);
        const bodyB = (await resB.json()) as { jobs: unknown[]; total: number };
        expect(bodyB.total).toBe(0);
        expect(bodyB.jobs).toHaveLength(0);
    });

    it('GET /:id ajeno → 404; propio → 200 con el detalle', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        publishJobsRouteDeps.store = store;
        const { jobs } = await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [{ platform: 'instagram', accountId: 'z1' }],
                content: 'Post A',
            },
            makeDeps(store),
        );
        await startApp();

        const res = await api(`/api/publish-jobs/${jobs[0].id}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { job: { id: string } };
        expect(body.job.id).toBe(jobs[0].id);

        const foreign = await api(`/api/publish-jobs/${jobs[0].id}`, undefined, T_B);
        expect(foreign.status).toBe(404);
        const badId = await api('/api/publish-jobs/no-es-uuid');
        expect(badId.status).toBe(400);
    });

    it('POST / encola un job por target → 202', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        publishJobsRouteDeps.store = store;
        await startApp();

        const res = await api('/api/publish-jobs', {
            method: 'POST',
            body: JSON.stringify({
                publicationId: PUB_ID,
                targets: [
                    { platform: 'instagram', accountId: 'z1' },
                    { platform: 'tiktok', accountId: 'z2' },
                ],
                content: 'Post manual',
                mediaUrls: ['https://cdn.test/m.png'],
            }),
        });
        expect(res.status).toBe(202);
        const body = (await res.json()) as {
            jobs: Array<{ status: string; platform: string }>;
            createdCount: number;
        };
        expect(res.status).toBe(202);
        expect(body.createdCount).toBe(2);
        expect(body.jobs.every((j) => j.status === 'queued')).toBe(true);
    });

    it('POST / valida body: content obligatorio, targets válidos, scheduledFor ISO', async () => {
        const { store } = createMemoryPublishJobStore();
        publishJobsRouteDeps.store = store;
        await startApp();

        const noContent = await api('/api/publish-jobs', {
            method: 'POST',
            body: JSON.stringify({ targets: [{ platform: 'ig', accountId: 'a' }] }),
        });
        expect(noContent.status).toBe(400);

        const badTarget = await api('/api/publish-jobs', {
            method: 'POST',
            body: JSON.stringify({
                content: 'x',
                targets: [{ platform: 'ig' }],
            }),
        });
        expect(badTarget.status).toBe(400);

        const badSchedule = await api('/api/publish-jobs', {
            method: 'POST',
            body: JSON.stringify({
                content: 'x',
                targets: [{ platform: 'ig', accountId: 'a' }],
                scheduledFor: 'ayer a la tarde',
            }),
        });
        expect(badSchedule.status).toBe(400);
    });

    it('POST /:id/retry → 200 re-encolado; estado inválido → 409', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        publishJobsRouteDeps.store = store;
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    id: JOB_ID,
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'z1',
                    idempotencyKey: 'kr1',
                    content: 'c',
                    status: 'failed',
                    attempts: 1,
                },
                () => T0,
            ),
        );
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    id: '77777777-7777-4777-8777-777777777777',
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'z2',
                    idempotencyKey: 'kr2',
                    content: 'c',
                    status: 'published',
                },
                () => T0,
            ),
        );
        await startApp();

        const ok = await api(`/api/publish-jobs/${JOB_ID}/retry`, { method: 'POST' });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { job: { status: string } };
        expect(body.job.status).toBe('queued');

        const invalid = await api(
            '/api/publish-jobs/77777777-7777-4777-8777-777777777777/retry',
            { method: 'POST' },
        );
        expect(invalid.status).toBe(409);

        const foreign = await api(
            `/api/publish-jobs/${JOB_ID}/retry`,
            { method: 'POST' },
            T_B,
        );
        expect(foreign.status).toBe(404);
    });

    it('POST /:id/cancel → 200 cancelled; ya publicado → 409', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        publishJobsRouteDeps.store = store;
        state.jobs.push(
            makeMemoryPublishJob(
                {
                    id: JOB_ID,
                    tenantId: T_A,
                    platform: 'instagram',
                    accountId: 'z1',
                    idempotencyKey: 'kc1',
                    content: 'c',
                    status: 'queued',
                },
                () => T0,
            ),
        );
        await startApp();

        const ok = await api(`/api/publish-jobs/${JOB_ID}/cancel`, { method: 'POST' });
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { job: { status: string } };
        expect(body.job.status).toBe('cancelled');

        const again = await api(`/api/publish-jobs/${JOB_ID}/cancel`, { method: 'POST' });
        expect(again.status).toBe(409);
    });

    it('401 sin auth', async () => {
        publishJobsRouteDeps.store = createMemoryPublishJobStore().store;
        await startApp();
        const res = await fetch(`${baseUrl}/api/publish-jobs`);
        expect(res.status).toBe(401);
    });
});

// ─── init/stop del worker (guard de una sola instancia) ──────────────────────

describe('initPublishWorker — guard de una sola instancia', () => {
    it('una segunda init se ignora con warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        initPublishWorker(undefined, {
            store: createMemoryPublishJobStore().store,
            zernio: makeFakeZernio().api,
            getZernioProfile: async () => null,
        });
        initPublishWorker(undefined, {});
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('Ya inicializado'),
        );
    });
});
