import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";

import {
  getAllPublications,
  deletePublication,
  countPublications,
  getAllTranscriptions,
  deleteTranscription,
  countTranscriptions,
} from "../services/databaseService.js";

export function registerHistoryRoutes(app: Express, io: Server): void {
  // ------------------------------------------------------------------
  // GET /api/history/publications
  // ------------------------------------------------------------------
  app.get("/api/history/publications", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const publications = getAllPublications(limit, offset);
    const total = countPublications();
    res.json({ publications, total });
  });

  // ------------------------------------------------------------------
  // DELETE /api/history/publications/:id
  // ------------------------------------------------------------------
  app.delete("/api/history/publications/:id", (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id));
    const deleted = deletePublication(id);
    if (deleted) {
      io.emit("history-delete-publication", { id });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Publicacion no encontrada" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/history/transcriptions
  // ------------------------------------------------------------------
  app.get("/api/history/transcriptions", (req: Request, res: Response) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const transcriptions = getAllTranscriptions(limit, offset);
    const total = countTranscriptions();
    res.json({ transcriptions, total });
  });

  // ------------------------------------------------------------------
  // DELETE /api/history/transcriptions/:id
  // ------------------------------------------------------------------
  app.delete("/api/history/transcriptions/:id", (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id));
    const deleted = deleteTranscription(id);
    if (deleted) {
      io.emit("history-delete-transcription", { id });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Transcripcion no encontrada" });
    }
  });
}
