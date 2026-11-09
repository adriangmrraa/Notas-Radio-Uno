import { Router, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { and, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";

import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { persons, personPhotos, personProgram } from "../db/schema/persons.js";
import { programs } from "../db/schema/programs.js";
import { conductors } from "../db/schema/conductors.js";
import { guests } from "../db/schema/guests.js";
import { personRoleEnum } from "../db/schema/enums.js";
import {
  createDrizzleFaceStore,
  disenrollFace,
  enrollFace,
  getFaceStatus,
} from "../services/faceEnrollmentService.js";
import { getFaceDetector } from "../services/faceDetectionService.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VALID_ROLES: readonly string[] = personRoleEnum.enumValues;
const MAX_PHOTOS_PER_PERSON = 5;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_NAME_LENGTH = 255;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Multer — memory storage, 5MB, PNG/JPEG only (field name: "file")
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

function uploadSingle(req: Request, res: Response, next: () => void): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const message =
        err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
          ? "La imagen supera el máximo de 5MB"
          : err instanceof Error
            ? err.message
            : "Archivo inválido";
      res.status(400).json({ error: message });
      return;
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const photoMetaSelect = {
  id: personPhotos.id,
  personId: personPhotos.personId,
  mimeType: personPhotos.mimeType,
  isPrimary: personPhotos.isPrimary,
  faceDetected: personPhotos.faceDetected,
  faceCount: personPhotos.faceCount,
  width: personPhotos.width,
  height: personPhotos.height,
  createdAt: personPhotos.createdAt,
} as const;

async function fetchPhotosMetadata(personIds: string[], tenantId: string) {
  if (personIds.length === 0) return [];
  return db
    .select(photoMetaSelect)
    .from(personPhotos)
    .where(
      and(
        eq(personPhotos.tenantId, tenantId),
        inArray(personPhotos.personId, personIds),
      ),
    );
}

async function fetchPersonPrograms(personIds: string[], tenantId: string) {
  if (personIds.length === 0) return [];
  return db
    .select({
      id: personProgram.id,
      personId: personProgram.personId,
      programId: personProgram.programId,
      roleOnProgram: personProgram.roleOnProgram,
      isPrimary: personProgram.isPrimary,
      programName: programs.name,
    })
    .from(personProgram)
    .innerJoin(
      programs,
      and(eq(personProgram.programId, programs.id), eq(programs.tenantId, tenantId)),
    )
    .where(
      and(
        eq(personProgram.tenantId, tenantId),
        inArray(personProgram.personId, personIds),
      ),
    );
}

async function fetchPersonDetail(personId: string, tenantId: string) {
  const [person] = await db
    .select()
    .from(persons)
    .where(and(eq(persons.id, personId), eq(persons.tenantId, tenantId)))
    .limit(1);

  if (!person) return null;

  const [photos, links] = await Promise.all([
    fetchPhotosMetadata([personId], tenantId),
    fetchPersonPrograms([personId], tenantId),
  ]);

  return {
    ...person,
    photos,
    programs: links.map(({ personId: _pid, ...link }) => link),
  };
}

/** Verifies that every programId exists within the tenant. Returns the deduped ids or null if any is foreign/unknown. */
async function validateProgramIds(
  programIds: string[],
  tenantId: string,
): Promise<string[] | null> {
  const uniqueIds = [...new Set(programIds)];
  if (uniqueIds.length === 0) return [];
  const found = await db
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.tenantId, tenantId), inArray(programs.id, uniqueIds)));
  return found.length === uniqueIds.length ? uniqueIds : null;
}

function escapeIlike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Router — mounted at /api/persons
// ---------------------------------------------------------------------------
export const personsRouter = Router();

// ------------------------------------------------------------------
// GET /api/persons — Paginated list with filters
// ------------------------------------------------------------------
personsRouter.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { search, role, programId, active } = req.query as {
      search?: string;
      role?: string;
      programId?: string;
      active?: string;
    };

    const page = Math.max(1, Number.parseInt(String(req.query.page ?? ""), 10) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.parseInt(String(req.query.limit ?? ""), 10) || DEFAULT_LIMIT),
    );

    if (role !== undefined && !VALID_ROLES.includes(role)) {
      res.status(400).json({
        error: `Rol inválido: ${role}. Valores permitidos: ${VALID_ROLES.join(", ")}`,
      });
      return;
    }

    const conditions: (SQL | undefined)[] = [eq(persons.tenantId, tenantId)];

    if (search && search.trim() !== "") {
      conditions.push(ilike(persons.name, `%${escapeIlike(search.trim())}%`));
    }
    if (role) {
      conditions.push(eq(persons.role, role as (typeof personRoleEnum.enumValues)[number]));
    }
    if (active === "true") {
      conditions.push(eq(persons.isActive, true));
    } else if (active === "false") {
      conditions.push(eq(persons.isActive, false));
    }
    // "all" (o ausente) no agrega filtro de estado.

    if (programId) {
      conditions.push(
        inArray(
          persons.id,
          db
            .select({ id: personProgram.personId })
            .from(personProgram)
            .where(
              and(
                eq(personProgram.tenantId, tenantId),
                eq(personProgram.programId, programId),
              ),
            ),
        ),
      );
    }

    const where = and(...conditions);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(persons)
      .where(where);

    const rows = await db
      .select()
      .from(persons)
      .where(where)
      .orderBy(persons.name)
      .limit(limit)
      .offset((page - 1) * limit);

    const ids = rows.map((r) => r.id);
    const [photos, links] = await Promise.all([
      fetchPhotosMetadata(ids, tenantId),
      fetchPersonPrograms(ids, tenantId),
    ]);

    const items = rows.map((person) => ({
      ...person,
      photos: photos.filter((p) => p.personId === person.id),
      programs: links
        .filter((l) => l.personId === person.id)
        .map(({ personId: _pid, ...link }) => link),
    }));

    res.json({ items, total: count, page, limit });
  } catch (error) {
    console.error("[Persons] Error al listar personas:", error);
    res.status(500).json({ error: "Error al obtener las personas" });
  }
});

// ------------------------------------------------------------------
// GET /api/persons/:id — Person detail (person + photos + programs)
// ------------------------------------------------------------------
personsRouter.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;

    const person = await fetchPersonDetail(id, tenantId);
    if (!person) {
      res.status(404).json({ error: "Persona no encontrada" });
      return;
    }

    res.json({ person });
  } catch (error) {
    console.error("[Persons] Error al obtener persona:", error);
    res.status(500).json({ error: "Error al obtener la persona" });
  }
});

// ------------------------------------------------------------------
// POST /api/persons — Create person
// ------------------------------------------------------------------
personsRouter.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const {
      name,
      role,
      roleLabel,
      bio,
      notes,
      socialLinks,
      isActive,
      programIds,
      roleOnProgram,
    } = req.body as {
      name?: string;
      role?: string;
      roleLabel?: string;
      bio?: string;
      notes?: string;
      socialLinks?: Record<string, unknown>;
      isActive?: boolean;
      programIds?: string[];
      roleOnProgram?: Record<string, string>;
    };

    if (typeof name !== "string" || name.trim() === "") {
      res.status(400).json({ error: "El nombre de la persona es requerido" });
      return;
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      res.status(400).json({
        error: `El nombre no puede superar los ${MAX_NAME_LENGTH} caracteres`,
      });
      return;
    }

    if (role !== undefined && !VALID_ROLES.includes(role)) {
      res.status(400).json({
        error: `Rol inválido: ${role}. Valores permitidos: ${VALID_ROLES.join(", ")}`,
      });
      return;
    }

    if (
      socialLinks !== undefined &&
      (typeof socialLinks !== "object" || socialLinks === null || Array.isArray(socialLinks))
    ) {
      res.status(400).json({ error: "socialLinks debe ser un objeto JSON" });
      return;
    }

    if (
      programIds !== undefined &&
      (!Array.isArray(programIds) ||
        programIds.some((pid) => typeof pid !== "string" || !UUID_RE.test(pid)))
    ) {
      res.status(400).json({ error: "programIds debe ser un array de ids (UUID)" });
      return;
    }

    let validatedProgramIds: string[] = [];
    if (programIds && programIds.length > 0) {
      const validated = await validateProgramIds(programIds, tenantId);
      if (validated === null) {
        res.status(404).json({ error: "Uno o más programas no existen en este tenant" });
        return;
      }
      validatedProgramIds = validated;
    }

    const person = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(persons)
        .values({
          tenantId,
          name: name.trim(),
          role: (role as (typeof personRoleEnum.enumValues)[number]) ?? "conductor",
          roleLabel: roleLabel?.slice(0, 120) ?? null,
          bio: bio ?? null,
          notes: notes ?? null,
          socialLinks: socialLinks ?? {},
          isActive: isActive ?? true,
        })
        .returning();

      if (validatedProgramIds.length > 0) {
        await tx.insert(personProgram).values(
          validatedProgramIds.map((programId) => ({
            tenantId,
            personId: created.id,
            programId,
            roleOnProgram: roleOnProgram?.[programId]?.slice(0, 80) ?? null,
            createdByUserId: req.auth!.userId,
          })),
        );
      }

      return created;
    });

    const detail = await fetchPersonDetail(person.id, tenantId);
    res.status(201).json({ success: true, person: detail });
  } catch (error) {
    console.error("[Persons] Error al crear persona:", error);
    res.status(500).json({ error: "Error al crear la persona" });
  }
});

// ------------------------------------------------------------------
// PATCH /api/persons/:id — Partial update; programIds replaces the set
// ------------------------------------------------------------------
personsRouter.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;
    const {
      name,
      role,
      roleLabel,
      bio,
      notes,
      socialLinks,
      isActive,
      programIds,
      roleOnProgram,
    } = req.body as {
      name?: string;
      role?: string;
      roleLabel?: string | null;
      bio?: string | null;
      notes?: string | null;
      socialLinks?: Record<string, unknown>;
      isActive?: boolean;
      programIds?: string[];
      roleOnProgram?: Record<string, string>;
    };

    const [existing] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Persona no encontrada" });
      return;
    }

    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      res.status(400).json({ error: "El nombre no puede quedar vacío" });
      return;
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      res.status(400).json({
        error: `El nombre no puede superar los ${MAX_NAME_LENGTH} caracteres`,
      });
      return;
    }

    if (role !== undefined && !VALID_ROLES.includes(role)) {
      res.status(400).json({
        error: `Rol inválido: ${role}. Valores permitidos: ${VALID_ROLES.join(", ")}`,
      });
      return;
    }

    if (
      socialLinks !== undefined &&
      (typeof socialLinks !== "object" || socialLinks === null || Array.isArray(socialLinks))
    ) {
      res.status(400).json({ error: "socialLinks debe ser un objeto JSON" });
      return;
    }

    if (
      programIds !== undefined &&
      (!Array.isArray(programIds) ||
        programIds.some((pid) => typeof pid !== "string" || !UUID_RE.test(pid)))
    ) {
      res.status(400).json({ error: "programIds debe ser un array de ids (UUID)" });
      return;
    }

    let validatedProgramIds: string[] | undefined;
    if (programIds !== undefined) {
      const validated = await validateProgramIds(programIds, tenantId);
      if (validated === null) {
        res.status(404).json({ error: "Uno o más programas no existen en este tenant" });
        return;
      }
      validatedProgramIds = validated;
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (role !== undefined) updateData.role = role;
    if (roleLabel !== undefined) updateData.roleLabel = roleLabel?.slice(0, 120) ?? null;
    if (bio !== undefined) updateData.bio = bio;
    if (notes !== undefined) updateData.notes = notes;
    if (socialLinks !== undefined) updateData.socialLinks = socialLinks;
    if (isActive !== undefined) updateData.isActive = isActive;

    await db.transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx
          .update(persons)
          .set(updateData)
          .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)));
      }

      if (validatedProgramIds !== undefined) {
        // Reemplazo del set de programas: borra los que ya no están, inserta
        // los nuevos y actualiza role_on_program en los que quedan.
        const current = await tx
          .select({ programId: personProgram.programId })
          .from(personProgram)
          .where(
            and(
              eq(personProgram.personId, id),
              eq(personProgram.tenantId, tenantId),
            ),
          );

        const currentIds = new Set(current.map((c) => c.programId));
        const nextIds = new Set(validatedProgramIds);

        const toDelete = [...currentIds].filter((pid) => !nextIds.has(pid));
        const toInsert = [...nextIds].filter((pid) => !currentIds.has(pid));
        const toKeep = [...nextIds].filter((pid) => currentIds.has(pid));

        if (toDelete.length > 0) {
          await tx
            .delete(personProgram)
            .where(
              and(
                eq(personProgram.personId, id),
                eq(personProgram.tenantId, tenantId),
                inArray(personProgram.programId, toDelete),
              ),
            );
        }

        if (toInsert.length > 0) {
          await tx.insert(personProgram).values(
            toInsert.map((programId) => ({
              tenantId,
              personId: id,
              programId,
              roleOnProgram: roleOnProgram?.[programId]?.slice(0, 80) ?? null,
              createdByUserId: req.auth!.userId,
            })),
          );
        }

        if (roleOnProgram !== undefined) {
          for (const programId of toKeep) {
            await tx
              .update(personProgram)
              .set({ roleOnProgram: roleOnProgram[programId]?.slice(0, 80) ?? null })
              .where(
                and(
                  eq(personProgram.personId, id),
                  eq(personProgram.tenantId, tenantId),
                  eq(personProgram.programId, programId),
                ),
              );
          }
        }
      } else if (roleOnProgram !== undefined) {
        // Sin programIds: solo actualiza role_on_program de los links existentes.
        const keys = Object.keys(roleOnProgram).slice(0, 100);
        for (const programId of keys) {
          await tx
            .update(personProgram)
            .set({ roleOnProgram: roleOnProgram[programId]?.slice(0, 80) ?? null })
            .where(
              and(
                eq(personProgram.personId, id),
                eq(personProgram.tenantId, tenantId),
                eq(personProgram.programId, programId),
              ),
            );
        }
      }
    });

    const detail = await fetchPersonDetail(id, tenantId);
    res.json({ success: true, person: detail });
  } catch (error) {
    console.error("[Persons] Error al actualizar persona:", error);
    res.status(500).json({ error: "Error al actualizar la persona" });
  }
});

// ------------------------------------------------------------------
// DELETE /api/persons/:id — Delete person (409 si hay refs legacy)
// ------------------------------------------------------------------
personsRouter.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { id } = req.params;

    const [existing] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Persona no encontrada" });
      return;
    }

    // conductors.person_id y guests.person_id tienen ON DELETE SET NULL:
    // borrar no viola la FK pero desvincularía silenciosamente las filas
    // legacy vivas. Si hay referencias, se rechaza con 409.
    const [legacyConductor, legacyGuest] = await Promise.all([
      db
        .select({ id: conductors.id })
        .from(conductors)
        .where(and(eq(conductors.personId, id), eq(conductors.tenantId, tenantId)))
        .limit(1),
      db
        .select({ id: guests.id })
        .from(guests)
        .where(and(eq(guests.personId, id), eq(guests.tenantId, tenantId)))
        .limit(1),
    ]);

    if (legacyConductor.length > 0 || legacyGuest.length > 0) {
      res.status(409).json({
        error:
          "La persona está vinculada a registros legacy (conductores/invitados) y no puede eliminarse",
        code: "PERSON_HAS_LEGACY_REFS",
      });
      return;
    }

    await db
      .delete(persons)
      .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)));

    res.json({ success: true });
  } catch (error) {
    console.error("[Persons] Error al eliminar persona:", error);
    res.status(500).json({ error: "Error al eliminar la persona" });
  }
});

// ------------------------------------------------------------------
// POST /api/persons/:id/photos — Upload photo (multipart, field "file")
// ------------------------------------------------------------------
personsRouter.post(
  "/:id/photos",
  requireAuth,
  (req: Request, res: Response, next: () => void) => uploadSingle(req, res, next),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: "Se requiere un archivo de imagen (campo 'file')" });
        return;
      }

      const tenantId = req.auth!.tenantId;
      const { id } = req.params;

      const [person] = await db
        .select({ id: persons.id })
        .from(persons)
        .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
        .limit(1);

      if (!person) {
        res.status(404).json({ error: "Persona no encontrada" });
        return;
      }

      const existingPhotos = await db
        .select({ id: personPhotos.id })
        .from(personPhotos)
        .where(and(eq(personPhotos.personId, id), eq(personPhotos.tenantId, tenantId)));

      if (existingPhotos.length >= MAX_PHOTOS_PER_PERSON) {
        res.status(409).json({
          error: `La persona ya tiene el máximo de ${MAX_PHOTOS_PER_PERSON} fotos`,
        });
        return;
      }

      // Se guarda el archivo original (máxima calidad para el pipeline de
      // rostros de PC-04); sharp sólo se usa para leer metadata.
      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(req.file.buffer).metadata();
      } catch {
        res.status(400).json({ error: "El archivo no es una imagen válida" });
        return;
      }

      const [newPhoto] = await db
        .insert(personPhotos)
        .values({
          tenantId,
          personId: id,
          photoData: req.file.buffer,
          mimeType: req.file.mimetype,
          isPrimary: existingPhotos.length === 0,
          width: metadata.width ?? null,
          height: metadata.height ?? null,
        })
        .returning(photoMetaSelect);

      res.status(201).json({ success: true, photo: newPhoto });
    } catch (error) {
      console.error("[Persons] Error al subir foto:", error);
      res.status(500).json({ error: "Error al procesar la foto" });
    }
  },
);

// ------------------------------------------------------------------
// GET /api/persons/:id/photos/:photoId — Serve photo binary
// ------------------------------------------------------------------
personsRouter.get(
  "/:id/photos/:photoId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id, photoId } = req.params;

      const [person] = await db
        .select({ id: persons.id })
        .from(persons)
        .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
        .limit(1);

      if (!person) {
        res.status(404).json({ error: "Persona no encontrada" });
        return;
      }

      const [photo] = await db
        .select()
        .from(personPhotos)
        .where(
          and(
            eq(personPhotos.id, photoId),
            eq(personPhotos.personId, id),
            eq(personPhotos.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!photo) {
        res.status(404).json({ error: "Foto no encontrada" });
        return;
      }

      res.setHeader("Content-Type", photo.mimeType);
      res.setHeader("Cache-Control", "private, no-store");
      res.send(Buffer.from(photo.photoData));
    } catch (error) {
      console.error("[Persons] Error al servir foto:", error);
      res.status(500).json({ error: "Error al obtener la foto" });
    }
  },
);

// ------------------------------------------------------------------
// DELETE /api/persons/:id/photos/:photoId — Delete photo
// ------------------------------------------------------------------
personsRouter.delete(
  "/:id/photos/:photoId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id, photoId } = req.params;

      const [person] = await db
        .select({ id: persons.id })
        .from(persons)
        .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
        .limit(1);

      if (!person) {
        res.status(404).json({ error: "Persona no encontrada" });
        return;
      }

      const [photo] = await db
        .select({
          id: personPhotos.id,
          isPrimary: personPhotos.isPrimary,
        })
        .from(personPhotos)
        .where(
          and(
            eq(personPhotos.id, photoId),
            eq(personPhotos.personId, id),
            eq(personPhotos.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!photo) {
        res.status(404).json({ error: "Foto no encontrada" });
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(personPhotos)
          .where(
            and(eq(personPhotos.id, photoId), eq(personPhotos.tenantId, tenantId)),
          );

        // Si era la primaria, promueve la más vieja que queda.
        if (photo.isPrimary) {
          const remaining = await tx
            .select({ id: personPhotos.id })
            .from(personPhotos)
            .where(
              and(
                eq(personPhotos.personId, id),
                eq(personPhotos.tenantId, tenantId),
              ),
            )
            .orderBy(personPhotos.createdAt)
            .limit(1);

          if (remaining.length > 0) {
            await tx
              .update(personPhotos)
              .set({ isPrimary: true })
              .where(
                and(
                  eq(personPhotos.id, remaining[0].id),
                  eq(personPhotos.tenantId, tenantId),
                ),
              );
          }
        }
      });

      res.json({ success: true });
    } catch (error) {
      console.error("[Persons] Error al eliminar foto:", error);
      res.status(500).json({ error: "Error al eliminar la foto" });
    }
  },
);

// ------------------------------------------------------------------
// PUT /api/persons/:id/photos/:photoId/primary — Set primary photo
// ------------------------------------------------------------------
personsRouter.put(
  "/:id/photos/:photoId/primary",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const { id, photoId } = req.params;

      const [person] = await db
        .select({ id: persons.id })
        .from(persons)
        .where(and(eq(persons.id, id), eq(persons.tenantId, tenantId)))
        .limit(1);

      if (!person) {
        res.status(404).json({ error: "Persona no encontrada" });
        return;
      }

      const [photo] = await db
        .select({ id: personPhotos.id })
        .from(personPhotos)
        .where(
          and(
            eq(personPhotos.id, photoId),
            eq(personPhotos.personId, id),
            eq(personPhotos.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!photo) {
        res.status(404).json({ error: "Foto no encontrada" });
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(personPhotos)
          .set({ isPrimary: false })
          .where(
            and(eq(personPhotos.personId, id), eq(personPhotos.tenantId, tenantId)),
          );

        await tx
          .update(personPhotos)
          .set({ isPrimary: true })
          .where(
            and(eq(personPhotos.id, photoId), eq(personPhotos.tenantId, tenantId)),
          );
      });

      res.json({ success: true });
    } catch (error) {
      console.error("[Persons] Error al establecer foto primaria:", error);
      res.status(500).json({ error: "Error al actualizar la foto primaria" });
    }
  },
);

// ------------------------------------------------------------------
// POST /api/persons/:id/photos/:photoId/enroll — enrolar rostro de una foto
// (PC-04). 0 caras → 400 NO_FACE_DETECTED · >1 caras → 400 MULTIPLE_FACES ·
// sin consentimiento → 400 CONSENT_REQUIRED · detector caído → 503.
// ------------------------------------------------------------------
personsRouter.post(
  "/:id/photos/:photoId/enroll",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { consent } = (req.body ?? {}) as { consent?: unknown };
      const result = await enrollFace(
        { store: createDrizzleFaceStore(db), resolveDetector: getFaceDetector },
        {
          tenantId: req.auth!.tenantId,
          personId: req.params.id,
          photoId: req.params.photoId,
          consent: consent === true,
        },
      );
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("[Persons] Error al enrolar rostro:", error);
      res.status(500).json({ error: "Error al enrolar el rostro" });
    }
  },
);

// ------------------------------------------------------------------
// POST /api/persons/:id/enroll — atajo: enrola la foto primaria de la persona.
// ------------------------------------------------------------------
personsRouter.post("/:id/enroll", requireAuth, async (req: Request, res: Response) => {
  try {
    const { consent } = (req.body ?? {}) as { consent?: unknown };
    const result = await enrollFace(
      { store: createDrizzleFaceStore(db), resolveDetector: getFaceDetector },
      {
        tenantId: req.auth!.tenantId,
        personId: req.params.id,
        consent: consent === true,
      },
    );
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error("[Persons] Error al enrolar rostro (foto primaria):", error);
    res.status(500).json({ error: "Error al enrolar el rostro" });
  }
});

// ------------------------------------------------------------------
// DELETE /api/persons/:id/photos/:photoId/embedding — desenrolar una foto:
// borra su embedding, limpia persons.embedding_ref y vuelve a pending.
// ------------------------------------------------------------------
personsRouter.delete(
  "/:id/photos/:photoId/embedding",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const result = await disenrollFace(
        { store: createDrizzleFaceStore(db), resolveDetector: getFaceDetector },
        {
          tenantId: req.auth!.tenantId,
          personId: req.params.id,
          photoId: req.params.photoId,
        },
      );
      res.status(result.status).json(result.body);
    } catch (error) {
      console.error("[Persons] Error al desenrolar rostro:", error);
      res.status(500).json({ error: "Error al desenrolar el rostro" });
    }
  },
);

// ------------------------------------------------------------------
// GET /api/persons/:id/face-status — estado del enrolment + detector.
// ------------------------------------------------------------------
personsRouter.get("/:id/face-status", requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await getFaceStatus(
      { store: createDrizzleFaceStore(db), resolveDetector: getFaceDetector },
      { tenantId: req.auth!.tenantId, personId: req.params.id },
    );
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error("[Persons] Error al obtener estado de rostro:", error);
    res.status(500).json({ error: "Error al obtener el estado de enrolamiento" });
  }
});
