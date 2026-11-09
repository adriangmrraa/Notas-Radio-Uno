import crypto from 'crypto';

// ---------------------------------------------------------------------------
// mediaSigner — tokens firmados de corta vida para /internal/media (D13)
// El engine sirve media privada SOLO con token válido; el api proxy/redirect
// firma URLs para clientes autenticados. Token = `${exp}.${hmac_b64url}`.
// ---------------------------------------------------------------------------

const SECRET = process.env.MEDIA_SIGNING_SECRET || process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DEFAULT_TTL_SEC = 300; // 5 min

function hmac(relPath: string, exp: number): string {
    return crypto
        .createHmac('sha256', SECRET)
        .update(`${relPath}|${exp}`)
        .digest('base64url');
}

export interface SignedMediaToken {
    token: string;
    expiresAt: number;
}

/** Firma una ruta RELATIVA dentro de MEDIA_ROOT. */
export function signMediaToken(relPath: string, ttlSec: number = DEFAULT_TTL_SEC): SignedMediaToken {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return { token: `${exp}.${hmac(relPath, exp)}`, expiresAt: exp };
}

/** Verifica timing-safe. Devuelve true si el token es válido y no expiró. */
export function verifyMediaToken(relPath: string, token: string | undefined | null): boolean {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;

    const exp = Number(token.slice(0, dot));
    const sig = token.slice(dot + 1);
    if (!Number.isFinite(exp) || !sig) return false;
    if (exp < Math.floor(Date.now() / 1000)) return false;

    const expected = hmac(relPath, exp);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** URL firmada lista para el engine interno. */
export function signedMediaUrl(engineBaseUrl: string, relPath: string, ttlSec: number = DEFAULT_TTL_SEC): string {
    const { token } = signMediaToken(relPath, ttlSec);
    const base = engineBaseUrl.replace(/\/$/, '');
    return `${base}/internal/media/${encodeURI(relPath)}?t=${encodeURIComponent(token)}`;
}
