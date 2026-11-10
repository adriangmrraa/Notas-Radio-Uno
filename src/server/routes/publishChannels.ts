/**
 * publishChannels.ts — API del canal de publicación por tenant (PG-07).
 * Montado en /api/publish-channels.
 *
 *   GET / → { mode, defaultMode, configured, platforms }
 *   Estado de migración por plataforma: canal efectivo ('zernio'|'legacy'|
 *   'none'), motivo cuando no hay camino, conexiones Zernio, assets legacy
 *   con su marca legacy-only y `pendingMigration`. `configured` es false
 *   cuando el tenant nunca guardó un modo — `mode` muestra el default
 *   efectivo ('hybrid').
 *
 *   PUT / { mode } → upsert del modo de canal del tenant.
 *   mode ∈ 'zernio'|'legacy'|'hybrid' (lista cerrada — 400 invalid_channel_mode).
 *   Auditado como publish_channel.mode_changed.
 *
 *   PUT /assets/:id/legacy-only { legacyOnly: boolean } → marca/desmarca un
 *   business_asset como "siempre por canal legacy" (metadata.legacyOnly —
 *   explícito, nunca inferido). Ancla TODA la plataforma del asset.
 *   404 si el asset es de otro tenant o no existe; 400 si el tipo de asset
 *   no es un canal legacy (facebook_page/instagram_account/twitter_account).
 *   Auditado como publish_channel.legacy_only_changed.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId`; las queries
 * del store son tenant-scoped (settings por tenant_id+key, assets por
 * tenant_id).
 *
 * Deps inyectables (`publishChannelsRouteDeps`): el store de canales +
 * listConnections + envTwitterBot — los tests los pisan con memoria.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    auditFromRequest,
    AUDIT_ACTIONS,
} from '../services/auditService.js';
import {
    getPublishChannelStatus,
    isPublishChannelMode,
    setAssetLegacyOnly,
    setPublishChannelMode,
    PUBLISH_CHANNEL_MODES,
    type PublishChannelDeps,
} from '../services/publishChannelService.js';

export const publishChannelsRouter = Router();

/** Mismo contrato que autoPublishRouteDeps. */
export const publishChannelsRouteDeps: PublishChannelDeps = {};

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
    console.error(`[PublishChannels] ${fallback}:`, error);
    res.status(500).json({ error: fallback });
};

// ------------------------------------------------------------------
// GET /api/publish-channels — modo + estado de migración por plataforma.
// ------------------------------------------------------------------
publishChannelsRouter.get(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const status = await getPublishChannelStatus(
                tenantId,
                publishChannelsRouteDeps,
            );
            res.status(200).json(status);
        } catch (error) {
            handleError(res, error, 'Error al leer los canales de publicación');
        }
    },
);

// ------------------------------------------------------------------
// PUT /api/publish-channels — cambia el modo de canal del tenant.
// ------------------------------------------------------------------
publishChannelsRouter.put(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            if (!isPublishChannelMode(body.mode)) {
                res.status(400).json({
                    error: `mode inválido — valores: ${PUBLISH_CHANNEL_MODES.join(' | ')}`,
                    code: 'invalid_channel_mode',
                });
                return;
            }

            const mode = await setPublishChannelMode(
                tenantId,
                body.mode,
                publishChannelsRouteDeps,
            );

            void auditFromRequest(
                req,
                AUDIT_ACTIONS.PUBLISH_CHANNEL_MODE_CHANGED,
                {
                    entityType: 'tenant',
                    entityId: tenantId,
                    metadata: { mode },
                },
            );

            res.status(200).json({ mode });
        } catch (error) {
            handleError(res, error, 'Error al guardar el modo de publicación');
        }
    },
);

// ------------------------------------------------------------------
// PUT /api/publish-channels/assets/:id/legacy-only — marca el asset.
// ------------------------------------------------------------------
publishChannelsRouter.put(
    '/assets/:id/legacy-only',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            if (!UUID_RE.test(req.params.id)) {
                res.status(400).json({
                    error: 'id inválido (uuid)',
                    code: 'invalid_asset_id',
                });
                return;
            }
            const body = (req.body ?? {}) as Record<string, unknown>;
            if (typeof body.legacyOnly !== 'boolean') {
                res.status(400).json({
                    error: 'legacyOnly debe ser booleano',
                    code: 'invalid_legacy_only',
                });
                return;
            }

            const asset = await setAssetLegacyOnly(
                tenantId,
                req.params.id,
                body.legacyOnly,
                publishChannelsRouteDeps,
            );

            void auditFromRequest(
                req,
                AUDIT_ACTIONS.PUBLISH_CHANNEL_LEGACY_ONLY_CHANGED,
                {
                    entityType: 'business_asset',
                    entityId: asset.id,
                    metadata: {
                        assetType: asset.assetType,
                        legacyOnly: body.legacyOnly,
                    },
                },
            );

            res.status(200).json({ asset });
        } catch (error) {
            handleError(res, error, 'Error al marcar el asset legacy-only');
        }
    },
);
