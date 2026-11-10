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
    createDrizzleAssetStore,
    type AssetServiceDeps,
} from '../services/assetsService.js';
import { getAvailableProviders } from '../services/aiProviders.js';
import { generateTextWithFallback } from '../services/aiSdkService.js';
import { clipRenderQueueService, type ClipRenderJob } from '../services/clipRenderQueueService.js';
import { generateImage, type GenerateImageResult } from '../services/imageModelService.js';
import { getClipById } from '../services/clipService.js';

export const assetsRouter = Router();

/** Mismo contrato que notesRouteDeps/publicationsRouteDeps. */
export const assetsRouteDeps: AssetServiceDeps = {};

/** Injectable AI/queue boundaries: route tests never call external providers. */
export const assetsAiRouteDeps: {
    proposeText?: (input: { tenantId: string; sourceText: string; instruction: string }) => Promise<{ text: string; provider: string }>;
    enqueueClipRegeneration?: (input: { tenantId: string; clipId: string; assetId: string; prompt: string }) => Promise<ClipRenderJob>;
    regenerateImage?: (input: { tenantId: string; prompt: string }) => Promise<GenerateImageResult>;
    getClip?: (clipId: string, tenantId: string) => Promise<unknown | null>;
} = {};

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

// ------------------------------------------------------------------
// PG-02: AI-assisted editorial actions. Both actions resolve the ledger
// row through the authenticated tenant before invoking any provider/queue.
// ------------------------------------------------------------------
assetsRouter.post('/:id/edit-text', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        if (!UUID_RE.test(req.params.id)) {
            res.status(400).json({ error: 'id invalido (uuid)' });
            return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.instruction !== 'string' || body.instruction.trim().length === 0) {
            res.status(400).json({ error: 'instruction es obligatoria' });
            return;
        }
        const asset = await (assetsRouteDeps.store ?? createDrizzleAssetStore()).getAsset(req.params.id, tenantId);
        if (!asset) {
            res.status(404).json({ error: 'Asset no encontrado', code: 'asset_not_found' });
            return;
        }
        if (asset.kind !== 'note' && asset.kind !== 'post') {
            res.status(422).json({ error: 'Este tipo de asset no admite edicion de texto', code: 'text_edit_unsupported' });
            return;
        }
        const sourceText = typeof asset.payload.content === 'string'
            ? asset.payload.content
            : typeof asset.payload.copy === 'string' ? asset.payload.copy : asset.title ?? '';
        if (!sourceText) {
            res.status(422).json({ error: 'El asset no tiene texto editable', code: 'missing_source_text' });
            return;
        }
        const propose = assetsAiRouteDeps.proposeText ?? (async (input: { tenantId: string; sourceText: string; instruction: string }) => {
            if (getAvailableProviders().length === 0) {
                throw new AppError('No hay proveedor de IA configurado para editar texto', 503, 'no_provider_configured');
            }
            return generateTextWithFallback({
                system: 'Eres un editor editorial. Devuelve solo el texto editado, sin inventar hechos.',
                prompt: `Texto original:\n${input.sourceText}\n\nInstruccion editorial:\n${input.instruction}`,
            });
        });
        const result = await propose({ tenantId, sourceText, instruction: body.instruction.trim() });
        res.status(200).json({ proposal: result.text, provider: result.provider });
    } catch (error) {
        handleError(res, error, 'Error al editar el texto del asset');
    }
});

assetsRouter.post('/:id/regenerate', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        if (!UUID_RE.test(req.params.id)) {
            res.status(400).json({ error: 'id invalido (uuid)' });
            return;
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
            res.status(400).json({ error: 'prompt es obligatorio' });
            return;
        }
        const asset = await (assetsRouteDeps.store ?? createDrizzleAssetStore()).getAsset(req.params.id, tenantId);
        if (!asset) {
            res.status(404).json({ error: 'Asset no encontrado', code: 'asset_not_found' });
            return;
        }
        if (asset.kind === 'clip' && asset.sourceTable === 'clips') {
            const clip = await (assetsAiRouteDeps.getClip ?? getClipById)(asset.refId, tenantId);
            if (!clip) {
                // Do not enqueue a ledger reference unless its source clip is
                // still accessible in the same tenant.
                res.status(404).json({ error: 'Clip asociado no encontrado', code: 'clip_not_found' });
                return;
            }
            const enqueue = assetsAiRouteDeps.enqueueClipRegeneration ?? ((input: { tenantId: string; clipId: string; assetId: string; prompt: string }) =>
                clipRenderQueueService.enqueue({ tenantId: input.tenantId, clipId: input.clipId, kind: 'reframe', payload: { clipId: input.clipId, assetId: input.assetId, prompt: input.prompt } }));
            const job = await enqueue({ tenantId, clipId: asset.refId, assetId: asset.id, prompt: body.prompt.trim() });
            res.status(202).json({ jobId: job.id, status: job.status });
            return;
        }
        if (asset.kind === 'flyer') {
            const regenerate = assetsAiRouteDeps.regenerateImage ?? ((input: { tenantId: string; prompt: string }) => generateImage(input));
            const result = await regenerate({ tenantId, prompt: body.prompt.trim() });
            // The image service writes the real result; do not fabricate a public URL.
            res.status(202).json({ status: 'generated', path: result.path, model: result.model });
            return;
        }
        res.status(422).json({ error: 'Este tipo de asset no admite regeneracion', code: 'regeneration_unsupported' });
    } catch (error) {
        handleError(res, error, 'Error al solicitar regeneracion del asset');
    }
});
