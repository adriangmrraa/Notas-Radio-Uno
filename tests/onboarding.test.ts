/**
 * Tests del slice PC-10: reglas puras del wizard de onboarding
 * (`src/server/lib/onboardingRules.ts`).
 *
 * Sin DB, sin red:
 *   - parseOnboardingState   → JSON defensivo del setting onboarding_state
 *   - isStepDone             → done = guardado explícito OR evidencia de dominio
 *   - computeOnboardingStatus → steps, currentStep, canComplete, completed
 *   - missingRequirements    → qué falta para poder completar (→ 400)
 *   - findForeignIds         → ids del body ajenos al tenant (→ 404)
 *   - normalizeTenantSlug / isValidTenantSlug / isValidTimezone
 *
 * AC del brief:
 *   - tenant sin nada        ⇒ paso 1 pendiente
 *   - canal completo         ⇒ paso 1 cumplido
 *   - los 4 cumplidos        ⇒ canComplete = true
 *   - onboarding_completed='true' ⇒ completed = true
 */
import { describe, expect, it } from 'vitest';
import {
  computeOnboardingStatus,
  findForeignIds,
  isStepDone,
  isValidTenantSlug,
  isValidTimezone,
  missingRequirements,
  normalizeTenantSlug,
  parseOnboardingState,
  EMPTY_FACTS,
  ONBOARDING_STEPS,
  type OnboardingFacts,
  type OnboardingState,
} from '../src/server/lib/onboardingRules';

const FACTS_ALL_DONE: OnboardingFacts = {
  channelConfigured: true,
  programCount: 1,
  personCount: 2,
  portfolioCount: 1,
};

// ── parseOnboardingState ─────────────────────────────────────────────────────
describe('parseOnboardingState', () => {
  it('devuelve {} ante null/undefined/vacío', () => {
    expect(parseOnboardingState(null)).toEqual({});
    expect(parseOnboardingState(undefined)).toEqual({});
    expect(parseOnboardingState('')).toEqual({});
  });

  it('parsea un estado válido', () => {
    const raw = JSON.stringify({
      currentStep: 2,
      steps: { channel: { done: true, savedAt: '2026-11-09T12:00:00Z' } },
    });
    const state = parseOnboardingState(raw);
    expect(state.currentStep).toBe(2);
    expect(state.steps?.channel?.done).toBe(true);
  });

  it('JSON corrupto, array u otro tipo ⇒ estado vacío', () => {
    expect(parseOnboardingState('{no-json')).toEqual({});
    expect(parseOnboardingState('[1,2,3]')).toEqual({});
    expect(parseOnboardingState('"channel"')).toEqual({});
    expect(parseOnboardingState('42')).toEqual({});
  });
});

// ── isStepDone ───────────────────────────────────────────────────────────────
describe('isStepDone', () => {
  it('un guardado explícito cumple el paso aun sin evidencia de dominio', () => {
    const state: OnboardingState = { steps: { persons: { done: true } } };
    expect(isStepDone('persons', EMPTY_FACTS, state)).toBe(true);
    expect(isStepDone('channels', EMPTY_FACTS, state)).toBe(false);
  });

  it('la evidencia de dominio cumple aunque nunca se haya guardado', () => {
    expect(isStepDone('channel', FACTS_ALL_DONE, {})).toBe(true);
    expect(isStepDone('program', FACTS_ALL_DONE, {})).toBe(true);
    expect(isStepDone('persons', { ...EMPTY_FACTS, personCount: 1 }, {})).toBe(true);
    expect(isStepDone('channels', { ...EMPTY_FACTS, portfolioCount: 3 }, {})).toBe(true);
  });

  it('tenant sin nada ⇒ ningún paso cumplido', () => {
    for (const step of ONBOARDING_STEPS) {
      expect(isStepDone(step.id, EMPTY_FACTS, {})).toBe(false);
    }
  });
});

// ── computeOnboardingStatus ──────────────────────────────────────────────────
describe('computeOnboardingStatus', () => {
  it('tenant sin nada ⇒ paso 1 (channel) pendiente, currentStep 0, canComplete false', () => {
    const status = computeOnboardingStatus({
      completed: false,
      facts: EMPTY_FACTS,
      state: {},
    });
    expect(status.completed).toBe(false);
    expect(status.currentStep).toBe(0);
    expect(status.canComplete).toBe(false);
    expect(status.steps).toHaveLength(4);
    expect(status.steps.map((s) => s.id)).toEqual(['channel', 'program', 'persons', 'channels']);
    expect(status.steps.every((s) => s.required)).toBe(true);
    expect(status.steps[0].done).toBe(false);
    expect(status.steps[0].completed).toBe(false);
  });

  it('canal completo ⇒ paso 1 cumplido y currentStep apunta a program', () => {
    const status = computeOnboardingStatus({
      completed: false,
      facts: { ...EMPTY_FACTS, channelConfigured: true },
      state: {},
    });
    expect(status.steps[0].done).toBe(true);
    expect(status.steps[0].completed).toBe(true);
    expect(status.currentStep).toBe(1);
    expect(status.canComplete).toBe(false);
  });

  it('los 4 pasos cumplidos ⇒ canComplete = true y currentStep = steps.length', () => {
    const status = computeOnboardingStatus({
      completed: false,
      facts: FACTS_ALL_DONE,
      state: {},
    });
    expect(status.steps.every((s) => s.done)).toBe(true);
    expect(status.canComplete).toBe(true);
    expect(status.currentStep).toBe(4);
  });

  it('los 4 pasos cumplidos por guardado explícito (sin facts) ⇒ canComplete = true', () => {
    const state: OnboardingState = {
      steps: {
        channel: { done: true },
        program: { done: true },
        persons: { done: true },
        channels: { done: true },
      },
    };
    const status = computeOnboardingStatus({
      completed: false,
      facts: EMPTY_FACTS,
      state,
    });
    expect(status.canComplete).toBe(true);
    expect(status.steps.every((s) => s.saved)).toBe(true);
  });

  it('onboarding_completed=true ⇒ completed = true aunque falten pasos', () => {
    const status = computeOnboardingStatus({
      completed: true,
      facts: EMPTY_FACTS,
      state: {},
    });
    expect(status.completed).toBe(true);
    expect(status.canComplete).toBe(false);
  });
});

// ── missingRequirements ──────────────────────────────────────────────────────
describe('missingRequirements', () => {
  it('tenant nuevo ⇒ faltan los 4 pasos requeridos', () => {
    const status = computeOnboardingStatus({ completed: false, facts: EMPTY_FACTS, state: {} });
    const missing = missingRequirements(status);
    expect(missing.map((m) => m.id)).toEqual(['channel', 'program', 'persons', 'channels']);
  });

  it('todo cumplido ⇒ no falta nada', () => {
    const status = computeOnboardingStatus({ completed: false, facts: FACTS_ALL_DONE, state: {} });
    expect(missingRequirements(status)).toEqual([]);
  });

  it('sólo reporta pasos requeridos pendientes', () => {
    const status = computeOnboardingStatus({
      completed: false,
      facts: { channelConfigured: true, programCount: 1, personCount: 0, portfolioCount: 0 },
      state: {},
    });
    expect(missingRequirements(status).map((m) => m.id)).toEqual(['persons', 'channels']);
  });
});

// ── findForeignIds (validación de ids contra el tenant) ──────────────────────
describe('findForeignIds', () => {
  const OWNED = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002'];

  it('todos los ids del tenant ⇒ []', () => {
    expect(findForeignIds([OWNED[0], OWNED[1]], OWNED)).toEqual([]);
    expect(findForeignIds([], OWNED)).toEqual([]);
  });

  it('ids ajenos al tenant ⇒ devueltos (→ 404)', () => {
    const foreign = 'bbbbbbbb-0000-4000-8000-000000000099';
    expect(findForeignIds([OWNED[0], foreign], OWNED)).toEqual([foreign]);
    expect(findForeignIds([foreign], OWNED)).toEqual([foreign]);
    expect(findForeignIds([OWNED[0]], [])).toEqual([OWNED[0]]);
  });

  it('deduplica el resultado', () => {
    const foreign = 'bbbbbbbb-0000-4000-8000-000000000099';
    expect(findForeignIds([foreign, foreign, OWNED[0]], OWNED)).toEqual([foreign]);
  });
});

// ── normalizeTenantSlug + isValidTenantSlug ──────────────────────────────────
describe('normalizeTenantSlug / isValidTenantSlug', () => {
  it('normaliza a minúsculas, sin diacríticos ni caracteres extra', () => {
    expect(normalizeTenantSlug('Mi Canal 12!')).toBe('mi-canal-12');
    expect(normalizeTenantSlug('  Crónica Televisión  ')).toBe('cronica-television');
    expect(normalizeTenantSlug('YA-VALIDO')).toBe('ya-valido');
    expect(normalizeTenantSlug('a---b___c')).toBe('a-bc');
  });

  it('valida el formato final', () => {
    expect(isValidTenantSlug('canal-12')).toBe(true);
    expect(isValidTenantSlug('')).toBe(false);
    expect(isValidTenantSlug('-canal')).toBe(false);
    expect(isValidTenantSlug('canal-')).toBe(false);
    expect(isValidTenantSlug('Canal')).toBe(false);
    expect(isValidTenantSlug('canal_12')).toBe(false);
    expect(isValidTenantSlug('x'.repeat(101))).toBe(false);
  });
});

// ── isValidTimezone ──────────────────────────────────────────────────────────
describe('isValidTimezone', () => {
  it('acepta timezones IANA reales', () => {
    expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Madrid')).toBe(true);
  });

  it('rechaza inventadas, vacías o larguísimas', () => {
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('UTC-3')).toBe(false);
    expect(isValidTimezone('X'.repeat(60))).toBe(false);
  });
});
