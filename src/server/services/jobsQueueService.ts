import { db } from '../db/index.js';
import { jobsQueue } from '../db/schema/index.js';
import { sql, eq, and } from 'drizzle-orm';
import type { JobQueueStatus } from '../db/schema/saas.js';

// ---------------------------------------------------------------------------
// jobsQueueService — cola de jobs en Postgres (D7)
// enqueue (dedup_key) → claim FOR UPDATE SKIP LOCKED → ack | retry 2^n → dead
// Workers in-process del proceso engine (PROCESS_ROLE=engine — T-20 los inicia).
// ---------------------------------------------------------------------------

export type JobType =
    | 'render_clip'
    | 'poststream_analysis'
    | 'purge_recording'
    | 'publish_job'
    | 'dunning_cycle'
    | 'dossier'
    | 'vod_ingest';

export interface EnqueueOptions {
    tenantId?: string | null;
    /** Idempotencia de enqueue: mismo dedup_key → devuelve el job existente. */
    dedupKey?: string;
    runAt?: Date;
    maxAttempts?: number;
}

export type QueueJob = typeof jobsQueue.$inferSelect;
export type ClaimedJob = QueueJob;

export type JobHandler<T = unknown> = (payload: T, job: ClaimedJob) => Promise<void>;

// Backoff exponencial: delay = BASE_DELAY_SEC * 2^attempts (60s, 120s, 240s…)
const BASE_DELAY_SEC = 30;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Enqueue — dedup por dedup_key (idempotencia de retries de webhooks/jobs)
// ---------------------------------------------------------------------------
export async function enqueue(
    type: JobType,
    payload: Record<string, unknown>,
    opts: EnqueueOptions = {},
): Promise<QueueJob> {
    const values = {
        type,
        payload,
        tenantId: opts.tenantId ?? null,
        dedupKey: opts.dedupKey ?? null,
        runAt: opts.runAt ?? new Date(),
        maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    };

    if (opts.dedupKey) {
        const [job] = await db.insert(jobsQueue)
            .values(values)
            .onConflictDoNothing({ target: jobsQueue.dedupKey })
            .returning();
        if (job) return job;
        // dedup_key ya existía → devolver el job previo (retry-safe)
        const [existing] = await db.select().from(jobsQueue)
            .where(eq(jobsQueue.dedupKey, opts.dedupKey))
            .limit(1);
        if (existing) return existing;
        throw new Error(`[JobsQueue] dedup conflict sin fila existente para key ${opts.dedupKey}`);
    }

    const [job] = await db.insert(jobsQueue).values(values).returning();
    return job;
}

// ---------------------------------------------------------------------------
// Claim — UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)
// Una sola query decide la toma: dos workers nunca agarran el mismo job.
// ---------------------------------------------------------------------------
export async function claim(workerId: string, types?: JobType[]): Promise<ClaimedJob | null> {
    const typeFilter = types && types.length > 0
        ? sql`AND "type" = ANY(${types})`
        : sql``;

    const result = await db.execute(sql`
        UPDATE "jobs_queue"
        SET "status" = 'running',
            "locked_by" = ${workerId},
            "locked_at" = now(),
            "attempts" = "attempts" + 1,
            "updated_at" = now()
        WHERE "id" = (
            SELECT "id" FROM "jobs_queue"
            WHERE "status" = 'pending' AND "run_at" <= now() ${typeFilter}
            ORDER BY "run_at", "id"
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING *
    `);

    const row = result.rows[0];
    return (row as ClaimedJob | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Ack — job completado
// ---------------------------------------------------------------------------
export async function ack(jobId: string): Promise<void> {
    await db.update(jobsQueue)
        .set({ status: 'done' })
        .where(and(eq(jobsQueue.id, jobId), eq(jobsQueue.status, 'running')));
}

// ---------------------------------------------------------------------------
// Retry / dead-letter — backoff 2^attempts; al agotar intentos → 'dead'
// ---------------------------------------------------------------------------
export async function retryOrDead(jobId: string, err: unknown): Promise<'retried' | 'dead'> {
    const message = err instanceof Error ? err.message : String(err);

    const [job] = await db.select().from(jobsQueue)
        .where(eq(jobsQueue.id, jobId))
        .limit(1);
    if (!job) return 'dead';

    if (job.attempts >= job.maxAttempts) {
        await db.update(jobsQueue)
            .set({ status: 'dead', lastError: message })
            .where(eq(jobsQueue.id, jobId));
        console.error(`[JobsQueue] job ${jobId} (${job.type}) → dead tras ${job.attempts} intentos: ${message}`);
        return 'dead';
    }

    const delaySec = BASE_DELAY_SEC * Math.pow(2, job.attempts);
    await db.update(jobsQueue)
        .set({
            status: 'pending',
            lastError: message,
            lockedBy: null,
            lockedAt: null,
            runAt: new Date(Date.now() + delaySec * 1000),
        })
        .where(eq(jobsQueue.id, jobId));
    return 'retried';
}

// ---------------------------------------------------------------------------
// Requeue manual desde dead-letter (panel admin / operador)
// ---------------------------------------------------------------------------
export async function requeueDead(jobId: string): Promise<boolean> {
    const result = await db.update(jobsQueue)
        .set({ status: 'pending', attempts: 0, runAt: new Date(), lockedBy: null, lockedAt: null })
        .where(and(eq(jobsQueue.id, jobId), eq(jobsQueue.status, 'dead')))
        .returning({ id: jobsQueue.id });
    return result.length > 0;
}

// ---------------------------------------------------------------------------
// Registry de handlers tipado por JobType
// ---------------------------------------------------------------------------
const handlers = new Map<JobType, JobHandler>();

export function registerJobHandler<T>(type: JobType, handler: JobHandler<T>): void {
    handlers.set(type, handler as JobHandler);
}

export function getJobHandler(type: JobType): JobHandler | undefined {
    return handlers.get(type);
}

// ---------------------------------------------------------------------------
// Worker loop (in-process; lo arranca el engine — nunca el api)
// ---------------------------------------------------------------------------
export interface WorkerHandle {
    workerId: string;
    stop: () => void;
}

export function startWorker(opts: {
    workerId?: string;
    types?: JobType[];
    pollIntervalMs?: number;
} = {}): WorkerHandle {
    const workerId = opts.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    let stopped = false;
    let running = false;

    const tick = async () => {
        if (stopped || running) return;
        running = true;
        try {
            // Drena la cola: procesa mientras haya jobs disponibles
            for (;;) {
                const job = await claim(workerId, opts.types);
                if (!job) break;
                const handler = handlers.get(job.type as JobType);
                if (!handler) {
                    await retryOrDead(job.id, new Error(`No handler registered for job type '${job.type}'`));
                    continue;
                }
                try {
                    await handler(job.payload, job);
                    await ack(job.id);
                } catch (err) {
                    await retryOrDead(job.id, err);
                }
            }
        } catch (err) {
            console.error(`[JobsQueue] worker ${workerId} tick error:`, err);
        } finally {
            running = false;
        }
    };

    const interval = setInterval(() => { void tick(); }, pollMs);
    void tick();
    console.log(`[JobsQueue] worker ${workerId} started (poll ${pollMs}ms, types=${opts.types?.join(',') ?? 'all'})`);

    return {
        workerId,
        stop: () => {
            stopped = true;
            clearInterval(interval);
        },
    };
}

// ---------------------------------------------------------------------------
// Listado para panel admin (jobs por estado/tipo/tenant)
// ---------------------------------------------------------------------------
export async function listJobs(filter: {
    status?: JobQueueStatus;
    type?: JobType;
    tenantId?: string;
    limit?: number;
}): Promise<QueueJob[]> {
    const conditions = [];
    if (filter.status) conditions.push(eq(jobsQueue.status, filter.status));
    if (filter.type) conditions.push(eq(jobsQueue.type, filter.type));
    if (filter.tenantId) conditions.push(eq(jobsQueue.tenantId, filter.tenantId));

    return db.select().from(jobsQueue)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(sql`${jobsQueue.createdAt} DESC`)
        .limit(filter.limit ?? 100);
}
