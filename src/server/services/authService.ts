import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail } from './emailService.js';
import slugify from 'slugify';
import { UserRole, UserStatus } from '../db/schema/enums.js';
import { users, tenants, subscriptions, plans, userTenants } from '../db/schema/index.js';
import { audit } from './auditService.js';
import { recordEvent } from './billingEventsService.js';
import { applyTransition } from './subscriptionMachine.js';
import { signAuthToken } from '../middleware/auth.js';
import { eq, and, desc, asc } from 'drizzle-orm';

const BCRYPT_ROUNDS = 12;
const VERIFICATION_TOKEN_TTL_HOURS = 48;
const RESET_TOKEN_TTL_HOURS = 1;
const TRIAL_DAYS = 7;

// ---------------------------------------------------------------------------
// authService — multi-tenant (B-2 / D8)
// - register crea tenant + membresía owner en user_tenants (users.tenantId
//   queda deprecado — NO se escribe, D11)
// - login devuelve JWT con activeTenantId + lista tenants[] para el switcher
// - switchTenant re-emite JWT con otro tenant activo (+ last_used_at)
// ---------------------------------------------------------------------------

export interface MembershipInfo {
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    role: UserRole;
    lastUsedAt: Date | null;
    isActive: boolean;
}

/** Lista las membresías activas del usuario con datos del tenant. */
export async function listMemberships(userId: string): Promise<MembershipInfo[]> {
    const rows = await db.select({
        tenantId: userTenants.tenantId,
        role: userTenants.role,
        lastUsedAt: userTenants.lastUsedAt,
        tenantName: tenants.name,
        tenantSlug: tenants.slug,
        isActive: tenants.isActive,
    })
        .from(userTenants)
        .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
        .where(and(eq(userTenants.userId, userId), eq(userTenants.status, 'active')))
        .orderBy(desc(userTenants.lastUsedAt), asc(userTenants.createdAt));

    return rows.map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        tenantSlug: r.tenantSlug,
        role: r.role,
        lastUsedAt: r.lastUsedAt,
        isActive: r.isActive,
    }));
}

/** Elige el tenant activo por default: el último usado, o el primero. */
function pickActiveMembership(memberships: MembershipInfo[]): MembershipInfo | null {
    return memberships[0] ?? null;
}

// =============================================
// REGISTRO → tenant + user + membresía owner
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
            // users.tenantId DEPRECADO (D11): la membresía vive en user_tenants.
            role: UserRole.owner,
            status: isDev ? UserStatus.active : UserStatus.pending,
            isVerified: isDev ? true : false,
            verificationToken: isDev ? null : verificationToken,
            verificationTokenExpiresAt: isDev ? null : tokenExpires,
        }).returning();

        // Membresía owner — reemplaza users.tenantId (B-2).
        await tx.insert(userTenants).values({
            userId: user.id,
            tenantId: tenant.id,
            role: UserRole.owner,
            status: 'active',
            lastUsedAt: new Date(),
        });

        await tx.update(tenants)
            .set({ ownerId: user.id })
            .where(eq(tenants.id, tenant.id));

        const [trialPlan] = await tx.select().from(plans).where(eq(plans.name, 'trial')).limit(1);
        if (trialPlan) {
            await tx.insert(subscriptions).values({
                tenantId: tenant.id,
                planId: trialPlan.id,
                status: 'trialing',
                trialEndsAt: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
            });
        }

        return { userId: user.id, tenantId: tenant.id, verificationToken };
    });

    sendVerificationEmail(normalizedEmail, fullName, result.verificationToken).catch(console.error);

    void audit({
        tenantId: result.tenantId,
        actorUserId: result.userId,
        action: 'auth.register',
        metadata: { email: normalizedEmail },
    });
    void recordEvent({
        tenantId: result.tenantId,
        type: 'trial_started',
        provider: 'system',
        payload: { email: normalizedEmail, trialDays: TRIAL_DAYS },
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

    const [membership] = await db.select({ tenantId: userTenants.tenantId })
        .from(userTenants)
        .where(eq(userTenants.userId, user.id))
        .limit(1);

    void audit({
        tenantId: membership?.tenantId ?? null,
        actorUserId: user.id,
        action: 'auth.email_verified',
    });

    return { message: 'Email verificado exitosamente. Ya puedes iniciar sesion.' };
}

// =============================================
// LOGIN → JWT multi-tenant + tenants[]
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
        void audit({
            actorUserId: user.id,
            action: 'auth.login_failed',
            ip: ipAddress,
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

    const memberships = await listMemberships(user.id);
    const active = pickActiveMembership(memberships);

    // Tenant suspendido por plataforma → no puede ser activo (spec edge).
    const effectiveActive = active?.isActive ? active : (memberships.find((m) => m.isActive) ?? null);

    if (effectiveActive) {
        await db.update(userTenants)
            .set({ lastUsedAt: new Date() })
            .where(and(
                eq(userTenants.userId, user.id),
                eq(userTenants.tenantId, effectiveActive.tenantId),
            ));
    }

    const accessToken = signAuthToken({
        userId: user.id,
        activeTenantId: effectiveActive?.tenantId ?? null,
        email: user.email,
        role: effectiveActive?.role ?? UserRole.viewer,
        isPlatformAdmin: user.isPlatformAdmin,
    });

    await db.update(users)
        .set({ lastLoginAt: new Date() })
        .where(eq(users.id, user.id));

    void audit({
        tenantId: effectiveActive?.tenantId ?? null,
        actorUserId: user.id,
        action: 'auth.login_success',
        ip: ipAddress,
        userAgent,
    });

    // Tenant activo con datos completos para la respuesta (compat con cliente).
    let tenantPayload: Record<string, unknown> | null = null;
    if (effectiveActive) {
        const [t] = await db.select().from(tenants).where(eq(tenants.id, effectiveActive.tenantId)).limit(1);
        if (t) {
            tenantPayload = {
                id: t.id, name: t.name, slug: t.slug,
                platformName: t.platformName, logoUrl: t.logoUrl, timezone: t.timezone,
            };
        }
    }

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            role: effectiveActive?.role ?? user.role, status: user.status,
            isVerified: user.isVerified, isPlatformAdmin: user.isPlatformAdmin,
        },
        tenant: tenantPayload,
        /** Lista de tenants del usuario para el switcher (spec multi-tenant-auth). */
        tenants: memberships.map((m) => ({
            tenantId: m.tenantId,
            name: m.tenantName,
            slug: m.tenantSlug,
            role: m.role,
            isActive: m.isActive,
            active: m.tenantId === effectiveActive?.tenantId,
        })),
        accessToken,
    };
}

// =============================================
// SWITCH TENANT → nuevo JWT con otro tenant activo
// =============================================
export async function switchTenant(userId: string, targetTenantId: string) {
    const [membership] = await db.select({
        role: userTenants.role,
        tenantName: tenants.name,
        isActive: tenants.isActive,
    })
        .from(userTenants)
        .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
        .where(and(
            eq(userTenants.userId, userId),
            eq(userTenants.tenantId, targetTenantId),
            eq(userTenants.status, 'active'),
        ))
        .limit(1);

    if (!membership) {
        throw new AppError('No tienes membresia en ese tenant', 403, 'NOT_A_MEMBER');
    }
    if (!membership.isActive) {
        throw new AppError('Este tenant esta suspendido', 403, 'TENANT_SUSPENDED');
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    await db.update(userTenants)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, targetTenantId)));

    const accessToken = signAuthToken({
        userId: user.id,
        activeTenantId: targetTenantId,
        email: user.email,
        role: membership.role,
        isPlatformAdmin: user.isPlatformAdmin,
    });

    void audit({
        tenantId: targetTenantId,
        actorUserId: userId,
        action: 'auth.switch_tenant',
        metadata: { tenantName: membership.tenantName },
    });

    return { accessToken, activeTenantId: targetTenantId };
}

// =============================================
// GET ME — user + tenant activo + tenants[] + suscripción
// =============================================
export async function getMe(userId: string, activeTenantId?: string | null) {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const memberships = await listMemberships(userId);
    const active = activeTenantId
        ? (memberships.find((m) => m.tenantId === activeTenantId) ?? null)
        : pickActiveMembership(memberships);

    let tenant: typeof tenants.$inferSelect | null = null;
    if (active) {
        const [t] = await db.select().from(tenants).where(eq(tenants.id, active.tenantId)).limit(1);
        tenant = t ?? null;
    }

    let subscription: typeof subscriptions.$inferSelect | null = null;
    let plan: typeof plans.$inferSelect | null = null;
    if (tenant) {
        const subRows = await db.select({ sub: subscriptions, plan: plans })
            .from(subscriptions)
            .leftJoin(plans, eq(subscriptions.planId, plans.id))
            .where(eq(subscriptions.tenantId, tenant.id))
            .limit(1);
        subscription = subRows[0]?.sub ?? null;
        plan = subRows[0]?.plan ?? null;
    }

    let trialDaysRemaining: number | null = null;
    if (subscription?.status === 'trialing' && subscription.trialEndsAt) {
        const msRemaining = subscription.trialEndsAt.getTime() - Date.now();
        trialDaysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
        if (trialDaysRemaining === 0) {
            await applyTransition(subscription.id, 'trial_expired', {
                provider: 'system',
                actor: 'system:getMe',
            }).catch(() => undefined);
            subscription.status = 'expired';
        }
    }

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            avatarUrl: user.avatarUrl, role: active?.role ?? user.role, status: user.status,
            isVerified: user.isVerified, isPlatformAdmin: user.isPlatformAdmin,
            lastLoginAt: user.lastLoginAt, createdAt: user.createdAt,
        },
        tenant: tenant ? {
            id: tenant.id, name: tenant.name, slug: tenant.slug,
            platformName: tenant.platformName, logoUrl: tenant.logoUrl,
            timezone: tenant.timezone, config: tenant.config,
        } : null,
        /** Membresías para el switcher multi-tenant (B-2). */
        tenants: memberships.map((m) => ({
            tenantId: m.tenantId,
            name: m.tenantName,
            slug: m.tenantSlug,
            role: m.role,
            isActive: m.isActive,
            active: m.tenantId === active?.tenantId,
        })),
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
                maxTransmissionsPerMonth: plan.maxTransmissionsPerMonth,
                maxDurationMinutes: plan.maxDurationMinutes,
                maxClipsPerTransmission: plan.maxClipsPerTransmission,
                maxPersons: plan.maxPersons,
                retentionDays: plan.retentionDays,
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

    const [membership] = await db.select({ tenantId: userTenants.tenantId })
        .from(userTenants)
        .where(eq(userTenants.userId, user.id))
        .limit(1);

    void audit({
        tenantId: membership?.tenantId ?? null,
        actorUserId: user.id,
        action: 'auth.password_reset',
    });

    return { message: 'Contrasena actualizada exitosamente.' };
}
