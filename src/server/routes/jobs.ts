import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireActiveSubscription } from '../middleware/auth.js';
import { stopJob, isJobRunning, getActiveJobIds } from '../services/jobSchedulerService.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/jobs — List all scheduled jobs for tenant
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
        const jobs = await prisma.scheduledJob.findMany({
            where: { tenantId: req.auth!.tenantId },
            orderBy: { createdAt: 'desc' },
        });

        const activeIds = getActiveJobIds();
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
        const subscription = await prisma.subscription.findUnique({
            where: { tenantId },
            include: { plan: true },
        });
        const maxJobs = subscription?.plan?.maxScheduledJobs ?? 1;
        const currentCount = await prisma.scheduledJob.count({ where: { tenantId } });

        if (maxJobs !== -1 && currentCount >= maxJobs) {
            res.status(403).json({
                error: `Tu plan permite maximo ${maxJobs} jobs programados. Actualiza tu plan.`,
                code: 'JOB_LIMIT',
            });
            return;
        }

        const job = await prisma.scheduledJob.create({
            data: {
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
            },
        });

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
        const job = await prisma.scheduledJob.findFirst({
            where: { id: req.params.id as string, tenantId: req.auth!.tenantId },
        });
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        const { name, description, streamUrl, scheduleType, daysOfWeek, startTime, durationMinutes, pipelineConfig, isActive } = req.body;

        const updated = await prisma.scheduledJob.update({
            where: { id: job.id },
            data: {
                ...(name && { name: name.trim() }),
                ...(description !== undefined && { description }),
                ...(streamUrl && { streamUrl: streamUrl.trim() }),
                ...(scheduleType && { scheduleType }),
                ...(daysOfWeek && { daysOfWeek }),
                ...(startTime && { startTime }),
                ...(durationMinutes && { durationMinutes }),
                ...(pipelineConfig && { pipelineConfig }),
                ...(isActive !== undefined && { isActive }),
            },
        });

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
        const job = await prisma.scheduledJob.findFirst({
            where: { id: req.params.id as string, tenantId: req.auth!.tenantId },
        });
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        // Stop if running
        if (isJobRunning(job.id)) {
            await stopJob(job.id);
        }

        await prisma.scheduledJob.delete({ where: { id: job.id } });
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
        const job = await prisma.scheduledJob.findFirst({
            where: { id: req.params.id as string, tenantId: req.auth!.tenantId },
        });
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        if (isJobRunning(job.id) && job.isActive) {
            await stopJob(job.id);
        }

        const updated = await prisma.scheduledJob.update({
            where: { id: job.id },
            data: { isActive: !job.isActive },
        });

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
        const job = await prisma.scheduledJob.findFirst({
            where: { id: req.params.id as string, tenantId: req.auth!.tenantId },
        });
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
        const job = await prisma.scheduledJob.findFirst({
            where: { id: req.params.id as string, tenantId: req.auth!.tenantId },
        });
        if (!job) { res.status(404).json({ error: 'Job no encontrado' }); return; }

        const executions = await prisma.jobExecution.findMany({
            where: { jobId: job.id },
            orderBy: { createdAt: 'desc' },
            take: 20,
        });

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

        const notifications = await prisma.notification.findMany({
            where: {
                tenantId: req.auth!.tenantId,
                ...(unreadOnly && { isRead: false }),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });

        const unreadCount = await prisma.notification.count({
            where: { tenantId: req.auth!.tenantId, isRead: false },
        });

        res.json({ notifications, unreadCount });
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
        await prisma.notification.updateMany({
            where: { tenantId: req.auth!.tenantId, isRead: false },
            data: { isRead: true },
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error' });
    }
});

export { router as jobsRouter };
