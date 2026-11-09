import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { PreApproval, Payment } from 'mercadopago';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwner } from '../middleware/authz.js';
import { auditFromRequest, recordAuditEvent, AUDIT_ACTIONS } from '../services/auditService.js';
import { getQuotaStatus } from '../services/transmissionMeteringService.js';
import { getStripe, getMercadoPago } from '../services/billingProviders.js';
import {
    dedupeBillingEvent,
    tagBillingEventTenant,
    paymentRecoveryFields,
    changePlan,
    reactivateSubscription,
} from '../services/billingService.js';
import { listAddons, createAddonCheckout, applyAddonPurchase } from '../services/addonService.js';
import { AppError } from '../lib/errors.js';
import { plans, subscriptions, usageRecords, invoices, addonPurchases } from '../db/schema/index.js';
import { users } from '../db/schema/index.js';
import { eq, and, desc, or } from 'drizzle-orm';

const router = Router();

/** Mapea AppError a respuesta HTTP; el resto son 500 genéricos. */
function respondError(res: Response, err: unknown, fallback: string): void {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
    }
    console.error('[Billing]', fallback, err);
    res.status(500).json({ error: fallback });
}

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
            .where(eq(subscriptions.tenantId, req.auth!.tenantId))
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
                await db.update(subscriptions)
                    .set({ status: 'expired' })
                    .where(eq(subscriptions.id, subscription.id));
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
                limits: {
                    maxPipelineHoursPerMonth: plan.maxPipelineHoursPerMonth,
                    maxPublicationsPerMonth: plan.maxPublicationsPerMonth,
                    maxScheduledJobs: plan.maxScheduledJobs,
                    maxCustomAgents: plan.maxCustomAgents,
                    maxTeamMembers: plan.maxTeamMembers,
                    maxConnectedPlatforms: plan.maxConnectedPlatforms,
                    maxStorageGb: plan.maxStorageGb,
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
// GET /api/billing/usage — Auth required
// ---------------------------------------------------------------------------
router.get('/usage', requireAuth, async (req: Request, res: Response) => {
    try {
        const now = new Date();
        const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

        let [usage] = await db.select().from(usageRecords)
            .where(and(
                eq(usageRecords.tenantId, req.auth!.tenantId),
                eq(usageRecords.periodStart, periodStart)
            ))
            .limit(1);

        if (!usage) {
            [usage] = await db.insert(usageRecords).values({
                tenantId: req.auth!.tenantId,
                periodStart,
            }).returning();
        }

        res.json({
            pipelineHoursUsed: Number(usage.pipelineHoursUsed),
            publicationsCount: usage.publicationsCount,
            transcriptionMinutes: Number(usage.transcriptionMinutes),
            aiTokensUsed: Number(usage.aiTokensUsed),
            storageUsedMb: Number(usage.storageUsedMb),
            periodStart: usage.periodStart,
        });
    } catch (err) {
        console.error('[Billing] Error fetching usage:', err);
        res.status(500).json({ error: 'Error al obtener uso' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/billing/quota — Estado de transmisiones del ciclo vigente
// ---------------------------------------------------------------------------
router.get('/quota', requireAuth, async (req: Request, res: Response) => {
    try {
        res.json(await getQuotaStatus(req.auth!.tenantId));
    } catch (err) {
        console.error('[Billing] Error fetching quota:', err);
        res.status(500).json({ error: 'Error al obtener cuota de transmisiones' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/billing/invoices — Auth required
// ---------------------------------------------------------------------------
router.get('/invoices', requireAuth, async (req: Request, res: Response) => {
    try {
        const allInvoices = await db.select().from(invoices)
            .where(eq(invoices.tenantId, req.auth!.tenantId))
            .orderBy(desc(invoices.createdAt))
            .limit(50);
        res.json(allInvoices);
    } catch (err) {
        console.error('[Billing] Error fetching invoices:', err);
        res.status(500).json({ error: 'Error al obtener facturas' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/checkout — Auth required
// ---------------------------------------------------------------------------
router.post('/checkout', requireAuth, requireOwner, async (req: Request, res: Response) => {
    try {
        const { planName, billingPeriod = 'monthly', provider = 'stripe' } = req.body;

        const [plan] = await db.select().from(plans)
            .where(eq(plans.name, planName))
            .limit(1);
        if (!plan) {
            res.status(400).json({ error: 'Plan no encontrado' });
            return;
        }

        const [user] = await db.select({ email: users.email }).from(users)
            .where(eq(users.id, req.auth!.userId))
            .limit(1);

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

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

            void auditFromRequest(req, AUDIT_ACTIONS.BILLING_CHECKOUT, {
                entityType: 'plan',
                entityId: plan.id,
                metadata: { planName: plan.name, billingPeriod, provider },
            });

            const session = await stripe.checkout.sessions.create({
                mode: 'subscription',
                customer_email: user?.email,
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: `${frontendUrl}/billing?status=success&provider=stripe`,
                cancel_url: `${frontendUrl}/billing?status=cancel`,
                metadata: {
                    kind: 'subscription',
                    tenantId: req.auth!.tenantId,
                    planName: plan.name,
                    billingPeriod,
                },
            });

            res.json({
                checkoutUrl: session.url,
                sessionId: session.id,
                provider: 'stripe',
            });
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
                    back_url: `${frontendUrl}/billing?status=success&provider=mercadopago`,
                },
            });

            res.json({
                checkoutUrl: result.init_point,
                preapprovalId: result.id,
                provider: 'mercadopago',
            });
        } else {
            res.status(400).json({ error: 'Provider no soportado' });
        }
    } catch (err) {
        console.error('[Billing] Checkout error:', err);
        res.status(500).json({ error: 'Error al crear checkout' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/billing/addons — Catálogo de add-ons comprables (+N transmisiones)
// ---------------------------------------------------------------------------
router.get('/addons', requireAuth, async (req: Request, res: Response) => {
    try {
        const [addonList, quota] = await Promise.all([
            listAddons(),
            getQuotaStatus(req.auth!.tenantId),
        ]);
        res.json({ addons: addonList, usageCycleId: quota.usageCycleId });
    } catch (err) {
        respondError(res, err, 'Error al obtener add-ons');
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/addons/checkout — Owner: compra un add-on de transmisiones
// ---------------------------------------------------------------------------
router.post('/addons/checkout', requireAuth, requireOwner, async (req: Request, res: Response) => {
    try {
        const { addonName, provider = 'stripe' } = req.body ?? {};
        if (typeof addonName !== 'string' || !addonName) {
            res.status(400).json({ error: 'addonName requerido' });
            return;
        }
        if (provider !== 'stripe' && provider !== 'mercadopago') {
            res.status(400).json({ error: 'provider inválido' });
            return;
        }

        const [user] = await db.select({ email: users.email }).from(users)
            .where(eq(users.id, req.auth!.userId)).limit(1);

        void auditFromRequest(req, AUDIT_ACTIONS.BILLING_CHECKOUT, {
            entityType: 'addon_purchase',
            metadata: { addonName, provider },
        });

        res.json(await createAddonCheckout({
            tenantId: req.auth!.tenantId,
            addonName,
            provider,
            actorUserId: req.auth!.userId,
            payerEmail: user?.email ?? null,
        }));
    } catch (err) {
        respondError(res, err, 'Error al crear checkout de add-on');
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/cancel — Auth required
// ---------------------------------------------------------------------------
router.post('/cancel', requireAuth, requireOwner, async (req: Request, res: Response) => {
    try {
        const [subscription] = await db.select().from(subscriptions)
            .where(eq(subscriptions.tenantId, req.auth!.tenantId))
            .limit(1);

        if (!subscription) {
            res.status(404).json({ error: 'No hay suscripcion activa' });
            return;
        }

        await db.update(subscriptions)
            .set({
                cancelAtPeriodEnd: true,
                canceledAt: new Date(),
            })
            .where(eq(subscriptions.id, subscription.id));

        // Cancel on Stripe if applicable
        if (subscription.paymentProvider === 'stripe' && subscription.externalSubscriptionId) {
            const stripe = getStripe();
            if (stripe) {
                await stripe.subscriptions.update(subscription.externalSubscriptionId, {
                    cancel_at_period_end: true,
                });
            }
        }

        // MercadoPago: el preapproval se cancela en el provider; la suscripción
        // local queda activa hasta fin de ciclo y el lifecycle la cierra.
        if (subscription.paymentProvider === 'mercadopago' && subscription.externalSubscriptionId) {
            const mpConfig = getMercadoPago();
            if (mpConfig) {
                try {
                    await new PreApproval(mpConfig).update({
                        id: subscription.externalSubscriptionId,
                        body: { status: 'cancelled' },
                    });
                } catch (err) {
                    console.error('[MercadoPago] No se pudo cancelar el preapproval:', err);
                }
            }
        }

        void auditFromRequest(req, AUDIT_ACTIONS.BILLING_PLAN_CHANGED, {
            entityType: 'subscription',
            entityId: subscription.id,
            metadata: { action: 'cancel_at_period_end' },
        });

        res.json({ message: 'Suscripcion cancelada al final del periodo' });
    } catch (err) {
        console.error('[Billing] Cancel error:', err);
        res.status(500).json({ error: 'Error al cancelar suscripcion' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/change-plan — Owner: cambia el plan de la suscripción
// ---------------------------------------------------------------------------
const changePlanSchema = z.object({
    planName: z.string().min(1),
    billingPeriod: z.enum(['monthly', 'yearly']).default('monthly'),
    provider: z.enum(['stripe', 'mercadopago']).optional(),
});

router.post('/change-plan', requireAuth, requireOwner, async (req: Request, res: Response) => {
    try {
        const data = changePlanSchema.parse(req.body ?? {});

        const [user] = await db.select({ email: users.email }).from(users)
            .where(eq(users.id, req.auth!.userId)).limit(1);

        const result = await changePlan({
            tenantId: req.auth!.tenantId,
            planName: data.planName,
            billingPeriod: data.billingPeriod,
            provider: data.provider,
            actorUserId: req.auth!.userId,
            payerEmail: user?.email ?? null,
        });
        res.json(result);
    } catch (err) {
        respondError(res, err, 'Error al cambiar de plan');
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/reactivate — Owner: deshace la cancelación a fin de ciclo
// ---------------------------------------------------------------------------
router.post('/reactivate', requireAuth, requireOwner, async (req: Request, res: Response) => {
    try {
        const result = await reactivateSubscription({
            tenantId: req.auth!.tenantId,
            actorUserId: req.auth!.userId,
        });
        res.json(result);
    } catch (err) {
        respondError(res, err, 'Error al reactivar la suscripción');
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/webhook/stripe — No auth (Stripe signs it)
//   El raw body llega como Buffer: express.raw() se monta en index.ts ANTES de
//   express.json() para este path. Sin raw body la firma jamás valida.
// ---------------------------------------------------------------------------
router.post('/webhook/stripe', async (req: Request, res: Response) => {
    const stripe = getStripe();
    if (!stripe) { res.sendStatus(503); return; }

    const sig = req.headers['stripe-signature'] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) { res.sendStatus(503); return; }
    if (!Buffer.isBuffer(req.body)) {
        res.status(400).send('Webhook requires raw body');
        return;
    }

    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('[Stripe Webhook] Signature verification failed:', err);
        res.status(400).send('Webhook signature verification failed');
        return;
    }

    // Dedupe: Stripe reintenta eventos; (provider, external_event_id) es único.
    const isNew = await dedupeBillingEvent({
        provider: 'stripe',
        externalEventId: event.id,
        type: event.type,
        payload: { livemode: event.livemode },
    });
    if (!isNew) {
        res.json({ received: true, deduped: true });
        return;
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;

                // Pago único de un add-on: no es una suscripción.
                if (session.metadata?.kind === 'addon' && session.metadata.purchaseId) {
                    const result = await applyAddonPurchase({
                        purchaseId: session.metadata.purchaseId,
                        provider: 'stripe',
                        externalId: session.id,
                    });
                    if (result.applied) {
                        const [purchase] = await db.select({ tenantId: addonPurchases.tenantId })
                            .from(addonPurchases)
                            .where(eq(addonPurchases.id, session.metadata.purchaseId))
                            .limit(1);
                        if (purchase) await tagBillingEventTenant('stripe', event.id, purchase.tenantId);
                    }
                    break;
                }

                const { tenantId, planName, billingPeriod } = session.metadata || {};
                if (!tenantId || !planName) break;

                const [plan] = await db.select().from(plans)
                    .where(eq(plans.name, planName))
                    .limit(1);
                if (!plan) break;

                // El período real vive en la suscripción de Stripe (en items con
                // la API nueva); si no se puede leer, se deja NULL y el
                // lifecycle lo infiere por ciclo calendario.
                let periodEnd: Date | null = null;
                try {
                    const stripeSub = await stripe.subscriptions.retrieve(session.subscription as string);
                    const itemEnd = (stripeSub.items.data[0] as unknown as { current_period_end?: number })?.current_period_end;
                    if (itemEnd) periodEnd = new Date(itemEnd * 1000);
                } catch (err) {
                    console.error('[Stripe Webhook] No se pudo leer la suscripción para el período:', err);
                }

                await db.insert(subscriptions).values({
                    tenantId,
                    planId: plan.id,
                    status: 'active',
                    paymentProvider: 'stripe',
                    billingPeriod: billingPeriod || 'monthly',
                    externalSubscriptionId: session.subscription as string,
                    externalCustomerId: session.customer as string,
                    currentPeriodStart: new Date(),
                    currentPeriodEnd: periodEnd,
                    trialEndsAt: null,
                    cancelAtPeriodEnd: false,
                    canceledAt: null,
                    ...paymentRecoveryFields(),
                }).onConflictDoUpdate({
                    target: subscriptions.tenantId,
                    set: {
                        planId: plan.id,
                        status: 'active',
                        paymentProvider: 'stripe',
                        billingPeriod: billingPeriod || 'monthly',
                        externalSubscriptionId: session.subscription as string,
                        externalCustomerId: session.customer as string,
                        currentPeriodStart: new Date(),
                        currentPeriodEnd: periodEnd,
                        trialEndsAt: null,
                        cancelAtPeriodEnd: false,
                        canceledAt: null,
                        ...paymentRecoveryFields(),
                    },
                });
                await tagBillingEventTenant('stripe', event.id, tenantId);
                void recordAuditEvent({
                    action: AUDIT_ACTIONS.BILLING_PAYMENT_OK,
                    tenantId,
                    entityType: 'subscription',
                    metadata: { provider: 'stripe', event: 'checkout.session.completed', planName },
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

                // Pago exitoso: la suscripción vuelve a activa y se resetea dunning.
                await db.update(subscriptions)
                    .set({
                        status: 'active',
                        currentPeriodStart: stripeInvoice.period_start ? new Date(stripeInvoice.period_start * 1000) : undefined,
                        currentPeriodEnd: stripeInvoice.period_end ? new Date(stripeInvoice.period_end * 1000) : undefined,
                        ...paymentRecoveryFields(),
                    })
                    .where(eq(subscriptions.id, subscription.id));

                await tagBillingEventTenant('stripe', event.id, subscription.tenantId);
                void recordAuditEvent({
                    action: AUDIT_ACTIONS.BILLING_PAYMENT_OK,
                    tenantId: subscription.tenantId,
                    entityType: 'invoice',
                    entityId: stripeInvoice.id,
                    metadata: { provider: 'stripe', event: 'invoice.paid' },
                });
                break;
            }

            case 'invoice.payment_failed': {
                const failedInvoice = event.data.object as Stripe.Invoice;
                const custId = failedInvoice.customer as string;

                const [subscription] = await db.select().from(subscriptions)
                    .where(eq(subscriptions.externalCustomerId, custId))
                    .limit(1);
                if (!subscription) break;

                // Marca past_due y arranca la gracia si todavía no arrancó.
                // La lógica completa de dunning (reintentos, emails, suspensión)
                // la ejecuta el lifecycle service.
                const now = new Date();
                await db.update(subscriptions)
                    .set({
                        status: 'past_due',
                        pastDueSince: subscription.pastDueSince ?? now,
                        graceEndsAt: subscription.graceEndsAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
                    })
                    .where(eq(subscriptions.id, subscription.id));

                await tagBillingEventTenant('stripe', event.id, subscription.tenantId);
                void recordAuditEvent({
                    action: AUDIT_ACTIONS.BILLING_PAYMENT_FAILED,
                    tenantId: subscription.tenantId,
                    entityType: 'invoice',
                    entityId: failedInvoice.id,
                    metadata: { provider: 'stripe', event: 'invoice.payment_failed' },
                });
                break;
            }

            case 'customer.subscription.updated': {
                const stripeSub = event.data.object as Stripe.Subscription;
                const [subscription] = await db.select().from(subscriptions)
                    .where(eq(subscriptions.externalSubscriptionId, stripeSub.id))
                    .limit(1);
                if (!subscription) break;

                // Sincroniza período, cancel_at_period_end, status y plan (por
                // price id → plans.stripe_price_id_*). En la API nueva el
                // período vive en el item.
                const item = stripeSub.items.data[0] as unknown as {
                    price?: { id?: string };
                    current_period_start?: number;
                    current_period_end?: number;
                } | undefined;
                const priceId = item?.price?.id;

                const patch: Partial<typeof subscriptions.$inferInsert> = {
                    cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
                    ...(stripeSub.status === 'active' ? { status: 'active' as const } : {}),
                    ...(stripeSub.status === 'past_due' || stripeSub.status === 'unpaid' ? { status: 'past_due' as const } : {}),
                    ...(item?.current_period_start ? { currentPeriodStart: new Date(item.current_period_start * 1000) } : {}),
                    ...(item?.current_period_end ? { currentPeriodEnd: new Date(item.current_period_end * 1000) } : {}),
                };

                if (priceId) {
                    const [plan] = await db.select({ id: plans.id }).from(plans)
                        .where(or(eq(plans.stripePriceIdMonthly, priceId), eq(plans.stripePriceIdYearly, priceId)))
                        .limit(1);
                    if (plan) patch.planId = plan.id;
                }

                await db.update(subscriptions).set(patch).where(eq(subscriptions.id, subscription.id));
                await tagBillingEventTenant('stripe', event.id, subscription.tenantId);
                break;
            }

            case 'customer.subscription.deleted': {
                const deletedSub = event.data.object as Stripe.Subscription;
                const [subscription] = await db.select().from(subscriptions)
                    .where(eq(subscriptions.externalSubscriptionId, deletedSub.id))
                    .limit(1);

                await db.update(subscriptions)
                    .set({ status: 'canceled', canceledAt: new Date() })
                    .where(eq(subscriptions.externalSubscriptionId, deletedSub.id));

                if (subscription) await tagBillingEventTenant('stripe', event.id, subscription.tenantId);
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
// POST /api/billing/webhook/mercadopago — No auth
// ---------------------------------------------------------------------------
router.post('/webhook/mercadopago', async (req: Request, res: Response) => {
    try {
        const { id: notificationId, action, type, data } = req.body ?? {};

        // Dedupe por id de notificación de MP (único por envío). Si no viene,
        // cae al recurso + acción — suficiente para absorber reintentos.
        const externalEventId = notificationId != null
            ? `mp:${notificationId}`
            : `mp:${type ?? 'unknown'}:${data?.id ?? 'noid'}:${action ?? 'noaction'}`;

        const isNew = await dedupeBillingEvent({
            provider: 'mercadopago',
            externalEventId,
            type: String(type ?? 'unknown'),
            payload: { action: action ?? null },
        });
        if (!isNew) {
            res.json({ received: true, deduped: true });
            return;
        }

        if (type === 'subscription_preapproval' && data?.id) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const preApproval = new PreApproval(mpConfig);
            const result = await preApproval.get({ id: data.id });

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
                await db.insert(subscriptions).values({
                    tenantId,
                    planId: plan.id,
                    status: 'active',
                    paymentProvider: 'mercadopago',
                    billingPeriod,
                    externalSubscriptionId: String(data.id),
                    currentPeriodStart: new Date(),
                    trialEndsAt: null,
                    cancelAtPeriodEnd: false,
                    canceledAt: null,
                    ...paymentRecoveryFields(),
                }).onConflictDoUpdate({
                    target: subscriptions.tenantId,
                    set: {
                        planId: plan.id,
                        status: 'active',
                        paymentProvider: 'mercadopago',
                        billingPeriod,
                        externalSubscriptionId: String(data.id),
                        currentPeriodStart: new Date(),
                        trialEndsAt: null,
                        cancelAtPeriodEnd: false,
                        canceledAt: null,
                        ...paymentRecoveryFields(),
                    },
                });
                await tagBillingEventTenant('mercadopago', externalEventId, tenantId);
                void recordAuditEvent({
                    action: AUDIT_ACTIONS.BILLING_PAYMENT_OK,
                    tenantId,
                    entityType: 'subscription',
                    metadata: { provider: 'mercadopago', event: 'preapproval.authorized', planName },
                });
                console.log(`[MercadoPago] Subscription activated for tenant ${tenantId}`);
            } else if (mpStatus === 'paused' || mpStatus === 'cancelled') {
                await db.update(subscriptions)
                    .set({ status: 'canceled', canceledAt: new Date() })
                    .where(eq(subscriptions.tenantId, tenantId));
                await tagBillingEventTenant('mercadopago', externalEventId, tenantId);
                void recordAuditEvent({
                    action: AUDIT_ACTIONS.BILLING_PLAN_CHANGED,
                    tenantId,
                    entityType: 'subscription',
                    metadata: { provider: 'mercadopago', event: `preapproval.${mpStatus}` },
                });
            }
        }

        if (type === 'payment' && data?.id) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const payment = new Payment(mpConfig);
            const paymentData = await payment.get({ id: data.id });

            // Pago único de un add-on: external_reference = addonpurchase:{id}
            const addonMatch = paymentData.external_reference?.match(/^addonpurchase:(.+)$/);
            if (paymentData.status === 'approved' && addonMatch) {
                const purchaseId = addonMatch[1];
                const [purchase] = await db.select({ tenantId: addonPurchases.tenantId })
                    .from(addonPurchases)
                    .where(eq(addonPurchases.id, purchaseId))
                    .limit(1);

                const result = await applyAddonPurchase({
                    purchaseId,
                    provider: 'mercadopago',
                    externalId: String(data.id),
                });
                if (result.applied && purchase) {
                    await tagBillingEventTenant('mercadopago', externalEventId, purchase.tenantId);
                }
                res.json({ received: true });
                return;
            }

            if (paymentData.status === 'approved' && paymentData.external_reference) {
                const match = paymentData.external_reference.match(/^tenant_(.+?)_/);
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
                            externalPaymentId: String(data.id),
                            paidAt: new Date(),
                        });

                        // Renovación cobrada: reactiva y resetea dunning.
                        await db.update(subscriptions)
                            .set({ status: 'active', ...paymentRecoveryFields() })
                            .where(eq(subscriptions.id, sub.id));

                        await tagBillingEventTenant('mercadopago', externalEventId, tenantId);
                        void recordAuditEvent({
                            action: AUDIT_ACTIONS.BILLING_PAYMENT_OK,
                            tenantId,
                            entityType: 'invoice',
                            entityId: String(data.id),
                            metadata: { provider: 'mercadopago', event: 'payment.approved' },
                        });
                    }
                }
            } else if (paymentData.status === 'rejected' && paymentData.external_reference) {
                const match = paymentData.external_reference.match(/^tenant_(.+?)_/);
                if (match) {
                    const tenantId = match[1];
                    const [sub] = await db.select().from(subscriptions)
                        .where(eq(subscriptions.tenantId, tenantId))
                        .limit(1);
                    if (sub) {
                        const now = new Date();
                        await db.update(subscriptions)
                            .set({
                                status: 'past_due',
                                pastDueSince: sub.pastDueSince ?? now,
                                graceEndsAt: sub.graceEndsAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
                            })
                            .where(eq(subscriptions.id, sub.id));
                        await tagBillingEventTenant('mercadopago', externalEventId, tenantId);
                        void recordAuditEvent({
                            action: AUDIT_ACTIONS.BILLING_PAYMENT_FAILED,
                            tenantId,
                            entityType: 'invoice',
                            entityId: String(data.id),
                            metadata: { provider: 'mercadopago', event: 'payment.rejected' },
                        });
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
