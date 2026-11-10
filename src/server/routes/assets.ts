/**
 * assets.ts — API del ledger editorial unificado (PF-10). Montado en
 * /api/assets.
 *
 *   GET /?kind&status&transmissionId → lista los assets del tenant con
 *   filtros opcionales. 200 { assets }.
 *
 *   POST /sync { transmissionId? } → recorre clips/publications del
 *   tenant y refleja cada artefacto en el ledger (idempotente por la
 *   UNIQUE tenant_id+source_table+ref_id). 200 { upserted, byKind }.
 *
 *   POST /:id/transition { to } → aplica la transición editorial
 *   canónica + write-through del status legacy a la fila fuente.
 *   200 { asset } / 400 (id o to mal formados) / 404 asset_not_found /
 *   409 invalid_transition / 422 invalid_state.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — un asset
 * ajeno ⇒ 404 (no se distingue "no existe" de "es de otro").
 *
 * Deps inyectables (`assetsRouteDeps`): el `AssetStore` — los tests lo
 * pisan con el store en memoria; el router se monta en una app express
 * efímera sin tocar Neon.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    isAssetKind,
    isAssetState,
    listAssetsPage,
    syncAssets,
    transitionAsset,
    type AssetServiceDeps,
} from '../services/assetsService.js';

export const assetsRouter = Router();

/** Mismo contrato que notesRouteDeps/publicationsRouteDeps. */
export const assetsRouteDeps: AssetServiceDeps = {};

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
    console.error(`[Assets] ${fallback}:`, error);
    res.status(500).json({ error: fallback });
};

// ------------------------------------------------------------------
// GET /api/assets — lista del ledger con filtros opcionales.
// ------------------------------------------------------------------
assetsRouter.get(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const q = req.query as Record<string, unknown>;

            let kind: string | undefined;
            if (q.kind !== undefined) {
                if (typeof q.kind !== 'string' || !isAssetKind(q.kind)) {
                    res.status(400).json({
                        error: "kind inválido ('clip'|'note'|'flyer'|'post')",
                    });
                    return;
                }
                kind = q.kind;
            }

            let status: string | undefined;
            if (q.status !== undefined) {
                if (typeof q.status !== 'string' || !isAssetState(q.status)) {
                    res.status(400).json({
                        error: 'status inválido (draft|pending_review|approved|published|archived)',
                    });
                    return;
                }
                status = q.status;
            }

            let transmissionId: string | undefined;
            if (q.transmissionId !== undefined) {
                if (
                    typeof q.transmissionId !== 'string' ||
                    !UUID_RE.test(q.transmissionId)
                ) {
                    res.status(400).json({
                        error: 'transmissionId inválido (uuid)',
                    });
                    return;
                }
                transmissionId = q.transmissionId;
            }

            let programId: string | undefined;
            if (q.programId !== undefined) {
                if (typeof q.programId !== 'string' || !UUID_RE.test(q.programId)) {
                    res.status(400).json({ error: 'programId invalido (uuid)' });
                    return;
                }
                programId = q.programId;
            }

            const page = q.page === undefined ? 1 : Number(q.page);
            const pageSize = q.pageSize === undefined ? 50 : Number(q.pageSize);
            if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
                res.status(400).json({ error: 'page y pageSize invalidos' });
                return;
            }

            const result = await listAssetsPage(
                { tenantId, kind, status, transmissionId, programId, page, pageSize },
                assetsRouteDeps,
            );
            res.status(200).json(result);
        } catch (error) {
            handleError(res, error, 'Error al listar los assets');
        }
    },
);

// ------------------------------------------------------------------
// POST /api/assets/sync — puebla/actualiza el ledger desde las fuentes.
// ------------------------------------------------------------------
assetsRouter.post(
    '/sync',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            let transmissionId: string | undefined;
            if (
                body.transmissionId !== undefined &&
                body.transmissionId !== null &&
                body.transmissionId !== ''
            ) {
                if (
                    typeof body.transmissionId !== 'string' ||
                    !UUID_RE.test(body.transmissionId)
                ) {
                    res.status(400).json({
                        error: 'transmissionId inválido (uuid)',
                    });
                    return;
                }
                transmissionId = body.transmissionId;
            }

            const result = await syncAssets(
                { tenantId, transmissionId },
                assetsRouteDeps,
            );
            res.status(200).json(result);
        } catch (error) {
            handleError(res, error, 'Error al sincronizar los assets');
        }
    },
);

// ------------------------------------------------------------------
// POST /api/assets/:id/transition — transición editorial + write-through.
// ------------------------------------------------------------------
assetsRouter.post(
    '/:id/transition',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;

            if (!UUID_RE.test(req.params.id)) {
                res.status(400).json({ error: 'id inválido (uuid)' });
                return;
            }

            const body = (req.body ?? {}) as Record<string, unknown>;
            if (typeof body.to !== 'string' || body.to.trim() === '') {
                res.status(400).json({
                    error: 'to es obligatorio (string)',
                });
                return;
            }

            const asset = await transitionAsset(
                {
                    tenantId,
                    assetId: req.params.id,
                    to: body.to.trim(),
                },
                assetsRouteDeps,
            );
            res.status(200).json({ asset });
        } catch (error) {
            handleError(res, error, 'Error al transicionar el asset');
        }
    },
);
