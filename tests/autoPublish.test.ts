/**
 * Tests del slice PG-03: `autoPublishService` + rutas `/api/auto-publish`.
 *
 * Deterministas, mismo estilo que assets/networkVariants: store en memoria
 * que replica la semántica del ON CONFLICT keyed por (tenant_id, program_key)
 * — la UNIQUE que también cubre la config global ('__all__'), que un UNIQUE
 * sobre (tenant_id, program_id) NO deduplicaría por los NULLs — y flag/plan
 * como deps inyectables (nunca Neon ni DB real). App express efímera para
 * las rutas con auth mockeado (x-test-tenant).
 *
 * Cubre el brief:
 *   (a) upsert + lectura tenant-scoped (global y por programa)
 *   (b) programId de otro tenant ⇒ 404 program_not_found
 *   (c) feature deshabilitado ⇒ 403 feature_disabled y NADA guardado
 *   (d) superar plans.max_connected_platforms ⇒ 403 plan_limit_exceeded
 *   (e) validación de mode/platforms/publishDays/publishTime (+ schedule)
 *   (f) el UNIQUE (tenant_id, program_key) deduplica también la global
 *   + GET 200 con estado del plan, DELETE 204/404, 401 sin auth, y el
 *     write-path de los campos scheduled ([]/NULL fuera de modo scheduled).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de auth (mismo contrato que assets.test.ts) ────────────────
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
    AUTO_PUBLISH_GLOBAL_KEY,
    AUTO_PUBLISH_PLATFORMS,
    deleteAutoPublishConfig,
    getAutoPublishConfig,
    getAutoPublishPlanStatus,
    isAutoPublishMode,
    isAutoPublishPlatform,
    listAutoPublishConfigs,
    programKeyFor,
    upsertAutoPublishConfig,
    type AutoPublishDeps,
} from '../src/server/services/autoPublishService';
import { autoPublishRouter, autoPublishRouteDeps } from '../src/server/routes/autoPublish';
import {
    createMemoryAutoPublishStore,
    seedProgram,
    type MemoryAutoPublishState,
} from './helpers/memoryAutoPublishStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const PROG_A = '00000000-0000-4000-8000-0000000000a1';
const PROG_B = '00000000-0000-4000-8000-0000000000b2';
const PROG_FOREIGN = '00000000-0000-4000-8000-0000000000f3';

const featureOn = async () => true;
const featureOff = async () => false;
const planLimit = (max: number | null) => async () => ({ name: 'creator', maxConnectedPlatforms: max });

const makeDeps = (
    store: AutoPublishDeps['store'],
    opts: { enabled?: boolean; max?: number | null } = {},
): AutoPublishDeps => ({
    store,
    isFeatureEnabled: opts.enabled === false ? featureOff : featureOn,
    getPlan: planLimit(opts.max === undefined ? null : opts.max),
});

describe('autoPublishService — upsert y lectura tenant-scoped', () => {
    let state: MemoryAutoPublishState;
    let deps: AutoPublishDeps;

    beforeEach(() => {
        const memory = createMemoryAutoPublishStore();
        state = memory.state;
        seedProgram(state, { id: PROG_A, tenantId: T_A });
        seedProgram(state, { id: PROG_B, tenantId: T_B });
        deps = makeDeps(memory.store);
    });

    it('(a) upsert crea la config global y la lee tenant-scoped', async () => {
        const saved = await upsertAutoPublishConfig(
            { tenantId: T_A, mode: 'on_approval', platforms: ['instagram', 'tiktok'] },
            deps,
        );
        expect(saved.programKey).toBe(AUTO_PUBLISH_GLOBAL_KEY);
        expect(saved.programId).toBeNull();
        expect(saved.platforms).toEqual(['instagram', 'tiktok']);

        const read = await getAutoPublishConfig(T_A, null, deps);
        expect(read?.id).toBe(saved.id);
        expect(read?.mode).toBe('on_approval');
        // Tenant ajeno no la ve.
        expect(await getAutoPublishConfig(T_B, null, deps)).toBeNull();
        expect(await listAutoPublishConfigs(T_B, deps)).toEqual([]);
    });

    it('(a) upsert por programa y re-upsert actualizan en vez de duplicar', async () => {
        await upsertAutoPublishConfig(
            { tenantId: T_A, programId: PROG_A, mode: 'scheduled', platforms: ['youtube'], publishDays: [1, 3], publishTime: '08:30' },
            deps,
        );
        const again = await upsertAutoPublishConfig(
            { tenantId: T_A, programId: PROG_A, mode: 'on_approval', platforms: ['youtube', 'reddit'] },
            deps,
        );
        const configs = await listAutoPublishConfigs(T_A, deps);
        expect(configs).toHaveLength(1);
        expect(configs[0].id).toBe(again.id);
        expect(configs[0].mode).toBe('on_approval');
        // Fuera de scheduled: publishDays/publishTime quedan []/NULL.
        expect(configs[0].publishDays).toEqual([]);
        expect(configs[0].publishTime).toBeNull();
        // La global y la del programa coexisten (program_key distinto).
        await upsertAutoPublishConfig({ tenantId: T_A, mode: 'off', platforms: [] }, deps);
        expect(await listAutoPublishConfigs(T_A, deps)).toHaveLength(2);
    });

    it('(f) program_key deduplica la global: no existen dos configs globales', async () => {
        const first = await upsertAutoPublishConfig({ tenantId: T_A, mode: 'on_approval', platforms: ['instagram'] }, deps);
        const second = await upsertAutoPublishConfig({ tenantId: T_A, mode: 'scheduled', platforms: ['bluesky'], publishDays: [6], publishTime: '21:00' }, deps);
        expect(second.id).toBe(first.id);
        const configs = state.configs.filter((c) => c.tenantId === T_A && c.programKey === AUTO_PUBLISH_GLOBAL_KEY);
        expect(configs).toHaveLength(1);
        expect(configs[0].mode).toBe('scheduled');
        // El program_key NUNCA viene del input — siempre se deriva de programId.
        expect(programKeyFor(null)).toBe(AUTO_PUBLISH_GLOBAL_KEY);
        expect(programKeyFor(PROG_A)).toBe(PROG_A);
    });

    it('(b) programId de otro tenant ⇒ 404 program_not_found', async () => {
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, programId: PROG_B, mode: 'on_approval', platforms: ['instagram'] },
                deps,
            ),
        ).rejects.toMatchObject({ statusCode: 404, code: 'program_not_found' });
        // No se guardó nada.
        expect(state.configs).toHaveLength(0);
    });

    it('(b) programId inexistente o con formato inválido', async () => {
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, programId: PROG_FOREIGN, mode: 'off', platforms: [] },
                deps,
            ),
        ).rejects.toMatchObject({ statusCode: 404, code: 'program_not_found' });
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, programId: 'no-es-uuid', mode: 'off', platforms: [] },
                deps,
            ),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_program' });
    });

    it('(c) feature deshabilitado ⇒ 403 feature_disabled y nada guardado', async () => {
        const off = makeDeps(createMemoryAutoPublishStore().store, { enabled: false });
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, mode: 'on_approval', platforms: ['instagram'] },
                off,
            ),
        ).rejects.toMatchObject({ statusCode: 403, code: 'feature_disabled' });
        expect(state.configs).toHaveLength(0);
    });

    it('(d) superar maxConnectedPlatforms ⇒ 403 plan_limit_exceeded (cuenta la unión)', async () => {
        // Memory store propio: la unión entre configs se ejerce de verdad.
        const memory = createMemoryAutoPublishStore();
        seedProgram(memory.state, { id: PROG_A, tenantId: T_A });
        const depsLimited = makeDeps(memory.store, { max: 2 });
        await upsertAutoPublishConfig(
            { tenantId: T_A, mode: 'on_approval', platforms: ['instagram', 'tiktok'] },
            depsLimited,
        );
        // Otra config que pide una plataforma nueva ⇒ unión = 3 > 2 ⇒ 403.
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, programId: PROG_A, mode: 'on_approval', platforms: ['youtube'] },
                depsLimited,
            ),
        ).rejects.toMatchObject({ statusCode: 403, code: 'plan_limit_exceeded' });
        // Reintentar la misma config con plataformas ya usadas sí pasa (unión = 2).
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, programId: PROG_A, mode: 'scheduled', platforms: ['tiktok'], publishDays: [0], publishTime: '10:00' },
                depsLimited,
            ),
        ).resolves.toMatchObject({ mode: 'scheduled' });
        // mode='off' no consume cuota: guarda sin mirar el tope.
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, programId: PROG_A, mode: 'off', platforms: ['youtube', 'reddit', 'bluesky'] },
                depsLimited,
            ),
        ).resolves.toMatchObject({ mode: 'off' });
    });

    it('(d) plan sin tope (NULL) ⇒ cualquier cantidad de plataformas pasa', async () => {
        await expect(
            upsertAutoPublishConfig(
                { tenantId: T_A, mode: 'on_approval', platforms: [...AUTO_PUBLISH_PLATFORMS] },
                deps,
            ),
        ).resolves.toMatchObject({ platforms: AUTO_PUBLISH_PLATFORMS });
    });

    it('(e) valida mode/platforms/publishDays/publishTime estrictamente', async () => {
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'inventado', platforms: [] }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_mode' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'off', platforms: ['myspace'] }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_platforms' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'off', platforms: 'instagram' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_platforms' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'scheduled', platforms: ['instagram'], publishDays: [7], publishTime: '09:00' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_publish_days' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'scheduled', platforms: ['instagram'], publishDays: [1.5], publishTime: '09:00' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_publish_days' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'scheduled', platforms: ['instagram'], publishDays: [1], publishTime: '25:00' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_publish_time' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'scheduled', platforms: ['instagram'], publishDays: [1], publishTime: '9:00' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_publish_time' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'off', timezone: 'mars/olympus$$' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_timezone' });
        // Nada quedó guardado tras todos los rechazos.
        expect(state.configs).toHaveLength(0);
    });

    it('(e) scheduled exige publishDays no vacío y publishTime', async () => {
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'scheduled', platforms: ['instagram'], publishDays: [], publishTime: '09:00' }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_schedule' });
        await expect(
            upsertAutoPublishConfig({ tenantId: T_A, mode: 'scheduled', platforms: ['instagram'], publishDays: [2] }, deps),
        ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_schedule' });
        const ok = await upsertAutoPublishConfig(
            { tenantId: T_A, mode: 'scheduled', platforms: ['instagram'], publishDays: [0, 6], publishTime: '07:45', timezone: 'America/Cordoba' },
            deps,
        );
        expect(ok.publishDays).toEqual([0, 6]);
        expect(ok.publishTime).toBe('07:45');
        expect(ok.timezone).toBe('America/Cordoba');
    });

    it('deduplica plataformas y días repetidos en la entrada', async () => {
        const saved = await upsertAutoPublishConfig(
            { tenantId: T_A, mode: 'scheduled', platforms: ['instagram', 'instagram', 'tiktok'], publishDays: [3, 3, 3], publishTime: '12:00' },
            deps,
        );
        expect(saved.platforms).toEqual(['instagram', 'tiktok']);
        expect(saved.publishDays).toEqual([3]);
    });

    it('type guards del dominio', () => {
        expect(isAutoPublishMode('off')).toBe(true);
        expect(isAutoPublishMode('on_approval')).toBe(true);
        expect(isAutoPublishMode('scheduled')).toBe(true);
        expect(isAutoPublishMode('auto')).toBe(false);
        for (const p of AUTO_PUBLISH_PLATFORMS) expect(isAutoPublishPlatform(p)).toBe(true);
        expect(isAutoPublishPlatform('whatsapp')).toBe(false);
    });

    it('deleteAutoPublishConfig: 404 al borrar inexistente o ajeno', async () => {
        const saved = await upsertAutoPublishConfig({ tenantId: T_A, mode: 'off', platforms: [] }, deps);
        await expect(deleteAutoPublishConfig(T_B, saved.id, deps)).rejects.toMatchObject({
            statusCode: 404,
            code: 'config_not_found',
        });
        await expect(deleteAutoPublishConfig(T_A, saved.id, deps)).resolves.toBeUndefined();
        expect(await listAutoPublishConfigs(T_A, deps)).toHaveLength(0);
    });

    it('getAutoPublishPlanStatus resume flag, tope y uso', async () => {
        const memory = createMemoryAutoPublishStore();
        seedProgram(memory.state, { id: PROG_A, tenantId: T_A });
        const depsStatus = makeDeps(memory.store, { max: 3 });
        await upsertAutoPublishConfig({ tenantId: T_A, mode: 'on_approval', platforms: ['instagram', 'tiktok'] }, depsStatus);
        await upsertAutoPublishConfig({ tenantId: T_A, programId: PROG_A, mode: 'off', platforms: ['reddit'] }, depsStatus);
        const status = await getAutoPublishPlanStatus(T_A, depsStatus);
        expect(status).toEqual({ planAllowsAutoPublish: true, maxPlatforms: 3, usedPlatforms: 2 });
        const statusOff = await getAutoPublishPlanStatus(T_A, makeDeps(memory.store, { enabled: false }));
        expect(statusOff.planAllowsAutoPublish).toBe(false);
    });
});

describe('autoPublish routes — /api/auto-publish', () => {
    let server: Server;
    let baseUrl: string;
    let state: MemoryAutoPublishState;

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
        });
        return res;
    };

    beforeEach(async () => {
        const memory = createMemoryAutoPublishStore();
        state = memory.state;
        seedProgram(state, { id: PROG_A, tenantId: T_A });
        Object.assign(autoPublishRouteDeps, {
            store: memory.store,
            isFeatureEnabled: featureOn,
            getPlan: planLimit(2),
        });
        const app = express();
        app.use(express.json());
        app.use('/api/auto-publish', autoPublishRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        Object.assign(autoPublishRouteDeps, {
            store: undefined,
            isFeatureEnabled: undefined,
            getPlan: undefined,
        });
        vi.restoreAllMocks();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('401 sin auth; GET devuelve configs + estado del plan', async () => {
        expect((await call('GET', '/api/auto-publish')).status).toBe(401);
        const res = await call('GET', '/api/auto-publish', undefined, T_A);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.configs).toEqual([]);
        expect(json.planAllowsAutoPublish).toBe(true);
        expect(json.maxPlatforms).toBe(2);
        expect(json.usedPlatforms).toBe(0);
    });

    it('PUT crea y re-escribe la config; GET la refleja', async () => {
        const put = await call('PUT', '/api/auto-publish', {
            programId: PROG_A,
            mode: 'scheduled',
            platforms: ['instagram', 'tiktok'],
            publishDays: [1, 4],
            publishTime: '18:30',
        }, T_A);
        expect(put.status).toBe(200);
        const { config } = await put.json();
        expect(config.programId).toBe(PROG_A);
        expect(config.programKey).toBe(PROG_A);

        const get = await call('GET', '/api/auto-publish', undefined, T_A);
        const json = await get.json();
        expect(json.configs).toHaveLength(1);
        expect(json.usedPlatforms).toBe(2);
    });

    it('PUT rechaza entradas inválidas con 400', async () => {
        expect((await call('PUT', '/api/auto-publish', {}, T_A)).status).toBe(400);
        expect((await call('PUT', '/api/auto-publish', { mode: 'x' }, T_A)).status).toBe(400);
        expect((await call('PUT', '/api/auto-publish', { mode: 'off', programId: 'xx' }, T_A)).status).toBe(400);
        const res = await call('PUT', '/api/auto-publish', { mode: 'on_approval', platforms: ['orkut'] }, T_A);
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('invalid_platforms');
    });

    it('PUT: 403 feature_disabled y 403 plan_limit_exceeded', async () => {
        autoPublishRouteDeps.isFeatureEnabled = featureOff;
        const res = await call('PUT', '/api/auto-publish', { mode: 'on_approval', platforms: ['instagram'] }, T_A);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('feature_disabled');
        expect(state.configs).toHaveLength(0);
        autoPublishRouteDeps.isFeatureEnabled = featureOn;

        // max=2: instagram+tiktok llenan el cupo; youtube lo supera.
        await call('PUT', '/api/auto-publish', { mode: 'on_approval', platforms: ['instagram', 'tiktok'] }, T_A);
        const res2 = await call('PUT', '/api/auto-publish', { programId: PROG_A, mode: 'on_approval', platforms: ['youtube'] }, T_A);
        expect(res2.status).toBe(403);
        expect((await res2.json()).code).toBe('plan_limit_exceeded');
    });

    it('PUT: programId de otro tenant ⇒ 404', async () => {
        const res = await call('PUT', '/api/auto-publish', { programId: PROG_B, mode: 'on_approval', platforms: ['instagram'] }, T_A);
        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('program_not_found');
    });

    it('DELETE borra la config del tenant; 404 ajena o inexistente', async () => {
        const put = await call('PUT', '/api/auto-publish', { mode: 'on_approval', platforms: ['instagram'] }, T_A);
        const { config } = await put.json();

        expect((await call('DELETE', `/api/auto-publish/${config.id}`, undefined, T_B)).status).toBe(404);
        expect((await call('DELETE', '/api/auto-publish/no-uuid', undefined, T_A)).status).toBe(400);
        const del = await call('DELETE', `/api/auto-publish/${config.id}`, undefined, T_A);
        expect(del.status).toBe(204);
        expect(state.configs).toHaveLength(0);
    });
});
