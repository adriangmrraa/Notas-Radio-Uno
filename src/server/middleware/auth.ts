import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { UserRole } from '../db/schema/enums.js';
import { subscriptions, users } from '../db/schema/index.js';
import { requireActiveMembership } from '../services/membershipService.js';
import { recordAuditEvent, AUDIT_ACTIONS } from '../services/auditService.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

/**
 * Claims de sesión (T-37 / decisión B-2).
 *
 * `activeTenantId` es el claim canónico: el tenant sobre el que opera TODO
 * request. `tenantId` es un mirror que requireAuth siempre re-escribe con el
 * tenant activo resuelto (string vacío cuando la sesión no tiene tenant, p.ej.
 * un platform admin en la consola): así las rutas con scope de tenant no
 * necesitan cambiar y, si no hay tenant, no matchean nada.
 *
 * `role` NUNCA se confía del token: requireAuth lo re-resuelve desde
 * `user_tenants` en cada request (revocar una membresía tiene efecto inmediato).
 */
export interface AuthPayload {
    userId: string;
    activeTenantId: string | null;
    tenantId: string;
    email: string;
    role: UserRole;
    /** Super admin de plataforma. Se refresca desde la DB en cada request. */
    isPlatformAdmin?: boolean;
    /** Id del super admin que está impersonando esta sesión (si aplica). */
    impersonatedBy?: string;
    /** Id de la sesión de impersonación (tabla impersonation_sessions). */
    imp?: string;
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthPayload;
            /** Motivo por el que optionalAuth no pudo habilitar la sesión. */
            authBlocked?: 'suspended' | 'not_found' | 'membership' | 'tenant';
            /** Detalle del bloqueo de membresía/tenant, para el JSON de error. */
            authBlockedDetail?: { code: string; error: string; status: number };
        }
    }
}

export function readTokenFromRequest(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
    return req.cookies?.token;
}

export function signSessionToken(payload: {
    userId: string;
    activeTenantId: string | null;
    email: string;
    role: UserRole;
    isPlatformAdmin?: boolean;
    impersonatedBy?: string;
    imp?: string;
}, expiresIn: string = '7d'): string {
    return jwt.sign(
        { ...payload, tenantId: payload.activeTenantId ?? '' },
        JWT_SECRET,
        { expiresIn: expiresIn as jwt.SignOptions['expiresIn'], algorithm: 'HS256' },
    ) as string;
}

export function readAuthPayload(req: Request): AuthPayload | null {
    const token = readTokenFromRequest(req);
    if (!token) return null;
    try {
        const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
        // Tokens pre-B-2 sólo traían `tenantId`: se traduce a tenant activo.
        if (!payload.activeTenantId && payload.tenantId) {
            payload.activeTenantId = payload.tenantId;
        }
        payload.tenantId = payload.activeTenantId ?? '';
        return payload;
    } catch {
        return null;
    }
}

/**
 * Re-verifica cuenta + membresía del tenant activo contra la DB.
 * Devuelve el payload corregido o el error a devolver (401/403).
 */
export async function verifySession(payload: AuthPayload): Promise<
    { ok: true; payload: AuthPayload } | { ok: false; status: number; code: string; error: string }
> {
    const [user] = await db
        .select({ status: users.status, isPlatformAdmin: users.isPlatformAdmin, email: users.email })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);

    if (!user) {
        return { ok: false, status: 401, code: 'ACCOUNT_NOT_FOUND', error: 'La cuenta no existe' };
    }
    if (user.status === 'suspended') {
        return { ok: false, status: 403, code: 'ACCOUNT_SUSPENDED', error: 'Tu cuenta está suspendida' };
    }

    payload.isPlatformAdmin = user.isPlatformAdmin;
    payload.email = payload.email || user.email;
    const activeTenantId = payload.activeTenantId ?? (payload.tenantId || null);

    if (!activeTenantId) {
        // Sin tenant activo: sólo la consola de plataforma puede operar.
        if (user.isPlatformAdmin) {
            payload.activeTenantId = null;
            payload.tenantId = '';
            return { ok: true, payload };
        }
        return {
            ok: false,
            status: 403,
            code: 'NO_ACTIVE_TENANT',
            error: 'Tu cuenta no tiene acceso a ninguna organización',
        };
    }

    try {
        const membership = await requireActiveMembership(payload.userId, activeTenantId);
        payload.activeTenantId = activeTenantId;
        payload.tenantId = activeTenantId;
        payload.role = membership.role;
        return { ok: true, payload };
    } catch (err) {
        if (err instanceof AppError) {
            void recordAuditEvent({
                action: AUDIT_ACTIONS.AUTHZ_DENIED,
                tenantId: activeTenantId,
                userId: payload.userId,
                actorRole: payload.role,
                actorEmail: payload.email,
                outcome: 'denied',
                entityType: 'session',
                entityId: payload.userId,
                metadata: { reason: err.code ?? 'membership_denied' },
            });
            return { ok: false, status: err.statusCode, code: err.code ?? 'MEMBERSHIP_REVOKED', error: err.message };
        }
        throw err;
    }
}

/**
 * Guard de rutas protegidas. Además de verificar la firma del token, RE-VERIFICA
 * la membresía del tenant activo en cada request: suspender una membresía corta
 * el acceso sin esperar a que expire el JWT (criterio de aceptación de T-37).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.authBlocked) {
        const detail = req.authBlockedDetail;
        res.status(detail?.status ?? 403).json({
            error: detail?.error ?? (req.authBlocked === 'suspended' ? 'Tu cuenta está suspendida' : 'La cuenta no existe'),
            code: detail?.code ?? (req.authBlocked === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_NOT_FOUND'),
        });
        return;
    }

    let payload = req.auth ?? readAuthPayload(req);

    if (!payload) {
        res.status(401).json({ error: 'Token de autenticacion requerido' });
        return;
    }

    try {
        const result = await verifySession(payload);
        if (!result.ok) {
            res.status(result.status).json({ error: result.error, code: result.code });
            return;
        }
        req.auth = result.payload;
        next();
    } catch (err) {
        console.error('[Auth] Error verificando la sesión:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
}

export function requireRole(...roles: UserRole[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.auth) {
            res.status(401).json({ error: 'No autenticado' });
            return;
        }

        if (!roles.includes(req.auth.role)) {
            res.status(403).json({ error: 'No tienes permisos para esta accion' });
            return;
        }

        next();
    };
}

export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.auth) {
        res.status(401).json({ error: 'No autenticado' });
        return;
    }
    if (!req.auth.activeTenantId) {
        res.status(403).json({ error: 'Tu sesión no tiene una organización activa', code: 'NO_ACTIVE_TENANT' });
        return;
    }

    const [subscription] = await db.select().from(subscriptions)
        .where(eq(subscriptions.tenantId, req.auth.activeTenantId))
        .limit(1);

    if (!subscription) {
        res.status(402).json({ error: 'No tienes una suscripcion activa', code: 'NO_SUBSCRIPTION' });
        return;
    }

    // past_due DENTRO de la gracia: el servicio sigue (el dunning no corta el
    // día 1). Se informan los días restantes en header para que el cliente
    // pueda avisar. Fuera de gracia → 402 PAYMENT_OVERDUE.
    if (subscription.status === 'past_due') {
        const now = new Date();
        if (subscription.graceEndsAt && subscription.graceEndsAt > now) {
            const daysLeft = Math.ceil((subscription.graceEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
            res.setHeader('X-Grace-Days-Remaining', String(daysLeft));
            next();
            return;
        }
        res.status(402).json({
            error: 'Pago vencido: actualizá tu medio de pago para seguir usando el servicio',
            code: 'PAYMENT_OVERDUE',
            status: 'past_due',
            graceDaysRemaining: 0,
        });
        return;
    }

    const activeStatuses = ['trialing', 'active'];
    if (!activeStatuses.includes(subscription.status)) {
        res.status(402).json({
            error: 'Tu suscripcion no esta activa',
            code: 'SUBSCRIPTION_INACTIVE',
            status: subscription.status,
        });
        return;
    }

    if (subscription.status === 'trialing' && subscription.trialEndsAt) {
        if (new Date() > subscription.trialEndsAt) {
            await db.update(subscriptions)
                .set({ status: 'expired' })
                .where(eq(subscriptions.id, subscription.id));
            res.status(402).json({
                error: 'Tu periodo de prueba ha expirado',
                code: 'TRIAL_EXPIRED',
            });
            return;
        }
    }

    next();
}
