import { db } from '../db/index.js';
import { subscriptions, users, userTenants } from '../db/schema/index.js';
import { eq, and, or, isNull, lt, lte, gt, desc } from 'drizzle-orm';
import { notify } from './notificationService.js';
import { audit } from './auditService.js';
import { applyTransition } from './subscriptionMachine.js';
import { hasEvent, recordEvent } from './billingEventsService.js';
import {
    sendPaymentFailedEmail,
    sendPaymentOkEmail,
    sendTrialExpiringEmail,
    sendSubscriptionSuspendedEmail,
} from './emailService.js';
import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// dunningService — ciclo de cobranza (T-41 / spec subscription-lifecycle)
//
//   Job `dunning_cycle` (diario vía engine; también interval propio):
//     1. past_due → reintento de cobro en el provider + email intento N/max
//     2. grace_ends_at vencido → 'grace_exhausted' → suspended (datos intactos)
//     3. trialing por vencer (< TRIAL_WARN_DAYS) → email de aviso (una vez)
//
//   Toda mutación de `subscriptions.status` pasa por la máquina — acá solo se
//   actualizan contadores de dunning (dunning_attempts/last_dunning_at), que
//   no son estado de la FSM.
// ---------------------------------------------------------------------------

const DUNNING_INTERVAL_MS = Number(process.env.DUNNING_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
const MAX_DUNNING_ATTEMPTS = Number(process.env.MAX_DUNNING_ATTEMPTS ?? 3);
const TRIAL_WARN_DAYS = Number(process.env.TRIAL_WARN_DAYS ?? 2);

function getStripe(): Stripe | null {
    const key = process.env.STRIPE_SECRET_KEY;
    return key ? new Stripe(key) : null;
}

// ── Contacto de billing del tenant: el owner (fallback: primer miembro) ──────
export async function getTenantOwnerContact(tenantId: string): Promise<{ email: string; fullName: string } | null> {
    const [owner] = await db.select({ email: users.email, fullName: users.fullName })
        .from(userTenants)
        .innerJoin(users, eq(userTenants.userId, users.id))
        .where(and(
            eq(userTenants.tenantId, tenantId),
            eq(userTenants.role, 'owner'),
            eq(userTenants.status, 'active'),
        ))
        .orderBy(desc(userTenants.lastUsedAt))
        .limit(1);
    if (owner) return owner;

    const [member] = await db.select({ email: users.email, fullName: users.fullName })
        .from(userTenants)
        .innerJoin(users, eq(userTenants.userId, users.id))
        .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.status, 'active')))
        .limit(1);
    return member ?? null;
}

export type BillingEmailKind = 'payment_ok' | 'payment_failed' | 'trial_expiring' | 'suspended';

/** Email transaccional de billing al owner del tenant (PB-09). Best-effort. */
export async function sendOwnerBillingEmail(
    tenantId: string,
    kind: BillingEmailKind,
    ctx: { attempt?: number; maxAttempts?: number; daysLeft?: number } = {},
): Promise<void> {
    const contact = await getTenantOwnerContact(tenantId);
    if (!contact) {
        console.warn(`[Dunning] tenant ${tenantId} sin contacto para email '${kind}'`);
        return;
    }
    switch (kind) {
        case 'payment_ok':
            await sendPaymentOkEmail(contact.email, contact.fullName);
            break;
        case 'payment_failed':
            await sendPaymentFailedEmail(contact.email, contact.fullName, ctx.attempt ?? 1, ctx.maxAttempts ?? MAX_DUNNING_ATTEMPTS);
            break;
        case 'trial_expiring':
            await sendTrialExpiringEmail(contact.email, contact.fullName, ctx.daysLeft ?? TRIAL_WARN_DAYS);
            break;
        case 'suspended':
            await sendSubscriptionSuspendedEmail(contact.email, contact.fullName);
            break;
    }
}

// ── Reintento de cobro en el provider (best-effort, nunca rompe el ciclo) ────
async function retryProviderCharge(sub: typeof subscriptions.$inferSelect): Promise<string> {
    if (sub.paymentProvider === 'stripe' && sub.externalCustomerId) {
        const stripe = getStripe();
        if (!stripe) return 'stripe_no_config';
        try {
            const open = await stripe.invoices.list({
                customer: sub.externalCustomerId,
                status: 'open',
                limit: 1,
            });
            const invoice = open.data[0];
            if (invoice?.id) {
                await stripe.invoices.pay(invoice.id);
                return `stripe:retry invoice ${invoice.id}`;
            }
            return 'stripe:no_open_invoice';
        } catch (err) {
            return `stripe:retry_failed ${(err as Error).message}`;
        }
    }
    // MercadoPago preapproval: no hay API de reintento — MP reintenta solo.
    return `${sub.paymentProvider ?? 'none'}:provider_retries`;
}

// ── past_due: email intento N/max + reintento provider + grace→suspended ─────
async function processPastDue(now: Date): Promise<{ processed: number; suspended: number }> {
    // 1. Grace vencido → suspended (la máquina valida la arista).
    const graceExpired = await db.select().from(subscriptions)
        .where(and(
            eq(subscriptions.status, 'past_due'),
            lte(subscriptions.graceEndsAt, now),
        ));

    let suspended = 0;
    for (const sub of graceExpired) {
        try {
            const applied = await applyTransition(sub.id, 'grace_exhausted', {
                provider: 'system',
                actor: 'system:dunning_cycle',
                payload: { dunningAttempts: sub.dunningAttempts, graceEndsAt: sub.graceEndsAt },
            });
            if (applied.applied) {
                suspended++;
                sendOwnerBillingEmail(sub.tenantId, 'suspended')
                    .catch((e) => console.warn('[Dunning] suspended email:', e));
                void audit({
                    tenantId: sub.tenantId,
                    action: 'billing.suspended',
                    metadata: { subscriptionId: sub.id, graceEndsAt: sub.graceEndsAt, actor: 'system:dunning' },
                });
            }
        } catch (err) {
            console.error(`[Dunning] grace_exhausted fallo sub=${sub.id}:`, err);
        }
    }

    // 2. Reintentos + avisos en la ventana de grace.
    const cutoff = new Date(now.getTime() - DUNNING_INTERVAL_MS);
    const overdue = await db.select().from(subscriptions)
        .where(and(
            eq(subscriptions.status, 'past_due'),
            or(
                isNull(subscriptions.lastDunningAt),
                lt(subscriptions.lastDunningAt, cutoff),
            ),
            or(
                isNull(subscriptions.graceEndsAt),
                gt(subscriptions.graceEndsAt, now),
            ),
        ));

    let processed = 0;
    for (const sub of overdue) {
        try {
            const attempts = (sub.dunningAttempts ?? 0) + 1;
            await db.update(subscriptions)
                .set({ dunningAttempts: attempts, lastDunningAt: now })
                .where(eq(subscriptions.id, sub.id));

            const retryNote = await retryProviderCharge(sub);
            const lastChance = attempts >= MAX_DUNNING_ATTEMPTS;

            await notify({
                tenantId: sub.tenantId,
                type: 'billing_dunning',
                title: lastChance ? 'Último aviso de pago' : 'Pago pendiente',
                message: lastChance
                    ? 'No pudimos cobrar tu suscripción. Es el último aviso antes de la suspensión del servicio.'
                    : `No pudimos cobrar tu suscripción (intento ${attempts}/${MAX_DUNNING_ATTEMPTS}). Actualizá tu medio de pago.`,
                icon: '💳',
                metadata: { attempts, maxAttempts: MAX_DUNNING_ATTEMPTS, lastChance },
            });
            sendOwnerBillingEmail(sub.tenantId, 'payment_failed', { attempt: attempts, maxAttempts: MAX_DUNNING_ATTEMPTS })
                .catch((e) => console.warn('[Dunning] payment_failed email:', e));

            void audit({
                tenantId: sub.tenantId,
                action: 'billing.dunning_notice',
                metadata: { attempts, maxAttempts: MAX_DUNNING_ATTEMPTS, graceEndsAt: sub.graceEndsAt, providerRetry: retryNote },
            });
            processed++;
        } catch (err) {
            console.error(`[Dunning] error en tenant ${sub.tenantId}:`, err);
        }
    }
    return { processed, suspended };
}

// ── Trials por vencer → email de aviso (una sola vez por trial) ──────────────
async function processTrialsExpiring(now: Date): Promise<number> {
    const warnUntil = new Date(now.getTime() + TRIAL_WARN_DAYS * 24 * 60 * 60 * 1000);
    const expiring = await db.select().from(subscriptions)
        .where(and(
            eq(subscriptions.status, 'trialing'),
            gt(subscriptions.trialEndsAt, now),
            lte(subscriptions.trialEndsAt, warnUntil),
        ));

    let sent = 0;
    for (const sub of expiring) {
        try {
            // Dedup: un solo aviso por sub+trialEnd (append-only log como flag).
            const dedupId = `system:trial_expiring:${sub.id}`;
            if (await hasEvent(dedupId)) continue;
            const daysLeft = Math.max(1, Math.ceil((sub.trialEndsAt!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
            const rec = await recordEvent({
                tenantId: sub.tenantId,
                subscriptionId: sub.id,
                type: 'trial_expiring_notice',
                provider: 'system',
                externalId: dedupId,
                payload: { daysLeft },
            });
            if (!rec.inserted) continue;
            await sendOwnerBillingEmail(sub.tenantId, 'trial_expiring', { daysLeft });
            sent++;
        } catch (err) {
            console.warn(`[Dunning] trial_expiring sub=${sub.id}:`, err);
        }
    }
    return sent;
}

// ── Trials vencidos → expired (red de seguridad — requireActiveSubscription
//    y getMe también disparan la transición en el request path) ───────────────
async function processTrialsExpired(now: Date): Promise<number> {
    const expired = await db.select().from(subscriptions)
        .where(and(
            eq(subscriptions.status, 'trialing'),
            lte(subscriptions.trialEndsAt, now),
        ));
    let count = 0;
    for (const sub of expired) {
        try {
            const applied = await applyTransition(sub.id, 'trial_expired', {
                provider: 'system',
                actor: 'system:dunning_cycle',
            });
            if (applied.applied) count++;
        } catch (err) {
            console.warn(`[Dunning] trial_expired sub=${sub.id}:`, err);
        }
    }
    return count;
}

// ── Ciclo completo ────────────────────────────────────────────────────────────
export async function handleDunningCycle(_payload: Record<string, unknown> = {}): Promise<{
    processed: number; suspended: number; trialNotices: number; trialExpired: number;
}> {
    const now = new Date();
    const { processed, suspended } = await processPastDue(now);
    const trialNotices = await processTrialsExpiring(now);
    const trialExpired = await processTrialsExpired(now);

    const total = processed + suspended + trialNotices + trialExpired;
    if (total > 0) {
        console.log(`[Dunning] ciclo — ${processed} avisos, ${suspended} suspended, ${trialNotices} trial warnings, ${trialExpired} trials expired`);
    }
    return { processed, suspended, trialNotices, trialExpired };
}
