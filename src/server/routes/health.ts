/**
 * health.ts — GET /api/health (PI-06).
 *
 * Ruta pública (sin auth) usada por el healthCheckPath del deploy
 * (render.yaml). Devuelve el reporte de `getHealthReport`: estado real de
 * DB, migraciones y providers de IA — sin secretos ni connection strings.
 *
 * Deps inyectables (`healthRouteDeps.probes`): los tests pisan las probes
 * con fakes — sin DB, sin FS, sin env.
 */
import { Router, type Request, type Response } from 'express';

import {
  defaultHealthProbes,
  getHealthReport,
  type HealthProbes,
} from '../services/healthService.js';

export const healthRouter = Router();

/** Mismo contrato que jobQueueRouteDeps/publishJobsRouteDeps. */
export const healthRouteDeps: { probes?: HealthProbes } = {};

healthRouter.get('/', async (_req: Request, res: Response) => {
  const report = await getHealthReport(
    healthRouteDeps.probes ?? defaultHealthProbes,
  );
  res.status(report.httpStatus).json(report.body);
});
