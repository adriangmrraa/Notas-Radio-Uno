/**
 * streamSources — registry ÚNICO de fuentes de stream soportadas (PD-07).
 *
 * Es la sola fuente de verdad para "¿de qué tipo es esta URL/valor?": el
 * resolver (`detectStreamPlatform`), el detector de live
 * (`liveDetectorService.detectPlatform`) y el servicio de transcripción
 * (`detectSourceType`) delegan acá — cada uno conserva etiquetas extra que
 * el registry no modela (facebook/vimeo/dailymotion en el resolver,
 * 'direct_stream'/'generic' en el detector, 'youtube'/'radio'/'generic' en
 * transcripción) pero las REGLAS de matching viven sólo en este archivo.
 *
 * Buckets:
 *   - youtube / twitch / kick → lives de plataforma; se resuelven con yt-dlp
 *     (`needsResolver`) y rotan proxies (R-1: YouTube bloquea datacenters).
 *   - hls → stream directo consumible por ffmpeg sin yt-dlp: .m3u8, .mp4,
 *     /stream, radio/shoutcast/icecast, .mp3/.aac, puertos típicos. También
 *     es el fallback de TODA URL http(s) que no matchea una plataforma
 *     (detectStreamSource devuelve hls por defecto — el resolver decide
 *     después si hace falta yt-dlp igual).
 *   - upload → NO es una URL: es un archivo subido por el usuario (fallback
 *     VOD de early adopters — `POST /api/transmissions/vod-upload`). No hay
 *     live que detectar ni URL que resolver.
 */
export type StreamSourceKind = 'youtube' | 'twitch' | 'kick' | 'hls' | 'upload';

export interface StreamSourceDef {
  kind: StreamSourceKind;
  label: string;
  /** Detecta si la URL/valor corresponde a esta fuente. */
  matches(input: string): boolean;
  /** true si la fuente requiere yt-dlp para resolver (HLS genérico no). */
  needsResolver: boolean;
  /** Soporta live en vivo (upload no). */
  supportsLive: boolean;
}

/** true si el input es una URL http(s) — único caso que NO es upload. */
export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/**
 * Patrón de stream directo (superset de los criterios que ya tenían
 * `liveDetectorService` y `transcriptionService`): .m3u8 / format=m3u8,
 * archivos de media directos (.mp4/.mp3/.aac), /stream, radio,
 * streamingraddios, shoutcast/icecast y los puertos típicos de radio
 * online (:8000, :8080).
 */
const DIRECT_STREAM_RE =
  /\.m3u8(\?|#|$)|format=m3u8|\.mp4(\?|#|$)|\.mp3(\?|#|$)|\.aac(\?|#|$)|\/stream(\/|\?|#|$)|radio|streamingraddios|shoutcast|icecast|:(8000|8080)/i;

/**
 * true si la URL tiene un patrón de stream directo explícito (distinto del
 * fallback "cualquier http URL es hls"). El detector de live lo usa para
 * conservar su distinción `direct_stream` (live asumido) vs `generic`
 * (hay que probar con yt-dlp).
 */
export function isExplicitStreamUrl(input: string): boolean {
  return isHttpUrl(input) && DIRECT_STREAM_RE.test(input);
}

const YOUTUBE: StreamSourceDef = {
  kind: 'youtube',
  label: 'YouTube / YouTube Live',
  matches: (input) => input.includes('youtube.com') || input.includes('youtu.be'),
  needsResolver: true,
  supportsLive: true,
};

const TWITCH: StreamSourceDef = {
  kind: 'twitch',
  label: 'Twitch',
  matches: (input) => input.includes('twitch.tv'),
  needsResolver: true,
  supportsLive: true,
};

const KICK: StreamSourceDef = {
  kind: 'kick',
  label: 'Kick',
  matches: (input) => input.includes('kick.com'),
  needsResolver: true,
  supportsLive: true,
};

const UPLOAD: StreamSourceDef = {
  kind: 'upload',
  label: 'Video subido (VOD)',
  // Cualquier cosa que no sea una URL http(s) es un archivo subido.
  matches: (input) => !isHttpUrl(input),
  needsResolver: false,
  supportsLive: false,
};

const HLS: StreamSourceDef = {
  kind: 'hls',
  label: 'Stream directo (HLS/genérico)',
  matches: isExplicitStreamUrl,
  needsResolver: false,
  supportsLive: true,
};

/**
 * Orden de matching: plataformas primero (una URL de YouTube no cae en el
 * bucket genérico), después `upload` (todo lo que no es URL) y `hls` al
 * final — es el bucket residual de las URLs http(s) reales.
 */
export const STREAM_SOURCES: readonly StreamSourceDef[] = [
  YOUTUBE,
  TWITCH,
  KICK,
  UPLOAD,
  HLS,
];

const HLS_FALLBACK = HLS;

/**
 * Primera fuente del registry que matchea. Como `upload` captura todo lo
 * no-URL, el fallback sólo ve URLs http(s) sin plataforma ni patrón de
 * stream explícito: esas se clasifican `hls` (stream genérico — el
 * resolver/detector deciden después si hace falta yt-dlp igual).
 */
export function detectStreamSource(input: string): StreamSourceDef {
  const value = (input ?? '').trim();
  for (const source of STREAM_SOURCES) {
    if (source.matches(value)) return source;
  }
  return HLS_FALLBACK;
}
