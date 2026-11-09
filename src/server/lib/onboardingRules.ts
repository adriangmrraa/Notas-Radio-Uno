/**
 * onboardingRules.ts — Reglas puras del wizard de onboarding (PC-10).
 *
 * Sin DB ni red: `onboardingService.ts` hidrata los facts desde Postgres y
 * persiste el avance en `settings`; acá vive sólo la lógica testeable:
 *   - parseOnboardingState  → onboarding_state (JSON) → objeto tipado
 *   - isStepDone            → done = guardado explícito OR evidencia de dominio
 *   - computeOnboardingStatus → status completo (steps, currentStep, canComplete)
 *   - missingRequirements   → qué falta para poder completar (→ 400)
 *   - findForeignIds        → ids del body que no pertenecen al tenant (→ 404)
 *   - normalizeTenantSlug / isValidTenantSlug / isValidTimezone → validaciones
 *     del paso "Canal" (slug único global, timezone IANA).
 */

export const ONBOARDING_COMPLETED_KEY = 'onboarding_completed';
export const ONBOARDING_STATE_KEY = 'onboarding_state';

export type OnboardingStepId = 'channel' | 'program' | 'persons' | 'channels';

export interface OnboardingStepDef {
  id: OnboardingStepId;
  title: string;
  required: boolean;
}

/**
 * Los 4 pasos del wizard. Todos son "required" en el sentido de que hay que
 * recorrerlos y guardarlos para completar; `persons` y `channels` admiten
 * guardarse vacíos (skip explícito), mientras `channel` y `program` exigen
 * datos reales (el tenant queda operativo con un programa).
 */
export const ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  { id: 'channel', title: 'Canal', required: true },
  { id: 'program', title: 'Programa', required: true },
  { id: 'persons', title: 'Personas', required: true },
  { id: 'channels', title: 'Canales y redes', required: true },
];

export const ONBOARDING_STEP_IDS: readonly OnboardingStepId[] = ONBOARDING_STEPS.map(
  (s) => s.id,
);

export function isOnboardingStepId(value: string): value is OnboardingStepId {
  return (ONBOARDING_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Error del endpoint POST /step/:stepId cuando el paso no existe.
 * Exportado para que la ruta y los tests compartan el contrato:
 * 400 (input inválido), no 404 (eso queda para recursos ajenos).
 */
export function unknownStepIdError(stepId: string): { status: number; error: string } {
  return {
    status: 400,
    error: `Paso desconocido: ${stepId}. Válidos: ${ONBOARDING_STEP_IDS.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// onboarding_state (settings.onboarding_state, JSON)
// ---------------------------------------------------------------------------

export interface OnboardingStepState {
  done?: boolean;
  savedAt?: string;
  data?: Record<string, unknown>;
}

export interface OnboardingState {
  currentStep?: number;
  steps?: Partial<Record<OnboardingStepId, OnboardingStepState>>;
}

/** Parse defensivo del JSON persistido: cualquier cosa inválida → estado vacío. */
export function parseOnboardingState(raw: string | null | undefined): OnboardingState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as OnboardingState;
    }
  } catch {
    // estado corrupto → se empieza de cero
  }
  return {};
}

// ---------------------------------------------------------------------------
// Facts de dominio (los hidrata el service desde las tablas reales)
// ---------------------------------------------------------------------------

export interface OnboardingFacts {
  /** El tenant tiene el canal configurado: name + platformName + timezone. */
  channelConfigured: boolean;
  /** Programas activos del tenant. */
  programCount: number;
  /** Personas activas del tenant. */
  personCount: number;
  /** Portfolios/redes activos del tenant. */
  portfolioCount: number;
}

export const EMPTY_FACTS: OnboardingFacts = {
  channelConfigured: false,
  programCount: 0,
  personCount: 0,
  portfolioCount: 0,
};

/**
 * Un paso está cumplido si el usuario lo guardó explícitamente vía
 * POST /api/onboarding/step/:id (persistido en onboarding_state) o si la
 * evidencia de dominio ya lo satisface (p.ej. ya existen programas).
 *
 * Excepción: `channel` exige el canal realmente configurado — un guardado
 * parcial (p.ej. sólo el slug) NO cumple el paso aunque quede registrado.
 */
export function isStepDone(
  stepId: OnboardingStepId,
  facts: OnboardingFacts,
  state: OnboardingState,
): boolean {
  if (stepId !== 'channel' && state.steps?.[stepId]?.done === true) return true;
  switch (stepId) {
    case 'channel':
      return facts.channelConfigured;
    case 'program':
      return facts.programCount > 0;
    case 'persons':
      return facts.personCount > 0;
    case 'channels':
      return facts.portfolioCount > 0;
  }
}

// ---------------------------------------------------------------------------
// Status computado
// ---------------------------------------------------------------------------

export interface OnboardingStepStatus extends OnboardingStepDef {
  /** El paso fue guardado explícitamente desde el wizard. */
  saved: boolean;
  /** El paso está cumplido (guardado o evidencia de dominio). */
  done: boolean;
  /** Alias semántico de `done` en el contrato del endpoint. */
  completed: boolean;
}

export interface OnboardingStatus {
  /** sale de settings.onboarding_completed === 'true' */
  completed: boolean;
  /** índice (0-based) del primer paso no cumplido; steps.length si están todos */
  currentStep: number;
  /** true cuando todos los pasos requeridos están cumplidos */
  canComplete: boolean;
  steps: OnboardingStepStatus[];
}

export function computeOnboardingStatus(input: {
  completed: boolean;
  facts: OnboardingFacts;
  state?: OnboardingState;
}): OnboardingStatus {
  const state = input.state ?? {};
  const steps = ONBOARDING_STEPS.map((def) => {
    const saved = state.steps?.[def.id]?.done === true;
    const done = isStepDone(def.id, input.facts, state);
    return { ...def, saved, done, completed: done };
  });
  const firstPending = steps.findIndex((s) => !s.done);
  return {
    completed: input.completed,
    currentStep: firstPending === -1 ? steps.length : firstPending,
    canComplete: steps.every((s) => !s.required || s.done),
    steps,
  };
}

/**
 * Pasos requeridos todavía no cumplidos — el detalle que devuelve el 400 de
 * POST /api/onboarding/complete cuando se intenta cerrar antes de tiempo.
 */
export function missingRequirements(
  status: Pick<OnboardingStatus, 'steps'>,
): Array<{ id: OnboardingStepId; title: string }> {
  return status.steps
    .filter((s) => s.required && !s.done)
    .map((s) => ({ id: s.id, title: s.title }));
}

// ---------------------------------------------------------------------------
// Validación de ids contra el tenant
// ---------------------------------------------------------------------------

/**
 * Devuelve los ids pedidos que NO pertenecen al tenant (deduplicados).
 * La ruta los contrasta con los ids reales leídos de la tabla correspondiente
 * y responde 404 si la lista vuelve no-vacía.
 */
export function findForeignIds(
  requestedIds: readonly string[],
  tenantOwnedIds: readonly string[],
): string[] {
  const owned = new Set(tenantOwnedIds);
  return [...new Set(requestedIds)].filter((id) => !owned.has(id));
}

// ---------------------------------------------------------------------------
// Validaciones del paso "Canal" (slug único global + timezone IANA)
// ---------------------------------------------------------------------------

const TENANT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normaliza un slug de tenant: minúsculas, sin diacríticos, sólo [a-z0-9-],
 * separadores únicos y sin guiones en los bordes. Mismo criterio que el
 * slugify de programs/auth.
 */
export function normalizeTenantSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

/** Formato final del slug (post-normalización). */
export function isValidTenantSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 100 && TENANT_SLUG_RE.test(slug);
}

/** Valida una timezone IANA usando Intl (sin tabla propia). */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 50) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
