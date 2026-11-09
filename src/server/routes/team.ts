/**
 * team.ts — Rutas de equipo e invitaciones (PA-02 / PA-03)
 *
 *  GET    /api/team                          → miembros + invitaciones + cupo
 *  POST   /api/team/invites                  → invitar (owner)
 *  POST   /api/team/invites/:id/resend       → reenviar (owner)
 *  DELETE /api/team/invites/:id              → revocar (owner)
 *  PATCH  /api/team/members/:id/role         → cambiar rol (owner)
 *  DELETE /api/team/members/:id              → quitar colaborador (owner)
 *  GET    /api/team/invite/:token            → preview público del invite
 *  POST   /api/team/invite/:token/accept     → aceptar invite (público)
 *
 * El tenant SIEMPRE sale de req.auth: nunca de params ni body.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { requireOwner } from '../middleware/authz.js';
import { AppError } from '../lib/errors.js';
import {
  listTeam,
  inviteMember,
  resendInvite,
  revokeInvite,
  acceptInvite,
  getInvitePreview,
  changeMemberRole,
  removeMember,
} from '../services/teamService.js';

export const teamRouter = Router();

const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas invitaciones. Probá de nuevo más tarde.' },
});

const acceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Probá de nuevo en 15 minutos.' },
});

const inviteSchema = z.object({
  email: z.string().email('Email inválido'),
  role: z.enum(['editor', 'viewer']).default('editor'),
});

const acceptSchema = z.object({
  fullName: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').max(255),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

const roleSchema = z.object({
  role: z.enum(['owner', 'editor', 'viewer']),
});

function handleError(res: Response, err: unknown, context: string): void {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.issues[0].message });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`[Team] ${context}:`, err);
  res.status(500).json({ error: 'Error interno del servidor' });
}

// ── Público: preview y aceptación ─────────────────────────────────────────────

teamRouter.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    res.json(await getInvitePreview(req.params.token));
  } catch (err) {
    handleError(res, err, 'GET /invite/:token');
  }
});

teamRouter.post('/invite/:token/accept', acceptLimiter, async (req: Request, res: Response) => {
  try {
    const data = acceptSchema.parse(req.body);
    const result = await acceptInvite({ token: req.params.token, ...data });
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err, 'POST /invite/:token/accept');
  }
});

// ── Autenticado ──────────────────────────────────────────────────────────────

teamRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await listTeam(req.auth!.tenantId));
  } catch (err) {
    handleError(res, err, 'GET /');
  }
});

teamRouter.post('/invites', requireAuth, requireOwner, inviteLimiter, async (req: Request, res: Response) => {
  try {
    const data = inviteSchema.parse(req.body);
    const result = await inviteMember({
      tenantId: req.auth!.tenantId,
      actorUserId: req.auth!.userId,
      email: data.email,
      role: data.role,
    });
    res.status(result.resent ? 200 : 201).json(result);
  } catch (err) {
    handleError(res, err, 'POST /invites');
  }
});

teamRouter.post('/invites/:id/resend', requireAuth, requireOwner, inviteLimiter, async (req: Request, res: Response) => {
  try {
    await resendInvite({
      tenantId: req.auth!.tenantId,
      inviteId: req.params.id,
      actorUserId: req.auth!.userId,
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'POST /invites/:id/resend');
  }
});

teamRouter.delete('/invites/:id', requireAuth, requireOwner, async (req: Request, res: Response) => {
  try {
    await revokeInvite({
      tenantId: req.auth!.tenantId,
      inviteId: req.params.id,
      actorUserId: req.auth!.userId,
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'DELETE /invites/:id');
  }
});

teamRouter.patch('/members/:id/role', requireAuth, requireOwner, async (req: Request, res: Response) => {
  try {
    const data = roleSchema.parse(req.body);
    await changeMemberRole({
      tenantId: req.auth!.tenantId,
      memberId: req.params.id,
      role: data.role,
      actorUserId: req.auth!.userId,
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'PATCH /members/:id/role');
  }
});

teamRouter.delete('/members/:id', requireAuth, requireOwner, async (req: Request, res: Response) => {
  try {
    await removeMember({
      tenantId: req.auth!.tenantId,
      memberId: req.params.id,
      actorUserId: req.auth!.userId,
    });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'DELETE /members/:id');
  }
});
