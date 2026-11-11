/**
 * Tests del slice PI-01: cola genérica `job_queue` —
 * `jobQueueService` (store + ciclo de vida + backoff), `jobQueueWorker`
 * (claim tenant-scoped + dispatch por kind) y las rutas
 * `/api/job-queue` (tenant) + `/api/admin/jobs` (platform admin)
 * montadas en apps express efímeras.
 *
 * Deterministas: sin DB real (store en memoria con los MISMOS filtros por
 * tenant que el drizzle), sin red, sin timers (`now`/`backoffMs`
 * inyectados, `worker.tick()` se llama a mano, `listTenantIds` fake) y sin
 * sockets (io fake que registra emits).
 *
 * Casos obligatorios del brief:
 *   1) enqueue → pending/attempts=0/run_at=now.
 *   2) claimNext respeta el gate run_at (futuro no se claimea).
 *   3) claimNext incrementa attempts → running + started_at.
 *   4) claimNext es tenant-scoped (job de A no lo claimea B).
 *   5) markFailed attempts<max → pending + run_at=backoff + last_error.
 *   6) markFailed attempts>=max → dead + dead_lettered_at + last_error.
 *   7) retry dead → pending/attempts=0/run_at=now/errores null;
 *      desde pending → null.
 *   8) cancel pending → cancelled; desde succeeded → null.
 *   9) backoffMs 60s/120s/240s… tope 3.6M ms.
 *  10) aislamiento tenant en listByTenant/getById/retry/cancel.
 *  11) rutas tenant: GET / {jobs,total}; GET /:id ajeno → 404;
 *      POST / → 202; retry → 200; cancel → 200; uuid inválido → 400;
 *      sin auth → 401.
 *  12) rutas admin: sin platform-admin → 401/403; con admin lista
 *      cross-tenant; retry de dead → 200; mutación auditada.
 *  13) worker tick: handler que tira → pending con backoff; agotado →
 *      dead; handler que resuelve → succeeded.
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

// ─── Mock parcial de auth (mismo contrato que publishJobs.test.ts) ──────────
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

// ─── Mock de authz: requirePlatformAdmin via header x-test-platform-admin ───
// En el grafo de imports de estos tests sólo admin.ts consume authz.
vi.mock('../src/server/middleware/authz.js', () => ({
    requirePlatformAdmin: (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        if (req.headers['x-test-platform-admin'] === '1') {
            next();
            return;
        }
        res.status(403).json({
            error: 'Requiere ser administrador de plataforma',
            code: 'NOT_PLATFORM_ADMIN',
        });
    },
}));

// ─── Mock parcial de audit: espiamos auditFromRequest/recordAuditEvent ──────
vi.mock('../src/server/services/auditService.js', async (io) => {
    const actual =
        await io<typeof import('../src/server/services/auditService.js')>();
    return {
        ...actual,
        recordAuditEvent: vi.fn(async () => {}),
        auditFromRequest: vi.fn(async () => {}),
    };
});

import {
    backoffMs,
    createJobQueueService,
    JOB_QUEUE_STATUSES,
} from '../src/server/services/jobQueueService';
import {
    createJobQueueWorker,
    createRetentionPurgeHandler,
    stopJobQueueWorker,
    type JobQueueWorkerIo,
} from '../src/server/services/jobQueueWorker';
import {
    jobQueueRouter,
    jobQueueRouteDeps,
} from '../src/server/routes/jobQueue';
import { adminRouter, adminJobsRouteDeps } from '../src/server/routes/admin';
import { auditFromRequest } from '../src/server/services/auditService';
import {
    createMemoryJobQueueStore,
    makeMemoryJob,
} from './helpers/memoryJobQueueStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const T0 = new Date('2026-11-11T12:00:00.000Z');

afterEach(() => {
    stopJobQueueWorker();
    vi.restoreAllMocks();
    delete jobQueueRouteDeps.store;
    delete adminJobsRouteDeps.jobQueueStore;
});

// ─── 1-10: ciclo de vida del store (mismo WHERE que el drizzle) ─────────────

describe('jobQueue store — ciclo de vida tenant-scoped', () => {
    it('(1) enqueue → status pending, attempts=0, run_at=now', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const job = await store.enqueue({
            tenantId: T_A,
            kind: 'retention.purge',
            payload: { foo: 1 },
        });
        expect(job.status).toBe('pending');
        expect(job.attempts).toBe(0);
        expect(job.maxAttempts).toBe(5);
        expect(job.runAt).toEqual(T0);
        expect(job.tenantId).toBe(T_A);
        expect(job.payload).toEqual({ foo: 1 });
    });

    it('(2) claimNext respeta el gate run_at: un job futuro no se claimea', async () => {
        const { store, state } = createMemoryJobQueueStore({ now: () => T0 });
        const job = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        job.runAt = new Date(T0.getTime() + 3_600_000);
        expect(await store.claimNext(T_A, T0)).toBeNull();
        // Al llegar run_at sí se claimea.
        expect((await store.claimNext(T_A, job.runAt))?.id).toBe(job.id);
        expect(state.jobs[0].status).toBe('running');
    });

    it('(3) claimNext incrementa attempts y deja running + started_at', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const job = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const claimed = await store.claimNext(T_A, T0);
        expect(claimed?.id).toBe(job.id);
        expect(claimed?.status).toBe('running');
        expect(claimed?.attempts).toBe(1);
        expect(claimed?.startedAt).toEqual(T0);
    });

    it('(4) claimNext es tenant-scoped: B no claimea el job de A', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        expect(await store.claimNext(T_B, T0)).toBeNull();
        const claimedA = await store.claimNext(T_A, T0);
        expect(claimedA?.tenantId).toBe(T_A);
    });

    it('(5) markFailed con attempts < max_attempts → pending + run_at=backoff + last_error', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const job = await store.enqueue({
            tenantId: T_A,
            kind: 'retention.purge',
            maxAttempts: 3,
        });
        await store.claimNext(T_A, T0); // attempts=1
        const retryAt = new Date(T0.getTime() + backoffMs(1));
        const updated = await store.markFailed(job.id, T_A, 'boom', {
            retryAt,
            category: 'handler_error',
        });
        expect(updated?.status).toBe('pending');
        expect(updated?.runAt).toEqual(retryAt);
        expect(updated?.lastError).toBe('boom');
        expect(updated?.errorCategory).toBe('handler_error');
        expect(updated?.deadLetteredAt).toBeNull();
    });

    it('(6) markFailed con attempts >= max_attempts → dead + dead_lettered_at + last_error', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const job = await store.enqueue({
            tenantId: T_A,
            kind: 'retention.purge',
            maxAttempts: 1,
        });
        await store.claimNext(T_A, T0); // attempts=1 = max
        const updated = await store.markFailed(job.id, T_A, 'boom');
        expect(updated?.status).toBe('dead');
        expect(updated?.deadLetteredAt).toEqual(T0);
        expect(updated?.lastError).toBe('boom');
        expect(updated?.finishedAt).toEqual(T0);
    });

    it('(7) retry desde dead → pending/attempts=0/run_at=now/errores null; desde pending → null', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const dead = await store.enqueue({
            tenantId: T_A,
            kind: 'retention.purge',
            maxAttempts: 1,
        });
        await store.claimNext(T_A, T0);
        await store.markFailed(dead.id, T_A, 'boom');
        const retried = await store.retry(dead.id, T_A);
        expect(retried?.status).toBe('pending');
        expect(retried?.attempts).toBe(0);
        expect(retried?.runAt).toEqual(T0);
        expect(retried?.lastError).toBeNull();
        expect(retried?.deadLetteredAt).toBeNull();

        const pending = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        expect(await store.retry(pending.id, T_A)).toBeNull();
    });

    it('(8) cancel desde pending → cancelled; desde succeeded → null', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const pending = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const cancelled = await store.cancel(pending.id, T_A);
        expect(cancelled?.status).toBe('cancelled');
        expect(cancelled?.finishedAt).toEqual(T0);

        const done = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await store.claimNext(T_A, T0);
        await store.markSucceeded(done.id, T_A);
        expect(await store.cancel(done.id, T_A)).toBeNull();
    });

    it('(9) backoffMs: 60s, 2m, 4m, 8m… con tope de 1h', () => {
        expect(backoffMs(1)).toBe(60_000);
        expect(backoffMs(2)).toBe(120_000);
        expect(backoffMs(3)).toBe(240_000);
        expect(backoffMs(4)).toBe(480_000);
        expect(backoffMs(5)).toBe(960_000);
        expect(backoffMs(6)).toBe(1_920_000);
        expect(backoffMs(7)).toBe(3_600_000);
        expect(backoffMs(10)).toBe(3_600_000); // tope
        expect(backoffMs(0)).toBe(60_000); // guard defensivo
    });

    it('(10) aislamiento tenant: listByTenant/getById/retry/cancel con id ajeno → null/vacío', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const foreign = await store.enqueue({ tenantId: T_B, kind: 'retention.purge' });
        foreign.status = 'dead';
        foreign.deadLetteredAt = T0;

        expect(await store.getById(foreign.id, T_A)).toBeNull();
        expect(await store.retry(foreign.id, T_A)).toBeNull();
        expect(await store.cancel(foreign.id, T_A)).toBeNull();
        const { jobs, total } = await store.listByTenant(T_A, {
            limit: 50,
            offset: 0,
        });
        expect(total).toBe(0);
        expect(jobs).toHaveLength(0);
        // El propio tenant sí lo ve.
        expect(await store.getById(foreign.id, T_B)).not.toBeNull();
        // Un job de T_A tampoco puede ser operado por T_B.
        const own = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        expect(await store.cancel(own.id, T_B)).toBeNull();
    });

    it('countByStatus devuelve el record completo con ceros (tenant + kind)', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const dead = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        dead.status = 'dead';
        await store.enqueue({ tenantId: T_B, kind: 'retention.purge' });
        const counts = await store.countByStatus({ tenantId: T_A });
        expect(counts.pending).toBe(1);
        expect(counts.dead).toBe(1);
        expect(counts.running).toBe(0);
        expect(counts.succeeded).toBe(0);
        expect(Object.keys(counts).sort()).toEqual(
            [...JOB_QUEUE_STATUSES].sort(),
        );
        // Sin tenantId → global (excepción documentada, admin).
        const global = await store.countByStatus();
        expect(global.pending).toBe(2);
    });
});

// ─── 13: worker — claim por tenant + dispatch + backoff + dead ───────────────

describe('jobQueueWorker — tick por tenant', () => {
    const makeFakeIo = () => {
        const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
        const io: JobQueueWorkerIo = {
            to: (room) => ({
                emit: (event, payload) => {
                    emitted.push({ room, event, payload });
                    return true;
                },
            }),
        };
        return { io, emitted };
    };

    it('(13) handler que tira → pending con backoff; agotado → dead; resuelve → succeeded', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const { io, emitted } = makeFakeIo();
        const failing = new Map([
            [
                'retention.purge',
                async () => {
                    throw new Error('purge explotó');
                },
            ],
        ]);
        const worker = createJobQueueWorker(
            {
                store,
                listTenantIds: async () => [T_A],
                handlers: failing,
                now: () => T0,
            },
            io,
        );

        const job = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await worker.tick();
        let current = (await store.getById(job.id, T_A))!;
        expect(current.status).toBe('pending');
        expect(current.attempts).toBe(1);
        expect(current.lastError).toBe('purge explotó');
        expect(current.runAt).toEqual(new Date(T0.getTime() + backoffMs(1)));

        // El gate run_at sigue vigente: en el mismo T0 no hay segundo intento.
        await worker.tick();
        current = (await store.getById(job.id, T_A))!;
        expect(current.attempts).toBe(1);

        // Agotar los intentos: backoffMs inyectado en 0 para reclaimear en T0.
        const fastWorker = createJobQueueWorker(
            {
                store,
                listTenantIds: async () => [T_A],
                handlers: failing,
                now: () => T0,
                backoffMs: () => 0,
            },
            io,
        );
        for (let i = 0; i < 5; i++) {
            current.runAt = T0; // simular que ya venció el backoff
            await fastWorker.tick();
        }
        current = (await store.getById(job.id, T_A))!;
        expect(current.status).toBe('dead');
        expect(current.attempts).toBe(current.maxAttempts);
        expect(current.deadLetteredAt).toEqual(T0);
        const deadEmit = emitted.find((e) => e.event === 'job:queue:dead');
        expect(deadEmit?.room).toBe(`tenant:${T_A}`);

        // Handler que resuelve → succeeded + evento.
        const okWorker = createJobQueueWorker(
            {
                store,
                listTenantIds: async () => [T_A],
                handlers: new Map([['retention.purge', async () => ({})]]),
                now: () => T0,
            },
            io,
        );
        const ok = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await okWorker.tick();
        const done = await store.getById(ok.id, T_A);
        expect(done?.status).toBe('succeeded');
        expect(done?.finishedAt).toEqual(T0);
        expect(emitted.some((e) => e.event === 'job:queue:succeeded')).toBe(true);
    });

    it('un tick claimea UN job por tenant (aislamiento justo entre tenants)', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const jobB = await store.enqueue({ tenantId: T_B, kind: 'retention.purge' });
        const calls: string[] = [];
        const worker = createJobQueueWorker({
            store,
            listTenantIds: async () => [T_A, T_B],
            handlers: new Map([
                [
                    'retention.purge',
                    async (job) => {
                        calls.push(job.tenantId);
                    },
                ],
            ]),
            now: () => T0,
        });
        await worker.tick();
        expect(calls.sort()).toEqual([T_A, T_B]);
        expect((await store.getById(jobB.id, T_B))?.status).toBe('succeeded');
    });

    it('kind sin handler → failed terminal sin gastar reintentos', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        const job = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const worker = createJobQueueWorker({
            store,
            listTenantIds: async () => [T_A],
            handlers: new Map(), // sin handlers registrados
            now: () => T0,
        });
        await worker.tick();
        const updated = await store.getById(job.id, T_A);
        expect(updated?.status).toBe('failed');
        expect(updated?.lastError).toContain('unknown job kind');
        expect(updated?.finishedAt).toEqual(T0);
    });

    it('el seed retention.purge llama purgeExpiredRecordings con tenantId + dryRun:false', async () => {
        const purgeCalls: Array<{ tenantId: string; dryRun: boolean }> = [];
        const handler = createRetentionPurgeHandler(async (_now, opts) => {
            purgeCalls.push({ tenantId: opts.tenantId ?? '', dryRun: opts.dryRun ?? true });
            return { scanned: 0, purged: 0, skipped: 0, bytesFreed: 0, errors: [] };
        });
        const job = makeMemoryJob({ tenantId: T_A, kind: 'retention.purge' }, () => T0);
        await handler(job);
        expect(purgeCalls).toEqual([{ tenantId: T_A, dryRun: false }]);
    });
});

// ─── 11: rutas tenant /api/job-queue ─────────────────────────────────────────

describe('rutas /api/job-queue (tenant)', () => {
    let server: Server | null = null;
    let baseUrl = '';

    const startApp = async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/job-queue', jobQueueRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    };

    const api = (path: string, init?: RequestInit, tenant: string | null = T_A) =>
        fetch(`${baseUrl}${path}`, {
            ...init,
            headers: {
                'content-type': 'application/json',
                ...(tenant ? { 'x-test-tenant': tenant } : {}),
                ...(init?.headers ?? {}),
            },
        });

    afterEach(async () => {
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    it('(11) GET / devuelve { jobs, total } tenant-scoped con filtros', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        jobQueueRouteDeps.store = store;
        await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await store.enqueue({ tenantId: T_B, kind: 'retention.purge' });
        await startApp();

        const res = await api('/api/job-queue?limit=1');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { jobs: unknown[]; total: number };
        expect(body.total).toBe(2); // el de T_B no cuenta
        expect(body.jobs).toHaveLength(1);

        const resB = await api('/api/job-queue', undefined, T_B);
        const bodyB = (await resB.json()) as { jobs: unknown[]; total: number };
        expect(bodyB.total).toBe(1);

        const badStatus = await api('/api/job-queue?status=whatever');
        expect(badStatus.status).toBe(400);
        const badKind = await api('/api/job-queue?kind=nope');
        expect(badKind.status).toBe(400);
    });

    it('(11) GET /:id de otro tenant → 404; propio → 200; uuid inválido → 400', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        jobQueueRouteDeps.store = store;
        const job = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await startApp();

        const own = await api(`/api/job-queue/${job.id}`);
        expect(own.status).toBe(200);
        const body = (await own.json()) as { job: { id: string } };
        expect(body.job.id).toBe(job.id);

        const foreign = await api(`/api/job-queue/${job.id}`, undefined, T_B);
        expect(foreign.status).toBe(404);
        const foreignBody = (await foreign.json()) as { code?: string };
        expect(foreignBody.code).toBe('job_not_found');

        const badId = await api('/api/job-queue/no-es-uuid');
        expect(badId.status).toBe(400);
    });

    it('(11) POST / encola → 202; kind inválido → 400 invalid_kind', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        jobQueueRouteDeps.store = store;
        await startApp();

        const res = await api('/api/job-queue', {
            method: 'POST',
            body: JSON.stringify({
                kind: 'retention.purge',
                payload: { reason: 'manual' },
                maxAttempts: 2,
            }),
        });
        expect(res.status).toBe(202);
        const body = (await res.json()) as {
            job: { status: string; tenantId: string; maxAttempts: number };
        };
        expect(body.job.status).toBe('pending');
        expect(body.job.tenantId).toBe(T_A);
        expect(body.job.maxAttempts).toBe(2);

        const bad = await api('/api/job-queue', {
            method: 'POST',
            body: JSON.stringify({ kind: 'kind.inexistente' }),
        });
        expect(bad.status).toBe(400);
        const badBody = (await bad.json()) as { code?: string };
        expect(badBody.code).toBe('invalid_kind');
    });

    it('(11) POST /:id/retry → 200 desde dead; pending → 409; ajeno → 404', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        jobQueueRouteDeps.store = store;
        const dead = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        dead.status = 'dead';
        dead.deadLetteredAt = T0;
        const pending = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const foreign = await store.enqueue({ tenantId: T_B, kind: 'retention.purge' });
        foreign.status = 'dead';
        await startApp();

        const res = await api(`/api/job-queue/${dead.id}/retry`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { job: { status: string; attempts: number } };
        expect(body.job.status).toBe('pending');
        expect(body.job.attempts).toBe(0);

        const conflict = await api(`/api/job-queue/${pending.id}/retry`, { method: 'POST' });
        expect(conflict.status).toBe(409);
        const conflictBody = (await conflict.json()) as { code?: string };
        expect(conflictBody.code).toBe('invalid_transition');

        const foreignRes = await api(`/api/job-queue/${foreign.id}/retry`, { method: 'POST' });
        expect(foreignRes.status).toBe(404);
    });

    it('(11) POST /:id/cancel → 200 desde pending; sin auth → 401', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        jobQueueRouteDeps.store = store;
        const pending = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const done = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        await store.claimNext(T_A, T0);
        await store.markSucceeded(done.id, T_A);
        await startApp();

        const res = await api(`/api/job-queue/${pending.id}/cancel`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { job: { status: string } };
        expect(body.job.status).toBe('cancelled');

        const conflict = await api(`/api/job-queue/${done.id}/cancel`, { method: 'POST' });
        expect(conflict.status).toBe(409);

        const noAuth = await api('/api/job-queue', undefined, null);
        expect(noAuth.status).toBe(401);
    });
});

// ─── 12: rutas admin /api/admin/jobs ─────────────────────────────────────────

describe('rutas /api/admin/jobs (platform admin, cross-tenant)', () => {
    let server: Server | null = null;
    let baseUrl = '';

    const startApp = async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/admin', adminRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    };

    const api = (
        path: string,
        init?: RequestInit,
        opts: { tenant?: string | null; admin?: boolean } = {},
    ) => {
        const { tenant = T_A, admin = true } = opts;
        return fetch(`${baseUrl}${path}`, {
            ...init,
            headers: {
                'content-type': 'application/json',
                ...(tenant ? { 'x-test-tenant': tenant } : {}),
                ...(admin ? { 'x-test-platform-admin': '1' } : {}),
                ...(init?.headers ?? {}),
            },
        });
    };

    afterEach(async () => {
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    it('(12) sin auth → 401; sin platform-admin → 403', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        adminJobsRouteDeps.jobQueueStore = store;
        await startApp();

        const noAuth = await api('/api/admin/jobs', undefined, { tenant: null });
        expect(noAuth.status).toBe(401);
        const notAdmin = await api('/api/admin/jobs', undefined, { admin: false });
        expect(notAdmin.status).toBe(403);
        const notAdminPost = await api(
            '/api/admin/jobs/00000000-0000-4000-8000-000000000099/retry',
            { method: 'POST' },
            { admin: false },
        );
        expect([401, 403]).toContain(notAdminPost.status);
    });

    it('(12) con platform-admin lista cross-tenant con counts', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        adminJobsRouteDeps.jobQueueStore = store;
        await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const deadB = await store.enqueue({ tenantId: T_B, kind: 'retention.purge' });
        deadB.status = 'dead';
        deadB.deadLetteredAt = T0;
        await startApp();

        const res = await api('/api/admin/jobs');
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            jobs: Array<{ tenantId: string; status: string }>;
            total: number;
            counts: Record<string, number>;
        };
        expect(body.total).toBe(2); // ve los dos tenants
        expect(body.jobs).toHaveLength(2);
        expect(body.counts.pending).toBe(1);
        expect(body.counts.dead).toBe(1);

        const filtered = await api('/api/admin/jobs?status=dead');
        const filteredBody = (await filtered.json()) as { jobs: unknown[]; total: number };
        expect(filteredBody.total).toBe(1);
        expect(filteredBody.jobs).toHaveLength(1);
    });

    it('(12) retry de un job dead → 200 y la mutación queda auditada', async () => {
        const { store } = createMemoryJobQueueStore({ now: () => T0 });
        adminJobsRouteDeps.jobQueueStore = store;
        const dead = await store.enqueue({ tenantId: T_B, kind: 'retention.purge' });
        dead.status = 'dead';
        dead.deadLetteredAt = T0;
        await startApp();

        const res = await api(`/api/admin/jobs/${dead.id}/retry`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { job: { status: string; attempts: number } };
        expect(body.job.status).toBe('pending');
        expect(body.job.attempts).toBe(0);

        // Audit: auditFromRequest con la acción nueva admin.job_requeued.
        const auditMock = vi.mocked(auditFromRequest);
        expect(auditMock).toHaveBeenCalledWith(
            expect.anything(),
            'admin.job_requeued',
            expect.objectContaining({
                entityType: 'job_queue',
                entityId: dead.id,
                metadata: expect.objectContaining({ tenantId: T_B, previousStatus: 'dead' }),
            }),
        );

        // Un job pending no es retryable → 409; inexistente → 404.
        const pending = await store.enqueue({ tenantId: T_A, kind: 'retention.purge' });
        const conflict = await api(`/api/admin/jobs/${pending.id}/retry`, { method: 'POST' });
        expect(conflict.status).toBe(409);
        const missing = await api(
            '/api/admin/jobs/00000000-0000-4000-8000-000000000099/retry',
            { method: 'POST' },
        );
        expect(missing.status).toBe(404);
    });
});
