/**
 * publishJobs.ts — API de la cola de publicación vía Zernio (PG-05).
 * Montado en /api/publish-jobs.
 *
 *   GET  /              → { jobs, total } — lista tenant-scoped con filtro
 *                         por status y paginación (limit/offset).
 *   GET  /:id           → { job } — detalle tenant-scoped con el último
 *                         error real categorizado. Nunca credenciales.
 *   POST /              → 202 { jobs, createdCount, deduplicatedCount }
 *                         Encolado manual: body { assetId? | publicationId?,
 *                         targets[{platform, accountId, connectionId?}],
 *                         content, mediaUrls?, scheduledFor? }. Un job por
 *                         destino; la idempotency_key deduplica re-envíos.
 *   POST /:id/retry     → { job } — reintento manual de un job `failed`/
 *                         `partial`. Con zernio_post_id va por
 *                         POST /v1/posts/{id}/retry de Zernio (reintenta las
 *                         plataformas fallidas del mismo post); sin él,
 *                         re-encola local. 409 invalid_transition |
 *                         max_attempts_reached.
 *   POST /:id/cancel    → { job } — cancela un job `queued`/`publishing`.
 *                         404 not_found | 409 invalid_transition.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — un job ajeno
 * ⇒ 404 (no se distingue "no existe" de "es de otro tenant").
 *
 * Deps inyectables (`publishJobsRouteDeps`): el store + servicios — los
 * tests los pisan con memory stores y Zernio falso, sin tocar Neon ni red.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
    cancelPublishJob,
    enqueuePublishJobs,
    getPublishJob,
    isPublishJobStatus,
    listPublishJobs,
    retryPublishJob,
    type PublishJobDeps,
    type PublishTarget,
} from '../services/publishJobService.js';

export const publishJobsRouter = Router();

/** Mismo contrato que assetsRouteDeps / autoPublishRouteDeps. */
export const publishJobsRouteDeps: PublishJobDeps = {};

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const handleError = (res: Response, error: unknown, fallback: string): void => {
    if (error instanceof AppError) {
        res.status(error.statusCode).json({
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
        });
        return;
    }
    console.error(`[PublishJobs] ${fallback}:`, error);
    res.status(500).json({ error: fallback });
};

// ------------------------------------------------------------------
// GET /api/publish-jobs — lista tenant-scoped (filtro status + paginación)
// ------------------------------------------------------------------
publishJobsRouter.get(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const statusParam =
                typeof req.query.status === 'string' ? req.query.status : undefined;
            if (statusParam !== undefined && !isPublishJobStatus(statusParam)) {
                res.status(400).json({
                    error: 'status inválido',
                    code: 'invalid_status',
                });
                return;
            }
            const limit = Math.min(
                Math.max(Number(req.query.limit) || 50, 1),
                200,
            );
            const offset = Math.max(Number(req.query.offset) || 0, 0);
            const { jobs, total } = await listPublishJobs(
                tenantId,
                { status: statusParam, limit, offset },
                publishJobsRouteDeps,
            );
            res.status(200).json({ jobs, total });
        } catch (error) {
            handleError(res, error, 'Error al listar los jobs de publicación');
        }
    },
);

// ------------------------------------------------------------------
// GET /api/publish-jobs/:id — detalle tenant-scoped
// ------------------------------------------------------------------
publishJobsRouter.get(
    '/:id',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            if (!UUID_RE.test(req.params.id)) {
                res.status(400).json({ error: 'id inválido (uuid)' });
                return;
            }
            const job = await getPublishJob(tenantId, req.params.id, publishJobsRouteDeps);
            if (!job) {
                res.status(404).json({
                    error: 'Job de publicación no encontrado',
                    code: 'publish_job_not_found',
                });
                return;
            }
            res.status(200).json({ job });
        } catch (error) {
            handleError(res, error, 'Error al obtener el job de publicación');
        }
    },
);

// ------------------------------------------------------------------
// POST /api/publish-jobs — encolado manual
// ------------------------------------------------------------------
publishJobsRouter.post(
    '/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            const body = (req.body ?? {}) as Record<string, unknown>;

            let assetId: string | null = null;
            let publicationId: string | null = null;
            for (const [field, assign] of [
                ['assetId', (v: string) => (assetId = v)],
                ['publicationId', (v: string) => (publicationId = v)],
            ] as const) {
                const raw = body[field];
                if (raw !== undefined && raw !== null && raw !== '') {
                    if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
                        res.status(400).json({
                            error: `${field} inválido (uuid)`,
                            code: 'invalid_source',
                        });
                        return;
                    }
                    assign(raw);
                }
            }

            if (typeof body.content !== 'string' || body.content.trim() === '') {
                res.status(400).json({
                    error: 'content es obligatorio',
                    code: 'invalid_content',
                });
                return;
            }

            if (!Array.isArray(body.targets) || body.targets.length === 0) {
                res.status(400).json({
                    error: 'targets[] es obligatorio (al menos un destino)',
                    code: 'invalid_targets',
                });
                return;
            }
            const targets: PublishTarget[] = [];
            for (const raw of body.targets as unknown[]) {
                const t = raw as Record<string, unknown>;
                if (
                    typeof t?.platform !== 'string' ||
                    t.platform.trim() === '' ||
                    typeof t?.accountId !== 'string' ||
                    t.accountId.trim() === ''
                ) {
                    res.status(400).json({
                        error: 'Cada target requiere {platform, accountId}',
                        code: 'invalid_targets',
                    });
                    return;
                }
                if (
                    t.connectionId !== undefined &&
                    t.connectionId !== null &&
                    (typeof t.connectionId !== 'string' ||
                        !UUID_RE.test(t.connectionId))
                ) {
                    res.status(400).json({
                        error: 'connectionId inválido (uuid)',
                        code: 'invalid_targets',
                    });
                    return;
                }
                targets.push({
                    platform: t.platform.trim(),
                    accountId: t.accountId.trim(),
                    connectionId: (t.connectionId as string | null) ?? null,
                });
            }

            let mediaUrls: string[] | undefined;
            if (body.mediaUrls !== undefined) {
                if (
                    !Array.isArray(body.mediaUrls) ||
                    body.mediaUrls.some(
                        (u) => typeof u !== 'string' || !/^https?:\/\//.test(u as string),
                    )
                ) {
                    res.status(400).json({
                        error: 'mediaUrls debe ser un array de URLs http(s)',
                        code: 'invalid_media',
                    });
                    return;
                }
                mediaUrls = body.mediaUrls as string[];
            }

            let scheduledFor: Date | null = null;
            if (body.scheduledFor !== undefined && body.scheduledFor !== null) {
                if (
                    typeof body.scheduledFor !== 'string' ||
                    !ISO_DATE_RE.test(body.scheduledFor) ||
                    Number.isNaN(Date.parse(body.scheduledFor))
                ) {
                    res.status(400).json({
                        error: 'scheduledFor inválido (ISO 8601)',
                        code: 'invalid_schedule',
                    });
                    return;
                }
                scheduledFor = new Date(body.scheduledFor);
            }

            const result = await enqueuePublishJobs(
                {
                    tenantId,
                    assetId,
                    publicationId,
                    targets,
                    content: body.content,
                    mediaUrls,
                    scheduledFor,
                },
                publishJobsRouteDeps,
            );
            res.status(202).json(result);
        } catch (error) {
            handleError(res, error, 'Error al encolar el job de publicación');
        }
    },
);

// ------------------------------------------------------------------
// POST /api/publish-jobs/:id/retry — reintento manual (failed/partial)
// ------------------------------------------------------------------
publishJobsRouter.post(
    '/:id/retry',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            if (!UUID_RE.test(req.params.id)) {
                res.status(400).json({ error: 'id inválido (uuid)' });
                return;
            }
            const job = await retryPublishJob(
                tenantId,
                req.params.id,
                publishJobsRouteDeps,
            );
            res.status(200).json({ job });
        } catch (error) {
            handleError(res, error, 'Error al reintentar el job de publicación');
        }
    },
);

// ------------------------------------------------------------------
// POST /api/publish-jobs/:id/cancel — cancelación manual (queued/publishing)
// ------------------------------------------------------------------
publishJobsRouter.post(
    '/:id/cancel',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const tenantId = req.auth!.tenantId;
            if (!UUID_RE.test(req.params.id)) {
                res.status(400).json({ error: 'id inválido (uuid)' });
                return;
            }
            const job = await cancelPublishJob(
                tenantId,
                req.params.id,
                publishJobsRouteDeps,
            );
            res.status(200).json({ job });
        } catch (error) {
            handleError(res, error, 'Error al cancelar el job de publicación');
        }
    },
);
