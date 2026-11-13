/**
 * Tests del slice PI-06: health check real (`healthService` + ruta
 * `/api/health`).
 *
 * Deterministas: probes fake (sin DB, sin FS, sin env), reloj inyectado,
 * router montado en app express efímera — mismo patrón que
 * jobQueue.test.ts.
 *
 * Casos:
 *   1) todo verde → status ok + HTTP 200.
 *   2) migraciones pendientes → degraded + 200 (la app sirve; el LB no
 *      debe drenar la instancia por una condición no fatal).
 *   3) sin provider de IA configurado → degraded + 200.
 *   4) migraciones no verificables (nulls) → degraded + 200.
 *   5) DB caída → error + HTTP 503 + checks dependientes en 'skipped'.
 *   6) la respuesta NUNCA expone secretos ni connection strings.
 *   7) GET /api/health end-to-end con probes inyectadas en healthRouteDeps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// El módulo DB crea un Pool Neon al importar — se reemplaza `db` para que
// ninguna probe real lo toque (las probes se inyectan por healthRouteDeps).
vi.mock('../src/server/db/index.js', async (io) => ({
    ...(await io()),
    db: {},
}));

import { getHealthReport } from '../src/server/services/healthService';
import {
    healthRouter,
    healthRouteDeps,
} from '../src/server/routes/health';
import type { HealthProbes } from '../src/server/services/healthService';

const T0 = new Date('2026-11-13T12:00:00.000Z');

const okProbes = (): HealthProbes => ({
    pingDatabase: async () => {},
    getMigrationStatus: async () => ({ applied: 22, expected: 22 }),
    listConfiguredAiProviders: () => ['deepseek', 'google'],
    now: () => T0,
});

afterEach(() => {
    delete healthRouteDeps.probes;
    vi.restoreAllMocks();
});

describe('getHealthReport — agregación de checks', () => {
    it('(1) todo verde → ok + 200 + checks up', async () => {
        const report = await getHealthReport(okProbes());
        expect(report.status).toBe('ok');
        expect(report.httpStatus).toBe(200);
        expect(report.body.status).toBe('ok');
        expect(report.body.timestamp).toBe(T0.toISOString());
        expect(report.body.checks.database.status).toBe('up');
        expect(report.body.checks.migrations).toEqual({
            status: 'up',
            applied: 22,
            expected: 22,
        });
        expect(report.body.checks.aiProviders).toEqual({
            status: 'up',
            configured: ['deepseek', 'google'],
        });
    });

    it('(2) migraciones pendientes → degraded + 200', async () => {
        const report = await getHealthReport({
            ...okProbes(),
            getMigrationStatus: async () => ({ applied: 20, expected: 22 }),
        });
        expect(report.status).toBe('degraded');
        expect(report.httpStatus).toBe(200);
        expect(report.body.checks.database.status).toBe('up');
        expect(report.body.checks.migrations.status).toBe('pending');
    });

    it('(3) sin provider de IA → degraded + 200 (aiProviders down)', async () => {
        const report = await getHealthReport({
            ...okProbes(),
            listConfiguredAiProviders: () => [],
        });
        expect(report.status).toBe('degraded');
        expect(report.httpStatus).toBe(200);
        expect(report.body.checks.aiProviders).toEqual({
            status: 'down',
            configured: [],
        });
    });

    it('(4) migraciones no verificables (nulls o probe que tira) → degraded + 200', async () => {
        const nulls = await getHealthReport({
            ...okProbes(),
            getMigrationStatus: async () => ({ applied: null, expected: null }),
        });
        expect(nulls.status).toBe('degraded');
        expect(nulls.httpStatus).toBe(200);
        expect(nulls.body.checks.migrations.status).toBe('unknown');

        const throwing = await getHealthReport({
            ...okProbes(),
            getMigrationStatus: async () => {
                throw new Error('sin tabla de migraciones');
            },
        });
        expect(throwing.status).toBe('degraded');
        expect(throwing.body.checks.migrations.status).toBe('unknown');
    });

    it('(5) DB caída → error + 503 + checks dependientes skipped', async () => {
        const report = await getHealthReport({
            ...okProbes(),
            pingDatabase: async () => {
                throw new Error('connection refused');
            },
        });
        expect(report.status).toBe('error');
        expect(report.httpStatus).toBe(503);
        expect(report.body.checks.database.status).toBe('down');
        expect(report.body.checks.migrations.status).toBe('skipped');
        expect(report.body.checks.aiProviders.status).toBe('skipped');
    });

    it('(6) la respuesta nunca expone secretos ni connection strings', async () => {
        process.env.DATABASE_URL = 'postgres://user:SECRETO@host:5432/db';
        process.env.DEEPSEEK_API_KEY = 'sk-SECRETO-DEEPSEEK';
        try {
            for (const probes of [
                okProbes(),
                {
                    ...okProbes(),
                    pingDatabase: async () => {
                        throw new Error('conn refused user:SECRETO@host');
                    },
                },
            ]) {
                const body = JSON.stringify((await getHealthReport(probes)).body);
                expect(body).not.toContain('SECRETO');
                expect(body).not.toContain('postgres://');
                expect(body).not.toContain('sk-');
                expect(body).not.toContain(process.env.DEEPSEEK_API_KEY);
            }
        } finally {
            delete process.env.DATABASE_URL;
            delete process.env.DEEPSEEK_API_KEY;
        }
    });
});

describe('GET /api/health — router con probes inyectadas', () => {
    let server: Server | null = null;
    let baseUrl = '';

    const startApp = async () => {
        const app = express();
        app.use('/api/health', healthRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    };

    afterEach(async () => {
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    it('(7) responde el body del reporte con el httpStatus correcto', async () => {
        healthRouteDeps.probes = okProbes();
        await startApp();
        const res = await fetch(`${baseUrl}/api/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            status: string;
            checks: { database: { status: string } };
        };
        expect(body.status).toBe('ok');
        expect(body.checks.database.status).toBe('up');
    });

    it('(7b) DB caída end-to-end → 503 + error', async () => {
        healthRouteDeps.probes = {
            ...okProbes(),
            pingDatabase: async () => {
                throw new Error('down');
            },
        };
        await startApp();
        const res = await fetch(`${baseUrl}/api/health`);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { status: string };
        expect(body.status).toBe('error');
    });
});
