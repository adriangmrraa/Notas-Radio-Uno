/**
 * Tests del registry de fuentes de stream (PD-07, Parte A).
 *
 * `detectStreamSource` es la única fuente de verdad para "¿de qué tipo es
 * esta URL/valor?": el resolver, el detector de live y la transcripción
 * delegan acá. Los casos del brief:
 *   youtube · twitch · kick · .m3u8 · stream directo genérico · URL
 *   desconocida → hls · input no-URL → upload.
 */
import { describe, expect, it } from 'vitest';

import {
    detectStreamSource,
    isExplicitStreamUrl,
    isHttpUrl,
    STREAM_SOURCES,
    type StreamSourceKind,
} from '../src/server/lib/streamSources';

const kind = (input: string): StreamSourceKind => detectStreamSource(input).kind;

describe('detectStreamSource — plataformas de live', () => {
    it('detecta YouTube (youtube.com y youtu.be)', () => {
        expect(kind('https://www.youtube.com/watch?v=abc123')).toBe('youtube');
        expect(kind('https://youtube.com/live/xyz')).toBe('youtube');
        expect(kind('https://youtu.be/abc123')).toBe('youtube');
    });

    it('detecta Twitch', () => {
        expect(kind('https://www.twitch.tv/canal')).toBe('twitch');
        expect(kind('https://twitch.tv/canal/videos')).toBe('twitch');
    });

    it('detecta Kick', () => {
        expect(kind('https://kick.com/canal')).toBe('kick');
        expect(kind('https://www.kick.com/canal?clip=1')).toBe('kick');
    });
});

describe('detectStreamSource — streams directos / HLS', () => {
    it('detecta una URL .m3u8 como hls', () => {
        expect(kind('https://cdn.example.com/live/index.m3u8')).toBe('hls');
        expect(kind('https://cdn.example.com/master.m3u8?token=abc')).toBe('hls');
        expect(kind('https://example.com/out.m3u8#frag')).toBe('hls');
    });

    it('detecta streams directos genéricos (radio, /stream, .mp4, puertos)', () => {
        expect(kind('https://radio.example.com:8000/stream')).toBe('hls');
        expect(kind('https://videos.example.com/programa.mp4')).toBe('hls');
        expect(kind('https://icecast.example.com/mount')).toBe('hls');
        expect(kind('https://shoutcast.example.com/;')).toBe('hls');
    });

    it('una URL http desconocida cae en el bucket genérico hls', () => {
        expect(kind('https://example.com/cualquier-cosa')).toBe('hls');
        expect(kind('http://stream.algo.tv/live')).toBe('hls');
    });
});

describe('detectStreamSource — upload', () => {
    it('un valor que no es URL http(s) es upload', () => {
        expect(kind('mi-programa.mp4')).toBe('upload');
        expect(kind('C:\\videos\\programa.mkv')).toBe('upload');
        expect(kind('')).toBe('upload');
        expect(kind('   ')).toBe('upload');
        expect(kind('ftp://ejemplo.com/video.mp4')).toBe('upload');
    });
});

describe('metadata del registry', () => {
    it('expone las cinco fuentes con sus capacidades', () => {
        const byKind = new Map(STREAM_SOURCES.map((s) => [s.kind, s]));

        expect(byKind.get('youtube')).toMatchObject({ needsResolver: true, supportsLive: true });
        expect(byKind.get('twitch')).toMatchObject({ needsResolver: true, supportsLive: true });
        expect(byKind.get('kick')).toMatchObject({ needsResolver: true, supportsLive: true });
        expect(byKind.get('hls')).toMatchObject({ needsResolver: false, supportsLive: true });
        expect(byKind.get('upload')).toMatchObject({ needsResolver: false, supportsLive: false });
    });

    it('devuelve la def del registry (misma instancia — fuente única de verdad)', () => {
        const def = detectStreamSource('https://www.youtube.com/x');
        expect(STREAM_SOURCES).toContain(def);
        expect(def.kind).toBe('youtube');
    });

    it('una plataforma nunca cae en el bucket genérico aunque tenga patrones directos', () => {
        // youtube.com contiene "youtu..." — el orden del registry decide.
        expect(kind('https://www.youtube.com/stream/abc')).toBe('youtube');
    });
});

describe('helpers del registry', () => {
    it('isHttpUrl sólo acepta http/https', () => {
        expect(isHttpUrl('https://a.com')).toBe(true);
        expect(isHttpUrl('http://a.com')).toBe(true);
        expect(isHttpUrl('  https://a.com  ')).toBe(true);
        expect(isHttpUrl('ftp://a.com')).toBe(false);
        expect(isHttpUrl('a.com')).toBe(false);
    });

    it('isExplicitStreamUrl distingue patrón directo de URL genérica', () => {
        expect(isExplicitStreamUrl('https://a.com/x.m3u8')).toBe(true);
        expect(isExplicitStreamUrl('https://a.com/pagina')).toBe(false);
        expect(isExplicitStreamUrl('archivo.m3u8')).toBe(false); // no es URL
    });
});
