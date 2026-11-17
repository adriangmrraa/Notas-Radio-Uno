import type { Server } from 'socket.io';
import { releaseStaleOperations } from './transmissionMeteringService.js';
import { evaluateTransitions } from './subscriptionLifecycleService.js';

/**
 * jobSchedulerService — scheduler de mantenimiento (Épica J / PJ-03).
 *
 * Histórico: este módulo ejecutaba `scheduled_jobs` disparando instancias de
 * AutoPipeline (motor legacy retirado en PJ-03). La agenda viva es
 * `scheduled_transmissions`, atendida por `transmissionSchedulerService`.
 *
 * Lo que queda acá es el tick de mantenimiento que el scheduler viejo también
 * hacía: liberación de reservas de cuota stale y ciclo de vida de
 * suscripciones. Es infraestructura de billing — no toca transmisiones.
 */

const MAINTENANCE_EVERY_N_TICKS = 15; // ~15 min con tick de 60s
let maintenanceCounter = MAINTENANCE_EVERY_N_TICKS - 1; // primer tick ya corre mantenimiento

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the maintenance scheduler. Checks every 60 seconds.
 * `io` se mantiene en la firma por compatibilidad con el callsite de index.ts;
 * el tick actual no emite eventos.
 */
export function initJobScheduler(_io: Server) {
    if (schedulerInterval) clearInterval(schedulerInterval);

    // Barrido de ciclo de vida de suscripciones al arrancar (try/catch: una
    // falla nunca tumba el scheduler ni el boot del server).
    evaluateTransitions().catch((err) => {
        console.error('[MaintenanceScheduler] Error en evaluateTransitions (startup):', err);
    });

    schedulerInterval = setInterval(() => {
        runMaintenanceTick().catch((err) => {
            console.error('[MaintenanceScheduler] Error in maintenance tick:', err);
        });
    }, 60_000); // Every minute

    console.log('[MaintenanceScheduler] Initialized — maintenance every ~15min');
}

/**
 * Tick de mantenimiento: cada MAINTENANCE_EVERY_N_TICKS ticks libera reservas
 * de cuota stale y evalúa transiciones de ciclo de vida de suscripciones
 * (trials vencidos, gracia agotada, cancelaciones a fin de período,
 * pendingPlan de MP). Todo en try/catch: nunca tumba el scheduler ni toca
 * transmisiones activas.
 */
async function runMaintenanceTick() {
    maintenanceCounter++;
    if (maintenanceCounter < MAINTENANCE_EVERY_N_TICKS) return;
    maintenanceCounter = 0;

    try {
        await releaseStaleOperations();
    } catch (err) {
        console.error('[MaintenanceScheduler] Error liberando reservas de cuota stale:', err);
    }
    try {
        await evaluateTransitions();
    } catch (err) {
        console.error('[MaintenanceScheduler] Error en evaluateTransitions:', err);
    }
}
