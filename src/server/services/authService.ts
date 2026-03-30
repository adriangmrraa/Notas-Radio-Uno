import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail } from './emailService.js';
import slugify from 'slugify';
import { UserRole, UserStatus } from '@prisma/client';

const BCRYPT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = '7d';
const VERIFICATION_TOKEN_TTL_HOURS = 48;
const RESET_TOKEN_TTL_HOURS = 1;

// =============================================
// REGISTRO
// =============================================
export async function register(input: {
    email: string;
    password: string;
    fullName: string;
    organizationName: string;
}) {
    const { email, password, fullName, organizationName } = input;
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
        where: { email: normalizedEmail },
    });
    if (existing) {
        throw new AppError('Este email ya esta registrado', 409);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let slug = slugify(organizationName, { lower: true, strict: true });
    const slugExists = await prisma.tenant.findUnique({ where: { slug } });
    if (slugExists) {
        slug = `${slug}-${Date.now().toString(36)}`;
    }

    const verificationToken = crypto.randomUUID();
    const tokenExpires = new Date(
        Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000
    );

    const result = await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
            data: {
                name: organizationName,
                slug,
                platformName: organizationName,
            },
        });

        const isDev = process.env.NODE_ENV !== 'production';
        const user = await tx.user.create({
            data: {
                email: normalizedEmail,
                passwordHash,
                fullName,
                tenantId: tenant.id,
                role: UserRole.owner,
                status: isDev ? UserStatus.active : UserStatus.pending,
                isVerified: isDev ? true : false,
                verificationToken: isDev ? null : verificationToken,
                verificationTokenExpiresAt: isDev ? null : tokenExpires,
            },
        });

        await tx.tenant.update({
            where: { id: tenant.id },
            data: { ownerId: user.id },
        });

        const trialPlan = await tx.plan.findUnique({ where: { name: 'trial' } });
        if (trialPlan) {
            await tx.subscription.create({
                data: {
                    tenantId: tenant.id,
                    planId: trialPlan.id,
                    status: 'trialing',
                    trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
            });
        }

        return { userId: user.id, tenantId: tenant.id, verificationToken };
    });

    sendVerificationEmail(normalizedEmail, fullName, result.verificationToken).catch(console.error);

    await prisma.auditLog.create({
        data: {
            tenantId: result.tenantId,
            userId: result.userId,
            action: 'register',
            metadata: { email: normalizedEmail },
        },
    });

    return { message: 'Cuenta creada. Revisa tu email para verificar tu cuenta.' };
}

// =============================================
// VERIFICACION DE EMAIL
// =============================================
export async function verifyEmail(token: string) {
    const user = await prisma.user.findFirst({
        where: { verificationToken: token, isVerified: false },
    });

    if (!user) throw new AppError('Token de verificacion invalido o ya utilizado', 400);

    if (user.verificationTokenExpiresAt && new Date() > user.verificationTokenExpiresAt) {
        throw new AppError('Token de verificacion expirado. Solicita uno nuevo.', 400);
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            isVerified: true,
            status: UserStatus.active,
            verificationToken: null,
            verificationTokenExpiresAt: null,
        },
    });

    sendWelcomeEmail(user.email, user.fullName).catch(console.error);

    await prisma.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: 'email_verified' },
    });

    return { message: 'Email verificado exitosamente. Ya puedes iniciar sesion.' };
}

// =============================================
// LOGIN
// =============================================
export async function login(
    input: { email: string; password: string },
    ipAddress?: string,
    userAgent?: string
) {
    const normalizedEmail = input.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: {
            tenant: {
                select: {
                    id: true, name: true, slug: true,
                    platformName: true, logoUrl: true, timezone: true,
                },
            },
        },
    });

    if (!user) throw new AppError('Credenciales invalidas', 401);

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
        await prisma.auditLog.create({
            data: {
                tenantId: user.tenantId, userId: user.id,
                action: 'login_failed', ipAddress,
                metadata: { reason: 'invalid_password' },
            },
        });
        throw new AppError('Credenciales invalidas', 401);
    }

    if (user.status === UserStatus.suspended) {
        throw new AppError('Tu cuenta esta suspendida. Contacta soporte.', 403);
    }

    if (!user.isVerified) {
        throw new AppError(
            'Debes verificar tu email antes de iniciar sesion.',
            403, 'EMAIL_NOT_VERIFIED'
        );
    }

    const payload = {
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256',
    });

    await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
    });

    await prisma.auditLog.create({
        data: {
            tenantId: user.tenantId, userId: user.id,
            action: 'login_success', ipAddress, userAgent,
        },
    });

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            role: user.role, status: user.status, isVerified: user.isVerified,
        },
        tenant: user.tenant,
        accessToken,
    };
}

// =============================================
// GET ME
// =============================================
export async function getMe(userId: string) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { tenant: true },
    });
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const subscription = await prisma.subscription.findUnique({
        where: { tenantId: user.tenantId },
        include: { plan: true },
    });

    let trialDaysRemaining: number | null = null;
    if (subscription?.status === 'trialing' && subscription.trialEndsAt) {
        const msRemaining = subscription.trialEndsAt.getTime() - Date.now();
        trialDaysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));

        if (trialDaysRemaining === 0) {
            await prisma.subscription.update({
                where: { id: subscription.id },
                data: { status: 'expired' },
            });
        }
    }

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            avatarUrl: user.avatarUrl, role: user.role, status: user.status,
            isVerified: user.isVerified, lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
        },
        tenant: {
            id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug,
            platformName: user.tenant.platformName, logoUrl: user.tenant.logoUrl,
            timezone: user.tenant.timezone, config: user.tenant.config,
        },
        subscription: subscription ? {
            id: subscription.id,
            status: subscription.status,
            planName: subscription.plan.name,
            planDisplayName: subscription.plan.displayName,
            priceUsd: Number(subscription.plan.priceUsd),
            billingPeriod: subscription.billingPeriod,
            trialEndsAt: subscription.trialEndsAt,
            trialDaysRemaining,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            limits: {
                maxPipelineHoursPerMonth: subscription.plan.maxPipelineHoursPerMonth,
                maxPublicationsPerMonth: subscription.plan.maxPublicationsPerMonth,
                maxScheduledJobs: subscription.plan.maxScheduledJobs,
                maxCustomAgents: subscription.plan.maxCustomAgents,
                maxTeamMembers: subscription.plan.maxTeamMembers,
                maxConnectedPlatforms: subscription.plan.maxConnectedPlatforms,
                maxStorageGb: subscription.plan.maxStorageGb,
            },
            features: subscription.plan.features as Record<string, boolean>,
        } : null,
    };
}

// =============================================
// FORGOT PASSWORD
// =============================================
export async function forgotPassword(email: string) {
    const genericResponse = {
        message: 'Si el email existe, recibiras instrucciones para resetear tu contrasena.',
    };

    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
    });
    if (!user) return genericResponse;

    const resetToken = crypto.randomUUID();
    const tokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    await prisma.user.update({
        where: { id: user.id },
        data: { resetPasswordToken: resetToken, resetPasswordExpiresAt: tokenExpires },
    });

    sendPasswordResetEmail(user.email, user.fullName, resetToken).catch(console.error);

    return genericResponse;
}

// =============================================
// RESET PASSWORD
// =============================================
export async function resetPassword(token: string, newPassword: string) {
    const user = await prisma.user.findFirst({
        where: { resetPasswordToken: token },
    });

    if (!user) throw new AppError('Token invalido', 400);

    if (user.resetPasswordExpiresAt && new Date() > user.resetPasswordExpiresAt) {
        throw new AppError('Token expirado. Solicita uno nuevo.', 400);
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await prisma.user.update({
        where: { id: user.id },
        data: {
            passwordHash,
            resetPasswordToken: null,
            resetPasswordExpiresAt: null,
        },
    });

    await prisma.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: 'password_reset' },
    });

    return { message: 'Contrasena actualizada exitosamente.' };
}
