import type { Express, Request, Response } from "express";

import { requireAuth } from "../middleware/auth.js";
import {
  exchangeToken,
  discoverAssets,
  getConnectionStatus,
  disconnectMeta,
  checkPermissions,
} from "../services/metaAuthService.js";
import { publishToAllMeta } from "../services/metaPublishService.js";

export function registerMetaRoutes(app: Express): void {
  // ------------------------------------------------------------------
  // GET /api/meta/config - Public IDs for frontend (no secrets)
  // ------------------------------------------------------------------
  app.get("/api/meta/config", requireAuth, (_req: Request, res: Response) => {
    res.json({
      appId: process.env.META_APP_ID || "",
      configId: process.env.META_CONFIG_ID || "",
    });
  });

  // ------------------------------------------------------------------
  // GET /api/meta/status - Connection status
  // ------------------------------------------------------------------
  app.get("/api/meta/status", requireAuth, (_req: Request, res: Response) => {
    try {
      const status = getConnectionStatus();
      res.json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error obteniendo estado de Meta:", message);
      res.status(500).json({ connected: false, error: message });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/meta/connect - Receive code or accessToken from FB popup
  // ------------------------------------------------------------------
  app.post("/api/meta/connect", requireAuth, async (req: Request, res: Response) => {
    const { code, accessToken, redirectUri } = req.body as {
      code?: string;
      accessToken?: string;
      redirectUri?: string;
    };

    if (!code && !accessToken) {
      res.status(400).json({
        error: "Se requiere code o accessToken del popup de Meta",
      });
      return;
    }

    try {
      // 1. Exchange for long-lived token
      const { longLivedToken, expiresIn } = await exchangeToken({
        code,
        accessToken,
        redirectUri,
      });

      // 2. Verify permissions
      const permissions = await checkPermissions(longLivedToken);

      // 3. Discover assets (Pages, IG accounts)
      const assets = await discoverAssets(longLivedToken);

      // 4. Sanitized response (no tokens exposed)
      res.json({
        success: true,
        connected: true,
        expiresIn,
        permissions,
        assets,
      });
    } catch (error: unknown) {
      const axiosData =
        (error as { response?: { data?: { error?: { message?: string } } } })
          .response?.data?.error?.message;
      const message =
        axiosData ||
        (error instanceof Error ? error.message : String(error));
      console.error("Error conectando Meta:", message);
      res.status(500).json({
        success: false,
        error: message,
      });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/meta/disconnect
  // ------------------------------------------------------------------
  app.post("/api/meta/disconnect", requireAuth, (_req: Request, res: Response) => {
    try {
      const result = disconnectMeta();
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error desconectando Meta:", message);
      res.status(500).json({ error: message });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/meta/publish - Publish directly via Meta API
  // ------------------------------------------------------------------
  app.post("/api/meta/publish", requireAuth, async (req: Request, res: Response) => {
    const { title, content, imageUrl, imagePath } = req.body as {
      title?: string;
      content?: string;
      imageUrl?: string;
      imagePath?: string;
    };

    if (!title) {
      res.status(400).json({ error: "Se requiere al menos un titulo" });
      return;
    }

    try {
      const results = await publishToAllMeta({
        title,
        content: content || "",
        imageUrl,
        imagePath,
      });
      res.json({ success: true, results });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error publicando en Meta:", message);
      res.status(500).json({ error: message });
    }
  });
}
