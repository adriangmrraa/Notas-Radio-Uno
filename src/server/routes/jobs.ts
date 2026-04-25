import { Router, Request, Response } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireActiveSubscription } from '../middleware/auth.js';
import { stopJob, isJobRunning, getActiveJobIds } from '../services/jobSchedulerService.js';
import { scheduledJobs, subscriptions, plans, jobExecutions, notifications } from '../db/schema/index.js';
import { eq, and, desc, sql } from 'drizzle-orm';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/jobs — List all scheduled jobs for tenant
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
        const jobs = await db.select().from(scheduledJobs)
            .where(eq(scheduledJobs.tenantId, req.auth!.tenantId))
            .orderBy(desc(scheduledJobs.createdAt));

        getActiveJobIds(); // called for side effects check
        const enriched = jobs.map((job) => ({
            ...job,
            isRunning: isJobRunning(job.id),
        }));

        res.json(enriched);
    } catch (err) {
        console.error('[Jobs] List error:', err);
        res.status(500).json({ error: 'Error al obtener jobs' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/jobs — Create new scheduled job
// ---------------------------------------------------------------------------
router.post('/', requireAuth, requireActiveSubscription, async (req: Request, res: Response) => {
    try {
        const tenantId = req.auth!.tenantId;
        const { name, description, streamUrl, scheduleType, daysOfWeek, startTime, durationMinutes, pipelineConfig } = req.body;

        if (!name?.trim() || !streamUrl?.trim() || !startTime) {
            res.status(400).json({ error: 'Nombre, URL del canal y hora son requeridos' });
            return;
        }

        // Check plan limit
        const [subRow] = await db.select({ sub: subscriptions, plan: plans })
            .from(subscriptions)
            .leftJoin(plans, eq(subscriptions.planId, plans.id))
            .where(eq(subscriptions.tenantId, tenantId))
            .limit(1);
        const maxJobs = subRow?.plan?.maxScheduledJobs ?? 1;

        const countResult = await db.select({ count: sql<number>`count(*)` })
            .from(scheduledJobs)
            .where(eq(scheduledJobs.tenantId, tenantId));
        const currentCount = Number(countResult[0]?.count ?? 0);

        if (maxJobs !== -1 && currentCount >= maxJobs) {
            res.status(403).json({
                error: `Tu plan permite maximo ${maxJobs} jobs programados. Actualiza tu plan.`,
                code: 'JOB_LIMIT',
            });
            return;
        }

        const [job] = await db.insert(scheduledJobs).values({
            tenantId,
            createdById: req.auth!.userId,
            name: name.trim(),
            description: description || null,
            streamUrl: streamUrl.trim(),
            scheduleType: scheduleType || 'recurring',
            daysOfWeek: daysOfWeek || [],
            startTime,
            durationMinutes: durationMinutes || 120,
            pipelineConfig: pipelineConfig || {},
            isActive: true,
        }).returning();

        res.status(201).json(job);
    } catch (err) {
        console.error('[Jobs] Create error:', err);
        res.status(500).json({ error: 'Error al crear job' });
    }
});

// ---------------------------------------------------------------------------
// PUT /api/jobs/:id — Update job
// ---------------------------------------------------------------------------
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const [job] = await db.select().from(scheduledJobs)
            .where(and(
                eq(scheduledJobs.id, id),
                eq(scheduledJobs.tenantId, req.auth!.tenantId)
            ))
            .limit(1);
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        const { name, description, streamUrl, scheduleType, daysOfWeek, startTime, durationMinutes, pipelineConfig, isActive } = req.body;

        const updateData: Partial<typeof job> = {};
        if (name) updateData.name = name.trim();
        if (description !== undefined) updateData.description = description;
        if (streamUrl) updateData.streamUrl = streamUrl.trim();
        if (scheduleType) updateData.scheduleType = scheduleType;
        if (daysOfWeek) updateData.daysOfWeek = daysOfWeek;
        if (startTime) updateData.startTime = startTime;
        if (durationMinutes) updateData.durationMinutes = durationMinutes;
        if (pipelineConfig) updateData.pipelineConfig = pipelineConfig;
        if (isActive !== undefined) updateData.isActive = isActive;

        const [updated] = await db.update(scheduledJobs)
            .set(updateData)
            .where(eq(scheduledJobs.id, job.id))
            .returning();

        res.json(updated);
    } catch (err) {
        console.error('[Jobs] Update error:', err);
        res.status(500).json({ error: 'Error al actualizar job' });
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/jobs/:id — Delete job
// ---------------------------------------------------------------------------
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const [job] = await db.select().from(scheduledJobs)
            .where(and(
                eq(scheduledJobs.id, id),
                eq(scheduledJobs.tenantId, req.auth!.tenantId)
            ))
            .limit(1);
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        // Stop if running
        if (isJobRunning(job.id)) {
            await stopJob(job.id);
        }

        await db.delete(scheduledJobs)
            .where(eq(scheduledJobs.id, job.id));
        res.json({ success: true });
    } catch (err) {
        console.error('[Jobs] Delete error:', err);
        res.status(500).json({ error: 'Error al eliminar job' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:id/toggle — Toggle active/inactive
// ---------------------------------------------------------------------------
router.post('/:id/toggle', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const [job] = await db.select().from(scheduledJobs)
            .where(and(
                eq(scheduledJobs.id, id),
                eq(scheduledJobs.tenantId, req.auth!.tenantId)
            ))
            .limit(1);
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        if (isJobRunning(job.id) && job.isActive) {
            await stopJob(job.id);
        }

        const [updated] = await db.update(scheduledJobs)
            .set({ isActive: !job.isActive })
            .where(eq(scheduledJobs.id, job.id))
            .returning();

        res.json(updated);
    } catch (err) {
        console.error('[Jobs] Toggle error:', err);
        res.status(500).json({ error: 'Error al cambiar estado' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/jobs/:id/stop — Stop running job manually
// ---------------------------------------------------------------------------
router.post('/:id/stop', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const [job] = await db.select().from(scheduledJobs)
            .where(and(
                eq(scheduledJobs.id, id),
                eq(scheduledJobs.tenantId, req.auth!.tenantId)
            ))
            .limit(1);
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        await stopJob(job.id);
        res.json({ success: true, message: 'Job detenido' });
    } catch (err) {
        console.error('[Jobs] Stop error:', err);
        res.status(500).json({ error: 'Error al detener job' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:id/executions — Execution history
// ---------------------------------------------------------------------------
router.get('/:id/executions', requireAuth, async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        const [job] = await db.select().from(scheduledJobs)
            .where(and(
                eq(scheduledJobs.id, id),
                eq(scheduledJobs.tenantId, req.auth!.tenantId)
            ))
            .limit(1);
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        const executions = await db.select().from(jobExecutions)
            .where(eq(jobExecutions.jobId, job.id))
            .orderBy(desc(jobExecutions.createdAt))
            .limit(20);

        res.json(executions);
    } catch (err) {
        console.error('[Jobs] Executions error:', err);
        res.status(500).json({ error: 'Error al obtener historial' });
    }
});

// ---------------------------------------------------------------------------
// GET /api/notifications — Get notifications for tenant
// ---------------------------------------------------------------------------
router.get('/notifications', requireAuth, async (req: Request, res: Response) => {
    try {
        const limit = parseInt(req.query.limit as string) || 30;
        const unreadOnly = req.query.unread === 'true';

        const whereClause = unreadOnly
            ? and(eq(notifications.tenantId, req.auth!.tenantId), eq(notifications.isRead, false))
            : eq(notifications.tenantId, req.auth!.tenantId);

        const notifs = await db.select().from(notifications)
            .where(whereClause)
            .orderBy(desc(notifications.createdAt))
            .limit(limit);

        const unreadCountResult = await db.select({ count: sql<number>`count(*)` })
            .from(notifications)
            .where(and(
                eq(notifications.tenantId, req.auth!.tenantId),
                eq(notifications.isRead, false)
            ));
        const unreadCount = Number(unreadCountResult[0]?.count ?? 0);

        res.json({ notifications: notifs, unreadCount });
    } catch (err) {
        console.error('[Jobs] Notifications error:', err);
        res.status(500).json({ error: 'Error al obtener notificaciones' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/jobs/notifications/read-all — Mark all as read
// ---------------------------------------------------------------------------
router.post('/notifications/read-all', requireAuth, async (req: Request, res: Response) => {
    try {
        await db.update(notifications)
            .set({ isRead: true })
            .where(and(
                eq(notifications.tenantId, req.auth!.tenantId),
                eq(notifications.isRead, false)
            ));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error' });
    }
});

export { router as jobsRouter };
