import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail } from './emailService.js';
import slugify from 'slugify';
import { UserRole, UserStatus } from '../db/schema/enums.js';
import { users, tenants, subscriptions, plans, refreshTokens, tenantFeatures, userTenants } from '../db/schema/index.js';
import { recordAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { buildFeatureRowsForPlan } from './tenantFeaturesService.js';
import {
    listUserMemberships,
    pickDefaultMembership,
    requireActiveMembership,
    touchMembership,
} from './membershipService.js';
import { signSessionToken } from '../middleware/auth.js';
import { startTrial } from './subscriptionLifecycleService.js';
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
            // Legacy (B-2): primer tenant del usuario. El acceso real vive en
            // `user_tenants`.
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

        // Membresía owner del tenant recién creado (fuente de verdad del acceso).
        await tx.insert(userTenants).values({
            userId: user.id,
            tenantId: tenant.id,
            role: UserRole.owner,
            status: 'active',
            lastUsedAt: new Date(),
        });

        const [trialPlan] = await tx.select().from(plans).where(eq(plans.name, 'trial')).limit(1);

        // Feature flags: el tenant nace con los defaults del plan (trial o fallback).
        await tx.insert(tenantFeatures).values(buildFeatureRowsForPlan(tenant.id, trialPlan ?? null));

        return { userId: user.id, tenantId: tenant.id, verificationToken };
    });

    // Suscripción trial (Épica B): si falta el plan 'trial' el registro no rompe.
    await startTrial(result.tenantId).catch((err) => {
        console.error('[Auth] No se pudo iniciar el trial:', err);
    });

    sendVerificationEmail(normalizedEmail, fullName, result.verificationToken).catch(console.error);

    await recordAuditEvent({
        action: AUDIT_ACTIONS.REGISTER,
        tenantId: result.tenantId,
        userId: result.userId,
        actorEmail: normalizedEmail,
        actorRole: UserRole.owner,
        entityType: 'tenant',
        entityId: result.tenantId,
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

    await recordAuditEvent({
        action: AUDIT_ACTIONS.EMAIL_VERIFIED,
        tenantId: user.tenantId,
        userId: user.id,
        actorEmail: user.email,
        entityType: 'user',
        entityId: user.id,
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

    const [user] = await db.select().from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

    if (!user) throw new AppError('Credenciales invalidas', 401);

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
        await recordAuditEvent({
            action: AUDIT_ACTIONS.LOGIN_FAILED,
            tenantId: user.tenantId,
            userId: user.id,
            actorEmail: user.email,
            outcome: 'denied',
            ipAddress,
            userAgent,
            metadata: { reason: 'invalid_password' },
        });
        throw new AppError('Credenciales invalidas', 401);
    }

    if (user.status === UserStatus.suspended) {
        await recordAuditEvent({
            action: AUDIT_ACTIONS.LOGIN_BLOCKED,
            tenantId: user.tenantId,
            userId: user.id,
            actorEmail: user.email,
            outcome: 'denied',
            ipAddress,
            userAgent,
            metadata: { reason: 'account_suspended' },
        });
        throw new AppError('Tu cuenta esta suspendida. Contacta soporte.', 403);
    }

    if (!user.isVerified) {
        throw new AppError(
            'Debes verificar tu email antes de iniciar sesion.',
            403, 'EMAIL_NOT_VERIFIED'
        );
    }

    // Multi-tenant (B-2): el tenant activo es el último usado y operable; el
    // rol efectivo es el de ESA membresía, no el rol histórico del usuario.
    const memberships = await listUserMemberships(user.id);
    const active = pickDefaultMembership(memberships);
    const activeTenantId = active?.tenantId ?? null;
    const role = active?.role ?? user.role;

    const accessToken = signSessionToken({
        userId: user.id,
        activeTenantId,
        email: user.email,
        role,
        isPlatformAdmin: user.isPlatformAdmin,
    });

    await db.update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

    if (activeTenantId) {
        await touchMembership(user.id, activeTenantId);
    }

    await recordAuditEvent({
        action: AUDIT_ACTIONS.LOGIN_SUCCESS,
        tenantId: activeTenantId,
        userId: user.id,
        actorEmail: user.email,
        actorRole: role,
        entityType: 'session',
        ipAddress,
        userAgent,
        metadata: { memberships: memberships.length, activeTenantId },
    });

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            role, status: user.status, isVerified: user.isVerified,
            isPlatformAdmin: user.isPlatformAdmin,
            tenantId: activeTenantId,
        },
        tenant: active ? {
            id: active.tenantId, name: active.name, slug: active.slug,
            platformName: active.platformName, logoUrl: active.logoUrl,
        } : null,
        tenants: memberships.map((m) => ({
            id: m.tenantId,
            name: m.name,
            slug: m.slug,
            platformName: m.platformName,
            logoUrl: m.logoUrl,
            role: m.role,
            status: m.status,
            isActive: m.isActive,
            lastUsedAt: m.lastUsedAt,
        })),
        accessToken,
    };
}

// =============================================
// SWITCH DE TENANT (B-2 / T-37)
// =============================================
export async function switchTenant(userId: string, tenantId: string, ipAddress?: string, userAgent?: string) {
    // Valida membresía activa + tenant operativo, o lanza el motivo exacto.
    const membership = await requireActiveMembership(userId, tenantId);

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('Usuario no encontrado', 404);
    if (user.status === UserStatus.suspended) {
        throw new AppError('Tu cuenta esta suspendida', 403, 'ACCOUNT_SUSPENDED');
    }

    await touchMembership(userId, tenantId);

    const memberships = await listUserMemberships(userId);
    const role = membership.role;

    const accessToken = signSessionToken({
        userId: user.id,
        activeTenantId: tenantId,
        email: user.email,
        role,
        isPlatformAdmin: user.isPlatformAdmin,
    });

    await recordAuditEvent({
        action: AUDIT_ACTIONS.TENANT_SWITCHED,
        tenantId,
        userId: user.id,
        actorEmail: user.email,
        actorRole: role,
        entityType: 'session',
        entityId: tenantId,
        ipAddress,
        userAgent,
    });

    return {
        accessToken,
        role,
        tenant: {
            id: membership.tenant.id,
            name: membership.tenant.name,
            slug: membership.tenant.slug,
            platformName: membership.tenant.platformName,
            logoUrl: membership.tenant.logoUrl,
            timezone: membership.tenant.timezone,
        },
        tenants: memberships.map((m) => ({
            id: m.tenantId,
            name: m.name,
            slug: m.slug,
            platformName: m.platformName,
            logoUrl: m.logoUrl,
            role: m.role,
            status: m.status,
            isActive: m.isActive,
            lastUsedAt: m.lastUsedAt,
        })),
    };
}

/** Membresías del usuario autenticado (para el switcher de la UI). */
export async function listMyTenants(userId: string) {
    const memberships = await listUserMemberships(userId);
    return {
        tenants: memberships.map((m) => ({
            id: m.tenantId,
            name: m.name,
            slug: m.slug,
            platformName: m.platformName,
            logoUrl: m.logoUrl,
            role: m.role,
            status: m.status,
            isActive: m.isActive,
            lastUsedAt: m.lastUsedAt,
        })),
    };
}

// =============================================
// GET ME
// =============================================
export async function getMe(userId: string, activeTenantId: string | null) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const memberships = await listUserMemberships(userId);
    const tenantsView = memberships.map((m) => ({
        id: m.tenantId,
        name: m.name,
        slug: m.slug,
        platformName: m.platformName,
        logoUrl: m.logoUrl,
        role: m.role,
        status: m.status,
        isActive: m.isActive,
        lastUsedAt: m.lastUsedAt,
    }));

    // Sin tenant activo: platform admin en consola o usuario sin membresías.
    if (!activeTenantId) {
        return {
            user: {
                id: user.id, email: user.email, fullName: user.fullName,
                avatarUrl: user.avatarUrl, role: user.role, status: user.status,
                isVerified: user.isVerified, isPlatformAdmin: user.isPlatformAdmin,
                tenantId: null,
                lastLoginAt: user.lastLoginAt,
                createdAt: user.createdAt,
            },
            tenant: null,
            tenants: tenantsView,
            subscription: null,
        };
    }

    // La membresía del tenant activo manda: rol efectivo y datos del tenant.
    const membership = await requireActiveMembership(userId, activeTenantId);
    const tenant = membership.tenant;
    const role = membership.role;

    const subRows = await db.select({ sub: subscriptions, plan: plans })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, activeTenantId))
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
            avatarUrl: user.avatarUrl, role, status: user.status,
            isVerified: user.isVerified, isPlatformAdmin: user.isPlatformAdmin,
            tenantId: activeTenantId,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
        },
        tenant: {
            id: tenant.id, name: tenant.name, slug: tenant.slug,
            platformName: tenant.platformName, logoUrl: tenant.logoUrl,
            timezone: tenant.timezone,
        },
        tenants: tenantsView,
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

    await recordAuditEvent({
        action: AUDIT_ACTIONS.PASSWORD_RESET,
        tenantId: user.tenantId,
        userId: user.id,
        actorEmail: user.email,
        actorRole: user.role,
        entityType: 'user',
        entityId: user.id,
    });

    return { message: 'Contrasena actualizada exitosamente.' };
}
