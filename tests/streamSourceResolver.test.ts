/**
 * Tests del slice PD-02: `streamSourceResolver.ts`.
 *
 * Sin red y sin yt-dlp real: el runner se inyecta como fake que cuenta
 * invocaciones y captura args. Cubre:
 *   - passthrough de .m3u8 sin invocar yt-dlp,
 *   - YouTube → yt-dlp con --proxy cuando hay proxies,
 *   - rotación completa de proxies + intento final directo,
 *   - URL inválida → error descriptivo,
 *   - clasificación de errores y parseo de --dump-json.
 */
import { describe, expect, it } from 'vitest';

import {
    buildProxyPlan,
    classifyYtDlpError,
    loadProxyUrls,
    resetProxyCursorForTests,
    resolveStreamUrl,
    StreamResolveError,
    type YtDlpRunner,
} from '../src/server/services/streamSourceResolver';

interface FakeCall {
    args: string[];
}

function makeRunner(handler: (args: string[], call: number) => string | Error) {
    const calls: FakeCall[] = [];
    const runner: YtDlpRunner = async (args) => {
        const call = calls.length;
        calls.push({ args });
        const out = handler(args, call);
        if (out instanceof Error) throw out;
        return out;
    };
    return { runner, calls };
}

function proxyOf(args: string[]): string | null {
    const i = args.indexOf('--proxy');
    return i === -1 ? null : args[i + 1];
}

describe('buildProxyPlan', () => {
    it('sin proxies → un solo intento directo', () => {
        expect(buildProxyPlan([])).toEqual([null]);
    });

    it('rota por startIndex y agrega el intento directo al final', () => {
        expect(buildProxyPlan(['p0', 'p1'], 0)).toEqual(['p0', 'p1', null]);
        expect(buildProxyPlan(['p0', 'p1'], 1)).toEqual(['p1', 'p0', null]);
        expect(buildProxyPlan(['p0', 'p1', 'p2'], 2)).toEqual(['p2', 'p0', 'p1', null]);
    });
});

describe('loadProxyUrls', () => {
    it('parsea INGEST_PROXY_URLS como CSV, trim y sin vacíos', () => {
        const env = { INGEST_PROXY_URLS: ' http://a:8080 ,http://b ,,' } as NodeJS.ProcessEnv;
        expect(loadProxyUrls(undefined, env)).toEqual(['http://a:8080', 'http://b']);
    });

    it('lista explícita tiene precedencia sobre env', () => {
        const env = { INGEST_PROXY_URLS: 'http://env' } as NodeJS.ProcessEnv;
        expect(loadProxyUrls(['http://opt'], env)).toEqual(['http://opt']);
        expect(loadProxyUrls([], env)).toEqual([]);
    });
});

describe('resolveStreamUrl — passthrough sin yt-dlp', () => {
    it('URL .m3u8 → kind hls y NUNCA invoca yt-dlp', async () => {
        const { runner, calls } = makeRunner(() => new Error('no debería llamarse'));
        const out = await resolveStreamUrl('https://cdn.example.com/live/index.m3u8', {
            runner,
            proxyUrls: ['http://proxy1:8080'],
        });
        expect(out.kind).toBe('hls');
        expect(out.url).toBe('https://cdn.example.com/live/index.m3u8');
        expect(out.proxy).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('URL con format=m3u8 también es passthrough', async () => {
        const { runner, calls } = makeRunner(() => 'unreachable');
        const out = await resolveStreamUrl('https://x.example.com/stream?format=m3u8', { runner });
        expect(out.kind).toBe('hls');
        expect(calls).toHaveLength(0);
    });
});

describe('resolveStreamUrl — yt-dlp con proxies', () => {
    it('YouTube + proxies configurados → primer intento usa el proxy 0 con --get-url', async () => {
        const { runner, calls } = makeRunner(() => 'https://manifest.googlevideo.com/hls.m3u8\n');
        const out = await resolveStreamUrl('https://www.youtube.com/watch?v=abc12345678', {
            runner,
            proxyUrls: ['http://proxy-a:8080', 'http://proxy-b:8080'],
        });
        expect(calls.length).toBe(1);
        expect(calls[0].args).toContain('--get-url');
        expect(proxyOf(calls[0].args)).toBe('http://proxy-a:8080');
        expect(out.url).toBe('https://manifest.googlevideo.com/hls.m3u8');
        // El manifest HLS que devuelve yt-dlp para YouTube Live → kind hls.
        expect(out.kind).toBe('hls');
        expect(out.platform).toBe('youtube');
        expect(out.proxy).toBe('http://proxy-a:8080');
    });

    it('sin proxies → intento directo sin --proxy', async () => {
        const { runner, calls } = makeRunner(() => 'https://cdn.example.com/v.mp4');
        const out = await resolveStreamUrl('https://www.twitch.tv/somechannel', {
            runner,
            proxyUrls: [],
        });
        expect(calls.length).toBe(1);
        expect(proxyOf(calls[0].args)).toBeNull();
        expect(out.proxy).toBeNull();
        expect(out.kind).toBe('http');
    });

    it('rotación: p0 falla → p1 → ambos fallan → último intento sin proxy', async () => {
        const { runner, calls } = makeRunner(() => new Error('HTTP Error 403: Forbidden'));
        await expect(
            resolveStreamUrl('https://www.youtube.com/watch?v=abc12345678', {
                runner,
                proxyUrls: ['http://p0', 'http://p1'],
            }),
        ).rejects.toBeInstanceOf(StreamResolveError);

        // Cada proxy agota --get-url + --dump-json antes de rotar.
        const proxies = calls.map((c) => proxyOf(c.args));
        expect(proxies).toEqual([
            'http://p0', 'http://p0',
            'http://p1', 'http://p1',
            null, null,
        ]);
        const getUrlCalls = calls.filter((c) => c.args.includes('--get-url'));
        expect(getUrlCalls.map((c) => proxyOf(c.args))).toEqual(['http://p0', 'http://p1', null]);
    });

    it('si el primer proxy falla y el segundo resuelve, devuelve proxy usado', async () => {
        let call = 0;
        const { runner, calls } = makeRunner(() => {
            call += 1;
            // get-url(p0) falla, dump-json(p0) falla, get-url(p1) OK.
            return call <= 2 ? new Error('timeout') : 'https://cdn.example.com/hls/index.m3u8';
        });
        const out = await resolveStreamUrl('https://www.youtube.com/watch?v=abc12345678', {
            runner,
            proxyUrls: ['http://p0', 'http://p1'],
        });
        expect(out.proxy).toBe('http://p1');
        expect(calls.map((c) => proxyOf(c.args))).toEqual(['http://p0', 'http://p0', 'http://p1']);
    });

    it('con proxies de env el arranque rota entre llamadas sucesivas', async () => {
        resetProxyCursorForTests();
        const env = process.env;
        const prev = env.INGEST_PROXY_URLS;
        env.INGEST_PROXY_URLS = 'http://p0,http://p1';
        try {
            const { runner, calls } = makeRunner(() => 'https://cdn.example.com/x.m3u8');
            await resolveStreamUrl('https://www.youtube.com/watch?v=abc12345678', { runner });
            await resolveStreamUrl('https://www.youtube.com/watch?v=abc12345678', { runner });
            // Primera resolución arranca en p0, la segunda rota y arranca en p1.
            expect(proxyOf(calls[0].args)).toBe('http://p0');
            expect(proxyOf(calls[1].args)).toBe('http://p1');
        } finally {
            if (prev === undefined) delete env.INGEST_PROXY_URLS;
            else env.INGEST_PROXY_URLS = prev;
            resetProxyCursorForTests();
        }
    });
});

describe('resolveStreamUrl — dump-json fallback y metadatos', () => {
    it('si --get-url falla, usa --dump-json y toma url + title', async () => {
        const { runner, calls } = makeRunner((args) => {
            if (args.includes('--get-url')) return new Error('extractor roto');
            return JSON.stringify({
                url: 'https://cdn.example.com/vod.mp4',
                title: 'Mi stream',
            });
        });
        const out = await resolveStreamUrl('https://vimeo.com/12345', { runner });
        expect(out.url).toBe('https://cdn.example.com/vod.mp4');
        expect(out.kind).toBe('http');
        expect(out.title).toBe('Mi stream');
        expect(out.platform).toBe('vimeo');
        expect(calls).toHaveLength(2);
    });
});

describe('resolveStreamUrl — errores', () => {
    it('URL vacía → invalid_url', async () => {
        await expect(resolveStreamUrl('   ', { runner: async () => '' })).rejects.toMatchObject({
            name: 'StreamResolveError',
            kind: 'invalid_url',
        });
    });

    it('URL inválida (no http, archivo inexistente) → error descriptivo', async () => {
        await expect(
            resolveStreamUrl('definitivamente-no-es-url', { runner: async () => '' }),
        ).rejects.toThrow(/URL inválida|archivo inexistente/i);
    });

    it('bloqueo de plataforma → kind blocked con mención a IP de datacenter', async () => {
        const { runner } = makeRunner(() => new Error('HTTP Error 403: Forbidden'));
        await expect(
            resolveStreamUrl('https://www.youtube.com/watch?v=abc12345678', {
                runner,
                proxyUrls: [],
            }),
        ).rejects.toThrow(/datacenter/i);
    });

    it('binario faltante (ENOENT) → missing_binary sin rotar', async () => {
        const enoent = Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
        const { runner, calls } = makeRunner(() => enoent);
        await expect(
            resolveStreamUrl('https://www.youtube.com/watch?v=x', {
                runner,
                proxyUrls: ['http://p0', 'http://p1'],
            }),
        ).rejects.toMatchObject({ kind: 'missing_binary' });
        // ENOENT no rota proxies: el binario no va a aparecer en el próximo intento.
        expect(calls).toHaveLength(1);
    });
});

describe('classifyYtDlpError', () => {
    it('distingue timeout, no-live, blocked y desconocido', () => {
        expect(classifyYtDlpError(Object.assign(new Error('timed out'), { signal: 'SIGTERM' })).kind).toBe('timeout');
        expect(classifyYtDlpError(new Error('This live event will begin in a few moments')).kind).toBe('no_live');
        expect(classifyYtDlpError(new Error('Sign in to confirm you’re not a bot')).kind).toBe('blocked');
        expect(classifyYtDlpError(new Error('wut')).kind).toBe('unknown');
        expect(classifyYtDlpError(Object.assign(new Error('x'), { code: 'ENOENT' })).kind).toBe('missing_binary');
    });
});
