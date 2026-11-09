import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRole, forbidImpersonated } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import { UserRole } from '../db/schema/enums.js';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
    inviteMember,
    acceptInvitation,
    getInvitationByToken,
    listTeam,
    revokeInvitation,
    resendInvitation,
    updateMemberRole,
    removeMember,
} from '../services/inviteService.js';

const router = Router();

// Rate limit en invite/accept — misma política que auth (spec edge).
const teamLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: 'Demasiados intentos. Intenta de nuevo en 15 minutos.' },
});

function handleError(res: Response, err: unknown, fallback: string): void {
    if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues[0].message });
        return;
    }
    if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
    }
    console.error('[Team]', err);
    res.status(500).json({ error: fallback });
}

async function inviterName(userId: string): Promise<string> {
    const [u] = await db.select({ fullName: users.fullName }).from(users)
        .where(eq(users.id, userId)).limit(1);
    return u?.fullName ?? 'Un compañero';
}

function activeTenant(req: Request, res: Response): string | null {
    const tenantId = req.auth!.activeTenantId;
    if (!tenantId) {
        res.status(403).json({ error: 'Sin tenant activo', code: 'NO_ACTIVE_TENANT' });
        return null;
    }
    return tenantId;
}

const inviteSchema = z.object({
    email: z.string().email('Email invalido'),
    role: z.enum(['owner', 'editor', 'viewer']),
});

// ---------------------------------------------------------------------------
// GET /api/team — roster (miembros + invitaciones pending). Cualquier miembro.
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req: Request, res: Response) => {
    try {
        const tenantId = activeTenant(req, res);
        if (!tenantId) return;
        const result = await listTeam(tenantId);
        res.json(result);
    } catch (err) {
        handleError(res, err, 'Error al obtener el equipo');
    }
});

// ---------------------------------------------------------------------------
// POST /api/team/invitations — invitar por email con rol (owner/editor)
// ---------------------------------------------------------------------------
router.post('/invitations', requireAuth, requireRole('owner', 'editor'), teamLimiter, async (req: Request, res: Response) => {
    try {
        const tenantId = activeTenant(req, res);
        if (!tenantId) return;
        const data = inviteSchema.parse(req.body);
        const result = await inviteMember({
            tenantId,
            email: data.email,
            role: data.role as UserRole,
            invitedByUserId: req.auth!.userId,
            inviterRole: req.auth!.role,
            inviterName: await inviterName(req.auth!.userId),
        });
        res.status(201).json(result);
    } catch (err) {
        handleError(res, err, 'Error al invitar');
    }
});

// ---------------------------------------------------------------------------
// GET /api/team/invitations/:token — preview público de la invitación (accept page)
// ---------------------------------------------------------------------------
router.get('/invitations/:token', teamLimiter, async (req: Request, res: Response) => {
    try {
        const inv = await getInvitationByToken(String(req.params.token));
        res.json({ email: inv.email, role: inv.role, tenantName: inv.tenantName, expiresAt: inv.expiresAt });
    } catch (err) {
        handleError(res, err, 'Invitacion invalida');
    }
});

// ---------------------------------------------------------------------------
// POST /api/team/invitations/:id/resend — reenviar (rota token + renueva TTL)
// ---------------------------------------------------------------------------
router.post('/invitations/:id/resend', requireAuth, requireRole('owner'), teamLimiter, async (req: Request, res: Response) => {
    try {
        const tenantId = activeTenant(req, res);
        if (!tenantId) return;
        const result = await resendInvitation(
            tenantId,
            String(req.params.id),
            req.auth!.userId,
            await inviterName(req.auth!.userId),
        );
        res.json(result);
    } catch (err) {
        handleError(res, err, 'Error al reenviar la invitacion');
    }
});

// ---------------------------------------------------------------------------
// POST /api/team/invitations/:id/revoke — revocar invitación pending
// ---------------------------------------------------------------------------
router.post('/invitations/:id/revoke', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
    try {
        const tenantId = activeTenant(req, res);
        if (!tenantId) return;
        const result = await revokeInvitation(tenantId, String(req.params.id), req.auth!.userId);
        res.json(result);
    } catch (err) {
        handleError(res, err, 'Error al revocar la invitacion');
    }
});

// ---------------------------------------------------------------------------
// POST /api/team/accept — aceptar invitación (público; cuenta nueva pide datos)
// ---------------------------------------------------------------------------
router.post('/accept', teamLimiter, async (req: Request, res: Response) => {
    try {
        const schema = z.object({
            token: z.string().min(1, 'Token requerido'),
            fullName: z.string().min(2).optional(),
            password: z.string().min(8).optional(),
        });
        const data = schema.parse(req.body);
        const result = await acceptInvitation({
            token: data.token,
            fullName: data.fullName,
            password: data.password,
            ip: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress,
            userAgent: req.headers['user-agent'],
        });
        res.json(result);
    } catch (err) {
        handleError(res, err, 'Error al aceptar la invitacion');
    }
});

// ---------------------------------------------------------------------------
// PATCH /api/team/members/:userId — cambiar rol (owner)
// ---------------------------------------------------------------------------
router.patch('/members/:userId', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
    try {
        const tenantId = activeTenant(req, res);
        if (!tenantId) return;
        const schema = z.object({ role: z.enum(['owner', 'editor', 'viewer']) });
        const { role } = schema.parse(req.body);
        const result = await updateMemberRole(
            tenantId,
            String(req.params.userId),
            role as UserRole,
            req.auth!.userId,
        );
        res.json(result);
    } catch (err) {
        handleError(res, err, 'Error al cambiar el rol');
    }
});

// ---------------------------------------------------------------------------
// DELETE /api/team/members/:userId — remover miembro (owner; last-owner guard;
// BLOQUEADO durante impersonación — anti-destructive F4)
// ---------------------------------------------------------------------------
router.delete('/members/:userId', requireAuth, requireRole('owner'), forbidImpersonated, async (req: Request, res: Response) => {
    try {
        const tenantId = activeTenant(req, res);
        if (!tenantId) return;
        const result = await removeMember(
            tenantId,
            String(req.params.userId),
            req.auth!.userId,
        );
        res.json(result);
    } catch (err) {
        handleError(res, err, 'Error al remover el miembro');
    }
});

export { router as teamRouter };
