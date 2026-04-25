import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail } from './emailService.js';
import slugify from 'slugify';
import { UserRole, UserStatus } from '../db/schema/enums.js';
import { users, tenants, subscriptions, plans, refreshTokens } from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import { eq, and, isNull } from 'drizzle-orm';

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

    const existingRows = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (existingRows[0]) {
        throw new AppError('Este email ya esta registrado', 409);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let slug = slugify(organizationName, { lower: true, strict: true });
    const slugRows = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (slugRows[0]) {
        slug = `${slug}-${Date.now().toString(36)}`;
    }

    const verificationToken = crypto.randomUUID();
    const tokenExpires = new Date(
        Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000
    );

    const result = await db.transaction(async (tx) => {
        const [tenant] = await tx.insert(tenants).values({
            name: organizationName,
            slug,
            platformName: organizationName,
        }).returning();

        const isDev = process.env.NODE_ENV !== 'production';
        const [user] = await tx.insert(users).values({
            email: normalizedEmail,
            passwordHash,
            fullName,
            tenantId: tenant.id,
            role: UserRole.owner,
            status: isDev ? UserStatus.active : UserStatus.pending,
            isVerified: isDev ? true : false,
            verificationToken: isDev ? null : verificationToken,
            verificationTokenExpiresAt: isDev ? null : tokenExpires,
        }).returning();

        await tx.update(tenants)
            .set({ ownerId: user.id })
            .where(eq(tenants.id, tenant.id));

        const [trialPlan] = await tx.select().from(plans).where(eq(plans.name, 'trial')).limit(1);
        if (trialPlan) {
            await tx.insert(subscriptions).values({
                tenantId: tenant.id,
                planId: trialPlan.id,
                status: 'trialing',
                trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            });
        }

        return { userId: user.id, tenantId: tenant.id, verificationToken };
    });

    sendVerificationEmail(normalizedEmail, fullName, result.verificationToken).catch(console.error);

    await db.insert(auditLog).values({
        tenantId: result.tenantId,
        userId: result.userId,
        action: 'register',
        metadata: { email: normalizedEmail },
    });

    return { message: 'Cuenta creada. Revisa tu email para verificar tu cuenta.' };
}

// =============================================
// VERIFICACION DE EMAIL
// =============================================
export async function verifyEmail(token: string) {
    const [user] = await db.select().from(users)
        .where(and(eq(users.verificationToken, token as any), eq(users.isVerified, false)))
        .limit(1);

    if (!user) throw new AppError('Token de verificacion invalido o ya utilizado', 400);

    if (user.verificationTokenExpiresAt && new Date() > user.verificationTokenExpiresAt) {
        throw new AppError('Token de verificacion expirado. Solicita uno nuevo.', 400);
    }

    await db.update(users)
        .set({
            isVerified: true,
            status: UserStatus.active,
            verificationToken: null,
            verificationTokenExpiresAt: null,
        })
        .where(eq(users.id, user.id));

    sendWelcomeEmail(user.email, user.fullName).catch(console.error);

    await db.insert(auditLog).values({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'email_verified',
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

    const rows = await db.select({
        user: users,
        tenant: tenants,
    })
        .from(users)
        .leftJoin(tenants, eq(users.tenantId, tenants.id))
        .where(eq(users.email, normalizedEmail))
        .limit(1);

    const row = rows[0];
    if (!row) throw new AppError('Credenciales invalidas', 401);

    const user = row.user;
    const tenant = row.tenant;

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
        await db.insert(auditLog).values({
            tenantId: user.tenantId,
            userId: user.id,
            action: 'login_failed',
            ipAddress,
            metadata: { reason: 'invalid_password' },
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

    await db.update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

    await db.insert(auditLog).values({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'login_success',
        ipAddress,
        userAgent,
    });

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            role: user.role, status: user.status, isVerified: user.isVerified,
        },
        tenant: tenant ? {
            id: tenant.id, name: tenant.name, slug: tenant.slug,
            platformName: tenant.platformName, logoUrl: tenant.logoUrl, timezone: tenant.timezone,
        } : null,
        accessToken,
    };
}

// =============================================
// GET ME
// =============================================
export async function getMe(userId: string) {
    const rows = await db.select({ user: users, tenant: tenants })
        .from(users)
        .leftJoin(tenants, eq(users.tenantId, tenants.id))
        .where(eq(users.id, userId))
        .limit(1);

    const row = rows[0];
    if (!row) throw new AppError('Usuario no encontrado', 404);

    const { user, tenant } = row;
    if (!tenant) throw new AppError('Tenant no encontrado', 404);

    const subRows = await db.select({ sub: subscriptions, plan: plans })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, user.tenantId))
        .limit(1);

    const subRow = subRows[0];
    const subscription = subRow?.sub ?? null;
    const plan = subRow?.plan ?? null;

    let trialDaysRemaining: number | null = null;
    if (subscription?.status === 'trialing' && subscription.trialEndsAt) {
        const msRemaining = subscription.trialEndsAt.getTime() - Date.now();
        trialDaysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));

        if (trialDaysRemaining === 0) {
            await db.update(subscriptions)
                .set({ status: 'expired' })
                .where(eq(subscriptions.id, subscription.id));
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
            id: tenant.id, name: tenant.name, slug: tenant.slug,
            platformName: tenant.platformName, logoUrl: tenant.logoUrl,
            timezone: tenant.timezone, config: tenant.config,
        },
        subscription: subscription && plan ? {
            id: subscription.id,
            status: subscription.status,
            planName: plan.name,
            planDisplayName: plan.displayName,
            priceUsd: Number(plan.priceUsd),
            billingPeriod: subscription.billingPeriod,
            trialEndsAt: subscription.trialEndsAt,
            trialDaysRemaining,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            limits: {
                maxPipelineHoursPerMonth: plan.maxPipelineHoursPerMonth,
                maxPublicationsPerMonth: plan.maxPublicationsPerMonth,
                maxScheduledJobs: plan.maxScheduledJobs,
                maxCustomAgents: plan.maxCustomAgents,
                maxTeamMembers: plan.maxTeamMembers,
                maxConnectedPlatforms: plan.maxConnectedPlatforms,
                maxStorageGb: plan.maxStorageGb,
            },
            features: plan.features as Record<string, boolean>,
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

    const [user] = await db.select().from(users)
        .where(eq(users.email, email.toLowerCase().trim()))
        .limit(1);
    if (!user) return genericResponse;

    const resetToken = crypto.randomUUID();
    const tokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    await db.update(users)
        .set({ resetPasswordToken: resetToken, resetPasswordExpiresAt: tokenExpires })
        .where(eq(users.id, user.id));

    sendPasswordResetEmail(user.email, user.fullName, resetToken).catch(console.error);

    return genericResponse;
}

// =============================================
// RESET PASSWORD
// =============================================
export async function resetPassword(token: string, newPassword: string) {
    const [user] = await db.select().from(users)
        .where(eq(users.resetPasswordToken, token as any))
        .limit(1);

    if (!user) throw new AppError('Token invalido', 400);

    if (user.resetPasswordExpiresAt && new Date() > user.resetPasswordExpiresAt) {
        throw new AppError('Token expirado. Solicita uno nuevo.', 400);
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await db.update(users)
        .set({
            passwordHash,
            resetPasswordToken: null,
            resetPasswordExpiresAt: null,
        })
        .where(eq(users.id, user.id));

    await db.insert(auditLog).values({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'password_reset',
    });

    return { message: 'Contrasena actualizada exitosamente.' };
}
