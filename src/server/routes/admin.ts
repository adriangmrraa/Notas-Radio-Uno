import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, requirePlatformAdmin } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import * as adminService from '../services/adminService.js';
import { listJobs, requeueDead } from '../services/jobsQueueService.js';
import type { JobType } from '../services/jobsQueueService.js';
import type { JobQueueStatus } from '../db/schema/saas.js';

const router = Router();

// ---------------------------------------------------------------------------
// /api/admin — consola de operadores de plataforma (T-42 / spec super-admin)
//
//   TODO endpoint pasa por requireAuth + requirePlatformAdmin (flag
//   users.is_platform_admin verificado en DB por request). Durante una sesión
//   de impersonación (imp:true) el guard rechaza el acceso — no se puede
//   impersonar en cadena ni operar la consola con el token imp.
// ---------------------------------------------------------------------------

router.use(requireAuth, requirePlatformAdmin);

function actor(req: Request) {
    return {
        adminUserId: req.auth!.userId,
        ip: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || null,
        userAgent: req.headers['user-agent'] ?? null,
    };
}

function handleError(res: Response, err: unknown, label: string): void {
    if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0].message });
        return;
    }
    if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
    }
    console.error(`[Admin] ${label} error:`, err);
    res.status(500).json({ error: 'Error interno del servidor' });
}

// ── Tenants ─────────────────────────────────────────────────────────────────

// GET /api/admin/tenants?search=&limit=&offset=
router.get('/tenants', async (req: Request, res: Response) => {
    try {
        res.json(await adminService.listTenants({
            search: req.query.search as string | undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            offset: req.query.offset ? Number(req.query.offset) : undefined,
        }));
    } catch (err) {
        handleError(res, err, 'listTenants');
    }
});

// GET /api/admin/tenants/:id — detalle (users, uso, actividad, costo IA)
router.get('/tenants/:id', async (req: Request, res: Response) => {
    try {
        res.json(await adminService.getTenantDetail(String(req.params.id)));
    } catch (err) {
        handleError(res, err, 'getTenantDetail');
    }
});

// GET /api/admin/tenants/:id/audit — audit log del tenant
router.get('/tenants/:id/audit', async (req: Request, res: Response) => {
    try {
        res.json(await adminService.getTenantAudit(String(req.params.id), req.query.limit ? Number(req.query.limit) : 50));
    } catch (err) {
        handleError(res, err, 'getTenantAudit');
    }
});

const planSchema = z.object({ planName: z.string().min(1) });

// POST /api/admin/tenants/:id/plan — cambiar plan (→ billing_event admin_grant)
router.post('/tenants/:id/plan', async (req: Request, res: Response) => {
    try {
        const { planName } = planSchema.parse(req.body);
        res.json(await adminService.adminSetPlan(String(req.params.id), planName, actor(req)));
    } catch (err) {
        handleError(res, err, 'adminSetPlan');
    }
});

const extendSchema = z.object({ days: z.number().int().min(1).max(90) });

// POST /api/admin/tenants/:id/extend-trial — +N días de trial
router.post('/tenants/:id/extend-trial', async (req: Request, res: Response) => {
    try {
        const { days } = extendSchema.parse(req.body);
        res.json(await adminService.adminExtendTrial(String(req.params.id), days, actor(req)));
    } catch (err) {
        handleError(res, err, 'adminExtendTrial');
    }
});

const grantSchema = z.object({ n: z.number().int().min(1).max(500) });

// POST /api/admin/tenants/:id/grant-transmissions — +N tx del ciclo
router.post('/tenants/:id/grant-transmissions', async (req: Request, res: Response) => {
    try {
        const { n } = grantSchema.parse(req.body);
        res.json(await adminService.adminGrantTransmissions(String(req.params.id), n, actor(req)));
    } catch (err) {
        handleError(res, err, 'adminGrantTransmissions');
    }
});

const suspendSchema = z.object({ reason: z.string().max(500).optional() });

// POST /api/admin/tenants/:id/suspend — suspender tenant (usuarios → 403)
router.post('/tenants/:id/suspend', async (req: Request, res: Response) => {
    try {
        const { reason } = suspendSchema.parse(req.body);
        res.json(await adminService.adminSuspendTenant(String(req.params.id), reason ?? null, actor(req)));
    } catch (err) {
        handleError(res, err, 'adminSuspendTenant');
    }
});

// POST /api/admin/tenants/:id/reactivate — reactivar tenant
router.post('/tenants/:id/reactivate', async (req: Request, res: Response) => {
    try {
        res.json(await adminService.adminReactivateTenant(String(req.params.id), actor(req)));
    } catch (err) {
        handleError(res, err, 'adminReactivateTenant');
    }
});

const featureSchema = z.object({
    value: z.unknown(),
    expiresAt: z.string().datetime().optional(),
});

// PUT /api/admin/tenants/:id/features/:key — override de feature flag
router.put('/tenants/:id/features/:key', async (req: Request, res: Response) => {
    try {
        const { value, expiresAt } = featureSchema.parse(req.body);
        res.json(await adminService.adminSetFeature(
            String(req.params.id),
            String(req.params.key),
            value,
            expiresAt ? new Date(expiresAt) : null,
            actor(req),
        ));
    } catch (err) {
        handleError(res, err, 'adminSetFeature');
    }
});

// DELETE /api/admin/tenants/:id/features/:key — quitar override
router.delete('/tenants/:id/features/:key', async (req: Request, res: Response) => {
    try {
        res.json(await adminService.adminDeleteFeature(String(req.params.id), String(req.params.key), actor(req)));
    } catch (err) {
        handleError(res, err, 'adminDeleteFeature');
    }
});

// ── Impersonación (F4) ────────────────────────────────────────────────────────

// POST /api/admin/tenants/:id/impersonate — JWT imp:true 30 min
router.post('/tenants/:id/impersonate', async (req: Request, res: Response) => {
    try {
        res.json(await adminService.startImpersonation(String(req.params.id), actor(req)));
    } catch (err) {
        handleError(res, err, 'startImpersonation');
    }
});

const stopSchema = z.object({ impersonationId: z.string().uuid() });

// POST /api/admin/impersonation/stop — ended_at + audit fin
router.post('/impersonation/stop', async (req: Request, res: Response) => {
    try {
        const { impersonationId } = stopSchema.parse(req.body);
        res.json(await adminService.stopImpersonation(impersonationId, req.auth!.userId));
    } catch (err) {
        handleError(res, err, 'stopImpersonation');
    }
});

// GET /api/admin/impersonations — sesiones recientes
router.get('/impersonations', async (_req: Request, res: Response) => {
    try {
        res.json(await adminService.listImpersonations());
    } catch (err) {
        handleError(res, err, 'listImpersonations');
    }
});

// ── Panel jobs_queue ──────────────────────────────────────────────────────────

// GET /api/admin/jobs?status=&type=&tenantId=&limit=
router.get('/jobs', async (req: Request, res: Response) => {
    try {
        res.json(await listJobs({
            status: req.query.status as JobQueueStatus | undefined,
            type: req.query.type as JobType | undefined,
            tenantId: req.query.tenantId as string | undefined,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
        }));
    } catch (err) {
        handleError(res, err, 'listJobs');
    }
});

// POST /api/admin/jobs/:id/requeue — dead-letter → pending
router.post('/jobs/:id/requeue', async (req: Request, res: Response) => {
    try {
        const ok = await requeueDead(String(req.params.id));
        if (!ok) {
            res.status(404).json({ error: 'Job no encontrado o no está en dead-letter' });
            return;
        }
        res.json({ message: 'Job re-encolado' });
    } catch (err) {
        handleError(res, err, 'requeueJob');
    }
});

// ── Métricas globales ─────────────────────────────────────────────────────────

// GET /api/admin/metrics — MRR, tenants activos, churn, conversión, alertas
router.get('/metrics', async (_req: Request, res: Response) => {
    try {
        res.json(await adminService.getPlatformMetrics());
    } catch (err) {
        handleError(res, err, 'getPlatformMetrics');
    }
});

export { router as adminRouter };
