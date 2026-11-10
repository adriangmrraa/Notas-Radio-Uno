/**
 * autoPublish.ts — API de configuración de auto-publicación (PG-03).
 * Montado en /api/auto-publish.
 *
 *   GET / → { configs, planAllowsAutoPublish, maxPlatforms, usedPlatforms }
 *   Lista las configs del tenant (global + por programa) con el estado del
 *   plan — la UI muestra el motivo cuando la función no está disponible,
 *   nunca lo esconde. La lectura NO está gated por el flag: un tenant sin
 *   la feature puede ver (y borrar) lo que ya tiene configurado.
 *
 *   PUT / { programId?, mode, platforms?, publishDays?, publishTime?,
 *           timezone? } → upsert tenant-scoped por (tenant_id, program_key).
 *   200 { config } / 400 validación / 403 feature_disabled |
 *   plan_limit_exceeded / 404 program_not_found.
 *
 *   DELETE /:id → borra la config del tenant. 204 / 404 config_not_found.
 *   El DELETE no exige el flag habilitado: borrar es la vía de limpieza —
 *   un tenant que perdió la feature tiene que poder apagar sus configs.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — una config
 * o un programa ajeno ⇒ 404 (no se distingue "no existe" de "es de otro").
 *
 * Deps inyectables (`autoPublishRouteDeps`): el store + flag + plan — los
 * tests los pisan con el store en memoria y flags falsos; el router se
 * monta en una app express efímera sin tocar Neon.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    deleteAutoPublishConfig,
    getAutoPublishPlanStatus,
    listAutoPublishConfigs,
    upsertAutoPublishConfig,
    type AutoPublishDeps,
} from '../services/autoPublishService.js';

export const autoPublishRouter = Router();

/** Mismo contrato que assetsRouteDeps. */
export const autoPublishRouteDeps: AutoPublishDeps = {};

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
    console.error(`[AutoPublish] ${fallback}:`, error);
    res.status(500).json({ error: fallback });
};

// ------------------------------------------------------------------
// GET /api/auto-publish — configs del tenant + estado del plan.
// ------------------------------------------------------------------
autoPublishRouter.get(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const [configs, plan] = await Promise.all([
                listAutoPublishConfigs(tenantId, autoPublishRouteDeps),
                getAutoPublishPlanStatus(tenantId, autoPublishRouteDeps),
            ]);
            res.status(200).json({
                configs,
                planAllowsAutoPublish: plan.planAllowsAutoPublish,
                maxPlatforms: plan.maxPlatforms,
                usedPlatforms: plan.usedPlatforms,
            });
        } catch (error) {
            handleError(res, error, 'Error al listar la auto-publicación');
        }
    },
);

// ------------------------------------------------------------------
// PUT /api/auto-publish — upsert tenant-scoped con gates de plan.
// ------------------------------------------------------------------
autoPublishRouter.put(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            let programId: string | null = null;
            if (
                body.programId !== undefined &&
                body.programId !== null &&
                body.programId !== ''
            ) {
                if (typeof body.programId !== 'string' || !UUID_RE.test(body.programId)) {
                    res.status(400).json({
                        error: 'programId inválido (uuid)',
                        code: 'invalid_program',
                    });
                    return;
                }
                programId = body.programId;
            }

            if (typeof body.mode !== 'string' || body.mode.trim() === '') {
                res.status(400).json({
                    error: 'mode es obligatorio (off|on_approval|scheduled)',
                    code: 'invalid_mode',
                });
                return;
            }

            const config = await upsertAutoPublishConfig(
                {
                    tenantId,
                    programId,
                    mode: body.mode.trim(),
                    platforms: body.platforms,
                    publishDays: body.publishDays,
                    publishTime: body.publishTime,
                    timezone: body.timezone,
                },
                autoPublishRouteDeps,
            );
            res.status(200).json({ config });
        } catch (error) {
            handleError(res, error, 'Error al guardar la auto-publicación');
        }
    },
);

// ------------------------------------------------------------------
// DELETE /api/auto-publish/:id — borra la config del tenant.
// ------------------------------------------------------------------
autoPublishRouter.delete(
    '/:id',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            if (!UUID_RE.test(req.params.id)) {
                res.status(400).json({ error: 'id inválido (uuid)' });
                return;
            }
            await deleteAutoPublishConfig(tenantId, req.params.id, autoPublishRouteDeps);
            res.status(204).end();
        } catch (error) {
            handleError(res, error, 'Error al borrar la auto-publicación');
        }
    },
);
