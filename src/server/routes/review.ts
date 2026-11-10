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
import { auditFromRequest, AUDIT_ACTIONS } from "../services/auditService.js";
import {
  getPublicationsByStatus,
  getReviewPublicationById,
  updatePublicationStatus,
  updatePublicationContent,
  addEditHistoryEntry,
} from "../services/databaseService.js";
import { publishToChannels } from "../services/publishService.js";
import { AppError } from "../lib/errors.js";
import {
  enqueueForApproval,
  previewPublishEnqueue,
  validatePublishOptions,
  type EnqueueForApprovalResult,
  type PublishJobDeps,
  type PublishPreviewResult,
} from "../services/publishJobService.js";
import { chatCompletion } from "../services/aiSdkService.js";
import { processImage } from "../services/imageService.js";
import { loadTenantBranding } from "../services/brandingService.js";
import { generateContentVariants, regenerateVariant } from "../services/contentMultiplierService.js";
import {
  programBelongsToTenant,
  resolveEditorialPromptContext,
} from "../services/editorialPromptService.js";
import type { EditHistoryEntry, TemplateId, FontFamilyId, ContentVariants } from "../../shared/types.js";

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

/**
 * PG-05 — deps inyectables del circuito approve → publish jobs.
 *
 * `enqueueForApproval` decide dentro: con conexiones Zernio encola un job
 * por cuenta destino (`usedZernio:true`); sin conexiones devuelve
 * `usedZernio:false` y el flujo legacy (`publishToChannels`) corre intacto.
 * Los tests pisan la fn y/o los stores vía `publishJobDeps`.
 */
export const reviewPublishDeps: {
  enqueueForApproval?: (
    input: {
      tenantId: string;
      assetId?: string | null;
      publicationId?: string | null;
      content: string;
      mediaUrls?: string[];
      scheduledFor?: Date | null;
      /** PG-06: personas explícitas / excluidas / etiquetas del request. */
      personIds?: string[];
      excludePersonIds?: string[];
      hashtags?: string[];
    },
    deps?: PublishJobDeps,
  ) => Promise<EnqueueForApprovalResult>;
  /** PG-06: previsualización de texto final por red (sin encolar). */
  previewPublishEnqueue?: (
    input: {
      tenantId: string;
      assetId?: string | null;
      publicationId?: string | null;
      content: string;
      personIds?: string[];
      excludePersonIds?: string[];
      hashtags?: string[];
    },
    deps?: PublishJobDeps,
  ) => Promise<PublishPreviewResult>;
  publishJobDeps?: PublishJobDeps;
} = {};

/** AppError → su status; cualquier otra cosa → 500. */
function routePublishError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
    });
    return;
  }
  const e = err as Error;
  res.status(500).json({ error: `${fallback}: ${e.message}` });
}

/** Media publicable por Zernio: sólo URLs absolutas http(s) — los paths locales no los puede leer. */
function publicMediaUrls(imageUrl: string | null | undefined): string[] {
  return imageUrl && /^https?:\/\//.test(imageUrl) ? [imageUrl] : [];
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
  // POST /api/review/:id/publish-preview — PG-06: texto final por red
  // (menciones reales + etiquetas) ANTES de aprobar. No encola nada.
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/:id/publish-preview", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    try {
      const opts = validatePublishOptions((req.body ?? {}) as Record<string, unknown>);
      const previewFn = reviewPublishDeps.previewPublishEnqueue ?? previewPublishEnqueue;
      const preview = await previewFn(
        {
          tenantId,
          publicationId: id,
          content: pub.content ?? "",
          ...opts,
        },
        reviewPublishDeps.publishJobDeps,
      );
      res.json(preview);
    } catch (err) {
      routePublishError(res, err, "Error al generar la previsualización");
    }
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

    // PG-05: con conexiones Zernio el approve encola publish jobs (un job
    // por cuenta destino) y la publicación queda 'approved' — el worker la
    // pasa a 'published' cuando todos los jobs publican (queda 'approved'
    // si alguno queda partial/failed). Sin conexiones → legacy intacto.
    // PG-06: el body puede traer personIds/excludePersonIds/hashtags — se
    // validan y componen el texto final por red dentro del enqueue.
    try {
      const opts = validatePublishOptions((req.body ?? {}) as Record<string, unknown>);
      const enqueueFn = reviewPublishDeps.enqueueForApproval ?? enqueueForApproval;
      const enq = await enqueueFn(
        {
          tenantId,
          publicationId: id,
          content: pub.content ?? "",
          mediaUrls: publicMediaUrls(pub.imageUrl),
          ...opts,
        },
        reviewPublishDeps.publishJobDeps,
      );

      if (enq.usedZernio) {
        await updatePublicationStatus(id, tenantId, 'approved');

        const entry: EditHistoryEntry = {
          action: 'approved',
          timestamp: now(),
          by: req.auth!.userId,
        };
        await addEditHistoryEntry(id, tenantId, entry);

        void auditFromRequest(req, AUDIT_ACTIONS.PUBLICATION_APPROVED, {
          entityType: 'publication',
          entityId: id,
          metadata: { publishJobs: enq.jobs.length, targets: enq.targets.length },
        });

        res.json({
          success: true,
          publish: 'zernio',
          enqueued: enq.createdCount,
          deduplicated: enq.deduplicatedCount,
          targetCount: enq.targets.length,
          jobs: enq.jobs,
        });
        return;
      }
    } catch (err) {
      const e = err as Error;
      void auditFromRequest(req, AUDIT_ACTIONS.PUBLISH_FAILED, {
        outcome: 'error',
        entityType: 'publication',
        entityId: id,
        metadata: { error: e.message },
      });
      routePublishError(res, err, 'Error al encolar la publicación');
      return;
    }

    // Sin conexiones Zernio: publicar en todos los canales configurados (legacy).
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
      void auditFromRequest(req, AUDIT_ACTIONS.PUBLISH_FAILED, {
        outcome: 'error',
        entityType: 'publication',
        entityId: id,
        metadata: { error: e.message },
      });
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

    void auditFromRequest(req, AUDIT_ACTIONS.PUBLISH, {
      entityType: 'publication',
      entityId: id,
      metadata: { results: publishResults },
    });
    void auditFromRequest(req, AUDIT_ACTIONS.PUBLICATION_APPROVED, {
      entityType: 'publication',
      entityId: id,
    });

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

    void auditFromRequest(req, AUDIT_ACTIONS.PUBLICATION_REJECTED, {
      entityType: 'publication',
      entityId: id,
    });

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
  // GET /api/review/:id/variants — Retorna las variantes de contenido guardadas
  // ────────────────────────────────────────────────────────────────────────────
  app.get("/api/review/:id/variants", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    if (!pub.contentVariants) {
      res.status(404).json({ error: "Esta publicación no tiene variantes de contenido generadas" });
      return;
    }

    res.json({ variants: pub.contentVariants });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/review/:id/regenerate-variant — Regenera una variante específica
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/:id/regenerate-variant", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;
    const { variant, prompt: customPrompt, programId } = req.body as {
      variant?: keyof ContentVariants;
      prompt?: string;
      programId?: string;
    };

    const validVariants: Array<keyof ContentVariants> = [
      'twitterThread', 'instagramCarousel', 'linkedinPost', 'youtubeDescription', 'newsletterBlurb',
    ];

    if (!variant || !validVariants.includes(variant)) {
      res.status(400).json({
        error: `El campo 'variant' es requerido. Valores válidos: ${validVariants.join(', ')}`,
      });
      return;
    }

    if (programId !== undefined && typeof programId !== "string") {
      res.status(400).json({ error: "programId debe ser un string." });
      return;
    }

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    if (!pub.title || !pub.content) {
      res.status(400).json({ error: "La publicación no tiene título o contenido" });
      return;
    }

    try {
      // programId opcional (PC-06): si viene, debe ser del tenant.
      if (programId && !(await programBelongsToTenant(tenantId, programId.trim()))) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }
      const editorial = await resolveEditorialPromptContext(tenantId, programId?.trim() || null);
      const regenerated = await regenerateVariant(pub.title, pub.content, variant, customPrompt, editorial.block);

      // Actualizar la variante en DB manteniendo las demás intactas
      const currentVariants: ContentVariants = pub.contentVariants ?? {
        twitterThread: [],
        instagramCarousel: [],
        linkedinPost: "",
        youtubeDescription: "",
        newsletterBlurb: "",
      };
      const updatedVariants: ContentVariants = { ...currentVariants, [variant]: regenerated };

      await updatePublicationContent(id, tenantId, { contentVariants: updatedVariants });

      await addEditHistoryEntry(id, tenantId, {
        action: 'text_edit',
        prompt: `Regenerar variante "${variant}"${customPrompt ? `: ${customPrompt}` : ""}`,
        timestamp: now(),
        by: req.auth!.userId,
      });

      res.json({ success: true, variant, content: regenerated });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al regenerar la variante: ${e.message}` });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // POST /api/review/:id/generate-variants — Genera variantes si no existen
  // ────────────────────────────────────────────────────────────────────────────
  app.post("/api/review/:id/generate-variants", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.auth!.tenantId;
    const id = req.params.id;

    const pub = await getReviewPublicationById(id, tenantId);
    if (!pub) {
      res.status(404).json({ error: "Publicación no encontrada" });
      return;
    }

    if (!pub.title || !pub.content) {
      res.status(400).json({ error: "La publicación no tiene título o contenido" });
      return;
    }

    const { programId } = (req.body ?? {}) as { programId?: string };
    if (programId !== undefined && typeof programId !== "string") {
      res.status(400).json({ error: "programId debe ser un string." });
      return;
    }

    try {
      // programId opcional (PC-06): si viene, debe ser del tenant. El tono
      // pasa a ser el de la línea editorial cuando existe (antes "formal"
      // hardcodeado); sin perfil se mantiene "formal".
      if (programId && !(await programBelongsToTenant(tenantId, programId.trim()))) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }
      const editorial = await resolveEditorialPromptContext(tenantId, programId?.trim() || null);
      const variants = await generateContentVariants(pub.title, pub.content, editorial.tone ?? "formal", editorial);
      await updatePublicationContent(id, tenantId, { contentVariants: variants });
      res.json({ success: true, variants });
    } catch (err) {
      const e = err as Error;
      res.status(500).json({ error: `Error al generar variantes: ${e.message}` });
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
          // PG-05: mismo branch que /:id/approve — con conexiones Zernio
          // encola jobs y la publicación queda 'approved'; sin conexiones
          // el publishToChannels legacy corre como antes.
          const enqueueFn = reviewPublishDeps.enqueueForApproval ?? enqueueForApproval;
          const enq = await enqueueFn(
            {
              tenantId,
              publicationId: id,
              content: pub.content ?? "",
              mediaUrls: publicMediaUrls(pub.imageUrl),
            },
            reviewPublishDeps.publishJobDeps,
          );
          if (enq.usedZernio) {
            await updatePublicationStatus(id, tenantId, 'approved');
          } else {
            await publishToChannels({
              id,
              tenantId,
              title: pub.title ?? "",
              content: pub.content ?? "",
              imagePath: pub.imagePath ?? null,
              imageUrl: pub.imageUrl ?? null,
            });
          }
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
