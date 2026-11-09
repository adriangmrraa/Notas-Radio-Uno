import { db } from '../db/index.js';
import {
    tenants, users, userTenants, subscriptions, plans,
    adminImpersonations, auditLog, transmissions, programs,
    billingEvents, assets,
} from '../db/schema/index.js';
import { eq, and, desc, ilike, or, sql, isNull, gt, gte, count } from 'drizzle-orm';
import { AppError } from '../lib/errors.js';
import { audit } from './auditService.js';
import { applyTransition, getSubscriptionByTenant } from './subscriptionMachine.js';
import { recordEvent } from './billingEventsService.js';
import { grant as grantQuota, getQuotaStatus } from './quotaService.js';
import { getAiCostSummary } from './aiCostMeter.js';
import { setTenantFeature, deleteTenantFeature } from './featureFlagService.js';
import { notify } from './notificationService.js';
import { signAuthToken } from '../middleware/auth.js';
import { computePlatformMetrics, computeAssetApprovalRate } from './platformMetricsService.js';

// ---------------------------------------------------------------------------
// adminService — consola de operadores (T-42 / spec super-admin)
//
//   - Lista/búsqueda de tenants con plan, estado y uso del ciclo.
//   - Detalle: miembros, uso, actividad (audit), costo IA (ai_cost_records).
//   - Acciones: plan / extender trial / +N transmisiones / suspender /
//     reactivar / feature flags — TODAS emiten billing_event 'admin_grant'
//     y audit con actor.
//   - Impersonación F4: sesión 30 min en admin_impersonations + JWT imp:true;
//     inicio/fin auditados.
// ---------------------------------------------------------------------------

const IMPERSONATION_MINUTES = Number(process.env.IMPERSONATION_MINUTES ?? 30);

type Actor = { adminUserId: string; ip?: string | null; userAgent?: string | null };

// ── Lista de tenants ──────────────────────────────────────────────────────────
export async function listTenants(opts: { search?: string; limit?: number; offset?: number } = {}) {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;

    const conditions = [];
    if (opts.search) {
        const term = `%${opts.search.trim()}%`;
        conditions.push(or(ilike(tenants.name, term), ilike(tenants.slug, term)));
    }

    const rows = await db
        .select({
            id: tenants.id,
            name: tenants.name,
            slug: tenants.slug,
            isActive: tenants.isActive,
            createdAt: tenants.createdAt,
            subscriptionStatus: subscriptions.status,
            planName: plans.name,
            planDisplayName: plans.displayName,
        })
        .from(tenants)
        .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tenants.createdAt))
        .limit(limit)
        .offset(offset);

    // Uso del ciclo por tenant (período en TZ de cada tenant).
    const out = [];
    for (const t of rows) {
        const quota = await getQuotaStatus(t.id).catch(() => null);
        out.push({
            ...t,
            usage: quota ? {
                period: quota.period,
                transmissionsUsed: quota.transmissionsUsed,
                effectiveLimit: quota.effectiveLimit,
            } : null,
        });
    }
    return out;
}

// ── Detalle de tenant ─────────────────────────────────────────────────────────
export async function getTenantDetail(tenantId: string) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new AppError('Tenant no encontrado', 404);

    const [subRow] = await db.select({ sub: subscriptions, plan: plans })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);

    const members = await db.select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        role: userTenants.role,
        membershipStatus: userTenants.status,
        lastUsedAt: userTenants.lastUsedAt,
    })
        .from(userTenants)
        .innerJoin(users, eq(userTenants.userId, users.id))
        .where(eq(userTenants.tenantId, tenantId));

    const quota = await getQuotaStatus(tenantId).catch(() => null);

    const recentTransmissions = await db.select({
        id: transmissions.id,
        status: transmissions.status,
        startedAt: transmissions.startedAt,
        createdAt: transmissions.createdAt,
    })
        .from(transmissions)
        .where(eq(transmissions.tenantId, tenantId))
        .orderBy(desc(transmissions.createdAt))
        .limit(10);

    const [programCount] = await db.select({ n: count() }).from(programs)
        .where(eq(programs.tenantId, tenantId));

    const recentActivity = await db.select({
        action: auditLog.action,
        userId: auditLog.userId,
        createdAt: auditLog.createdAt,
        metadata: auditLog.metadata,
    })
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenantId))
        .orderBy(desc(auditLog.createdAt))
        .limit(30);

    const aiCost = await getAiCostSummary(tenantId).catch(() => null);

    return {
        tenant,
        subscription: subRow?.sub ?? null,
        plan: subRow?.plan ?? null,
        members,
        quota,
        recentTransmissions,
        programCount: programCount?.n ?? 0,
        recentActivity,
        aiCost,
    };
}

// ── Acción: cambiar plan ──────────────────────────────────────────────────────
export async function adminSetPlan(tenantId: string, planName: string, actor: Actor) {
    const [plan] = await db.select().from(plans).where(eq(plans.name, planName)).limit(1);
    if (!plan) throw new AppError(`Plan '${planName}' no existe`, 404);

    let sub = await getSubscriptionByTenant(tenantId);
    if (!sub) {
        // Sin suscripción: crear fila semilla en trialing → máquina.
        const [created] = await db.insert(subscriptions)
            .values({ tenantId, planId: plan.id, status: 'trialing' })
            .returning();
        sub = created;
    }

    // Mapeo de acción admin → evento de máquina válido por estado actual.
    const current = sub.status;
    const ctx = {
        planId: plan.id,
        frozenPrice: plan.priceUsd,
        frozenCurrency: 'USD',
        provider: 'admin',
        actor: `admin:${actor.adminUserId}`,
        eventType: 'admin_grant',
    } as const;

    if (current === 'trialing') {
        // Trial vigente: cambiar plan NO convierte el trial — solo se actualiza
        // planId/precio (campos no-status; el status sigue siendo 'trialing').
        // La conversión real la hace checkout_completed cuando el tenant paga.
        await db.update(subscriptions)
            .set({ planId: plan.id, frozenPrice: plan.priceUsd, frozenCurrency: 'USD' })
            .where(eq(subscriptions.id, sub.id));
        await recordEvent({
            tenantId,
            subscriptionId: sub.id,
            type: 'admin_grant',
            provider: 'admin',
            payload: { action: 'set_plan', planName, statusKept: 'trialing' },
        });
        void audit({
            tenantId,
            actorUserId: actor.adminUserId,
            action: 'admin.plan_changed',
            ip: actor.ip,
            userAgent: actor.userAgent,
            metadata: { planName, previousStatus: current, statusKept: 'trialing' },
        });
        return { message: `Plan actualizado a ${plan.displayName} (trial sigue vigente)`, status: 'trialing' };
    }

    let applied;
    if (current === 'active' || current === 'past_due') {
        applied = await applyTransition(sub.id, 'plan_changed', { ...ctx, planId: plan.id });
    } else if (current === 'suspended') {
        await applyTransition(sub.id, 'admin_reactivate', ctx);
        applied = await applyTransition(sub.id, 'plan_changed', { ...ctx, planId: plan.id });
    } else {
        // canceled/expired → re-suscripción administrada (edge checkout_completed
        // con eventType admin_grant: queda el billing_event correcto).
        applied = await applyTransition(sub.id, 'checkout_completed', ctx);
    }

    if (!applied.applied) {
        throw new AppError(`No se pudo cambiar el plan desde estado '${current}': ${applied.reason}`, 409);
    }

    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.plan_changed',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { planName, previousStatus: current },
    });
    return { message: `Plan actualizado a ${plan.displayName}`, status: applied.nextStatus };
}

// ── Acción: extender trial ────────────────────────────────────────────────────
export async function adminExtendTrial(tenantId: string, days: number, actor: Actor) {
    if (!Number.isFinite(days) || days <= 0 || days > 90) {
        throw new AppError('days debe ser un número entre 1 y 90', 400);
    }
    const sub = await getSubscriptionByTenant(tenantId);
    if (!sub) throw new AppError('El tenant no tiene suscripción', 404);
    if (sub.status !== 'trialing') {
        throw new AppError(`Solo se puede extender un trial vigente (estado actual: ${sub.status})`, 409);
    }

    const base = sub.trialEndsAt && sub.trialEndsAt > new Date() ? sub.trialEndsAt : new Date();
    const newEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
    await db.update(subscriptions).set({ trialEndsAt: newEnd }).where(eq(subscriptions.id, sub.id));

    await recordEvent({
        tenantId,
        subscriptionId: sub.id,
        type: 'admin_grant',
        provider: 'admin',
        payload: { action: 'extend_trial', days, newTrialEndsAt: newEnd },
    });
    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.trial_extended',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { days, newTrialEndsAt: newEnd },
    });
    return { message: `Trial extendido ${days} días`, trialEndsAt: newEnd };
}

// ── Acción: +N transmisiones (crédito del ciclo) ─────────────────────────────
export async function adminGrantTransmissions(tenantId: string, n: number, actor: Actor) {
    if (!Number.isFinite(n) || n <= 0 || n > 500) {
        throw new AppError('n debe ser un número entre 1 y 500', 400);
    }
    const result = await grantQuota(tenantId, n, actor.adminUserId);

    const sub = await getSubscriptionByTenant(tenantId);
    await recordEvent({
        tenantId,
        subscriptionId: sub?.id ?? null,
        type: 'admin_grant',
        provider: 'admin',
        payload: { action: 'grant_transmissions', n, period: result.period },
    });
    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.transmissions_granted',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { n, period: result.period, extraTransmissions: result.extraTransmissions },
    });
    await notify({
        tenantId,
        type: 'admin_grant',
        title: `Recibiste +${n} transmisiones`,
        message: `La plataforma acreditó ${n} transmisiones extra en tu ciclo ${result.period}.`,
        icon: '🎁',
    }).catch(() => undefined);

    return { message: `+${n} transmisiones acreditadas`, ...result };
}

// ── Acción: suspender / reactivar tenant ─────────────────────────────────────
export async function adminSuspendTenant(tenantId: string, reason: string | null, actor: Actor) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new AppError('Tenant no encontrado', 404);
    if (!tenant.isActive) throw new AppError('El tenant ya está suspendido', 409);

    await db.update(tenants)
        .set({ isActive: false, suspendedAt: new Date(), suspensionReason: reason })
        .where(eq(tenants.id, tenantId));

    const sub = await getSubscriptionByTenant(tenantId);
    if (sub) {
        await applyTransition(sub.id, 'admin_suspend', {
            provider: 'admin',
            actor: `admin:${actor.adminUserId}`,
            payload: { reason },
        }).catch((e) => console.warn('[Admin] admin_suspend transition:', e));
    }

    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.tenant_suspended',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { reason },
    });
    return { message: 'Tenant suspendido. Sus usuarios reciben 403 al operar; la transmisión en vivo (si hay) termina su curso.' };
}

export async function adminReactivateTenant(tenantId: string, actor: Actor) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new AppError('Tenant no encontrado', 404);
    if (tenant.isActive) throw new AppError('El tenant ya está activo', 409);

    await db.update(tenants)
        .set({ isActive: true, suspendedAt: null, suspensionReason: null })
        .where(eq(tenants.id, tenantId));

    const sub = await getSubscriptionByTenant(tenantId);
    if (sub && sub.status === 'suspended') {
        await applyTransition(sub.id, 'admin_reactivate', {
            provider: 'admin',
            actor: `admin:${actor.adminUserId}`,
        }).catch((e) => console.warn('[Admin] admin_reactivate transition:', e));
    }

    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.tenant_reactivated',
        ip: actor.ip,
        userAgent: actor.userAgent,
    });
    return { message: 'Tenant reactivado' };
}

// ── Acción: feature flags ────────────────────────────────────────────────────
export async function adminSetFeature(
    tenantId: string,
    key: string,
    value: unknown,
    expiresAt: Date | null,
    actor: Actor,
) {
    await setTenantFeature(tenantId, key, value, { expiresAt, setBy: actor.adminUserId });
    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.feature_set',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { key, value, expiresAt },
    });
    return { message: `Feature '${key}' actualizada` };
}

export async function adminDeleteFeature(tenantId: string, key: string, actor: Actor) {
    await deleteTenantFeature(tenantId, key);
    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.feature_deleted',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { key },
    });
    return { message: `Feature '${key}' eliminada (cae al plan/default)` };
}

// ── Audit del tenant (vista admin) ───────────────────────────────────────────
export async function getTenantAudit(tenantId: string, limit = 50) {
    return db.select().from(auditLog)
        .where(eq(auditLog.tenantId, tenantId))
        .orderBy(desc(auditLog.createdAt))
        .limit(Math.min(limit, 200));
}

// ── Impersonación (F4): 30 min, guard anti-destructive, audit inicio/fin ──────
export async function startImpersonation(tenantId: string, actor: Actor) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new AppError('Tenant no encontrado', 404);

    // "Impersonar a otro admin" prohibido (spec): si el owner del tenant es
    // platform admin, la impersonación queda rechazada.
    if (tenant.ownerId) {
        const [owner] = await db.select({ isPlatformAdmin: users.isPlatformAdmin })
            .from(users).where(eq(users.id, tenant.ownerId)).limit(1);
        if (owner?.isPlatformAdmin) {
            void audit({
                tenantId,
                actorUserId: actor.adminUserId,
                action: 'admin.impersonation_rejected',
                ip: actor.ip,
                metadata: { reason: 'target_is_platform_admin' },
            });
            throw new AppError('No se puede impersonar a otro operador de plataforma', 403, 'TARGET_IS_ADMIN');
        }
    }

    // Cerrar sesiones abiertas previas del mismo admin (higiene).
    await db.update(adminImpersonations)
        .set({ endedAt: new Date() })
        .where(and(
            eq(adminImpersonations.adminUserId, actor.adminUserId),
            isNull(adminImpersonations.endedAt),
        ));

    const expiresAt = new Date(Date.now() + IMPERSONATION_MINUTES * 60 * 1000);
    const [session] = await db.insert(adminImpersonations).values({
        adminUserId: actor.adminUserId,
        tenantId,
        expiresAt,
    }).returning();

    const [admin] = await db.select({ email: users.email }).from(users)
        .where(eq(users.id, actor.adminUserId)).limit(1);

    const accessToken = signAuthToken({
        userId: actor.adminUserId,
        activeTenantId: tenantId,
        email: admin?.email ?? '',
        role: 'owner',
        isPlatformAdmin: false, // durante impersonación NO opera /api/admin
        imp: true,
        impersonatedBy: actor.adminUserId,
        impersonationId: session.id,
        // expiresIn en segundos (number) — evita el tipo ms.StringValue.
    }, IMPERSONATION_MINUTES * 60);

    void audit({
        tenantId,
        actorUserId: actor.adminUserId,
        action: 'admin.impersonation_started',
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { impersonationId: session.id, expiresAt, impersonatedBy: actor.adminUserId },
    });

    return {
        accessToken,
        impersonationId: session.id,
        expiresAt,
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
}

export async function stopImpersonation(impersonationId: string, actorUserId: string) {
    const [session] = await db.select().from(adminImpersonations)
        .where(and(
            eq(adminImpersonations.id, impersonationId),
            eq(adminImpersonations.adminUserId, actorUserId),
            isNull(adminImpersonations.endedAt),
        ))
        .limit(1);
    if (!session) throw new AppError('Sesion de impersonacion no encontrada o ya cerrada', 404);

    await db.update(adminImpersonations)
        .set({ endedAt: new Date() })
        .where(eq(adminImpersonations.id, session.id));

    void audit({
        tenantId: session.tenantId,
        actorUserId,
        action: 'admin.impersonation_ended',
        metadata: { impersonationId: session.id, impersonatedBy: actorUserId },
    });
    return { message: 'Impersonacion finalizada' };
}

export async function listImpersonations(limit = 50) {
    return db.select({
        id: adminImpersonations.id,
        adminUserId: adminImpersonations.adminUserId,
        adminEmail: users.email,
        tenantId: adminImpersonations.tenantId,
        tenantName: tenants.name,
        startedAt: adminImpersonations.startedAt,
        expiresAt: adminImpersonations.expiresAt,
        endedAt: adminImpersonations.endedAt,
    })
        .from(adminImpersonations)
        .leftJoin(users, eq(adminImpersonations.adminUserId, users.id))
        .leftJoin(tenants, eq(adminImpersonations.tenantId, tenants.id))
        .orderBy(desc(adminImpersonations.startedAt))
        .limit(limit);
}

// ── Métricas globales de plataforma (loader + funciones puras) ───────────────
export async function getPlatformMetrics() {
    const [subs, events, txCounts, assetRows, aiCostByTenant] = await Promise.all([
        db.select({
            status: subscriptions.status,
            frozenPrice: subscriptions.frozenPrice,
            frozenCurrency: subscriptions.frozenCurrency,
            canceledAt: subscriptions.canceledAt,
            createdAt: subscriptions.createdAt,
        }).from(subscriptions),
        db.select({
            type: billingEvents.type,
            tenantId: billingEvents.tenantId,
            createdAt: billingEvents.createdAt,
        }).from(billingEvents)
            .where(gte(billingEvents.createdAt, new Date(Date.now() - 400 * 24 * 60 * 60 * 1000))),
        db.select({ n: count() }).from(transmissions),
        db.select({ status: assets.status }).from(assets),
        db.execute(sql`
            SELECT "tenant_id" AS "tenantId", SUM("cost_estimate_usd"::numeric) AS "totalUsd"
            FROM "ai_cost_records"
            GROUP BY "tenant_id"
            ORDER BY "totalUsd" DESC
            LIMIT 20
        `),
    ]);

    const metrics = computePlatformMetrics({ subscriptions: subs, billingEvents: events });
    return {
        ...metrics,
        transmissionsTotal: txCounts[0]?.n ?? 0,
        assetApprovalRate: computeAssetApprovalRate(assetRows),
        topAiCostTenants: (aiCostByTenant.rows as { tenantId: string; totalUsd: string }[])
            .map((r) => ({ tenantId: r.tenantId, totalUsd: Number(r.totalUsd) })),
    };
}
