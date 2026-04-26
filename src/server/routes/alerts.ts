/**
 * alerts.ts — Rutas para gestión de keywords de alertas en vivo
 *
 * GET  /api/settings/alert-keywords  — obtiene keywords configurados del tenant
 * PUT  /api/settings/alert-keywords  — actualiza keywords (body: { keywords: string[] })
 */

import type { Express, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getSetting, setSetting } from "../services/databaseService.js";

const SETTING_KEY = "alert_keywords";

export function registerAlertRoutes(app: Express): void {
  // ── GET /api/settings/alert-keywords ──────────────────────────────────────
  app.get("/api/settings/alert-keywords", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const raw = await getSetting(SETTING_KEY, tenantId);
      const keywords: string[] = raw ? JSON.parse(raw) : [];
      res.json({ keywords });
    } catch (err) {
      console.error("[AlertRoutes] Error fetching keywords:", (err as Error).message);
      res.status(500).json({ error: "Error obteniendo keywords" });
    }
  });

  // ── PUT /api/settings/alert-keywords ──────────────────────────────────────
  app.put("/api/settings/alert-keywords", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { keywords } = req.body as { keywords?: unknown };

      if (!Array.isArray(keywords)) {
        res.status(400).json({ error: "keywords debe ser un array de strings" });
        return;
      }

      const cleaned = keywords
        .filter((k) => typeof k === "string" && k.trim().length > 0)
        .map((k) => (k as string).trim().toLowerCase())
        .slice(0, 100); // máximo 100 keywords

      await setSetting(SETTING_KEY, JSON.stringify(cleaned), tenantId);
      res.json({ success: true, keywords: cleaned });
    } catch (err) {
      console.error("[AlertRoutes] Error saving keywords:", (err as Error).message);
      res.status(500).json({ error: "Error guardando keywords" });
    }
  });
}
