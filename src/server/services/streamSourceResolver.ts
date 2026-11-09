/**
 * streamSourceResolver — resolución una-sola-vez de URL de stream a URL
 * directa de media (PD-02).
 *
 * El recorder llama `resolveStreamUrl` UNA vez por transmisión y le entrega a
 * ffmpeg la URL resuelta (HLS/http/file). Reglas:
 *
 *   - `.m3u8` (o `format=m3u8`) → passthrough directo, sin yt-dlp, kind 'hls'.
 *   - YouTube / Twitch / Kick / Vimeo / Dailymotion / Facebook Live (y URLs
 *     http(s) genéricas) → `yt-dlp`: primero `--get-url`, si falla
 *     `--dump-json` y se toma `url`/`formats`. Para YouTube Live `--get-url`
 *     suele devolver el manifest HLS — es lo que queremos (ffmpeg lo consume
 *     nativo).
 *   - Rutas/`file://` locales → kind 'file', sin yt-dlp.
 *
 * Rotación de proxies (decisión B-1, riesgo R-1): YouTube bloquea IPs de
 * datacenter, así que cada intento de resolución rota al siguiente proxy de
 * `INGEST_PROXY_URLS` (lista separada por comas en env, u `opts.proxyUrls`).
 * El plan de una resolución es `[p_i, p_{i+1}, …, null]`: se prueban todos los
 * proxies y, si agotan, un último intento directo. El índice de arranque rota
 * entre llamadas sólo cuando la lista viene de env; con `opts.proxyUrls`
 * explícita siempre arranca en 0 (determinista, lo usan los tests).
 *
 * Dependencias inyectables (`opts.runner`, `opts.ytDlpPath`) para tests sin
 * red ni procesos reales.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { findBinary } from '../lib/binaries.js';

export interface ResolvedStream {
  /** URL directa que ffmpeg puede abrir (HLS/mp4/http). */
  url: string;
  /** 'hls' | 'http' | 'file' */
  kind: 'hls' | 'http' | 'file';
  /** Metadatos útiles (title, platform, thumbnail). */
  title: string | null;
  platform: string;
  /** Proxy usado (null si fue directo). */
  proxy: string | null;
}

/** Motivo de fallo de resolución — el mensaje del error lo describe en texto. */
export type StreamResolveErrorKind =
  | 'invalid_url'
  | 'no_live'
  | 'blocked'
  | 'timeout'
  | 'missing_binary'
  | 'unknown';

export class StreamResolveError extends Error {
  readonly kind: StreamResolveErrorKind;

  constructor(kind: StreamResolveErrorKind, message: string) {
    super(message);
    this.name = 'StreamResolveError';
    this.kind = kind;
  }
}

/**
 * Runner de yt-dlp inyectable: recibe los args (sin el binario) y devuelve
 * stdout. Debe lanzar un error con `stderr`/`message` descriptivo cuando
 * yt-dlp falla, y un error con `code === 'ENOENT'` si el binario no existe.
 */
export type YtDlpRunner = (args: string[], timeoutMs: number) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** Plataforma detectada por URL — misma tabla que liveDetectorService. */
export function detectStreamPlatform(url: string): string {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('twitch.tv')) return 'twitch';
  if (url.includes('kick.com')) return 'kick';
  if (url.includes('facebook.com')) return 'facebook';
  if (url.includes('vimeo.com')) return 'vimeo';
  if (url.includes('dailymotion.com')) return 'dailymotion';
  return 'generic';
}

/** Lee la lista de proxies: `opts.proxyUrls` o `INGEST_PROXY_URLS` (CSV). */
export function loadProxyUrls(
  explicit?: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = explicit ?? (env.INGEST_PROXY_URLS ?? '').split(',');
  return raw.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Plan de proxies para UNA resolución: la lista rotada por `startIndex` y un
 * intento final directo (`null`) — si todos los proxies fallan, se reintenta
 * sin proxy antes de rendirse. Con lista vacía queda `[null]` (sólo directo).
 */
export function buildProxyPlan(
  proxies: string[],
  startIndex = 0,
): Array<string | null> {
  if (proxies.length === 0) return [null];
  const n = proxies.length;
  const rotated = Array.from({ length: n }, (_, i) => proxies[(startIndex + i) % n]);
  return [...rotated, null];
}

// Cursor a nivel módulo: resoluciones sucesivas con proxies de env arrancan
// en el siguiente proxy (rotación real entre llamadas, no sólo entre reintentos).
let proxyCursor = 0;

/** Resetea el cursor de rotación — sólo para tests. */
export function resetProxyCursorForTests(): void {
  proxyCursor = 0;
}

function isHlsUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('format=m3u8');
}

function classifyResolvedKind(url: string): ResolvedStream['kind'] {
  return isHlsUrl(url) ? 'hls' : 'http';
}

/** Runner real: execFile sin shell, captura stderr en el error lanzado. */
function createExecFileRunner(binaryPath: string): YtDlpRunner {
  return (args, timeoutMs) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        binaryPath,
        args,
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const err = error as Error & { stderr?: string };
            err.stderr = stderr?.toString() ?? '';
            reject(err);
            return;
          }
          resolve(stdout.toString());
        },
      );
    });
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as { stderr?: string }).stderr;
    return `${err.message}\n${stderr ?? ''}`;
  }
  return String(err);
}

function isMissingBinary(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string; message?: string };
  const text = errorText(err);
  return (
    e?.signal === 'SIGTERM' ||
    /timed?\s*out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)
  );
}

/**
 * Clasifica el fallo de yt-dlp en el motivo que exige el brief: binario
 * faltante, timeout, no hay live, bloqueo de plataforma (posible bloqueo de
 * IP de datacenter) o desconocido.
 */
export function classifyYtDlpError(err: unknown): StreamResolveError {
  if (isMissingBinary(err)) {
    return new StreamResolveError(
      'missing_binary',
      'No se encontró el binario yt-dlp (revisá TOOLS_DIR/PATH)',
    );
  }
  const text = errorText(err);
  if (isTimeout(err)) {
    return new StreamResolveError(
      'timeout',
      `Timeout resolviendo la URL del stream: ${text.slice(-200)}`,
    );
  }
  if (
    /is not live|not currently live|offline|will begin|hasn'?t started|premiere|live event will begin/i.test(
      text,
    )
  ) {
    return new StreamResolveError(
      'no_live',
      `No hay live activo en esta URL: ${text.slice(-200)}`,
    );
  }
  if (
    /HTTP Error 4\d\d|Forbidden|Sign in to confirm|not a bot|captcha|account associated|requested content is not available|video is unavailable|Private video|copyright|geo.?block|This live event is not available/i.test(
      text,
    )
  ) {
    return new StreamResolveError(
      'blocked',
      `La plataforma rechazó la resolución (puede ser bloqueo de IP de datacenter): ${text.slice(-200)}`,
    );
  }
  return new StreamResolveError(
    'unknown',
    `yt-dlp no pudo resolver la URL: ${text.slice(-300)}`,
  );
}

const YTDLP_ARGS_BASE = ['--js-runtimes', 'node', '--no-warnings', '--no-playlist'];

interface YtDlpInfo {
  url?: string;
  title?: string;
  fulltitle?: string;
  formats?: Array<{ url?: string; vcodec?: string; acodec?: string; manifest_url?: string }>;
  manifest_url?: string;
}

function pickUrlFromInfo(info: YtDlpInfo): string | null {
  if (typeof info.url === 'string' && info.url.length > 0) return info.url;
  if (typeof info.manifest_url === 'string') return info.manifest_url;
  const formats = info.formats ?? [];
  // Preferir formato con video (o el último disponible con URL).
  const withVideo = [...formats].reverse().find((f) => f.url && f.vcodec !== 'none');
  if (withVideo?.url) return withVideo.url;
  const any = [...formats].reverse().find((f) => f.url);
  return any?.url ?? null;
}

export interface ResolveStreamOptions {
  /** Proxies explícitos (si no, se usa INGEST_PROXY_URLS del env). */
  proxyUrls?: string[];
  /** Timeout por invocación de yt-dlp. Default 30 s. */
  timeoutMs?: number;
  /** Runner inyectable para tests (default: execFile sobre el binario real). */
  runner?: YtDlpRunner;
  /** Path del binario yt-dlp (default: findBinary('yt-dlp')). */
  ytDlpPath?: string;
}

export async function resolveStreamUrl(
  streamUrl: string,
  opts: ResolveStreamOptions = {},
): Promise<ResolvedStream> {
  const url = (streamUrl ?? '').trim();
  if (url.length === 0) {
    throw new StreamResolveError('invalid_url', 'URL de stream vacía');
  }

  // Archivo local o file:// → ffmpeg lo abre directo.
  if (!/^https?:\/\//i.test(url)) {
    const filePath = url.startsWith('file://') ? fileURLToPathSafe(url) : url;
    if (filePath && fs.existsSync(filePath)) {
      return {
        url: filePath,
        kind: 'file',
        title: null,
        platform: 'file',
        proxy: null,
      };
    }
    throw new StreamResolveError(
      'invalid_url',
      `URL inválida o archivo inexistente: ${url.slice(0, 120)}`,
    );
  }

  const platform = detectStreamPlatform(url);

  // HLS genérico: se usa directamente, sin yt-dlp.
  if (isHlsUrl(url)) {
    return { url, kind: 'hls', title: null, platform, proxy: null };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = opts.runner ?? createExecFileRunner(opts.ytDlpPath ?? findBinary('yt-dlp'));

  const proxies = loadProxyUrls(opts.proxyUrls);
  // Con proxies de env el arranque rota entre llamadas; con lista explícita
  // (tests, caller) siempre arranca en el proxy 0.
  const startIndex = opts.proxyUrls === undefined ? proxyCursor++ : 0;
  const plan = buildProxyPlan(proxies, startIndex);

  let lastError: StreamResolveError | null = null;
  let sawBlocked = false;

  for (const proxy of plan) {
    const proxyArgs = proxy ? ['--proxy', proxy] : [];

    // Intento 1: --get-url (devuelve la URL directa).
    try {
      const stdout = await runner(
        [...YTDLP_ARGS_BASE, '--get-url', ...proxyArgs, url],
        timeoutMs,
      );
      const direct = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (direct) {
        return {
          url: direct,
          kind: classifyResolvedKind(direct),
          title: null,
          platform,
          proxy,
        };
      }
      throw new Error('yt-dlp --get-url devolvió salida vacía');
    } catch (err) {
      if (isMissingBinary(err)) throw classifyYtDlpError(err);
      lastError = classifyYtDlpError(err);
      sawBlocked ||= lastError.kind === 'blocked';
    }

    // Intento 2 (mismo proxy): --dump-json y se toma url/formats + metadatos.
    try {
      const stdout = await runner(
        [...YTDLP_ARGS_BASE, '--dump-json', '--no-download', ...proxyArgs, url],
        timeoutMs,
      );
      const info = JSON.parse(stdout) as YtDlpInfo;
      const direct = pickUrlFromInfo(info);
      if (direct) {
        return {
          url: direct,
          kind: classifyResolvedKind(direct),
          title: info.title ?? info.fulltitle ?? null,
          platform,
          proxy,
        };
      }
      throw new Error('yt-dlp --dump-json no devolvió URL utilizable');
    } catch (err) {
      if (isMissingBinary(err)) throw classifyYtDlpError(err);
      lastError = classifyYtDlpError(err);
      sawBlocked ||= lastError.kind === 'blocked';
    }
  }

  // Todos los intentos fallaron. Si alguno fue bloqueo de plataforma, ese
  // motivo es más accionable que el último genérico.
  if (sawBlocked && lastError && lastError.kind !== 'blocked') {
    throw new StreamResolveError(
      'blocked',
      `La plataforma rechazó la resolución tras rotar ${plan.length} intento(s) (puede ser bloqueo de IP de datacenter): ${lastError.message}`,
    );
  }
  throw (
    lastError ??
    new StreamResolveError('unknown', 'yt-dlp no pudo resolver la URL')
  );
}

function fileURLToPathSafe(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  } catch {
    return null;
  }
}
