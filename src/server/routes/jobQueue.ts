/**
 * jobQueue.ts — API tenant-scoped de la cola genérica `job_queue` (PI-01).
 * Montado en /api/job-queue.
 *
 *   GET  /              → { jobs, total } — lista tenant-scoped con filtros
 *                         status/kind y paginación (limit 1..200, def 50).
 *   GET  /:id           → { job } — detalle tenant-scoped. 404 job_not_found.
 *   POST /              → 202 { job } — encolado manual: body { kind,
 *                         payload?, maxAttempts? }. 400 invalid_kind.
 *   POST /:id/retry     → { job } — reintento manual desde dead/failed/
 *                         cancelled. 404 | 409 invalid_transition.
 *   POST /:id/cancel    → { job } — cancela pending/running.
 *                         404 | 409 invalid_transition.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — nunca del
 * body ni del query. Un job ajeno ⇒ 404 (no se distingue "no existe" de
 * "es de otro tenant"), igual que /api/publish-jobs.
 *
 * Deps inyectables (`jobQueueRouteDeps.store`): los tests lo pisan con el
 * memory store — sin DB, sin red.
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import {
  createJobQueueService,
  isJobQueueKind,
  isJobQueueStatus,
  jobQueueService,
  type JobQueueStore,
} from '../services/jobQueueService.js';

export const jobQueueRouter = Router();

/** Mismo contrato que publishJobsRouteDeps. */
export const jobQueueRouteDeps: { store?: JobQueueStore } = {};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const service = () =>
  jobQueueRouteDeps.store
    ? createJobQueueService(jobQueueRouteDeps.store)
    : jobQueueService;

const handleError = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
    return;
  }
  console.error(`[JobQueue] ${fallback}:`, error);
  res.status(500).json({ error: fallback });
};

const parseLimit = (raw: unknown): number =>
  Math.min(Math.max(Number(raw) || 50, 1), 200);
const parseOffset = (raw: unknown): number => Math.max(Number(raw) || 0, 0);

// ------------------------------------------------------------------
// GET /api/job-queue — lista tenant-scoped (status/kind + paginación)
// ------------------------------------------------------------------
jobQueueRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const statusParam =
      typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusParam !== undefined && !isJobQueueStatus(statusParam)) {
      res.status(400).json({ error: 'status inválido', code: 'invalid_status' });
      return;
    }
    const kindParam =
      typeof req.query.kind === 'string' ? req.query.kind : undefined;
    if (kindParam !== undefined && !isJobQueueKind(kindParam)) {
      res.status(400).json({ error: 'kind inválido', code: 'invalid_kind' });
      return;
    }
    const { jobs, total } = await service().listJobs(tenantId, {
      status: statusParam,
      kind: kindParam,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset),
    });
    res.status(200).json({ jobs, total });
  } catch (error) {
    handleError(res, error, 'Error al listar los jobs');
  }
});

// ------------------------------------------------------------------
// GET /api/job-queue/:id — detalle tenant-scoped
// ------------------------------------------------------------------
jobQueueRouter.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    if (!UUID_RE.test(req.params.id)) {
      res.status(400).json({ error: 'id inválido (uuid)' });
      return;
    }
    const job = await service().getJob(req.params.id, tenantId);
    if (!job) {
      res.status(404).json({ error: 'Job no encontrado', code: 'job_not_found' });
      return;
    }
    res.status(200).json({ job });
  } catch (error) {
    handleError(res, error, 'Error al obtener el job');
  }
});

// ------------------------------------------------------------------
// POST /api/job-queue — encolado manual
// ------------------------------------------------------------------
jobQueueRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (typeof body.kind !== 'string' || !isJobQueueKind(body.kind)) {
      res.status(400).json({ error: 'kind inválido', code: 'invalid_kind' });
      return;
    }

    let payload: Record<string, unknown> | undefined;
    if (body.payload !== undefined && body.payload !== null) {
      if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
        res
          .status(400)
          .json({ error: 'payload debe ser un objeto', code: 'invalid_payload' });
        return;
      }
      payload = body.payload as Record<string, unknown>;
    }

    let maxAttempts: number | undefined;
    if (body.maxAttempts !== undefined && body.maxAttempts !== null) {
      const n = Number(body.maxAttempts);
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        res.status(400).json({
          error: 'maxAttempts debe ser un entero entre 1 y 100',
          code: 'invalid_max_attempts',
        });
        return;
      }
      maxAttempts = n;
    }

    const job = await service().enqueue({
      tenantId,
      kind: body.kind,
      payload,
      maxAttempts,
    });
    res.status(202).json({ job });
  } catch (error) {
    handleError(res, error, 'Error al encolar el job');
  }
});

// ------------------------------------------------------------------
// POST /api/job-queue/:id/retry — reintento manual (dead/failed/cancelled)
// ------------------------------------------------------------------
jobQueueRouter.post(
  '/:id/retry',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: 'id inválido (uuid)' });
        return;
      }
      const existing = await service().getJob(req.params.id, tenantId);
      if (!existing) {
        res
          .status(404)
          .json({ error: 'Job no encontrado', code: 'job_not_found' });
        return;
      }
      const job = await service().retryJob(req.params.id, tenantId);
      if (!job) {
        res.status(409).json({
          error: `No se puede re-encolar un job en estado '${existing.status}'`,
          code: 'invalid_transition',
        });
        return;
      }
      res.status(200).json({ job });
    } catch (error) {
      handleError(res, error, 'Error al reintentar el job');
    }
  },
);

// ------------------------------------------------------------------
// POST /api/job-queue/:id/cancel — cancelación manual (pending/running)
// ------------------------------------------------------------------
jobQueueRouter.post(
  '/:id/cancel',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: 'id inválido (uuid)' });
        return;
      }
      const existing = await service().getJob(req.params.id, tenantId);
      if (!existing) {
        res
          .status(404)
          .json({ error: 'Job no encontrado', code: 'job_not_found' });
        return;
      }
      const job = await service().cancelJob(req.params.id, tenantId);
      if (!job) {
        res.status(409).json({
          error: `No se puede cancelar un job en estado '${existing.status}'`,
          code: 'invalid_transition',
        });
        return;
      }
      res.status(200).json({ job });
    } catch (error) {
      handleError(res, error, 'Error al cancelar el job');
    }
  },
);

