/**
 * onboardingService.ts — estado y operaciones del wizard de onboarding (PC-10).
 *
 * Persistencia: tabla `settings` (sin migraciones nuevas):
 *   - `onboarding_completed` → 'true' | 'false'   (ONBOARDING_COMPLETED_KEY)
 *   - `onboarding_state`     → JSON { currentStep, steps: { <id>: {done, savedAt, data} } }
 *
 * La lógica pura (status, "puedo completar", validación de ids, slug/tz) vive en
 * `lib/onboardingRules.ts`; acá van las lecturas/escrituras contra Postgres y las
 * operaciones de dominio de cada paso (tenant, programas, personas, portfolios),
 * siempre con `tenantId` explícito (nunca del body — decisión PA-12).
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "../db/index.js";
import { AppError } from "../lib/errors.js";
import { tenants } from "../db/schema/tenants.js";
import { programs } from "../db/schema/programs.js";
import { persons } from "../db/schema/persons.js";
import { socialPortfolios } from "../db/schema/social.js";
import { plans, subscriptions } from "../db/schema/index.js";
import { personRoleEnum } from "../db/schema/enums.js";
import { deleteSetting, getSetting, setSetting } from "./databaseService.js";
import { createProgramWithUrls, type ProgramUrlInput } from "./programService.js";
import {
  computeOnboardingStatus,
  findForeignIds,
  isValidTenantSlug,
  isValidTimezone,
  missingRequirements,
  normalizeTenantSlug,
  parseOnboardingState,
  ONBOARDING_COMPLETED_KEY,
  ONBOARDING_STATE_KEY,
  type OnboardingFacts,
  type OnboardingState,
  type OnboardingStatus,
  type OnboardingStepId,
} from "../lib/onboardingRules.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_PERSON_ROLES: readonly string[] = personRoleEnum.enumValues;
const MAX_CREATE_BATCH = 50;
const MAX_NAME_LENGTH = 255;
const MAX_PORTFOLIO_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// Facts + status
// ---------------------------------------------------------------------------

interface TenantChannelRow {
  name: string;
  slug: string;
  platformName: string | null;
  timezone: string;
  logoUrl: string | null;
}

async function loadOnboardingFacts(
  tenantId: string,
): Promise<{ facts: OnboardingFacts; tenant: TenantChannelRow }> {
  const [tenant] = await db
    .select({
      name: tenants.name,
      slug: tenants.slug,
      platformName: tenants.platformName,
      timezone: tenants.timezone,
      logoUrl: tenants.logoUrl,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant) {
    throw new AppError("Tenant no encontrado", 404);
  }

  const [[programRow], [personRow], [portfolioRow]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(programs)
      .where(and(eq(programs.tenantId, tenantId), eq(programs.isActive, true))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(persons)
      .where(and(eq(persons.tenantId, tenantId), eq(persons.isActive, true))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(socialPortfolios)
      .where(and(eq(socialPortfolios.tenantId, tenantId), eq(socialPortfolios.isActive, true))),
  ]);

  return {
    tenant,
    facts: {
      channelConfigured: Boolean(
        tenant.name?.trim() && tenant.platformName?.trim() && tenant.timezone?.trim(),
      ),
      programCount: Number(programRow?.count ?? 0),
      personCount: Number(personRow?.count ?? 0),
      portfolioCount: Number(portfolioRow?.count ?? 0),
    },
  };
}

export interface OnboardingStatusResponse extends OnboardingStatus {
  data: {
    channel: TenantChannelRow;
    programCount: number;
    personCount: number;
    portfolioCount: number;
    saved: OnboardingState;
  };
}

export async function getOnboardingStatus(tenantId: string): Promise<OnboardingStatusResponse> {
  const [completedRaw, stateRaw, { facts, tenant }] = await Promise.all([
    getSetting(ONBOARDING_COMPLETED_KEY, tenantId),
    getSetting(ONBOARDING_STATE_KEY, tenantId),
    loadOnboardingFacts(tenantId),
  ]);

  const saved = parseOnboardingState(stateRaw);
  const status = computeOnboardingStatus({
    completed: completedRaw === "true",
    facts,
    state: saved,
  });

  return {
    ...status,
    data: {
      channel: tenant,
      programCount: facts.programCount,
      personCount: facts.personCount,
      portfolioCount: facts.portfolioCount,
      saved,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistencia del avance (onboarding_state)
// ---------------------------------------------------------------------------

async function saveStepState(
  tenantId: string,
  stepId: OnboardingStepId,
  data: Record<string, unknown>,
): Promise<void> {
  const state = parseOnboardingState(await getSetting(ONBOARDING_STATE_KEY, tenantId));
  const prev = state.steps?.[stepId];
  state.steps = {
    ...(state.steps ?? {}),
    [stepId]: {
      done: true,
      savedAt: new Date().toISOString(),
      data: { ...(prev?.data ?? {}), ...data },
    },
  };
  const { facts } = await loadOnboardingFacts(tenantId);
  state.currentStep = computeOnboardingStatus({ completed: false, facts, state }).currentStep;
  await setSetting(ONBOARDING_STATE_KEY, JSON.stringify(state), tenantId);
}

// ---------------------------------------------------------------------------
// Paso 1 — Canal (edita la fila `tenants` del tenant del usuario)
// ---------------------------------------------------------------------------

async function applyChannelStep(
  tenantId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { name, platformName, timezone, slug } = body as {
    name?: unknown;
    platformName?: unknown;
    timezone?: unknown;
    slug?: unknown;
  };

  const updateData: Record<string, unknown> = {};

  if (name !== undefined) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new AppError("El nombre del canal no puede quedar vacío", 400);
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      throw new AppError(`El nombre no puede superar los ${MAX_NAME_LENGTH} caracteres`, 400);
    }
    updateData.name = name.trim();
  }

  if (platformName !== undefined) {
    if (typeof platformName !== "string" || platformName.trim() === "") {
      throw new AppError("El nombre de la plataforma no puede quedar vacío", 400);
    }
    if (platformName.trim().length > MAX_NAME_LENGTH) {
      throw new AppError(
        `El nombre de la plataforma no puede superar los ${MAX_NAME_LENGTH} caracteres`,
        400,
      );
    }
    updateData.platformName = platformName.trim();
  }

  if (timezone !== undefined) {
    if (typeof timezone !== "string" || !isValidTimezone(timezone.trim())) {
      throw new AppError("Timezone inválida (formato IANA, p.ej. America/Argentina/Buenos_Aires)", 400);
    }
    updateData.timezone = timezone.trim();
  }

  if (slug !== undefined) {
    if (typeof slug !== "string") {
      throw new AppError("Slug inválido", 400);
    }
    const normalized = normalizeTenantSlug(slug);
    if (!isValidTenantSlug(normalized)) {
      throw new AppError(
        "Slug inválido: sólo letras minúsculas, números y guiones (máx. 100)",
        400,
      );
    }
    // slug es único GLOBAL — conflicto con otro tenant → 409.
    const [conflict] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.slug, normalized), ne(tenants.id, tenantId)))
      .limit(1);
    if (conflict) {
      throw new AppError("Ese slug ya está en uso por otra organización", 409, "SLUG_TAKEN");
    }
    updateData.slug = normalized;
  }

  if (Object.keys(updateData).length === 0) {
    throw new AppError("No hay datos del canal para guardar", 400);
  }

  await db.update(tenants).set(updateData).where(eq(tenants.id, tenantId));
  return updateData;
}

// ---------------------------------------------------------------------------
// Paso 2 — Programa (seleccionar existente o crear vía programService)
// ---------------------------------------------------------------------------

async function applyProgramStep(
  tenantId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { programId, name, description, schedule, isPublic, urls } = body as {
    programId?: unknown;
    name?: unknown;
    description?: string;
    schedule?: string;
    isPublic?: boolean;
    urls?: ProgramUrlInput[];
  };

  if (programId !== undefined) {
    if (typeof programId !== "string" || !UUID_RE.test(programId)) {
      throw new AppError("programId debe ser un UUID", 400);
    }
    const [program] = await db
      .select({ id: programs.id })
      .from(programs)
      .where(
        and(
          eq(programs.id, programId),
          eq(programs.tenantId, tenantId),
          eq(programs.isActive, true),
        ),
      )
      .limit(1);
    if (!program) {
      throw new AppError("El programa no existe en este tenant", 404);
    }
    return { programId };
  }

  if (typeof name === "string" && name.trim() !== "") {
    const program = await createProgramWithUrls(tenantId, {
      name: name.trim(),
      description,
      schedule,
      isPublic,
      urls,
    });
    return { programId: program.id, created: true };
  }

  throw new AppError("Indicá programId (existente) o name (para crear uno nuevo)", 400);
}

// ---------------------------------------------------------------------------
// Paso 3 — Personas (ids existentes validados contra el tenant, o alta rápida)
// ---------------------------------------------------------------------------

async function applyPersonsStep(
  tenantId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { personIds, create } = body as {
    personIds?: unknown;
    create?: unknown;
  };

  if (personIds === undefined && create === undefined) {
    throw new AppError("Indicá personIds (existentes) o create (altas rápidas)", 400);
  }

  if (
    personIds !== undefined &&
    (!Array.isArray(personIds) ||
      personIds.some((pid) => typeof pid !== "string" || !UUID_RE.test(pid)))
  ) {
    throw new AppError("personIds debe ser un array de ids (UUID)", 400);
  }

  const createdIds: string[] = [];
  if (create !== undefined) {
    if (!Array.isArray(create) || create.length > MAX_CREATE_BATCH) {
      throw new AppError(`create debe ser un array de hasta ${MAX_CREATE_BATCH} personas`, 400);
    }
    const rows = create.map((item, idx) => {
      const entry = (item ?? {}) as { name?: unknown; role?: unknown; roleLabel?: unknown };
      if (typeof entry.name !== "string" || entry.name.trim() === "") {
        throw new AppError(`create[${idx}]: el nombre es requerido`, 400);
      }
      if (entry.name.trim().length > MAX_NAME_LENGTH) {
        throw new AppError(`create[${idx}]: el nombre supera los ${MAX_NAME_LENGTH} caracteres`, 400);
      }
      const role = entry.role === undefined ? "conductor" : entry.role;
      if (typeof role !== "string" || !VALID_PERSON_ROLES.includes(role)) {
        throw new AppError(
          `create[${idx}]: rol inválido. Valores permitidos: ${VALID_PERSON_ROLES.join(", ")}`,
          400,
        );
      }
      return {
        tenantId,
        name: entry.name.trim(),
        role: role as (typeof personRoleEnum.enumValues)[number],
        roleLabel:
          typeof entry.roleLabel === "string" && entry.roleLabel.trim() !== ""
            ? entry.roleLabel.slice(0, 120)
            : null,
      };
    });
    if (rows.length > 0) {
      const inserted = await db.insert(persons).values(rows).returning({ id: persons.id });
      createdIds.push(...inserted.map((r) => r.id));
    }
  }

  const uniqueIds = [...new Set([...(personIds ?? []), ...createdIds])];
  if (uniqueIds.length > 0) {
    const owned = await db
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.tenantId, tenantId), inArray(persons.id, uniqueIds)));
    const foreign = findForeignIds(uniqueIds, owned.map((r) => r.id));
    if (foreign.length > 0) {
      throw new AppError("Una o más personas no existen en este tenant", 404, "FOREIGN_IDS");
    }
  }

  return { personIds: uniqueIds };
}

// ---------------------------------------------------------------------------
// Paso 4 — Canales y redes (social_portfolios: activar existentes o crear)
// ---------------------------------------------------------------------------

async function applyChannelsStep(
  tenantId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { portfolioIds, create } = body as {
    portfolioIds?: unknown;
    create?: unknown;
  };

  if (portfolioIds === undefined && create === undefined) {
    throw new AppError("Indicá portfolioIds (existentes) o create (nuevas redes)", 400);
  }

  if (
    portfolioIds !== undefined &&
    (!Array.isArray(portfolioIds) ||
      portfolioIds.some((pid) => typeof pid !== "string" || !UUID_RE.test(pid)))
  ) {
    throw new AppError("portfolioIds debe ser un array de ids (UUID)", 400);
  }

  const createdIds: string[] = [];
  if (create !== undefined) {
    if (!Array.isArray(create) || create.length > MAX_CREATE_BATCH) {
      throw new AppError(`create debe ser un array de hasta ${MAX_CREATE_BATCH} redes`, 400);
    }
    const names = create.map((item, idx) => {
      const entry = (item ?? {}) as { name?: unknown };
      if (typeof entry.name !== "string" || entry.name.trim() === "") {
        throw new AppError(`create[${idx}]: el nombre de la red es requerido`, 400);
      }
      if (entry.name.trim().length > MAX_PORTFOLIO_NAME_LENGTH) {
        throw new AppError(
          `create[${idx}]: el nombre supera los ${MAX_PORTFOLIO_NAME_LENGTH} caracteres`,
          400,
        );
      }
      return entry.name.trim();
    });

    if (names.length > 0) {
      // Mismo límite por plan que POST /api/connections/portfolios.
      const [subRow] = await db
        .select({ sub: subscriptions, plan: plans })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
      const maxPortfolios = subRow?.plan?.maxConnectedPlatforms ?? 2;

      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(socialPortfolios)
        .where(eq(socialPortfolios.tenantId, tenantId));
      const currentCount = Number(countRow?.count ?? 0);

      if (maxPortfolios !== -1 && currentCount + names.length > maxPortfolios) {
        throw new AppError(
          `Tu plan permite máximo ${maxPortfolios} portfolios. Actualizá tu plan.`,
          403,
          "PORTFOLIO_LIMIT",
        );
      }

      try {
        const inserted = await db
          .insert(socialPortfolios)
          .values(names.map((name, i) => ({ tenantId, name, sortOrder: currentCount + i })))
          .returning({ id: socialPortfolios.id });
        createdIds.push(...inserted.map((r) => r.id));
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === "23505" || code === "P2002") {
          throw new AppError("Ya existe una red con ese nombre", 409);
        }
        throw err;
      }
    }
  }

  const uniqueIds = [...new Set([...(portfolioIds ?? []), ...createdIds])];
  if (uniqueIds.length > 0) {
    const owned = await db
      .select({ id: socialPortfolios.id })
      .from(socialPortfolios)
      .where(and(eq(socialPortfolios.tenantId, tenantId), inArray(socialPortfolios.id, uniqueIds)));
    const foreign = findForeignIds(uniqueIds, owned.map((r) => r.id));
    if (foreign.length > 0) {
      throw new AppError("Una o más redes no existen en este tenant", 404, "FOREIGN_IDS");
    }

    // "Elegir cuáles activar": los ids enviados quedan activos; el resto no se toca.
    await db
      .update(socialPortfolios)
      .set({ isActive: true })
      .where(and(eq(socialPortfolios.tenantId, tenantId), inArray(socialPortfolios.id, uniqueIds)));
  }

  return { portfolioIds: uniqueIds };
}

// ---------------------------------------------------------------------------
// Dispatcher del paso + complete/reset
// ---------------------------------------------------------------------------

/**
 * Aplica un paso del wizard: valida el body, ejecuta la operación de dominio
 * y persiste el avance en onboarding_state. Lanza AppError (400/404/409).
 */
export async function applyOnboardingStep(
  tenantId: string,
  stepId: OnboardingStepId,
  body: unknown,
): Promise<void> {
  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  let data: Record<string, unknown>;
  switch (stepId) {
    case "channel":
      data = await applyChannelStep(tenantId, payload);
      break;
    case "program":
      data = await applyProgramStep(tenantId, payload);
      break;
    case "persons":
      data = await applyPersonsStep(tenantId, payload);
      break;
    case "channels":
      data = await applyChannelsStep(tenantId, payload);
      break;
  }

  await saveStepState(tenantId, stepId, data);
}

/**
 * Marca el tenant como onboardeado. Sólo si todos los pasos requeridos están
 * cumplidos — si no, AppError 400 con `missing` en el mensaje para el detalle.
 */
export async function completeOnboarding(
  tenantId: string,
): Promise<OnboardingStatusResponse> {
  const status = await getOnboardingStatus(tenantId);
  const missing = missingRequirements(status);
  if (missing.length > 0) {
    throw new AppError(
      `Faltan pasos requeridos: ${missing.map((m) => m.title).join(", ")}`,
      400,
      "ONBOARDING_INCOMPLETE",
    );
  }
  await setSetting(ONBOARDING_COMPLETED_KEY, "true", tenantId);
  return getOnboardingStatus(tenantId);
}

/** Vuelve el onboarding a pendiente y limpia el avance guardado. */
export async function resetOnboarding(tenantId: string): Promise<OnboardingStatusResponse> {
  await setSetting(ONBOARDING_COMPLETED_KEY, "false", tenantId);
  await deleteSetting(ONBOARDING_STATE_KEY, tenantId);
  return getOnboardingStatus(tenantId);
}
