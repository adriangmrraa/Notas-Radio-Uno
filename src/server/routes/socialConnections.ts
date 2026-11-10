/**
 * socialConnections.ts — API de conexión de cuentas vía Zernio (PG-04).
 * Montado en /api/social-connections.
 *
 *   POST /connect { platform } → { authUrl, state }
 *   Inicia el OAuth hospedado por Zernio: valida la plataforma contra el
 *   enum real de la API, aplica el tope de plataformas del plan
 *   (`max_connected_platforms`), asegura el perfil Zernio del tenant y
 *   devuelve la authUrl white-label (welcome + brandName/logoUrl) con el
 *   state firmado ya embebido en el redirect_url.
 *   400 invalid_platform / 403 max_connected_platforms /
 *   503 zernio_not_configured.
 *
 *   GET /callback?state&connected&profileId&accountId&username
 *   Retorno del flujo Zernio. NO lleva requireAuth: el navegador llega
 *   redirigido desde Zernio sin el header de auth — la credencial es el
 *   `state` HMAC firmado (tenant + platform, 15 min). Verifica state,
 *   profileId y connected, hace el upsert tenant-scoped y redirige al
 *   frontend con ?social_connected=<platform> o
 *   ?social_error=<code>. Nunca escribe nada sin state válido.
 *
 *   GET / → { connections, plan: { maxPlatforms, usedPlatforms } }
 *   Lista las conexiones del tenant (todas, cualquier status).
 *
 *   DELETE /:id → 204
 *   Desconecta: DELETE /v1/accounts/{accountId} en Zernio propagando el
 *   error real (salvo 404/account_not_found = ya desconectada), después
 *   borra la fila local. 404 connection_not_found si es ajena o no existe.
 *
 *   POST /sync → { connections, synced, markedDisconnected }
 *   Re-sincroniza con Zernio: upsert de cada cuenta remota y marca
 *   'disconnected' las filas locales que Zernio ya no reporta.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` o del state
 * firmado — jamás de un query/body sin verificar.
 *
 * Deps inyectables (`socialConnectionsRouteDeps`): store, cliente Zernio,
 * plan, branding, secretos — los tests montan el router en una app express
 * efímera sin Neon ni red.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    completeSocialConnect,
    disconnectSocialConnection,
    frontendUrlFor,
    getSocialConnectionsPlanStatus,
    listSocialConnections,
    startSocialConnect,
    syncSocialConnections,
    type CallbackQuery,
    type SocialConnectionsDeps,
} from '../services/socialConnectionsService.js';

export const socialConnectionsRouter = Router();

/** Mismo contrato que autoPublishRouteDeps — los tests lo pisan entero. */
export const socialConnectionsRouteDeps: SocialConnectionsDeps = {};

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handleError = (res: Response, error: unknown, fallback: string): void => {
    if (error instanceof AppError) {
        res.status(error.statusCode).json({
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
        });
        return;
    }
    console.error(`[SocialConnections] ${fallback}:`, error);
    res.status(500).json({ error: fallback });
};

/** Redirige al frontend informando el resultado del flujo OAuth. */
const redirectToFrontend = (
    res: Response,
    params: Record<string, string>,
): void => {
    const url = new URL(`${frontendUrlFor(socialConnectionsRouteDeps)}/conexiones`);
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    res.redirect(url.toString());
};

// ------------------------------------------------------------------
// POST /api/social-connections/connect — inicia el OAuth de Zernio.
// ------------------------------------------------------------------
socialConnectionsRouter.post(
    '/connect',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;
            if (typeof body.platform !== 'string' || body.platform.trim() === '') {
                res.status(400).json({
                    error: 'platform es obligatoria',
                    code: 'invalid_platform',
                });
                return;
            }
            const { authUrl, state } = await startSocialConnect(
                tenantId,
                body.platform.trim().toLowerCase(),
                socialConnectionsRouteDeps,
            );
            res.status(200).json({ authUrl, state });
        } catch (error) {
            handleError(res, error, 'Error al iniciar la conexión');
        }
    },
);

// ------------------------------------------------------------------
// GET /api/social-connections/callback — retorno OAuth de Zernio.
// SIN requireAuth: la credencial es el state firmado.
// ------------------------------------------------------------------
socialConnectionsRouter.get(
    '/callback',
    async (req: Request, res: Response) => {
        const q = req.query as Record<string, unknown>;
        const str = (v: unknown): string | undefined =>
            typeof v === 'string' && v.length > 0 ? v : undefined;
        const query: CallbackQuery = {
            state: str(q.state),
            connected: str(q.connected),
            profileId: str(q.profileId),
            accountId: str(q.accountId),
            username: str(q.username),
            error: str(q.error),
            platform: str(q.platform),
            request_id: str(q.request_id),
            stage: str(q.stage),
        };

        try {
            const { platform } = await completeSocialConnect(
                query,
                socialConnectionsRouteDeps,
            );
            redirectToFrontend(res, { social_connected: platform });
        } catch (error) {
            const code =
                error instanceof AppError && error.code ? error.code : 'connect_failed';
            // Los errores también vuelven al frontend — el flujo nunca deja
            // al usuario colgado en una pantalla de Zernio.
            redirectToFrontend(res, { social_error: code });
        }
    },
);

// ------------------------------------------------------------------
// GET /api/social-connections — conexiones del tenant + cupo del plan.
// ------------------------------------------------------------------
socialConnectionsRouter.get(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const [connections, plan] = await Promise.all([
                listSocialConnections(tenantId, socialConnectionsRouteDeps),
                getSocialConnectionsPlanStatus(tenantId, socialConnectionsRouteDeps),
            ]);
            res.status(200).json({ connections, plan });
        } catch (error) {
            handleError(res, error, 'Error al listar las conexiones');
        }
    },
);

// ------------------------------------------------------------------
// DELETE /api/social-connections/:id — desconecta (Zernio + local).
// ------------------------------------------------------------------
socialConnectionsRouter.delete(
    '/:id',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            if (!UUID_RE.test(req.params.id)) {
                res.status(400).json({ error: 'id inválido (uuid)' });
                return;
            }
            await disconnectSocialConnection(
                tenantId,
                req.params.id,
                socialConnectionsRouteDeps,
            );
            res.status(204).end();
        } catch (error) {
            handleError(res, error, 'Error al desconectar la cuenta');
        }
    },
);

// ------------------------------------------------------------------
// POST /api/social-connections/sync — reconcilia con las cuentas Zernio.
// ------------------------------------------------------------------
socialConnectionsRouter.post(
    '/sync',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const result = await syncSocialConnections(tenantId, socialConnectionsRouteDeps);
            res.status(200).json(result);
        } catch (error) {
            handleError(res, error, 'Error al sincronizar las conexiones');
        }
    },
);
