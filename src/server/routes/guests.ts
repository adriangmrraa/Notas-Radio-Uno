import type { Express, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { eq, and, asc } from "drizzle-orm";

import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { guests, guestPhotos } from "../db/schema/guests.js";
import { guestDossiers } from "../db/schema/dossiers.js";
import { programs } from "../db/schema/programs.js";
import { generateGuestDossier, getLatestDossier, listDossiers } from "../services/dossierService.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_PHOTOS_PER_GUEST = 5;

// ---------------------------------------------------------------------------
// Multer — memory storage, 5MB, PNG/JPEG only (high quality for quote flyers)
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (["image/png", "image/jpeg"].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Solo se aceptan imágenes PNG o JPEG"));
    }
  },
});

// ---------------------------------------------------------------------------
// Query helper — fetch guest with photo metadata (no binary)
// ---------------------------------------------------------------------------
async function fetchGuestWithPhotos(guestId: string, tenantId: string) {
  const [guest] = await db
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.tenantId, tenantId)))
    .limit(1);

  if (!guest) return null;

  const photos = await db
    .select({
      id: guestPhotos.id,
      guestId: guestPhotos.guestId,
      mimeType: guestPhotos.mimeType,
      isPrimary: guestPhotos.isPrimary,
      createdAt: guestPhotos.createdAt,
    })
    .from(guestPhotos)
    .where(eq(guestPhotos.guestId, guestId));

  return { ...guest, photos };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerGuestRoutes(app: Express): void {
  // ------------------------------------------------------------------
  // GET /api/guests — List active guests for a program, optional date filter
  // ------------------------------------------------------------------
  app.get("/api/guests", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { programId, date } = req.query as { programId?: string; date?: string };

      if (!programId) {
        res.status(400).json({ error: "El parámetro programId es requerido" });
        return;
      }

      // Verify program belongs to tenant
      const [program] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
        .limit(1);

      if (!program) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }

      // Resolve date filter
      let resolvedDate: string | undefined;
      if (date) {
        if (date === "today") {
          const now = new Date();
          const yyyy = now.getFullYear();
          const mm = String(now.getMonth() + 1).padStart(2, "0");
          const dd = String(now.getDate()).padStart(2, "0");
          resolvedDate = `${yyyy}-${mm}-${dd}`;
        } else {
          resolvedDate = date;
        }
      }

      const rows = await db
        .select()
        .from(guests)
        .where(
          and(
            eq(guests.tenantId, tenantId),
            eq(guests.programId, programId),
            eq(guests.isActive, true),
            resolvedDate ? eq(guests.scheduledDate, resolvedDate) : undefined,
          ),
        )
        .orderBy(asc(guests.scheduledDate), asc(guests.name));

      const guestsWithPhotos = await Promise.all(
        rows.map(async (guest) => {
          const photos = await db
            .select({
              id: guestPhotos.id,
              guestId: guestPhotos.guestId,
              mimeType: guestPhotos.mimeType,
              isPrimary: guestPhotos.isPrimary,
              createdAt: guestPhotos.createdAt,
            })
            .from(guestPhotos)
            .where(eq(guestPhotos.guestId, guest.id));
          return { ...guest, photos };
        }),
      );

      res.json({ guests: guestsWithPhotos });
    } catch (error) {
      console.error("[Guests] Error al listar invitados:", error);
      res.status(500).json({ error: "Error al obtener los invitados" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/guests — Create a guest
  // ------------------------------------------------------------------
  app.post("/api/guests", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const {
        programId,
        name,
        role,
        bio,
        scheduledDate,
        scheduledTimeStart,
        scheduledTimeEnd,
      } = req.body as {
        programId?: string;
        name?: string;
        role?: string;
        bio?: string;
        scheduledDate?: string;
        scheduledTimeStart?: string;
        scheduledTimeEnd?: string;
      };

      if (!programId) {
        res.status(400).json({ error: "El programId es requerido" });
        return;
      }

      if (!name || name.trim() === "") {
        res.status(400).json({ error: "El nombre del invitado es requerido" });
        return;
      }

      if (!role || role.trim() === "") {
        res.status(400).json({ error: "El rol del invitado es requerido" });
        return;
      }

      if (!scheduledDate) {
        res.status(400).json({ error: "La fecha programada es requerida" });
        return;
      }

      // Validate time range if both provided
      if (scheduledTimeStart && scheduledTimeEnd) {
        if (scheduledTimeEnd <= scheduledTimeStart) {
          res.status(400).json({
            error: "La hora de fin debe ser posterior a la hora de inicio",
          });
          return;
        }
      }

      // Verify program belongs to tenant
      const [program] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
        .limit(1);

      if (!program) {
        res.status(404).json({ error: "Programa no encontrado" });
        return;
      }

      const [newGuest] = await db
        .insert(guests)
        .values({
          tenantId,
          programId,
          name: name.trim(),
          role: role.trim(),
          bio: bio ?? null,
          scheduledDate,
          scheduledTimeStart: scheduledTimeStart ?? null,
          scheduledTimeEnd: scheduledTimeEnd ?? null,
        })
        .returning();

      res.status(201).json({ success: true, guest: { ...newGuest, photos: [] } });
    } catch (error) {
      console.error("[Guests] Error al crear invitado:", error);
      res.status(500).json({ error: "Error al crear el invitado" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/guests/:id — Get single guest with photo metadata
  // ------------------------------------------------------------------
  app.get("/api/guests/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      const guest = await fetchGuestWithPhotos(id, tenantId);
      if (!guest) {
        res.status(404).json({ error: "Invitado no encontrado" });
        return;
      }

      res.json({ guest });
    } catch (error) {
      console.error("[Guests] Error al obtener invitado:", error);
      res.status(500).json({ error: "Error al obtener el invitado" });
    }
  });

  // ------------------------------------------------------------------
  // PUT /api/guests/:id — Update guest (partial)
  // ------------------------------------------------------------------
  app.put("/api/guests/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;
      const {
        name,
        role,
        bio,
        scheduledDate,
        scheduledTimeStart,
        scheduledTimeEnd,
        isActive,
      } = req.body as {
        name?: string;
        role?: string;
        bio?: string;
        scheduledDate?: string;
        scheduledTimeStart?: string;
        scheduledTimeEnd?: string;
        isActive?: boolean;
      };

      // Validate time range if both provided
      if (scheduledTimeStart && scheduledTimeEnd) {
        if (scheduledTimeEnd <= scheduledTimeStart) {
          res.status(400).json({
            error: "La hora de fin debe ser posterior a la hora de inicio",
          });
          return;
        }
      }

      const [existing] = await db
        .select({ id: guests.id })
        .from(guests)
        .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Invitado no encontrado" });
        return;
      }

      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name.trim();
      if (role !== undefined) updateData.role = role.trim();
      if (bio !== undefined) updateData.bio = bio;
      if (scheduledDate !== undefined) updateData.scheduledDate = scheduledDate;
      if (scheduledTimeStart !== undefined) updateData.scheduledTimeStart = scheduledTimeStart;
      if (scheduledTimeEnd !== undefined) updateData.scheduledTimeEnd = scheduledTimeEnd;
      if (isActive !== undefined) updateData.isActive = isActive;

      const [updated] = await db
        .update(guests)
        .set(updateData)
        .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
        .returning();

      const photos = await db
        .select({
          id: guestPhotos.id,
          guestId: guestPhotos.guestId,
          mimeType: guestPhotos.mimeType,
          isPrimary: guestPhotos.isPrimary,
          createdAt: guestPhotos.createdAt,
        })
        .from(guestPhotos)
        .where(eq(guestPhotos.guestId, id));

      res.json({ success: true, guest: { ...updated, photos } });
    } catch (error) {
      console.error("[Guests] Error al actualizar invitado:", error);
      res.status(500).json({ error: "Error al actualizar el invitado" });
    }
  });

  // ------------------------------------------------------------------
  // DELETE /api/guests/:id — Soft delete
  // ------------------------------------------------------------------
  app.delete("/api/guests/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      const [existing] = await db
        .select({ id: guests.id })
        .from(guests)
        .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Invitado no encontrado" });
        return;
      }

      await db
        .update(guests)
        .set({ isActive: false })
        .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)));

      res.json({ success: true });
    } catch (error) {
      console.error("[Guests] Error al eliminar invitado:", error);
      res.status(500).json({ error: "Error al eliminar el invitado" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/guests/:id/photos — Upload photo (multipart)
  // ------------------------------------------------------------------
  app.post(
    "/api/guests/:id/photos",
    requireAuth,
    upload.single("photo"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: "Se requiere un archivo de imagen." });
          return;
        }

        const tenantId = req.auth!.tenantId;
        const { id } = req.params;

        // Verify guest ownership
        const [guest] = await db
          .select({ id: guests.id })
          .from(guests)
          .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
          .limit(1);

        if (!guest) {
          res.status(404).json({ error: "Invitado no encontrado" });
          return;
        }

        // Check max photos limit
        const existingPhotos = await db
          .select({ id: guestPhotos.id })
          .from(guestPhotos)
          .where(eq(guestPhotos.guestId, id));

        if (existingPhotos.length >= MAX_PHOTOS_PER_GUEST) {
          res.status(400).json({
            error: `El invitado ya tiene el máximo de ${MAX_PHOTOS_PER_GUEST} fotos`,
          });
          return;
        }

        // Resize + crop to 800x800 with Sharp (high quality for quote flyers)
        const processedBuffer = await sharp(req.file.buffer)
          .resize(800, 800, { fit: "cover" })
          .jpeg({ quality: 90 })
          .toBuffer();

        const isFirst = existingPhotos.length === 0;

        const [newPhoto] = await db
          .insert(guestPhotos)
          .values({
            guestId: id,
            photoData: processedBuffer,
            mimeType: "image/jpeg",
            isPrimary: isFirst,
          })
          .returning({
            id: guestPhotos.id,
            guestId: guestPhotos.guestId,
            mimeType: guestPhotos.mimeType,
            isPrimary: guestPhotos.isPrimary,
            createdAt: guestPhotos.createdAt,
          });

        res.status(201).json({ success: true, photo: newPhoto });
      } catch (error) {
        console.error("[Guests] Error al subir foto:", error);
        res.status(500).json({ error: "Error al procesar la foto" });
      }
    },
  );

  // ------------------------------------------------------------------
  // GET /api/guests/:id/photos/:photoId — Serve photo binary
  // ------------------------------------------------------------------
  app.get(
    "/api/guests/:id/photos/:photoId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id, photoId } = req.params;

        // Verify guest ownership
        const [guest] = await db
          .select({ id: guests.id })
          .from(guests)
          .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
          .limit(1);

        if (!guest) {
          res.status(404).json({ error: "Invitado no encontrado" });
          return;
        }

        // Fetch photo with data
        const [photo] = await db
          .select()
          .from(guestPhotos)
          .where(
            and(
              eq(guestPhotos.id, photoId),
              eq(guestPhotos.guestId, id),
            ),
          )
          .limit(1);

        if (!photo) {
          res.status(404).json({ error: "Foto no encontrada" });
          return;
        }

        res.setHeader("Content-Type", photo.mimeType);
        res.setHeader("Cache-Control", "public, max-age=300");
        res.send(Buffer.from(photo.photoData));
      } catch (error) {
        console.error("[Guests] Error al servir foto:", error);
        res.status(500).json({ error: "Error al obtener la foto" });
      }
    },
  );

  // ------------------------------------------------------------------
  // DELETE /api/guests/:id/photos/:photoId — Delete photo
  // ------------------------------------------------------------------
  app.delete(
    "/api/guests/:id/photos/:photoId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id, photoId } = req.params;

        // Verify guest ownership
        const [guest] = await db
          .select({ id: guests.id })
          .from(guests)
          .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
          .limit(1);

        if (!guest) {
          res.status(404).json({ error: "Invitado no encontrado" });
          return;
        }

        // Fetch the photo to check if it's primary
        const [photo] = await db
          .select({
            id: guestPhotos.id,
            isPrimary: guestPhotos.isPrimary,
            createdAt: guestPhotos.createdAt,
          })
          .from(guestPhotos)
          .where(
            and(
              eq(guestPhotos.id, photoId),
              eq(guestPhotos.guestId, id),
            ),
          )
          .limit(1);

        if (!photo) {
          res.status(404).json({ error: "Foto no encontrada" });
          return;
        }

        await db.transaction(async (tx) => {
          // Delete the photo
          await tx.delete(guestPhotos).where(eq(guestPhotos.id, photoId));

          // If it was primary, promote the oldest remaining photo
          if (photo.isPrimary) {
            const remaining = await tx
              .select({ id: guestPhotos.id })
              .from(guestPhotos)
              .where(eq(guestPhotos.guestId, id))
              .orderBy(guestPhotos.createdAt)
              .limit(1);

            if (remaining.length > 0) {
              await tx
                .update(guestPhotos)
                .set({ isPrimary: true })
                .where(eq(guestPhotos.id, remaining[0].id));
            }
          }
        });

        res.json({ success: true });
      } catch (error) {
        console.error("[Guests] Error al eliminar foto:", error);
        res.status(500).json({ error: "Error al eliminar la foto" });
      }
    },
  );

  // ------------------------------------------------------------------
  // PUT /api/guests/:id/photos/:photoId/primary — Set primary photo
  // ------------------------------------------------------------------
  app.put(
    "/api/guests/:id/photos/:photoId/primary",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id, photoId } = req.params;

        // Verify guest ownership
        const [guest] = await db
          .select({ id: guests.id })
          .from(guests)
          .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
          .limit(1);

        if (!guest) {
          res.status(404).json({ error: "Invitado no encontrado" });
          return;
        }

        // Verify photo belongs to this guest
        const [photo] = await db
          .select({ id: guestPhotos.id })
          .from(guestPhotos)
          .where(
            and(
              eq(guestPhotos.id, photoId),
              eq(guestPhotos.guestId, id),
            ),
          )
          .limit(1);

        if (!photo) {
          res.status(404).json({ error: "Foto no encontrada" });
          return;
        }

        await db.transaction(async (tx) => {
          // Unset all primaries for this guest
          await tx
            .update(guestPhotos)
            .set({ isPrimary: false })
            .where(eq(guestPhotos.guestId, id));

          // Set the target as primary
          await tx
            .update(guestPhotos)
            .set({ isPrimary: true })
            .where(eq(guestPhotos.id, photoId));
        });

        res.json({ success: true });
      } catch (error) {
        console.error("[Guests] Error al establecer foto primaria:", error);
        res.status(500).json({ error: "Error al actualizar la foto primaria" });
      }
    },
  );

  // ==================================================================
  // DOSSIER ROUTES
  // ==================================================================

  // ------------------------------------------------------------------
  // GET /api/guests/:id/dossier — Get latest dossier for a guest
  // ------------------------------------------------------------------
  app.get(
    "/api/guests/:id/dossier",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id } = req.params;

        const dossier = await getLatestDossier(id, tenantId);
        if (!dossier) {
          res.json({ dossier: null });
          return;
        }

        res.json({ dossier });
      } catch (error) {
        console.error("[Dossier] Error al obtener dossier:", error);
        res.status(500).json({ error: "Error al obtener el dossier" });
      }
    },
  );

  // ------------------------------------------------------------------
  // POST /api/guests/:id/dossier — Generate/regenerate dossier on demand
  // ------------------------------------------------------------------
  app.post(
    "/api/guests/:id/dossier",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id } = req.params;

        // Verify guest belongs to tenant
        const [guest] = await db
          .select({ id: guests.id })
          .from(guests)
          .where(and(eq(guests.id, id), eq(guests.tenantId, tenantId)))
          .limit(1);

        if (!guest) {
          res.status(404).json({ error: "Invitado no encontrado" });
          return;
        }

        const result = await generateGuestDossier(id, tenantId);
        res.status(201).json({ success: true, dossierId: result.id, status: result.status });
      } catch (error) {
        console.error("[Dossier] Error al generar dossier:", error);
        res.status(500).json({ error: "Error al generar el dossier" });
      }
    },
  );

  // ------------------------------------------------------------------
  // GET /api/dossiers — List dossiers by program/date
  // ------------------------------------------------------------------
  app.get("/api/dossiers", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { programId, date } = req.query as { programId?: string; date?: string };

      const dossiers = await listDossiers(tenantId, { programId, date });
      res.json({ dossiers });
    } catch (error) {
      console.error("[Dossier] Error al listar dossiers:", error);
      res.status(500).json({ error: "Error al obtener los dossiers" });
    }
  });
}
