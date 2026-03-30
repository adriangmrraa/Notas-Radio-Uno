import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";
import type { PipelineConfig, PipelineStatus } from "../../shared/types.js";

import { AutoPipeline } from "../services/pipelineService.js";
import { TONE_PROMPTS, STRUCTURE_PROMPTS } from "../services/newsService.js";
import { requireAuth, requireActiveSubscription } from "../middleware/auth.js";

// Per-tenant pipeline instances
const pipelines: Map<string, AutoPipeline> = new Map();

export function registerPipelineRoutes(app: Express, io: Server): void {
  // ------------------------------------------------------------------
  // POST /api/pipeline/start
  // ------------------------------------------------------------------
  app.post("/api/pipeline/start", requireAuth, requireActiveSubscription, async (req: Request, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const {
      url,
      tone,
      structure,
      imageModel,
      segmentDuration,
      autoPublish,
    } = req.body as Partial<PipelineConfig> & { url?: string };

    if (!url) {
      res.status(400).json({ error: "Se requiere una URL de transmision." });
      return;
    }

    try {
      const existing = pipelines.get(tenantId);
      if (existing && existing.running) {
        res.status(400).json({
          error: "El pipeline ya esta en ejecucion. Detenelo primero.",
        });
        return;
      }

      const pipeline = new AutoPipeline(io, tenantId);
      pipelines.set(tenantId, pipeline);

      await pipeline.start({
        url,
        tone: tone || "formal",
        structure: structure || "completa",
        imageModel: imageModel || "gemini",
        segmentDuration: segmentDuration || 120,
        autoPublish: autoPublish !== false,
      });

      res.json({
        success: true,
        message: "Pipeline autonomo iniciado.",
        config: pipeline.config,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Pipeline][${tenantId}] Error iniciando:`, message);
      res.status(500).json({ error: message });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/pipeline/stop
  // ------------------------------------------------------------------
  app.post("/api/pipeline/stop", requireAuth, (req: Request, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const pipeline = pipelines.get(tenantId);

    if (!pipeline || !pipeline.running) {
      res.status(400).json({ error: "No hay pipeline en ejecucion." });
      return;
    }

    pipeline.stop();
    res.json({
      success: true,
      message: "Pipeline detenido.",
      stats: {
        totalPublished: pipeline.publishedNotes.length,
      },
    });
  });

  // ------------------------------------------------------------------
  // GET /api/pipeline/status
  // ------------------------------------------------------------------
  app.get("/api/pipeline/status", requireAuth, (req: Request, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const pipeline = pipelines.get(tenantId);

    if (!pipeline) {
      const idle = {
        running: false,
        currentStep: "idle",
        chunksTranscribed: 0,
        totalMinutes: 0,
        transcriptionLength: 0,
        publishedTopics: [] as string[],
        totalPublished: 0,
        publishedNotes: [] as any[],
      };
      res.json(idle);
      return;
    }
    res.json(pipeline.getStatus());
  });

  // ------------------------------------------------------------------
  // GET /api/pipeline/options
  // ------------------------------------------------------------------
  app.get("/api/pipeline/options", (_req: Request, res: Response) => {
    res.json({
      tones: Object.keys(TONE_PROMPTS).map((key) => ({
        value: key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        description: TONE_PROMPTS[key],
      })),
      structures: Object.keys(STRUCTURE_PROMPTS).map((key) => ({
        value: key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        description: STRUCTURE_PROMPTS[key],
      })),
    });
  });

  // ------------------------------------------------------------------
  // Expose pipelines map for graceful shutdown
  // ------------------------------------------------------------------
  app.set("pipelines", () => pipelines);
}
