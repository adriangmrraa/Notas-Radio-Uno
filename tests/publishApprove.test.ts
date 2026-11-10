/**
 * Tests del circuito de aprobación PG-05 — `POST /api/review/:id/approve` y
 * `POST /api/review/batch` (approve) montados en una app express efímera.
 *
 * Lo que se valida del brief:
 *   (a) approve con conexiones Zernio encola UN publish job por red/cuenta
 *       destino y la publicación queda 'approved' (el worker la pasa a
 *       'published' cuando todos los jobs publican — syncSourceStatus).
 *   (f) approve SIN conexiones Zernio corre el flujo legacy intacto
 *       (publishToChannels), sin tocar la cola.
 *   Tenant siempre del auth mockeado (x-test-tenant); un id ajeno → 404.
 *
 * Deterministas: databaseService/publishService/auditService mockeados en el
 * borde del módulo (vi.mock), la cola corre con `memoryPublishJobStore` y
 * las conexiones/configs via deps inyectadas — sin DB real ni red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de DB (importarlo crea un Pool Neon) ───────────────────────
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

// ─── Estado compartido de los mocks de módulo ────────────────────────────────
const mocks = vi.hoisted(() => ({
    pubs: new Map<
        string,
        {
            id: string;
            tenantId: string;
            title: string | null;
            content: string | null;
            imagePath: string | null;
            imageUrl: string | null;
            status: string;
        }
    >(),
    publishToChannels: vi.fn(),
    updatePublicationStatus: vi.fn(),
    addEditHistoryEntry: vi.fn(),
}));

vi.mock('../src/server/services/databaseService.js', () => ({
    getPublicationsByStatus: async () => ({ publications: [], total: 0 }),
    getReviewPublicationById: async (id: string, tenantId: string) => {
        const pub = mocks.pubs.get(id);
        return pub && pub.tenantId === tenantId ? pub : null;
    },
    updatePublicationStatus: mocks.updatePublicationStatus,
    updatePublicationContent: async () => null,
    addEditHistoryEntry: mocks.addEditHistoryEntry,
}));

vi.mock('../src/server/services/publishService.js', () => ({
    publishToChannels: mocks.publishToChannels,
}));

vi.mock('../src/server/services/auditService.js', async (io) => ({
    ...(await io()),
    auditFromRequest: vi.fn(async () => undefined),
}));

// Los demás servicios que review.ts importa no intervienen en el approve —
// se mockean para que el módulo cargue sin tocar AI/fs/DB.
vi.mock('../src/server/services/aiSdkService.js', () => ({
    chatCompletion: vi.fn(),
}));
vi.mock('../src/server/services/imageService.js', () => ({
    processImage: vi.fn(),
}));
vi.mock('../src/server/services/brandingService.js', () => ({
    loadTenantBranding: vi.fn(),
}));
vi.mock('../src/server/services/contentMultiplierService.js', () => ({
    generateContentVariants: vi.fn(),
    regenerateVariant: vi.fn(),
}));
vi.mock('../src/server/services/editorialPromptService.js', () => ({
    programBelongsToTenant: vi.fn(async () => true),
    resolveEditorialPromptContext: vi.fn(async () => ({ tone: 'formal', block: '' })),
}));

import { registerReviewRoutes, reviewPublishDeps } from '../src/server/routes/review';
import type { SocialConnectionRow } from '../src/server/services/socialConnectionsService';
import { createMemoryPublishJobStore } from './helpers/memoryPublishJobStore';

const T_A = 'tenant-a';
const PUB_1 = '11111111-1111-4111-8111-111111111111';
const PUB_2 = '11111111-1111-4111-8111-111111111112';
const T0 = new Date('2026-11-10T12:00:00.000Z');

const makeConn = (v: {
    tenantId: string;
    platform: string;
    accountId: string;
    status?: string;
}): SocialConnectionRow => ({
    id: '55555555-5555-4555-8555-555555555551',
    tenantId: v.tenantId,
    platform: v.platform,
    accountId: v.accountId,
    username: 'radio.uno',
    displayName: 'Radio Uno',
    status: v.status ?? 'connected',
    zernioProfileId: 'zprof_1',
    lastSyncedAt: null,
    createdAt: T0,
    updatedAt: T0,
});

const seedPub = (id: string, tenantId = T_A) => {
    mocks.pubs.set(id, {
        id,
        tenantId,
        title: 'Nota de prueba',
        content: 'Contenido de la nota',
        imagePath: '/tmp/img.png',
        imageUrl: 'https://cdn.test/img.png',
        status: 'pending_review',
    });
};

let server: Server | null = null;
let baseUrl = '';

const api = (path: string, init?: RequestInit, tenant = T_A) =>
    fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            'content-type': 'application/json',
            'x-test-tenant': tenant,
            ...(init?.headers ?? {}),
        },
    });

beforeEach(async () => {
    mocks.pubs.clear();
    mocks.publishToChannels.mockReset().mockResolvedValue({ drive: 'ok' });
    mocks.updatePublicationStatus
        .mockReset()
        .mockImplementation(async (id: string, _tenantId: string, status: string) => {
            const pub = mocks.pubs.get(id);
            if (pub) pub.status = status;
            return pub ?? null;
        });
    mocks.addEditHistoryEntry.mockReset().mockResolvedValue(null);

    const app = express();
    app.use(express.json());
    registerReviewRoutes(app);
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
    reviewPublishDeps.enqueueForApproval = undefined;
    reviewPublishDeps.publishJobDeps = undefined;
    await new Promise((r) => server?.close(() => r(null)));
    server = null;
});

describe('POST /api/review/:id/approve — circuito Zernio vs legacy', () => {
    it('(a) con conexiones Zernio encola un job por cuenta y queda approved', async () => {
        seedPub(PUB_1);
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            store,
            listConnections: async () => [
                makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'zacc_1' }),
                makeConn({ tenantId: T_A, platform: 'tiktok', accountId: 'zacc_2' }),
            ],
            listAutoPublishConfigs: async () => [],
            // PG-06: estos tests no ejercitan la composición por red —
            // sin origen de menciones (publishMentions.test.ts la cubre).
            getMentionSource: async () => null,
            listMentionPersons: async () => [],
        };

        const res = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            success: boolean;
            publish: string;
            enqueued: number;
            targetCount: number;
            jobs: Array<{ platform: string; accountId: string; publicationId: string }>;
        };
        expect(body.publish).toBe('zernio');
        expect(body.enqueued).toBe(2);
        expect(body.targetCount).toBe(2);
        expect(body.jobs).toHaveLength(2);
        expect(
            body.jobs.every(
                (j) => j.publicationId === PUB_1 && j.accountId.startsWith('zacc_'),
            ),
        ).toBe(true);
        // Un job por red/cuenta en la cola persistente:
        expect(state.jobs).toHaveLength(2);
        // La publicación queda 'approved' — NO 'published' (los jobs mandan).
        expect(mocks.updatePublicationStatus).toHaveBeenCalledWith(
            PUB_1,
            T_A,
            'approved',
        );
        expect(mocks.publishToChannels).not.toHaveBeenCalled();
    });

    it('media: imageUrl local no viaja a los jobs (sólo URLs http(s))', async () => {
        seedPub(PUB_1);
        mocks.pubs.get(PUB_1)!.imageUrl = '/output/img.png';
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            store,
            listConnections: async () => [
                makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'zacc_1' }),
            ],
            listAutoPublishConfigs: async () => [],
            // PG-06: estos tests no ejercitan la composición por red —
            // sin origen de menciones (publishMentions.test.ts la cubre).
            getMentionSource: async () => null,
            listMentionPersons: async () => [],
        };
        const res = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        const body = (await res.json()) as { jobs: Array<{ mediaUrls: string[] }> };
        expect(body.jobs[0].mediaUrls).toEqual([]);
    });

    it('(f) SIN conexiones Zernio → publishToChannels legacy corre intacto', async () => {
        seedPub(PUB_1);
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            store,
            listConnections: async () => [],
            listAutoPublishConfigs: async () => [],
            // PG-06: estos tests no ejercitan la composición por red —
            // sin origen de menciones (publishMentions.test.ts la cubre).
            getMentionSource: async () => null,
            listMentionPersons: async () => [],
        };

        const res = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success: boolean; publishResults: unknown };
        expect(body.success).toBe(true);
        expect(body.publishResults).toEqual({ drive: 'ok' });
        expect(mocks.publishToChannels).toHaveBeenCalledTimes(1);
        // La cola quedó vacía y nunca se llamó 'approved' por el camino Zernio.
        expect(state.jobs).toHaveLength(0);
    });

    it('re-aprobar el mismo id no duplica jobs (idempotency_key dedup)', async () => {
        seedPub(PUB_1);
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            store,
            listConnections: async () => [
                makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'zacc_1' }),
            ],
            listAutoPublishConfigs: async () => [],
            // PG-06: estos tests no ejercitan la composición por red —
            // sin origen de menciones (publishMentions.test.ts la cubre).
            getMentionSource: async () => null,
            listMentionPersons: async () => [],
        };
        await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        const second = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        const body = (await second.json()) as {
            enqueued: number;
            deduplicated: number;
        };
        expect(body.enqueued).toBe(0);
        expect(body.deduplicated).toBe(1);
        expect(state.jobs).toHaveLength(1);
    });

    it('publicación inexistente o ajena → 404; sin auth → 401', async () => {
        const res = await api(
            '/api/review/99999999-9999-4999-8999-999999999999/approve',
            { method: 'POST' },
        );
        expect(res.status).toBe(404);

        seedPub(PUB_1, 'tenant-ajeno');
        const foreign = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        expect(foreign.status).toBe(404);

        const unauth = await fetch(`${baseUrl}/api/review/${PUB_1}/approve`, {
            method: 'POST',
        });
        expect(unauth.status).toBe(401);
    });
});

describe('POST /api/review/batch — approve encola por publicación', () => {
    it('con conexiones encola un job por cuenta en cada publicación', async () => {
        seedPub(PUB_1);
        seedPub(PUB_2);
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            store,
            listConnections: async () => [
                makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'zacc_1' }),
            ],
            listAutoPublishConfigs: async () => [],
            // PG-06: estos tests no ejercitan la composición por red —
            // sin origen de menciones (publishMentions.test.ts la cubre).
            getMentionSource: async () => null,
            listMentionPersons: async () => [],
        };
        const res = await api('/api/review/batch', {
            method: 'POST',
            body: JSON.stringify({ ids: [PUB_1, PUB_2], action: 'approve' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { processed: number; errors: number };
        expect(body).toEqual({ success: true, processed: 2, errors: 0 });
        // 1 cuenta × 2 publicaciones = 2 jobs (publicationId distinto → keys distintas).
        expect(state.jobs).toHaveLength(2);
        expect(new Set(state.jobs.map((j) => j.publicationId))).toEqual(
            new Set([PUB_1, PUB_2]),
        );
        expect(mocks.updatePublicationStatus).toHaveBeenCalledWith(PUB_1, T_A, 'approved');
        expect(mocks.updatePublicationStatus).toHaveBeenCalledWith(PUB_2, T_A, 'approved');
        expect(mocks.publishToChannels).not.toHaveBeenCalled();
    });

    it('batch sin conexiones → legacy publishToChannels por publicación', async () => {
        seedPub(PUB_1);
        seedPub(PUB_2);
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            store,
            listConnections: async () => [],
            listAutoPublishConfigs: async () => [],
            // PG-06: estos tests no ejercitan la composición por red —
            // sin origen de menciones (publishMentions.test.ts la cubre).
            getMentionSource: async () => null,
            listMentionPersons: async () => [],
        };
        const res = await api('/api/review/batch', {
            method: 'POST',
            body: JSON.stringify({ ids: [PUB_1, PUB_2], action: 'approve' }),
        });
        const body = (await res.json()) as { processed: number; errors: number };
        expect(body.processed).toBe(2);
        expect(mocks.publishToChannels).toHaveBeenCalledTimes(2);
        expect(state.jobs).toHaveLength(0);
    });
});
