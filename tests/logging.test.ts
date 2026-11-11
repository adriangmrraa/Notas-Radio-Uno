/**
 * Tests del slice PI-02: logger estructurado + request-id + trazabilidad.
 *
 * Deterministas: sin DB, sin red externa (el server HTTP de las pruebas del
 * middleware se levanta en 127.0.0.1 con puerto efímero — patrón
 * publishJobs.test.ts), sin timers (`vi.waitFor` para el finish-log) y sin
 * mocks de módulos: el logger, el contexto y el middleware no tocan `db`.
 *
 * Casos obligatorios del brief (§3.5):
 *   1.  Formato JSON en producción.
 *   2.  Formato legible fuera de producción.
 *   3.  Nivel: LOG_LEVEL filtra lo que está por debajo.
 *   4.  Redacción de claves sensibles.
 *   5.  Redacción de URL de Postgres con credenciales.
 *   6.  requestId automático desde el contexto.
 *   7.  Middleware: request-id generado (uuid v4) cuando no viene header.
 *   8.  Middleware: request-id válido se adopta.
 *   9.  Middleware: request-id inválido se reemplaza, sin romper la request.
 *   10. Middleware: finish-log con method/path/status/durationMs/requestId.
 *   11. log.child({ transmissionId }) combina con el contexto.
 *   12. Contexto anidado: el interno gana; al salir vuelve el externo.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { log } from '../src/server/lib/logger';
import {
    getRequestContext,
    runWithRequestContext,
    setRequestContext,
} from '../src/server/lib/requestContext';
import { requestIdMiddleware } from '../src/server/middleware/requestId';

const UUID_V4_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Captura TODA línea emitida vía console.log/warn/error (el sink del logger). */
function captureLogLines(): string[] {
    const lines: string[] = [];
    const push = (...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(push);
    vi.spyOn(console, 'warn').mockImplementation(push);
    vi.spyOn(console, 'error').mockImplementation(push);
    return lines;
}

/** Parsea las líneas JSON capturadas (ignora las que no parsean). */
function jsonLines(lines: string[]): Array<Record<string, unknown>> {
    return lines
        .map((line) => {
            try {
                return JSON.parse(line) as Record<string, unknown>;
            } catch {
                return null;
            }
        })
        .filter((o): o is Record<string, unknown> => o !== null);
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

// ─── Logger: formato, nivel y redacción ─────────────────────────────────────

describe('logger — formatos y nivel', () => {
    it('1. producción: una línea JSON por evento con ts/level/msg/fields', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        log.info('x', { a: 1 });
        expect(lines).toHaveLength(1);
        const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
        expect(parsed.level).toBe('info');
        expect(parsed.msg).toBe('x');
        expect(parsed.a).toBe(1);
        expect(typeof parsed.ts).toBe('string');
        expect(Number.isNaN(Date.parse(parsed.ts as string))).toBe(false);
    });

    it('2. fuera de producción: línea legible con nivel, msg y campos', () => {
        vi.stubEnv('NODE_ENV', 'development');
        const lines = captureLogLines();
        log.info('hola mundo', { a: 1, b: 'dos' });
        expect(lines).toHaveLength(1);
        expect(() => JSON.parse(lines[0])).toThrow();
        expect(lines[0]).toContain('INFO');
        expect(lines[0]).toContain('hola mundo');
        expect(lines[0]).toContain('a=1');
        expect(lines[0]).toContain('b=dos');
    });

    it('3. LOG_LEVEL filtra: debug con nivel info no emite; con debug sí', () => {
        vi.stubEnv('LOG_LEVEL', 'info');
        let lines = captureLogLines();
        log.debug('no debería verse');
        expect(lines).toHaveLength(0);
        vi.restoreAllMocks();

        vi.stubEnv('LOG_LEVEL', 'debug');
        lines = captureLogLines();
        log.debug('ahora sí');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('ahora sí');
    });
});

describe('logger — redacción de secretos', () => {
    it('4. claves sensibles salen como [REDACTED] (password, apiKey, Authorization)', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        log.info('m', {
            password: 'pw-SEKRET-9',
            apiKey: 'ak-SEKRET-9',
            Authorization: 'Bearer hdr-SEKRET-9',
        });
        expect(lines).toHaveLength(1);
        const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
        expect(parsed.password).toBe('[REDACTED]');
        expect(parsed.apiKey).toBe('[REDACTED]');
        expect(parsed.Authorization).toBe('[REDACTED]');
        expect(lines[0]).not.toContain('SEKRET-9');
        expect(lines[0]).not.toContain('Bearer');
    });

    it('5. una URL de Postgres con credenciales se redacta en cualquier clave', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        log.info('m', { detail: 'postgres://admin:sup3r-cr3dencial@db.host:5432/app' });
        const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
        expect(lines[0]).not.toContain('sup3r-cr3dencial');
        expect(parsed.detail).toBe('postgres://[REDACTED]@db.host:5432/app');
    });

    it('Error como campo serializa message+stack, nunca [object Object]', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        log.error('falló', { err: new Error('boom-xyz') });
        const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
        const err = parsed.err as Record<string, unknown>;
        expect(err.message).toBe('boom-xyz');
        expect(typeof err.stack).toBe('string');
        expect(lines[0]).not.toContain('[object Object]');
    });
});

// ─── Contexto: requestId, trazabilidad y anidado ────────────────────────────

describe('request context — inyección automática', () => {
    it('6. dentro de runWithRequestContext las líneas llevan requestId', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        runWithRequestContext({ requestId: 'abc' }, () => log.info('m'));
        const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
        expect(parsed.requestId).toBe('abc');
        expect(parsed.msg).toBe('m');
    });

    it('11. log.child({transmissionId}) combina con el requestId del contexto', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        runWithRequestContext({ requestId: 'r-1' }, () => {
            log.child({ transmissionId: 'tx-1' }).info('corte de stream');
            log.info('sin child');
        });
        const parsed = jsonLines(lines);
        expect(parsed).toHaveLength(2);
        expect(parsed[0].transmissionId).toBe('tx-1');
        expect(parsed[0].requestId).toBe('r-1');
        expect(parsed[1].transmissionId).toBeUndefined();
        expect(parsed[1].requestId).toBe('r-1');
    });

    it('12. contexto anidado: el interno gana y no se filtra al padre', () => {
        const seen: Array<Record<string, unknown>> = [];
        runWithRequestContext({ requestId: 'outer' }, () => {
            seen.push({ ...getRequestContext() });
            runWithRequestContext({ requestId: 'inner' }, () => {
                setRequestContext({ tenantId: 't-inner' });
                seen.push({ ...getRequestContext() });
            });
            seen.push({ ...getRequestContext() });
        });
        expect(seen[0].requestId).toBe('outer');
        expect(seen[1].requestId).toBe('inner');
        expect(seen[1].tenantId).toBe('t-inner');
        // Al salir, el externo vuelve intacto — nada del scope interno se filtra.
        expect(seen[2].requestId).toBe('outer');
        expect(seen[2].tenantId).toBeUndefined();
        expect(getRequestContext()).toBeUndefined();
    });
});

// ─── Middleware: request-id + finish-log ────────────────────────────────────

describe('requestIdMiddleware', () => {
    let server: Server | null = null;
    let baseUrl = '';

    const startApp = async (withAuth = false) => {
        const app = express();
        app.use(requestIdMiddleware);
        if (withAuth) {
            // Fake del orden real (middleware → optionalAuth): puebla req.auth
            // y empuja el tenant al contexto como hace authz.optionalAuth.
            app.use((req: Request, _res: Response, next: NextFunction) => {
                req.auth = {
                    userId: 'u-1',
                    tenantId: 'tenant-xyz',
                    email: 't@t.com',
                    role: 'owner',
                } as Request['auth'];
                setRequestContext({ tenantId: 'tenant-xyz' });
                next();
            });
        }
        app.get('/api/ping', (_req: Request, res: Response) => {
            res.json({ ok: true });
        });
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };

    const finishLog = async (lines: string[]) => {
        await vi.waitFor(() => {
            expect(
                jsonLines(lines).some((l) => l.msg === 'http.request'),
            ).toBe(true);
        });
        return jsonLines(lines).find((l) => l.msg === 'http.request')!;
    };

    afterEach(async () => {
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    it('7. sin header: genera uuid v4, lo devuelve y el finish-log lo incluye', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        await startApp();
        const res = await fetch(`${baseUrl}/api/ping`);
        expect(res.status).toBe(200);
        const requestId = res.headers.get('x-request-id');
        expect(requestId).toMatch(UUID_V4_RE);
        const entry = await finishLog(lines);
        expect(entry.requestId).toBe(requestId);
    });

    it('8. con X-Request-Id válido: lo adopta y el finish-log lo incluye', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        await startApp();
        const res = await fetch(`${baseUrl}/api/ping`, {
            headers: { 'x-request-id': 'corr-123' },
        });
        expect(res.headers.get('x-request-id')).toBe('corr-123');
        const entry = await finishLog(lines);
        expect(entry.requestId).toBe('corr-123');
    });

    it('9. con X-Request-Id inválido: genera uno nuevo y la request no falla', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        await startApp();
        const res = await fetch(`${baseUrl}/api/ping`, {
            headers: { 'x-request-id': 'bad id!' },
        });
        expect(res.status).toBe(200);
        const requestId = res.headers.get('x-request-id');
        expect(requestId).toMatch(UUID_V4_RE);
        expect(requestId).not.toBe('bad id!');
        const entry = await finishLog(lines);
        expect(entry.requestId).toBe(requestId);
    });

    it('9b. un request-id de 200 chars también se reemplaza', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        await startApp();
        const res = await fetch(`${baseUrl}/api/ping`, {
            headers: { 'x-request-id': 'a'.repeat(200) },
        });
        expect(res.status).toBe(200);
        const requestId = res.headers.get('x-request-id');
        expect(requestId).toMatch(UUID_V4_RE);
        const entry = await finishLog(lines);
        expect(entry.requestId).toBe(requestId);
    });

    it('10. el finish-log trae method, path, status, durationMs y requestId (+tenantId si hay auth)', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const lines = captureLogLines();
        await startApp(true);
        const res = await fetch(`${baseUrl}/api/ping?token=no-se-loguea`);
        expect(res.status).toBe(200);
        const entry = await finishLog(lines);
        expect(entry.method).toBe('GET');
        expect(entry.path).toBe('/api/ping');
        expect(entry.status).toBe(200);
        expect(typeof entry.durationMs).toBe('number');
        expect(typeof entry.requestId).toBe('string');
        expect(entry.tenantId).toBe('tenant-xyz');
        // La query NUNCA se loguea (puede llevar tokens).
        expect(lines.join('\n')).not.toContain('no-se-loguea');
    });
});
