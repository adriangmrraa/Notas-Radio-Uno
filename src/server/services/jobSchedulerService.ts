import type { Server } from 'socket.io';
import { db } from '../db/index.js';
import { detectLiveStream } from './liveDetectorService.js';
import { AutoPipeline } from './pipelineService.js';
import { jobNotify } from './notificationService.js';
import { trackPipelineMinutes, trackPublication } from './usageTracker.js';
import { scheduledJobs, jobExecutions } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

const MAX_RETRY_ATTEMPTS = 15; // 15 x 2min = 30 min window
const RETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_CONCURRENT_JOBS = 5;

// Active job pipelines — separate from manual pipeline instances
const activeJobs: Map<string, { pipeline: AutoPipeline; executionId: string; startTime: Date; timeoutHandle: ReturnType<typeof setTimeout> }> = new Map();

// Retry state per job
const retryState: Map<string, { attempts: number; handle: ReturnType<typeof setTimeout> }> = new Map();

let ioRef: Server;
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Initialize the job scheduler. Checks every 60 seconds for jobs to run.
 */
export function initJobScheduler(io: Server) {
    ioRef = io;

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
 * today's job-local date).
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
 * Main loop: find jobs that should run NOW and start them.
 * Day / startTime / dedup are all evaluated in `job.timezone`.
 */
async function checkAndRunJobs() {
    const now = new Date();

    // Get active jobs that match current time and day
    const jobs = await db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.isActive, true));

    for (const job of jobs) {
        // Skip if already running or retrying
        if (activeJobs.has(job.id) || retryState.has(job.id)) continue;

        // Skip if max concurrent reached
        if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
            console.log(`[JobScheduler] Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached, skipping ${job.name}`);
            break;
        }

        const jobTz = resolveJobTimezone(job.timezone);
        const local = getJobLocalParts(now, jobTz);

        if (job.scheduleType === 'one_time') {
            // one_time: fires only on its scheduledDate (job-local date)
            if (!job.scheduledDate) continue;
            if (local.date < job.scheduledDate) continue; // not yet
            if (local.date > job.scheduledDate) {
                // Past date that never ran — mark expired so it stops evaluating
                console.log(`[JobScheduler] one_time job '${job.name}' expired (scheduledDate ${job.scheduledDate} < ${local.date} ${jobTz})`);
                await db.update(scheduledJobs)
                    .set({ isActive: false, lastRunStatus: 'expired' })
                    .where(eq(scheduledJobs.id, job.id));
                continue;
            }
            if (job.lastRunAt) continue; // already ran — one_time never repeats
        } else {
            // recurring: check day-of-week in the job's timezone
            const daysOfWeek = (job.daysOfWeek as number[]) || [];
            if (daysOfWeek.length > 0 && !daysOfWeek.includes(local.day)) continue;
        }

        // Check time match (exact minute, in the job's timezone)
        if (job.startTime !== local.time) continue;

        // Dedup: "already ran today" = lastRunAt's job-local date == today's job-local date
        if (job.lastRunAt && job.scheduleType === 'recurring') {
            const lastRunLocalDate = getJobLocalParts(new Date(job.lastRunAt), jobTz).date;
            if (lastRunLocalDate === local.date) {
                continue; // Already ran today (job-local date)
            }
        }

        console.log(`[JobScheduler] Triggering job: ${job.name} (${job.id}) @ ${local.time} ${jobTz}`);
        startJobDetection(job);
    }
}

/**
 * Start the live detection + retry loop for a job.
 */
async function startJobDetection(job: any) {
    const tenantId = job.tenantId;

    await jobNotify.detecting(tenantId, job.id, job.name);

    // Create execution record
    const [execution] = await db.insert(jobExecutions).values({
        jobId: job.id,
        tenantId,
        status: 'pending',
        scheduledFor: new Date(),
    }).returning();

    attemptDetection(job, execution.id, 1);
}

/**
 * Attempt to detect a live stream. Retry if not found.
 */
async function attemptDetection(job: any, executionId: string, attempt: number) {
    const tenantId = job.tenantId;

    try {
        const result = await detectLiveStream(job.streamUrl);

        if (result.found && result.liveUrl) {
            // Live found! Clear retry state and start pipeline
            retryState.delete(job.id);

            await jobNotify.started(tenantId, job.id, job.name, result.title || undefined);

            await db.update(jobExecutions)
                .set({ status: 'running', startedAt: new Date() })
                .where(eq(jobExecutions.id, executionId));

            await db.update(scheduledJobs)
                .set({ lastRunAt: new Date(), lastRunStatus: 'running' })
                .where(eq(scheduledJobs.id, job.id));

            startJobPipeline(job, executionId, result.liveUrl);
        } else if (attempt < MAX_RETRY_ATTEMPTS) {
            // Not found — retry
            await jobNotify.retrying(tenantId, job.id, attempt, MAX_RETRY_ATTEMPTS);

            const retryHandle = setTimeout(() => {
                attemptDetection(job, executionId, attempt + 1);
            }, RETRY_INTERVAL_MS);

            retryState.set(job.id, { attempts: attempt, handle: retryHandle });
        } else {
            // Exhausted retries
            retryState.delete(job.id);
            await jobNotify.noLiveFound(tenantId, job.id, job.name);

            await db.update(jobExecutions)
                .set({
                    status: 'failed',
                    finishedAt: new Date(),
                    errorMessage: 'No se encontro live despues de 30 minutos de reintentos',
                })
                .where(eq(jobExecutions.id, executionId));

            await db.update(scheduledJobs)
                .set({ lastRunStatus: 'failed' })
                .where(eq(scheduledJobs.id, job.id));
        }
    } catch (err) {
        console.error(`[JobScheduler] Detection error for ${job.name}:`, err);
        if (attempt < MAX_RETRY_ATTEMPTS) {
            const retryHandle = setTimeout(() => attemptDetection(job, executionId, attempt + 1), RETRY_INTERVAL_MS);
            retryState.set(job.id, { attempts: attempt, handle: retryHandle });
        }
    }
}

/**
 * Start the AutoPipeline for a job in background.
 * The manual pipeline (Dashboard) is unaffected — this creates a separate instance.
 */
function startJobPipeline(job: any, executionId: string, liveUrl: string) {
    const tenantId = job.tenantId;
    const pipelineConfig = (job.pipelineConfig as Record<string, unknown>) || {};

    // Create a SEPARATE pipeline instance for the job (does NOT interfere with manual pipeline)
    const pipeline = new AutoPipeline(ioRef, tenantId);

    // Auto-stop timeout based on job duration
    const durationMs = (job.durationMinutes || 120) * 60 * 1000;
    const timeoutHandle = setTimeout(async () => {
        await stopJobPipeline(job.id, 'duration_limit');
    }, durationMs);

    activeJobs.set(job.id, { pipeline, executionId, startTime: new Date(), timeoutHandle });

    // Intercept ALL pipeline events to generate notifications.
    // Every visual canvas step becomes a notification — the user sees the full
    // pipeline progress in their NotificationBell even for background jobs.
    const originalEmit = (pipeline as any).emit.bind(pipeline);
    (pipeline as any).emit = (event: string, data: Record<string, unknown>) => {
        // Call original emit (sends to tenant Socket room — does NOT affect manual pipeline
        // because this is a separate AutoPipeline instance with its own tenantId room events)
        originalEmit(event, data);

        // Map EVERY pipeline event to a notification
        const handler: (() => Promise<unknown>) | undefined = ({
            'step':          () => jobNotify.pipelineStep(tenantId, job.id, data),
            'detail':        () => jobNotify.pipelineDetail(tenantId, job.id, data),
            'transcription': () => jobNotify.pipelineTranscription(tenantId, job.id, data),
            'note':          () => jobNotify.pipelineNote(tenantId, job.id, data),
            'flyer':         () => jobNotify.pipelineFlyer(tenantId, job.id, data),
            'published':     () => jobNotify.pipelinePublished(tenantId, job.id, data),
            'error':         () => jobNotify.pipelineError(tenantId, job.id, data),
        } as Record<string, () => Promise<unknown>>)[event];

        if (handler) handler().catch(() => {});
    };

    // Start the pipeline
    pipeline.start({
        url: liveUrl,
        tone: (pipelineConfig.tone as string) || 'formal',
        structure: (pipelineConfig.structure as string) || 'completa',
        imageModel: (pipelineConfig.imageModel as string) || 'gemini',
        segmentDuration: (pipelineConfig.segmentDuration as number) || 120,
        autoPublish: pipelineConfig.autoPublish !== false,
    }).catch(async (err) => {
        console.error(`[JobScheduler] Pipeline error for job ${job.name}:`, err);
        await stopJobPipeline(job.id, 'error', err instanceof Error ? err.message : String(err));
    });
}

/**
 * Stop a running job pipeline and record results.
 */
async function stopJobPipeline(jobId: string, reason: 'duration_limit' | 'manual' | 'error' | 'live_ended', errorMsg?: string) {
    const active = activeJobs.get(jobId);
    if (!active) return;

    const { pipeline, executionId, startTime, timeoutHandle } = active;
    clearTimeout(timeoutHandle);

    pipeline.stop();
    activeJobs.delete(jobId);

    const durationMin = Math.round((Date.now() - startTime.getTime()) / 60000);
    const publications = pipeline.publishedNotes.length;
    const status = reason === 'error' ? 'failed' : 'completed';

    // Get job info for notification
    const [job] = await db.select().from(scheduledJobs)
        .where(eq(scheduledJobs.id, jobId))
        .limit(1);
    const tenantId = job?.tenantId || '';

    await db.update(jobExecutions)
        .set({
            status,
            finishedAt: new Date(),
            publicationsGenerated: publications,
            transcriptionMinutes: String(durationMin),
            errorMessage: errorMsg,
        })
        .where(eq(jobExecutions.id, executionId));

    await db.update(scheduledJobs)
        .set({ lastRunStatus: status })
        .where(eq(scheduledJobs.id, jobId));

    // Track usage
    if (tenantId) {
        await trackPipelineMinutes(tenantId, durationMin);
        for (let i = 0; i < publications; i++) {
            await trackPublication(tenantId);
        }
    }

    // Final notification
    if (job && tenantId) {
        if (status === 'completed') {
            await jobNotify.completed(tenantId, jobId, job.name, { publications, durationMin });
        } else {
            await jobNotify.failed(tenantId, jobId, job.name, errorMsg || 'Error desconocido');
        }
    }
}

/**
 * Manually stop a job (called from API).
 */
export async function stopJob(jobId: string) {
    await stopJobPipeline(jobId, 'manual');
    // Also cancel retries
    const retry = retryState.get(jobId);
    if (retry) {
        clearTimeout(retry.handle);
        retryState.delete(jobId);
    }
}

/**
 * Get status of active jobs.
 */
export function getActiveJobIds(): string[] {
    return Array.from(activeJobs.keys());
}

export function isJobRunning(jobId: string): boolean {
    return activeJobs.has(jobId) || retryState.has(jobId);
}
