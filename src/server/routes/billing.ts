import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { MercadoPagoConfig, PreApproval, Payment } from 'mercadopago';
import { db } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { plans, subscriptions, usageRecords, invoices } from '../db/schema/index.js';
import { users } from '../db/schema/index.js';
import { eq, and, desc } from 'drizzle-orm';

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
router.post('/checkout', requireAuth, async (req: Request, res: Response) => {
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

            const session = await stripe.checkout.sessions.create({
                mode: 'subscription',
                customer_email: user?.email,
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: `${frontendUrl}/billing?status=success&provider=stripe`,
                cancel_url: `${frontendUrl}/billing?status=cancel`,
                metadata: {
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
// POST /api/billing/cancel — Auth required
// ---------------------------------------------------------------------------
router.post('/cancel', requireAuth, async (req: Request, res: Response) => {
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

        res.json({ message: 'Suscripcion cancelada al final del periodo' });
    } catch (err) {
        console.error('[Billing] Cancel error:', err);
        res.status(500).json({ error: 'Error al cancelar suscripcion' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/billing/webhook/stripe — No auth (Stripe signs it)
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
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;
                const { tenantId, planName, billingPeriod } = session.metadata || {};
                if (!tenantId || !planName) break;

                const [plan] = await db.select().from(plans)
                    .where(eq(plans.name, planName))
                    .limit(1);
                if (!plan) break;

                await db.insert(subscriptions).values({
                    tenantId,
                    planId: plan.id,
                    status: 'active',
                    paymentProvider: 'stripe',
                    billingPeriod: billingPeriod || 'monthly',
                    externalSubscriptionId: session.subscription as string,
                    externalCustomerId: session.customer as string,
                    currentPeriodStart: new Date(),
                    trialEndsAt: null,
                    cancelAtPeriodEnd: false,
                    canceledAt: null,
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
                        trialEndsAt: null,
                        cancelAtPeriodEnd: false,
                        canceledAt: null,
                    },
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
                break;
            }

            case 'invoice.payment_failed': {
                const failedInvoice = event.data.object as Stripe.Invoice;
                const custId = failedInvoice.customer as string;

                await db.update(subscriptions)
                    .set({ status: 'past_due' })
                    .where(eq(subscriptions.externalCustomerId, custId));
                break;
            }

            case 'customer.subscription.deleted': {
                const deletedSub = event.data.object as Stripe.Subscription;
                await db.update(subscriptions)
                    .set({ status: 'canceled', canceledAt: new Date() })
                    .where(eq(subscriptions.externalSubscriptionId, deletedSub.id));
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

        // SECURITY: req.body is NEVER trusted for state mutations. Every branch
        // below re-fetches the entity from the MercadoPago API (preApproval.get /
        // payment.get) and mutates only from that verified response.

        if (type === 'subscription_preapproval' && dataId) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const preApproval = new PreApproval(mpConfig);
            const result = await preApproval.get({ id: String(dataId) });

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
                    externalSubscriptionId: String(dataId),
                    currentPeriodStart: new Date(),
                    trialEndsAt: null,
                    cancelAtPeriodEnd: false,
                    canceledAt: null,
                }).onConflictDoUpdate({
                    target: subscriptions.tenantId,
                    set: {
                        planId: plan.id,
                        status: 'active',
                        paymentProvider: 'mercadopago',
                        billingPeriod,
                        externalSubscriptionId: String(dataId),
                        currentPeriodStart: new Date(),
                        trialEndsAt: null,
                        cancelAtPeriodEnd: false,
                        canceledAt: null,
                    },
                });
                console.log(`[MercadoPago] Subscription activated for tenant ${tenantId}`);
            } else if (mpStatus === 'paused' || mpStatus === 'cancelled') {
                await db.update(subscriptions)
                    .set({ status: 'canceled', canceledAt: new Date() })
                    .where(eq(subscriptions.tenantId, tenantId));
            }
        }

        if (type === 'payment' && dataId) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const payment = new Payment(mpConfig);
            const paymentData = await payment.get({ id: String(dataId) });

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
                            externalPaymentId: String(dataId),
                            paidAt: new Date(),
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
