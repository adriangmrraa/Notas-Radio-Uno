/**
 * features.ts — Feature flags del tenant actual
 *
 *  GET /api/features  → mapa { [key]: { enabled, source, limitValue, ... } }
 *
 * El tenant SIEMPRE sale del token; nunca de params.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getTenantFeatureMap } from '../services/tenantFeaturesService.js';
import { AppError } from '../lib/errors.js';

export const featuresRouter = Router();

featuresRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await getTenantFeatureMap(req.auth!.tenantId));
  } catch (err) {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    console.error('[Features] GET /:', err);
    res.status(500).json({ error: 'Error al obtener los features' });
  }
});
