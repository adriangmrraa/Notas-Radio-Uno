import type { Server } from 'socket.io';
import { prisma } from '../lib/prisma.js';
import { detectLiveStream } from './liveDetectorService.js';
import { AutoPipeline } from './pipelineService.js';
import { jobNotify } from './notificationService.js';
import { trackPipelineMinutes, trackPublication } from './usageTracker.js';

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

/**
 * Main loop: find jobs that should run NOW and start them.
 */
async function checkAndRunJobs() {
    const now = new Date();
    const currentDay = now.getDay(); // 0=Sunday
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Get active jobs that match current time and day
    const jobs = await prisma.scheduledJob.findMany({
        where: { isActive: true },
    });

    for (const job of jobs) {
        // Skip if already running or retrying
        if (activeJobs.has(job.id) || retryState.has(job.id)) continue;

        // Skip if max concurrent reached
        if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
            console.log(`[JobScheduler] Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached, skipping ${job.name}`);
            break;
        }

        // Check day match
        const daysOfWeek = (job.daysOfWeek as number[]) || [];
        if (daysOfWeek.length > 0 && !daysOfWeek.includes(currentDay)) continue;

        // Check time match (exact minute)
        if (job.startTime !== currentTime) continue;

        // Check if already ran today (prevent double-runs)
        if (job.lastRunAt) {
            const lastRun = new Date(job.lastRunAt);
            if (lastRun.toDateString() === now.toDateString() && job.scheduleType === 'recurring') {
                continue; // Already ran today
            }
        }

        console.log(`[JobScheduler] Triggering job: ${job.name} (${job.id})`);
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
    const execution = await prisma.jobExecution.create({
        data: {
            jobId: job.id,
            tenantId,
            status: 'pending',
            scheduledFor: new Date(),
        },
    });

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

            await prisma.jobExecution.update({
                where: { id: executionId },
                data: { status: 'running', startedAt: new Date() },
            });

            await prisma.scheduledJob.update({
                where: { id: job.id },
                data: { lastRunAt: new Date(), lastRunStatus: 'running' },
            });

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

            await prisma.jobExecution.update({
                where: { id: executionId },
                data: { status: 'failed', finishedAt: new Date(), errorMessage: 'No se encontro live despues de 30 minutos de reintentos' },
            });

            await prisma.scheduledJob.update({
                where: { id: job.id },
                data: { lastRunStatus: 'failed' },
            });
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
    const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    const tenantId = job?.tenantId || '';

    await prisma.jobExecution.update({
        where: { id: executionId },
        data: {
            status,
            finishedAt: new Date(),
            publicationsGenerated: publications,
            transcriptionMinutes: durationMin,
            errorMessage: errorMsg,
        },
    });

    await prisma.scheduledJob.update({
        where: { id: jobId },
        data: { lastRunStatus: status },
    });

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
