import type { Express, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { eq, and, isNull } from "drizzle-orm";

import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { conductors, conductorPhotos } from "../db/schema/conductors.js";
import { programs } from "../db/schema/programs.js";
import type { ConductorRole } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VALID_ROLES: readonly string[] = [
  "conductor",
  "columnista",
  "productor",
  "invitado",
  "other",
];

const MAX_PHOTOS_PER_CONDUCTOR = 5;

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
// Query helper — fetch conductor with photo metadata (no binary)
// ---------------------------------------------------------------------------
async function fetchConductorWithPhotos(conductorId: string, tenantId: string) {
  const [conductor] = await db
    .select()
    .from(conductors)
    .where(and(eq(conductors.id, conductorId), eq(conductors.tenantId, tenantId)))
    .limit(1);

  if (!conductor) return null;

  const photos = await db
    .select({
      id: conductorPhotos.id,
      conductorId: conductorPhotos.conductorId,
      mimeType: conductorPhotos.mimeType,
      isPrimary: conductorPhotos.isPrimary,
      createdAt: conductorPhotos.createdAt,
    })
    .from(conductorPhotos)
    .where(eq(conductorPhotos.conductorId, conductorId));

  return { ...conductor, photos };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerConductorRoutes(app: Express): void {
  // ------------------------------------------------------------------
  // GET /api/conductors — List active conductors, optional programId filter
  // ------------------------------------------------------------------
  app.get("/api/conductors", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { programId } = req.query as { programId?: string };

      if (programId) {
        const [program] = await db
          .select({ id: programs.id })
          .from(programs)
          .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
          .limit(1);

        if (!program) {
          res.status(404).json({ error: "Programa no encontrado" });
          return;
        }
      }

      const rows = await db
        .select()
        .from(conductors)
        .where(
          and(
            eq(conductors.tenantId, tenantId),
            eq(conductors.isActive, true),
            programId ? eq(conductors.programId, programId) : undefined,
          ),
        );

      const conductorsWithPhotos = await Promise.all(
        rows.map(async (conductor) => {
          const photos = await db
            .select({
              id: conductorPhotos.id,
              conductorId: conductorPhotos.conductorId,
              mimeType: conductorPhotos.mimeType,
              isPrimary: conductorPhotos.isPrimary,
              createdAt: conductorPhotos.createdAt,
            })
            .from(conductorPhotos)
            .where(eq(conductorPhotos.conductorId, conductor.id));
          return { ...conductor, photos };
        }),
      );

      res.json({ conductors: conductorsWithPhotos });
    } catch (error) {
      console.error("[Conductors] Error al listar conductores:", error);
      res.status(500).json({ error: "Error al obtener los conductores" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/conductors — Create a conductor
  // ------------------------------------------------------------------
  app.post("/api/conductors", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { name, role, bio, programId } = req.body as {
        name?: string;
        role?: string;
        bio?: string;
        programId?: string;
      };

      if (!name || name.trim() === "") {
        res.status(400).json({ error: "El nombre del conductor es requerido" });
        return;
      }

      if (role !== undefined && !VALID_ROLES.includes(role)) {
        res.status(400).json({
          error: `Rol inválido: ${role}. Valores permitidos: ${VALID_ROLES.join(", ")}`,
        });
        return;
      }

      // If programId provided, verify it belongs to tenant
      if (programId) {
        const [program] = await db
          .select({ id: programs.id })
          .from(programs)
          .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
          .limit(1);

        if (!program) {
          res.status(404).json({ error: "Programa no encontrado" });
          return;
        }
      }

      const [newConductor] = await db
        .insert(conductors)
        .values({
          tenantId,
          programId: programId ?? null,
          name: name.trim(),
          role: (role as ConductorRole) ?? null,
          bio: bio ?? null,
        })
        .returning();

      res.status(201).json({ success: true, conductor: { ...newConductor, photos: [] } });
    } catch (error) {
      console.error("[Conductors] Error al crear conductor:", error);
      res.status(500).json({ error: "Error al crear el conductor" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/conductors/:id — Get single conductor with photo metadata
  // ------------------------------------------------------------------
  app.get("/api/conductors/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      const conductor = await fetchConductorWithPhotos(id, tenantId);
      if (!conductor) {
        res.status(404).json({ error: "Conductor no encontrado" });
        return;
      }

      res.json({ conductor });
    } catch (error) {
      console.error("[Conductors] Error al obtener conductor:", error);
      res.status(500).json({ error: "Error al obtener el conductor" });
    }
  });

  // ------------------------------------------------------------------
  // PUT /api/conductors/:id — Update conductor
  // ------------------------------------------------------------------
  app.put("/api/conductors/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;
      const { name, role, bio, isActive } = req.body as {
        name?: string;
        role?: string;
        bio?: string;
        isActive?: boolean;
      };

      if (role !== undefined && !VALID_ROLES.includes(role)) {
        res.status(400).json({
          error: `Rol inválido: ${role}. Valores permitidos: ${VALID_ROLES.join(", ")}`,
        });
        return;
      }

      const [existing] = await db
        .select({ id: conductors.id })
        .from(conductors)
        .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Conductor no encontrado" });
        return;
      }

      const updateData: Record<string, unknown> = {};
      if (name !== undefined) updateData.name = name.trim();
      if (role !== undefined) updateData.role = role;
      if (bio !== undefined) updateData.bio = bio;
      if (isActive !== undefined) updateData.isActive = isActive;

      const [updated] = await db
        .update(conductors)
        .set(updateData)
        .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)))
        .returning();

      const photos = await db
        .select({
          id: conductorPhotos.id,
          conductorId: conductorPhotos.conductorId,
          mimeType: conductorPhotos.mimeType,
          isPrimary: conductorPhotos.isPrimary,
          createdAt: conductorPhotos.createdAt,
        })
        .from(conductorPhotos)
        .where(eq(conductorPhotos.conductorId, id));

      res.json({ success: true, conductor: { ...updated, photos } });
    } catch (error) {
      console.error("[Conductors] Error al actualizar conductor:", error);
      res.status(500).json({ error: "Error al actualizar el conductor" });
    }
  });

  // ------------------------------------------------------------------
  // DELETE /api/conductors/:id — Soft delete
  // ------------------------------------------------------------------
  app.delete("/api/conductors/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      const [existing] = await db
        .select({ id: conductors.id })
        .from(conductors)
        .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)))
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Conductor no encontrado" });
        return;
      }

      await db
        .update(conductors)
        .set({ isActive: false })
        .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)));

      res.json({ success: true });
    } catch (error) {
      console.error("[Conductors] Error al eliminar conductor:", error);
      res.status(500).json({ error: "Error al eliminar el conductor" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/conductors/:id/photos — Upload photo (multipart)
  // ------------------------------------------------------------------
  app.post(
    "/api/conductors/:id/photos",
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

        // Verify conductor ownership
        const [conductor] = await db
          .select({ id: conductors.id })
          .from(conductors)
          .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)))
          .limit(1);

        if (!conductor) {
          res.status(404).json({ error: "Conductor no encontrado" });
          return;
        }

        // Check max photos limit
        const existingPhotos = await db
          .select({ id: conductorPhotos.id })
          .from(conductorPhotos)
          .where(eq(conductorPhotos.conductorId, id));

        if (existingPhotos.length >= MAX_PHOTOS_PER_CONDUCTOR) {
          res.status(400).json({
            error: `El conductor ya tiene el máximo de ${MAX_PHOTOS_PER_CONDUCTOR} fotos`,
          });
          return;
        }

        // Resize + crop to 400x400 with Sharp
        const processedBuffer = await sharp(req.file.buffer)
          .resize(400, 400, { fit: "cover" })
          .jpeg()
          .toBuffer();

        const isFirst = existingPhotos.length === 0;

        const [newPhoto] = await db
          .insert(conductorPhotos)
          .values({
            conductorId: id,
            photoData: processedBuffer,
            mimeType: "image/jpeg",
            isPrimary: isFirst,
          })
          .returning({
            id: conductorPhotos.id,
            conductorId: conductorPhotos.conductorId,
            mimeType: conductorPhotos.mimeType,
            isPrimary: conductorPhotos.isPrimary,
            createdAt: conductorPhotos.createdAt,
          });

        res.status(201).json({ success: true, photo: newPhoto });
      } catch (error) {
        console.error("[Conductors] Error al subir foto:", error);
        res.status(500).json({ error: "Error al procesar la foto" });
      }
    },
  );

  // ------------------------------------------------------------------
  // GET /api/conductors/:id/photos/:photoId — Serve photo binary
  // ------------------------------------------------------------------
  app.get(
    "/api/conductors/:id/photos/:photoId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id, photoId } = req.params;

        // Verify conductor ownership
        const [conductor] = await db
          .select({ id: conductors.id })
          .from(conductors)
          .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)))
          .limit(1);

        if (!conductor) {
          res.status(404).json({ error: "Conductor no encontrado" });
          return;
        }

        // Fetch photo with data
        const [photo] = await db
          .select()
          .from(conductorPhotos)
          .where(
            and(
              eq(conductorPhotos.id, photoId),
              eq(conductorPhotos.conductorId, id),
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
        console.error("[Conductors] Error al servir foto:", error);
        res.status(500).json({ error: "Error al obtener la foto" });
      }
    },
  );

  // ------------------------------------------------------------------
  // DELETE /api/conductors/:id/photos/:photoId — Delete photo
  // ------------------------------------------------------------------
  app.delete(
    "/api/conductors/:id/photos/:photoId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id, photoId } = req.params;

        // Verify conductor ownership
        const [conductor] = await db
          .select({ id: conductors.id })
          .from(conductors)
          .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)))
          .limit(1);

        if (!conductor) {
          res.status(404).json({ error: "Conductor no encontrado" });
          return;
        }

        // Fetch the photo to check if it's primary
        const [photo] = await db
          .select({
            id: conductorPhotos.id,
            isPrimary: conductorPhotos.isPrimary,
            createdAt: conductorPhotos.createdAt,
          })
          .from(conductorPhotos)
          .where(
            and(
              eq(conductorPhotos.id, photoId),
              eq(conductorPhotos.conductorId, id),
            ),
          )
          .limit(1);

        if (!photo) {
          res.status(404).json({ error: "Foto no encontrada" });
          return;
        }

        await db.transaction(async (tx) => {
          // Delete the photo
          await tx.delete(conductorPhotos).where(eq(conductorPhotos.id, photoId));

          // If it was primary, promote the oldest remaining photo
          if (photo.isPrimary) {
            const remaining = await tx
              .select({ id: conductorPhotos.id })
              .from(conductorPhotos)
              .where(eq(conductorPhotos.conductorId, id))
              .orderBy(conductorPhotos.createdAt)
              .limit(1);

            if (remaining.length > 0) {
              await tx
                .update(conductorPhotos)
                .set({ isPrimary: true })
                .where(eq(conductorPhotos.id, remaining[0].id));
            }
          }
        });

        res.json({ success: true });
      } catch (error) {
        console.error("[Conductors] Error al eliminar foto:", error);
        res.status(500).json({ error: "Error al eliminar la foto" });
      }
    },
  );

  // ------------------------------------------------------------------
  // PUT /api/conductors/:id/photos/:photoId/primary — Set primary photo
  // ------------------------------------------------------------------
  app.put(
    "/api/conductors/:id/photos/:photoId/primary",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const tenantId = req.auth!.tenantId;
        const { id, photoId } = req.params;

        // Verify conductor ownership
        const [conductor] = await db
          .select({ id: conductors.id })
          .from(conductors)
          .where(and(eq(conductors.id, id), eq(conductors.tenantId, tenantId)))
          .limit(1);

        if (!conductor) {
          res.status(404).json({ error: "Conductor no encontrado" });
          return;
        }

        // Verify photo belongs to this conductor
        const [photo] = await db
          .select({ id: conductorPhotos.id })
          .from(conductorPhotos)
          .where(
            and(
              eq(conductorPhotos.id, photoId),
              eq(conductorPhotos.conductorId, id),
            ),
          )
          .limit(1);

        if (!photo) {
          res.status(404).json({ error: "Foto no encontrada" });
          return;
        }

        await db.transaction(async (tx) => {
          // Unset all primaries for this conductor
          await tx
            .update(conductorPhotos)
            .set({ isPrimary: false })
            .where(eq(conductorPhotos.conductorId, id));

          // Set the target as primary
          await tx
            .update(conductorPhotos)
            .set({ isPrimary: true })
            .where(eq(conductorPhotos.id, photoId));
        });

        res.json({ success: true });
      } catch (error) {
        console.error("[Conductors] Error al establecer foto primaria:", error);
        res.status(500).json({ error: "Error al actualizar la foto primaria" });
      }
    },
  );
}
