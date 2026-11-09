/**
 * authz.ts — Autorización por rol y por rol de plataforma
 *
 * Jerarquía: owner (3) > editor (2) > viewer (1).
 *
 * Estrategia de aplicación (defensa en capas):
 *  1. `optionalAuth` montado en /api: decodifica el JWT y, en métodos que mutan,
 *     refresca rol y estado desde la DB (un token viejo no puede seguir mutando
 *     con un rol que ya no tiene, ni operar si la cuenta fue suspendida).
 *  2. `viewerWriteGuard` montado en /api: un viewer NUNCA muta (403), salvo
 *     endpoints de su propia cuenta (/api/auth) y webhooks de billing.
 *  3. `requireMinRole` / `requireOwner` / `requirePlatformAdmin` en rutas
 *     puntuales que exigen más que "poder escribir".
 *
 * Toda denegación queda auditada como `authz.denied`.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { AUDIT_ACTIONS } from '../services/auditService.js';
import { recordAuditEvent } from '../services/auditService.js';
import type { UserRole } from '../db/schema/enums.js';
import type { AuthPayload } from './auth.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export const ROLE_RANK: Record<UserRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function hasRoleAtLeast(role: UserRole | undefined | null, min: UserRole): boolean {
  if (!role) return false;
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK[min];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Endpoints que un viewer sí puede usar aunque muten (su propia cuenta). */
const WRITE_GUARD_EXEMPT = [
  /^\/api\/auth\//,
  /^\/api\/billing\/webhooks\//,
  // Aceptar una invitación es público: la prueba de identidad es el token.
  /^\/api\/team\/invite\//,
];

function isExemptFromWriteGuard(originalUrl: string): boolean {
  const path = originalUrl.split('?')[0];
  return WRITE_GUARD_EXEMPT.some((re) => re.test(path));
}

function readToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return req.cookies?.token;
}

/**
 * Autenticación opcional para /api. No rechaza requests sin token (hay rutas
 * públicas), pero deja `req.auth` disponible para los guards que vienen después.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = readToken(req);
  if (!token) return next();

  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
  } catch {
    return next();
  }

  // En métodos que mutan validamos rol/estado contra la DB: el JWT es un claim,
  // no una fuente de verdad para permisos.
  if (!SAFE_METHODS.has(req.method)) {
    try {
      const [row] = await db
        .select({ role: users.role, status: users.status, isPlatformAdmin: users.isPlatformAdmin })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);

      if (!row || row.status === 'suspended') {
        req.authBlocked = row ? 'suspended' : 'not_found';
        next();
        return;
      }
      payload.role = row.role;
      payload.isPlatformAdmin = row.isPlatformAdmin;
    } catch (err) {
      console.error('[Authz] No se pudo refrescar rol desde la DB:', err);
    }
  }

  req.auth = payload;
  next();
}

/**
 * Bloquea cualquier mutación de un usuario con rol `viewer`.
 * Se monta a nivel /api, antes de registrar las rutas.
 */
export function viewerWriteGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!req.auth || req.auth.role !== 'viewer') return next();
  if (isExemptFromWriteGuard(req.originalUrl)) return next();

  void recordAuditEvent({
    action: AUDIT_ACTIONS.AUTHZ_DENIED,
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    actorRole: req.auth.role,
    actorEmail: req.auth.email,
    outcome: 'denied',
    entityType: 'route',
    entityId: `${req.method} ${req.originalUrl.split('?')[0]}`,
    ipAddress: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || null,
    userAgent: req.headers['user-agent'] ?? null,
    metadata: { reason: 'read_only_role' },
  });

  res.status(403).json({
    error: 'Tu rol es de solo lectura: no podés modificar contenido.',
    code: 'ROLE_READ_ONLY',
  });
}

/** Exige al menos `min` en la jerarquía owner > editor > viewer. */
export function requireMinRole(min: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'No autenticado' });
      return;
    }
    if (!hasRoleAtLeast(req.auth.role, min)) {
      void recordAuditEvent({
        action: AUDIT_ACTIONS.AUTHZ_DENIED,
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        actorRole: req.auth.role,
        actorEmail: req.auth.email,
        outcome: 'denied',
        entityType: 'route',
        entityId: `${req.method} ${req.originalUrl.split('?')[0]}`,
        metadata: { reason: 'insufficient_role', required: min, actual: req.auth.role },
      });
      res.status(403).json({
        error: 'No tenés permisos para esta acción',
        code: 'INSUFFICIENT_ROLE',
        required: min,
      });
      return;
    }
    next();
  };
}

export const requireEditor = requireMinRole('editor');
export const requireOwner = requireMinRole('owner');

/**
 * Exige ser super admin de la plataforma. Verifica contra la DB en cada request:
 * el flag no viaja en el JWT, así que revocarlo tiene efecto inmediato.
 */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.auth) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }

  try {
    const [row] = await db
      .select({ isPlatformAdmin: users.isPlatformAdmin, status: users.status })
      .from(users)
      .where(eq(users.id, req.auth.userId))
      .limit(1);

    if (!row?.isPlatformAdmin || row.status === 'suspended') {
      void recordAuditEvent({
        action: AUDIT_ACTIONS.AUTHZ_DENIED,
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        actorRole: req.auth.role,
        actorEmail: req.auth.email,
        outcome: 'denied',
        entityType: 'admin_route',
        entityId: `${req.method} ${req.originalUrl.split('?')[0]}`,
        metadata: { reason: 'not_platform_admin' },
      });
      res.status(403).json({ error: 'Requiere ser administrador de plataforma', code: 'NOT_PLATFORM_ADMIN' });
      return;
    }

    req.auth.isPlatformAdmin = true;
    next();
  } catch (err) {
    console.error('[Authz] Error verificando platform admin:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
