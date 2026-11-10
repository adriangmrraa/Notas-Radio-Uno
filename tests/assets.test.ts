/**
 * Tests del slice PF-10: `assetsService` — ledger editorial unificado
 * (clip | note | flyer | post) sobre `clips`/`publications` con máquina de
 * estados canónica, sync idempotente y write-through al status legacy.
 *
 * Deterministas, mismo estilo que noteFactory/quoteFlyers/networkVariants:
 * store en memoria que replica la semántica del ON CONFLICT (keyed por
 * tenant_id+source_table+ref_id, status preservado en conflicto) y los
 * filtros por tenant de la impl drizzle; app express efímera para las
 * rutas — nunca Neon ni DB real.
 *
 * Cubre el brief:
 *   - mapLegacyStatus (ambas tablas + desconocido→draft), canTransition
 *     (todas las aristas válidas e inválidas), toLegacyStatus (inverso +
 *     archived→null).
 *   - flyerRefId: uuid v5 determinista.
 *   - syncAssets: clip/note/flyer con payloads correctos, parent_asset_id
 *     flyer→nota, idempotencia (2 corridas = mismos counts, sin duplicar),
 *     status manual preservado en re-sync, filtro por transmisión,
 *     aislamiento por tenant.
 *   - transitionAsset: write-through clips 'ready'/publications 'approved'/
 *     'published'; archived sólo toca el asset (sin legacy); errores
 *     invalid_state/asset_not_found/invalid_transition.
 *   - Rutas: GET lista + filtros kind/status/transmissionId (y 400),
 *     POST /sync 200 (+400), POST /:id/transition 200/400/404/409/422,
 *     401 sin auth, aislamiento por tenant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de auth (mismo contrato que networkVariants.test.ts) ───────
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

import {
    ASSET_STATES,
    ASSET_TRANSITIONS,
    canTransition,
    flyerRefId,
    listAssets,
    mapLegacyStatus,
    syncAssets,
    toLegacyStatus,
    transitionAsset,
    type AssetState,
} from '../src/server/services/assetsService';
import { assetsRouter, assetsRouteDeps } from '../src/server/routes/assets';
import {
    createMemoryAssetsStore,
    seedAssetClip,
    seedAssetPublication,
    type MemoryAssetState,
} from './helpers/memoryAssetsStore';
import type { AssetStore } from '../src/server/services/assetsService';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TX_1 = '00000000-0000-4000-8000-0000000000a1';
const TX_2 = '00000000-0000-4000-8000-0000000000a2';
const CLIP_1 = '00000000-0000-4000-8000-0000000000c1';
const CLIP_2 = '00000000-0000-4000-8000-0000000000c2';
const CLIP_ERR = '00000000-0000-4000-8000-0000000000c3';
const PUB_1 = '00000000-0000-4000-8000-0000000000d1';
const PUB_B = '00000000-0000-4000-8000-0000000000d2';
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── mapLegacyStatus ──────────────────────────────────────────────────────────

describe('mapLegacyStatus', () => {
    it('mapea todos los statuses de clips al canónico', () => {
        expect(mapLegacyStatus('clips', 'generating')).toBe('draft');
        expect(mapLegacyStatus('clips', 'pending_review')).toBe(
            'pending_review',
        );
        expect(mapLegacyStatus('clips', 'ready')).toBe('approved');
        expect(mapLegacyStatus('clips', 'published')).toBe('published');
        expect(mapLegacyStatus('clips', 'error')).toBe('draft');
    });

    it('mapea todos los statuses de publications al canónico', () => {
        expect(mapLegacyStatus('publications', 'pending_review')).toBe(
            'pending_review',
        );
        expect(mapLegacyStatus('publications', 'approved')).toBe('approved');
        expect(mapLegacyStatus('publications', 'published')).toBe(
            'published',
        );
        expect(mapLegacyStatus('publications', 'rejected')).toBe('archived');
    });

    it('status desconocido → draft (conservador, el sync nunca rompe)', () => {
        expect(mapLegacyStatus('clips', 'que_no_existe')).toBe('draft');
        expect(mapLegacyStatus('publications', 'drafted')).toBe('draft');
        expect(mapLegacyStatus('clips', '')).toBe('draft');
    });
});

// ─── canTransition / ASSET_TRANSITIONS ────────────────────────────────────────

describe('canTransition', () => {
    it('cubre exactamente las aristas del brief', () => {
        const valid: Array<[AssetState, AssetState]> = [
            ['draft', 'pending_review'],
            ['pending_review', 'approved'],
            ['pending_review', 'archived'],
            ['approved', 'published'],
            ['approved', 'archived'],
        ];
        for (const [from, to] of valid) {
            expect(canTransition(from, to)).toBe(true);
        }
        // Ningún otro par es válido — ni auto-transiciones ni saltos.
        for (const from of ASSET_STATES) {
            for (const to of ASSET_STATES) {
                const expected = valid.some(([f, t]) => f === from && t === to);
                expect(canTransition(from, to)).toBe(expected);
            }
        }
    });

    it('rechaza las inválidas del brief: draft→published y published→draft', () => {
        expect(canTransition('draft', 'published')).toBe(false);
        expect(canTransition('published', 'draft')).toBe(false);
        expect(canTransition('published', 'archived')).toBe(false);
        expect(canTransition('archived', 'draft')).toBe(false);
        expect(canTransition('draft', 'approved')).toBe(false);
        expect(canTransition('pending_review', 'published')).toBe(false);
    });

    it('estado origen inexistente → false (no explota)', () => {
        expect(canTransition('inventado', 'draft')).toBe(false);
    });
});

// ─── toLegacyStatus (write-through inverso) ───────────────────────────────────

describe('toLegacyStatus', () => {
    it('canónico → legacy por tabla fuente', () => {
        expect(toLegacyStatus('clips', 'approved')).toBe('ready');
        expect(toLegacyStatus('clips', 'published')).toBe('published');
        expect(toLegacyStatus('clips', 'pending_review')).toBe(
            'pending_review',
        );
        expect(toLegacyStatus('publications', 'approved')).toBe('approved');
        expect(toLegacyStatus('publications', 'published')).toBe('published');
        expect(toLegacyStatus('publications', 'pending_review')).toBe(
            'pending_review',
        );
    });

    it('archived → null en ambas: NO tiene legacy (no es rejected)', () => {
        expect(toLegacyStatus('clips', 'archived')).toBeNull();
        expect(toLegacyStatus('publications', 'archived')).toBeNull();
    });
});

// ─── flyerRefId (uuid v5 determinista) ────────────────────────────────────────

describe('flyerRefId', () => {
    it('es determinista, uuid válido y distinto por pub/índice', () => {
        const a = flyerRefId(PUB_1, 0);
        expect(a).toBe(flyerRefId(PUB_1, 0));
        expect(a).toMatch(UUID_RE);
        expect(flyerRefId(PUB_1, 1)).not.toBe(a);
        expect(flyerRefId(PUB_B, 0)).not.toBe(a);
    });
});

// ─── syncAssets ───────────────────────────────────────────────────────────────

describe('syncAssets', () => {
    let store: AssetStore;
    let state: MemoryAssetState;

    beforeEach(() => {
        ({ store, state } = createMemoryAssetsStore());
    });

    it('sincroniza clips → assets kind=clip con payload y estado mapeado', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'ready',
            videoPath: 'clips/a.mp4',
            duration: 42,
            transmissionId: TX_1,
        });
        seedAssetClip(state, {
            id: CLIP_ERR,
            tenantId: T_A,
            status: 'error',
            metadata: { error: 'ffmpeg explotó', other: 1 },
        });

        const result = await syncAssets({ tenantId: T_A }, { store });

        expect(result.upserted).toBe(2);
        expect(result.byKind).toEqual({
            clip: 2,
            note: 0,
            flyer: 0,
            post: 0,
        });

        const assets = await listAssets({ tenantId: T_A }, { store });
        const ready = assets.find((a) => a.refId === CLIP_1)!;
        expect(ready.kind).toBe('clip');
        expect(ready.sourceTable).toBe('clips');
        expect(ready.status).toBe('approved'); // ready → approved
        expect(ready.transmissionId).toBe(TX_1);
        expect(ready.payload).toEqual({
            videoPath: 'clips/a.mp4',
            duration: 42,
        });

        const errored = assets.find((a) => a.refId === CLIP_ERR)!;
        expect(errored.status).toBe('draft'); // error → draft
        expect(errored.payload.error).toBe('ffmpeg explotó');
    });

    it('sincroniza publications → note + flyers con parent y ref determinista', async () => {
        seedAssetPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            title: 'Nota de economía',
            status: 'published',
            content: 'La nota completa.',
            quoteFlyerPaths: [
                'flyers/pub1-0.png',
                'flyers/pub1-1.png',
                42 as unknown as string, // no-string se ignora
            ],
        });

        const result = await syncAssets({ tenantId: T_A }, { store });

        expect(result.byKind.note).toBe(1);
        expect(result.byKind.flyer).toBe(2);

        const assets = await listAssets({ tenantId: T_A }, { store });
        const note = assets.find((a) => a.kind === 'note')!;
        expect(note.refId).toBe(PUB_1);
        expect(note.status).toBe('published');
        expect(note.payload).toEqual({ content: 'La nota completa.' });
        expect(note.transmissionId).toBeNull();

        const flyers = assets
            .filter((a) => a.kind === 'flyer')
            .sort(
                (x, y) =>
                    (x.payload.quoteIndex as number) -
                    (y.payload.quoteIndex as number),
            );
        expect(flyers).toHaveLength(2);
        expect(flyers[0].refId).toBe(flyerRefId(PUB_1, 0));
        expect(flyers[1].refId).toBe(flyerRefId(PUB_1, 1));
        for (const flyer of flyers) {
            expect(flyer.parentAssetId).toBe(note.id);
            expect(flyer.sourceTable).toBe('publications');
            expect(flyer.status).toBe('published'); // hereda el de la nota
        }
        expect(flyers[0].payload).toEqual({
            flyerPath: 'flyers/pub1-0.png',
            quoteIndex: 0,
        });
        expect(flyers[1].title).toBe('Nota de economía — flyer #2');
    });

    it('es idempotente: 2 corridas → mismos counts, una fila por artefacto', async () => {
        seedAssetClip(state, { id: CLIP_1, tenantId: T_A });
        seedAssetPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quoteFlyerPaths: ['f0.png', 'f1.png', 'f2.png'],
        });

        const first = await syncAssets({ tenantId: T_A }, { store });
        const second = await syncAssets({ tenantId: T_A }, { store });

        expect(second).toEqual(first);
        expect(second.upserted).toBe(5); // 1 clip + 1 nota + 3 flyers
        const assets = await listAssets({ tenantId: T_A }, { store });
        expect(assets).toHaveLength(5);
    });

    it('re-sync preserva el status transicionado manualmente', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'pending_review',
        });
        await syncAssets({ tenantId: T_A }, { store });

        const [asset] = await listAssets({ tenantId: T_A }, { store });
        // Transición editorial manual: pending_review → approved.
        await transitionAsset(
            { tenantId: T_A, assetId: asset.id, to: 'approved' },
            { store },
        );

        // El clip sigue en 'ready' por write-through; si el source volviera
        // a pending_review el re-sync igual NO retrocede el asset.
        seedAssetClip(state, {
            id: CLIP_2,
            tenantId: T_A,
            status: 'generating',
        });
        await syncAssets({ tenantId: T_A }, { store });

        const after = await listAssets({ tenantId: T_A }, { store });
        const original = after.find((a) => a.id === asset.id)!;
        expect(original.status).toBe('approved'); // preservado
        // ...pero los campos estructurales sí se refrescan (title/payload).
        const nuevo = after.find((a) => a.refId === CLIP_2)!;
        expect(nuevo.status).toBe('draft'); // generating → draft
    });

    it('re-sync actualiza title/payload aunque preserve status', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'generating',
            title: 'Título viejo',
            videoPath: 'v1.mp4',
        });
        await syncAssets({ tenantId: T_A }, { store });
        const [a1] = await listAssets({ tenantId: T_A }, { store });
        await transitionAsset(
            { tenantId: T_A, assetId: a1.id, to: 'pending_review' },
            { store },
        );

        // La fuente cambió (nuevo path/título) pero el status editorial
        // del asset queda donde el equipo lo dejó.
        state.clips[0].title = 'Título nuevo';
        state.clips[0].videoPath = 'v2.mp4';
        await syncAssets({ tenantId: T_A }, { store });

        const [a2] = await listAssets({ tenantId: T_A }, { store });
        expect(a2.id).toBe(a1.id);
        expect(a2.title).toBe('Título nuevo');
        expect(a2.payload.videoPath).toBe('v2.mp4');
        expect(a2.status).toBe('pending_review');
    });

    it('transmissionId filtra clips; las notas se sincronizan igual', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            transmissionId: TX_1,
        });
        seedAssetClip(state, {
            id: CLIP_2,
            tenantId: T_A,
            transmissionId: TX_2,
        });
        seedAssetPublication(state, { id: PUB_1, tenantId: T_A });

        const result = await syncAssets(
            { tenantId: T_A, transmissionId: TX_1 },
            { store },
        );

        expect(result.byKind.clip).toBe(1);
        expect(result.byKind.note).toBe(1);
        const assets = await listAssets({ tenantId: T_A }, { store });
        expect(assets.map((a) => a.refId).sort()).toEqual(
            [CLIP_1, PUB_1].sort(),
        );
    });

    it('aislamiento por tenant: sólo sincroniza lo propio', async () => {
        seedAssetClip(state, { id: CLIP_1, tenantId: T_A });
        seedAssetClip(state, { id: CLIP_2, tenantId: T_B });
        seedAssetPublication(state, { id: PUB_1, tenantId: T_A });
        seedAssetPublication(state, { id: PUB_B, tenantId: T_B });

        const result = await syncAssets({ tenantId: T_A }, { store });

        expect(result.upserted).toBe(2);
        const assetsA = await listAssets({ tenantId: T_A }, { store });
        const assetsB = await listAssets({ tenantId: T_B }, { store });
        expect(assetsA.map((a) => a.refId).sort()).toEqual(
            [CLIP_1, PUB_1].sort(),
        );
        expect(assetsB).toHaveLength(0);
    });
});

// ─── transitionAsset ──────────────────────────────────────────────────────────

describe('transitionAsset', () => {
    let store: AssetStore;
    let state: MemoryAssetState;

    beforeEach(() => {
        ({ store, state } = createMemoryAssetsStore());
    });

    const syncAndGet = async (refId: string) => {
        await syncAssets({ tenantId: T_A }, { store });
        const assets = await listAssets({ tenantId: T_A }, { store });
        return assets.find((a) => a.refId === refId)!;
    };

    it('approved sobre clip → write-through status=ready', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'pending_review',
        });
        const asset = await syncAndGet(CLIP_1);

        const updated = await transitionAsset(
            { tenantId: T_A, assetId: asset.id, to: 'approved' },
            { store },
        );

        expect(updated.status).toBe('approved');
        expect(state.clips[0].status).toBe('ready'); // la fuente lo ve
    });

    it('published sobre nota → write-through status=published', async () => {
        seedAssetPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            status: 'approved',
        });
        const asset = await syncAndGet(PUB_1);

        await transitionAsset(
            { tenantId: T_A, assetId: asset.id, to: 'published' },
            { store },
        );

        expect(state.publications[0].status).toBe('published');
    });

    it('pending_review sobre clip generating → write-through pending_review', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'generating',
        });
        const asset = await syncAndGet(CLIP_1);

        await transitionAsset(
            { tenantId: T_A, assetId: asset.id, to: 'pending_review' },
            { store },
        );

        expect(state.clips[0].status).toBe('pending_review');
    });

    it('archived sólo toca el asset — la fuente NO cambia (sin legacy)', async () => {
        seedAssetPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            status: 'approved',
        });
        const asset = await syncAndGet(PUB_1);

        const updated = await transitionAsset(
            { tenantId: T_A, assetId: asset.id, to: 'archived' },
            { store },
        );

        expect(updated.status).toBe('archived');
        // NO es 'rejected': archived es un concepto del ledger.
        expect(state.publications[0].status).toBe('approved');
    });

    it('flyer: transiciona sin write-through (su ref_id no es una fila)', async () => {
        seedAssetPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            status: 'pending_review',
            quoteFlyerPaths: ['f0.png'],
        });
        await syncAssets({ tenantId: T_A }, { store });
        const assets = await listAssets({ tenantId: T_A }, { store });
        const flyer = assets.find((a) => a.kind === 'flyer')!;

        const updated = await transitionAsset(
            { tenantId: T_A, assetId: flyer.id, to: 'approved' },
            { store },
        );

        expect(updated.status).toBe('approved');
        // La publicación madre no se tocó (el ref del flyer no es su id).
        expect(state.publications[0].status).toBe('pending_review');
    });

    it('invalid_transition: draft → published directo NO', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'generating',
        });
        const asset = await syncAndGet(CLIP_1);

        await expect(
            transitionAsset(
                { tenantId: T_A, assetId: asset.id, to: 'published' },
                { store },
            ),
        ).rejects.toMatchObject({
            statusCode: 409,
            code: 'invalid_transition',
        });
    });

    it('published es terminal: published → draft tira invalid_transition', async () => {
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'published',
        });
        const asset = await syncAndGet(CLIP_1);

        await expect(
            transitionAsset(
                { tenantId: T_A, assetId: asset.id, to: 'draft' },
                { store },
            ),
        ).rejects.toMatchObject({
            statusCode: 409,
            code: 'invalid_transition',
        });
    });

    it('asset_not_found (404) y asset ajeno también 404', async () => {
        seedAssetClip(state, { id: CLIP_1, tenantId: T_A });
        const asset = await syncAndGet(CLIP_1);

        await expect(
            transitionAsset(
                {
                    tenantId: T_A,
                    assetId: '00000000-0000-4000-8000-00000000ffff',
                    to: 'pending_review',
                },
                { store },
            ),
        ).rejects.toMatchObject({
            statusCode: 404,
            code: 'asset_not_found',
        });
        // El asset de T_A no se puede transicionar desde T_B.
        await expect(
            transitionAsset(
                { tenantId: T_B, assetId: asset.id, to: 'pending_review' },
                { store },
            ),
        ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('invalid_state: `to` fuera de los estados canónicos → 422', async () => {
        seedAssetClip(state, { id: CLIP_1, tenantId: T_A });
        const asset = await syncAndGet(CLIP_1);

        await expect(
            transitionAsset(
                { tenantId: T_A, assetId: asset.id, to: 'ready' },
                { store },
            ),
        ).rejects.toMatchObject({
            statusCode: 422,
            code: 'invalid_state',
        });
    });
});

// ─── Rutas HTTP (app efímera) ─────────────────────────────────────────────────

describe('API /api/assets', () => {
    let server: Server;
    let baseUrl: string;
    let state: MemoryAssetState;

    const authHeaders = (tenant?: string) =>
        tenant ? { 'x-test-tenant': tenant } : {};
    const getJson = (path: string, tenant?: string) =>
        fetch(`${baseUrl}${path}`, { headers: authHeaders(tenant) });
    const postJson = (path: string, body: unknown, tenant?: string) =>
        fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...authHeaders(tenant),
            },
            body: JSON.stringify(body),
        });

    beforeEach(async () => {
        const mem = createMemoryAssetsStore();
        state = mem.state;
        seedAssetClip(state, {
            id: CLIP_1,
            tenantId: T_A,
            status: 'pending_review',
            transmissionId: TX_1,
        });
        seedAssetClip(state, {
            id: CLIP_2,
            tenantId: T_A,
            status: 'ready',
            transmissionId: TX_2,
        });
        seedAssetClip(state, {
            id: 'clip-b1',
            tenantId: T_B,
        });
        seedAssetPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            status: 'approved',
            quoteFlyerPaths: ['f0.png', 'f1.png'],
        });
        seedAssetPublication(state, { id: PUB_B, tenantId: T_B });

        assetsRouteDeps.store = mem.store;

        const app = express();
        app.use(express.json());
        app.use('/api/assets', assetsRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        assetsRouteDeps.store = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sin autenticación → 401 en los tres endpoints', async () => {
        expect((await getJson('/api/assets')).status).toBe(401);
        expect((await postJson('/api/assets/sync', {})).status).toBe(401);
        expect(
            (await postJson(`/api/assets/${CLIP_1}/transition`, {})).status,
        ).toBe(401);
    });

    it('POST /sync → 200 {upserted, byKind} e idempotente', async () => {
        const res = await postJson('/api/assets/sync', {}, T_A);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.upserted).toBe(5); // 2 clips + 1 nota + 2 flyers
        expect(json.byKind).toEqual({
            clip: 2,
            note: 1,
            flyer: 2,
            post: 0,
        });
        // Segunda corrida: mismos counts, sin duplicar.
        const res2 = await postJson('/api/assets/sync', {}, T_A);
        expect((await res2.json()).upserted).toBe(5);
        const list = await (await getJson('/api/assets', T_A)).json();
        expect(list.assets).toHaveLength(5);
    });

    it('POST /sync con transmissionId filtra los clips', async () => {
        const res = await postJson(
            '/api/assets/sync',
            { transmissionId: TX_1 },
            T_A,
        );
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.byKind.clip).toBe(1);
        expect(json.byKind.note).toBe(1);
    });

    it('POST /sync con transmissionId mal formado → 400', async () => {
        const res = await postJson(
            '/api/assets/sync',
            { transmissionId: 'no-es-uuid' },
            T_A,
        );
        expect(res.status).toBe(400);
    });

    it('GET / lista sólo los assets del tenant y filtra por kind/status', async () => {
        await postJson('/api/assets/sync', {}, T_A);

        const all = await (await getJson('/api/assets', T_A)).json();
        // Los clips/pubs de T_B existen pero NO se sincronizaron ni se ven.
        expect(all.assets).toHaveLength(5);
        expect(
            all.assets.every((a: { tenantId: string }) => a.tenantId === T_A),
        ).toBe(true);

        const flyers = await (
            await getJson('/api/assets?kind=flyer', T_A)
        ).json();
        expect(flyers.assets).toHaveLength(2);
        expect(
            flyers.assets.every((a: { kind: string }) => a.kind === 'flyer'),
        ).toBe(true);

        const approved = await (
            await getJson('/api/assets?status=approved', T_A)
        ).json();
        // clip ready→approved, nota approved→approved, flyers heredan.
        expect(approved.assets).toHaveLength(4);
        expect(
            approved.assets.every(
                (a: { status: string }) => a.status === 'approved',
            ),
        ).toBe(true);

        const byTx = await (
            await getJson(`/api/assets?transmissionId=${TX_1}`, T_A)
        ).json();
        expect(byTx.assets).toHaveLength(1);
        expect(byTx.assets[0].refId).toBe(CLIP_1);
    });

    it('GET / con filtros inválidos → 400', async () => {
        for (const q of [
            '?kind=video',
            '?status=listo',
            '?transmissionId=xx',
        ]) {
            expect((await getJson(`/api/assets${q}`, T_A)).status).toBe(400);
        }
    });

    it('GET / pagina el resultado y valida programId/paginacion', async () => {
        await postJson('/api/assets/sync', {}, T_A);
        const paged = await (await getJson('/api/assets?page=1&pageSize=2', T_A)).json();
        expect(paged.assets).toHaveLength(2);
        expect(paged.total).toBe(5);
        expect(paged.page).toBe(1);
        expect(paged.pageSize).toBe(2);

        for (const q of ['?programId=ajeno', '?page=0', '?pageSize=101']) {
            expect((await getJson(`/api/assets${q}`, T_A)).status).toBe(400);
        }
    });

    it('POST /:id/transition → 200 con asset actualizado + write-through', async () => {
        await postJson('/api/assets/sync', {}, T_A);
        const list = await (await getJson('/api/assets', T_A)).json();
        const clipAsset = list.assets.find(
            (a: { refId: string }) => a.refId === CLIP_1,
        );

        const res = await postJson(
            `/api/assets/${clipAsset.id}/transition`,
            { to: 'approved' },
            T_A,
        );
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.asset.status).toBe('approved');
        // Write-through: el clip legacy quedó 'ready'.
        expect(state.clips.find((c) => c.id === CLIP_1)!.status).toBe(
            'ready',
        );
    });

    it('POST /:id/transition → 409 invalid_transition / 404 / 422 / 400', async () => {
        await postJson('/api/assets/sync', {}, T_A);
        const list = await (await getJson('/api/assets', T_A)).json();
        const pending = list.assets.find(
            (a: { refId: string }) => a.refId === CLIP_1,
        );
        const published = list.assets.find(
            (a: { refId: string; status: string }) =>
                a.refId === PUB_1 && a.status === 'approved',
        );

        // 409: pending_review → published no es arista.
        const bad = await postJson(
            `/api/assets/${pending.id}/transition`,
            { to: 'published' },
            T_A,
        );
        expect(bad.status).toBe(409);
        expect((await bad.json()).code).toBe('invalid_transition');

        // 404: asset inexistente.
        const missing = await postJson(
            '/api/assets/00000000-0000-4000-8000-00000000ffff/transition',
            { to: 'approved' },
            T_A,
        );
        expect(missing.status).toBe(404);
        expect((await missing.json()).code).toBe('asset_not_found');

        // 404: asset ajeno (sin leak).
        const foreign = await postJson(
            `/api/assets/${published.id}/transition`,
            { to: 'published' },
            T_B,
        );
        expect(foreign.status).toBe(404);

        // 422: estado canónico inexistente.
        const badState = await postJson(
            `/api/assets/${pending.id}/transition`,
            { to: 'ready' },
            T_A,
        );
        expect(badState.status).toBe(422);
        expect((await badState.json()).code).toBe('invalid_state');

        // 400: id no-uuid y body sin `to`.
        expect(
            (
                await postJson(
                    '/api/assets/no-uuid/transition',
                    { to: 'approved' },
                    T_A,
                )
            ).status,
        ).toBe(400);
        expect(
            (
                await postJson(
                    `/api/assets/${pending.id}/transition`,
                    {},
                    T_A,
                )
            ).status,
        ).toBe(400);
    });
});
