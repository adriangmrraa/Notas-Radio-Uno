/**
 * transmissionMeteringService.ts — Medición de transmisiones por tenant (Épica B)
 *
 * Modelo: cada tenant tiene un `usage_cycles` por período de facturación (o mes
 * calendario en su timezone si no hay suscripción con períodos). Iniciar una
 * transmisión descuenta UNA unidad del pool:
 *
 *   pool = includedTransmissions (plan/trial) + addonTransmissions (ciclo) + extra (admin)
 *
 * REGLA INVIOLABLE: una transmisión ACTIVA nunca se corta por cuota.
 * Este servicio se consulta únicamente al INICIAR una transmisión. Ningún loop,
 * cron ni webhook detiene un pipeline en curso: `releaseStaleOperations` sólo
 * libera reservas cuya referencia ya no está activa, nunca corta nada.
 *
 * Idempotencia: `consumeTransmission` es segura ante reintentos del cliente via
 * `operationId` — un segundo call con el mismo id devuelve `duplicate: true`
 * sin volver a descontar.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  plans,
  quotaOperations,
  subscriptions,
  tenants,
  usageCycles,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

/** Ventana en la que una reserva puede liberarse como "arranque fallido". */
export const RELEASE_WINDOW_MINUTES = 5;

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';
const FALLBACK_TRIAL_TRANSMISSIONS = 2;

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface QuotaStatus {
  planName: string | null;
  status: string | null;
  periodStart: string;
  periodEnd: string;
  included: number;
  addon: number;
  /** Transmisiones extra otorgadas por un admin (tenants.config.extraTransmissions). */
  extra: number;
  used: number;
  remaining: number;
  percentUsed: number;
  unlimited: boolean;
  usageCycleId: string;
}

export interface ConsumeResult {
  allowed: boolean;
  duplicate?: boolean;
  reason?: 'QUOTA_EXCEEDED';
  quota: QuotaStatus;
}

export interface ReleaseResult {
  released: boolean;
  alreadyReleased?: boolean;
}

/** Chequeo inyectable: ¿la transmisión referenciada sigue activa? */
type ActiveChecker = (tenantId: string, transmissionRef: string | null) => boolean;

let activeChecker: ActiveChecker = () => false;

/**
 * Registra el chequeo de "sigue activa" que usa `releaseStaleOperations`.
 * Lo llama el módulo de pipeline al montar sus rutas: sólo él sabe qué
 * transmisiones tiene corriendo. NUNCA se usa para cortar pipelines.
 */
export function registerActiveTransmissionChecker(checker: ActiveChecker): void {
  activeChecker = checker;
}

// ── Helpers de período ────────────────────────────────────────────────────────

function tenantTimezone(config: { timezone?: string | null } | undefined): string {
  return config?.timezone || DEFAULT_TIMEZONE;
}

/** Date → 'YYYY-MM-DD' en la zona horaria indicada. */
function toDateString(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
}

/** Primer día del mes calendario (en la TZ del tenant) y del siguiente. */
function calendarMonthPeriod(timeZone: string): { periodStart: string; periodEnd: string } {
  const today = toDateString(new Date(), timeZone);
  const [y, m] = today.split('-').map(Number);
  const periodStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const periodEnd = `${next.y}-${String(next.m).padStart(2, '0')}-01`;
  return { periodStart, periodEnd };
}

function extraTransmissions(config: unknown): number {
  if (config && typeof config === 'object') {
    const value = (config as Record<string, unknown>).extraTransmissions;
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }
  return 0;
}

async function getBillingContext(tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const rows = await db
    .select({ subscription: subscriptions, plan: plans })
    .from(subscriptions)
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  return {
    tenant: tenant ?? null,
    subscription: rows[0]?.subscription ?? null,
    plan: rows[0]?.plan ?? null,
  };
}

function planIncluded(subscription: typeof subscriptions.$inferSelect | null, plan: typeof plans.$inferSelect | null): number {
  if (!subscription) return 0;
  if (subscription.status === 'trialing') {
    return subscription.trialTransmissionsIncluded ?? FALLBACK_TRIAL_TRANSMISSIONS;
  }
  return plan?.transmissionsPerCycle ?? 0;
}

function isUnlimited(subscription: typeof subscriptions.$inferSelect | null, plan: typeof plans.$inferSelect | null): boolean {
  if (!subscription || !plan) return false;
  if (subscription.status === 'trialing') return false; // el trial siempre tiene tope
  return plan.transmissionsPerCycle === null;
}

// ── Ciclo de uso ──────────────────────────────────────────────────────────────

/**
 * Devuelve el ciclo abierto del tenant para el período vigente, creándolo si
 * no existe. El período es `subscription.currentPeriod{Start,End}` si existen;
 * si no, el mes calendario en `tenants.timezone`.
 */
export async function getOrCreateUsageCycle(tenantId: string): Promise<typeof usageCycles.$inferSelect> {
  const { tenant, subscription, plan } = await getBillingContext(tenantId);
  const tz = tenantTimezone(tenant ?? undefined);

  let periodStart: string;
  let periodEnd: string;
  if (subscription?.currentPeriodStart && subscription?.currentPeriodEnd) {
    periodStart = toDateString(subscription.currentPeriodStart, tz);
    periodEnd = toDateString(subscription.currentPeriodEnd, tz);
  } else {
    ({ periodStart, periodEnd } = calendarMonthPeriod(tz));
  }

  const included = planIncluded(subscription, plan);

  const [existing] = await db
    .select()
    .from(usageCycles)
    .where(and(eq(usageCycles.tenantId, tenantId), eq(usageCycles.periodStart, periodStart)))
    .limit(1);

  if (existing) {
    // Si cambió el plan o el trial incluido, el ciclo abierto refleja el nuevo
    // pool incluido (los add-ons comprados no se tocan: son del ciclo).
    if (existing.status === 'open' && existing.includedTransmissions !== included) {
      const [updated] = await db
        .update(usageCycles)
        .set({ includedTransmissions: included })
        .where(eq(usageCycles.id, existing.id))
        .returning();
      return updated ?? existing;
    }
    return existing;
  }

  // Carrera entre dos arranques simultáneos: el unique (tenant_id, period_start)
  // decide un solo ganador; el perdedor re-lee la fila creada.
  const [created] = await db
    .insert(usageCycles)
    .values({ tenantId, periodStart, periodEnd, includedTransmissions: included })
    .onConflictDoNothing()
    .returning();

  if (created) return created;

  const [row] = await db
    .select()
    .from(usageCycles)
    .where(and(eq(usageCycles.tenantId, tenantId), eq(usageCycles.periodStart, periodStart)))
    .limit(1);
  if (!row) throw new AppError('No se pudo crear el ciclo de uso', 500, 'USAGE_CYCLE_FAILED');
  return row;
}

// ── Estado de cuota ───────────────────────────────────────────────────────────

export async function getQuotaStatus(tenantId: string): Promise<QuotaStatus> {
  const { tenant, subscription, plan } = await getBillingContext(tenantId);
  const cycle = await getOrCreateUsageCycle(tenantId);
  const extra = extraTransmissions(tenant?.config);
  const unlimited = isUnlimited(subscription, plan);

  const total = cycle.includedTransmissions + cycle.addonTransmissions + extra;
  const used = cycle.transmissionsUsed;
  const remaining = unlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, total - used);
  const percentUsed = unlimited ? 0 : total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 100;

  return {
    planName: plan?.name ?? null,
    status: subscription?.status ?? null,
    periodStart: cycle.periodStart,
    periodEnd: cycle.periodEnd,
    included: cycle.includedTransmissions,
    addon: cycle.addonTransmissions,
    extra,
    used,
    remaining,
    percentUsed,
    unlimited,
    usageCycleId: cycle.id,
  };
}

// ── Consumo atómico ───────────────────────────────────────────────────────────

/**
 * Descuenta una transmisión del ciclo vigente. Atómico e idempotente:
 *  - operationId ya consumido → `{ allowed: true, duplicate: true }` sin tocar contadores.
 *  - plan ilimitado → registra la operación y permite, sin tocar contadores.
 *  - sin cupo → `{ allowed: false, reason: 'QUOTA_EXCEEDED' }` SIN registrar operación.
 *  - con cupo → UNA transacción: guarda `used < included + addon + extra` + insert.
 */
export async function consumeTransmission(input: {
  tenantId: string;
  operationId: string;
  transmissionRef?: string;
  kind?: string;
}): Promise<ConsumeResult> {
  const { tenantId, operationId } = input;

  // Idempotencia primero: un retry del cliente nunca descuenta dos veces.
  const [existingOp] = await db
    .select({ id: quotaOperations.id })
    .from(quotaOperations)
    .where(and(eq(quotaOperations.tenantId, tenantId), eq(quotaOperations.operationId, operationId)))
    .limit(1);

  if (existingOp) {
    return { allowed: true, duplicate: true, quota: await getQuotaStatus(tenantId) };
  }

  const { tenant, subscription, plan } = await getBillingContext(tenantId);
  const cycle = await getOrCreateUsageCycle(tenantId);
  const extra = extraTransmissions(tenant?.config);
  const unlimited = isUnlimited(subscription, plan);

  if (unlimited) {
    const inserted = await db
      .insert(quotaOperations)
      .values({
        tenantId,
        usageCycleId: cycle.id,
        operationId,
        kind: input.kind ?? 'transmission_start',
        status: 'consumed',
        transmissionRef: input.transmissionRef ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: quotaOperations.id });

    return {
      allowed: true,
      duplicate: inserted.length === 0,
      quota: await getQuotaStatus(tenantId),
    };
  }

  const total = cycle.includedTransmissions + cycle.addonTransmissions + extra;
  if (total - cycle.transmissionsUsed <= 0) {
    const quota = await getQuotaStatus(tenantId);
    return { allowed: false, reason: 'QUOTA_EXCEEDED', quota };
  }

  // Una sola transacción: insert de la operación + incremento guardado.
  //  * Si el insert no inserta (operation_id duplicado en carrera) → duplicate.
  //  * Si el UPDATE toca 0 filas (cupo agotado en carrera) → rollback completo:
    //    la operación tampoco queda registrada, coherente con "sin cupo → sin op".
  let outcome: 'consumed' | 'duplicate' | 'exceeded';
  try {
    outcome = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(quotaOperations)
        .values({
          tenantId,
          usageCycleId: cycle.id,
          operationId,
          kind: input.kind ?? 'transmission_start',
          status: 'consumed',
          transmissionRef: input.transmissionRef ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: quotaOperations.id });

      if (inserted.length === 0) return 'duplicate' as const;

      const upd = await tx.execute(sql`
        UPDATE usage_cycles
        SET transmissions_used = transmissions_used + 1,
            updated_at = now()
        WHERE id = ${cycle.id}
          AND tenant_id = ${tenantId}
          AND transmissions_used < included_transmissions + addon_transmissions + ${extra}
      `);

      if ((upd.rowCount ?? 0) === 0) {
        throw new AppError('Cupo agotado', 402, 'QUOTA_EXCEEDED');
      }
      return 'consumed' as const;
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'QUOTA_EXCEEDED') {
      outcome = 'exceeded';
    } else {
      throw err;
    }
  }

  const quota = await getQuotaStatus(tenantId);
  if (outcome === 'exceeded') return { allowed: false, reason: 'QUOTA_EXCEEDED', quota };
  return { allowed: true, duplicate: outcome === 'duplicate', quota };
}

// ── Liberación ────────────────────────────────────────────────────────────────

/**
 * Devuelve una unidad al pool. Sólo libera operaciones en estado `consumed`
 * (idempotente: repetir no hace nada). El decremento nunca baja de 0.
 */
export async function releaseTransmission(input: {
  tenantId: string;
  operationId: string;
  reason: string;
}): Promise<ReleaseResult> {
  const { tenantId, operationId, reason } = input;

  return db.transaction(async (tx) => {
    const released = await tx
      .update(quotaOperations)
      .set({ status: 'released', releasedAt: new Date(), releaseReason: reason })
      .where(
        and(
          eq(quotaOperations.tenantId, tenantId),
          eq(quotaOperations.operationId, operationId),
          eq(quotaOperations.status, 'consumed'),
        ),
      )
      .returning({ usageCycleId: quotaOperations.usageCycleId });

    if (released.length === 0) return { released: false, alreadyReleased: true };

    const cycleId = released[0].usageCycleId;
    if (cycleId) {
      await tx.execute(sql`
        UPDATE usage_cycles
        SET transmissions_used = GREATEST(0, transmissions_used - 1),
            updated_at = now()
        WHERE id = ${cycleId} AND tenant_id = ${tenantId} AND transmissions_used > 0
      `);
    }

    return { released: true };
  });
}

/**
 * Libera operaciones `consumed` más viejas que la ventana cuya referencia ya no
 * esté activa (el checker lo decide; por defecto ninguna está activa — tras un
 * restart no hay pipelines vivos, así que todo lo stale se devuelve).
 * La invoca el scheduler: NUNCA toca pipelines en curso, sólo contadores.
 */
export async function releaseStaleOperations(input: {
  olderThanMinutes?: number;
} = {}): Promise<{ released: number }> {
  const olderThanMinutes = input.olderThanMinutes ?? RELEASE_WINDOW_MINUTES;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

  const stale = await db
    .select({
      tenantId: quotaOperations.tenantId,
      operationId: quotaOperations.operationId,
      transmissionRef: quotaOperations.transmissionRef,
    })
    .from(quotaOperations)
    .where(and(eq(quotaOperations.status, 'consumed'), lt(quotaOperations.createdAt, cutoff)))
    .orderBy(desc(quotaOperations.createdAt))
    .limit(500);

  let released = 0;
  for (const op of stale) {
    if (activeChecker(op.tenantId, op.transmissionRef)) continue;
    const result = await releaseTransmission({
      tenantId: op.tenantId,
      operationId: op.operationId,
      reason: 'stale_operation',
    });
    if (result.released) released++;
  }
  return { released };
}
