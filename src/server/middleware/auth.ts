import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { UserRole } from '../db/schema/enums.js';
import { subscriptions, userTenants, tenants, users, adminImpersonations } from '../db/schema/index.js';
import { eq, and, gt, isNull } from 'drizzle-orm';
import { auditForbiddenAttempt, audit } from '../services/auditService.js';
import { applyTransition } from '../services/subscriptionMachine.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// ---------------------------------------------------------------------------
// Auth multi-tenant (T-37 / D8 / B-2)
//
// JWT payload NUEVO: { userId, activeTenantId, email, role (de la membresía
// activa), isPlatformAdmin, imp?, impersonatedBy?, impersonationId? }
//
// COMPAT (decisión menos invasiva): `tenantId` sigue tipado `string` y porta
// el MISMO valor que `activeTenantId` — los ~145 usos de `req.auth.tenantId`
// en rutas existentes compilan y operan sobre el tenant activo sin migración.
// OJO: cuando el usuario no tiene tenant activo, en RUNTIME ambos valen null
// (el tipo dice string por compat) — `eq(col, null)` devuelve 0 filas, scope
// vacío garantizado (fail-closed). Código nuevo DEBE usar `activeTenantId`
// (tipado honesto `string | null`) y hacer null-check explícito.
//
// requireAuth re-verifica la membresía en user_tenants POR REQUEST → una
// revocación tiene efecto en el próximo request (no espera expiración JWT).
// En impersonación (imp:true) NO se exige membresía (el admin no es miembro)
// pero sí se verifica que la sesión admin_impersonations siga vigente.
// ---------------------------------------------------------------------------
export interface AuthPayload {
    userId: string;
    /** COMPAT: alias del tenant activo. Tipado `string` para no romper rutas
     *  existentes; en runtime puede ser null (usuario sin membresías) → las
     *  queries tenant-scoped devuelven vacío (fail-closed). */
    tenantId: string;
    /** Tenant activo (nombre nuevo — usar este en código nuevo, con null-check). */
    activeTenantId: string | null;
    email: string;
    /** Rol de la membresía del tenant activo (no un rol global del user). */
    role: UserRole;
    isPlatformAdmin: boolean;
    /** true si el request corre en contexto de impersonación admin (F4). */
    imp?: boolean;
    impersonatedBy?: string;
    impersonationId?: string;
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthPayload;
        }
    }
}

function extractToken(req: Request): string | undefined {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return req.cookies?.token as string | undefined;
}

function normalizePayload(raw: Record<string, unknown>): AuthPayload {
    // Tokens viejos (pre-migración) portan solo tenantId — se traducen.
    const activeTenantId = (raw.activeTenantId ?? raw.tenantId ?? null) as string | null;
    return {
        userId: raw.userId as string,
        // COMPAT: tenantId tipado string; en runtime puede ser null cuando no
        // hay tenant activo (ver header). eq(col, null) → scope vacío.
        tenantId: activeTenantId as string,
        activeTenantId,
        email: (raw.email as string) ?? '',
        role: (raw.role as UserRole) ?? 'viewer',
        isPlatformAdmin: raw.isPlatformAdmin === true,
        imp: raw.imp === true ? true : undefined,
        impersonatedBy: (raw.impersonatedBy as string) ?? undefined,
        impersonationId: (raw.impersonationId as string) ?? undefined,
    };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = extractToken(req);
    if (!token) {
        res.status(401).json({ error: 'Token de autenticacion requerido' });
        return;
    }

    let payload: AuthPayload;
    try {
        payload = normalizePayload(jwt.verify(token, JWT_SECRET) as Record<string, unknown>);
    } catch {
        res.status(401).json({ error: 'Token invalido o expirado' });
        return;
    }

    try {
        if (payload.imp) {
            // Sesión de impersonación: no exige membresía (F4), pero la sesión
            // debe seguir vigente (no terminada anticipadamente ni vencida).
            if (!payload.impersonationId) {
                res.status(401).json({ error: 'Sesion de impersonacion invalida' });
                return;
            }
            const [session] = await db.select({ id: adminImpersonations.id })
                .from(adminImpersonations)
                .where(and(
                    eq(adminImpersonations.id, payload.impersonationId),
                    isNull(adminImpersonations.endedAt),
                    gt(adminImpersonations.expiresAt, new Date()),
                ))
                .limit(1);
            if (!session) {
                res.status(401).json({ error: 'La sesion de impersonacion expiro', code: 'IMPERSONATION_EXPIRED' });
                return;
            }
        } else if (payload.activeTenantId) {
            // Re-verificación de membresía por request: si la membresía fue
            // suspendida/eliminada, el próximo request recibe 403 (revocación
            // efectiva inmediata — D8). También refresca el rol efectivo.
            const [membership] = await db.select({ role: userTenants.role })
                .from(userTenants)
                .where(and(
                    eq(userTenants.userId, payload.userId),
                    eq(userTenants.tenantId, payload.activeTenantId),
                    eq(userTenants.status, 'active'),
                ))
                .limit(1);

            if (!membership) {
                void audit({
                    actorUserId: payload.userId,
                    tenantId: payload.activeTenantId,
                    action: 'auth.membership_revoked',
                    metadata: { path: req.originalUrl ?? req.url },
                });
                res.status(403).json({
                    error: 'Ya no tienes acceso a este tenant',
                    code: 'MEMBERSHIP_REVOKED',
                });
                return;
            }
            // El rol efectivo SIEMPRE es el de la membresía (refrescado).
            payload.role = membership.role;

            // Tenant suspendido → sus usuarios reciben 403 al operar.
            const [tenant] = await db.select({ isActive: tenants.isActive })
                .from(tenants)
                .where(eq(tenants.id, payload.activeTenantId))
                .limit(1);
            if (!tenant?.isActive) {
                res.status(403).json({
                    error: 'Este tenant esta suspendido',
                    code: 'TENANT_SUSPENDED',
                });
                return;
            }
        }
        // Usuario sin membresías (activeTenantId null): pasa autenticado pero
        // sin scope — el cliente muestra estado "sin acceso" (spec).

        // Flags del user que pueden cambiar en vivo (revocación de admin):
        // el claim se valida contra DB en requirePlatformAdmin; acá solo
        // refrescamos isPlatformAdmin si el token lo marca (barato: 1 query
        // solo para admins o tokens con tenant null que podrían ser admin).
        if (payload.isPlatformAdmin || !payload.activeTenantId) {
            const [u] = await db.select({ isPlatformAdmin: users.isPlatformAdmin })
                .from(users)
                .where(eq(users.id, payload.userId))
                .limit(1);
            payload.isPlatformAdmin = u?.isPlatformAdmin === true;
        }

        req.auth = payload;
        next();
    } catch (err) {
        console.error('[Auth] requireAuth membership check error:', err);
        res.status(500).json({ error: 'Error verificando la sesion' });
    }
}

export function requireRole(...roles: UserRole[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.auth) {
            res.status(401).json({ error: 'No autenticado' });
            return;
        }

        if (!roles.includes(req.auth.role)) {
            auditForbiddenAttempt(req, roles);
            res.status(403).json({ error: 'No tienes permisos para esta accion' });
            return;
        }

        next();
    };
}

/** Solo operadores de plataforma (users.is_platform_admin, verificado en DB).
 *  Bloqueado durante impersonación: un token imp:true no puede operar /api/admin
 *  (previene impersonación anidada y elevación — spec super-admin). */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.auth) {
        res.status(401).json({ error: 'No autenticado' });
        return;
    }
    if (req.auth.imp === true) {
        res.status(403).json({ error: 'No disponible durante una sesion de impersonacion', code: 'IMPERSONATION_RESTRICTED' });
        return;
    }
    try {
        const [u] = await db.select({ isPlatformAdmin: users.isPlatformAdmin })
            .from(users)
            .where(eq(users.id, req.auth.userId))
            .limit(1);
        if (u?.isPlatformAdmin !== true) {
            auditForbiddenAttempt(req, ['platform_admin']);
            res.status(403).json({ error: 'Solo operadores de la plataforma', code: 'NOT_PLATFORM_ADMIN' });
            return;
        }
        next();
    } catch (err) {
        console.error('[Auth] requirePlatformAdmin error:', err);
        res.status(500).json({ error: 'Error verificando permisos' });
    }
}

/**
 * Guard anti-destructive (F4): durante impersonación (imp:true) se bloquean
 * acciones destructivas/irreversibles — billing, baja de miembros, delete
 * tenant. Aplicar en rutas sensibles.
 */
export function forbidImpersonated(req: Request, res: Response, next: NextFunction): void {
    if (req.auth?.imp === true) {
        void audit({
            actorUserId: req.auth.impersonatedBy ?? req.auth.userId,
            tenantId: req.auth.activeTenantId,
            action: 'admin.impersonation_blocked_action',
            metadata: {
                method: req.method,
                path: req.originalUrl ?? req.url,
                impersonatedBy: req.auth.impersonatedBy,
            },
        });
        res.status(403).json({
            error: 'Accion no permitida durante una sesion de impersonacion',
            code: 'IMPERSONATION_RESTRICTED',
        });
        return;
    }
    next();
}

export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.auth) {
        res.status(401).json({ error: 'No autenticado' });
        return;
    }
    if (!req.auth.activeTenantId) {
        res.status(402).json({ error: 'No tienes una suscripcion activa', code: 'NO_SUBSCRIPTION' });
        return;
    }

    let subscription: typeof subscriptions.$inferSelect | undefined;
    try {
        [subscription] = await db.select().from(subscriptions)
            .where(eq(subscriptions.tenantId, req.auth.activeTenantId))
            .limit(1);
    } catch (err) {
        console.error('[Auth] requireActiveSubscription error:', err);
        res.status(500).json({ error: 'Error verificando la suscripcion' });
        return;
    }

    if (!subscription) {
        res.status(402).json({ error: 'No tienes una suscripcion activa', code: 'NO_SUBSCRIPTION' });
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
            // La expiración de trial pasa por la máquina (T-39) — nunca
            // mutación ad-hoc de subscriptions.status.
            await applyTransition(subscription.id, 'trial_expired', {
                provider: 'system',
                actor: 'system:requireActiveSubscription',
            }).catch((err) => console.warn('[Auth] trial_expired transition:', err));
            res.status(402).json({
                error: 'Tu periodo de prueba ha expirado',
                code: 'TRIAL_EXPIRED',
            });
            return;
        }
    }

    next();
}

/** Helper para emitir el JWT con el shape multi-tenant. */
export function signAuthToken(
    payload: Omit<AuthPayload, 'tenantId'>,
    expiresIn: jwt.SignOptions['expiresIn'] = '7d',
): string {
    const body = {
        ...payload,
        // COMPAT: `tenantId` = alias de activeTenantId (ver header del archivo).
        tenantId: payload.activeTenantId as string,
    };
    return jwt.sign(body, JWT_SECRET, { expiresIn, algorithm: 'HS256' });
}

export { AppError };
