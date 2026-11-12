/**
 * aiUsage.ts — API tenant-scoped del ledger `ai_usage_events` (PI-03).
 * Montado en /api/ai-usage.
 *
 *   GET /summary → { summary } — agregado del tenant autenticado:
 *     query: `from`/`to` (ISO 8601, rango [from, to) sobre created_at),
 *            `feature` (filtro exacto), `top` (tope del ranking de
 *            transmisiones por costo, 1..50, default 10).
 *     summary = { totals, byTenant, byFeature, byProvider, topTransmissions }
 *     — byTenant trae una sola fila (la del caller); byFeature/byProvider/
 *     topTransmissions ordenados por costo desc.
 *
 * Aislamiento: el tenant sale SIEMPRE de `req.auth!.tenantId` — nunca del
 * query. La vista cross-tenant vive en /api/admin/ai-usage (guard
 * requirePlatformAdmin), no acá.
 *
 * Deps inyectables: el service resuelve `aiUsageDeps.store` — los tests lo
 * pisan con el memory store (mismo contrato que jobQueueRouteDeps).
 */
import { Router, type Request, type Response } from 'express';

import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import {
  createAiUsageService,
  type AiUsageSummaryFilter,
} from '../services/aiUsageService.js';

export const aiUsageRouter = Router();

const handleError = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
    return;
  }
  log.error(`[AiUsage] ${fallback}`, { err: error });
  res.status(500).json({ error: fallback });
};

function parseDateParam(raw: unknown, name: string): Date | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AppError(`${name} debe ser una fecha ISO 8601`, 400, 'invalid_range');
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new AppError(`${name} debe ser una fecha ISO 8601`, 400, 'invalid_range');
  }
  return d;
}

function parseTopParam(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new AppError('top debe ser un entero entre 1 y 50', 400, 'invalid_top');
  }
  return n;
}

/**
 * Filtros compartidos por el endpoint tenant y el admin — el admin además
 * admite `tenantId` (resuelto en admin.ts, validado uuid).
 */
export function parseAiUsageSummaryQuery(
  query: Request['query'],
): AiUsageSummaryFilter {
  const from = parseDateParam(query.from, 'from');
  const to = parseDateParam(query.to, 'to');
  if (from && to && from.getTime() >= to.getTime()) {
    throw new AppError('from debe ser anterior a to', 400, 'invalid_range');
  }
  const feature =
    typeof query.feature === 'string' && query.feature.trim() !== ''
      ? query.feature.trim()
      : undefined;
  return {
    from,
    to,
    feature,
    topTransmissionsLimit: parseTopParam(query.top),
  };
}

// ------------------------------------------------------------------
// GET /api/ai-usage/summary — agregado del tenant autenticado
// ------------------------------------------------------------------
aiUsageRouter.get(
  '/summary',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const filter = parseAiUsageSummaryQuery(req.query);
      const summary = await createAiUsageService().summarize({
        ...filter,
        tenantId,
      });
      res.status(200).json({ summary });
    } catch (error) {
      handleError(res, error, 'Error al resumir el uso de IA');
    }
  },
);
