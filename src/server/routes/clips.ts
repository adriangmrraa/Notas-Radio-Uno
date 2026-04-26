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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

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
}
