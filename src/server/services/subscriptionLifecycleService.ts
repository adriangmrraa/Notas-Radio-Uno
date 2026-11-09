/**
 * subscriptionLifecycleService.ts — Ciclo de vida de la suscripción (Épica B)
 *
 * Centraliza: startTrial, dunning (payment failed/succeeded), suspensión y el
 * barrido de transiciones (`evaluateTransitions`) que corre al arranque y cada
 * ~15 min desde el scheduler.
 *
 * Invariantes:
 *  - Toda query multi-tenant filtra por tenantId. El barrido toca todas las
 *    suscripciones pero actualiza fila por fila con su propio tenantId.
 *  - NINGUNA transición detiene pipelines: sólo cambian estados de la
 *    suscripción. Una transmisión activa nunca se corta.
 *  - Emails: siempre via sendEmail (no-op sin SMTP) y nunca tumban el flujo.
 */

import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  billingEvents,
  plans,
  subscriptions,
  tenants,
  usageCycles,
  users,
} from '../db/schema/index.js';
import { recordAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { getOrCreateUsageCycle } from './transmissionMeteringService.js';
import { syncTenantFeaturesForTenant } from './tenantFeaturesService.js';
import {
  sendTrialEndingEmail,
  sendTrialExpiredEmail,
  sendPaymentSucceededEmail,
  sendPaymentFailedEmail,
  sendSubscriptionSuspendedEmail,
} from './emailService.js';

export const TRIAL_DAYS = 7;
export const TRIAL_TRANSMISSIONS = 2;
export const GRACE_DAYS = 7;
export const MAX_DUNNING_ATTEMPTS = 3;
const TRIAL_ENDING_NOTICE_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

function toDateString(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
}

/** Email + nombre del owner del tenant (tenants.ownerId, fallback role='owner'). */
async function resolveOwnerContact(tenantId: string): Promise<{ email: string; name: string } | null> {
  const [tenant] = await db.select({ ownerId: tenants.ownerId }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1);

  if (tenant?.ownerId) {
    const [owner] = await db.select({ email: users.email, name: users.fullName }).from(users)
      .where(and(eq(users.id, tenant.ownerId), eq(users.tenantId, tenantId))).limit(1);
    if (owner) return { email: owner.email, name: owner.name ?? '' };
  }

  const [ownerUser] = await db.select({ email: users.email, name: users.fullName }).from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, 'owner')))
    .limit(1);
  return ownerUser ? { email: ownerUser.email, name: ownerUser.name ?? '' } : null;
}

/** Email best-effort: un fallo de SMTP NUNCA rompe la transición de estado. */
async function safeSend(fn: () => Promise<void>, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[Lifecycle] Error enviando ${label}:`, err);
  }
}

// ── Eventos append-only ───────────────────────────────────────────────────────

/** Idempotente por (provider, externalEventId): devuelve true si insertó. */
export async function recordBillingEvent(input: {
  tenantId: string;
  type: string;
  provider?: string | null;
  externalEventId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  const rows = await db.insert(billingEvents).values({
    tenantId: input.tenantId,
    type: input.type,
    provider: input.provider ?? null,
    externalEventId: input.externalEventId ?? null,
    payload: input.payload ?? {},
  }).onConflictDoNothing().returning({ id: billingEvents.id });
  return rows.length > 0;
}

// ── Trial ─────────────────────────────────────────────────────────────────────

/**
 * Crea la suscripción trial del tenant. Lo llama `authService.register`.
 * Si falta el plan `trial` NO rompe el registro: loguea y devuelve null.
 */
export async function startTrial(tenantId: string): Promise<typeof subscriptions.$inferSelect | null> {
  const [existing] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId)).limit(1);
  if (existing) return existing;

  const [trialPlan] = await db.select().from(plans)
    .where(eq(plans.name, 'trial')).limit(1);
  if (!trialPlan) {
    console.warn(`[Lifecycle] Plan 'trial' no existe: tenant ${tenantId} queda sin suscripción de prueba`);
    return null;
  }

  const [sub] = await db.insert(subscriptions).values({
    tenantId,
    planId: trialPlan.id,
    status: 'trialing',
    trialEndsAt: new Date(Date.now() + TRIAL_DAYS * DAY_MS),
    trialTransmissionsIncluded: TRIAL_TRANSMISSIONS,
  }).onConflictDoNothing().returning();

  return sub ?? null;
}

// ── Dunning ───────────────────────────────────────────────────────────────────

/**
 * Registra un cobro fallido: dunningAttempts++, past_due, gracia de 7 días
 * desde ahora, email con número de intento. Al llegar a MAX_DUNNING_ATTEMPTS
 * suspende la suscripción.
 */
export async function handlePaymentFailed(tenantId: string, provider: string): Promise<void> {
  const [sub] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId)).limit(1);
  if (!sub) return;

  const now = new Date();
  const attempts = sub.dunningAttempts + 1;
  const graceEndsAt = new Date(now.getTime() + GRACE_DAYS * DAY_MS);

  // El intento se registra siempre; al llegar al máximo se suspende (la
  // suspensión envía su propio email en lugar del de pago fallido).
  await db.update(subscriptions).set({
    status: 'past_due',
    pastDueSince: sub.pastDueSince ?? now,
    graceEndsAt,
    dunningAttempts: attempts,
    lastDunningAt: now,
  }).where(eq(subscriptions.id, sub.id));

  if (attempts >= MAX_DUNNING_ATTEMPTS) {
    await suspendSubscription(tenantId);
    return;
  }

  await recordBillingEvent({
    tenantId,
    type: 'payment_failed',
    provider,
    externalEventId: `dunning:${sub.id}:${attempts}`,
    payload: { attempt: attempts, graceEndsAt },
  });
  await recordAuditEvent({
    action: AUDIT_ACTIONS.BILLING_PAYMENT_FAILED,
    tenantId,
    entityType: 'subscription',
    entityId: sub.id,
    metadata: { provider, attempt: attempts },
  });

  const owner = await resolveOwnerContact(tenantId);
  if (owner) {
    await safeSend(() => sendPaymentFailedEmail(owner.email, owner.name, attempts, graceEndsAt), 'payment_failed');
  }
}

/**
 * Registra un cobro exitoso: reactiva, resetea dunning, email de pago ok y
 * reabre el ciclo de uso cuando el período cambió (cierra ciclos vencidos).
 */
export async function handlePaymentSucceeded(input: {
  tenantId: string;
  provider: string;
  amount?: string | number;
  currency?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}): Promise<void> {
  const { tenantId } = input;
  const [row] = await db
    .select({ sub: subscriptions, plan: plans })
    .from(subscriptions)
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);
  if (!row?.sub) return;

  const { sub, plan } = row;

  await db.update(subscriptions).set({
    status: 'active',
    ...(input.periodStart ? { currentPeriodStart: input.periodStart } : {}),
    ...(input.periodEnd ? { currentPeriodEnd: input.periodEnd } : {}),
    pastDueSince: null,
    graceEndsAt: null,
    dunningAttempts: 0,
    lastDunningAt: null,
    suspendedAt: null,
  }).where(eq(subscriptions.id, sub.id));

  await recordBillingEvent({
    tenantId,
    type: 'payment_succeeded',
    provider: input.provider,
    externalEventId: input.periodEnd ? `paid:${sub.id}:${input.periodEnd.toISOString()}` : null,
    payload: { amount: input.amount ?? null, currency: input.currency ?? null },
  });
  await recordAuditEvent({
    action: AUDIT_ACTIONS.BILLING_PAYMENT_OK,
    tenantId,
    entityType: 'subscription',
    entityId: sub.id,
    metadata: { provider: input.provider, amount: input.amount ?? null },
  });

  // Reabrir ciclo de uso: cerrar ciclos open vencidos y asegurar el vigente.
  const [tenant] = await db.select({ config: tenants.config }).from(tenants)
    .where(eq(tenants.id, tenantId)).limit(1);
  const tz = (tenant?.config as Record<string, unknown> | null)?.timezone as string | undefined;
  const today = toDateString(new Date(), tz ?? DEFAULT_TIMEZONE);
  await db.update(usageCycles).set({ status: 'closed' })
    .where(and(eq(usageCycles.tenantId, tenantId), eq(usageCycles.status, 'open'), lt(usageCycles.periodEnd, today)));
  await getOrCreateUsageCycle(tenantId);

  const owner = await resolveOwnerContact(tenantId);
  if (owner) {
    await safeSend(
      () => sendPaymentSucceededEmail(owner.email, owner.name, input.amount ?? '', input.currency ?? '', plan?.displayName ?? ''),
      'payment_succeeded',
    );
  }
}

// ── Suspensión ────────────────────────────────────────────────────────────────

export async function suspendSubscription(tenantId: string): Promise<void> {
  const [sub] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, tenantId)).limit(1);
  if (!sub || sub.status === 'suspended') return;

  const now = new Date();
  await db.update(subscriptions).set({
    status: 'suspended',
    suspendedAt: now,
  }).where(eq(subscriptions.id, sub.id));

  await recordBillingEvent({
    tenantId,
    type: 'subscription_suspended',
    externalEventId: `suspended:${sub.id}:${now.toISOString().slice(0, 10)}`,
    payload: { reason: 'dunning_exhausted_or_grace_ended', dunningAttempts: sub.dunningAttempts },
  });
  await recordAuditEvent({
    action: AUDIT_ACTIONS.BILLING_PAYMENT_FAILED,
    tenantId,
    entityType: 'subscription',
    entityId: sub.id,
    metadata: { action: 'suspended' },
  });

  const owner = await resolveOwnerContact(tenantId);
  if (owner) {
    await safeSend(() => sendSubscriptionSuspendedEmail(owner.email, owner.name), 'subscription_suspended');
  }
}

// ── Barrido de transiciones ───────────────────────────────────────────────────

/**
 * Evalúa y aplica las transiciones de estado. Corre al arranque y cada ~15min
 * desde el scheduler. Cada suscripción se procesa en su propio try/catch: un
 * tenant roto no frena el barrido. NUNCA toca pipelines activos.
 */
export async function evaluateTransitions(): Promise<{ processed: number }> {
  const now = new Date();
  let processed = 0;

  const candidates = await db.select({
    sub: subscriptions,
    tenantConfig: tenants.config,
  })
    .from(subscriptions)
    .leftJoin(tenants, eq(subscriptions.tenantId, tenants.id))
    .where(inArray(subscriptions.status, ['trialing', 'past_due', 'active']));

  for (const { sub, tenantConfig } of candidates) {
    try {
      // ── Trial por vencer (≤2d): aviso una sola vez por suscripción ──
      if (sub.status === 'trialing' && sub.trialEndsAt) {
        const msLeft = sub.trialEndsAt.getTime() - now.getTime();
        const daysLeft = Math.ceil(msLeft / DAY_MS);

        if (msLeft <= 0) {
          await db.update(subscriptions).set({ status: 'expired' })
            .where(eq(subscriptions.id, sub.id));
          await recordBillingEvent({
            tenantId: sub.tenantId,
            type: 'trial_expired',
            externalEventId: `trial-expired:${sub.id}`,
          });
          const owner = await resolveOwnerContact(sub.tenantId);
          if (owner) await safeSend(() => sendTrialExpiredEmail(owner.email, owner.name), 'trial_expired');
          processed++;
          continue;
        }

        if (daysLeft <= TRIAL_ENDING_NOTICE_DAYS) {
          const notified = await recordBillingEvent({
            tenantId: sub.tenantId,
            type: 'trial_ending_notified',
            provider: 'lifecycle',
            externalEventId: `trial-ending:${sub.id}`,
            payload: { daysLeft, trialEndsAt: sub.trialEndsAt },
          });
          if (notified) {
            const owner = await resolveOwnerContact(sub.tenantId);
            if (owner) await safeSend(() => sendTrialEndingEmail(owner.email, owner.name, daysLeft), 'trial_ending');
            processed++;
          }
          continue;
        }
      }

      // ── past_due fuera de gracia → suspended ──
      if (sub.status === 'past_due' && sub.graceEndsAt && sub.graceEndsAt.getTime() <= now.getTime()) {
        await suspendSubscription(sub.tenantId);
        processed++;
        continue;
      }

      // ── Cancelación diferida: fin del período llegó ──
      if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= now.getTime()) {
        await db.update(subscriptions).set({
          status: 'canceled',
          canceledAt: sub.canceledAt ?? now,
          cancelAtPeriodEnd: false,
        }).where(eq(subscriptions.id, sub.id));
        await recordBillingEvent({
          tenantId: sub.tenantId,
          type: 'subscription_canceled',
          externalEventId: `period-end:${sub.id}:${sub.currentPeriodEnd.toISOString()}`,
        });
        processed++;
        continue;
      }

      // ── Cambio de plan diferido (MercadoPago): aplica al cerrar el período ──
      if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() <= now.getTime()) {
        const config = (tenantConfig && typeof tenantConfig === 'object' ? tenantConfig : {}) as Record<string, unknown>;
        const pending = config.pendingPlan as { planName?: string; billingPeriod?: string } | undefined;
        if (pending?.planName) {
          const [plan] = await db.select().from(plans).where(eq(plans.name, pending.planName)).limit(1);
          const nextConfig = { ...config };
          delete nextConfig.pendingPlan;
          await db.update(tenants).set({ config: nextConfig }).where(eq(tenants.id, sub.tenantId));

          if (plan) {
            await db.update(subscriptions).set({
              planId: plan.id,
              ...(pending.billingPeriod ? { billingPeriod: pending.billingPeriod } : {}),
            }).where(eq(subscriptions.id, sub.id));
            await syncTenantFeaturesForTenant(sub.tenantId);
            await recordBillingEvent({
              tenantId: sub.tenantId,
              type: 'pending_plan_applied',
              externalEventId: `pending-plan:${sub.id}:${pending.planName}:${now.toISOString().slice(0, 10)}`,
              payload: { planName: pending.planName, billingPeriod: pending.billingPeriod ?? null },
            });
            processed++;
          }
        }
      }
    } catch (err) {
      console.error(`[Lifecycle] Error evaluando tenant ${sub.tenantId}:`, err);
    }
  }

  return { processed };
}
