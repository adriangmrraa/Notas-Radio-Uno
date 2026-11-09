/**
 * programService.ts — lógica de programas compartida por la API CRUD
 * (`routes/programs.ts`) y el wizard de onboarding (`services/onboardingService.ts`).
 *
 * Extraída de routes/programs.ts sin cambios de comportamiento (PC-10):
 * slug global único, validación de URLs y fetch con urls + conductores.
 */
import { eq, and } from "drizzle-orm";

import { db } from "../db/index.js";
import { AppError } from "../lib/errors.js";
import { programs, programUrls, programUrlTypeValues } from "../db/schema/programs.js";
import { conductors } from "../db/schema/conductors.js";
import type { PlatformType } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------
export function slugifyProgram(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100);
}

/**
 * Loop puro de candidatos `base`, `base-1`, `base-2`… hasta encontrar uno
 * libre. `findBySlug` es la fuente inyectable (DB en producción, un Set en
 * tests). `excludeId` permite re-guardar el programa que ya tiene el slug.
 */
export async function pickUniqueSlug(
  base: string,
  findBySlug: (candidate: string) => Promise<{ id: string } | null | undefined>,
  excludeId?: string,
): Promise<string> {
  let candidate = base;
  let attempt = 0;

  while (true) {
    const existing = await findBySlug(candidate);

    if (!existing || (excludeId && existing.id === excludeId)) {
      return candidate;
    }

    attempt++;
    candidate = `${base}-${attempt}`;
  }
}

export function ensureUniqueProgramSlug(base: string, excludeId?: string): Promise<string> {
  return pickUniqueSlug(
    base,
    async (candidate) => {
      const [existing] = await db
        .select({ id: programs.id })
        .from(programs)
        .where(eq(programs.slug, candidate))
        .limit(1);
      return existing;
    },
    excludeId,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function isValidProgramUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

export const VALID_PROGRAM_URL_TYPES: readonly string[] = programUrlTypeValues;

export interface ProgramUrlInput {
  type: string;
  url: string;
  label?: string;
}

/** Valida el array de urls (tipo + formato). Lanza AppError 400 si hay alguna inválida. */
export function assertValidProgramUrls(urls: ProgramUrlInput[] | undefined): void {
  if (!urls || !Array.isArray(urls)) return;
  for (const urlItem of urls) {
    if (!VALID_PROGRAM_URL_TYPES.includes(urlItem.type)) {
      throw new AppError(
        `Tipo de URL inválido: ${urlItem.type}. Valores permitidos: ${VALID_PROGRAM_URL_TYPES.join(", ")}`,
        400,
      );
    }
    if (!isValidProgramUrl(urlItem.url)) {
      throw new AppError(`URL inválida: ${urlItem.url}`, 400);
    }
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------
export async function fetchProgramWithUrls(programId: string, tenantId: string) {
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
// createProgramWithUrls — inserta programa + urls atómicamente
// ---------------------------------------------------------------------------
export async function createProgramWithUrls(
  tenantId: string,
  input: {
    name: string;
    description?: string;
    schedule?: string;
    slug?: string;
    isPublic?: boolean;
    urls?: ProgramUrlInput[];
  },
) {
  const { name, description, schedule, slug: rawSlug, isPublic, urls } = input;

  if (!name || name.trim() === "") {
    throw new AppError("El nombre del programa es requerido", 400);
  }

  assertValidProgramUrls(urls);

  // Generate slug from name if not provided
  const slugBase = rawSlug ? slugifyProgram(rawSlug) : slugifyProgram(name.trim());
  const finalSlug = await ensureUniqueProgramSlug(slugBase);

  // Transaction: insert program + urls atomically
  return db.transaction(async (tx) => {
    const [newProgram] = await tx
      .insert(programs)
      .values({
        tenantId,
        name: name.trim(),
        description: description ?? null,
        schedule: schedule ?? null,
        slug: finalSlug,
        isPublic: isPublic ?? false,
      })
      .returning();

    let insertedUrls: typeof programUrls.$inferSelect[] = [];
    if (urls && Array.isArray(urls) && urls.length > 0) {
      insertedUrls = await tx
        .insert(programUrls)
        .values(
          urls.map((u) => ({
            programId: newProgram.id,
            type: u.type as PlatformType,
            url: u.url,
            label: u.label ?? null,
          })),
        )
        .returning();
    }

    return { ...newProgram, urls: insertedUrls };
  });
}
