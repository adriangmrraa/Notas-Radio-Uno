import { db } from '../db/index.js';
import { billingEvents } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// billingEventsService — log append-only de eventos de facturación (T-39)
//
//   - Append-only: JAMÁS update/delete sobre billing_events.
//   - Dedup por external_id (UNIQUE): un webhook reintentado no duplica.
//   - Tipos conocidos: trial_started, trial_converted, charged,
//     payment_failed, reactivated, plan_changed, canceled, suspended,
//     expired, addon_purchased, admin_grant, subscription_created.
// ---------------------------------------------------------------------------

export interface BillingEventInput {
    tenantId?: string | null;
    subscriptionId?: string | null;
    type: string;
    provider?: string | null;
    /** Idempotencia de webhook: el id del evento del provider (Stripe evt_*,
     *  MP data.id compuesto). Mismo external_id → dedup (no doble efecto). */
    externalId?: string | null;
    payload?: Record<string, unknown>;
}

export interface RecordEventResult {
    /** true si la fila se insertó; false si external_id ya existía (dedup). */
    inserted: boolean;
    id?: string;
}

/**
 * Inserta un billing_event. Con externalId set, ON CONFLICT DO NOTHING
 * garantiza dedup atómico (retry-safe bajo concurrencia).
 */
export async function recordEvent(input: BillingEventInput): Promise<RecordEventResult> {
    if (input.externalId) {
        const [row] = await db.insert(billingEvents).values({
            tenantId: input.tenantId ?? null,
            subscriptionId: input.subscriptionId ?? null,
            type: input.type,
            provider: input.provider ?? null,
            externalId: input.externalId,
            payload: input.payload ?? {},
        })
            .onConflictDoNothing({ target: billingEvents.externalId })
            .returning({ id: billingEvents.id });
        return { inserted: !!row, id: row?.id };
    }

    const [row] = await db.insert(billingEvents).values({
        tenantId: input.tenantId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        type: input.type,
        provider: input.provider ?? null,
        externalId: null,
        payload: input.payload ?? {},
    }).returning({ id: billingEvents.id });
    return { inserted: true, id: row?.id };
}

/** ¿Ya procesamos este evento del provider? (dedup temprano de webhooks). */
export async function hasEvent(externalId: string): Promise<boolean> {
    const [row] = await db.select({ id: billingEvents.id })
        .from(billingEvents)
        .where(eq(billingEvents.externalId, externalId))
        .limit(1);
    return !!row;
}

/** Historial del tenant (admin / detalle). */
export async function listEvents(tenantId: string, limit = 50) {
    return db.select().from(billingEvents)
        .where(eq(billingEvents.tenantId, tenantId))
        .orderBy(billingEvents.createdAt)
        .limit(limit);
}
