import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { MercadoPagoConfig, PreApproval, Payment } from 'mercadopago';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';

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
        const plans = await prisma.plan.findMany({
            where: { isActive: true },
            orderBy: { sortOrder: 'asc' },
        });
        res.json(plans);
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
        const subscription = await prisma.subscription.findUnique({
            where: { tenantId: req.auth!.tenantId },
            include: { plan: true },
        });

        if (!subscription) {
            res.json({ subscription: null });
            return;
        }

        let trialDaysRemaining: number | null = null;
        if (subscription.status === 'trialing' && subscription.trialEndsAt) {
            const diff = subscription.trialEndsAt.getTime() - Date.now();
            trialDaysRemaining = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
            if (trialDaysRemaining === 0) {
                await prisma.subscription.update({
                    where: { id: subscription.id },
                    data: { status: 'expired' },
                });
                subscription.status = 'expired';
            }
        }

        res.json({
            subscription: {
                id: subscription.id,
                status: subscription.status,
                planName: subscription.plan.name,
                planDisplayName: subscription.plan.displayName,
                trialEndsAt: subscription.trialEndsAt,
                trialDaysRemaining,
                currentPeriodEnd: subscription.currentPeriodEnd,
                cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                limits: {
                    maxPipelineHoursPerMonth: subscription.plan.maxPipelineHoursPerMonth,
                    maxPublicationsPerMonth: subscription.plan.maxPublicationsPerMonth,
                    maxScheduledJobs: subscription.plan.maxScheduledJobs,
                    maxCustomAgents: subscription.plan.maxCustomAgents,
                    maxTeamMembers: subscription.plan.maxTeamMembers,
                    maxConnectedPlatforms: subscription.plan.maxConnectedPlatforms,
                    maxStorageGb: subscription.plan.maxStorageGb,
                },
                features: subscription.plan.features,
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
        const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

        let usage = await prisma.usageRecord.findFirst({
            where: { tenantId: req.auth!.tenantId, periodStart },
        });

        if (!usage) {
            usage = await prisma.usageRecord.create({
                data: { tenantId: req.auth!.tenantId, periodStart },
            });
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
        const invoices = await prisma.invoice.findMany({
            where: { tenantId: req.auth!.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        res.json(invoices);
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

        const plan = await prisma.plan.findUnique({ where: { name: planName } });
        if (!plan) {
            res.status(400).json({ error: 'Plan no encontrado' });
            return;
        }

        const user = await prisma.user.findUnique({
            where: { id: req.auth!.userId },
            select: { email: true },
        });

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
        const subscription = await prisma.subscription.findUnique({
            where: { tenantId: req.auth!.tenantId },
        });

        if (!subscription) {
            res.status(404).json({ error: 'No hay suscripcion activa' });
            return;
        }

        await prisma.subscription.update({
            where: { id: subscription.id },
            data: {
                cancelAtPeriodEnd: true,
                canceledAt: new Date(),
            },
        });

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
        // For raw body, we need express.raw() on this route
        const rawBody = JSON.stringify(req.body);
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
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

                const plan = await prisma.plan.findUnique({ where: { name: planName } });
                if (!plan) break;

                await prisma.subscription.upsert({
                    where: { tenantId },
                    update: {
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
                    create: {
                        tenantId,
                        planId: plan.id,
                        status: 'active',
                        paymentProvider: 'stripe',
                        billingPeriod: billingPeriod || 'monthly',
                        externalSubscriptionId: session.subscription as string,
                        externalCustomerId: session.customer as string,
                        currentPeriodStart: new Date(),
                    },
                });
                console.log(`[Stripe] Subscription activated for tenant ${tenantId}, plan ${planName}`);
                break;
            }

            case 'invoice.paid': {
                const invoice = event.data.object as Stripe.Invoice;
                const customerId = invoice.customer as string;

                const subscription = await prisma.subscription.findFirst({
                    where: { externalCustomerId: customerId },
                });
                if (!subscription) break;

                await prisma.invoice.create({
                    data: {
                        tenantId: subscription.tenantId,
                        subscriptionId: subscription.id,
                        amount: (invoice.amount_paid || 0) / 100,
                        currency: invoice.currency?.toUpperCase() || 'USD',
                        status: 'paid',
                        paymentProvider: 'stripe',
                        externalInvoiceId: invoice.id,
                        paidAt: new Date(),
                        billingPeriodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : undefined,
                        billingPeriodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : undefined,
                    },
                });
                break;
            }

            case 'invoice.payment_failed': {
                const failedInvoice = event.data.object as Stripe.Invoice;
                const custId = failedInvoice.customer as string;

                await prisma.subscription.updateMany({
                    where: { externalCustomerId: custId },
                    data: { status: 'past_due' },
                });
                break;
            }

            case 'customer.subscription.deleted': {
                const deletedSub = event.data.object as Stripe.Subscription;
                await prisma.subscription.updateMany({
                    where: { externalSubscriptionId: deletedSub.id },
                    data: { status: 'canceled', canceledAt: new Date() },
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
// POST /api/billing/webhook/mercadopago — No auth
// ---------------------------------------------------------------------------
router.post('/webhook/mercadopago', async (req: Request, res: Response) => {
    try {
        const { type, data } = req.body;

        if (type === 'subscription_preapproval' && data?.id) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const preApproval = new PreApproval(mpConfig);
            const result = await preApproval.get({ id: data.id });

            const externalRef = result.external_reference || '';
            const match = externalRef.match(/^tenant_(.+?)_(.+?)_(.+)$/);
            if (!match) { res.json({ received: true }); return; }

            const [, tenantId, planName, billingPeriod] = match;
            const plan = await prisma.plan.findUnique({ where: { name: planName } });
            if (!plan) { res.json({ received: true }); return; }

            const mpStatus = result.status;

            if (mpStatus === 'authorized') {
                await prisma.subscription.upsert({
                    where: { tenantId },
                    update: {
                        planId: plan.id,
                        status: 'active',
                        paymentProvider: 'mercadopago',
                        billingPeriod,
                        externalSubscriptionId: String(data.id),
                        currentPeriodStart: new Date(),
                        trialEndsAt: null,
                        cancelAtPeriodEnd: false,
                        canceledAt: null,
                    },
                    create: {
                        tenantId,
                        planId: plan.id,
                        status: 'active',
                        paymentProvider: 'mercadopago',
                        billingPeriod,
                        externalSubscriptionId: String(data.id),
                        currentPeriodStart: new Date(),
                    },
                });
                console.log(`[MercadoPago] Subscription activated for tenant ${tenantId}`);
            } else if (mpStatus === 'paused' || mpStatus === 'cancelled') {
                await prisma.subscription.updateMany({
                    where: { tenantId },
                    data: { status: 'canceled', canceledAt: new Date() },
                });
            }
        }

        if (type === 'payment' && data?.id) {
            const mpConfig = getMercadoPago();
            if (!mpConfig) { res.sendStatus(503); return; }

            const payment = new Payment(mpConfig);
            const paymentData = await payment.get({ id: data.id });

            if (paymentData.status === 'approved' && paymentData.external_reference) {
                const match = paymentData.external_reference.match(/^tenant_(.+?)_/);
                if (match) {
                    const tenantId = match[1];
                    const sub = await prisma.subscription.findUnique({ where: { tenantId } });
                    if (sub) {
                        await prisma.invoice.create({
                            data: {
                                tenantId,
                                subscriptionId: sub.id,
                                amount: paymentData.transaction_amount || 0,
                                currency: 'ARS',
                                status: 'paid',
                                paymentProvider: 'mercadopago',
                                externalPaymentId: String(data.id),
                                paidAt: new Date(),
                            },
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
