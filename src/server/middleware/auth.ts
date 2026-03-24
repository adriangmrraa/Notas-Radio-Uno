import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import type { UserRole } from '@prisma/client';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

export interface AuthPayload {
    userId: string;
    tenantId: string;
    email: string;
    role: UserRole;
}

declare global {
    namespace Express {
        interface Request {
            auth?: AuthPayload;
        }
    }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Token de autenticacion requerido' });
        return;
    }

    const token = authHeader.slice(7);

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

    const subscription = await prisma.subscription.findUnique({
        where: { tenantId: req.auth.tenantId },
    });

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
            await prisma.subscription.update({
                where: { id: subscription.id },
                data: { status: 'expired' },
            });
            res.status(402).json({
                error: 'Tu periodo de prueba ha expirado',
                code: 'TRIAL_EXPIRED',
            });
            return;
        }
    }

    next();
}
