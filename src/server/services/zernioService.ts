/**
 * zernioService — Cliente HTTP de la API de Zernio (PG-04).
 *
 * Wrapper fino sobre `https://zernio.com/api/v1` con
 * `Authorization: Bearer <ZERNIO_API_KEY>`. La API key es DE LA PLATAFORMA
 * (una sola, por env): los tenants no tienen key propia — se aíslan por
 * `profileId` (un perfil Zernio por tenant, externalId = tenantId).
 *
 * Reglas duras:
 *   - La API key NUNCA se loguea, nunca sale por API, nunca se escribe en
 *     DB ni en errores. Toda cadena que pueda tocar un error/log se pasa por
 *     `redact()`, que enmascara la key si apareciera.
 *   - Si `ZERNIO_API_KEY` no está configurada, NADA se rompe al importar:
 *     el módulo carga igual y sólo falla en runtime, al usarse, con
 *     `AppError` 503 `zernio_not_configured`.
 *   - Errores de Zernio se mapean a `AppError` con el `code` legible por
 *     máquina que devuelve la API (`profile_not_found`, `account_not_found`,
 *     `idempotency_conflict`, …) y `details` adjunto cuando viene.
 *
 * Inyectable para tests (`ZernioDeps`): `apiKey`, `baseUrl`, `fetchFn` y
 * `timeoutMs` — los tests nunca pegan a la red real.
 *
 * Referencia verificada: BRIEF-ZERNIO-API.md + https://zernio.com/openapi.yaml.
 */
import { AppError } from '../lib/errors.js';

export const ZERNIO_DEFAULT_BASE_URL = 'https://zernio.com/api/v1';
const DEFAULT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Modelos (shape normalizado de la API — ids opacos, nunca credenciales)
// ---------------------------------------------------------------------------

export interface ZernioProfile {
    /** `_id` del perfil en Zernio. */
    id: string;
    name: string | null;
    externalId: string | null;
}

export type ZernioAccountStatus = 'connected' | 'disconnected';

export interface ZernioAccount {
    /** `_id` de la cuenta EN ZERNIO — el `accountId` de /v1/posts. */
    id: string;
    platform: string;
    username: string | null;
    displayName: string | null;
    /** Perfil Zernio dueño de la cuenta. */
    profileId: string | null;
    enabled: boolean | null;
    /**
     * 'disconnected' cuando la plataforma reportó el token muerto
     * (`needsReconnection`/`isActive=false` en la API, o `status` explícito).
     */
    status: ZernioAccountStatus;
}

export interface ZernioConnectResult {
    authUrl: string;
    state?: string;
}

// ---------------------------------------------------------------------------
// Publicación (PG-05): POST /v1/posts + retry remoto
// ---------------------------------------------------------------------------

/** Estados del post que reporta Zernio (Post.status). */
export type ZernioPostStatus =
    | 'draft'
    | 'pending_approval'
    | 'scheduled'
    | 'publishing'
    | 'published'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | (string & {});

/** Estado de cada platform entry dentro del post. */
export type ZernioPlatformEntryStatus =
    | 'pending'
    | 'processing'
    | 'uploading'
    | 'published'
    | 'failed'
    | 'cancelled'
    | (string & {});

export interface ZernioPostPlatformEntry {
    platform: string;
    /** `_id` de la cuenta en Zernio — puede venir null en entradas raras. */
    accountId: string | null;
    status: ZernioPlatformEntryStatus;
    /** URL pública del post en la red (cuando la plataforma la devolvió). */
    platformPostUrl: string | null;
    errorMessage: string | null;
    /** Taxonomía de error de Zernio (auth_expired, user_content, …). */
    errorCategory: string | null;
    /** 'user' | 'platform' | 'system'. */
    errorSource: string | null;
}

export interface ZernioPost {
    /** `_id` del post en Zernio — llave del retry remoto. */
    id: string;
    status: ZernioPostStatus;
    platforms: ZernioPostPlatformEntry[];
}

/**
 * Resultado normalizado de publishPost/retryPost. `httpStatus` conserva el
 * código real porque la semántica cambia con él:
 *   201 → creado · 200 → replay idempotente (Idempotency-Key conocida,
 *   NO creó un post nuevo) · 202 → creado pero X quedó esperando fondos ·
 *   207 → publicación parcial entre plataformas.
 * `post` es null sólo si la API respondió 2xx sin body de post (caso
 * anómalo — el caller lo decide, no se asume éxito).
 */
export interface ZernioPublishResult {
    httpStatus: number;
    /** true cuando el 200 fue replay de la Idempotency-Key original. */
    idempotentReplay: boolean;
    post: ZernioPost | null;
}

export interface ZernioPublishInput {
    profileId: string;
    content: string;
    /** Un destino por plataforma/cuenta — {platform, accountId}. */
    platforms: Array<{ platform: string; accountId: string }>;
    mediaUrls?: string[];
    /** publicNow=true XOR scheduledFor (ISO) — siempre uno de los dos. */
    publishNow?: boolean;
    scheduledFor?: string;
    /** Header Idempotency-Key — la key persistente del publish job. */
    idempotencyKey?: string;
}

/** Detalle estructurado del error de la API (details.existingProfileId, …). */
export type ZernioErrorDetails = Record<string, unknown> | undefined;

export interface ZernioApi {
    /** GET /v1/profiles?externalId= — null si el tenant no tiene perfil. */
    findProfileByExternalId(externalId: string): Promise<ZernioProfile | null>;
    /** POST /v1/profiles — 201 con { profile }. Soporta Idempotency-Key. */
    createProfile(input: {
        name: string;
        externalId: string;
        idempotencyKey?: string;
    }): Promise<ZernioProfile>;
    /** GET /v1/connect/{platform} — authUrl (welcome/brand opcionales). */
    getConnectUrl(input: {
        profileId: string;
        platform: string;
        redirectUrl: string;
        welcome?: boolean;
        brandName?: string;
        logoUrl?: string;
        primaryColor?: string;
    }): Promise<ZernioConnectResult>;
    /** GET /v1/accounts?profileId= — cuentas que Zernio reporta del perfil. */
    listAccounts(profileId: string): Promise<ZernioAccount[]>;
    /** DELETE /v1/accounts/{accountId} — 404 si ya estaba desconectada. */
    disconnectAccount(accountId: string): Promise<void>;
    /**
     * POST /v1/posts — publica contenido en una o varias cuentas del perfil.
     * Conserva el HTTP status (201/200/202/207) en el resultado; los 4xx/5xx
     * siguen saliendo como AppError con el `code` de la API. Idempotente
     * vía `idempotencyKey` → header Idempotency-Key.
     */
    publishPost(input: ZernioPublishInput): Promise<ZernioPublishResult>;
    /** POST /v1/posts/{postId}/retry — reintenta las plataformas fallidas. */
    retryPost(postId: string): Promise<ZernioPublishResult>;
}

export interface ZernioDeps {
    /** Default: process.env.ZERNIO_API_KEY (resuelto por llamada). */
    apiKey?: string;
    /** Default: https://zernio.com/api/v1 */
    baseUrl?: string;
    /** Default: fetch global — los tests inyectan un stub. */
    fetchFn?: typeof fetch;
    /** Default: 15000 ms. */
    timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

type ZernioAppError = AppError & { details?: ZernioErrorDetails };

const resolveKey = (deps: ZernioDeps): string | undefined =>
    deps.apiKey !== undefined ? deps.apiKey : process.env.ZERNIO_API_KEY;

/** Enmascara la API key en cualquier texto que pueda llegar a un log/error. */
const redact = (text: string, apiKey: string | undefined): string =>
    apiKey ? text.split(apiKey).join('[redacted]') : text;

const toAppError = (
    error: unknown,
    apiKey: string | undefined,
    fallback: string,
): AppError => {
    if (error instanceof AppError) return error;
    const message = redact(
        error instanceof Error ? error.message : fallback,
        apiKey,
    );
    const appError: ZernioAppError = new AppError(message, 503, 'zernio_unavailable');
    return appError;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;

const asString = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

// ---------------------------------------------------------------------------
// createZernioApi — implementación fetch
// ---------------------------------------------------------------------------

export function createZernioApi(deps: ZernioDeps = {}): ZernioApi {
    const fetchFn = deps.fetchFn ?? fetch;
    const baseUrl = (deps.baseUrl ?? ZERNIO_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    /**
     * Única vía de salida a la red. Resuelve la API key POR LLAMADA (así un
     * proceso arrancado sin env y luego configurado funciona sin reiniciar
     * la importación, y los tests controlan el caso "sin key").
     *
     * `requestRaw` devuelve `{status, payload}` — los 4xx/5xx siguen siendo
     * AppError; publishPost necesita el status real porque 200/201/202/207
     * significan cosas distintas. `request` lo envuelve para los métodos
     * clásicos que no les importa el status.
     */
    async function requestRaw(
        method: string,
        path: string,
        options: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<{ status: number; payload: unknown }> {
        const apiKey = resolveKey(deps);
        if (!apiKey) {
            throw new AppError(
                'La integración con Zernio no está configurada (falta ZERNIO_API_KEY)',
                503,
                'zernio_not_configured',
            );
        }

        const url = new URL(`${baseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            url.searchParams.set(key, value);
        }

        let res: Response;
        try {
            res = await fetchFn(url.toString(), {
                method,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    ...options.headers,
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw toAppError(error, apiKey, 'Zernio no responde');
        }

        let payload: unknown = null;
        const text = await res.text().catch(() => '');
        if (text) {
            try {
                payload = JSON.parse(text);
            } catch {
                payload = null;
            }
        }

        if (!res.ok) {
            const body = isRecord(payload) ? payload : {};
            const code = asString(body.code) ?? 'zernio_error';
            const rawMessage =
                asString(body.error) ?? asString(body.message) ?? `Zernio respondió HTTP ${res.status}`;
            const status = res.status >= 400 && res.status < 600 ? res.status : 502;
            const appError: ZernioAppError = new AppError(
                redact(rawMessage, apiKey),
                status,
                code,
            );
            if (isRecord(body.details)) appError.details = body.details;
            throw appError;
        }

        return { status: res.status, payload };
    }

    async function request<T>(
        method: string,
        path: string,
        options: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
    ): Promise<T> {
        const { payload } = await requestRaw(method, path, options);
        return payload as T;
    }

    const parseProfile = (raw: unknown): ZernioProfile | null => {
        if (!isRecord(raw)) return null;
        const id = asString(raw._id) ?? asString(raw.id);
        if (!id) return null;
        return {
            id,
            name: asString(raw.name),
            externalId: asString(raw.externalId),
        };
    };

    const parseAccount = (raw: unknown): ZernioAccount | null => {
        if (!isRecord(raw)) return null;
        const id = asString(raw._id) ?? asString(raw.id);
        const platform = asString(raw.platform);
        if (!id || !platform) return null;
        const rawProfileId = raw.profileId;
        const profileId =
            asString(rawProfileId) ??
            (isRecord(rawProfileId) ? asString(rawProfileId._id) : null);
        const disconnected =
            raw.status === 'disconnected' ||
            raw.needsReconnection === true ||
            raw.isActive === false;
        return {
            id,
            platform,
            username: asString(raw.username),
            displayName: asString(raw.displayName),
            profileId,
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
            status: disconnected ? 'disconnected' : 'connected',
        };
    };

    const parsePostPlatformEntry = (raw: unknown): ZernioPostPlatformEntry | null => {
        if (!isRecord(raw)) return null;
        const platform = asString(raw.platform);
        const status = asString(raw.status);
        if (!platform || !status) return null;
        return {
            platform,
            accountId: asString(raw.accountId),
            status,
            platformPostUrl:
                asString(raw.platformPostUrl) ?? asString(raw.postUrl) ?? asString(raw.url),
            errorMessage: asString(raw.errorMessage) ?? asString(raw.error),
            errorCategory: asString(raw.errorCategory) ?? asString(raw.category),
            errorSource: asString(raw.errorSource) ?? asString(raw.source),
        };
    };

    const parsePost = (raw: unknown): ZernioPost | null => {
        if (!isRecord(raw)) return null;
        const id = asString(raw._id) ?? asString(raw.id);
        const status = asString(raw.status);
        if (!id || !status) return null;
        const rawPlatforms = Array.isArray(raw.platforms) ? raw.platforms : [];
        return {
            id,
            status,
            platforms: rawPlatforms
                .map(parsePostPlatformEntry)
                .filter((p): p is ZernioPostPlatformEntry => p !== null),
        };
    };

    /**
     * Extrae el objeto post del body de /v1/posts — la API lo devuelve como
     * `{ post }` en 201/207 y (según versión) directo o `{ post }` en 200/202.
     */
    const parsePostResponse = (status: number, payload: unknown): ZernioPublishResult => {
        const body = isRecord(payload) ? payload : {};
        const post = parsePost(body.post) ?? parsePost(body);
        return { httpStatus: status, idempotentReplay: status === 200, post };
    };

    return {
        async findProfileByExternalId(externalId) {
            const data = await request<{ profiles?: unknown[] }>(
                'GET',
                '/profiles',
                { query: { externalId } },
            );
            const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
            for (const raw of profiles) {
                const parsed = parseProfile(raw);
                if (parsed) return parsed;
            }
            return null;
        },

        async createProfile({ name, externalId, idempotencyKey }) {
            const data = await request<{ profile?: unknown }>(
                'POST',
                '/profiles',
                {
                    body: { name, externalId },
                    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
                },
            );
            const profile = parseProfile(data?.profile);
            if (!profile) {
                throw new AppError('Zernio no devolvió el perfil creado', 502, 'zernio_error');
            }
            return profile;
        },

        async getConnectUrl({ profileId, platform, redirectUrl, welcome, brandName, logoUrl, primaryColor }) {
            const query: Record<string, string> = { profileId, redirect_url: redirectUrl };
            if (welcome !== undefined) query.welcome = String(welcome);
            if (brandName) query.brandName = brandName;
            if (logoUrl) query.logoUrl = logoUrl;
            if (primaryColor) query.primaryColor = primaryColor;
            const data = await request<{ authUrl?: unknown; state?: unknown }>(
                'GET',
                `/connect/${encodeURIComponent(platform)}`,
                { query },
            );
            const authUrl = asString(data?.authUrl);
            if (!authUrl) {
                throw new AppError('Zernio no devolvió la URL de conexión', 502, 'zernio_error');
            }
            return { authUrl, state: asString(data?.state) ?? undefined };
        },

        async listAccounts(profileId) {
            const data = await request<{ accounts?: unknown[] }>(
                'GET',
                '/accounts',
                { query: { profileId } },
            );
            const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
            return accounts
                .map(parseAccount)
                .filter((a): a is ZernioAccount => a !== null);
        },

        async disconnectAccount(accountId) {
            await request<unknown>('DELETE', `/accounts/${encodeURIComponent(accountId)}`);
        },

        async publishPost(input) {
            const body: Record<string, unknown> = {
                profileId: input.profileId,
                content: input.content,
                platforms: input.platforms.map((t) => ({
                    platform: t.platform,
                    accountId: t.accountId,
                })),
            };
            if (input.mediaUrls && input.mediaUrls.length > 0) {
                body.mediaUrls = input.mediaUrls;
            }
            if (input.scheduledFor) {
                body.scheduledFor = input.scheduledFor;
            } else {
                body.publishNow = true;
            }
            const { status, payload } = await requestRaw('POST', '/posts', {
                body,
                headers: input.idempotencyKey
                    ? { 'Idempotency-Key': input.idempotencyKey }
                    : {},
            });
            return parsePostResponse(status, payload);
        },

        async retryPost(postId) {
            const { status, payload } = await requestRaw(
                'POST',
                `/posts/${encodeURIComponent(postId)}/retry`,
            );
            return parsePostResponse(status, payload);
        },
    };
}
