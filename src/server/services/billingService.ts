/**
 * billingService.ts — Operaciones de suscripción iniciadas por el tenant
 * (change-plan, reactivate) + dedupe de webhooks en `billing_events`.
 *
 * Reglas:
 *  - Toda query multi-tenant filtra por tenantId. Nada global sin filtro.
 *  - Stripe: el cambio de plan se aplica al vuelo con prorrateo.
 *  - MercadoPago: un preapproval no admite cambiar monto/plan → el cambio se
 *    difiere a fin de ciclo en `tenants.config.pendingPlan` (lo aplica el
 *    lifecycle service cuando termina el período).
 *  - Suscripciones sin provider (trial, cortesía de admin): cambio inmediato.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { billingEvents, plans, subscriptions, tenants } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { recordAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { syncTenantFeaturesForTenant } from './tenantFeaturesService.js';
import { getStripe } from './billingProviders.js';

export type BillingPeriod = 'monthly' | 'yearly';
export type WebhookProvider = 'stripe' | 'mercadopago';

// ── Dedupe de webhooks ────────────────────────────────────────────────────────

/**
 * Inserta el evento en billing_events ANTES de procesarlo.
 * Devuelve true si es nuevo (proceder) o false si es un reintento ya recibido.
 */
export async function dedupeBillingEvent(input: {
  provider: WebhookProvider;
  externalEventId: string;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<boolean> {
  const rows = await db.insert(billingEvents).values({
    provider: input.provider,
    externalEventId: input.externalEventId,
    type: input.type,
    payload: input.payload ?? {},
  }).onConflictDoNothing().returning({ id: billingEvents.id });
  return rows.length > 0;
}

/** Backfill del tenantId una vez resuelto el recurso externo. */
export async function tagBillingEventTenant(
  provider: WebhookProvider,
  externalEventId: string,
  tenantId: string,
): Promise<void> {
  await db.update(billingEvents)
    .set({ tenantId })
    .where(and(eq(billingEvents.provider, provider), eq(billingEvents.externalEventId, externalEventId)));
}

/** Resetea los campos de dunning tras un pago/activación exitosa. */
export function paymentRecoveryFields() {
  return {
    pastDueSince: null,
    graceEndsAt: null,
    dunningAttempts: 0,
    lastDunningAt: null,
    suspendedAt: null,
  } as const;
}

// ── Change plan ───────────────────────────────────────────────────────────────

export async function changePlan(input: {
  tenantId: string;
  planName: string;
  billingPeriod: BillingPeriod;
  actorUserId?: string | null;
}): Promise<{ applied: 'immediate' | 'deferred'; planName: string }> {
  const [sub] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, input.tenantId)).limit(1);
  if (!sub) throw new AppError('No hay suscripción para este tenant', 404, 'NO_SUBSCRIPTION');

  const [plan] = await db.select().from(plans)
    .where(eq(plans.name, input.planName)).limit(1);
  if (!plan || !plan.isActive) throw new AppError('Plan no encontrado', 404, 'PLAN_NOT_FOUND');

  const [oldPlan] = await db.select({ name: plans.name }).from(plans)
    .where(eq(plans.id, sub.planId)).limit(1);

  if (sub.planId === plan.id && sub.billingPeriod === input.billingPeriod) {
    return { applied: 'immediate', planName: plan.name };
  }

  const providerMutable = sub.status === 'active' || sub.status === 'past_due';

  const applyNow = async () => {
    await db.update(subscriptions)
      .set({ planId: plan.id, billingPeriod: input.billingPeriod })
      .where(eq(subscriptions.id, sub.id));
    await syncTenantFeaturesForTenant(input.tenantId);
  };

  const auditAndEvent = async (deferred: boolean) => {
    await db.insert(billingEvents).values({
      tenantId: input.tenantId,
      type: deferred ? 'plan_change_deferred' : 'plan_changed',
      payload: { from: oldPlan?.name ?? null, to: plan.name, billingPeriod: input.billingPeriod },
    });
    await recordAuditEvent({
      action: AUDIT_ACTIONS.BILLING_PLAN_CHANGED,
      tenantId: input.tenantId,
      userId: input.actorUserId ?? null,
      entityType: 'subscription',
      entityId: sub.id,
      metadata: {
        from: oldPlan?.name ?? null,
        to: plan.name,
        billingPeriod: input.billingPeriod,
        deferred,
      },
    });
  };

  // Stripe: prorratea y cambia el price de la suscripción viva.
  if (sub.paymentProvider === 'stripe' && sub.externalSubscriptionId && providerMutable) {
    const stripe = getStripe();
    if (!stripe) throw new AppError('Stripe no está configurado', 503, 'STRIPE_NOT_CONFIGURED');

    const priceId = input.billingPeriod === 'yearly' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;
    if (!priceId) throw new AppError('El plan no tiene precio configurado en Stripe', 400, 'PLAN_NO_STRIPE_PRICE');

    let stripeSub: Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>;
    try {
      stripeSub = await stripe.subscriptions.retrieve(sub.externalSubscriptionId);
    } catch (err) {
      throw new AppError(`No se pudo leer la suscripción en Stripe: ${(err as Error).message}`, 502, 'STRIPE_ERROR');
    }
    const itemId = stripeSub.items.data[0]?.id;
    if (!itemId) throw new AppError('La suscripción de Stripe no tiene items', 502, 'STRIPE_SUB_NO_ITEMS');

    await stripe.subscriptions.update(sub.externalSubscriptionId, {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: 'create_prorations',
    });

    await applyNow();
    await auditAndEvent(false);
    return { applied: 'immediate', planName: plan.name };
  }

  // MercadoPago: el preapproval no admite cambio de monto → diferido a fin de ciclo.
  if (sub.paymentProvider === 'mercadopago' && sub.externalSubscriptionId && providerMutable) {
    const [tenant] = await db.select({ config: tenants.config }).from(tenants)
      .where(eq(tenants.id, input.tenantId)).limit(1);
    const config = (tenant?.config && typeof tenant.config === 'object' ? tenant.config : {}) as Record<string, unknown>;
    await db.update(tenants)
      .set({ config: { ...config, pendingPlan: { planName: plan.name, billingPeriod: input.billingPeriod } } })
      .where(eq(tenants.id, input.tenantId));

    await auditAndEvent(true);
    return { applied: 'deferred', planName: plan.name };
  }

  // Sin provider (trial, cortesía admin): cambio inmediato local.
  await applyNow();
  await auditAndEvent(false);
  return { applied: 'immediate', planName: plan.name };
}

// ── Reactivate ────────────────────────────────────────────────────────────────

export async function reactivateSubscription(input: {
  tenantId: string;
  actorUserId?: string | null;
}): Promise<{ status: string }> {
  const [sub] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, input.tenantId)).limit(1);
  if (!sub) throw new AppError('No hay suscripción para este tenant', 404, 'NO_SUBSCRIPTION');

  if (!sub.cancelAtPeriodEnd) {
    if (sub.status === 'past_due') {
      throw new AppError('Hay un pago pendiente: actualizá tu medio de pago para reactivar', 409, 'PAYMENT_OVERDUE');
    }
    if (sub.status === 'suspended') {
      throw new AppError('La suscripción está suspendida: regularizá el pago o contactá soporte', 409, 'SUBSCRIPTION_SUSPENDED');
    }
    if (sub.status === 'canceled' || sub.status === 'expired') {
      throw new AppError('La suscripción ya terminó: contratá un plan nuevo desde checkout', 409, 'SUBSCRIPTION_ENDED');
    }
    return { status: sub.status };
  }

  if (sub.paymentProvider === 'stripe' && sub.externalSubscriptionId) {
    const stripe = getStripe();
    if (!stripe) throw new AppError('Stripe no está configurado', 503, 'STRIPE_NOT_CONFIGURED');
    await stripe.subscriptions.update(sub.externalSubscriptionId, { cancel_at_period_end: false });
  }

  await db.update(subscriptions)
    .set({ cancelAtPeriodEnd: false, canceledAt: null })
    .where(eq(subscriptions.id, sub.id));

  await db.insert(billingEvents).values({
    tenantId: input.tenantId,
    type: 'subscription_reactivated',
    payload: {},
  });
  await recordAuditEvent({
    action: AUDIT_ACTIONS.BILLING_PLAN_CHANGED,
    tenantId: input.tenantId,
    userId: input.actorUserId ?? null,
    entityType: 'subscription',
    entityId: sub.id,
    metadata: { action: 'reactivate' },
  });

  return { status: sub.status };
}
