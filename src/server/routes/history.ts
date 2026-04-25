import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";

import {
  getAllPublications,
  deletePublication,
  countPublications,
  getAllTranscriptions,
  deleteTranscription,
  countTranscriptions,
  getPendingPublications,
  approvePublication,
  updatePublication,
  getPublicationById,
} from "../services/databaseService.js";
import { requireAuth } from "../middleware/auth.js";

export function registerHistoryRoutes(app: Express, io: Server): void {
  // ------------------------------------------------------------------
  // GET /api/history/publications
  // ------------------------------------------------------------------
  app.get("/api/history/publications", requireAuth, async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const publications = await getAllPublications(limit, offset);
    const total = await countPublications();
    res.json({ publications, total });
  });

  // ------------------------------------------------------------------
  // GET /api/history/publications/pending — Publicaciones pendientes de aprobación
  // ------------------------------------------------------------------
  app.get("/api/history/publications/pending", requireAuth, async (_req: Request, res: Response) => {
    const publications = await getPendingPublications();
    res.json({ publications });
  });

  // ------------------------------------------------------------------
  // GET /api/history/publications/:id
  // ------------------------------------------------------------------
  app.get("/api/history/publications/:id", requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const pub = await getPublicationById(id);
    if (!pub) {
      res.status(404).json({ error: "Publicacion no encontrada" });
      return;
    }
    res.json(pub);
  });

  // ------------------------------------------------------------------
  // PUT /api/history/publications/:id — Editar título, contenido, imagen
  // ------------------------------------------------------------------
  app.put("/api/history/publications/:id", requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const { title, content, imagePath, imageUrl } = req.body;
    const updated = await updatePublication(id, { title, content, imagePath, imageUrl });
    if (!updated) {
      res.status(404).json({ error: "Publicacion no encontrada" });
      return;
    }
    const tenantId = req.auth!.tenantId;
    io.to(`tenant:${tenantId}`).emit("publication-updated", updated);
    res.json(updated);
  });

  // ------------------------------------------------------------------
  // POST /api/history/publications/:id/approve — Aprobar y publicar
  // ------------------------------------------------------------------
  app.post("/api/history/publications/:id/approve", requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const pub = await approvePublication(id);
    if (!pub) {
      res.status(404).json({ error: "Publicacion no encontrada" });
      return;
    }
    const tenantId = req.auth!.tenantId;
    io.to(`tenant:${tenantId}`).emit("publication-approved", pub);
    res.json({ success: true, publication: pub });
  });

  // ------------------------------------------------------------------
  // POST /api/history/publications/:id/reject — Rechazar publicación
  // ------------------------------------------------------------------
  app.post("/api/history/publications/:id/reject", requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const updated = await updatePublication(id, { status: 'rejected' });
    if (!updated) {
      res.status(404).json({ error: "Publicacion no encontrada" });
      return;
    }
    const tenantId = req.auth!.tenantId;
    io.to(`tenant:${tenantId}`).emit("publication-rejected", updated);
    res.json({ success: true });
  });

  // ------------------------------------------------------------------
  // DELETE /api/history/publications/:id
  // ------------------------------------------------------------------
  app.delete("/api/history/publications/:id", requireAuth, async (req: Request, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const id = String(req.params.id);
    const deleted = await deletePublication(id);
    if (deleted) {
      io.to(`tenant:${tenantId}`).emit("history-delete-publication", { id });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Publicacion no encontrada" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/history/transcriptions
  // ------------------------------------------------------------------
  app.get("/api/history/transcriptions", requireAuth, async (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const transcriptions = await getAllTranscriptions(limit, offset);
    const total = await countTranscriptions();
    res.json({ transcriptions, total });
  });

  // ------------------------------------------------------------------
  // DELETE /api/history/transcriptions/:id
  // ------------------------------------------------------------------
  app.delete("/api/history/transcriptions/:id", requireAuth, async (req: Request, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const id = String(req.params.id);
    const deleted = await deleteTranscription(id);
    if (deleted) {
      io.to(`tenant:${tenantId}`).emit("history-delete-transcription", { id });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Transcripcion no encontrada" });
    }
  });
}
