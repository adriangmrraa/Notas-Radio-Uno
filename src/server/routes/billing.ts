import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { MercadoPagoConfig, PreApproval, Payment, Preference } from 'mercadopago';
import { db } from '../db/index.js';
import { requireAuth, forbidImpersonated } from '../middleware/auth.js';
import { plans, subscriptions, usageRecords, invoices, tenants } from '../db/schema/index.js';
import { users } from '../db/schema/index.js';
import { eq, and, desc } from 'drizzle-orm';
import { recordEvent, hasEvent, listEvents } from '../services/billingEventsService.js';
import { applyTransition, getSubscriptionByTenant } from '../services/subscriptionMachine.js';
import { getQuotaStatus, grant as grantQuota } from '../services/quotaService.js';
import { sendPaymentOkEmail } from '../services/emailService.js';
import { listMemberEmails } from '../services/inviteService.js';
import { auditRequest } from '../services/auditService.js';

const router = Router();

// ---------------------------------------------------------------------------
// Stripe & MercadoPago clients (lazy init)
// ---------------------------------------------------------------------------
function getStripe(): Stripe | null {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    return new Stripe(key);
}

function getMercadoPago() {
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) return null;
    return new MercadoPagoConfig({ accessToken: token });
}

// ---------------------------------------------------------------------------
// Add-ons de transmisiones (PRODUCT-VISION §3.3): +5 / +15, expiran con ciclo.
// Precios configurables por env — defaults razonables en centavos.
// ---------------------------------------------------------------------------
const ADDON_PACKAGES = {
    plus5: { transmissions: 5, priceUsdCents: Number(process.env.ADDON_PLUS5_USD_CENTS ?? 1500), priceArs: Number(process.env.ADDON_PLUS5_ARS ?? 15000) },
    plus15: { transmissions: 15, priceUsdCents: Number(process.env.ADDON_PLUS15_USD_CENTS ?? 3900), priceArs: Number(process.env.ADDON_PLUS15_ARS ?? 39000) },
} as const;
type AddonKey = keyof typeof ADDON_PACKAGES;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ---------------------------------------------------------------------------
// GET /api/billing/plans — Public
// ---------------------------------------------------------------------------
router.get('/plans', async (_req: Request, res: Response) => {
    try {
        const allPlans = await db.select().from(plans)
            .where(eq(plans.isActive, true))
            .orderBy(plans.sortOrder);
        res.json(allPlans);
    } catch (err) {
        console.error('[Billing] Error fetching plans:', err);
        res.status(500).json({ error: 'Error al obtener planes' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/billing/my-subscription — Auth required
// ---------------------------------------------------------------------------
router.get('/my-subscription', requireAuth, async (req: Request, res: Response) => {
    try {
        const rows = await db.select({ sub: subscriptions, plan: plans })
            .from(subscriptions)
            .leftJoin(plans, eq(subscriptions.planId, plans.id))
            .where(eq(subscriptions.tenantId, req.auth!.tenantId!))
            .limit(1);

        if (!rows[0]) {
            res.json({ subscription: null });
            return;
        }

        const { sub: subscription, plan } = rows[0];

        if (!subscription || !plan) {
            res.json({ subscription: null });
            return;
        }

        let trialDaysRemaining: number | null = null;
        if (subscription.status === 'trialing' && subscription.trialEndsAt) {
            const diff = subscription.trialEndsAt.getTime() - Date.now();
            trialDaysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
            if (trialDaysRemaining === 0) {
                // La expiración pasa por la máquina (T-39/T-40).
                await applyTransition(subscription.id, 'trial_expired', {
                    provider: 'system',
                    actor: 'system:my-subscription',
                }).catch((e) => console.warn('[Billing] trial_expired:', e));
                subscription.status = 'expired';
            }
        }

        res.json({
            subscription: {
                id: subscription.id,
                status: subscription.status,
                planName: plan.name,
                planDisplayName: plan.displayName,
                trialEndsAt: subscription.trialEndsAt,
                trialDaysRemaining,
                currentPeriodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                graceEndsAt: subscription.graceEndsAt,
                limits: {
                    maxPipelineHoursPerMonth: plan.maxPipelineHoursPerMonth,
                    maxPublicationsPerMonth: plan.maxPublicationsPerMonth,
                    maxScheduledJobs: plan.maxScheduledJobs,
                    maxCustomAgents: plan.maxCustomAgents,
                    maxTeamMembers: plan.maxTeamMembers,
                    maxConnectedPlatforms: plan.maxConnectedPlatforms,
                    maxStorageGb: plan.maxStorageGb,
                    maxTransmissionsPerMonth: plan.maxTransmissionsPerMonth,
                    maxDurationMinutes: plan.maxDurationMinutes,
                    maxClipsPerTransmission: plan.maxClipsPerTransmission,
                    maxPersons: plan.maxPersons,
                    retentionDays: plan.retentionDays,
                },
                features: plan.features,
            },
        });
    } catch (err) {
        console.error('[Billing] Error fetching subscription:', err);
        res.status(500).json({ error: 'Error al obtener suscripcion' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/billing/usage — medidor del ciclo (T-44)
// count/limit/period/extra + renovación en TZ del tenant + históricos legacy.
// ---------------------------------------------------------------------------

/** Offset (local − UTC) en ms para una fecha dada en una timezone IANA. */
function tzOffsetMs(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
    const localAsUtc = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    return localAsUtc - date.getTime();
}

/** Instante UTC en que empieza el período siguiente (00:00 del día 1 en TZ tenant). */
export function periodRenewalInstant(period: string, timeZone: string): Date {
    const [y, m] = period.split('-').map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const guessUtc = Date.UTC(nextY, nextM - 1, 1, 0, 0, 0);
    // Una iteración de corrección por DST basta para el boundary mensual.
    const offset = tzOffsetMs(new Date(guessUtc), timeZone);
    return new Date(guessUtc - offset);
}

router.get('/usage', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId!;
        const quota = await getQuotaStatus(tenantId);

        const [tenant] = await db.select({ timezone: tenants.timezone })
            .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
        const timezone = tenant?.timezone ?? 'UTC';

        const [subRow] = await db.select({ plan: plans, sub: subscriptions })
            .from(subscriptions)
            .leftJoin(plans, eq(subscriptions.planId, plans.id))
            .where(eq(subscriptions.tenantId, tenantId))
            .limit(1);

        const effectiveLimit = quota.effectiveLimit; // -1 = ilimitado
        const used = quota.transmissionsUsed;
        const usagePercent = effectiveLimit > 0
            ? Math.round((used / effectiveLimit) * 100)
            : (used > 0 && effectiveLimit === 0 ? 100 : 0);

        // Histórico legacy (pipeline hours, publications…) — usage_records.
        const now = new Date();
        const legacyPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        const [legacy] = await db.select().from(usageRecords)
            .where(and(eq(usageRecords.tenantId, tenantId), eq(usageRecords.periodStart, legacyPeriod)))
            .limit(1);

        res.json({
            // ── Shape legacy FLAT (BillingPage lo consume tal cual) ──
            pipelineHoursUsed: Number(legacy?.pipelineHoursUsed ?? 0),
            publicationsCount: legacy?.publicationsCount ?? 0,
            transcriptionMinutes: Number(legacy?.transcriptionMinutes ?? 0),
            aiTokensUsed: Number(legacy?.aiTokensUsed ?? 0),
            storageUsedMb: Number(legacy?.storageUsedMb ?? 0),
            // ── Veredicto de cuota real del ciclo (T-44) ──
            period: quota.period,
            timezone,
            transmissionsUsed: used,
            effectiveLimit,                       // plan + extra (-1 = ∞)
            extraTransmissions: quota.extraTransmissions,
            planLimit: subRow?.plan?.maxTransmissionsPerMonth ?? null,
            usagePercent,
            over80: effectiveLimit > 0 && usagePercent >= 80,
            renewsAt: periodRenewalInstant(quota.period, timezone),
            subscriptionStatus: subRow?.sub?.status ?? null,
            planName: subRow?.plan?.name ?? null,
        });
    } catch (err) {
        console.error('[Billing] Error fetching usage:', err);
        res.status(500).json({ error: 'Error al obtener uso' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/billing/invoices — Auth required
// ---------------------------------------------------------------------------
router.get('/invoices', requireAuth, async (req: Request, res: Response) => {
    try {
        const allInvoices = await db.select().from(invoices)
            .where(eq(invoices.tenantId, req.auth!.tenantId!))
            .orderBy(desc(invoices.createdAt))
            .limit(50);
        res.json(allInvoices);
    } catch (err) {
        console.error('[Billing] Error fetching invoices:', err);
        res.status(500).json({ error: 'Error al obtener facturas' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/billing/events — historial billing_events del tenant (append-only)
// ---------------------------------------------------------------------------
router.get('/events', requireAuth, async (req: Request, res: Response) => {
    try {
        const events = await listEvents(req.auth!.tenantId!, 100);
        res.json(events);
    } catch (err) {
        console.error('[Billing] Error fetching events:', err);
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/checkout — alta o cambio de plan (Stripe | MercadoPago)
// BLOQUEADO durante impersonación (F4 anti-destructive: pagos).
// ---------------------------------------------------------------------------
router.post('/checkout', requireAuth, forbidImpersonated, async (req: Request, res: Response) => {
    try {
        const { planName, billingPeriod = 'monthly', provider = 'stripe' } = req.body;

        const [plan] = await db.select().from(plans)
            .where(eq(plans.name, planName))
            .limit(1);
        if (!plan || !plan.isActive) {
            res.status(400).json({ error: 'Plan no encontrado' });
            return;
        }

        const [user] = await db.select({ email: users.email }).from(users)
            .where(eq(users.id, req.auth!.userId))
            .limit(1);

        if (provider === 'stripe') {
            const stripe = getStripe();
            if (!stripe) {
                res.status(503).json({ error: 'Stripe no esta configurado' });
                return;
            }

            const priceId = billingPeriod === 'yearly'
                ? plan.stripePriceIdYearly
                : plan.stripePriceIdMonthly;

            if (!priceId) {
                res.status(400).json({ error: 'Plan no tiene precio configurado en Stripe' });
                return;
            }

            const session = await stripe.checkout.sessions.create({
                mode: 'subscription',
                customer_email: user?.email,
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: `${FRONTEND_URL}/billing?status=success&provider=stripe`,
                cancel_url: `${FRONTEND_URL}/billing?status=cancel`,
                metadata: {
                    tenantId: req.auth!.tenantId!,
                    planName: plan.name,
                    billingPeriod,
                },
            });

            void auditRequest(req, 'billing.checkout', { provider: 'stripe', planName, billingPeriod });
            res.json({ checkoutUrl: session.url, sessionId: session.id, provider: 'stripe' });
        } else if (provider === 'mercadopago') {
            const mpConfig = getMercadoPago();
            if (!mpConfig) {
                res.status(503).json({ error: 'MercadoPago no esta configurado' });
                return;
            }

            const amount = billingPeriod === 'yearly'
                ? Number(plan.priceArsYearly || plan.priceArs)
                : Number(plan.priceArs);

            const preApproval = new PreApproval(mpConfig);
            const result = await preApproval.create({
                body: {
                    reason: `PeriodistApp ${plan.displayName} - ${billingPeriod === 'yearly' ? 'Anual' : 'Mensual'}`,
                    auto_recurring: {
                        frequency: 1,
                        frequency_type: billingPeriod === 'yearly' ? 'years' : 'months',
                        transaction_amount: amount,
                        currency_id: 'ARS',
                    },
                    external_reference: `tenant_${req.auth!.tenantId}_${plan.name}_${billingPeriod}`,
                    back_url: `${FRONTEND_URL}/billing?status=success&provider=mercadopago`,
                },
            });

            void auditRequest(req, 'billing.checkout', { provider: 'mercadopago', planName, billingPeriod });
            res.json({ checkoutUrl: result.init_point, preapprovalId: result.id, provider: 'mercadopago' });
        } else {
            res.status(400).json({ error: 'Provider no soportado' });
        }
    } catch (err) {
        console.error('[Billing] Checkout error:', err);
        res.status(500).json({ error: 'Error al crear checkout' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/change-plan — cambio de plan con prorrateo (Stripe) o
// checkout nuevo (MP no prorratea → se completa vía webhook authorized).
// ---------------------------------------------------------------------------
router.post('/change-plan', requireAuth, forbidImpersonated, async (req: Request, res: Response) => {
    try {
        const { planName, billingPeriod } = req.body as { planName?: string; billingPeriod?: string };
        if (!planName) { res.status(400).json({ error: 'planName requerido' }); return; }

        const [plan] = await db.select().from(plans).where(eq(plans.name, planName)).limit(1);
        if (!plan || !plan.isActive) { res.status(400).json({ error: 'Plan no encontrado' }); return; }

        const sub = await getSubscriptionByTenant(req.auth!.tenantId!);
        if (!sub) { res.status(404).json({ error: 'No hay suscripcion activa — usa /checkout' }); return; }

        const period = billingPeriod ?? sub.billingPeriod ?? 'monthly';

        if (sub.paymentProvider === 'stripe' && sub.externalSubscriptionId) {
            const stripe = getStripe();
            if (!stripe) { res.status(503).json({ error: 'Stripe no esta configurado' }); return; }

            const priceId = period === 'yearly' ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;
            if (!priceId) { res.status(400).json({ error: 'Plan sin precio Stripe configurado' }); return; }

            // Prorrateo del provider (spec: cambio de plan con proration).
            const stripeSub = await stripe.subscriptions.retrieve(sub.externalSubscriptionId);
            const itemId = stripeSub.items.data[0]?.id;
            if (!itemId) { res.status(502).json({ error: 'Suscripcion Stripe sin items' }); return; }

            await stripe.subscriptions.update(sub.externalSubscriptionId, {
                items: [{ id: itemId, price: priceId }],
                proration_behavior: 'create_prorations',
            });

            const applied = await applyTransition(sub.id, 'plan_changed', {
                planId: plan.id,
                billingPeriod: period,
                frozenPrice: plan.priceUsd,
                frozenCurrency: 'USD',
                provider: 'stripe',
                actor: req.auth!.userId,
            });

            void auditRequest(req, 'billing.plan_changed', { planName, provider: 'stripe', prorated: true, applied: applied.applied });
            res.json({ message: 'Plan actualizado con prorrateo', plan: plan.name, applied: applied.applied });
            return;
        }

        if (sub.paymentProvider === 'mercadopago') {
            // MP no prorratea: emitir checkout del nuevo plan — el webhook
            // authorized completa el cambio vía máquina (external_reference).
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.status(503).json({ error: 'MercadoPago no esta configurado' }); return; }

            const amount = period === 'yearly' ? Number(plan.priceArsYearly || plan.priceArs) : Number(plan.priceArs);
            const preApproval = new PreApproval(mpConfig);
            const result = await preApproval.create({
                body: {
                    reason: `PeriodistApp ${plan.displayName} - ${period === 'yearly' ? 'Anual' : 'Mensual'}`,
                    auto_recurring: {
                        frequency: 1,
                        frequency_type: period === 'yearly' ? 'years' : 'months',
                        transaction_amount: amount,
                        currency_id: 'ARS',
                    },
                    external_reference: `tenant_${req.auth!.tenantId}_${plan.name}_${period}`,
                    back_url: `${FRONTEND_URL}/billing?status=success&provider=mercadopago`,
                },
            });
            void auditRequest(req, 'billing.plan_change_requested', { planName, provider: 'mercadopago' });
            res.json({ checkoutUrl: result.init_point, provider: 'mercadopago', message: 'Confirma el nuevo plan en MercadoPago' });
            return;
        }

        // Sin provider externo (admin/manual): transición directa.
        const applied = await applyTransition(sub.id, 'plan_changed', {
            planId: plan.id,
            billingPeriod: period,
            frozenPrice: plan.priceUsd,
            frozenCurrency: 'USD',
            provider: 'manual',
            actor: req.auth!.userId,
        });
        void auditRequest(req, 'billing.plan_changed', { planName, provider: 'manual', applied: applied.applied });
        res.json({ message: 'Plan actualizado', plan: plan.name, applied: applied.applied });
    } catch (err) {
        console.error('[Billing] Change plan error:', err);
        res.status(500).json({ error: 'Error al cambiar de plan' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/cancel — soft-cancel con motivo (spec subscription-lifecycle)
// ---------------------------------------------------------------------------
router.post('/cancel', requireAuth, forbidImpersonated, async (req: Request, res: Response) => {
    try {
        const { reason } = req.body as { reason?: string };
        const sub = await getSubscriptionByTenant(req.auth!.tenantId!);

        if (!sub) {
            res.status(404).json({ error: 'No hay suscripcion activa' });
            return;
        }

        // Soft-cancel vía máquina: status intacto, flag hasta fin de período.
        const applied = await applyTransition(sub.id, 'cancel_requested', {
            cancelReason: reason ?? null,
            actor: req.auth!.userId,
            provider: sub.paymentProvider,
        });
        if (!applied.applied) {
            res.status(409).json({ error: applied.reason ?? 'No se pudo cancelar' });
            return;
        }

        // Aviso al provider (best-effort — la fuente de verdad es el webhook).
        if (sub.paymentProvider === 'stripe' && sub.externalSubscriptionId) {
            const stripe = getStripe();
            if (stripe) {
                await stripe.subscriptions.update(sub.externalSubscriptionId, {
                    cancel_at_period_end: true,
                }).catch((e) => console.warn('[Billing] Stripe cancel_at_period_end:', e));
            }
        } else if (sub.paymentProvider === 'mercadopago' && sub.externalSubscriptionId) {
            const mpConfig = getMercadoPago();
            if (mpConfig) {
                await new PreApproval(mpConfig).update({
                    id: sub.externalSubscriptionId,
                    body: { status: 'cancelled' },
                }).catch((e) => console.warn('[Billing] MP preapproval cancel:', e));
            }
        }

        void auditRequest(req, 'billing.cancel', { reason: reason ?? null });
        res.json({ message: 'Suscripcion cancelada al final del periodo' });
    } catch (err) {
        console.error('[Billing] Cancel error:', err);
        res.status(500).json({ error: 'Error al cancelar suscripcion' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/addon — add-on +5/+15 transmisiones (expiran con el ciclo)
// ---------------------------------------------------------------------------
router.post('/addon', requireAuth, forbidImpersonated, async (req: Request, res: Response) => {
    try {
        const { addon, provider = 'stripe' } = req.body as { addon?: AddonKey; provider?: string };
        if (!addon || !(addon in ADDON_PACKAGES)) {
            res.status(400).json({ error: 'Addon invalido — opciones: plus5 | plus15' });
            return;
        }
        const pkg = ADDON_PACKAGES[addon];

        if (provider === 'stripe') {
            const stripe = getStripe();
            if (!stripe) { res.status(503).json({ error: 'Stripe no esta configurado' }); return; }

            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        unit_amount: pkg.priceUsdCents,
                        product_data: { name: `+${pkg.transmissions} transmisiones (ciclo actual)` },
                    },
                    quantity: 1,
                }],
                success_url: `${FRONTEND_URL}/billing?status=addon_success&provider=stripe`,
                cancel_url: `${FRONTEND_URL}/billing?status=cancel`,
                metadata: { tenantId: req.auth!.tenantId!, addon },
            });
            void auditRequest(req, 'billing.addon_checkout', { addon, provider: 'stripe' });
            res.json({ checkoutUrl: session.url, sessionId: session.id, provider: 'stripe' });
            return;
        }

        if (provider === 'mercadopago') {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.status(503).json({ error: 'MercadoPago no esta configurado' }); return; }

            const preference = new Preference(mpConfig);
            const result = await preference.create({
                body: {
                    items: [{
                        id: addon,
                        title: `PeriodistApp +${pkg.transmissions} transmisiones`,
                        quantity: 1,
                        unit_price: pkg.priceArs,
                        currency_id: 'ARS',
                    }],
                    external_reference: `addon_${req.auth!.tenantId}_${addon}`,
                    back_urls: {
                        success: `${FRONTEND_URL}/billing?status=addon_success&provider=mercadopago`,
                        failure: `${FRONTEND_URL}/billing?status=cancel`,
                    },
                },
            });
            void auditRequest(req, 'billing.addon_checkout', { addon, provider: 'mercadopago' });
            res.json({ checkoutUrl: result.init_point, provider: 'mercadopago' });
            return;
        }

        res.status(400).json({ error: 'Provider no soportado' });
    } catch (err) {
        console.error('[Billing] Addon error:', err);
        res.status(500).json({ error: 'Error al crear add-on' });
    }
});

// ---------------------------------------------------------------------------
// Helpers compartidos de webhook
// ---------------------------------------------------------------------------

/** Asegura fila de suscripción para el tenant (edge: checkout sin sub previa). */
async function ensureSubscription(tenantId: string, planId: string) {
    const existing = await getSubscriptionByTenant(tenantId);
    if (existing) return existing;
    const [sub] = await db.insert(subscriptions).values({
        tenantId,
        planId,
        status: 'trialing',
    }).onConflictDoNothing({ target: subscriptions.tenantId }).returning();
    if (sub) return sub;
    return (await getSubscriptionByTenant(tenantId))!;
}

/** Otorga las transmisiones de un add-on pago (grant que expira con el ciclo). */
async function grantAddon(tenantId: string, addon: string, externalOpId: string) {
    const pkg = ADDON_PACKAGES[addon as AddonKey];
    if (!pkg) {
        console.warn(`[Billing] addon desconocido '${addon}' — grant ignorado`);
        return;
    }
    await grantQuota(tenantId, pkg.transmissions, null, externalOpId);
    await recordEvent({
        tenantId,
        type: 'addon_purchased',
        payload: { addon, transmissions: pkg.transmissions, externalOpId },
    });
    console.log(`[Billing] add-on ${addon} → +${pkg.transmissions} tx para tenant ${tenantId}`);
}

/** Emails de pago OK a los owners del tenant (best-effort). */
async function emailOwnersPaymentOk(tenantId: string): Promise<void> {
    const emails = await listMemberEmails(tenantId).catch(() => [] as string[]);
    for (const email of emails) {
        sendPaymentOkEmail(email, 'equipo').catch((e) => console.warn('[Billing] sendPaymentOkEmail:', e));
    }
}

// ---------------------------------------------------------------------------
// POST /api/billing/webhook/stripe — No auth (Stripe signs it)
// Flujo: firma → dedup billing_events(external_id=event.id) → máquina.
// ---------------------------------------------------------------------------
router.post('/webhook/stripe', async (req: Request, res: Response) => {
    const stripe = getStripe();
    if (!stripe) { res.sendStatus(503); return; }

    const sig = req.headers['stripe-signature'] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) { res.sendStatus(503); return; }

    let event: Stripe.Event;
    try {
        // req.body is a raw Buffer here: index.ts mounts express.raw() on this
        // path BEFORE express.json(). If that ordering ever breaks, req.body is a
        // parsed object and constructEvent throws — failing closed with a 400.
        event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret);
    } catch (err) {
        console.error('[Stripe Webhook] Signature verification failed:', err);
        res.status(400).send('Webhook signature verification failed');
        return;
    }

    try {
        // Dedup ATÓMICO por external_id — el primer insert gana; un retry del
        // mismo evento Stripe sale temprano sin doble efecto (F5).
        const gate = await recordEvent({
            type: 'webhook_received',
            provider: 'stripe',
            externalId: event.id,
            payload: { eventType: event.type },
        });
        if (!gate.inserted) {
            res.json({ received: true, deduplicated: true });
            return;
        }

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;
                const { tenantId, planName, billingPeriod, addon } = session.metadata || {};
                if (!tenantId) break;

                if (session.mode === 'payment' && addon) {
                    // Add-on +N transmisiones → grant de cuota del ciclo.
                    await grantAddon(tenantId, addon, `stripe_addon:${session.id}`);
                    break;
                }

                if (!planName) break;
                const [plan] = await db.select().from(plans)
                    .where(eq(plans.name, planName))
                    .limit(1);
                if (!plan) break;

                const sub = await ensureSubscription(tenantId, plan.id);
                await applyTransition(sub.id, 'checkout_completed', {
                    planId: plan.id,
                    billingPeriod: billingPeriod || 'monthly',
                    paymentProvider: 'stripe',
                    externalSubscriptionId: session.subscription as string,
                    externalCustomerId: session.customer as string,
                    frozenPrice: plan.priceUsd,
                    frozenCurrency: 'USD',
                    currentPeriodStart: new Date(),
                    provider: 'stripe',
                    actor: 'system:webhook-stripe',
                    payload: { sessionId: session.id },
                });
                console.log(`[Stripe] Subscription activated for tenant ${tenantId}, plan ${planName}`);
                break;
            }

            case 'invoice.paid': {
                const stripeInvoice = event.data.object as Stripe.Invoice;
                const customerId = stripeInvoice.customer as string;

                const [subscription] = await db.select().from(subscriptions)
                    .where(eq(subscriptions.externalCustomerId, customerId))
                    .limit(1);
                if (!subscription) break;

                await db.insert(invoices).values({
                    tenantId: subscription.tenantId,
                    subscriptionId: subscription.id,
                    amount: String((stripeInvoice.amount_paid || 0) / 100),
                    currency: stripeInvoice.currency?.toUpperCase() || 'USD',
                    status: 'paid',
                    paymentProvider: 'stripe',
                    externalInvoiceId: stripeInvoice.id,
                    paidAt: new Date(),
                    billingPeriodStart: stripeInvoice.period_start ? new Date(stripeInvoice.period_start * 1000) : undefined,
                    billingPeriodEnd: stripeInvoice.period_end ? new Date(stripeInvoice.period_end * 1000) : undefined,
                });

                await applyTransition(subscription.id, 'invoice_paid', {
                    currentPeriodStart: stripeInvoice.period_start ? new Date(stripeInvoice.period_start * 1000) : null,
                    currentPeriodEnd: stripeInvoice.period_end ? new Date(stripeInvoice.period_end * 1000) : null,
                    provider: 'stripe',
                    actor: 'system:webhook-stripe',
                });
                void emailOwnersPaymentOk(subscription.tenantId);
                break;
            }

            case 'invoice.payment_failed': {
                const failedInvoice = event.data.object as Stripe.Invoice;
                const custId = failedInvoice.customer as string;

                const [subscription] = await db.select().from(subscriptions)
                    .where(eq(subscriptions.externalCustomerId, custId))
                    .limit(1);
                if (!subscription) break;

                // active → past_due + billing_event + enqueue dunning (máquina).
                await applyTransition(subscription.id, 'payment_failed', {
                    provider: 'stripe',
                    actor: 'system:webhook-stripe',
                    payload: { invoiceId: failedInvoice.id },
                });
                break;
            }

            case 'customer.subscription.deleted': {
                const deletedSub = event.data.object as Stripe.Subscription;
                const [subscription] = await db.select().from(subscriptions)
                    .where(eq(subscriptions.externalSubscriptionId, deletedSub.id))
                    .limit(1);
                if (!subscription) break;

                await applyTransition(subscription.id, 'subscription_deleted', {
                    cancelReason: 'provider_deleted',
                    provider: 'stripe',
                    actor: 'system:webhook-stripe',
                });
                break;
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error('[Stripe Webhook] Processing error:', err);
        res.status(500).json({ error: 'Webhook processing error' });
    }
});

// ---------------------------------------------------------------------------
// MercadoPago webhook signature verification
// Docs: https://www.mercadopago.com/developers/en/docs/your-integrations/notifications/webhooks
// x-signature: "ts=<unix>,v1=<hmac-sha256 hex>" — signed manifest:
//   "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// If MP_WEBHOOK_SECRET is not set, verification is skipped and the handler
// relies solely on the mandatory API re-fetch below (never trusts req.body).
// ---------------------------------------------------------------------------
function verifyMercadoPagoSignature(req: Request): boolean {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) return true;

    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    if (typeof xSignature !== 'string' || typeof xRequestId !== 'string') return false;

    const parts: Record<string, string> = {};
    for (const pair of xSignature.split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) parts[k.trim()] = v.trim();
    }
    const ts = parts['ts'];
    const v1 = parts['v1'];
    if (!ts || !v1) return false;

    const dataId = String(
        req.query['data.id'] ?? (req.body as { data?: { id?: unknown } } | undefined)?.data?.id ?? ''
    );
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expected = createHmac('sha256', secret).update(manifest).digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(v1, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// POST /api/billing/webhook/mercadopago — No auth
// Flujo: firma (si hay secret) → re-fetch API → dedup external_id → máquina.
// ---------------------------------------------------------------------------
router.post('/webhook/mercadopago', async (req: Request, res: Response) => {
    if (!verifyMercadoPagoSignature(req)) {
        console.warn('[MercadoPago Webhook] Invalid x-signature — request rejected');
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
    }

    try {
        // MP may send { type, data.id } in the body or as ?type=&data.id= query params.
        const type = (req.query.type as string) || (req.body as { type?: string })?.type;
        const dataId =
            (req.query['data.id'] as string) ||
            (req.body as { data?: { id?: unknown } })?.data?.id;

        // Dedup ANTES de tocar la API: el external_id compuesto cubre retries.
        const externalId = `mp:${type ?? 'unknown'}:${dataId ?? 'noid'}`;
        if (dataId && (await hasEvent(externalId))) {
            res.json({ received: true, deduplicated: true });
            return;
        }

        // SECURITY: req.body is NEVER trusted for state mutations. Every branch
        // below re-fetches the entity from the MercadoPago API (preApproval.get /
        // payment.get) and mutates only from that verified response.

        if (type === 'subscription_preapproval' && dataId) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const preApproval = new PreApproval(mpConfig);
            const result = await preApproval.get({ id: String(dataId) });

            // Registramos la recepción DESPUÉS de confirmar que el evento es real.
            await recordEvent({
                type: 'webhook_received', provider: 'mercadopago', externalId,
                payload: { mpStatus: result.status },
            });

            const externalRef = result.external_reference || '';
            const match = externalRef.match(/^tenant_(.+?)_(.+?)_(.+)$/);
            if (!match) { res.json({ received: true }); return; }

            const [, tenantId, planName, billingPeriod] = match;
            const [plan] = await db.select().from(plans)
                .where(eq(plans.name, planName))
                .limit(1);
            if (!plan) { res.json({ received: true }); return; }

            const mpStatus = result.status;

            if (mpStatus === 'authorized') {
                const sub = await ensureSubscription(tenantId, plan.id);
                await applyTransition(sub.id, 'checkout_completed', {
                    planId: plan.id,
                    billingPeriod,
                    paymentProvider: 'mercadopago',
                    externalSubscriptionId: String(dataId),
                    frozenPrice: plan.priceArs,
                    frozenCurrency: 'ARS',
                    currentPeriodStart: new Date(),
                    provider: 'mercadopago',
                    actor: 'system:webhook-mp',
                });
                console.log(`[MercadoPago] Subscription activated for tenant ${tenantId}`);
            } else if (mpStatus === 'paused' || mpStatus === 'cancelled') {
                const sub = await getSubscriptionByTenant(tenantId);
                if (sub) {
                    await applyTransition(sub.id, 'subscription_deleted', {
                        cancelReason: `mp_${mpStatus}`,
                        provider: 'mercadopago',
                        actor: 'system:webhook-mp',
                    });
                }
            }
        }

        if (type === 'payment' && dataId) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const payment = new Payment(mpConfig);
            const paymentData = await payment.get({ id: String(dataId) });

            await recordEvent({
                type: 'webhook_received', provider: 'mercadopago', externalId,
                payload: { mpStatus: paymentData.status },
            });

            if (paymentData.status === 'approved' && paymentData.external_reference) {
                const ref = paymentData.external_reference;

                const addonMatch = ref.match(/^addon_(.+?)_(plus5|plus15)$/);
                if (addonMatch) {
                    const [, tenantId, addon] = addonMatch;
                    await grantAddon(tenantId, addon, `mp_addon:${dataId}`);
                    res.json({ received: true });
                    return;
                }

                const match = ref.match(/^tenant_(.+?)_/);
                if (match) {
                    const tenantId = match[1];
                    const [sub] = await db.select().from(subscriptions)
                        .where(eq(subscriptions.tenantId, tenantId))
                        .limit(1);
                    if (sub) {
                        await db.insert(invoices).values({
                            tenantId,
                            subscriptionId: sub.id,
                            amount: String(paymentData.transaction_amount || 0),
                            currency: 'ARS',
                            status: 'paid',
                            paymentProvider: 'mercadopago',
                            externalPaymentId: String(dataId),
                            paidAt: new Date(),
                        });
                        await applyTransition(sub.id, 'invoice_paid', {
                            provider: 'mercadopago',
                            actor: 'system:webhook-mp',
                        });
                        void emailOwnersPaymentOk(tenantId);
                    }
                }
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error('[MercadoPago Webhook] Error:', err);
        res.status(500).json({ error: 'Webhook processing error' });
    }
});

export { router as billingRouter };
