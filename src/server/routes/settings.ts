import type { Express, Request, Response } from "express";

import { requireAuth } from "../middleware/auth.js";
import { getSetting, setSetting } from "../services/databaseService.js";

// ---------------------------------------------------------------------------
// Webhook URL helpers
// ---------------------------------------------------------------------------
function getWebhookUrl(settingKey: string, envKey: string): string {
  return getSetting(settingKey) || process.env[envKey] || "";
}

function getWebhookNuevoBoton(): string {
  return getWebhookUrl("webhook_nuevo_boton", "WEBHOOK_URL_NUEVO_BOTON");
}

function getWebhookViejoBoton(): string {
  return getWebhookUrl("webhook_viejo_boton", "WEBHOOK_URL_VIEJO_BOTON");
}

function getWebhookTercerBoton(): string {
  return getWebhookUrl("webhook_tercer_boton", "WEBHOOK_URL_TERCER_BOTON");
}

export function registerSettingsRoutes(app: Express): void {
  // ------------------------------------------------------------------
  // GET /api/settings/webhooks
  // ------------------------------------------------------------------
  app.get("/api/settings/webhooks", requireAuth, (_req: Request, res: Response) => {
    res.json({
      webhook_nuevo_boton: getWebhookNuevoBoton(),
      webhook_viejo_boton: getWebhookViejoBoton(),
      webhook_tercer_boton: getWebhookTercerBoton(),
      webhook_pipeline:
        getSetting("webhook_pipeline") ||
        process.env.WEBHOOK_URL_PIPELINE ||
        "",
    });
  });

  // ------------------------------------------------------------------
  // POST /api/settings/webhooks
  // ------------------------------------------------------------------
  app.post("/api/settings/webhooks", requireAuth, (req: Request, res: Response) => {
    const {
      webhook_nuevo_boton,
      webhook_viejo_boton,
      webhook_tercer_boton,
      webhook_pipeline,
    } = req.body as Record<string, string | undefined>;

    if (webhook_nuevo_boton !== undefined) {
      setSetting("webhook_nuevo_boton", webhook_nuevo_boton);
    }
    if (webhook_viejo_boton !== undefined) {
      setSetting("webhook_viejo_boton", webhook_viejo_boton);
    }
    if (webhook_tercer_boton !== undefined) {
      setSetting("webhook_tercer_boton", webhook_tercer_boton);
    }
    if (webhook_pipeline !== undefined) {
      setSetting("webhook_pipeline", webhook_pipeline);
    }

    res.json({
      success: true,
      message: "Webhooks actualizados correctamente.",
    });
  });
}

// Re-export helpers for use in generate routes
export { getWebhookNuevoBoton, getWebhookViejoBoton, getWebhookTercerBoton };
