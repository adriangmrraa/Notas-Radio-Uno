/**
 * planService.ts — Catálogo de planes (Épica B)
 *
 * Fuente de verdad de los planes vendibles del modelo "por transmisiones":
 *   trial → creator → media → network → enterprise (ilimitado).
 *
 * `seedPlans()` es idempotente y NO destructivo: inserta los planes que falten
 * y sólo completa columnas en NULL de los existentes — nunca pisa precios ni
 * límites que un admin haya ajustado a mano.
 */

import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plans } from '../db/schema/index.js';
import { FEATURE_CATALOG } from './tenantFeaturesService.js';
import { recordAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { AppError } from '../lib/errors.js';

export interface PlanSeedDef {
  name: string;
  displayName: string;
  description: string;
  priceUsd: string;
  transmissionsPerCycle: number | null;
  maxTransmissionMinutes: number | null;
  maxClipsPerTransmission: number | null;
  maxPeople: number | null;
  rawRetentionDays: number | null;
  maxTeamMembers: number;
  maxStorageGb: number;
  isActive: boolean;
  sortOrder: number;
}

/** Flags efectivos del plan según el catálogo central de features. */
function featuresForPlan(planName: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const def of FEATURE_CATALOG) {
    out[def.key] = def.byPlan[planName] ?? def.fallback;
  }
  return out;
}

export const PLAN_SEED: readonly PlanSeedDef[] = [
  {
    name: 'trial',
    displayName: 'Prueba',
    description: 'Prueba gratuita de 7 días con 2 transmisiones.',
    priceUsd: '0',
    transmissionsPerCycle: 2,
    maxTransmissionMinutes: 60,
    maxClipsPerTransmission: 3,
    maxPeople: 5,
    rawRetentionDays: 3,
    maxTeamMembers: 1,
    maxStorageGb: 2,
    // Oculto de la grilla pública: se asigna solo en el registro.
    isActive: false,
    sortOrder: -1,
  },
  {
    name: 'creator',
    displayName: 'Creator',
    description: 'Para un creador o medio chico que transmite seguido.',
    priceUsd: '29',
    transmissionsPerCycle: 20,
    maxTransmissionMinutes: 90,
    maxClipsPerTransmission: 6,
    maxPeople: 15,
    rawRetentionDays: 7,
    maxTeamMembers: 3,
    maxStorageGb: 20,
    isActive: true,
    sortOrder: 1,
  },
  {
    name: 'media',
    displayName: 'Media',
    description: 'Para medios con varias transmisiones semanales.',
    priceUsd: '79',
    transmissionsPerCycle: 80,
    maxTransmissionMinutes: 120,
    maxClipsPerTransmission: 12,
    maxPeople: 50,
    rawRetentionDays: 15,
    maxTeamMembers: 8,
    maxStorageGb: 100,
    isActive: true,
    sortOrder: 2,
  },
  {
    name: 'network',
    displayName: 'Network',
    description: 'Para cadenas y redes con programación intensiva.',
    priceUsd: '199',
    transmissionsPerCycle: 250,
    maxTransmissionMinutes: 180,
    maxClipsPerTransmission: 25,
    maxPeople: 200,
    rawRetentionDays: 30,
    maxTeamMembers: 25,
    maxStorageGb: 400,
    isActive: true,
    sortOrder: 3,
  },
  {
    name: 'enterprise',
    displayName: 'Enterprise',
    description: 'Operación a medida: transmisiones ilimitadas.',
    priceUsd: '0',
    transmissionsPerCycle: null,
    maxTransmissionMinutes: 240,
    maxClipsPerTransmission: 50,
    maxPeople: null,
    rawRetentionDays: 90,
    maxTeamMembers: 100,
    maxStorageGb: 1000,
    isActive: true,
    sortOrder: 4,
  },
] as const;

/**
 * Upsert idempotente por `name`. Inserta los planes faltantes y sólo rellena
 * columnas NULL de los ya existentes — los precios y límites existentes se
 * respetan siempre.
 */
export async function seedPlans(): Promise<{ inserted: string[]; updated: string[] }> {
  const inserted: string[] = [];
  const updated: string[] = [];

  for (const def of PLAN_SEED) {
    const features = featuresForPlan(def.name);
    const [existing] = await db.select().from(plans).where(eq(plans.name, def.name)).limit(1);

    if (!existing) {
      await db.insert(plans).values({ ...def, features });
      inserted.push(def.name);
      continue;
    }

    const patch: Record<string, unknown> = {};
    const fill = (key: keyof PlanSeedDef) => {
      if (existing[key] === null || existing[key] === undefined) patch[key] = def[key];
    };
    fill('displayName');
    fill('description');
    fill('transmissionsPerCycle');
    fill('maxTransmissionMinutes');
    fill('maxClipsPerTransmission');
    fill('maxPeople');
    fill('rawRetentionDays');

    // El trial nunca debe aparecer en la grilla pública: se repara si quedó activo.
    if (def.name === 'trial' && existing.isActive) patch.isActive = false;

    if (Object.keys(patch).length > 0) {
      await db.update(plans).set(patch).where(eq(plans.id, existing.id));
      updated.push(def.name);
    }
  }

  if (inserted.length || updated.length) {
    console.log(`[Seed] Planes: insertados=[${inserted.join(', ')}] completados=[${updated.join(', ')}]`);
  }
  return { inserted, updated };
}

/** Lista TODOS los planes (incluye inactivos) — vista de super admin. */
export async function listPlans(): Promise<(typeof plans.$inferSelect)[]> {
  return db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.priceUsd));
}

export interface PlanPatch {
  displayName?: string;
  priceUsd?: string;
  priceUsdYearly?: string | null;
  priceArs?: string | null;
  priceArsYearly?: string | null;
  transmissionsPerCycle?: number | null;
  maxTransmissionMinutes?: number | null;
  maxClipsPerTransmission?: number | null;
  maxPeople?: number | null;
  rawRetentionDays?: number | null;
  maxTeamMembers?: number;
  maxStorageGb?: number;
  isActive?: boolean;
  sortOrder?: number;
}

/** Aplica un patch a un plan y audita el cambio como acción de admin. */
export async function updatePlan(input: {
  planId: string;
  patch: PlanPatch;
  actorUserId: string;
}): Promise<typeof plans.$inferSelect> {
  const { planId, patch, actorUserId } = input;

  const [existing] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!existing) throw new AppError('Plan no encontrado', 404, 'PLAN_NOT_FOUND');

  const [updated] = await db.update(plans).set(patch).where(eq(plans.id, planId)).returning();

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_PLAN_CHANGED,
    userId: actorUserId,
    entityType: 'plan',
    entityId: planId,
    metadata: { planName: existing.name, changed: Object.keys(patch) },
  });

  return updated;
}
