/**
 * Tests del slice PG-04: `socialConnectionsService` + `zernioService` +
 * rutas `/api/social-connections`.
 *
 * Deterministas, mismo estilo que autoPublish/assets: store en memoria que
 * replica el ON CONFLICT keyed por (tenant_id, platform, account_id), un
 * `ZernioApi` falso que graba las llamadas (NUNCA red real) y deps
 * inyectables (plan, branding, secretos). App express efímera para las
 * rutas con auth mockeado (x-test-tenant); el callback va SIN auth porque
 * la credencial es el state HMAC — como en producción.
 *
 * Cobertura del brief:
 *   (1)  conectar sin API key ⇒ error honesto 503 zernio_not_configured
 *   (2)  state inválido/expirado ⇒ no escribe nada
 *   (3)  state de otro tenant / profileId ajeno ⇒ no escribe nada
 *   (4)  upsert idempotente por (tenant, platform, account_id)
 *   (5)  aislamiento tenant: listar/borrar no toca filas ajenas
 *   (6)  authUrl contiene welcome=true
 *   (7)  authUrl contiene el profileId del tenant
 *   (8)  plan maxConnectedPlatforms ⇒ 403 max_connected_platforms
 *   (9)  la API key nunca aparece en logs
 *   (10) la API key nunca aparece en respuestas
 *   + perfil Zernio: creación y recuperación tras 409
 *   + sync: upsert de remotas y marca 'disconnected' las ausentes
 *   + callback: redirect al frontend con éxito/error
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de auth (mismo contrato que autoPublish.test.ts) ────────────
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
    completeSocialConnect,
    disconnectSocialConnection,
    ensureProfileForTenant,
    isZernioPlatform,
    listSocialConnections,
    signConnectState,
    startSocialConnect,
    syncSocialConnections,
    verifyConnectState,
    ZERNIO_PLATFORMS,
    type SocialConnectionsDeps,
} from '../src/server/services/socialConnectionsService';
import {
    createZernioApi,
    type ZernioApi,
    type ZernioConnectResult,
} from '../src/server/services/zernioService';
import {
    socialConnectionsRouter,
    socialConnectionsRouteDeps,
} from '../src/server/routes/socialConnections';
import {
    createMemorySocialConnectionsStore,
    seedTenant,
    type MemorySocialConnectionsState,
} from './helpers/memorySocialConnectionsStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const SECRET = 'test-state-secret';
const API_KEY = 'zrn_test_SUPERSECRET_987';

// ─── ZernioApi falso — graba llamadas, nunca toca la red ────────────────────

interface FakeZernio extends ZernioApi {
    calls: {
        createProfile: unknown[];
        findProfileByExternalId: unknown[];
        getConnectUrl: Array<{
            profileId: string;
            platform: string;
            redirectUrl: string;
            welcome?: boolean;
            brandName?: string;
            logoUrl?: string;
        }>;
        listAccounts: string[];
        disconnectAccount: string[];
    };
    remoteAccounts: Array<{
        id: string;
        platform: string;
        username: string | null;
        displayName: string | null;
        profileId: string | null;
        enabled: boolean | null;
        status: 'connected' | 'disconnected';
    }>;
}

const createFakeZernio = (): FakeZernio => {
    let seq = 0;
    const fake: FakeZernio = {
        calls: {
            createProfile: [],
            findProfileByExternalId: [],
            getConnectUrl: [],
            listAccounts: [],
            disconnectAccount: [],
        },
        remoteAccounts: [],
        async findProfileByExternalId(externalId: string) {
            fake.calls.findProfileByExternalId.push(externalId);
            return null;
        },
        async createProfile(input: { name: string; externalId: string }) {
            fake.calls.createProfile.push(input);
            return { id: `zprof_${++seq}`, name: input.name, externalId: input.externalId };
        },
        async getConnectUrl(input): Promise<ZernioConnectResult> {
            fake.calls.getConnectUrl.push(input);
            const url = new URL('https://zernio.com/connect');
            url.searchParams.set('profileId', input.profileId);
            url.searchParams.set('redirect_url', input.redirectUrl);
            if (input.welcome) url.searchParams.set('welcome', 'true');
            if (input.brandName) url.searchParams.set('brandName', input.brandName);
            if (input.logoUrl) url.searchParams.set('logoUrl', input.logoUrl);
            return { authUrl: url.toString() };
        },
        async listAccounts(profileId: string) {
            fake.calls.listAccounts.push(profileId);
            return fake.remoteAccounts;
        },
        async disconnectAccount(accountId: string) {
            fake.calls.disconnectAccount.push(accountId);
        },
    };
    return fake;
};

const makeDeps = (
    store: SocialConnectionsDeps['store'],
    zernio: ZernioApi,
    opts: { max?: number | null } = {},
): SocialConnectionsDeps => ({
    store,
    zernio,
    getPlan: async () => ({
        name: 'creator',
        maxConnectedPlatforms: opts.max === undefined ? null : opts.max,
    }),
    getBranding: async () => ({
        brandName: 'Radio Uno',
        logoUrl: 'https://cdn.test/logo.png',
    }),
    stateSecret: SECRET,
    apiPublicUrl: 'https://api.test',
    frontendUrl: 'https://app.test',
});

const seedStore = () => {
    const memory = createMemorySocialConnectionsStore();
    seedTenant(memory.state, { id: T_A, name: 'Radio Uno' });
    seedTenant(memory.state, { id: T_B, name: 'Radio Dos' });
    return memory;
};

// ─── State firmado ───────────────────────────────────────────────────────────

describe('state firmado — firma y verificación', () => {
    it('firma y verifica tenantId+platform; vence y detecta alteraciones', () => {
        const state = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET);
        expect(verifyConnectState(state, SECRET)).toEqual({ tenantId: T_A, platform: 'instagram' });
        // Secreto distinto / platform alterada / basura / expirado.
        expect(verifyConnectState(state, 'otro-secreto')).toBeNull();
        expect(verifyConnectState(state.replace('instagram', 'tiktok'), SECRET)).toBeNull();
        expect(verifyConnectState('basura.sin.forma', SECRET)).toBeNull();
        const expired = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET, 60, 1_000);
        expect(verifyConnectState(expired, SECRET, 1_061)).toBeNull();
        expect(verifyConnectState(expired, SECRET, 1_059)).not.toBeNull();
    });
});

// ─── Servicio: connect + callback + aislamiento ──────────────────────────────

describe('socialConnectionsService — connect/callback', () => {
    let state: MemorySocialConnectionsState;
    let zernio: FakeZernio;
    let deps: SocialConnectionsDeps;

    beforeEach(() => {
        const memory = seedStore();
        state = memory.state;
        zernio = createFakeZernio();
        deps = makeDeps(memory.store, zernio);
    });

    it('(1) sin API key ⇒ error honesto 503 y CERO llamadas a la red', async () => {
        const fetchFn = vi.fn();
        const noKey = createZernioApi({ apiKey: '', fetchFn: fetchFn as never });
        const memory = seedStore();
        await expect(
            startSocialConnect(T_A, 'instagram', makeDeps(memory.store, noKey)),
        ).rejects.toMatchObject({ statusCode: 503, code: 'zernio_not_configured' });
        expect(fetchFn).not.toHaveBeenCalled();
        expect(memory.state.connections).toHaveLength(0);
        expect(memory.state.zernioProfiles).toHaveLength(0);
    });

    it('(6)+(7) authUrl trae welcome=true, el profileId del tenant y la marca', async () => {
        const { authUrl, state: returnedState } = await startSocialConnect(T_A, 'instagram', deps);
        expect(authUrl).toContain('welcome=true');
        expect(authUrl).toContain('profileId=zprof_1');
        expect(authUrl).toContain('brandName=Radio+Uno');
        expect(authUrl).toContain('logoUrl=');
        // El redirect_url apunta al callback propio con el state embebido.
        const call = zernio.calls.getConnectUrl[0];
        expect(call.redirectUrl).toContain('/api/social-connections/callback?state=');
        expect(returnedState).toBeTruthy();
        // El perfil quedó persistido con externalId=tenantId.
        expect(state.zernioProfiles).toHaveLength(1);
        expect(state.zernioProfiles[0].profileId).toBe('zprof_1');
        expect(zernio.calls.createProfile[0]).toMatchObject({ externalId: T_A });
    });

    it('rechaza plataformas fuera del enum verificado', async () => {
        await expect(
            startSocialConnect(T_A, 'myspace', deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_platform' });
        expect(isZernioPlatform('instagram')).toBe(true);
        for (const p of ZERNIO_PLATFORMS) expect(isZernioPlatform(p)).toBe(true);
        expect(isZernioPlatform('myspace')).toBe(false);
    });

    it('(4) el callback hace upsert idempotente: re-conectar no duplica', async () => {
        await ensureProfileForTenant(T_A, deps);
        const stateParam = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET);
        const query = {
            state: stateParam,
            connected: 'instagram',
            profileId: 'zprof_1',
            accountId: 'zacc_1',
            username: 'radio.uno',
        };
        const first = await completeSocialConnect(query, deps);
        const second = await completeSocialConnect(query, deps);
        expect(second.connection.id).toBe(first.connection.id);
        const rows = await listSocialConnections(T_A, deps);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('connected');
        expect(rows[0].username).toBe('radio.uno');
    });

    it('(2) state inválido o expirado ⇒ 400 invalid_state y NADA escrito', async () => {
        await ensureProfileForTenant(T_A, deps);
        for (const bad of ['garbage', '', 'v1.otro.instagram.9999999999.firma']) {
            await expect(
                completeSocialConnect(
                    { state: bad, connected: 'instagram', profileId: 'zprof_1', accountId: 'zacc_1' },
                    deps,
                ),
            ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_state' });
        }
        // State firmado pero ya vencido.
        const expired = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET, -10);
        await expect(
            completeSocialConnect(
                { state: expired, connected: 'instagram', profileId: 'zprof_1', accountId: 'zacc_1' },
                deps,
            ),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_state' });
        expect(state.connections).toHaveLength(0);
    });

    it('(3) profileId ajeno al tenant del state ⇒ 403 y NADA escrito', async () => {
        await ensureProfileForTenant(T_A, deps); // zprof_1 es de T_A
        const stateParam = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET);
        await expect(
            completeSocialConnect(
                { state: stateParam, connected: 'instagram', profileId: 'zprof_DE_OTRO', accountId: 'zacc_1' },
                deps,
            ),
        ).rejects.toMatchObject({ statusCode: 403, code: 'profile_mismatch' });
        expect(state.connections).toHaveLength(0);
    });

    it('(3)+(5) el state ata el tenant: nada puede escribir en otro tenant', async () => {
        // T_A conecta; T_B conecta la MISMA account_id — no colisionan.
        await ensureProfileForTenant(T_A, deps);
        await ensureProfileForTenant(T_B, deps);
        for (const tenant of [T_A, T_B]) {
            const profileId = (await ensureProfileForTenant(tenant, deps)).profileId;
            const stateParam = signConnectState({ tenantId: tenant, platform: 'instagram' }, SECRET);
            await completeSocialConnect(
                { state: stateParam, connected: 'instagram', profileId, accountId: 'zacc_1', username: 'misma' },
                deps,
            );
        }
        const rowsA = await listSocialConnections(T_A, deps);
        const rowsB = await listSocialConnections(T_B, deps);
        expect(rowsA).toHaveLength(1);
        expect(rowsB).toHaveLength(1);
        expect(rowsA[0].tenantId).toBe(T_A);
        expect(rowsB[0].tenantId).toBe(T_B);
        // Borrar con el id ajeno ⇒ 404, la fila de A sigue.
        await expect(disconnectSocialConnection(T_B, rowsA[0].id, deps)).rejects.toMatchObject({
            statusCode: 404,
            code: 'connection_not_found',
        });
        expect(await listSocialConnections(T_A, deps)).toHaveLength(1);
        // El callback con state de A nunca toca a B aunque Zernio repita.
        const stateA = signConnectState({ tenantId: T_A, platform: 'tiktok' }, SECRET);
        const r = await completeSocialConnect(
            { state: stateA, connected: 'tiktok', profileId: 'zprof_1', accountId: 'zacc_9' },
            deps,
        );
        expect(r.connection.tenantId).toBe(T_A);
        expect(await listSocialConnections(T_B, deps)).toHaveLength(1);
    });

    it('callback sin connected/accountId ⇒ 400 y nada escrito', async () => {
        await ensureProfileForTenant(T_A, deps);
        const stateParam = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET);
        await expect(
            completeSocialConnect({ state: stateParam, profileId: 'zprof_1', accountId: 'zacc_1' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'connection_not_confirmed' });
        await expect(
            completeSocialConnect({ state: stateParam, connected: 'instagram', profileId: 'zprof_1' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'missing_account' });
        expect(state.connections).toHaveLength(0);
    });

    it('(8) plan maxConnectedPlatforms ⇒ 403 max_connected_platforms (servicio)', async () => {
        const memory = seedStore();
        const limited = makeDeps(memory.store, createFakeZernio(), { max: 1 });
        // Conecto instagram de verdad (start + callback) → cupo lleno 1/1.
        await startSocialConnect(T_A, 'instagram', limited);
        const stateParam = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET);
        await completeSocialConnect(
            { state: stateParam, connected: 'instagram', profileId: 'zprof_1', accountId: 'zacc_1' },
            limited,
        );
        await expect(startSocialConnect(T_A, 'youtube', limited)).rejects.toMatchObject({
            statusCode: 403,
            code: 'max_connected_platforms',
        });
        // Re-conectar la misma plataforma no suma — no se rechaza.
        await expect(startSocialConnect(T_A, 'instagram', limited)).resolves.toBeTruthy();
        // El callback también aplica el gate (el state no saltea el tope).
        const stateTiktok = signConnectState({ tenantId: T_A, platform: 'tiktok' }, SECRET);
        await expect(
            completeSocialConnect(
                { state: stateTiktok, connected: 'tiktok', profileId: 'zprof_1', accountId: 'zacc_2' },
                limited,
            ),
        ).rejects.toMatchObject({ statusCode: 403, code: 'max_connected_platforms' });
    });

    it('ensureProfileForTenant: 409 ⇒ recupera por externalId y persiste', async () => {
        const memory = seedStore();
        const recovering = createFakeZernio();
        let created = false;
        recovering.createProfile = async (input: { name: string; externalId: string }) => {
            recovering.calls.createProfile.push(input);
            if (!created) {
                created = true;
                const err = new Error('conflict') as Error & { statusCode?: number; code?: string };
                // Simula el AppError 409 del cliente HTTP.
                const { AppError } = await import('../src/server/lib/errors.js');
                throw new AppError('profile already exists', 409, 'profile_exists');
            }
            return { id: 'zprof_new', name: input.name, externalId: input.externalId };
        };
        recovering.findProfileByExternalId = async (externalId: string) => {
            recovering.calls.findProfileByExternalId.push(externalId);
            return { id: 'zprof_recovered', name: 'Radio Uno', externalId };
        };
        const profile = await ensureProfileForTenant(T_A, makeDeps(memory.store, recovering));
        expect(profile.profileId).toBe('zprof_recovered');
        expect(memory.state.zernioProfiles[0].profileId).toBe('zprof_recovered');
        // Idempotente: la segunda llamada usa la fila local, sin red.
        const again = await ensureProfileForTenant(T_A, makeDeps(memory.store, recovering));
        expect(again.profileId).toBe('zprof_recovered');
        expect(recovering.calls.findProfileByExternalId).toHaveLength(1);
    });
});

// ─── Sync + disconnect ───────────────────────────────────────────────────────

describe('socialConnectionsService — sync y disconnect', () => {
    it('sync: upsert de remotas, marca ausentes como disconnected', async () => {
        const memory = seedStore();
        const zernio = createFakeZernio();
        const deps = makeDeps(memory.store, zernio);
        await ensureProfileForTenant(T_A, deps);
        // Fila local previa que Zernio ya no reporta.
        await memory.store.upsertConnection({
            tenantId: T_A,
            platform: 'instagram',
            accountId: 'zacc_vieja',
            username: 'vieja',
            displayName: null,
            status: 'connected',
            zernioProfileId: 'zprof_1',
            lastSyncedAt: null,
        });
        zernio.remoteAccounts = [
            { id: 'zacc_1', platform: 'instagram', username: 'radio.uno', displayName: 'Radio Uno', profileId: 'zprof_1', enabled: true, status: 'connected' },
            { id: 'zacc_2', platform: 'tiktok', username: 'radiouno', displayName: null, profileId: 'zprof_1', enabled: true, status: 'connected' },
        ];
        const result = await syncSocialConnections(T_A, deps);
        expect(result.synced).toBe(2);
        expect(result.markedDisconnected).toBe(1);
        const rows = await listSocialConnections(T_A, deps);
        expect(rows).toHaveLength(3);
        const byAccount = new Map(rows.map((r) => [r.accountId, r]));
        expect(byAccount.get('zacc_vieja')?.status).toBe('disconnected');
        expect(byAccount.get('zacc_1')?.status).toBe('connected');
        expect(byAccount.get('zacc_2')?.platform).toBe('tiktok');
        // Re-sync: ya no marca nada (zacc_vieja ya estaba disconnected).
        const again = await syncSocialConnections(T_A, deps);
        expect(again.markedDisconnected).toBe(0);
        expect(await listSocialConnections(T_A, deps)).toHaveLength(3);
    });

    it('disconnect: llama a Zernio, borra local y propaga errores reales', async () => {
        const memory = seedStore();
        const zernio = createFakeZernio();
        const deps = makeDeps(memory.store, zernio);
        await ensureProfileForTenant(T_A, deps);
        const conn = await memory.store.upsertConnection({
            tenantId: T_A, platform: 'instagram', accountId: 'zacc_1',
            username: 'r', displayName: null, status: 'connected',
            zernioProfileId: 'zprof_1', lastSyncedAt: null,
        });
        await disconnectSocialConnection(T_A, conn.id, deps);
        expect(zernio.calls.disconnectAccount).toEqual(['zacc_1']);
        expect(await listSocialConnections(T_A, deps)).toHaveLength(0);

        // Error real de Zernio se propaga y NO borra la fila local.
        const { AppError } = await import('../src/server/lib/errors.js');
        const conn2 = await memory.store.upsertConnection({
            tenantId: T_A, platform: 'tiktok', accountId: 'zacc_2',
            username: null, displayName: null, status: 'connected',
            zernioProfileId: 'zprof_1', lastSyncedAt: null,
        });
        zernio.disconnectAccount = async () => {
            throw new AppError('upstream caído', 502, 'zernio_unavailable');
        };
        await expect(disconnectSocialConnection(T_A, conn2.id, deps)).rejects.toMatchObject({
            statusCode: 502,
        });
        expect(await listSocialConnections(T_A, deps)).toHaveLength(1);

        // 404/account_not_found = ya desconectada en Zernio ⇒ baja local ok.
        zernio.disconnectAccount = async () => {
            throw new AppError('account not found', 404, 'account_not_found');
        };
        await expect(disconnectSocialConnection(T_A, conn2.id, deps)).resolves.toBeUndefined();
        expect(await listSocialConnections(T_A, deps)).toHaveLength(0);
    });
});

// ─── Rutas ───────────────────────────────────────────────────────────────────

describe('socialConnections routes — /api/social-connections', () => {
    let server: Server;
    let baseUrl: string;
    let state: MemorySocialConnectionsState;
    let zernio: FakeZernio;

    const call = async (
        method: string,
        path: string,
        body?: unknown,
        tenant?: string,
    ) => {
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                'content-type': 'application/json',
                ...(tenant ? { 'x-test-tenant': tenant } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual', // el callback devuelve 302 — lo inspeccionamos
        });
        return res;
    };

    beforeEach(async () => {
        const memory = seedStore();
        state = memory.state;
        zernio = createFakeZernio();
        Object.assign(socialConnectionsRouteDeps, {
            store: memory.store,
            zernio,
            getPlan: async () => ({ name: 'creator', maxConnectedPlatforms: 1 }),
            getBranding: async () => ({ brandName: 'Radio Uno', logoUrl: 'https://cdn.test/logo.png' }),
            stateSecret: SECRET,
            apiPublicUrl: 'https://api.test',
            frontendUrl: 'https://app.test',
        });
        const app = express();
        app.use(express.json());
        app.use('/api/social-connections', socialConnectionsRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        Object.assign(socialConnectionsRouteDeps, {
            store: undefined,
            zernio: undefined,
            getPlan: undefined,
            getBranding: undefined,
            stateSecret: undefined,
            apiPublicUrl: undefined,
            frontendUrl: undefined,
        });
        vi.restoreAllMocks();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('401 sin auth en los endpoints protegidos', async () => {
        expect((await call('GET', '/api/social-connections')).status).toBe(401);
        expect((await call('POST', '/api/social-connections/connect', { platform: 'instagram' })).status).toBe(401);
        expect((await call('POST', '/api/social-connections/sync')).status).toBe(401);
        expect((await call('DELETE', '/api/social-connections/00000000-0000-4000-8000-000000000001')).status).toBe(401);
    });

    it('POST /connect devuelve authUrl+state; GET lista con plan', async () => {
        const res = await call('POST', '/api/social-connections/connect', { platform: 'instagram' }, T_A);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.authUrl).toContain('welcome=true');
        expect(json.authUrl).toContain('profileId=zprof_1');
        expect(json.state).toBeTruthy();

        const list = await call('GET', '/api/social-connections', undefined, T_A);
        expect(list.status).toBe(200);
        const body = await list.json();
        expect(body.connections).toEqual([]);
        expect(body.plan).toEqual({ maxPlatforms: 1, usedPlatforms: 0 });
        // Aislamiento: T_B no ve nada.
        const listB = await call('GET', '/api/social-connections', undefined, T_B);
        expect((await listB.json()).connections).toEqual([]);
    });

    it('(8) POST /connect: 403 max_connected_platforms al superar el cupo', async () => {
        // max=1: instagram llena el cupo (vía callback real del flujo).
        const connect = await call('POST', '/api/social-connections/connect', { platform: 'instagram' }, T_A);
        const { state: st } = await connect.json();
        const cb = await call(
            'GET',
            `/api/social-connections/callback?state=${encodeURIComponent(st)}&connected=instagram&profileId=zprof_1&accountId=zacc_1&username=radio.uno`,
        );
        expect(cb.status).toBe(302);
        expect(cb.headers.get('location')).toContain('social_connected=instagram');

        const res = await call('POST', '/api/social-connections/connect', { platform: 'youtube' }, T_A);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('max_connected_platforms');
    });

    it('GET /callback redirige al frontend con éxito o con error', async () => {
        // Éxito: state válido + params de Zernio → 302 con social_connected.
        const stateParam = signConnectState({ tenantId: T_A, platform: 'tiktok' }, SECRET);
        // El perfil de T_A aún no existe → el flujo lo crea vía fake (zprof_1).
        const ok = await call(
            'GET',
            `/api/social-connections/callback?state=${encodeURIComponent(stateParam)}&connected=tiktok&profileId=zprof_1&accountId=zacc_5`,
        );
        expect(ok.status).toBe(302);
        const loc = ok.headers.get('location') ?? '';
        expect(loc).toContain('https://app.test/conexiones');
        expect(loc).toContain('social_connected=tiktok');
        expect(state.connections).toHaveLength(1);
        expect(state.connections[0].platform).toBe('tiktok');

        // Error: state basura → 302 con social_error, sin escribir más.
        const bad = await call('GET', '/api/social-connections/callback?state=invalido&connected=tiktok&profileId=zprof_1&accountId=x');
        expect(bad.status).toBe(302);
        expect(bad.headers.get('location')).toContain('social_error=invalid_state');
        expect(state.connections).toHaveLength(1);
    });

    it('POST /sync reconcilia y DELETE desconecta vía Zernio', async () => {
        // Semilla vía callback.
        const stateParam = signConnectState({ tenantId: T_A, platform: 'instagram' }, SECRET);
        await call(
            'GET',
            `/api/social-connections/callback?state=${encodeURIComponent(stateParam)}&connected=instagram&profileId=zprof_1&accountId=zacc_1`,
        );
        zernio.remoteAccounts = [
            { id: 'zacc_1', platform: 'instagram', username: 'radio.uno', displayName: 'Radio Uno', profileId: 'zprof_1', enabled: true, status: 'connected' },
        ];
        const sync = await call('POST', '/api/social-connections/sync', undefined, T_A);
        expect(sync.status).toBe(200);
        const { synced } = await sync.json();
        expect(synced).toBe(1);

        const connId = state.connections[0].id;
        const del = await call('DELETE', `/api/social-connections/${connId}`, undefined, T_A);
        expect(del.status).toBe(204);
        expect(zernio.calls.disconnectAccount).toEqual(['zacc_1']);
        expect(state.connections).toHaveLength(0);

        // DELETE de id inexistente ⇒ 404.
        const res404 = await call(
            'DELETE',
            '/api/social-connections/00000000-0000-4000-8000-000000000099',
            undefined,
            T_A,
        );
        expect(res404.status).toBe(404);
    });

    it('(9)+(10) la API key NUNCA aparece en logs ni en respuestas', async () => {
        const logs: string[] = [];
        for (const method of ['error', 'warn', 'log', 'info'] as const) {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
                logs.push(args.map(String).join(' '));
            });
        }
        // Cliente real con la key — upstream responde 401 y su mensaje
        // CONTIENE la key (caso hostil: el servidor la repite en el body).
        const fetchFn = vi.fn(async () =>
            new Response(
                JSON.stringify({ error: `token revocado: ${API_KEY}`, code: 'unauthorized' }),
                { status: 401, headers: { 'content-type': 'application/json' } },
            ),
        );
        socialConnectionsRouteDeps.zernio = createZernioApi({
            apiKey: API_KEY,
            fetchFn: fetchFn as never,
        });
        const res = await call('POST', '/api/social-connections/connect', { platform: 'instagram' }, T_A);
        const bodyText = JSON.stringify(await res.json());
        // (10) La respuesta no contiene la key (el error se redactó).
        expect(bodyText).not.toContain(API_KEY);
        expect(bodyText).toContain('[redacted]');
        // El header Authorization sí llevó la key hacia Zernio.
        const authHeader = (fetchFn.mock.calls[0][1]?.headers as Record<string, string>).Authorization;
        expect(authHeader).toBe(`Bearer ${API_KEY}`);
        // (9) Ningún log del proceso contiene la key.
        expect(logs.join('\n')).not.toContain(API_KEY);
    });
});
