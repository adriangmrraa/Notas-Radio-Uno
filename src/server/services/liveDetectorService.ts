import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');

function findBinary(name: string): string {
    const toolsPath = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(toolsPath)) return toolsPath;
    return name;
}

const YTDLP = findBinary('yt-dlp');

export interface LiveDetectionResult {
    found: boolean;
    liveUrl: string | null;
    title: string | null;
    platform: string;
    error: string | null;
}

/**
 * Detecta si hay un live stream activo en un canal/URL.
 *
 * Soporta:
 * - YouTube channels/handles → busca live activo
 * - Twitch channels → chequea si está live
 * - Kick channels → chequea si está live
 * - Facebook pages → busca live activo
 * - Direct stream URLs (.m3u8, /stream, etc.) → siempre "found"
 * - Radio streams → siempre "found"
 */
export async function detectLiveStream(channelUrl: string): Promise<LiveDetectionResult> {
    const platform = detectPlatform(channelUrl);

    try {
        switch (platform) {
            case 'youtube':
                return await detectYouTubeLive(channelUrl);
            case 'twitch':
                return await detectTwitchLive(channelUrl);
            case 'kick':
                return await detectGenericLive(channelUrl, 'kick');
            case 'facebook':
                return await detectGenericLive(channelUrl, 'facebook');
            case 'direct_stream':
                return { found: true, liveUrl: channelUrl, title: 'Direct Stream', platform, error: null };
            default:
                return await detectGenericLive(channelUrl, platform);
        }
    } catch (err) {
        return {
            found: false,
            liveUrl: null,
            title: null,
            platform,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

function detectPlatform(url: string): string {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('twitch.tv')) return 'twitch';
    if (url.includes('kick.com')) return 'kick';
    if (url.includes('facebook.com')) return 'facebook';
    if (url.endsWith('.m3u8') || url.endsWith('/stream') || url.endsWith('.mp3') || url.endsWith('.aac') ||
        url.includes('streamingraddios') || url.includes('radio') || url.includes(':8000') || url.includes(':8080')) {
        return 'direct_stream';
    }
    return 'generic';
}

/**
 * YouTube: Usa yt-dlp para buscar live en un canal.
 * Convierte URLs de canal a /live endpoint que apunta al live activo.
 */
async function detectYouTubeLive(channelUrl: string): Promise<LiveDetectionResult> {
    // Normalize to /live URL which auto-redirects to active livestream
    let liveCheckUrl = channelUrl;

    // Handle various YouTube channel URL formats
    if (channelUrl.match(/youtube\.com\/(c\/|channel\/|@)/)) {
        // Channel URL → append /live
        liveCheckUrl = channelUrl.replace(/\/$/, '') + '/live';
    } else if (channelUrl.match(/youtube\.com\/watch\?v=/)) {
        // Already a specific video URL — check if it's live
        liveCheckUrl = channelUrl;
    }

    try {
        // yt-dlp --dump-json checks if the URL resolves to a live stream
        const output = execSync(
            `"${YTDLP}" --dump-json --no-download --no-warnings "${liveCheckUrl}"`,
            { timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );

        const info = JSON.parse(output);
        const isLive = info.is_live === true || info.live_status === 'is_live';

        if (isLive) {
            return {
                found: true,
                liveUrl: info.webpage_url || info.original_url || liveCheckUrl,
                title: info.title || info.fulltitle || null,
                platform: 'youtube',
                error: null,
            };
        }

        return {
            found: false,
            liveUrl: null,
            title: null,
            platform: 'youtube',
            error: 'Canal encontrado pero no hay live activo',
        };
    } catch (err: any) {
        const stderr = err.stderr?.toString() || '';
        if (stderr.includes('is not a video') || stderr.includes('no video') || stderr.includes('This live event will begin')) {
            return { found: false, liveUrl: null, title: null, platform: 'youtube', error: 'No hay live activo en este momento' };
        }
        throw err;
    }
}

/**
 * Twitch: Usa yt-dlp para verificar si el canal está en vivo.
 */
async function detectTwitchLive(channelUrl: string): Promise<LiveDetectionResult> {
    try {
        const output = execSync(
            `"${YTDLP}" --dump-json --no-download --no-warnings "${channelUrl}"`,
            { timeout: 20000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );

        const info = JSON.parse(output);
        return {
            found: true,
            liveUrl: info.webpage_url || channelUrl,
            title: info.title || info.description || null,
            platform: 'twitch',
            error: null,
        };
    } catch {
        return { found: false, liveUrl: null, title: null, platform: 'twitch', error: 'Canal no esta en vivo' };
    }
}

/**
 * Generic: Intenta con yt-dlp para cualquier plataforma soportada.
 */
async function detectGenericLive(url: string, platform: string): Promise<LiveDetectionResult> {
    try {
        const output = execSync(
            `"${YTDLP}" --dump-json --no-download --no-warnings "${url}"`,
            { timeout: 20000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );

        const info = JSON.parse(output);
        const isLive = info.is_live === true || info.live_status === 'is_live';

        return {
            found: isLive || platform === 'direct_stream',
            liveUrl: isLive ? (info.webpage_url || url) : null,
            title: info.title || null,
            platform,
            error: isLive ? null : 'No hay live activo',
        };
    } catch {
        return { found: false, liveUrl: null, title: null, platform, error: 'No se pudo detectar live' };
    }
}
