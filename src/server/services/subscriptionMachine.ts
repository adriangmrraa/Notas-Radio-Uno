import { db } from '../db/index.js';
import { subscriptions } from '../db/schema/index.js';
import type { SubscriptionStatus } from '../db/schema/enums.js';
import { eq } from 'drizzle-orm';
import { recordEvent } from './billingEventsService.js';
import { enqueue } from './jobsQueueService.js';
import { notify } from './notificationService.js';
import { audit } from './auditService.js';

// ---------------------------------------------------------------------------
// subscriptionMachine — máquina de estados de suscripción (T-39)
//
//   - `transition()` es una FUNCIÓN PURA: (status, event, ctx) →
//     {nextStatus, updates, eventType, effects} | {error}. Sin IO.
//   - `applyTransition()` es el wrapper: lee la suscripción, aplica la
//     transición, persiste campos, emite billing_event y ejecuta efectos
//     (enqueue dunning, notificaciones). TODA mutación de subscriptions.status
//     pasa por acá — nunca mutación ad-hoc (spec subscription-lifecycle).
//
//   Aristas (spec):
//     trialing  → active | expired | canceled
//     active    → past_due | canceled | suspended
//     past_due  → active | suspended | canceled
//     suspended → active | canceled
//   Edges extra documentadas: expired|canceled → active SOLO via
//   'checkout_completed' (re-suscripción: el provider confirmó pago nuevo).
// ---------------------------------------------------------------------------

export type SubscriptionEvent =
    | 'checkout_completed'     // alta/re-suscripción confirmada por provider
    | 'invoice_paid'           // renovación / recuperación de pago
    | 'payment_failed'         // cobro fallido → entra en dunning
    | 'trial_expired'          // trialEndsAt vencido sin pago
    | 'trial_quota_exhausted'  // trial consumió sus transmisiones
    | 'trial_converted'        // trial → pago (explícito)
    | 'subscription_deleted'   // provider cancela/borra la suscripción
    | 'cancel_requested'       // soft-cancel: flag hasta fin de período
    | 'plan_changed'           // cambio de plan (mismo status, nuevo planId)
    | 'grace_exhausted'        // grace_ends_at vencido sin pago
    | 'admin_suspend'          // suspensión manual de plataforma
    | 'admin_reactivate'       // reactivación manual de plataforma
    | 'reactivated';           // alias semántico de invoice_paid en past_due

export interface TransitionContext {
    /** Campos de período confirmados por el provider (renovación). */
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    /** Para plan_changed / checkout_completed. */
    planId?: string;
    billingPeriod?: string;
    /** Precio congelado de la suscripción (MRR, plan_changed, checkout). */
    frozenPrice?: string | number | null;
    frozenCurrency?: string | null;
    /** Provider refs. */
    paymentProvider?: string;
    externalSubscriptionId?: string | null;
    externalCustomerId?: string | null;
    /** Soft-cancel: motivo registrado. */
    cancelReason?: string | null;
    /** Ventana de grace en días (default GRACE_PERIOD_DAYS o 7). */
    graceDays?: number;
    /** billing_event.type a emitir (default: derivado del evento). */
    eventType?: string;
    /** external_id para dedup de webhook. */
    externalId?: string | null;
    /** actor: 'system:webhook-stripe' | admin userId… */
    actor?: string | null;
    provider?: string | null;
    payload?: Record<string, unknown>;
}

export interface SubscriptionPatch {
    status?: SubscriptionStatus;
    planId?: string;
    trialEndsAt?: Date | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    billingPeriod?: string | null;
    paymentProvider?: string;
    externalSubscriptionId?: string | null;
    externalCustomerId?: string | null;
    cancelAtPeriodEnd?: boolean;
    canceledAt?: Date | null;
    graceEndsAt?: Date | null;
    dunningAttempts?: number;
    lastDunningAt?: Date | null;
    frozenPrice?: string | null;
    frozenCurrency?: string | null;
    cancelReason?: string | null;
}

export type MachineEffect = 'enqueue_dunning' | 'notify_suspended' | 'notify_reactivated' | 'notify_expired' | 'notify_past_due';

export type TransitionResult =
    | { ok: true; nextStatus: SubscriptionStatus; updates: SubscriptionPatch; eventType: string; effects: MachineEffect[] }
    | { ok: false; reason: string };

const DEFAULT_GRACE_DAYS = Number(process.env.GRACE_PERIOD_DAYS ?? 7);

const EVENT_TO_BILLING_TYPE: Record<SubscriptionEvent, string> = {
    checkout_completed: 'charged',
    invoice_paid: 'charged',
    payment_failed: 'payment_failed',
    trial_expired: 'expired',
    trial_quota_exhausted: 'expired',
    trial_converted: 'trial_converted',
    subscription_deleted: 'canceled',
    cancel_requested: 'canceled',
    plan_changed: 'plan_changed',
    grace_exhausted: 'suspended',
    admin_suspend: 'suspended',
    admin_reactivate: 'reactivated',
    reactivated: 'reactivated',
};

/** Tabla de aristas: status actual → { evento → status destino }. */
const EDGES: Record<SubscriptionStatus, Partial<Record<SubscriptionEvent, SubscriptionStatus>>> = {
    trialing: {
        checkout_completed: 'active',
        invoice_paid: 'active',
        trial_converted: 'active',
        trial_expired: 'expired',
        trial_quota_exhausted: 'expired',
        subscription_deleted: 'canceled',
    },
    active: {
        payment_failed: 'past_due',
        subscription_deleted: 'canceled',
        admin_suspend: 'suspended',
        // Eventos que no cambian el status pero sí campos:
        invoice_paid: 'active',
        checkout_completed: 'active',
        cancel_requested: 'active',
        plan_changed: 'active',
    },
    past_due: {
        invoice_paid: 'active',
        reactivated: 'active',
        grace_exhausted: 'suspended',
        admin_suspend: 'suspended',
        subscription_deleted: 'canceled',
    },
    suspended: {
        invoice_paid: 'active',
        admin_reactivate: 'active',
        subscription_deleted: 'canceled',
    },
    expired: {
        // Re-suscripción: el provider confirmó un pago nuevo (edge documentada).
        checkout_completed: 'active',
    },
    canceled: {
        // Re-suscripción: nueva vida con checkout confirmado (edge documentada).
        checkout_completed: 'active',
    },
};

/**
 * Función pura de transición. Sin IO — testeable.
 * Devuelve el status destino + patch de campos + tipo de billing_event +
 * efectos a ejecutar por el wrapper.
 */
export function transition(
    current: SubscriptionStatus,
    event: SubscriptionEvent,
    ctx: TransitionContext = {},
): TransitionResult {
    const edge = EDGES[current]?.[event];
    if (!edge) {
        return { ok: false, reason: `Transicion invalida: ${current} --(${event})-->` };
    }

    const now = new Date();
    const graceDays = ctx.graceDays ?? DEFAULT_GRACE_DAYS;
    const updates: SubscriptionPatch = { status: edge };
    const effects: MachineEffect[] = [];
    let eventType = ctx.eventType ?? EVENT_TO_BILLING_TYPE[event];

    switch (event) {
        case 'payment_failed': {
            updates.graceEndsAt = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);
            updates.dunningAttempts = 0;
            updates.lastDunningAt = null;
            effects.push('enqueue_dunning', 'notify_past_due');
            break;
        }
        case 'invoice_paid':
        case 'reactivated':
        case 'admin_reactivate': {
            updates.graceEndsAt = null;
            updates.dunningAttempts = 0;
            updates.lastDunningAt = null;
            updates.cancelAtPeriodEnd = false;
            updates.cancelReason = null;
            if (ctx.currentPeriodStart !== undefined) updates.currentPeriodStart = ctx.currentPeriodStart;
            if (ctx.currentPeriodEnd !== undefined) updates.currentPeriodEnd = ctx.currentPeriodEnd;
            if (current === 'past_due' || current === 'suspended') {
                eventType = ctx.eventType ?? 'reactivated';
                effects.push('notify_reactivated');
            }
            break;
        }
        case 'checkout_completed': {
            updates.trialEndsAt = null;
            updates.cancelAtPeriodEnd = false;
            updates.canceledAt = null;
            updates.graceEndsAt = null;
            updates.dunningAttempts = 0;
            updates.lastDunningAt = null;
            updates.cancelReason = null;
            if (ctx.planId) updates.planId = ctx.planId;
            if (ctx.billingPeriod) updates.billingPeriod = ctx.billingPeriod;
            if (ctx.paymentProvider) updates.paymentProvider = ctx.paymentProvider;
            if (ctx.externalSubscriptionId !== undefined) updates.externalSubscriptionId = ctx.externalSubscriptionId;
            if (ctx.externalCustomerId !== undefined) updates.externalCustomerId = ctx.externalCustomerId;
            if (ctx.frozenPrice !== undefined && ctx.frozenPrice !== null) updates.frozenPrice = String(ctx.frozenPrice);
            if (ctx.frozenCurrency !== undefined) updates.frozenCurrency = ctx.frozenCurrency;
            if (ctx.currentPeriodStart !== undefined) updates.currentPeriodStart = ctx.currentPeriodStart;
            if (ctx.currentPeriodEnd !== undefined) updates.currentPeriodEnd = ctx.currentPeriodEnd;
            if (current === 'trialing') eventType = ctx.eventType ?? 'trial_converted';
            else eventType = ctx.eventType ?? 'charged';
            break;
        }
        case 'trial_converted': {
            updates.cancelAtPeriodEnd = false;
            updates.graceEndsAt = null;
            if (ctx.planId) updates.planId = ctx.planId;
            if (ctx.frozenPrice !== undefined && ctx.frozenPrice !== null) updates.frozenPrice = String(ctx.frozenPrice);
            if (ctx.frozenCurrency !== undefined) updates.frozenCurrency = ctx.frozenCurrency;
            if (ctx.currentPeriodStart !== undefined) updates.currentPeriodStart = ctx.currentPeriodStart;
            if (ctx.currentPeriodEnd !== undefined) updates.currentPeriodEnd = ctx.currentPeriodEnd;
            break;
        }
        case 'trial_expired':
        case 'trial_quota_exhausted': {
            eventType = ctx.eventType ?? 'expired';
            effects.push('notify_expired');
            break;
        }
        case 'grace_exhausted':
        case 'admin_suspend': {
            effects.push('notify_suspended');
            if (event === 'admin_suspend') eventType = ctx.eventType ?? 'admin_grant';
            break;
        }
        case 'subscription_deleted': {
            updates.canceledAt = now;
            updates.cancelAtPeriodEnd = false;
            if (ctx.cancelReason !== undefined) updates.cancelReason = ctx.cancelReason;
            updates.graceEndsAt = null;
            break;
        }
        case 'cancel_requested': {
            // Soft-cancel: el status sigue igual; el servicio corre hasta
            // currentPeriodEnd. El provider emitirá subscription_deleted.
            updates.cancelAtPeriodEnd = true;
            updates.canceledAt = now;
            if (ctx.cancelReason !== undefined) updates.cancelReason = ctx.cancelReason;
            eventType = ctx.eventType ?? 'canceled';
            break;
        }
        case 'plan_changed': {
            if (ctx.planId) updates.planId = ctx.planId;
            if (ctx.frozenPrice !== undefined && ctx.frozenPrice !== null) updates.frozenPrice = String(ctx.frozenPrice);
            if (ctx.frozenCurrency !== undefined) updates.frozenCurrency = ctx.frozenCurrency;
            if (ctx.billingPeriod) updates.billingPeriod = ctx.billingPeriod;
            break;
        }
    }

    return { ok: true, nextStatus: edge, updates, eventType, effects };
}

export interface ApplyResult {
    applied: boolean;
    reason?: string;
    previousStatus?: SubscriptionStatus;
    nextStatus?: SubscriptionStatus;
    alreadyProcessed?: boolean;
}

/**
 * Wrapper: aplica una transición sobre la suscripción persistida.
 * - Lee la fila, evalúa la máquina, persiste campos, emite billing_event
 *   (dedup por ctx.externalId) y dispara efectos (dunning, notificaciones).
 * - Transición inválida → registra el intento y NO muta (spec).
 */
export async function applyTransition(
    subscriptionId: string,
    event: SubscriptionEvent,
    ctx: TransitionContext = {},
): Promise<ApplyResult> {
    const [sub] = await db.select().from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId))
        .limit(1);
    if (!sub) return { applied: false, reason: 'Suscripcion no encontrada' };

    const current = sub.status as SubscriptionStatus;
    const result = transition(current, event, ctx);

    if (!result.ok) {
        // Rechazo explícito + registro del intento (spec: "registra el intento").
        console.warn(`[SubscriptionMachine] ${result.reason} (sub=${subscriptionId})`);
        void recordEvent({
            tenantId: sub.tenantId,
            subscriptionId: sub.id,
            type: 'transition_rejected',
            provider: ctx.provider ?? null,
            externalId: ctx.externalId ? `${ctx.externalId}:rejected` : null,
            payload: { event, from: current, reason: result.reason, actor: ctx.actor ?? null },
        });
        return { applied: false, reason: result.reason, previousStatus: current };
    }

    // Dedup de webhook: si externalId ya está en billing_events → no doble efecto.
    if (ctx.externalId) {
        const dedup = await recordEvent({
            tenantId: sub.tenantId,
            subscriptionId: sub.id,
            type: result.eventType,
            provider: ctx.provider ?? null,
            externalId: ctx.externalId,
            payload: { event, from: current, to: result.nextStatus, ...(ctx.payload ?? {}) },
        });
        if (!dedup.inserted) {
            return { applied: false, reason: 'Evento ya procesado (dedup external_id)', alreadyProcessed: true, previousStatus: current, nextStatus: result.nextStatus };
        }
    } else {
        await recordEvent({
            tenantId: sub.tenantId,
            subscriptionId: sub.id,
            type: result.eventType,
            provider: ctx.provider ?? null,
            payload: { event, from: current, to: result.nextStatus, ...(ctx.payload ?? {}) },
        });
    }

    // Persistir el patch (solo columnas presentes).
    const setData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(result.updates)) {
        if (v !== undefined) setData[k] = v;
    }
    if (Object.keys(setData).length > 0) {
        await db.update(subscriptions).set(setData).where(eq(subscriptions.id, sub.id));
    }

    // Efectos (best-effort — nunca rompen la transición ya aplicada).
    for (const effect of result.effects) {
        try {
            switch (effect) {
                case 'enqueue_dunning':
                    await enqueue('dunning_cycle', { tenantId: sub.tenantId }, {
                        tenantId: sub.tenantId,
                        dedupKey: `dunning:${sub.id}:${result.nextStatus}`,
                    });
                    break;
                case 'notify_past_due':
                    await notify({
                        tenantId: sub.tenantId,
                        type: 'billing_past_due',
                        title: 'Pago pendiente',
                        message: 'No pudimos cobrar tu suscripcion. Actualiza tu medio de pago para evitar la suspension.',
                        icon: '💳',
                    });
                    break;
                case 'notify_suspended':
                    await notify({
                        tenantId: sub.tenantId,
                        type: 'billing_suspended',
                        title: 'Suscripcion suspendida',
                        message: 'Tu suscripcion fue suspendida por falta de pago. Tus datos estan intactos — regulariza el pago para reactivar el servicio.',
                        icon: '⛔',
                    });
                    break;
                case 'notify_reactivated':
                    await notify({
                        tenantId: sub.tenantId,
                        type: 'billing_reactivated',
                        title: 'Suscripcion reactivada',
                        message: 'Tu pago fue confirmado. El acceso queda pleno nuevamente.',
                        icon: '✅',
                    });
                    break;
                case 'notify_expired':
                    await notify({
                        tenantId: sub.tenantId,
                        type: 'billing_trial_expired',
                        title: 'Tu periodo de prueba termino',
                        message: 'El trial gratuito finalizo. Elegi un plan para seguir transmitiendo.',
                        icon: '⏰',
                    });
                    break;
            }
        } catch (err) {
            console.warn(`[SubscriptionMachine] efecto '${effect}' fallo (best-effort):`, err);
        }
    }

    void audit({
        tenantId: sub.tenantId,
        action: `billing.transition`,
        metadata: { event, from: current, to: result.nextStatus, actor: ctx.actor ?? 'system' },
    });

    return { applied: true, previousStatus: current, nextStatus: result.nextStatus };
}

/** Lookup por tenant (una suscripción por tenant — unique). */
export async function getSubscriptionByTenant(tenantId: string) {
    const [sub] = await db.select().from(subscriptions)
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);
    return sub ?? null;
}
