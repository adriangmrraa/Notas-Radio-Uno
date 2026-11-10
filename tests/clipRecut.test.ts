/**
 * Tests del slice PF-05: re-corte manual — `clipRecutService` (servicio +
 * `isWindowCovered` puro) sobre `memoryRecutStore`/`memoryRenderJobsStore`,
 * y las rutas de `routes/clips.ts` montadas en una app express efímera
 * (listen(0) + fetch real, auth mockeado con `x-test-tenant` — mismo
 * harness que liveRoomApi/transmissionsVodUpload).
 *
 * Deterministas: sin DB real (stores en memoria con los MISMOS filtros por
 * tenant que el drizzle — listCoverage replica el JOIN segments→recordings
 * y el status='active'), sin worker (se inspecciona la fila encolada en la
 * cola en memoria) y `now` inyectado para el límite de segmentos abiertos.
 *
 * Casos del brief:
 *   - recut ok → enqueue con payload exacto {transmissionId,startMs,endMs,
 *     recutOf} + metadata.recutJobId en el clip origen (merge, no pisa lo
 *     demás).
 *   - invalid_window: end<=start, no finitos, > maxWindowMs (default e
 *     inyectado), startMs negativo.
 *   - window_out_of_coverage: hueco entre segmentos, fuera de rango;
 *     segmento abierto (endMs null) cubre hasta `now` inyectado.
 *   - clip_not_found / no_transmission / aislamiento por tenant.
 *   - clip_rendering: anti-duplicado con job 'cut' pending/running ligado
 *     por payload.recutOf.
 *   - Rutas: 202+jobId, 400 body inválido, 404, 409 coverage/rendering,
 *     422 invalid/no_transmission; GET jobs (incluye el recut job con su
 *     clip_id destino cuando termina); GET render-jobs/:id 200/404;
 *     POST render-jobs/:id/retry 200/404/409.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// ─── Mock parcial de auth (mismo contrato que el resto del repo) ──────────────
vi.mock('../src/server/middleware/auth.js', async (io) => {
    const actual = await io<typeof import('../src/server/middleware/auth.js')>();
    const fakeRequireAuth = (req: Request, res: Response, next: NextFunction): void => {
        const tenant = req.headers['x-test-tenant'];
        if (typeof tenant !== 'string' || tenant.length === 0) {
            res.status(401).json({ error: 'Token de autenticacion requerido' });
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

import {
    ClipRecutError,
    createClipRecutService,
    isWindowCovered,
    type CoverageSegment,
} from '../src/server/services/clipRecutService';
import type {
    ClipRenderJob,
    EnqueueRenderJobInput,
} from '../src/server/services/clipRenderQueueService';
import { clipsRouteDeps, registerClipRoutes } from '../src/server/routes/clips';
import { createMemoryRecutStore } from './helpers/memoryRecutStore';
import { createMemoryRenderJobsStore } from './helpers/memoryRenderJobsStore';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const CLIP_A = '11111111-1111-4111-8111-111111111111';
const CLIP_FOREIGN = '11111111-1111-4111-8111-1111111111fb';
const TX_A = '22222222-2222-4222-8222-222222222222';
const REC_A = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-03-01T12:00:00Z');

// ─── Fixture base: clip + crudo [0,30s] ∪ [30s,90s] ──────────────────────────

function makeState() {
    return {
        clips: [
            {
                id: CLIP_A,
                tenantId: TENANT_A,
                transmissionId: TX_A,
                status: 'ready',
                metadata: { window: { startMs: 0, endMs: 30_000 }, origin: 'manual_mark' },
            },
            // El clip ajeno EXISTE — el 404/clip_not_found sale del filtro
            // por tenant, no de "no existe".
            {
                id: CLIP_FOREIGN,
                tenantId: TENANT_B,
                transmissionId: TX_A,
                status: 'ready',
                metadata: {},
            },
        ],
        recordings: [
            { id: REC_A, tenantId: TENANT_A, transmissionId: TX_A },
        ],
        segments: [
            {
                tenantId: TENANT_A,
                recordingId: REC_A,
                sequence: 1,
                startMs: 0,
                endMs: 30_000,
            },
            {
                tenantId: TENANT_A,
                recordingId: REC_A,
                sequence: 2,
                startMs: 30_000,
                endMs: 90_000,
            },
        ],
    };
}

/** Servicio real sobre stores en memoria + cola en memoria (enqueue REAL). */
function makeService(opts?: {
    seed?: ReturnType<typeof makeState>;
    jobs?: Array<Partial<ClipRenderJob> & { tenantId: string; kind: string }>;
    now?: () => Date;
    maxWindowMs?: number;
}) {
    // OJO: el helper COPIA el seed — las mutaciones/asserts van sobre
    // `recut.state` (el estado interno del store), no sobre el seed.
    const recut = createMemoryRecutStore(opts?.seed ?? makeState());
    const queue = createMemoryRenderJobsStore({
        jobs: opts?.jobs,
        now: () => NOW,
    });
    const service = createClipRecutService(recut.store, {
        enqueue: (v: EnqueueRenderJobInput) => queue.store.enqueue(v),
        listJobsByClip: (clipId, tenantId) =>
            queue.store.listByClip(clipId, tenantId),
        now: opts?.now ?? (() => NOW),
        ...(opts?.maxWindowMs !== undefined
            ? { maxWindowMs: opts.maxWindowMs }
            : {}),
    });
    return { service, state: recut.state, queue };
}

const expectReason = async (
    p: Promise<unknown>,
    reason: ClipRecutError['reason'],
) => {
    await expect(p).rejects.toMatchObject({
        name: 'ClipRecutError',
        reason,
    });
};

// ─── isWindowCovered (pura) ─────────────────────────────────────────────────

describe('isWindowCovered', () => {
    const seg = (startMs: number, endMs: number | null): CoverageSegment => ({
        startMs,
        endMs,
    });

    it('un solo segmento conteniendo la ventana → true', () => {
        expect(isWindowCovered([seg(0, 90_000)], 10_000, 50_000, 0)).toBe(true);
    });

    it('unión contigua de varios segmentos → true', () => {
        const cov = [seg(0, 30_000), seg(30_000, 60_000), seg(60_000, 90_000)];
        expect(isWindowCovered(cov, 20_000, 80_000, 0)).toBe(true);
    });

    it('hueco entre segmentos → false', () => {
        const cov = [seg(0, 30_000), seg(35_000, 90_000)];
        expect(isWindowCovered(cov, 10_000, 50_000, 0)).toBe(false);
        // Pero una ventana entera DENTRO de un tramo sí pasa.
        expect(isWindowCovered(cov, 40_000, 50_000, 0)).toBe(true);
    });

    it('ventana que empieza antes del primer segmento → false', () => {
        expect(isWindowCovered([seg(10_000, 90_000)], 0, 20_000, 0)).toBe(false);
    });

    it('ventana más allá del último end → false', () => {
        expect(isWindowCovered([seg(0, 90_000)], 60_000, 120_000, 0)).toBe(false);
    });

    it('segmentos solapados no abren huecos falsos', () => {
        const cov = [seg(0, 50_000), seg(30_000, 90_000)];
        expect(isWindowCovered(cov, 40_000, 80_000, 0)).toBe(true);
    });

    it('segmento abierto (endMs null) cubre hasta nowMs inyectado', () => {
        const cov = [seg(0, 30_000), seg(30_000, null)];
        // nowMs = 45s: [35s,45s] entra justo; [35s,50s] no.
        expect(isWindowCovered(cov, 35_000, 45_000, 45_000)).toBe(true);
        expect(isWindowCovered(cov, 35_000, 50_000, 45_000)).toBe(false);
    });

    it('cobertura vacía → false', () => {
        expect(isWindowCovered([], 0, 1_000, 0)).toBe(false);
    });
});

// ─── recutClip (servicio) ───────────────────────────────────────────────────

describe('recutClip', () => {
    it('ok → encola kind cut con el payload exacto y linkea recutJobId en el origen', async () => {
        const { service, state, queue } = makeService();

        const { job } = await service.recutClip({
            tenantId: TENANT_A,
            clipId: CLIP_A,
            startMs: 10_000,
            endMs: 40_000,
        });

        expect(job.kind).toBe('cut');
        expect(job.status).toBe('pending');
        expect(job.tenantId).toBe(TENANT_A);
        expect(job.clipId).toBeNull(); // lo rellena el worker con el clip nuevo
        expect(job.payload).toEqual({
            transmissionId: TX_A,
            startMs: 10_000,
            endMs: 40_000,
            recutOf: CLIP_A,
        });
        expect(queue.state.jobs).toHaveLength(1);

        // Merge jsonb: recutJobId se suma SIN pisar la metadata existente.
        const clip = state.clips.find((c) => c.id === CLIP_A)!;
        expect(clip.metadata).toMatchObject({
            recutJobId: job.id,
            window: { startMs: 0, endMs: 30_000 },
            origin: 'manual_mark',
        });
    });

    it('clip inexistente o de OTRO tenant → clip_not_found', async () => {
        const { service } = makeService();
        await expectReason(
            service.recutClip({
                tenantId: TENANT_A,
                clipId: 'clip-que-no-existe',
                startMs: 0,
                endMs: 10_000,
            }),
            'clip_not_found',
        );
        // Aislamiento: el clip de TENANT_B no es visible para TENANT_A.
        await expectReason(
            service.recutClip({
                tenantId: TENANT_A,
                clipId: CLIP_FOREIGN,
                startMs: 0,
                endMs: 10_000,
            }),
            'clip_not_found',
        );
    });

    it('clip sin transmissionId → no_transmission', async () => {
        const seed = makeState();
        seed.clips[0].transmissionId = null;
        const { service, queue } = makeService({ seed });
        await expectReason(
            service.recutClip({
                tenantId: TENANT_A,
                clipId: CLIP_A,
                startMs: 0,
                endMs: 10_000,
            }),
            'no_transmission',
        );
        expect(queue.state.jobs).toHaveLength(0); // nunca encoló
    });

    it('invalid_window: endMs <= startMs, negativos y no finitos', async () => {
        const { service } = makeService();
        const base = { tenantId: TENANT_A, clipId: CLIP_A };
        await expectReason(
            service.recutClip({ ...base, startMs: 10_000, endMs: 10_000 }),
            'invalid_window',
        );
        await expectReason(
            service.recutClip({ ...base, startMs: 10_000, endMs: 5_000 }),
            'invalid_window',
        );
        await expectReason(
            service.recutClip({ ...base, startMs: -1, endMs: 5_000 }),
            'invalid_window',
        );
        await expectReason(
            service.recutClip({ ...base, startMs: 0, endMs: Number.NaN }),
            'invalid_window',
        );
        await expectReason(
            service.recutClip({
                ...base,
                startMs: 0,
                endMs: Number.POSITIVE_INFINITY,
            }),
            'invalid_window',
        );
    });

    it('invalid_window: duración > maxWindowMs (default 120s e inyectado)', async () => {
        const { service } = makeService();
        // La cobertura llega a 90s — una ventana de 121s sería inválida por
        // duración AUNQUE hubiera crudo (primero pega el tope).
        await expectReason(
            service.recutClip({
                tenantId: TENANT_A,
                clipId: CLIP_A,
                startMs: 0,
                endMs: 120_001,
            }),
            'invalid_window',
        );

        // Con maxWindowMs inyectado más chico, una ventana legal falla igual.
        const tight = makeService({ maxWindowMs: 10_000 });
        await expectReason(
            tight.service.recutClip({
                tenantId: TENANT_A,
                clipId: CLIP_A,
                startMs: 0,
                endMs: 15_000,
            }),
            'invalid_window',
        );
    });

    it('window_out_of_coverage: hueco entre segmentos y fuera de rango', async () => {
        const seed = makeState();
        // Hueco [30s, 40s): el segundo segmento arranca en 40s.
        seed.segments[1].startMs = 40_000;
        const { service, queue } = makeService({ seed });

        await expectReason(
            service.recutClip({
                tenantId: TENANT_A,
                clipId: CLIP_A,
                startMs: 20_000,
                endMs: 50_000,
            }),
            'window_out_of_coverage',
        );
        await expectReason(
            service.recutClip({
                tenantId: TENANT_A,
                clipId: CLIP_A,
                startMs: 80_000,
                endMs: 100_000, // más allá del último end (90s)
            }),
            'window_out_of_coverage',
        );
        expect(queue.state.jobs).toHaveLength(0); // nada encolado
    });

    it('segmento abierto cubre hasta `now` inyectado: dentro ok, fuera falla', async () => {
        const seed = makeState();
        seed.segments[1].endMs = null; // sigue grabando
        const nowMs = 45_000;
        const { service } = makeService({
            seed,
            now: () => new Date(nowMs),
        });

        // [35s,45s] entra justo en el límite del segmento abierto.
        const ok = await service.recutClip({
            tenantId: TENANT_A,
            clipId: CLIP_A,
            startMs: 35_000,
            endMs: 45_000,
        });
        expect(ok.job.status).toBe('pending');

        // [35s,50s] supera el "ahora" del crudo → fuera de cobertura.
        await expectReason(
            service.recutClip({
                tenantId: TENANT_A,
                clipId: CLIP_A,
                startMs: 35_000,
                endMs: 50_000,
            }),
            'window_out_of_coverage',
        );
    });

    it('clip_rendering: rechaza si ya hay un cut pending/running ligado por recutOf', async () => {
        for (const status of ['pending', 'running'] as const) {
            const { service, queue } = makeService({
                jobs: [
                    {
                        tenantId: TENANT_A,
                        kind: 'cut',
                        status,
                        payload: {
                            transmissionId: TX_A,
                            startMs: 0,
                            endMs: 10_000,
                            recutOf: CLIP_A,
                        },
                    },
                ],
            });
            await expectReason(
                service.recutClip({
                    tenantId: TENANT_A,
                    clipId: CLIP_A,
                    startMs: 20_000,
                    endMs: 30_000,
                }),
                'clip_rendering',
            );
            expect(queue.state.jobs).toHaveLength(1); // no encoló otro
        }
    });

    it('un cut terminado/cancelado NO bloquea; un reframe pending tampoco', async () => {
        const { service } = makeService({
            jobs: [
                {
                    tenantId: TENANT_A,
                    kind: 'cut',
                    status: 'error',
                    payload: { recutOf: CLIP_A },
                },
                {
                    tenantId: TENANT_A,
                    kind: 'reframe',
                    status: 'pending',
                    clipId: CLIP_A,
                    payload: { clipId: CLIP_A },
                },
            ],
        });
        const { job } = await service.recutClip({
            tenantId: TENANT_A,
            clipId: CLIP_A,
            startMs: 0,
            endMs: 10_000,
        });
        expect(job.status).toBe('pending');
    });
});

// ─── Rutas (app express efímera) ────────────────────────────────────────────

let server: Server;
let baseUrl: string;
let routeMem: ReturnType<typeof createMemoryRecutStore>;
let routeQueue: ReturnType<typeof createMemoryRenderJobsStore>;

beforeEach(async () => {
    routeMem = createMemoryRecutStore(makeState());
    routeQueue = createMemoryRenderJobsStore({ now: () => NOW });
    const service = createClipRecutService(routeMem.store, {
        enqueue: (v: EnqueueRenderJobInput) => routeQueue.store.enqueue(v),
        listJobsByClip: (clipId, tenantId) =>
            routeQueue.store.listByClip(clipId, tenantId),
        now: () => NOW,
    });
    clipsRouteDeps.recutClip = (input) => service.recutClip(input);
    clipsRouteDeps.listJobsByClip = (clipId, tenantId) =>
        routeQueue.store.listByClip(clipId, tenantId);
    clipsRouteDeps.getRenderJob = (jobId, tenantId) =>
        routeQueue.store.getById(jobId, tenantId);
    clipsRouteDeps.retryRenderJob = (jobId, tenantId) =>
        routeQueue.store.retry(jobId, tenantId);

    const app = express();
    app.use(express.json());
    registerClipRoutes(app);
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    clipsRouteDeps.recutClip = undefined;
    clipsRouteDeps.listJobsByClip = undefined;
    clipsRouteDeps.getRenderJob = undefined;
    clipsRouteDeps.retryRenderJob = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

const authHeaders = (tenant?: string) =>
    tenant ? { 'x-test-tenant': tenant } : {};

const postJson = (url: string, body: unknown, tenant?: string) =>
    fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(tenant) },
        body: JSON.stringify(body),
    });

const recutUrl = (id: string) => `${baseUrl}/api/clips/${id}/recut`;

describe('POST /api/clips/:id/recut', () => {
    it('sin autenticación → 401', async () => {
        const res = await postJson(recutUrl(CLIP_A), { startMs: 0, endMs: 10_000 });
        expect(res.status).toBe(401);
    });

    it('body inválido (no números / faltantes / no finitos) → 400', async () => {
        for (const body of [
            {},
            { startMs: '0', endMs: 10_000 },
            { startMs: 0 },
            { startMs: 0, endMs: 'diez mil' },
            { startMs: null, endMs: 10_000 },
        ]) {
            const res = await postJson(recutUrl(CLIP_A), body, TENANT_A);
            expect(res.status).toBe(400);
            expect(routeQueue.state.jobs).toHaveLength(0);
        }
    });

    it('clip inexistente → 404; clip de otro tenant → 404 sin leak', async () => {
        const res = await postJson(
            recutUrl('clip-que-no-existe'),
            { startMs: 0, endMs: 10_000 },
            TENANT_A,
        );
        expect(res.status).toBe(404);

        const foreign = await postJson(
            recutUrl(CLIP_FOREIGN),
            { startMs: 0, endMs: 10_000 },
            TENANT_A,
        );
        expect(foreign.status).toBe(404);
        const body = JSON.stringify(await foreign.json());
        expect(body).not.toContain(TENANT_B);
    });

    it('clip sin transmisión → 422 (no_transmission)', async () => {
        routeMem.state.clips[0].transmissionId = null;
        const res = await postJson(
            recutUrl(CLIP_A),
            { startMs: 0, endMs: 10_000 },
            TENANT_A,
        );
        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.code).toBe('no_transmission');
    });

    it('ventana inválida (end<=start, > maxWindowMs) → 422 invalid_window', async () => {
        for (const [startMs, endMs] of [
            [10_000, 10_000],
            [20_000, 10_000],
            [0, 120_001],
        ]) {
            const res = await postJson(recutUrl(CLIP_A), { startMs, endMs }, TENANT_A);
            expect(res.status).toBe(422);
            const json = await res.json();
            expect(json.code).toBe('invalid_window');
        }
        expect(routeQueue.state.jobs).toHaveLength(0);
    });

    it('ventana fuera de cobertura → 409 window_out_of_coverage', async () => {
        const res = await postJson(
            recutUrl(CLIP_A),
            { startMs: 80_000, endMs: 100_000 },
            TENANT_A,
        );
        expect(res.status).toBe(409);
        const json = await res.json();
        expect(json.code).toBe('window_out_of_coverage');
    });

    it('re-corte ya en vuelo → 409 clip_rendering', async () => {
        await routeQueue.store.enqueue({
            tenantId: TENANT_A,
            kind: 'cut',
            payload: { transmissionId: TX_A, startMs: 0, endMs: 10_000, recutOf: CLIP_A },
        });
        const res = await postJson(
            recutUrl(CLIP_A),
            { startMs: 20_000, endMs: 30_000 },
            TENANT_A,
        );
        expect(res.status).toBe(409);
        const json = await res.json();
        expect(json.code).toBe('clip_rendering');
        expect(routeQueue.state.jobs).toHaveLength(1);
    });

    it('ok → 202 {jobId, status: pending} + job encolado con payload recutOf', async () => {
        const res = await postJson(
            recutUrl(CLIP_A),
            { startMs: 10_000, endMs: 40_000 },
            TENANT_A,
        );
        expect(res.status).toBe(202);
        const json = await res.json();
        expect(json).toEqual({ jobId: expect.any(String), status: 'pending' });

        const job = routeQueue.state.jobs.find((j) => j.id === json.jobId);
        expect(job).toBeDefined();
        expect(job!.payload).toEqual({
            transmissionId: TX_A,
            startMs: 10_000,
            endMs: 40_000,
            recutOf: CLIP_A,
        });

        // El origen quedó linkeado al job.
        const clip = routeMem.state.clips.find((c) => c.id === CLIP_A)!;
        expect(clip.metadata).toMatchObject({ recutJobId: json.jobId });
    });
});

describe('GET /api/clips/:id/jobs', () => {
    it('sin autenticación → 401', async () => {
        const res = await fetch(`${baseUrl}/api/clips/${CLIP_A}/jobs`);
        expect(res.status).toBe(401);
    });

    it('incluye el recut job por payload.recutOf y su clip_id destino cuando termina', async () => {
        const res = await postJson(
            recutUrl(CLIP_A),
            { startMs: 10_000, endMs: 40_000 },
            TENANT_A,
        );
        const { jobId } = await res.json();

        // Pending: clip_id NULL — se encuentra por payload.recutOf.
        let jobsRes = await fetch(`${baseUrl}/api/clips/${CLIP_A}/jobs`, {
            headers: authHeaders(TENANT_A),
        });
        expect(jobsRes.status).toBe(200);
        let json = await jobsRes.json();
        expect(json.jobs.map((j: ClipRenderJob) => j.id)).toEqual([jobId]);
        expect(json.jobs[0].clipId).toBeNull();

        // Simulo el done del worker: clip_id → el clip DERIVADO nuevo, y el
        // job SIGUE listado desde el origen (recutOf es el vínculo estable).
        await routeQueue.store.markDone(jobId, { clipId: 'clip-derivado' });
        jobsRes = await fetch(`${baseUrl}/api/clips/${CLIP_A}/jobs`, {
            headers: authHeaders(TENANT_A),
        });
        json = await jobsRes.json();
        expect(json.jobs).toHaveLength(1);
        expect(json.jobs[0].clipId).toBe('clip-derivado');
        expect(json.jobs[0].status).toBe('done');
    });

    it('clip de otro tenant → 200 con lista vacía (sin leak)', async () => {
        const res = await fetch(`${baseUrl}/api/clips/${CLIP_FOREIGN}/jobs`, {
            headers: authHeaders(TENANT_A),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).jobs).toEqual([]);
    });
});

describe('GET /api/render-jobs/:jobId', () => {
    it('sin autenticación → 401', async () => {
        const res = await fetch(`${baseUrl}/api/render-jobs/job-x`);
        expect(res.status).toBe(401);
    });

    it('200 {job} propio; 404 inexistente y de otro tenant', async () => {
        const job = await routeQueue.store.enqueue({
            tenantId: TENANT_A,
            kind: 'cut',
            payload: { transmissionId: TX_A, startMs: 0, endMs: 10_000 },
        });

        const ok = await fetch(`${baseUrl}/api/render-jobs/${job.id}`, {
            headers: authHeaders(TENANT_A),
        });
        expect(ok.status).toBe(200);
        const json = await ok.json();
        expect(json.job).toMatchObject({ id: job.id, kind: 'cut', status: 'pending' });

        const missing = await fetch(`${baseUrl}/api/render-jobs/no-existe`, {
            headers: authHeaders(TENANT_A),
        });
        expect(missing.status).toBe(404);

        // Existe pero es del tenant A — para B es 404 (sin distinguir).
        const foreign = await fetch(`${baseUrl}/api/render-jobs/${job.id}`, {
            headers: authHeaders(TENANT_B),
        });
        expect(foreign.status).toBe(404);
    });
});

describe('POST /api/render-jobs/:jobId/retry', () => {
    const retryUrl = (id: string) => `${baseUrl}/api/render-jobs/${id}/retry`;

    it('sin autenticación → 401', async () => {
        const res = await postJson(retryUrl('job-x'), {});
        expect(res.status).toBe(401);
    });

    it('job en error → 200 con status pending; running → 409; inexistente → 404', async () => {
        const errJob = await routeQueue.store.enqueue({
            tenantId: TENANT_A,
            kind: 'cut',
            payload: {},
        });
        // Lo llevo a error terminal vía la cola real.
        routeQueue.state.jobs[0].status = 'error';
        routeQueue.state.jobs[0].attempts = 3;
        routeQueue.state.jobs[0].lastError = 'ffmpeg boom';

        const ok = await postJson(retryUrl(errJob.id), {}, TENANT_A);
        expect(ok.status).toBe(200);
        const json = await ok.json();
        expect(json.job).toMatchObject({ id: errJob.id, status: 'pending', attempts: 0 });

        const runningJob = await routeQueue.store.enqueue({
            tenantId: TENANT_A,
            kind: 'cut',
            payload: {},
        });
        routeQueue.state.jobs.find((j) => j.id === runningJob.id)!.status =
            'running';
        const conflict = await postJson(retryUrl(runningJob.id), {}, TENANT_A);
        expect(conflict.status).toBe(409);
        const cj = await conflict.json();
        expect(cj.code).toBe('job_not_retryable');

        const missing = await postJson(retryUrl('no-existe'), {}, TENANT_A);
        expect(missing.status).toBe(404);

        // Job de TENANT_A pedido por TENANT_B → 404 (no lo toca).
        const foreign = await postJson(retryUrl(errJob.id), {}, TENANT_B);
        expect(foreign.status).toBe(404);
    });
});
