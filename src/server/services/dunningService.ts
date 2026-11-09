import { db } from '../db/index.js';
import { subscriptions } from '../db/schema/index.js';
import { eq, and, or, isNull, lt } from 'drizzle-orm';
import { notify } from './notificationService.js';
import { audit } from './auditService.js';

// ---------------------------------------------------------------------------
// dunningService — ciclo mínimo de dunning (T-20 startup; handler 'dunning_cycle')
//
// Recorre suscripciones en past_due cuyo último aviso supera el intervalo y:
//   - incrementa dunning_attempts + last_dunning_at
//   - notifica al tenant (recordatorio de pago)
// El engine lo corre: (a) como job 'dunning_cycle' en la cola y (b) en un
// intervalo propio que encola/ejecuta el ciclo completo.
// ---------------------------------------------------------------------------

const DUNNING_INTERVAL_MS = Number(process.env.DUNNING_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
const MAX_DUNNING_ATTEMPTS = Number(process.env.MAX_DUNNING_ATTEMPTS ?? 4);

export async function handleDunningCycle(_payload: Record<string, unknown> = {}): Promise<{ processed: number }> {
    const cutoff = new Date(Date.now() - DUNNING_INTERVAL_MS);
    const overdue = await db.select().from(subscriptions)
        .where(and(
            eq(subscriptions.status, 'past_due'),
            or(
                isNull(subscriptions.lastDunningAt),
                lt(subscriptions.lastDunningAt, cutoff),
            ),
        ));

    let processed = 0;
    for (const sub of overdue) {
        try {
            const attempts = (sub.dunningAttempts ?? 0) + 1;
            await db.update(subscriptions)
                .set({ dunningAttempts: attempts, lastDunningAt: new Date() })
                .where(eq(subscriptions.tenantId, sub.tenantId));

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
            void audit({
                tenantId: sub.tenantId,
                action: 'billing.dunning_notice',
                metadata: { attempts, maxAttempts: MAX_DUNNING_ATTEMPTS, graceEndsAt: sub.graceEndsAt },
            });
            processed++;
        } catch (err) {
            console.error(`[Dunning] error en tenant ${sub.tenantId}:`, err);
        }
    }
    if (processed > 0) console.log(`[Dunning] ciclo completado — ${processed} avisos`);
    return { processed };
}
