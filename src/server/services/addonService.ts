/**
 * addonService.ts — Add-ons de transmisiones (+N unidades por ciclo)
 *
 * Los add-ons comprados suman `usage_cycles.addon_transmissions` del ciclo
 * vigente y EXPIRAN SOLOS: el ciclo siguiente arranca en 0. No se acumulan
 * entre períodos.
 *
 * Idempotencia de aplicación:
 *  - La compra se crea `pending` con el checkout; el webhook la pasa a `paid`
 *    con un UPDATE condicionado a `status = 'pending'` → un segundo webhook
 *    toca 0 filas y no vuelve a acreditar.
 *  - `external_id` guarda el id del pago del provider y es único por provider.
 *  - Además el evento del webhook queda deduplicado en `billing_events`.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { Preference } from 'mercadopago';
import { db } from '../db/index.js';
import {
  addonPurchases,
  billingEvents,
  planAddons,
  tenants,
  usageCycles,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { recordAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { getOrCreateUsageCycle } from './transmissionMeteringService.js';
import { getStripe, getMercadoPago } from './billingProviders.js';

// ── Catálogo ──────────────────────────────────────────────────────────────────

const ADDON_SEEDS = [
  { name: '+5', transmissions: 5, priceUsd: '19.00', priceArs: '19000.00', sortOrder: 1 },
  { name: '+15', transmissions: 15, priceUsd: '45.00', priceArs: '45000.00', sortOrder: 2 },
] as const;

/** Idempotente: inserta los add-ons faltantes. Nunca pisa precios ajustados. */
export async function seedAddons(): Promise<{ inserted: string[] }> {
  const existing = await db.select({ name: planAddons.name }).from(planAddons);
  const have = new Set(existing.map((r) => r.name));
  const inserted: string[] = [];

  for (const seed of ADDON_SEEDS) {
    if (have.has(seed.name)) continue;
    await db.insert(planAddons).values({ kind: 'transmissions', ...seed }).onConflictDoNothing();
    inserted.push(seed.name);
  }
  return { inserted };
}

export async function listAddons() {
  return db.select().from(planAddons)
    .where(eq(planAddons.isActive, true))
    .orderBy(asc(planAddons.sortOrder));
}

// ── Checkout ──────────────────────────────────────────────────────────────────

export async function createAddonCheckout(input: {
  tenantId: string;
  addonName: string;
  provider: 'stripe' | 'mercadopago';
  actorUserId?: string | null;
  payerEmail?: string | null;
}): Promise<{ checkoutUrl: string | null; purchaseId: string; provider: string }> {
  const [addon] = await db.select().from(planAddons)
    .where(and(eq(planAddons.name, input.addonName), eq(planAddons.isActive, true)))
    .limit(1);
  if (!addon) throw new AppError('Add-on no encontrado', 404, 'ADDON_NOT_FOUND');

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  if (input.provider === 'stripe') {
    const stripe = getStripe();
    if (!stripe) throw new AppError('Stripe no está configurado', 503, 'STRIPE_NOT_CONFIGURED');

    const cycle = await getOrCreateUsageCycle(input.tenantId);

    const [purchase] = await db.insert(addonPurchases).values({
      tenantId: input.tenantId,
      addonId: addon.id,
      transmissionsGranted: addon.transmissions,
      amount: addon.priceUsd,
      currency: 'USD',
      provider: 'stripe',
      status: 'pending',
    }).returning({ id: addonPurchases.id });

    const lineItem = addon.stripePriceId
      ? { price: addon.stripePriceId, quantity: 1 }
      : {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(Number(addon.priceUsd) * 100),
            product_data: { name: `+${addon.transmissions} transmisiones — PeriodistApp` },
          },
          quantity: 1,
        };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: input.payerEmail ?? undefined,
      line_items: [lineItem],
      success_url: `${frontendUrl}/billing?status=addon_success&provider=stripe`,
      cancel_url: `${frontendUrl}/billing?status=cancel`,
      metadata: {
        kind: 'addon',
        tenantId: input.tenantId,
        addonName: addon.name,
        usageCycleId: cycle.id,
        purchaseId: purchase.id,
      },
    });

    return { checkoutUrl: session.url, purchaseId: purchase.id, provider: 'stripe' };
  }

  // MercadoPago: Checkout Pro con referencia a la compra pendiente.
  const mpConfig = getMercadoPago();
  if (!mpConfig) throw new AppError('MercadoPago no está configurado', 503, 'MP_NOT_CONFIGURED');

  const [purchase] = await db.insert(addonPurchases).values({
    tenantId: input.tenantId,
    addonId: addon.id,
    transmissionsGranted: addon.transmissions,
    amount: addon.priceArs ?? addon.priceUsd,
    currency: 'ARS',
    provider: 'mercadopago',
    status: 'pending',
  }).returning({ id: addonPurchases.id });

  const preference = new Preference(mpConfig);
  const result = await preference.create({
    body: {
      items: [{
        id: addon.name,
        title: `+${addon.transmissions} transmisiones — PeriodistApp`,
        quantity: 1,
        unit_price: Number(addon.priceArs ?? addon.priceUsd),
        currency_id: 'ARS',
      }],
      external_reference: `addonpurchase:${purchase.id}`,
      back_urls: {
        success: `${frontendUrl}/billing?status=addon_success&provider=mercadopago`,
        failure: `${frontendUrl}/billing?status=cancel`,
        pending: `${frontendUrl}/billing?status=pending`,
      },
      auto_return: 'approved',
    },
  });

  return { checkoutUrl: result.init_point ?? null, purchaseId: purchase.id, provider: 'mercadopago' };
}

// ── Aplicación (idempotente) ──────────────────────────────────────────────────

/**
 * Acredita las transmisiones de una compra al ciclo vigente del tenant.
 * Segura ante reintentos: si la compra ya está `paid` no hace nada.
 */
export async function applyAddonPurchase(input: {
  purchaseId: string;
  provider: 'stripe' | 'mercadopago';
  externalId: string;
}): Promise<{ applied: boolean; transmissionsGranted?: number }> {
  const [purchase] = await db.select().from(addonPurchases)
    .where(eq(addonPurchases.id, input.purchaseId))
    .limit(1);
  if (!purchase) throw new AppError('Compra de add-on no encontrada', 404, 'PURCHASE_NOT_FOUND');
  if (purchase.provider && purchase.provider !== input.provider) {
    throw new AppError('La compra pertenece a otro provider', 409, 'PROVIDER_MISMATCH');
  }
  if (purchase.status === 'paid') return { applied: false };

  const cycle = await getOrCreateUsageCycle(purchase.tenantId);
  const expiresAt = new Date(`${cycle.periodEnd}T00:00:00.000Z`);

  // UPDATE guardado por status='pending': un segundo webhook toca 0 filas.
  const [applied] = await db.update(addonPurchases)
    .set({
      status: 'paid',
      externalId: input.externalId,
      usageCycleId: cycle.id,
      expiresAt,
      appliedAt: new Date(),
    })
    .where(and(eq(addonPurchases.id, purchase.id), eq(addonPurchases.status, 'pending')))
    .returning({ id: addonPurchases.id });

  if (!applied) return { applied: false };

  // Sumar al pool del ciclo vigente.
  await db.update(usageCycles)
    .set({ addonTransmissions: sql`${usageCycles.addonTransmissions} + ${purchase.transmissionsGranted}` })
    .where(and(eq(usageCycles.id, cycle.id), eq(usageCycles.tenantId, purchase.tenantId)));

  await db.insert(billingEvents).values({
    tenantId: purchase.tenantId,
    type: 'addon_purchased',
    provider: input.provider,
    externalEventId: `addon:${purchase.id}:${input.externalId}`,
    payload: { purchaseId: purchase.id, transmissions: purchase.transmissionsGranted, expiresAt },
  }).onConflictDoNothing();

  void recordAuditEvent({
    action: AUDIT_ACTIONS.BILLING_PAYMENT_OK,
    tenantId: purchase.tenantId,
    entityType: 'addon_purchase',
    entityId: purchase.id,
    metadata: { provider: input.provider, transmissions: purchase.transmissionsGranted, externalId: input.externalId },
  });

  return { applied: true, transmissionsGranted: purchase.transmissionsGranted };
}
