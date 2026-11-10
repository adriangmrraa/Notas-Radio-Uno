/**
 * clips.ts — Rutas de Auto-Clips Verticales
 *
 * Gestiona los clips generados automáticamente por el pipeline:
 * listar, ver detalle, servir video, aprobar y eliminar.
 *
 * Todas las rutas requieren autenticación JWT. El tenantId se extrae del token.
 */

import type { Express, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { requireAuth } from '../middleware/auth.js';
import {
  getClipsByTenant,
  getClipById,
  updateClipStatus,
  deleteClip,
} from '../services/clipService.js';
import {
  clipRecutService,
  ClipRecutError,
  type ClipRecutErrorReason,
  type RecutClipInput,
  type RecutClipResult,
} from '../services/clipRecutService.js';
import {
  clipRenderQueueService,
  type ClipRenderJob,
} from '../services/clipRenderQueueService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Deps inyectables (mismo patrón que liveRouteDeps/transmissionsRouteDeps)
// ---------------------------------------------------------------------------

/**
 * En producción quedan vacías (los servicios usan sus singletons drizzle);
 * los tests las pisan con servicios sobre stores en memoria — el router se
 * monta en una app express efímera sin tocar Neon.
 */
export const clipsRouteDeps: {
  recutClip?: (input: RecutClipInput) => Promise<RecutClipResult>;
  listJobsByClip?: (
    clipId: string,
    tenantId: string,
  ) => Promise<ClipRenderJob[]>;
  getRenderJob?: (
    jobId: string,
    tenantId: string,
  ) => Promise<ClipRenderJob | null>;
  retryRenderJob?: (
    jobId: string,
    tenantId: string,
  ) => Promise<ClipRenderJob | null>;
} = {};

/** reason del ClipRecutError → HTTP (contrato del slice PF-05). */
const RECUT_ERROR_HTTP: Record<ClipRecutErrorReason, number> = {
  clip_not_found: 404,
  // El clip existe pero su transmisión origen se borró (FK set null):
  // estado del recurso que lo hace improcesable — no es un conflicto
  // transitorio que se resuelva reintentando (eso sería 409).
  no_transmission: 422,
  invalid_window: 422,
  window_out_of_coverage: 409,
  clip_rendering: 409,
};

// ---------------------------------------------------------------------------
// Registro de rutas
// ---------------------------------------------------------------------------

export function registerClipRoutes(app: Express): void {

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/clips — Listar clips del tenant (con filtro de status)
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/clips', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const status = req.query.status as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    try {
      const result = await getClipsByTenant(tenantId, status, limit, offset);
      res.json(result);
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al listar clips: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/clips/:id — Detalle de un clip
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/clips/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;

    try {
      const clip = await getClipById(id, tenantId);
      if (!clip) {
        res.status(404).json({ error: 'Clip no encontrado' });
        return;
      }
      res.json(clip);
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al obtener clip: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/clips/:id/video — Servir el archivo de video MP4
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/clips/:id/video', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;

    try {
      const clip = await getClipById(id, tenantId);
      if (!clip) {
        res.status(404).json({ error: 'Clip no encontrado' });
        return;
      }
      if (!clip.videoPath) {
        res.status(404).json({ error: 'El clip aún no tiene video generado' });
        return;
      }

      const videoPath = clip.videoPath;
      if (!fs.existsSync(videoPath)) {
        res.status(404).json({ error: 'Archivo de video no encontrado en disco' });
        return;
      }

      const stat = fs.statSync(videoPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        // Range request for video streaming
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4',
        });
        fs.createReadStream(videoPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
          'Content-Disposition': `attachment; filename="clip_${id}.mp4"`,
        });
        fs.createReadStream(videoPath).pipe(res);
      }
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al servir video: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/clips/:id/approve — Aprobar clip (→ ready)
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/clips/:id/approve', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;

    try {
      const clip = await getClipById(id, tenantId);
      if (!clip) {
        res.status(404).json({ error: 'Clip no encontrado' });
        return;
      }

      await updateClipStatus(id, tenantId, 'ready');
      res.json({ success: true });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al aprobar clip: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/clips/:id — Eliminar clip
  // ──────────────────────────────────────────────────────────────────────────
  app.delete('/api/clips/:id', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;

    try {
      const clip = await getClipById(id, tenantId);
      if (!clip) {
        res.status(404).json({ error: 'Clip no encontrado' });
        return;
      }

      await deleteClip(id, tenantId);
      res.json({ success: true });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al eliminar clip: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/clips/:id/recut — Re-corte manual (PF-05)
  //
  // Body {startMs, endMs} (offsets en ms sobre la línea de tiempo grabada).
  // Valida la ventana contra el crudo ANTES de encolar y devuelve 202 con el
  // job de la cola de render — el clip derivado lo crea el worker (kind 'cut').
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/clips/:id/recut', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;
    const body = (req.body ?? {}) as { startMs?: unknown; endMs?: unknown };

    // 400: el body tiene que traer DOS números finitos (el resto de las
    // validaciones de la ventana — rango, duración, cobertura — es del
    // servicio y se traduce por `reason`).
    if (
      typeof body.startMs !== 'number' ||
      typeof body.endMs !== 'number' ||
      !Number.isFinite(body.startMs) ||
      !Number.isFinite(body.endMs)
    ) {
      res.status(400).json({
        error: 'startMs y endMs deben ser números finitos',
        code: 'invalid_body',
      });
      return;
    }

    try {
      const recut = clipsRouteDeps.recutClip ??
        ((input: RecutClipInput) => clipRecutService.recutClip(input));
      const { job } = await recut({
        tenantId,
        clipId: id,
        startMs: body.startMs,
        endMs: body.endMs,
      });
      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err) {
      if (err instanceof ClipRecutError) {
        res
          .status(RECUT_ERROR_HTTP[err.reason] ?? 500)
          .json({ error: err.message, code: err.reason });
        return;
      }
      const e = err as Error;
      res.status(500).json({ error: `Error al re-cortar el clip: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/clips/:id/jobs — Jobs de render ligados al clip (PF-05)
  //
  // listByClip matchea por clip_id (destino) O payload.recutOf (origen), así
  // el recut job aparece acá — y cuando termina, su clip_id muestra el clip
  // derivado. Un clip ajeno/inexistente devuelve lista vacía (sin leak).
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/clips/:id/jobs', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;

    try {
      const list = clipsRouteDeps.listJobsByClip ??
        ((clipId: string, tId: string) =>
          clipRenderQueueService.listJobsByClip(clipId, tId));
      const jobs = await list(id, tenantId);
      res.json({ jobs });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al listar jobs del clip: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/render-jobs/:jobId — Estado de un job de render (PF-05)
  //
  // Para el polling de la UI: status/attempts/last_error y, cuando termina,
  // clip_id = el clip derivado.
  // ──────────────────────────────────────────────────────────────────────────
  app.get('/api/render-jobs/:jobId', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { jobId } = req.params;

    try {
      const get = clipsRouteDeps.getRenderJob ??
        ((jId: string, tId: string) => clipRenderQueueService.getJob(jId, tId));
      const job = await get(jobId, tenantId);
      if (!job) {
        res.status(404).json({ error: 'Job de render no encontrado' });
        return;
      }
      res.json({ job });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al obtener el job: ${e.message}` });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/render-jobs/:jobId/retry — Reintento manual de un job (PF-05)
  //
  // Sólo desde 'error' o 'cancelled' (contrato del store): 404 si el job no
  // existe para el tenant, 409 si está en otro estado.
  // ──────────────────────────────────────────────────────────────────────────
  app.post('/api/render-jobs/:jobId/retry', requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { jobId } = req.params;

    try {
      const get = clipsRouteDeps.getRenderJob ??
        ((jId: string, tId: string) => clipRenderQueueService.getJob(jId, tId));
      const existing = await get(jobId, tenantId);
      if (!existing) {
        res.status(404).json({ error: 'Job de render no encontrado' });
        return;
      }

      const retry = clipsRouteDeps.retryRenderJob ??
        ((jId: string, tId: string) =>
          clipRenderQueueService.retryJob(jId, tId));
      const job = await retry(jobId, tenantId);
      if (!job) {
        res.status(409).json({
          error: `El job está '${existing.status}' — sólo se reintentan jobs en error o cancelados`,
          code: 'job_not_retryable',
        });
        return;
      }
      res.json({ job });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al reintentar el job: ${e.message}` });
    }
  });
}
