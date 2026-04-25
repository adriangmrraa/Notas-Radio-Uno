import type { Express, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { eq } from "drizzle-orm";

import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { tenants } from "../db/schema/tenants.js";
import { invalidateBrandingCache } from "../services/brandingService.js";
import type { FontFamilyId, TemplateId } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Allowed values
// ---------------------------------------------------------------------------
const ALLOWED_FONTS: FontFamilyId[] = [
  "bebas_kai",
  "oswald",
  "roboto_condensed",
  "montserrat",
  "lato",
  "playfair",
];

const ALLOWED_TEMPLATES: TemplateId[] = [
  "dark_gradient",
  "solid_bar",
  "minimal",
  "split",
  "vignette",
];

// ---------------------------------------------------------------------------
// Multer — memory storage, 2MB, PNG/JPEG only
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/png", "image/jpeg"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Solo se aceptan imágenes PNG o JPEG"));
    }
  },
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerBrandingRoutes(app: Express): void {
  // ------------------------------------------------------------------
  // GET /api/branding — Current branding config (no binary data)
  // ------------------------------------------------------------------
  app.get("/api/branding", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;

      const [tenant] = await db
        .select({
          platformName: tenants.platformName,
          fontFamily: tenants.fontFamily,
          templateId: tenants.templateId,
          logoData: tenants.logoData,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant) {
        res.status(404).json({ error: "Tenant no encontrado" });
        return;
      }

      res.json({
        platformName: tenant.platformName,
        fontFamily: tenant.fontFamily as FontFamilyId,
        templateId: tenant.templateId as TemplateId,
        hasLogo: tenant.logoData !== null,
      });
    } catch (error) {
      console.error("[Branding] Error al obtener branding:", error);
      res.status(500).json({ error: "Error al obtener configuración de branding" });
    }
  });

  // ------------------------------------------------------------------
  // PUT /api/branding — Update platformName, fontFamily, templateId
  // ------------------------------------------------------------------
  app.put("/api/branding", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { platformName, fontFamily, templateId } = req.body as {
        platformName?: string;
        fontFamily?: string;
        templateId?: string;
      };

      // Validate fontFamily if provided
      if (fontFamily !== undefined && !ALLOWED_FONTS.includes(fontFamily as FontFamilyId)) {
        res.status(400).json({
          error: `fontFamily inválido. Valores permitidos: ${ALLOWED_FONTS.join(", ")}`,
        });
        return;
      }

      // Validate templateId if provided
      if (templateId !== undefined && !ALLOWED_TEMPLATES.includes(templateId as TemplateId)) {
        res.status(400).json({
          error: `templateId inválido. Valores permitidos: ${ALLOWED_TEMPLATES.join(", ")}`,
        });
        return;
      }

      const updateData: Record<string, unknown> = {};
      if (platformName !== undefined) updateData.platformName = platformName;
      if (fontFamily !== undefined) updateData.fontFamily = fontFamily;
      if (templateId !== undefined) updateData.templateId = templateId;

      await db.update(tenants).set(updateData).where(eq(tenants.id, tenantId));

      invalidateBrandingCache(tenantId);

      // Fetch updated record to return
      const [updated] = await db
        .select({
          platformName: tenants.platformName,
          fontFamily: tenants.fontFamily,
          templateId: tenants.templateId,
          logoData: tenants.logoData,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      res.json({
        success: true,
        branding: {
          platformName: updated.platformName,
          fontFamily: updated.fontFamily as FontFamilyId,
          templateId: updated.templateId as TemplateId,
          hasLogo: updated.logoData !== null,
        },
      });
    } catch (error) {
      console.error("[Branding] Error al actualizar branding:", error);
      res.status(500).json({ error: "Error al actualizar configuración de branding" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/branding/logo — Upload logo (multipart, PNG/JPEG, max 2MB)
  // ------------------------------------------------------------------
  app.post(
    "/api/branding/logo",
    requireAuth,
    upload.single("logo"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: "Se requiere un archivo de imagen." });
          return;
        }

        const tenantId = req.auth!.tenantId;

        // Resize to max 300px width, maintain aspect ratio
        const resized = await sharp(req.file.buffer)
          .resize({ width: 300, withoutEnlargement: true })
          .toBuffer();

        await db
          .update(tenants)
          .set({
            logoData: resized,
            logoMimeType: req.file.mimetype,
          })
          .where(eq(tenants.id, tenantId));

        invalidateBrandingCache(tenantId);

        res.json({ success: true, hasLogo: true });
      } catch (error) {
        console.error("[Branding] Error al subir logo:", error);
        res.status(500).json({ error: "Error al procesar el logo" });
      }
    },
  );

  // ------------------------------------------------------------------
  // DELETE /api/branding/logo — Remove logo
  // ------------------------------------------------------------------
  app.delete("/api/branding/logo", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;

      await db
        .update(tenants)
        .set({ logoData: null, logoMimeType: null })
        .where(eq(tenants.id, tenantId));

      invalidateBrandingCache(tenantId);

      res.json({ success: true });
    } catch (error) {
      console.error("[Branding] Error al eliminar logo:", error);
      res.status(500).json({ error: "Error al eliminar el logo" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/branding/logo — Serve logo binary
  // ------------------------------------------------------------------
  app.get("/api/branding/logo", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;

      const [tenant] = await db
        .select({
          logoData: tenants.logoData,
          logoMimeType: tenants.logoMimeType,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      if (!tenant?.logoData || !tenant.logoMimeType) {
        res.status(404).json({ error: "No hay logo configurado" });
        return;
      }

      res.setHeader("Content-Type", tenant.logoMimeType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(Buffer.from(tenant.logoData));
    } catch (error) {
      console.error("[Branding] Error al servir logo:", error);
      res.status(500).json({ error: "Error al obtener el logo" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/branding/fonts — Available font families
  // ------------------------------------------------------------------
  app.get("/api/branding/fonts", requireAuth, (_req: Request, res: Response) => {
    res.json({
      fonts: [
        { id: "bebas_kai", name: "Bebas Kai" },
        { id: "oswald", name: "Oswald" },
        { id: "roboto_condensed", name: "Roboto Condensed" },
        { id: "montserrat", name: "Montserrat" },
        { id: "lato", name: "Lato" },
        { id: "playfair", name: "Playfair Display" },
      ],
    });
  });

  // ------------------------------------------------------------------
  // GET /api/branding/templates — Available templates
  // ------------------------------------------------------------------
  app.get("/api/branding/templates", requireAuth, (_req: Request, res: Response) => {
    res.json({
      templates: [
        {
          id: "dark_gradient",
          name: "Gradiente Oscuro",
          description: "Gradiente negro de abajo hacia arriba",
        },
        {
          id: "solid_bar",
          name: "Barra Sólida",
          description: "Barra de color sólido en la parte inferior",
        },
        {
          id: "minimal",
          name: "Minimal",
          description: "Diseño limpio con tipografía sobre imagen",
        },
        {
          id: "split",
          name: "Split",
          description: "Imagen y texto divididos en dos mitades",
        },
        {
          id: "vignette",
          name: "Viñeta",
          description: "Viñeta oscura en los bordes con texto centrado",
        },
      ],
    });
  });
}
