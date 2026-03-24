# SPEC 02: Sistema de Suscripciones y Billing (Prisma ORM)

> Suscripción obligatoria: trial gratuito → planes pagos via Stripe/MercadoPago. Sin suscripción activa = error 402.

---

## Contexto

Tras SPEC-01, la plataforma tiene auth con Prisma ORM y multi-tenancy. Esta spec agrega el sistema de pagos que bloquea el acceso si el tenant no tiene una suscripción activa. Al registrarse se crea automáticamente un trial de 7 días.

### Dependencias de SPEC anterior
- Auth system funcional (register, login, JWT) con Prisma
- PostgreSQL con models Tenant, User, Plan, Subscription, UsageRecord, Invoice (ya definidos en schema.prisma de SPEC-01)
- Middleware `requireAuth` en todas las rutas protegidas

### Schema Prisma (ya definido en SPEC-01)

Los modelos `Plan`, `Subscription`, `UsageRecord`, `Invoice` y sus enums (`SubscriptionStatus`, `InvoiceStatus`) ya están definidos en `prisma/schema.prisma`. El seed de planes se ejecuta con `npx prisma db seed`.

---

## 1. Dependencias Nuevas

```bash
npm install stripe                     # Stripe SDK
npm install mercadopago                # MercadoPago SDK (v2)
```

---

## 2. Subscription Service con Prisma

### `src/server/services/subscriptionService.ts`

```typescript
import Stripe from 'stripe';
import { prisma } from '../lib/prisma.js';
import { AppError } from './authService.js';
import { SubscriptionStatus } from '@prisma/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-12-18.acacia',
});

const TRIAL_DAYS = 7;
const FRONTEND_URL = process.env.FRONTEND_URL!;

// =============================================
// CREAR TRIAL AL REGISTRARSE
// (ya integrado en authService.register via $transaction)
// Esta función es para uso standalone si se necesita
// =============================================
export async function createTrialSubscription(tenantId: string): Promise<void> {
    const trialPlan = await prisma.plan.findUnique({ where: { name: 'trial' } });
    if (!trialPlan) throw new Error('Plan trial no encontrado. Ejecuta: npx prisma db seed');

    await prisma.subscription.create({
        data: {
            tenantId,
            planId: trialPlan.id,
            status: SubscriptionStatus.trialing,
            trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
        },
    });
}

// =============================================
// OBTENER SUSCRIPCIÓN + PLAN DEL TENANT
// =============================================
export interface SubscriptionInfo {
    id: string;
    status: string;
    planName: string;
    planDisplayName: string;
    priceUsd: number;
    billingPeriod: string | null;
    trialEndsAt: Date | null;
    trialDaysRemaining: number | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    limits: {
        maxPipelineHoursPerMonth: number | null;
        maxPublicationsPerMonth: number | null;
        maxScheduledJobs: number | null;
        maxCustomAgents: number | null;
        maxTeamMembers: number;
        maxConnectedPlatforms: number | null;
        maxStorageGb: number;
    };
    features: Record<string, boolean>;
}

export async function getSubscription(tenantId: string): Promise<SubscriptionInfo | null> {
    const sub = await prisma.subscription.findUnique({
        where: { tenantId },
        include: { plan: true },
    });

    if (!sub) return null;

    let trialDaysRemaining: number | null = null;
    let currentStatus = sub.status;

    if (sub.status === SubscriptionStatus.trialing && sub.trialEndsAt) {
        const msRemaining = sub.trialEndsAt.getTime() - Date.now();
        trialDaysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));

        if (trialDaysRemaining === 0) {
            await prisma.subscription.update({
                where: { id: sub.id },
                data: { status: SubscriptionStatus.expired },
            });
            currentStatus = SubscriptionStatus.expired;
        }
    }

    return {
        id: sub.id,
        status: currentStatus,
        planName: sub.plan.name,
        planDisplayName: sub.plan.displayName,
        priceUsd: Number(sub.plan.priceUsd),
        billingPeriod: sub.billingPeriod,
        trialEndsAt: sub.trialEndsAt,
        trialDaysRemaining,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        limits: {
            maxPipelineHoursPerMonth: sub.plan.maxPipelineHoursPerMonth,
            maxPublicationsPerMonth: sub.plan.maxPublicationsPerMonth,
            maxScheduledJobs: sub.plan.maxScheduledJobs,
            maxCustomAgents: sub.plan.maxCustomAgents,
            maxTeamMembers: sub.plan.maxTeamMembers,
            maxConnectedPlatforms: sub.plan.maxConnectedPlatforms,
            maxStorageGb: sub.plan.maxStorageGb,
        },
        features: sub.plan.features as Record<string, boolean>,
    };
}

// =============================================
// OBTENER USO DEL MES (Prisma upsert)
// =============================================
export async function getUsage(tenantId: string) {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    // Upsert: crear si no existe, devolver si existe
    const usage = await prisma.usageRecord.upsert({
        where: {
            tenantId_periodStart: { tenantId, periodStart },
        },
        update: {},  // No actualizar nada, solo devolver
        create: { tenantId, periodStart },
    });

    const sub = await getSubscription(tenantId);

    const pipelineHours = Number(usage.pipelineHoursUsed);
    const publications = usage.publicationsCount;

    return {
        period: periodStart.toISOString().slice(0, 7),
        usage: {
            pipelineHoursUsed: pipelineHours,
            publicationsCount: publications,
            transcriptionMinutes: Number(usage.transcriptionMinutes),
            aiTokensUsed: Number(usage.aiTokensUsed),
            storageUsedMb: Number(usage.storageUsedMb),
        },
        limits: {
            maxPipelineHoursPerMonth: sub?.limits.maxPipelineHoursPerMonth ?? null,
            maxPublicationsPerMonth: sub?.limits.maxPublicationsPerMonth ?? null,
        },
        percentages: {
            pipelineHours: sub?.limits.maxPipelineHoursPerMonth
                ? Math.round((pipelineHours / sub.limits.maxPipelineHoursPerMonth) * 100)
                : null,
            publications: sub?.limits.maxPublicationsPerMonth
                ? Math.round((publications / sub.limits.maxPublicationsPerMonth) * 100)
                : null,
        },
    };
}

// =============================================
// INCREMENTAR USO (Prisma upsert + increment)
// =============================================
export async function incrementUsage(
    tenantId: string,
    field: 'pipelineHoursUsed' | 'publicationsCount' | 'transcriptionMinutes' | 'aiTokensUsed',
    amount: number
): Promise<void> {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    // Prisma no soporta increment en upsert directamente,
    // así que usamos $executeRaw para atomicidad
    const fieldMap: Record<string, string> = {
        pipelineHoursUsed: 'pipeline_hours_used',
        publicationsCount: 'publications_count',
        transcriptionMinutes: 'transcription_minutes',
        aiTokensUsed: 'ai_tokens_used',
    };

    const dbField = fieldMap[field];

    await prisma.$executeRaw`
        INSERT INTO usage_records (id, tenant_id, period_start, ${prisma.$queryRawUnsafe(dbField)})
        VALUES (gen_random_uuid(), ${tenantId}::uuid, ${periodStart}::date, ${amount})
        ON CONFLICT (tenant_id, period_start)
        DO UPDATE SET ${prisma.$queryRawUnsafe(dbField)} = usage_records.${prisma.$queryRawUnsafe(dbField)} + ${amount},
                      updated_at = NOW()
    `;
}

// Alternativa type-safe con Prisma (sin raw SQL):
export async function incrementUsageSafe(
    tenantId: string,
    field: 'pipelineHoursUsed' | 'publicationsCount' | 'transcriptionMinutes' | 'aiTokensUsed',
    amount: number
): Promise<void> {
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    // Asegurar que existe el registro
    await prisma.usageRecord.upsert({
        where: { tenantId_periodStart: { tenantId, periodStart } },
        update: {},
        create: { tenantId, periodStart },
    });

    // Incrementar atómicamente
    await prisma.usageRecord.update({
        where: { tenantId_periodStart: { tenantId, periodStart } },
        data: {
            [field]: { increment: field === 'aiTokensUsed' ? BigInt(amount) : amount },
        },
    });
}

// =============================================
// VERIFICAR LÍMITES
// =============================================
export async function checkUsageLimit(
    tenantId: string,
    limitField: 'maxPipelineHoursPerMonth' | 'maxPublicationsPerMonth'
): Promise<{ allowed: boolean; current: number; limit: number | null }> {
    const sub = await getSubscription(tenantId);
    if (!sub) return { allowed: false, current: 0, limit: 0 };

    const limit = sub.limits[limitField];
    if (limit === null) return { allowed: true, current: 0, limit: null };

    const usage = await getUsage(tenantId);
    const fieldMap: Record<string, number> = {
        maxPipelineHoursPerMonth: usage.usage.pipelineHoursUsed,
        maxPublicationsPerMonth: usage.usage.publicationsCount,
    };

    const current = fieldMap[limitField] || 0;
    return { allowed: current < limit, current, limit };
}

// =============================================
// LISTAR PLANES (público)
// =============================================
export async function getPlans() {
    return prisma.plan.findMany({
        where: { isActive: true, name: { not: 'trial' } },
        orderBy: { sortOrder: 'asc' },
    });
}

// =============================================
// STRIPE: CREAR CHECKOUT SESSION
// =============================================
export async function createCheckoutSession(
    tenantId: string,
    email: string,
    planId: string,
    billingPeriod: 'monthly' | 'yearly'
) {
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new AppError('Plan no encontrado', 404);

    const priceId = billingPeriod === 'yearly'
        ? plan.stripePriceIdYearly
        : plan.stripePriceIdMonthly;

    if (!priceId) throw new AppError('Precio de Stripe no configurado para este plan', 400);

    // Buscar o crear customer
    const sub = await prisma.subscription.findUnique({ where: { tenantId } });
    let customerId = sub?.externalCustomerId;

    if (!customerId) {
        const customer = await stripe.customers.create({
            email,
            metadata: { tenantId },
        });
        customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${FRONTEND_URL}/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/billing?canceled=true`,
        metadata: { tenantId, planId, billingPeriod },
        subscription_data: { metadata: { tenantId, planId } },
    });

    return { checkoutUrl: session.url!, sessionId: session.id };
}

// =============================================
// STRIPE: WEBHOOK HANDLER (con Prisma)
// =============================================
export async function handleStripeWebhook(body: Buffer, signature: string): Promise<void> {
    const event = stripe.webhooks.constructEvent(
        body, signature, process.env.STRIPE_WEBHOOK_SECRET!
    );

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            const { tenantId, planId, billingPeriod } = session.metadata || {};
            if (!tenantId || !planId) break;

            const periodEnd = new Date();
            periodEnd.setMonth(periodEnd.getMonth() + (billingPeriod === 'yearly' ? 12 : 1));

            await prisma.subscription.update({
                where: { tenantId },
                data: {
                    planId,
                    status: SubscriptionStatus.active,
                    paymentProvider: 'stripe',
                    externalSubscriptionId: session.subscription as string,
                    externalCustomerId: session.customer as string,
                    billingPeriod: billingPeriod || 'monthly',
                    currentPeriodStart: new Date(),
                    currentPeriodEnd: periodEnd,
                    trialEndsAt: null,
                    cancelAtPeriodEnd: false,
                },
            });

            // Crear invoice
            const plan = await prisma.plan.findUnique({ where: { id: planId } });
            await prisma.invoice.create({
                data: {
                    tenantId,
                    subscriptionId: (await prisma.subscription.findUnique({ where: { tenantId } }))!.id,
                    planName: plan?.displayName,
                    amount: plan?.priceUsd ?? 0,
                    currency: 'USD',
                    status: 'paid',
                    paymentProvider: 'stripe',
                    externalPaymentId: session.payment_intent as string,
                    paidAt: new Date(),
                },
            });
            break;
        }

        case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;
            await prisma.subscription.updateMany({
                where: { externalSubscriptionId: invoice.subscription as string },
                data: { status: SubscriptionStatus.past_due },
            });
            break;
        }

        case 'customer.subscription.deleted': {
            const sub = event.data.object as Stripe.Subscription;
            await prisma.subscription.updateMany({
                where: { externalSubscriptionId: sub.id },
                data: { status: SubscriptionStatus.canceled, canceledAt: new Date() },
            });
            break;
        }
    }
}

// =============================================
// CANCELAR SUSCRIPCIÓN
// =============================================
export async function cancelSubscription(tenantId: string) {
    const sub = await prisma.subscription.findUnique({ where: { tenantId } });
    if (!sub) throw new AppError('No hay suscripción activa', 404);

    if (sub.paymentProvider === 'stripe' && sub.externalSubscriptionId) {
        await stripe.subscriptions.update(sub.externalSubscriptionId, {
            cancel_at_period_end: true,
        });
    }

    await prisma.subscription.update({
        where: { tenantId },
        data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
    });

    return { message: 'Tu suscripción se cancelará al final del periodo actual.' };
}

// =============================================
// OBTENER INVOICES
// =============================================
export async function getInvoices(tenantId: string) {
    return prisma.invoice.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 50,
    });
}
```

---

## 3. Subscription Guard Middleware (sin cambios)

El middleware `requireActiveSubscription` en `src/server/middleware/subscriptionGuard.ts` se mantiene idéntico a la spec anterior — usa `getSubscription()` y `checkUsageLimit()` del service, que ahora internamente usan Prisma. No hay queries directas en el middleware.

---

## 4. Rutas de Billing (sin cambios)

Las rutas en `src/server/routes/billing.ts` se mantienen idénticas — llaman a funciones del service que ahora usan Prisma internamente.

**Recordatorio importante para `index.ts`:**

```typescript
// Stripe webhook necesita raw body (ANTES de express.json)
app.use('/api/billing/webhook/stripe', express.raw({ type: 'application/json' }));
```

---

## 5. Integración con Registro (SPEC-01)

La creación del trial ya está integrada en `authService.register()` dentro de la `$transaction` de Prisma. No se necesita un paso separado.

---

## 6. Variables de Entorno Nuevas

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
# MP_ACCESS_TOKEN=...  (futuro)
```

---

## 7. Testing Checklist

- [ ] Al registrarse se crea subscription trial (Prisma `$transaction`)
- [ ] `GET /me` incluye subscription con trialDaysRemaining calculado
- [ ] `GET /billing/plans` devuelve 3 planes activos (excluye trial)
- [ ] `GET /billing/my-subscription` devuelve estado actual
- [ ] `GET /billing/usage` devuelve uso vs límites con upsert de Prisma
- [ ] Subscription guard bloquea con 402 cuando trial expira
- [ ] Subscription guard permite /api/auth/* y /api/billing/* sin suscripción
- [ ] `POST /billing/checkout` genera URL de Stripe
- [ ] Stripe webhook activa suscripción (update via Prisma)
- [ ] `POST /billing/cancel` cancela al final del periodo
- [ ] `incrementUsageSafe()` incrementa atómicamente con Prisma
- [ ] Pipeline no inicia si límite excedido
- [ ] Invoices se crean correctamente via Prisma
- [ ] Todos los tipos son auto-generados por Prisma (SubscriptionStatus, etc.)
