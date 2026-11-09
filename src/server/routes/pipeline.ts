import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";
import type { PipelineConfig, PipelineStatus } from "../../shared/types.js";
import { randomUUID } from "crypto";

import { AutoPipeline } from "../services/pipelineService.js";
import { TONE_PROMPTS, STRUCTURE_PROMPTS } from "../services/newsService.js";
import { requireAuth, requireActiveSubscription } from "../middleware/auth.js";
import {
  consumeTransmission,
  releaseTransmission,
  registerActiveTransmissionChecker,
  RELEASE_WINDOW_MINUTES,
} from "../services/transmissionMeteringService.js";
import { db } from "../db/index.js";
import { programs } from "../db/schema/programs.js";
import { eq, and } from "drizzle-orm";

// Per-tenant pipeline instances
const pipelines: Map<string, AutoPipeline> = new Map();

export function registerPipelineRoutes(app: Express, io: Server): void {
  // El liberador de reservas stale consulta este mapa para saber qué
  // transmisiones siguen vivas. Se usa SÓLO para no liberar cuota de algo que
  // corre — jamás para detener un pipeline por cuota.
  registerActiveTransmissionChecker((tenantId) => Boolean(pipelines.get(tenantId)?.running));

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
      programId,
    } = req.body as Partial<PipelineConfig> & { url?: string };

    if (!url) {
      res.status(400).json({ error: "Se requiere una URL de transmision." });
      return;
    }

    try {
      // Validate programId if provided
      if (programId) {
        const [program] = await db
          .select({ id: programs.id })
          .from(programs)
          .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
          .limit(1);

        if (!program) {
          res.status(400).json({ error: "El programa seleccionado no existe o no pertenece a este tenant." });
          return;
        }
      }

      const existing = pipelines.get(tenantId);
      if (existing && existing.running) {
        res.status(400).json({
          error: "El pipeline ya esta en ejecucion. Detenelo primero.",
        });
        return;
      }

      // ── Medición de cuota (Épica B) ──────────────────────────────────────
      // Guarda de regresión: el early return de arriba garantiza que el
      // medidor NUNCA se consulta con un pipeline activo — una transmisión
      // en curso jamás se corta ni se re-cobra por cuota. No agregar chequeos
      // de cuota en /stop, en el loop del pipeline ni en el scheduler.
      const operationId = randomUUID();
      const consumption = await consumeTransmission({
        tenantId,
        operationId,
        transmissionRef: url,
      });

      if (!consumption.allowed) {
        res.status(402).json({
          error: "No te quedan transmisiones en este ciclo",
          code: "QUOTA_EXCEEDED",
          quota: consumption.quota,
          upsell: { canBuyAddons: true, canUpgrade: true },
        });
        return;
      }

      const pipeline = new AutoPipeline(io, tenantId);
      pipelines.set(tenantId, pipeline);

      const startedAt = Date.now();
      try {
        await pipeline.start({
          url,
          tone: tone || "formal",
          structure: structure || "completa",
          imageModel: imageModel || "gemini",
          segmentDuration: segmentDuration || 120,
          autoPublish: autoPublish !== false,
          ...(programId ? { programId } : {}),
        });
      } catch (startError) {
        // Si el arranque falla dentro de la ventana la transmisión no se cobra:
        // nunca se cobra una transmisión que no llegó a iniciar. Pasada la
        // ventana, la reserva queda consumida (y si queda stale la libera el
        // scheduler cuando el pipeline ya no esté activo).
        if (Date.now() - startedAt < RELEASE_WINDOW_MINUTES * 60_000) {
          await releaseTransmission({ tenantId, operationId, reason: "start_failed" }).catch((releaseErr) => {
            console.error(`[Pipeline][${tenantId}] No se pudo liberar la reserva de cuota:`, releaseErr);
          });
        }
        throw startError;
      }

      res.json({
        success: true,
        message: "Pipeline autonomo iniciado.",
        config: pipeline.config,
        usage: { operationId, remaining: consumption.quota.remaining },
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
