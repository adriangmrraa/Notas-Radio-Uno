import type { Express, Request, Response } from "express";
import { eq, and } from "drizzle-orm";

import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { programs, programUrls, programUrlTypeValues } from "../db/schema/programs.js";
import { conductors } from "../db/schema/conductors.js";
import type { PlatformType } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

const VALID_URL_TYPES: readonly string[] = programUrlTypeValues;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------
async function fetchProgramWithUrls(programId: string, tenantId: string) {
  const [program] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
    .limit(1);

  if (!program) return null;

  const [urls, programConductors] = await Promise.all([
    db
      .select()
      .from(programUrls)
      .where(eq(programUrls.programId, programId)),
    db
      .select({
        id: conductors.id,
        name: conductors.name,
        role: conductors.role,
        bio: conductors.bio,
        isActive: conductors.isActive,
        programId: conductors.programId,
        createdAt: conductors.createdAt,
      })
      .from(conductors)
      .where(and(eq(conductors.programId, programId), eq(conductors.isActive, true))),
  ]);

  return { ...program, urls, conductors: programConductors };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerProgramRoutes(app: Express): void {
  // ------------------------------------------------------------------
  // GET /api/programs — List active programs for tenant
  // ------------------------------------------------------------------
  app.get("/api/programs", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;

      const rows = await db
        .select()
        .from(programs)
        .where(and(eq(programs.tenantId, tenantId), eq(programs.isActive, true)));

      // Fetch urls for all programs
      const programsWithUrls = await Promise.all(
        rows.map(async (program) => {
          const urls = await db
            .select()
            .from(programUrls)
            .where(eq(programUrls.programId, program.id));
          return { ...program, urls };
        }),
      );

      res.json({ programs: programsWithUrls });
    } catch (error) {
      console.error("[Programs] Error al listar programas:", error);
      res.status(500).json({ error: "Error al obtener los programas" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/programs — Create a new program
  // ------------------------------------------------------------------
  app.post("/api/programs", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { name, description, schedule, urls } = req.body as {
        name?: string;
        description?: string;
        schedule?: string;
        urls?: Array<{ type: string; url: string; label?: string }>;
      };

      if (!name || name.trim() === "") {
        res.status(400).json({ error: "El nombre del programa es requerido" });
        return;
      }

      // Validate urls if provided
      if (urls && Array.isArray(urls)) {
        for (const urlItem of urls) {
          if (!VALID_URL_TYPES.includes(urlItem.type)) {
            res.status(400).json({
              error: `Tipo de URL inválido: ${urlItem.type}. Valores permitidos: ${VALID_URL_TYPES.join(", ")}`,
            });
            return;
          }
          if (!isValidUrl(urlItem.url)) {
            res.status(400).json({ error: `URL inválida: ${urlItem.url}` });
            return;
          }
        }
      }

      // Transaction: insert program + urls atomically
      const result = await db.transaction(async (tx) => {
        const [newProgram] = await tx
          .insert(programs)
          .values({
            tenantId,
            name: name.trim(),
            description: description ?? null,
            schedule: schedule ?? null,
          })
          .returning();

        let insertedUrls: typeof programUrls.$inferSelect[] = [];
        if (urls && Array.isArray(urls) && urls.length > 0) {
          insertedUrls = await tx
            .insert(programUrls)
            .values(
              urls.map((u) => ({
                programId: newProgram.id,
                type: u.type,
                url: u.url,
                label: u.label ?? null,
              })),
            )
            .returning();
        }

        return { ...newProgram, urls: insertedUrls };
      });

      res.status(201).json({ success: true, program: result });
    } catch (error) {
      console.error("[Programs] Error al crear programa:", error);
      res.status(500).json({ error: "Error al crear el programa" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/programs/:id — Get single program with urls
  // ------------------------------------------------------------------
  app.get("/api/programs/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      const program = await fetchProgramWithUrls(id, tenantId);
      if (!program) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }

      res.json({ program });
    } catch (error) {
      console.error("[Programs] Error al obtener programa:", error);
      res.status(500).json({ error: "Error al obtener el programa" });
    }
  });

  // ------------------------------------------------------------------
  // PUT /api/programs/:id — Update program (replace urls if provided)
  // ------------------------------------------------------------------
  app.put("/api/programs/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;
      const { name, description, schedule, isActive, urls } = req.body as {
        name?: string;
        description?: string;
        schedule?: string;
        isActive?: boolean;
        urls?: Array<{ type: string; url: string; label?: string }>;
      };

      // Verify ownership
      const [existing] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, id), eq(programs.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }

      // Validate urls if provided
      if (urls && Array.isArray(urls)) {
        for (const urlItem of urls) {
          if (!VALID_URL_TYPES.includes(urlItem.type)) {
            res.status(400).json({
              error: `Tipo de URL inválido: ${urlItem.type}. Valores permitidos: ${VALID_URL_TYPES.join(", ")}`,
            });
            return;
          }
          if (!isValidUrl(urlItem.url)) {
            res.status(400).json({ error: `URL inválida: ${urlItem.url}` });
            return;
          }
        }
      }

      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name.trim();
      if (description !== undefined) updateData.description = description;
      if (schedule !== undefined) updateData.schedule = schedule;
      if (isActive !== undefined) updateData.isActive = isActive;

      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(programs)
          .set(updateData)
          .where(and(eq(programs.id, id), eq(programs.tenantId, tenantId)))
          .returning();

        let finalUrls: typeof programUrls.$inferSelect[];
        if (urls !== undefined) {
          // Replace pattern: delete all, insert new
          await tx.delete(programUrls).where(eq(programUrls.programId, id));

          if (urls.length > 0) {
            finalUrls = await tx
              .insert(programUrls)
              .values(
                urls.map((u) => ({
                  programId: id,
                  type: u.type,
                  url: u.url,
                  label: u.label ?? null,
                })),
              )
              .returning();
          } else {
            finalUrls = [];
          }
        } else {
          finalUrls = await tx
            .select()
            .from(programUrls)
            .where(eq(programUrls.programId, id));
        }

        return { ...updated, urls: finalUrls };
      });

      res.json({ success: true, program: result });
    } catch (error) {
      console.error("[Programs] Error al actualizar programa:", error);
      res.status(500).json({ error: "Error al actualizar el programa" });
    }
  });

  // ------------------------------------------------------------------
  // DELETE /api/programs/:id — Soft delete (isActive = false)
  // ------------------------------------------------------------------
  app.delete("/api/programs/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      const [existing] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, id), eq(programs.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }

      await db.transaction(async (tx) => {
        // Soft-delete all conductors belonging to this program
        await tx
          .update(conductors)
          .set({ isActive: false })
          .where(eq(conductors.programId, id));

        // Soft-delete the program itself
        await tx
          .update(programs)
          .set({ isActive: false })
          .where(and(eq(programs.id, id), eq(programs.tenantId, tenantId)));
      });

      res.json({ success: true });
    } catch (error) {
      console.error("[Programs] Error al eliminar programa:", error);
      res.status(500).json({ error: "Error al eliminar el programa" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/programs/:id/urls — Add a URL to a program
  // ------------------------------------------------------------------
  app.post("/api/programs/:id/urls", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;
      const { type, url, label } = req.body as {
        type?: string;
        url?: string;
        label?: string;
      };

      // Validate type
      if (!type || !VALID_URL_TYPES.includes(type)) {
        res.status(400).json({
          error: `Tipo de URL inválido. Valores permitidos: ${VALID_URL_TYPES.join(", ")}`,
        });
        return;
      }

      // Validate url
      if (!url || !isValidUrl(url)) {
        res.status(400).json({ error: "URL inválida o requerida" });
        return;
      }

      // Verify program ownership
      const [program] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, id), eq(programs.tenantId, tenantId)))
        .limit(1);

      if (!program) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }

      const [newUrl] = await db
        .insert(programUrls)
        .values({
          programId: id,
          type: type as PlatformType,
          url,
          label: label ?? null,
        })
        .returning();

      res.status(201).json({ success: true, url: newUrl });
    } catch (error) {
      console.error("[Programs] Error al agregar URL:", error);
      res.status(500).json({ error: "Error al agregar la URL" });
    }
  });

  // ------------------------------------------------------------------
  // DELETE /api/programs/:id/urls/:urlId — Remove a URL from a program
  // ------------------------------------------------------------------
  app.delete(
    "/api/programs/:id/urls/:urlId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id, urlId } = req.params;

        // Verify program ownership
        const [program] = await db
          .select({ id: programs.id })
          .from(programs)
          .where(and(eq(programs.id, id), eq(programs.tenantId, tenantId)))
          .limit(1);

        if (!program) {
          res.status(404).json({ error: "Programa no encontrado" });
          return;
        }

        // Verify url belongs to this program
        const [existingUrl] = await db
          .select({ id: programUrls.id })
          .from(programUrls)
          .where(and(eq(programUrls.id, urlId), eq(programUrls.programId, id)))
          .limit(1);

        if (!existingUrl) {
          res.status(404).json({ error: "URL no encontrada" });
          return;
        }

        await db.delete(programUrls).where(eq(programUrls.id, urlId));

        res.json({ success: true });
      } catch (error) {
        console.error("[Programs] Error al eliminar URL:", error);
        res.status(500).json({ error: "Error al eliminar la URL" });
      }
    },
  );
}
