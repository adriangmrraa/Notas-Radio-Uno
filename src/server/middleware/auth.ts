import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { UserRole } from '../db/schema/enums.js';
import { subscriptions } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export interface AuthPayload {
    userId: string;
    tenantId: string;
    email: string;
    role: UserRole;
    /** Super admin de plataforma. Se refresca desde la DB en cada mutación. */
    isPlatformAdmin?: boolean;
    /** Id del super admin que está impersonando esta sesión (si aplica). */
    impersonatedBy?: string;
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthPayload;
            /** Motivo por el que optionalAuth no pudo habilitar la sesión. */
            authBlocked?: 'suspended' | 'not_found';
        }
    }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    // optionalAuth ya resolvió la sesión para /api (con rol y estado frescos).
    if (req.authBlocked) {
        res.status(403).json({
            error: req.authBlocked === 'suspended'
                ? 'Tu cuenta está suspendida'
                : 'La cuenta no existe',
            code: req.authBlocked === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_NOT_FOUND',
        });
        return;
    }

    if (req.auth) {
        next();
        return;
    }

    // Support both Bearer header and HttpOnly cookie
    let token: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.slice(7);
    } else if (req.cookies?.token) {
        token = req.cookies.token;
    }

    if (!token) {
        res.status(401).json({ error: 'Token de autenticacion requerido' });
        return;
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
        req.auth = payload;
        next();
    } catch {
        res.status(401).json({ error: 'Token invalido o expirado' });
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

    const [subscription] = await db.select().from(subscriptions)
        .where(eq(subscriptions.tenantId, req.auth.tenantId))
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
