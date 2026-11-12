/**
 * Tests del slice PI-03: ledger de consumo de IA `ai_usage_events` —
 * `aiUsageService` (pricing + normalización de tokens + registro
 * best-effort + agregación), la instrumentación del gateway
 * (`aiSdkService.chatCompletion` con 'ai' mockeado) y las rutas
 * `/api/ai-usage/summary` (tenant) + `/api/admin/ai-usage`
 * (platform admin) montadas en apps express efímeras.
 *
 * Deterministas: sin DB real (memory store con la MISMA agregación que el
 * drizzle via `summarizeUsageRows`), sin red ('ai' y axios nunca se
 * llaman), `createdAt` fijo en T0, env de API keys restaurado por test.
 *
 * Casos obligatorios del brief:
 *   1) pricing: prompt*in + completion*out por 1M; modelo desconocido → null.
 *   2) normalización de usage: SDK v6, OpenAI REST, Gemini REST, faltantes.
 *   3) record: inserta con tokens+costo; sin tenantId no escribe; store
 *      caído → resuelve igual (nunca rompe la llamada IA).
 *   4) withAiUsageRecording: éxito → success+tokens; fallo → success=false
 *      + error truncado + repropaga.
 *   5) agregación: por tenant, por feature/provider, top transmisiones,
 *      rango [from, to), aislamiento tenant.
 *   6) rutas tenant: { summary } sólo del tenant autenticado; sin auth →
 *      401; from inválido → 400.
 *   7) rutas admin: sin platform-admin → 401/403; con admin ve cross-tenant;
 *      filtro tenantId (uuid inválido → 400).
 *   8) gateway: chatCompletion con usageContext registra el evento con
 *      tokens del SDK; fallo del provider → success=false.
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

// ─── Mock parcial de auth (mismo contrato que jobQueue.test.ts) ─────────────
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

// ─── Mock parcial de audit: admin.ts importa auditService ───────────────────
vi.mock('../src/server/services/auditService.js', async (io) => {
    const actual =
        await io<typeof import('../src/server/services/auditService.js')>();
    return {
        ...actual,
        recordAuditEvent: vi.fn(async () => {}),
        auditFromRequest: vi.fn(async () => {}),
    };
});

// ─── Mock de 'ai' (Vercel AI SDK): generateText/streamText nunca salen a la
// red — el gateway queda testeable de punta a punta con usage determinista. ──
const mockGenerateText = vi.fn();
const mockStreamText = vi.fn();
vi.mock('ai', () => ({
    generateText: (...args: unknown[]) => mockGenerateText(...args),
    streamText: (...args: unknown[]) => mockStreamText(...args),
}));

import {
    aiUsageDeps,
    buildAiUsageEventRow,
    createAiUsageService,
    estimateAiCostUsd,
    normalizeTokenUsage,
    recordAiUsageEvent,
    summarizeUsageRows,
    withAiUsageRecording,
} from '../src/server/services/aiUsageService';
import { chatCompletion } from '../src/server/services/aiSdkService';
import { aiUsageRouter } from '../src/server/routes/aiUsage';
import { adminRouter } from '../src/server/routes/admin';
import {
    createMemoryAiUsageStore,
    makeMemoryAiUsageEvent,
} from './helpers/memoryAiUsageStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TR_A1 = 'transmission-a1';
const TR_A2 = 'transmission-a2';
const T0 = new Date('2026-11-11T12:00:00.000Z');

const ENV_KEYS = ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];
let savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
    vi.restoreAllMocks();
    delete aiUsageDeps.store;
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    savedEnv = {};
});

function saveAndSetEnv(updates: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
    }
    for (const [k, v] of Object.entries(updates)) {
        if (v !== undefined) process.env[k] = v;
    }
}

// ─── 1: pricing ─────────────────────────────────────────────────────────────

describe('pricing — estimateAiCostUsd', () => {
    it('(1) costo = prompt*input + completion*output por 1M tokens', () => {
        // deepseek-chat: 0.27 / 1.10 → 1M in + 1M out = $1.37
        expect(estimateAiCostUsd('deepseek-chat', 1_000_000, 1_000_000)).toBeCloseTo(1.37, 6);
        // gpt-4o-mini: 0.15 / 0.60 → 1000 in + 500 out = 0.00015 + 0.0003
        expect(estimateAiCostUsd('gpt-4o-mini', 1000, 500)).toBeCloseTo(0.00045, 8);
        // gemini-2.0-flash: 0.10 / 0.40
        expect(estimateAiCostUsd('gemini-2.0-flash', 2000, 1000)).toBeCloseTo(0.0006, 8);
    });

    it('(1) modelo sin precio cargado → null (nunca un número inventado)', () => {
        expect(estimateAiCostUsd('modelo-raro', 1000, 1000)).toBeNull();
    });
});

// ─── 2: normalización de usage ──────────────────────────────────────────────

describe('normalizeTokenUsage — formas de usage por provider', () => {
    it('(2) AI SDK v6 {inputTokens,outputTokens,totalTokens}', () => {
        expect(
            normalizeTokenUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
        ).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it('(2) OpenAI REST {prompt_tokens,completion_tokens,total_tokens}', () => {
        expect(
            normalizeTokenUsage({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
        ).toEqual({ promptTokens: 7, completionTokens: 3, totalTokens: 10 });
    });

    it('(2) Gemini REST {promptTokenCount,candidatesTokenCount,totalTokenCount}', () => {
        expect(
            normalizeTokenUsage({
                promptTokenCount: 12,
                candidatesTokenCount: 4,
                totalTokenCount: 16,
            }),
        ).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
    });

    it('(2) sin total ⇒ prompt+completion; sin nada ⇒ ceros', () => {
        expect(normalizeTokenUsage({ inputTokens: 8, outputTokens: 2 })).toEqual({
            promptTokens: 8,
            completionTokens: 2,
            totalTokens: 10,
        });
        expect(normalizeTokenUsage(undefined)).toEqual({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        });
        expect(normalizeTokenUsage(null)).toEqual({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        });
    });
});

// ─── 3: buildAiUsageEventRow + recordAiUsageEvent ───────────────────────────

describe('registro de eventos', () => {
    it('(3) buildAiUsageEventRow calcula tokens + costo fixed(6); fallo → costo null', () => {
        const ok = buildAiUsageEventRow({
            tenantId: T_A,
            feature: 'news-generate',
            provider: 'deepseek',
            model: 'deepseek-chat',
            usage: { inputTokens: 1000, outputTokens: 500 },
            success: true,
            createdAt: T0,
        });
        expect(ok.promptTokens).toBe(1000);
        expect(ok.completionTokens).toBe(500);
        expect(ok.totalTokens).toBe(1500);
        // 1000*0.27 + 500*1.10 = 820µ$ → '0.000820'
        expect(ok.estimatedCostUsd).toBe('0.000820');
        expect(ok.success).toBe(true);
        expect(ok.transmissionId).toBeNull();

        const fail = buildAiUsageEventRow({
            tenantId: T_A,
            feature: 'news-generate',
            provider: 'deepseek',
            model: 'deepseek-chat',
            success: false,
            error: 'timeout',
        });
        expect(fail.estimatedCostUsd).toBeNull();
        expect(fail.error).toBe('timeout');
        expect(fail.totalTokens).toBe(0);
    });

    it('(3) buildAiUsageEventRow trunca el error a 500 chars', () => {
        const row = buildAiUsageEventRow({
            tenantId: T_A,
            feature: 'f',
            provider: 'p',
            model: 'm',
            success: false,
            error: 'x'.repeat(1000),
        });
        expect(row.error).toHaveLength(500);
    });

    it('(3) recordAiUsageEvent inserta en el store inyectado', async () => {
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;
        await recordAiUsageEvent({
            tenantId: T_A,
            transmissionId: TR_A1,
            feature: 'news-generate',
            provider: 'google',
            model: 'gemini-2.0-flash',
            usage: { promptTokenCount: 2000, candidatesTokenCount: 1000 },
            success: true,
            durationMs: 42,
        });
        expect(state.events).toHaveLength(1);
        expect(state.events[0].tenantId).toBe(T_A);
        expect(state.events[0].transmissionId).toBe(TR_A1);
        expect(state.events[0].totalTokens).toBe(3000);
        expect(state.events[0].estimatedCostUsd).toBe('0.000600');
        expect(state.events[0].durationMs).toBe(42);
        expect(state.events[0].createdAt).toEqual(T0);
    });

    it('(3) sin tenantId no escribe nada (la columna es NOT NULL)', async () => {
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;
        await recordAiUsageEvent({
            tenantId: '',
            feature: 'news-generate',
            provider: 'deepseek',
            model: 'deepseek-chat',
        });
        expect(state.events).toHaveLength(0);
    });

    it('(3) store caído → recordAiUsageEvent resuelve igual (best-effort)', async () => {
        const { store } = createMemoryAiUsageStore({ failOnInsert: true });
        aiUsageDeps.store = store;
        await expect(
            recordAiUsageEvent({
                tenantId: T_A,
                feature: 'news-generate',
                provider: 'deepseek',
                model: 'deepseek-chat',
            }),
        ).resolves.toBeUndefined();
    });
});

// ─── 4: withAiUsageRecording ────────────────────────────────────────────────

describe('withAiUsageRecording — wrapper del gateway', () => {
    it('(4) éxito: devuelve el value y registra success+tokens+duration', async () => {
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;
        const out = await withAiUsageRecording(
            {
                provider: 'openai',
                model: 'gpt-4o-mini',
                usageCtx: { tenantId: T_A, feature: 'review-edit' },
            },
            async () => ({ value: 'texto', usage: { prompt_tokens: 500, completion_tokens: 250 } }),
        );
        expect(out).toBe('texto');
        expect(state.events).toHaveLength(1);
        const e = state.events[0];
        expect(e.success).toBe(true);
        expect(e.model).toBe('gpt-4o-mini');
        expect(e.promptTokens).toBe(500);
        expect(e.completionTokens).toBe(250);
        expect(e.estimatedCostUsd).toBe('0.000225'); // 500*.15 + 250*.60
        expect(e.durationMs).toBeTypeOf('number');
    });

    it('(4) fallo: registra success=false con el error y REPROPAGA', async () => {
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;
        await expect(
            withAiUsageRecording(
                {
                    provider: 'deepseek',
                    model: 'deepseek-chat',
                    usageCtx: { tenantId: T_A, feature: 'news-generate' },
                },
                async () => {
                    throw new Error('provider caído');
                },
            ),
        ).rejects.toThrow('provider caído');
        expect(state.events).toHaveLength(1);
        expect(state.events[0].success).toBe(false);
        expect(state.events[0].error).toBe('provider caído');
        expect(state.events[0].estimatedCostUsd).toBeNull();
    });

    it('(4) sin usageCtx no registra pero la llamada funciona', async () => {
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;
        const out = await withAiUsageRecording(
            { provider: 'deepseek', model: 'deepseek-chat' },
            async () => ({ value: 42 }),
        );
        expect(out).toBe(42);
        expect(state.events).toHaveLength(0);
    });
});

// ─── 5: agregación summarizeUsageRows ───────────────────────────────────────

const seedRows = () => [
    // T_A — dos features, dos providers, una con transmisión
    makeMemoryAiUsageEvent({
        tenantId: T_A,
        transmissionId: TR_A1,
        feature: 'live-analysis',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        estimatedCostUsd: '0.001550',
        createdAt: T0,
    }),
    makeMemoryAiUsageEvent({
        tenantId: T_A,
        transmissionId: TR_A1,
        feature: 'news-generate',
        provider: 'deepseek',
        model: 'deepseek-chat',
        promptTokens: 2000,
        completionTokens: 1000,
        totalTokens: 3000,
        estimatedCostUsd: '0.001640',
        createdAt: new Date(T0.getTime() + 1000),
    }),
    makeMemoryAiUsageEvent({
        tenantId: T_A,
        transmissionId: TR_A2,
        feature: 'news-generate',
        provider: 'deepseek',
        model: 'deepseek-chat',
        promptTokens: 500,
        completionTokens: 250,
        totalTokens: 750,
        estimatedCostUsd: '0.000410',
        success: false,
        error: 'timeout',
        createdAt: new Date(T0.getTime() + 2000),
    }),
    // T_B — otro tenant (no debe contaminar la vista de A)
    makeMemoryAiUsageEvent({
        tenantId: T_B,
        feature: 'review-edit',
        provider: 'openai',
        model: 'gpt-4o-mini',
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: '0.000045',
        createdAt: T0,
    }),
];

describe('summarizeUsageRows — agregación y aislamiento', () => {
    it('(5) vista tenant: sólo filas del tenant, totales y group-bys', () => {
        const s = summarizeUsageRows(seedRows(), { tenantId: T_A });
        expect(s.totals.calls).toBe(3);
        expect(s.totals.errors).toBe(1);
        expect(s.totals.totalTokens).toBe(5250);
        expect(s.totals.costUsd).toBeCloseTo(0.0036, 6);
        expect(s.byTenant).toHaveLength(1);
        expect(s.byTenant[0].tenantId).toBe(T_A);

        const features = Object.fromEntries(s.byFeature.map((f) => [f.feature, f]));
        expect(features['live-analysis'].calls).toBe(1);
        expect(features['news-generate'].calls).toBe(2);

        const providers = Object.fromEntries(s.byProvider.map((p) => [p.provider, p]));
        expect(providers['gemini'].calls).toBe(1);
        expect(providers['deepseek'].calls).toBe(2);
        expect(providers['openai']).toBeUndefined();
    });

    it('(5) top transmisiones: por costo desc, sólo las del scope', () => {
        const s = summarizeUsageRows(seedRows(), { tenantId: T_A });
        expect(s.topTransmissions.map((t) => t.transmissionId)).toEqual([TR_A1, TR_A2]);
        expect(s.topTransmissions[0].costUsd).toBeCloseTo(0.00319, 6);
        expect(s.topTransmissions.every((t) => t.tenantId === T_A)).toBe(true);
    });

    it('(5) rango [from, to) filtra por created_at', () => {
        const s = summarizeUsageRows(seedRows(), {
            tenantId: T_A,
            from: new Date(T0.getTime() + 1500),
            to: new Date(T0.getTime() + 2500),
        });
        expect(s.totals.calls).toBe(1);
        expect(s.totals.errors).toBe(1);
    });

    it('(5) cross-tenant (admin): sin tenantId agrega TODOS los tenants', () => {
        const s = summarizeUsageRows(seedRows(), {});
        expect(s.totals.calls).toBe(4);
        expect(s.byTenant).toHaveLength(2);
        // T_A cuesta más → primero
        expect(s.byTenant[0].tenantId).toBe(T_A);
    });
});

// ─── 6: rutas tenant /api/ai-usage ──────────────────────────────────────────

describe('rutas /api/ai-usage (tenant)', () => {
    let server: Server | null = null;
    let baseUrl = '';

    const startApp = async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/ai-usage', aiUsageRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    };

    const api = (path: string, tenant: string | null = T_A) =>
        fetch(`${baseUrl}${path}`, {
            headers: tenant ? { 'x-test-tenant': tenant } : {},
        });

    afterEach(async () => {
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    it('(6) GET /summary → { summary } sólo del tenant autenticado', async () => {
        const { store } = createMemoryAiUsageStore({ events: seedRows() });
        aiUsageDeps.store = store;
        await startApp();

        const res = await api('/api/ai-usage/summary');
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            summary: ReturnType<typeof summarizeUsageRows>;
        };
        expect(body.summary.totals.calls).toBe(3);
        expect(body.summary.byTenant).toHaveLength(1);
        expect(body.summary.byTenant[0].tenantId).toBe(T_A);
        expect(body.summary.topTransmissions).toHaveLength(2);
        // Tenant B pide lo suyo: ve su única fila, nada de A.
        const resB = await api('/api/ai-usage/summary', T_B);
        const bodyB = (await resB.json()) as typeof body;
        expect(bodyB.summary.totals.calls).toBe(1);
        expect(bodyB.summary.byTenant[0].tenantId).toBe(T_B);
        expect(bodyB.summary.topTransmissions).toHaveLength(0);
    });

    it('(6) filtros feature/rango aplican; from inválido → 400; sin auth → 401', async () => {
        const { store } = createMemoryAiUsageStore({ events: seedRows() });
        aiUsageDeps.store = store;
        await startApp();

        const byFeature = await api('/api/ai-usage/summary?feature=live-analysis');
        expect(byFeature.status).toBe(200);
        const bf = (await byFeature.json()) as {
            summary: { totals: { calls: number } };
        };
        expect(bf.summary.totals.calls).toBe(1);

        const badFrom = await api('/api/ai-usage/summary?from=nope');
        expect(badFrom.status).toBe(400);
        const badRange = await api(
            '/api/ai-usage/summary?from=2026-11-12&to=2026-11-11',
        );
        expect(badRange.status).toBe(400);
        const badTop = await api('/api/ai-usage/summary?top=abc');
        expect(badTop.status).toBe(400);

        const noAuth = await api('/api/ai-usage/summary', null);
        expect(noAuth.status).toBe(401);
    });
});

// ─── 7: rutas admin /api/admin/ai-usage ─────────────────────────────────────

describe('rutas /api/admin/ai-usage (platform admin, cross-tenant)', () => {
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
        opts: { tenant?: string | null; admin?: boolean } = {},
    ) => {
        const { tenant = T_A, admin = true } = opts;
        return fetch(`${baseUrl}${path}`, {
            headers: {
                ...(tenant ? { 'x-test-tenant': tenant } : {}),
                ...(admin ? { 'x-test-platform-admin': '1' } : {}),
            },
        });
    };

    afterEach(async () => {
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    const UUID_TENANT_B = '00000000-0000-4000-8000-0000000000b1';

    it('(7) sin auth → 401; sin platform-admin → 403', async () => {
        const { store } = createMemoryAiUsageStore({ events: seedRows() });
        aiUsageDeps.store = store;
        await startApp();

        const noAuth = await api('/api/admin/ai-usage', { tenant: null });
        expect(noAuth.status).toBe(401);
        const notAdmin = await api('/api/admin/ai-usage', { admin: false });
        expect(notAdmin.status).toBe(403);
    });

    it('(7) con admin agrega cross-tenant; filtro tenantId limita el scope', async () => {
        const rows = seedRows();
        // tenantId con formato uuid para el filtro del admin
        rows[3].tenantId = UUID_TENANT_B;
        const { store } = createMemoryAiUsageStore({ events: rows });
        aiUsageDeps.store = store;
        await startApp();

        const res = await api('/api/admin/ai-usage');
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            summary: ReturnType<typeof summarizeUsageRows>;
        };
        expect(body.summary.totals.calls).toBe(4);
        expect(body.summary.byTenant).toHaveLength(2);

        const scoped = await api(`/api/admin/ai-usage?tenantId=${UUID_TENANT_B}`);
        const scopedBody = (await scoped.json()) as typeof body;
        expect(scopedBody.summary.totals.calls).toBe(1);
        expect(scopedBody.summary.byTenant).toHaveLength(1);
        expect(scopedBody.summary.byTenant[0].tenantId).toBe(UUID_TENANT_B);

        const badTenant = await api('/api/admin/ai-usage?tenantId=no-es-uuid');
        expect(badTenant.status).toBe(400);
    });
});

// ─── 8: gateway instrumentado (aiSdkService.chatCompletion + 'ai' mockeado) ─

describe('gateway — chatCompletion registra el evento', () => {
    it('(8) éxito: evento con provider/model/tokens del SDK y costo', async () => {
        saveAndSetEnv({ DEEPSEEK_API_KEY: 'test-key' });
        mockGenerateText.mockResolvedValue({
            text: 'respuesta',
            usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        });
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;

        const result = await chatCompletion({
            userPrompt: 'hola',
            usageContext: { tenantId: T_A, transmissionId: TR_A1, feature: 'news-generate' },
        });
        expect(result.text).toBe('respuesta');
        expect(result.provider).toBe('deepseek');
        expect(state.events).toHaveLength(1);
        const e = state.events[0];
        expect(e.feature).toBe('news-generate');
        expect(e.provider).toBe('deepseek');
        expect(e.model).toBe('deepseek-chat');
        expect(e.tenantId).toBe(T_A);
        expect(e.transmissionId).toBe(TR_A1);
        expect(e.promptTokens).toBe(1000);
        expect(e.completionTokens).toBe(500);
        expect(e.estimatedCostUsd).toBe('0.000820');
        expect(e.success).toBe(true);
    });

    it('(8) provider caído: evento success=false y la llamada sigue el fallback', async () => {
        saveAndSetEnv({ DEEPSEEK_API_KEY: 'test-key' });
        mockGenerateText.mockRejectedValue(new Error('deepseek 500'));
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;

        await expect(
            chatCompletion({
                userPrompt: 'hola',
                usageContext: { tenantId: T_A, feature: 'news-generate' },
            }),
        ).rejects.toThrow();
        expect(state.events).toHaveLength(1);
        expect(state.events[0].success).toBe(false);
        expect(state.events[0].error).toBe('deepseek 500');
        expect(state.events[0].estimatedCostUsd).toBeNull();
    });

    it('(8) sin usageContext no hay evento (backward compat)', async () => {
        saveAndSetEnv({ DEEPSEEK_API_KEY: 'test-key' });
        mockGenerateText.mockResolvedValue({
            text: 'ok',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        aiUsageDeps.store = store;

        const result = await chatCompletion({ userPrompt: 'hola' });
        expect(result.text).toBe('ok');
        expect(state.events).toHaveLength(0);
    });
});

// ─── service: createAiUsageService respeta el store inyectado ───────────────

describe('createAiUsageService — store inyectable', () => {
    it('recordEvent y summarize usan el store pasado por parámetro', async () => {
        const { store, state } = createMemoryAiUsageStore({ now: () => T0 });
        const svc = createAiUsageService(store);
        await svc.recordEvent({
            tenantId: T_A,
            feature: 'f',
            provider: 'deepseek',
            model: 'deepseek-chat',
            usage: { inputTokens: 10, outputTokens: 5 },
        });
        expect(state.events).toHaveLength(1);
        const s = await svc.summarize({ tenantId: T_A });
        expect(s.totals.calls).toBe(1);
        expect(s.totals.totalTokens).toBe(15);
        // Sin tenantId no escribe (misma regla que recordAiUsageEvent).
        await svc.recordEvent({
            tenantId: '',
            feature: 'f',
            provider: 'p',
            model: 'm',
        });
        expect(state.events).toHaveLength(1);
    });
});
