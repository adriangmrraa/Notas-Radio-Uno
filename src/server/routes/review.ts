/**
 * review.ts — Rutas del Copiloto Editorial
 *
 * Gestiona la cola de revisión humana: listar publicaciones pendientes, aprobar,
 * rechazar, editar texto con IA y regenerar imágenes.
 *
 * Todas las rutas requieren autenticación JWT. El tenantId se extrae del token.
 */

import type { Express, Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { requireAuth } from "../middleware/auth.js";
import {
  getPublicationsByStatus,
  getReviewPublicationById,
  updatePublicationStatus,
  updatePublicationContent,
  addEditHistoryEntry,
} from "../services/databaseService.js";
import { publishToChannels } from "../services/publishService.js";
import { chatCompletion } from "../services/aiSdkService.js";
import { processImage } from "../services/imageService.js";
import { loadTenantBranding } from "../services/brandingService.js";
import type { EditHistoryEntry, TemplateId, FontFamilyId } from "../../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Timestamp ISO para entradas de historial */
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Registro de rutas
// ---------------------------------------------------------------------------

export function registerReviewRoutes(app: Express): void {

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/review — Listar publicaciones por estado
  // ────────────────────────────────────────────────────────────────────────────
  app.get("/api/review", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const status = (req.query.status as string) || "pending_review";
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const result = await getPublicationsByStatus(tenantId, status, limit, offset);
    res.json(result);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // GET /api/review/:id — Detalle de una publicación para revisión
  // ────────────────────────────────────────────────────────────────────────────
  app.get("/api/review/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }
    res.json(pub);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/review/:id/approve — Aprobar y publicar en todos los canales
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/:id/approve", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    // Publicar en todos los canales configurados
    let publishResults;
    try {
      publishResults = await publishToChannels({
        id,
        tenantId,
        title: pub.title ?? "",
        content: pub.content ?? "",
        imagePath: pub.imagePath ?? null,
        imageUrl: pub.imageUrl ?? null,
      });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al publicar: ${e.message}` });
      return;
    }

    // Agregar entrada al historial (publishToChannels ya actualizó el status a 'published')
    const entry: EditHistoryEntry = {
      action: 'approved',
      timestamp: now(),
      by: req.auth!.userId,
    };
    await addEditHistoryEntry(id, tenantId, entry);

    res.json({ success: true, publishResults });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/review/:id/reject — Rechazar / descartar publicación
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/:id/reject", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    await updatePublicationStatus(id, tenantId, 'rejected');

    const entry: EditHistoryEntry = {
      action: 'rejected',
      timestamp: now(),
      by: req.auth!.userId,
    };
    await addEditHistoryEntry(id, tenantId, entry);

    res.json({ success: true });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/review/:id/edit-text — Edición de texto asistida por IA
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/:id/edit-text", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;
    const { prompt } = req.body as { prompt?: string };

    if (!prompt?.trim()) {
      res.status(400).json({ error: "Se requiere el campo 'prompt'" });
      return;
    }

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    // Llamar a la IA para regenerar texto
    let newTitle = pub.title ?? "";
    let newContent = pub.content ?? "";

    try {
      const aiPrompt = `Sos un editor periodístico. Tenés esta nota:

Título: ${pub.title ?? ""}
Contenido: ${pub.content ?? ""}

El usuario pidió: "${prompt}"

Devolvé el título y contenido modificados en formato JSON: { "title": "...", "content": "..." }`;

      const { text } = await chatCompletion({
        userPrompt: aiPrompt,
        temperature: 0.5,
        maxTokens: 1500,
        jsonMode: true,
      });

      const parsed = JSON.parse(text) as { title?: string; content?: string };
      if (parsed.title) newTitle = parsed.title;
      if (parsed.content) newContent = parsed.content;
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al generar texto con IA: ${e.message}` });
      return;
    }

    // Actualizar en DB
    const updated = await updatePublicationContent(id, tenantId, {
      title: newTitle,
      content: newContent,
    });

    const entry: EditHistoryEntry = {
      action: 'text_edit',
      prompt,
      timestamp: now(),
      by: req.auth!.userId,
    };
    await addEditHistoryEntry(id, tenantId, entry);

    res.json({ success: true, publication: updated });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/review/:id/edit-image — Regenerar imagen con nuevos parámetros de branding
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/:id/edit-image", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;
    const { prompt, templateId, fontFamily } = req.body as {
      prompt?: string;
      templateId?: TemplateId;
      fontFamily?: FontFamilyId;
    };

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    if (!pub.imagePath) {
      res.status(400).json({ error: "La publicación no tiene imagen para regenerar" });
      return;
    }

    try {
      // Cargar branding del tenant y sobreescribir con los parámetros recibidos
      const branding = await loadTenantBranding(tenantId);
      if (templateId) branding.templateId = templateId;
      if (fontFamily) branding.fontFamily = fontFamily;

      const newImagePath = await processImage(pub.imagePath, pub.title ?? "", branding);
      const newImageUrl = `/output/${path.basename(newImagePath)}`;

      const updated = await updatePublicationContent(id, tenantId, {
        imagePath: newImagePath,
        imageUrl: newImageUrl,
      });

      const entry: EditHistoryEntry = {
        action: 'image_edit',
        prompt: prompt ?? `template: ${templateId ?? 'default'}, font: ${fontFamily ?? 'default'}`,
        timestamp: now(),
        by: req.auth!.userId,
      };
      await addEditHistoryEntry(id, tenantId, entry);

      res.json({ success: true, imageUrl: newImageUrl, publication: updated });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al regenerar imagen: ${e.message}` });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/review/batch — Operaciones en lote (aprobar o rechazar múltiples)
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/batch", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const { ids, action } = req.body as { ids?: string[]; action?: 'approve' | 'reject' };

    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: "Se requiere 'ids' como array no vacío" });
      return;
    }
    if (action !== 'approve' && action !== 'reject') {
      res.status(400).json({ error: "El campo 'action' debe ser 'approve' o 'reject'" });
      return;
    }

    let processed = 0;
    let errors = 0;

    for (const id of ids) {
      try {
        const pub = await getReviewPublicationById(id, tenantId);
        if (!pub) { errors++; continue; }

        if (action === 'approve') {
          await publishToChannels({
            id,
            tenantId,
            title: pub.title ?? "",
            content: pub.content ?? "",
            imagePath: pub.imagePath ?? null,
            imageUrl: pub.imageUrl ?? null,
          });
          await addEditHistoryEntry(id, tenantId, {
            action: 'approved',
            timestamp: now(),
            by: req.auth!.userId,
          });
        } else {
          await updatePublicationStatus(id, tenantId, 'rejected');
          await addEditHistoryEntry(id, tenantId, {
            action: 'rejected',
            timestamp: now(),
            by: req.auth!.userId,
          });
        }
        processed++;
      } catch (err) {
        console.error(`[Review] Error procesando publicación ${id}:`, (err as Error).message);
        errors++;
      }
    }

    res.json({ success: true, processed, errors });
  });
}
