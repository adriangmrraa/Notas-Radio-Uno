import type { Express, Request, Response } from "express";

import { requireAuth } from "../middleware/auth.js";
import { getSetting, setSetting } from "../services/databaseService.js";

// ---------------------------------------------------------------------------
// Webhook URL helpers (async — read from DB with env fallback)
// ---------------------------------------------------------------------------
async function getWebhookUrl(settingKey: string, envKey: string): Promise<string> {
  return (await getSetting(settingKey)) || process.env[envKey] || "";
}

export async function getWebhookNuevoBoton(): Promise<string> {
  return getWebhookUrl("webhook_nuevo_boton", "WEBHOOK_URL_NUEVO_BOTON");
}

export async function getWebhookViejoBoton(): Promise<string> {
  return getWebhookUrl("webhook_viejo_boton", "WEBHOOK_URL_VIEJO_BOTON");
}

export async function getWebhookTercerBoton(): Promise<string> {
  return getWebhookUrl("webhook_tercer_boton", "WEBHOOK_URL_TERCER_BOTON");
}

export function registerSettingsRoutes(app: Express): void {
  // ------------------------------------------------------------------
  // GET /api/settings/webhooks
  // ------------------------------------------------------------------
  app.get("/api/settings/webhooks", requireAuth, async (_req: Request, res: Response) => {
    const [nuevoBoton, viejoBoton, tercerBoton, pipeline] = await Promise.all([
      getWebhookNuevoBoton(),
      getWebhookViejoBoton(),
      getWebhookTercerBoton(),
      getSetting("webhook_pipeline").then((v) => v || process.env.WEBHOOK_URL_PIPELINE || ""),
    ]);

    res.json({
      webhook_nuevo_boton: nuevoBoton,
      webhook_viejo_boton: viejoBoton,
      webhook_tercer_boton: tercerBoton,
      webhook_pipeline: pipeline,
    });
  });

  // ------------------------------------------------------------------
  // POST /api/settings/webhooks
  // ------------------------------------------------------------------
  app.post("/api/settings/webhooks", requireAuth, async (req: Request, res: Response) => {
    const {
      webhook_nuevo_boton,
      webhook_viejo_boton,
      webhook_tercer_boton,
      webhook_pipeline,
    } = req.body as Record<string, string | undefined>;

    const updates: Promise<void>[] = [];

    if (webhook_nuevo_boton !== undefined) {
      updates.push(setSetting("webhook_nuevo_boton", webhook_nuevo_boton));
    }
    if (webhook_viejo_boton !== undefined) {
      updates.push(setSetting("webhook_viejo_boton", webhook_viejo_boton));
    }
    if (webhook_tercer_boton !== undefined) {
      updates.push(setSetting("webhook_tercer_boton", webhook_tercer_boton));
    }
    if (webhook_pipeline !== undefined) {
      updates.push(setSetting("webhook_pipeline", webhook_pipeline));
    }

    await Promise.all(updates);

    res.json({
      success: true,
      message: "Webhooks actualizados correctamente.",
    });
  });
}

