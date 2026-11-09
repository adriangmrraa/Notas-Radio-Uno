import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { notify } from './notificationService.js';
import { trackPipelineMinutes, trackPublication } from './usageTracker.js';
import { scheduledJobs, jobExecutions } from '../db/schema/index.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { consume as consumeQuota } from './quotaService.js';
import { create as createTransmission, requestStop } from './transmissionService.js';
import { audit } from './auditService.js';

// ---------------------------------------------------------------------------
// jobSchedulerService — despacho cuota-aware de scheduled_jobs (T-33)
//
// Al disparar un job:
//   1. operationId = `schedjob:{jobId}:{jobLocalDate}` → quotaService.consume
//   2. SIN cuota → job_executions(status='skipped_quota') + notify paywall
//      + audit. NO se crea transmission.
//   3. CON cuota → transmission(status='waiting', source='live_capture') +
//      job_executions(transmission_id). El recorder del engine (T-22) la
//      recoge: detecta el live, graba, y al cerrar libera cuota si la
//      captura real fue < MIN_CAPTURE_MS.
//
// Este loop corre SOLO en PROCESS_ROLE=engine|combined (T-20/D1).
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_JOBS = 5;

/** Despachos activos de este proceso: jobId → {executionId, transmissionId}. */
const dispatchedJobs: Map<string, { executionId: string; transmissionId: string }> = new Map();

let ioRef: Server | null = null;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the job scheduler. Checks every 60 seconds for jobs to run.
 * Engine-only: llamado desde initEngine (o combined dev). `io` es opcional —
 * las notificaciones pasan por emitToTenant (relay interno si no hay socket).
 */
export function initJobScheduler(io?: Server | null) {
    ioRef = io ?? null;

    if (schedulerInterval) clearInterval(schedulerInterval);

    schedulerInterval = setInterval(() => {
        checkAndRunJobs().catch((err) => {
            console.error('[JobScheduler] Error in check loop:', err);
        });
    }, 60_000); // Every minute

    console.log('[JobScheduler] Initialized — checking jobs every 60s');
}

// ---------------------------------------------------------------------------
// Timezone helpers — all trigger comparisons happen in job.timezone, NOT in the
// server's local timezone (a job at 10:00 America/Argentina/Buenos_Aires must
// fire at 13:00 UTC on a UTC server, never at 10:00 UTC).
// ---------------------------------------------------------------------------

/** Returns true if `tz` is a valid IANA timezone name. */
export function isValidIanaTimezone(tz: unknown): tz is string {
    if (typeof tz !== 'string' || tz.trim().length === 0) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** Resolves a stored timezone, falling back to UTC if invalid/legacy. */
function resolveJobTimezone(tz: string | null | undefined): string {
    if (isValidIanaTimezone(tz)) return tz;
    if (tz) console.warn(`[JobScheduler] Invalid timezone '${tz}' — falling back to UTC`);
    return 'UTC';
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface JobLocalParts {
    /** 0=Sunday … 6=Saturday, in the job's timezone */
    day: number;
    /** 'HH:MM' 24h, in the job's timezone */
    time: string;
    /** 'YYYY-MM-DD' local calendar date in the job's timezone */
    date: string;
}

/**
 * Decomposes `date` into day-of-week, 'HH:MM' and 'YYYY-MM-DD' **in `timeZone`**.
 * Used both for the trigger check (against `now`) and for dedup (against
 * `lastRunAt` — a job "already ran today" iff lastRunAt's job-local date equals
 * today's job-local date). The same `date` feeds the quota operationId.
 */
function getJobLocalParts(date: Date, timeZone: string): JobLocalParts {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return {
        day: WEEKDAY_TO_INDEX[get('weekday')] ?? 0,
        time: `${get('hour')}:${get('minute')}`,
        date: `${get('year')}-${get('month')}-${get('day')}`,
    };
}

/**
 * Main loop: find jobs that should run NOW and dispatch them.
 * Day / startTime / dedup are all evaluated in `job.timezone`.
 */
async function checkAndRunJobs() {
    const now = new Date();

    const jobs = await db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.isActive, true));

    for (const job of jobs) {
        // Skip if already dispatched in this process
        if (dispatchedJobs.has(job.id)) continue;

        if (dispatchedJobs.size >= MAX_CONCURRENT_JOBS) {
            console.log(`[JobScheduler] Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached, skipping ${job.name}`);
            break;
        }

        const jobTz = resolveJobTimezone(job.timezone);
        const local = getJobLocalParts(now, jobTz);

        if (job.scheduleType === 'one_time') {
            if (!job.scheduledDate) continue;
            if (local.date < job.scheduledDate) continue;
            if (local.date > job.scheduledDate) {
                console.log(`[JobScheduler] one_time job '${job.name}' expired (scheduledDate ${job.scheduledDate} < ${local.date} ${jobTz})`);
                await db.update(scheduledJobs)
                    .set({ isActive: false, lastRunStatus: 'expired' })
                    .where(eq(scheduledJobs.id, job.id));
                continue;
            }
            if (job.lastRunAt) continue;
        } else {
            const daysOfWeek = (job.daysOfWeek as number[]) || [];
            if (daysOfWeek.length > 0 && !daysOfWeek.includes(local.day)) continue;
        }

        if (job.startTime !== local.time) continue;

        if (job.lastRunAt && job.scheduleType === 'recurring') {
            const lastRunLocalDate = getJobLocalParts(new Date(job.lastRunAt), jobTz).date;
            if (lastRunLocalDate === local.date) continue;
        }

        console.log(`[JobScheduler] Dispatching job: ${job.name} (${job.id}) @ ${local.time} ${jobTz}`);
        await dispatchJob(job, local.date, now);
    }
}

// ---------------------------------------------------------------------------
// T-33: dispatch cuota-aware.
// operationId = schedjob:{jobId}:{jobLocalDate} — idempotente por día de job.
// ---------------------------------------------------------------------------
async function dispatchJob(
    job: typeof scheduledJobs.$inferSelect,
    jobLocalDate: string,
    now: Date,
): Promise<void> {
    const tenantId = job.tenantId;
    const operationId = `schedjob:${job.id}:${jobLocalDate}`;

    // ── 1. Reserva de cuota ANTES de crear nada ────────────────────────────
    const quota = await consumeQuota(tenantId, operationId, 'transmission');

    if (!quota.allowed) {
        // skipped_quota: ejecución registrada + notificación paywall + audit.
        const [execution] = await db.insert(jobExecutions).values({
            jobId: job.id,
            tenantId,
            status: 'skipped_quota',
            scheduledFor: now,
            startedAt: now,
            finishedAt: now,
            errorMessage: `Cuota de transmisiones agotada (${quota.count}/${quota.effectiveLimit} en ${quota.period})`,
        }).returning();

        await db.update(scheduledJobs)
            .set({ lastRunAt: now, lastRunStatus: 'skipped_quota' })
            .where(eq(scheduledJobs.id, job.id));

        await notify({
            tenantId,
            jobId: job.id,
            type: 'quota_exceeded',
            title: `Sin cuota: "${job.name}" no se ejecutó`,
            message: `Límite del plan alcanzado (${quota.count}/${quota.effectiveLimit} transmisiones en ${quota.period}). Mejorá tu plan para seguir transmitiendo.`,
            icon: '🔒',
            metadata: { paywall: true, executionId: execution.id, operationId, limit: quota.effectiveLimit, count: quota.count, period: quota.period },
        });

        void audit({
            tenantId,
            action: 'scheduler.skipped_quota',
            metadata: { jobId: job.id, jobName: job.name, executionId: execution.id, operationId, count: quota.count, limit: quota.effectiveLimit, period: quota.period },
        });

        // T-40/T-41: si el tenant está en trial y agotó sus transmisiones de
        // cortesía → la suscripción pasa a 'expired' vía máquina (paywall).
        try {
            const { getSubscriptionByTenant, applyTransition } = await import('./subscriptionMachine.js');
            const sub = await getSubscriptionByTenant(tenantId);
            if (sub?.status === 'trialing') {
                await applyTransition(sub.id, 'trial_quota_exhausted', {
                    provider: 'system',
                    actor: 'system:jobScheduler',
                });
            }
        } catch (err) {
            console.warn('[JobScheduler] trial_quota_exhausted transition:', err);
        }

        console.log(`[JobScheduler] '${job.name}' skipped_quota (${quota.count}/${quota.effectiveLimit})`);
        return;
    }

    // ── 2. Cuota reservada → transmission waiting + ejecución vinculada ────
    const tx = await createTransmission({
        tenantId,
        source: 'live_capture',
        programId: job.programId ?? null,
        scheduledJobId: job.id,
        streamUrl: job.streamUrl,
        durationMinutes: job.durationMinutes,
        operationId,
        pipelineConfig: (job.pipelineConfig as Record<string, unknown>) ?? {},
        initialStatus: 'waiting',
    });

    const [execution] = await db.insert(jobExecutions).values({
        jobId: job.id,
        tenantId,
        status: 'running',
        scheduledFor: now,
        startedAt: now,
        transmissionId: tx.id,
    }).returning();

    await db.update(scheduledJobs)
        .set({ lastRunAt: now, lastRunStatus: 'running' })
        .where(eq(scheduledJobs.id, job.id));

    dispatchedJobs.set(job.id, { executionId: execution.id, transmissionId: tx.id });

    await notify({
        tenantId,
        jobId: job.id,
        type: 'job_started',
        title: `Job "${job.name}" despachado`,
        message: 'Transmisión en espera — el recorder busca el live',
        icon: '🚀',
        metadata: { transmissionId: tx.id, executionId: execution.id, operationId },
    });
    void audit({
        tenantId,
        action: 'scheduler.dispatched',
        metadata: { jobId: job.id, transmissionId: tx.id, executionId: execution.id, operationId },
    });
}

// ---------------------------------------------------------------------------
// stop / estado — usado por routes/jobs.ts
// ---------------------------------------------------------------------------

/** Cancela la transmisión despachada por este job (si sigue viva). */
export async function stopJob(jobId: string) {
    const active = dispatchedJobs.get(jobId);
    if (active) {
        try {
            const [exec] = await db.select({ tenantId: jobExecutions.tenantId })
                .from(jobExecutions).where(eq(jobExecutions.id, active.executionId)).limit(1);
            if (exec) await requestStop(exec.tenantId, active.transmissionId);
        } catch (err) {
            console.warn(`[JobScheduler] stopJob ${jobId}:`, err instanceof Error ? err.message : err);
        }
        dispatchedJobs.delete(jobId);
        return;
    }

    // Proceso reiniciado: buscar la ejecución running del job y cancelar su tx.
    const [execution] = await db.select().from(jobExecutions)
        .where(and(eq(jobExecutions.jobId, jobId), inArray(jobExecutions.status, ['pending', 'running'])))
        .orderBy(desc(jobExecutions.createdAt))
        .limit(1);
    if (execution?.transmissionId) {
        try {
            await requestStop(execution.tenantId, execution.transmissionId);
        } catch (err) {
            console.warn(`[JobScheduler] stopJob ${jobId} (db):`, err instanceof Error ? err.message : err);
        }
    } else if (execution) {
        await db.update(jobExecutions)
            .set({ status: 'failed', finishedAt: new Date(), errorMessage: 'Detenido manualmente' })
            .where(eq(jobExecutions.id, execution.id));
    }
}

/** IDs de jobs con despacho activo EN ESTE proceso. */
export function getActiveJobIds(): string[] {
    return Array.from(dispatchedJobs.keys());
}

export function isJobRunning(jobId: string): boolean {
    return dispatchedJobs.has(jobId);
}

// ---------------------------------------------------------------------------
// Utilidad de tracking usada históricamente al cerrar pipelines (se conserva
// para callers existentes de routes/jobs.ts; el cierre real lo hace la tx).
// ---------------------------------------------------------------------------
export async function trackJobCompletion(tenantId: string, durationMin: number, publications: number): Promise<void> {
    await trackPipelineMinutes(tenantId, durationMin);
    for (let i = 0; i < publications; i++) {
        await trackPublication(tenantId);
    }
}
