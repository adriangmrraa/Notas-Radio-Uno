/**
 * Tests del slice PG-07 — canal de publicación por tenant (migración
 * gradual legacy → Zernio sin regresiones):
 *
 *   - `publishChannelService`: modo persistido en `settings`
 *     (default efectivo 'hybrid'), resolución por plataforma
 *     (`createChannelPlan` puro + `planPublishChannels` con store),
 *     marca legacy-only explícita en `business_assets.metadata`.
 *   - `enqueueForApproval`: partición Zernio/legacy según el plan (en
 *     vez del binario "hay conexión → Zernio" de PG-05) + forceLegacy.
 *   - Rutas `/api/publish-channels` (GET/PUT modo, PUT legacy-only) y el
 *     approve de `review.ts` integrado con el plan.
 *
 * Casos obligatorios del brief:
 *   (a) tenant sin config conserva el comportamiento legacy (cero regresión).
 *   (b) modo zernio: plataformas nuevas por Zernio; Meta/Twitter legacy
 *       sólo bajo demanda explícita.
 *   (c) modo legacy con portfolio legacy → canal directo.
 *   (d) híbrido: conectadas por Zernio, no migradas por el canal directo.
 *   (e) plataforma nueva sin conexión Zernio → 'none' con motivo claro.
 *   (f) aislamiento entre tenants.
 *   (g) GET /api/publish-channels refleja modo y estado real.
 *
 * Deterministas: stores en memoria (settings + business_assets + jobs),
 * sin DB real ni red (db mockeado como en publishApprove.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial del módulo DB (importarlo crea un Pool Neon) ───────────────
vi.mock('../src/server/db/index.js', async (io) => ({
    ...(await io()),
    db: {},
}));

// ─── Mock parcial de auth (mismo contrato que publishApprove.test.ts) ────────
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

// ─── Mocks de módulo para las rutas de review ────────────────────────────────
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
    auditFromRequest: vi.fn(async () => undefined),
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
    auditFromRequest: mocks.auditFromRequest,
}));
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

import {
    createChannelPlan,
    getPublishChannelMode,
    getPublishChannelStatus,
    planPublishChannels,
    resolvePublishChannels,
    setAssetLegacyOnly,
    setPublishChannelMode,
    isLegacyOnlyAsset,
    PUBLISH_CHANNEL_MODE_KEY,
    type PublishChannelDeps,
    type PublishChannelSnapshot,
} from '../src/server/services/publishChannelService';
import {
    enqueueForApproval,
    type PublishJobDeps,
} from '../src/server/services/publishJobService';
import type { SocialConnectionRow } from '../src/server/services/socialConnectionsService';
import { registerReviewRoutes, reviewPublishDeps } from '../src/server/routes/review';
import {
    publishChannelsRouter,
    publishChannelsRouteDeps,
} from '../src/server/routes/publishChannels';
import { createMemoryPublishJobStore } from './helpers/memoryPublishJobStore';
import {
    createMemoryPublishChannelStore,
    makeChannelAsset,
} from './helpers/memoryPublishChannelStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const PUB_1 = '11111111-1111-4111-8111-111111111111';
const ASSET_FB = '44444444-4444-4444-8444-444444444401';
const ASSET_IG = '44444444-4444-4444-8444-444444444402';
const ASSET_TW = '44444444-4444-4444-8444-444444444403';
const CONN_IG = '55555555-5555-4555-8555-555555555551';
const T0 = new Date('2026-11-10T12:00:00.000Z');

const makeConn = (v: {
    id?: string;
    tenantId: string;
    platform: string;
    accountId: string;
    status?: string;
}): SocialConnectionRow => ({
    id: v.id ?? CONN_IG,
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

const snap = (
    over: Partial<PublishChannelSnapshot> = {},
): PublishChannelSnapshot => ({
    mode: 'hybrid',
    zernioPlatforms: new Set<string>(),
    legacyAssetsByPlatform: new Map(),
    envTwitterBot: false,
    ...over,
});

const depsWith = (
    over: Partial<PublishChannelDeps> & { store?: ReturnType<typeof createMemoryPublishChannelStore>['store'] },
): PublishChannelDeps => ({
    envTwitterBot: false,
    ...over,
});

// ─── Resolución pura — createChannelPlan ─────────────────────────────────────

describe('createChannelPlan — reglas de resolución por plataforma', () => {
    it('(e) plataforma nueva: con conexión → zernio; sin conexión → none con motivo', () => {
        const plan = createChannelPlan(
            snap({ zernioPlatforms: new Set(['tiktok']) }),
        );
        expect(plan.resolve('tiktok')).toMatchObject({
            channel: 'zernio',
            reason: null,
            hasLegacyPath: false,
        });
        const noConn = plan.resolve('youtube');
        expect(noConn.channel).toBe('none');
        expect(noConn.reason).toMatch(/Zernio/);
        expect(noConn.reason).toMatch(/Conexiones/);
        // Las plataformas nuevas NUNCA tienen camino legacy:
        expect(noConn.hasLegacyPath).toBe(false);
    });

    it('(b) modo zernio: Meta/Twitter con conexión → zernio; sin conexión → none', () => {
        const withConn = createChannelPlan(
            snap({ mode: 'zernio', zernioPlatforms: new Set(['instagram']) }),
        );
        expect(withConn.resolve('instagram').channel).toBe('zernio');
        const none = withConn.resolve('facebook');
        expect(none.channel).toBe('none');
        expect(none.reason).toMatch(/demanda explícita|Conexiones/);
    });

    it('(b) modo zernio + forceLegacy: Meta con camino → legacy; sin camino → none', () => {
        const plan = createChannelPlan(
            snap({
                mode: 'zernio',
                zernioPlatforms: new Set(['instagram']),
                legacyAssetsByPlatform: new Map([
                    [
                        'instagram',
                        [
                            makeChannelAsset({
                                id: ASSET_IG,
                                tenantId: T_A,
                                assetType: 'instagram_account',
                                externalId: 'ig_1',
                            }),
                        ],
                    ],
                ]),
            }),
            { forceLegacy: true },
        );
        expect(plan.resolve('instagram').channel).toBe('legacy');
        expect(plan.legacyPlatforms).toEqual(['instagram']);
        // Una red nueva no cambia con forceLegacy:
        expect(plan.resolve('tiktok').channel).toBe('none');
        // Meta sin camino legacy → none también en force:
        expect(plan.resolve('twitter').channel).toBe('none');
    });

    it('(c) modo legacy: Meta con asset → legacy; sin asset pero con conn → zernio', () => {
        const plan = createChannelPlan(
            snap({
                mode: 'legacy',
                zernioPlatforms: new Set(['instagram', 'tiktok']),
                legacyAssetsByPlatform: new Map([
                    [
                        'facebook',
                        [
                            makeChannelAsset({
                                id: ASSET_FB,
                                tenantId: T_A,
                                assetType: 'facebook_page',
                                externalId: 'fb_1',
                            }),
                        ],
                    ],
                ]),
            }),
        );
        expect(plan.resolve('facebook').channel).toBe('legacy');
        // En legacy, Meta sin asset pero con conexión migra a Zernio:
        expect(plan.resolve('instagram').channel).toBe('zernio');
        expect(plan.resolve('tiktok').channel).toBe('zernio');
        expect(plan.legacyPlatforms).toEqual(['facebook']);
    });

    it('(d) híbrido: conn sin marca → zernio; asset marcado → legacy; sin nada → none', () => {
        const plan = createChannelPlan(
            snap({
                zernioPlatforms: new Set(['instagram', 'facebook']),
                legacyAssetsByPlatform: new Map([
                    [
                        'facebook',
                        [
                            makeChannelAsset({
                                id: ASSET_FB,
                                tenantId: T_A,
                                assetType: 'facebook_page',
                                externalId: 'fb_1',
                                metadata: { legacyOnly: true },
                            }),
                        ],
                    ],
                ]),
            }),
        );
        // Instagram: conn + sin assets → Zernio.
        expect(plan.resolve('instagram').channel).toBe('zernio');
        // Facebook: conn PERO el asset está marcado legacy-only → ancla.
        expect(plan.resolve('facebook').channel).toBe('legacy');
        // Twitter: sin conn ni camino → none.
        expect(plan.resolve('twitter').channel).toBe('none');
        expect(plan.legacyPlatforms).toEqual(['facebook']);
    });

    it('híbrido: el bot de Twitter por env cuenta como camino legacy', () => {
        const plan = createChannelPlan(snap({ envTwitterBot: true }));
        expect(plan.resolve('twitter').channel).toBe('legacy');
        expect(plan.legacyPlatforms).toEqual(['twitter']);
        // Facebook sin bot ni asset sigue en none:
        expect(plan.resolve('facebook').channel).toBe('none');
    });
});

// ─── Modo del tenant + store ─────────────────────────────────────────────────

describe('modo del tenant (settings + business_assets)', () => {
    it('(a) tenant sin config → modo efectivo híbrido (cero regresión)', async () => {
        const { store } = createMemoryPublishChannelStore();
        expect(await getPublishChannelMode(T_A, { store })).toBe('hybrid');
        // Un valor corrupto legado también cae al default:
        const { store: corrupted } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'modo-viejo' } },
        });
        expect(await getPublishChannelMode(T_A, { store: corrupted })).toBe('hybrid');
    });

    it('set/get modo por tenant; valor inválido → 400', async () => {
        const { store, state } = createMemoryPublishChannelStore();
        await setPublishChannelMode(T_A, 'zernio', { store });
        expect(state.settings.get(T_A)?.get(PUBLISH_CHANNEL_MODE_KEY)).toBe('zernio');
        expect(await getPublishChannelMode(T_A, { store })).toBe('zernio');
        await expect(
            // @ts-expect-error — fuerza el runtime guard
            setPublishChannelMode(T_A, 'nope', { store }),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_channel_mode' });
    });

    it('(f) aislamiento: el modo y los assets de un tenant no afectan a otro', async () => {
        const { store } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'zernio' } },
            assets: [
                makeChannelAsset({
                    id: ASSET_FB,
                    tenantId: T_B, // asset AJENO — no cuenta para A
                    assetType: 'facebook_page',
                    externalId: 'fb_b',
                }),
            ],
        });
        expect(await getPublishChannelMode(T_A, { store })).toBe('zernio');
        expect(await getPublishChannelMode(T_B, { store })).toBe('hybrid');
        // El asset de T_B no le da camino legacy a T_A:
        const statusA = await getPublishChannelStatus(
            T_A,
            depsWith({ store, listConnections: async () => [] }),
        );
        expect(
            statusA.platforms.find((p) => p.platform === 'facebook')?.legacyAssets,
        ).toEqual([]);
    });

    it('legacy-only: marca explícita; asset ajeno → 404; tipo no legacy → 400', async () => {
        const { store, state } = createMemoryPublishChannelStore({
            assets: [
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                }),
                makeChannelAsset({
                    id: 'ad-account-1',
                    tenantId: T_A,
                    assetType: 'ad_account',
                    externalId: 'act_1',
                }),
            ],
        });
        const marked = await setAssetLegacyOnly(T_A, ASSET_IG, true, { store });
        expect(isLegacyOnlyAsset(marked)).toBe(true);
        expect(state.assets.find((a) => a.id === ASSET_IG)?.metadata.legacyOnly).toBe(true);
        // Desmarcar:
        const unmarked = await setAssetLegacyOnly(T_A, ASSET_IG, false, { store });
        expect(isLegacyOnlyAsset(unmarked)).toBe(false);
        // Aislamiento — el mismo id en otro tenant no existe:
        await expect(
            setAssetLegacyOnly(T_B, ASSET_IG, true, { store }),
        ).rejects.toMatchObject({ statusCode: 404, code: 'asset_not_found' });
        // Un asset que no es un canal legacy no se marca:
        await expect(
            setAssetLegacyOnly(T_A, 'ad-account-1', true, { store }),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_legacy_asset' });
    });

    it('resolvePublishChannels: la firma del brief — {tenantId, platform} → canal', async () => {
        const { store } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'zernio' } },
        });
        const deps = depsWith({
            store,
            listConnections: async () => [
                makeConn({ tenantId: T_A, platform: 'tiktok', accountId: 'z1' }),
            ],
        });
        expect(
            (await resolvePublishChannels({ tenantId: T_A, platform: 'tiktok' }, deps)).channel,
        ).toBe('zernio');
        expect(
            (await resolvePublishChannels({ tenantId: T_A, platform: 'youtube' }, deps)).channel,
        ).toBe('none');
    });
});

// ─── enqueueForApproval — partición por canal ────────────────────────────────

const channelDeps = (
    channelStore: ReturnType<typeof createMemoryPublishChannelStore>['store'],
    extra: Partial<PublishJobDeps> = {},
): PublishJobDeps => ({
    channelStore,
    envTwitterBot: false,
    getMentionSource: async () => null,
    listMentionPersons: async () => [],
    ...extra,
});

describe('enqueueForApproval — el plan de canales decide el camino', () => {
    it('(a) tenant sin config + sin conexiones → usedZernio:false, tramo legacy completo', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const { store: chStore } = createMemoryPublishChannelStore();
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_1, content: 'Nota' },
            channelDeps(chStore, {
                store,
                listConnections: async () => [],
                listAutoPublishConfigs: async () => [],
            }),
        );
        expect(result.usedZernio).toBe(false);
        expect(result.channelMode).toBe('hybrid');
        expect(result.jobs).toHaveLength(0);
        // Sin assets legacy → ninguna plataforma resuelve 'legacy' → la
        // ruta corre el publishToChannels completo de siempre.
        expect(result.legacyPlatforms).toEqual([]);
    });

    it('(b) modo zernio: red nueva conectada → job; Meta sin conn → skipped', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const { store: chStore } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'zernio' } },
            assets: [
                makeChannelAsset({
                    id: ASSET_FB,
                    tenantId: T_A,
                    assetType: 'facebook_page',
                    externalId: 'fb_1',
                }),
            ],
        });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_1, content: 'Nota' },
            channelDeps(chStore, {
                store,
                listConnections: async () => [
                    makeConn({ tenantId: T_A, platform: 'tiktok', accountId: 'z1' }),
                ],
                listAutoPublishConfigs: async () => [],
            }),
        );
        expect(result.usedZernio).toBe(true);
        expect(result.channelMode).toBe('zernio');
        expect(result.jobs).toHaveLength(1);
        expect(state.jobs[0].platform).toBe('tiktok');
        // Facebook tiene camino legacy pero el modo zernio no lo usa por
        // defecto → queda en skipped con motivo, NO en legacyPlatforms.
        expect(result.legacyPlatforms).toEqual([]);
        expect(result.skipped).toEqual([
            expect.objectContaining({ platform: 'facebook' }),
        ]);
    });

    it('(b) modo zernio + forceLegacy → Meta con camino va por el canal directo', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const { store: chStore } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'zernio' } },
            assets: [
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                }),
            ],
        });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_1, content: 'Nota', forceLegacy: true },
            channelDeps(chStore, {
                store,
                listConnections: async () => [
                    makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'z1' }),
                ],
                listAutoPublishConfigs: async () => [],
            }),
        );
        // La conexión IG queda anulada por forceLegacy → nada por Zernio.
        expect(result.usedZernio).toBe(false);
        expect(result.forceLegacy).toBe(true);
        expect(result.legacyPlatforms).toEqual(['instagram']);
        expect(state.jobs).toHaveLength(0);
    });

    it('(c) modo legacy + portfolio legacy → Meta/Twitter por el canal directo', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const { store: chStore } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'legacy' } },
            assets: [
                makeChannelAsset({
                    id: ASSET_FB,
                    tenantId: T_A,
                    assetType: 'facebook_page',
                    externalId: 'fb_1',
                }),
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                }),
            ],
        });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_1, content: 'Nota' },
            channelDeps(chStore, {
                store,
                // Conexión de una red NUEVA — en modo legacy también sale por Zernio.
                listConnections: async () => [
                    makeConn({ tenantId: T_A, platform: 'tiktok', accountId: 'z1' }),
                ],
                listAutoPublishConfigs: async () => [],
            }),
        );
        expect(result.usedZernio).toBe(true); // tiktok → job
        expect(state.jobs).toHaveLength(1);
        expect(state.jobs[0].platform).toBe('tiktok');
        expect(result.legacyPlatforms).toEqual(
            expect.arrayContaining(['facebook', 'instagram']),
        );
    });

    it('(d) híbrido: conectada → zernio; asset no migrado → canal directo', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const { store: chStore } = createMemoryPublishChannelStore({
            // Sin fila en settings → híbrido efectivo.
            assets: [
                makeChannelAsset({
                    id: ASSET_TW,
                    tenantId: T_A,
                    assetType: 'twitter_account',
                    externalId: 'tw_1',
                }),
            ],
        });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_1, content: 'Nota' },
            channelDeps(chStore, {
                store,
                listConnections: async () => [
                    makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'z1' }),
                ],
                listAutoPublishConfigs: async () => [],
            }),
        );
        expect(result.usedZernio).toBe(true);
        expect(result.channelMode).toBe('hybrid');
        expect(state.jobs).toHaveLength(1);
        expect(state.jobs[0].platform).toBe('instagram');
        expect(result.legacyPlatforms).toEqual(['twitter']);
    });

    it('(d) híbrido: asset marcado legacy-only anula la conexión Zernio de la red', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const { store: chStore } = createMemoryPublishChannelStore({
            assets: [
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                    metadata: { legacyOnly: true },
                }),
            ],
        });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_1, content: 'Nota' },
            channelDeps(chStore, {
                store,
                listConnections: async () => [
                    makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'z1' }),
                ],
                listAutoPublishConfigs: async () => [],
            }),
        );
        // Hay conexión IG pero la marca ancla la plataforma al directo →
        // ninguna conn resuelve zernio → la ruta corre el tramo legacy.
        expect(result.usedZernio).toBe(false);
        expect(result.legacyPlatforms).toEqual(['instagram']);
        expect(state.jobs).toHaveLength(0);
    });
});

// ─── Rutas — /api/publish-channels + approve integrado ───────────────────────

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
    mocks.auditFromRequest.mockClear();

    const app = express();
    app.use(express.json());
    registerReviewRoutes(app);
    app.use('/api/publish-channels', publishChannelsRouter);
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
    reviewPublishDeps.enqueueForApproval = undefined;
    reviewPublishDeps.publishJobDeps = undefined;
    publishChannelsRouteDeps.store = undefined;
    publishChannelsRouteDeps.listConnections = undefined;
    publishChannelsRouteDeps.envTwitterBot = undefined;
    await new Promise((r) => server?.close(() => r(null)));
    server = null;
});

describe('GET/PUT /api/publish-channels — modo + estado de migración', () => {
    it('(g) GET refleja el modo real y el canal por plataforma', async () => {
        const { store } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'zernio' } },
            assets: [
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                }),
            ],
        });
        publishChannelsRouteDeps.store = store;
        publishChannelsRouteDeps.envTwitterBot = false;
        publishChannelsRouteDeps.listConnections = async () => [
            makeConn({ tenantId: T_A, platform: 'tiktok', accountId: 'z1' }),
        ];

        const res = await api('/api/publish-channels');
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            mode: string;
            defaultMode: string;
            configured: boolean;
            platforms: Array<{
                platform: string;
                channel: string;
                reason: string | null;
                pendingMigration: boolean;
                legacyAssets: Array<{ id: string; legacyOnly: boolean }>;
            }>;
        };
        expect(body.mode).toBe('zernio');
        expect(body.defaultMode).toBe('hybrid');
        expect(body.configured).toBe(true);
        const byPlatform = new Map(body.platforms.map((p) => [p.platform, p]));
        expect(byPlatform.get('tiktok')?.channel).toBe('zernio');
        // IG: tiene asset legacy pero modo zernio sin conn → none + motivo.
        const ig = byPlatform.get('instagram')!;
        expect(ig.channel).toBe('none');
        expect(ig.reason).toMatch(/Zernio|demanda/);
        expect(ig.legacyAssets).toHaveLength(1);
        // YouTube: red nueva sin conn → none + "conectá en Conexiones".
        expect(byPlatform.get('youtube')?.reason).toMatch(/Conexiones/);
    });

    it('PUT modo: persiste + audita; modo inválido → 400; aislamiento de lectura', async () => {
        const { store } = createMemoryPublishChannelStore();
        publishChannelsRouteDeps.store = store;
        publishChannelsRouteDeps.envTwitterBot = false;
        publishChannelsRouteDeps.listConnections = async () => [];

        const bad = await api('/api/publish-channels', {
            method: 'PUT',
            body: JSON.stringify({ mode: 'todo-zernio' }),
        });
        expect(bad.status).toBe(400);
        expect((await bad.json() as { code: string }).code).toBe('invalid_channel_mode');

        const ok = await api('/api/publish-channels', {
            method: 'PUT',
            body: JSON.stringify({ mode: 'legacy' }),
        });
        expect(ok.status).toBe(200);
        expect(((await ok.json()) as { mode: string }).mode).toBe('legacy');
        // Auditado con la acción nueva:
        expect(mocks.auditFromRequest).toHaveBeenCalledWith(
            expect.anything(),
            'publish_channel.mode_changed',
            expect.objectContaining({ metadata: { mode: 'legacy' } }),
        );
        // El tenant B sigue viendo el default:
        const resB = await api('/api/publish-channels', undefined, T_B);
        expect(((await resB.json()) as { mode: string }).mode).toBe('hybrid');
    });

    it('PUT legacy-only: marca el asset del tenant; ajeno → 404; sin auth → 401', async () => {
        const { store, state } = createMemoryPublishChannelStore({
            assets: [
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                }),
            ],
        });
        publishChannelsRouteDeps.store = store;

        const res = await api(`/api/publish-channels/assets/${ASSET_IG}/legacy-only`, {
            method: 'PUT',
            body: JSON.stringify({ legacyOnly: true }),
        });
        expect(res.status).toBe(200);
        expect(state.assets[0].metadata.legacyOnly).toBe(true);
        expect(mocks.auditFromRequest).toHaveBeenCalledWith(
            expect.anything(),
            'publish_channel.legacy_only_changed',
            expect.objectContaining({ entityId: ASSET_IG }),
        );

        const foreign = await api(`/api/publish-channels/assets/${ASSET_IG}/legacy-only`, {
            method: 'PUT',
            body: JSON.stringify({ legacyOnly: false }),
        }, T_B);
        expect(foreign.status).toBe(404);

        const unauth = await fetch(`${baseUrl}/api/publish-channels`);
        expect(unauth.status).toBe(401);
    });
});

describe('approve integrado con el plan de canales', () => {
    const jobDeps = (
        chStore: ReturnType<typeof createMemoryPublishChannelStore>['store'],
        conns: SocialConnectionRow[],
    ): PublishJobDeps => ({
        store: createMemoryPublishJobStore({ now: () => T0 }).store,
        channelStore: chStore,
        envTwitterBot: false,
        listConnections: async () => conns,
        listAutoPublishConfigs: async () => [],
        getMentionSource: async () => null,
        listMentionPersons: async () => [],
    });

    it('(a) tenant sin config ni conexiones → publishToChannels completo (como siempre)', async () => {
        seedPub(PUB_1);
        const { store: chStore } = createMemoryPublishChannelStore();
        reviewPublishDeps.publishJobDeps = jobDeps(chStore, []);

        const res = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { publish: string; channelMode: string };
        expect(body.publish).toBe('legacy');
        expect(body.channelMode).toBe('hybrid');
        // La llamada va SIN filtro — la de siempre:
        expect(mocks.publishToChannels).toHaveBeenCalledWith(
            expect.objectContaining({ id: PUB_1, tenantId: T_A }),
        );
        expect(mocks.publishToChannels.mock.calls[0][0].legacyPlatforms).toBeUndefined();
    });

    it('(d) híbrido: job Zernio + tramo legacy filtrado en el mismo approve', async () => {
        seedPub(PUB_1);
        const { store: chStore } = createMemoryPublishChannelStore({
            assets: [
                makeChannelAsset({
                    id: ASSET_TW,
                    tenantId: T_A,
                    assetType: 'twitter_account',
                    externalId: 'tw_1',
                }),
            ],
        });
        const { store: jobStore, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            ...jobDeps(chStore, [
                makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'z1' }),
            ]),
            store: jobStore,
        };

        const res = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            publish: string;
            legacyPlatforms: string[];
        };
        expect(body.publish).toBe('mixed');
        expect(body.legacyPlatforms).toEqual(['twitter']);
        expect(state.jobs).toHaveLength(1);
        expect(state.jobs[0].platform).toBe('instagram');
        // publishToChannels corrió filtrado al twitter_account:
        expect(mocks.publishToChannels).toHaveBeenCalledWith(
            expect.objectContaining({ legacyPlatforms: ['twitter'] }),
        );
        // Queda 'approved' (jobs en curso) — no 'published'.
        expect(mocks.updatePublicationStatus).toHaveBeenLastCalledWith(PUB_1, T_A, 'approved');
    });

    it('(b) modo zernio sin forceLegacy: no hay tramo legacy (asset informado en skipped)', async () => {
        seedPub(PUB_1);
        const { store: chStore } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'zernio' } },
            assets: [
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                }),
            ],
        });
        reviewPublishDeps.publishJobDeps = jobDeps(chStore, [
            makeConn({ tenantId: T_A, platform: 'tiktok', accountId: 'z1' }),
        ]);

        const res = await api(`/api/review/${PUB_1}/approve`, { method: 'POST' });
        const body = (await res.json()) as {
            publish: string;
            skipped: Array<{ platform: string; reason: string }>;
        };
        expect(body.publish).toBe('zernio');
        expect(body.skipped).toEqual([
            expect.objectContaining({ platform: 'instagram' }),
        ]);
        // El canal directo NO corrió — en zernio la demanda es explícita.
        expect(mocks.publishToChannels).not.toHaveBeenCalled();
    });

    it('(b) modo zernio + forceLegacy en el body → publica por el canal directo', async () => {
        seedPub(PUB_1);
        const { store: chStore } = createMemoryPublishChannelStore({
            settings: { [T_A]: { [PUBLISH_CHANNEL_MODE_KEY]: 'zernio' } },
            assets: [
                makeChannelAsset({
                    id: ASSET_IG,
                    tenantId: T_A,
                    assetType: 'instagram_account',
                    externalId: 'ig_1',
                }),
            ],
        });
        const { store: jobStore, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = {
            ...jobDeps(chStore, [
                makeConn({ tenantId: T_A, platform: 'instagram', accountId: 'z1' }),
            ]),
            store: jobStore,
        };

        const res = await api(`/api/review/${PUB_1}/approve`, {
            method: 'POST',
            body: JSON.stringify({ forceLegacy: true }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { publish: string; legacyPlatforms: string[] };
        expect(body.publish).toBe('legacy');
        expect(body.legacyPlatforms).toEqual(['instagram']);
        expect(mocks.publishToChannels).toHaveBeenCalledWith(
            expect.objectContaining({ legacyPlatforms: ['instagram'] }),
        );
        // La conexión IG no generó job — el force la anuló.
        expect(state.jobs).toHaveLength(0);
    });

    it('forceLegacy mal tipado → 400 (validación de body)', async () => {
        seedPub(PUB_1);
        reviewPublishDeps.publishJobDeps = jobDeps(
            createMemoryPublishChannelStore().store,
            [],
        );
        const res = await api(`/api/review/${PUB_1}/approve`, {
            method: 'POST',
            body: JSON.stringify({ forceLegacy: 'si' }),
        });
        expect(res.status).toBe(400);
    });
});
