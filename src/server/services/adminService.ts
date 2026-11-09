/**
 * adminService.ts — Operaciones de super admin de plataforma
 *
 * Todo lo de acá es cross-tenant por definición: el filtro NO es `tenant_id`
 * sino el guard `requirePlatformAdmin` de la ruta + auditoría de cada acción.
 * Nunca se expone a usuarios de tenant.
 */

import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  invoices,
  plans,
  subscriptions,
  tenantFeatures,
  tenants,
  usageRecords,
  users,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import jwt from 'jsonwebtoken';
import { impersonationSessions } from '../db/schema/index.js';
import { recordAuditEvent, AUDIT_ACTIONS } from './auditService.js';
import { syncTenantFeaturesForTenant, setFeatureFlag, resetFeatureOverride } from './tenantFeaturesService.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// ── KPIs de plataforma ────────────────────────────────────────────────────────

export interface PlatformStats {
  tenants: { total: number; active: number; suspended: number; newLast30d: number };
  users: { total: number; active: number; platformAdmins: number };
  subscriptions: { byStatus: Record<string, number>; trialing: number; active: number };
  revenue: { activeMrrUsd: number };
  usage: { publications30d: number; pipelineHours30d: number };
}

export async function getPlatformStats(): Promise<PlatformStats> {
  const [tenantTotals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${tenants.isActive} = true)::int`,
      suspended: sql<number>`count(*) filter (where ${tenants.isActive} = false)::int`,
      newLast30d: sql<number>`count(*) filter (where ${tenants.createdAt} > now() - interval '30 days')::int`,
    })
    .from(tenants);

  const [userTotals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${users.status} = 'active')::int`,
      platformAdmins: sql<number>`count(*) filter (where ${users.isPlatformAdmin} = true)::int`,
    })
    .from(users);

  const statusRows = await db
    .select({ status: subscriptions.status, total: sql<number>`count(*)::int` })
    .from(subscriptions)
    .groupBy(subscriptions.status);

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) byStatus[row.status] = row.total;

  // MRR estimado: suma del precio mensual de los planes con suscripción activa.
  const [mrr] = await db
    .select({ total: sql<string>`coalesce(sum(${plans.priceUsd}), 0)` })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.status, 'active'));

  const [usage30d] = await db
    .select({
      publications: sql<number>`coalesce(sum(${usageRecords.publicationsCount}), 0)::int`,
      hours: sql<string>`coalesce(sum(${usageRecords.pipelineHoursUsed}), 0)`,
    })
    .from(usageRecords)
    .where(sql`${usageRecords.periodStart} >= (current_date - interval '30 days')`);

  return {
    tenants: tenantTotals ?? { total: 0, active: 0, suspended: 0, newLast30d: 0 },
    users: userTotals ?? { total: 0, active: 0, platformAdmins: 0 },
    subscriptions: {
      byStatus,
      trialing: byStatus.trialing ?? 0,
      active: byStatus.active ?? 0,
    },
    revenue: { activeMrrUsd: Number(mrr?.total ?? 0) },
    usage: {
      publications30d: usage30d?.publications ?? 0,
      pipelineHours30d: Number(usage30d?.hours ?? 0),
    },
  };
}

// ── Listado de tenants ────────────────────────────────────────────────────────

export interface AdminTenantRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: Date;
  ownerEmail: string | null;
  ownerName: string | null;
  planName: string | null;
  planDisplayName: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  usersCount: number;
  publicationsThisCycle: number;
  enabledFeatures: number;
}

export interface ListTenantsInput {
  search?: string;
  status?: 'all' | 'active' | 'suspended' | 'trialing';
  page?: number;
  pageSize?: number;
}

export async function listTenants(input: ListTenantsInput = {}): Promise<{
  tenants: AdminTenantRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
  const offset = (page - 1) * pageSize;
  const search = input.search?.trim();

  const owner = sql<string | null>`(select u.email from users u where u.id = ${tenants.ownerId} limit 1)`;
  const ownerName = sql<string | null>`(select u.full_name from users u where u.id = ${tenants.ownerId} limit 1)`;
  const usersCount = sql<number>`(select count(*)::int from users u where u.tenant_id = ${tenants.id})`;
  const enabledFeatures = sql<number>`(select count(*)::int from tenant_features tf where tf.tenant_id = ${tenants.id} and tf.enabled = true)`;
  const publications = sql<number>`(
    select coalesce(sum(ur.publications_count), 0)::int
    from usage_records ur
    where ur.tenant_id = ${tenants.id}
      and ur.period_start >= date_trunc('month', current_date)::date
  )`;

  const conditions = [];
  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        ilike(tenants.name, term),
        ilike(tenants.slug, term),
        sql`exists (select 1 from users u where u.tenant_id = ${tenants.id} and u.email ilike ${term})`,
      )!,
    );
  }
  if (input.status === 'active') conditions.push(eq(tenants.isActive, true));
  if (input.status === 'suspended') conditions.push(eq(tenants.isActive, false));
  if (input.status === 'trialing') conditions.push(eq(subscriptions.status, 'trialing'));

  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      isActive: tenants.isActive,
      createdAt: tenants.createdAt,
      ownerEmail: owner,
      ownerName: ownerName,
      planName: plans.name,
      planDisplayName: plans.displayName,
      subscriptionStatus: subscriptions.status,
      trialEndsAt: subscriptions.trialEndsAt,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      usersCount,
      publicationsThisCycle: publications,
      enabledFeatures,
    })
    .from(tenants)
    .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(where)
    .orderBy(desc(tenants.createdAt))
    .limit(pageSize)
    .offset(offset);

  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(tenants)
    .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
    .where(where);

  return {
    tenants: rows.map((r) => ({
      ...r,
      usersCount: Number(r.usersCount ?? 0),
      publicationsThisCycle: Number(r.publicationsThisCycle ?? 0),
      enabledFeatures: Number(r.enabledFeatures ?? 0),
    })),
    total: countRow?.total ?? 0,
    page,
    pageSize,
  };
}

// ── Detalle de tenant (PA-08) ─────────────────────────────────────────────────

export async function getTenantDetail(tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new AppError('Tenant no encontrado', 404, 'TENANT_NOT_FOUND');

  const tenantUsers = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .orderBy(users.createdAt);

  const [subRow] = await db
    .select({ subscription: subscriptions, plan: plans })
    .from(subscriptions)
    .leftJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, tenantId))
    .limit(1);

  const featureRows = await db
    .select()
    .from(tenantFeatures)
    .where(eq(tenantFeatures.tenantId, tenantId))
    .orderBy(tenantFeatures.featureKey);

  const [usage] = await db
    .select({
      publications: sql<number>`coalesce(sum(${usageRecords.publicationsCount}), 0)::int`,
      pipelineHours: sql<string>`coalesce(sum(${usageRecords.pipelineHoursUsed}), 0)`,
      transcriptionMinutes: sql<string>`coalesce(sum(${usageRecords.transcriptionMinutes}), 0)`,
      aiTokens: sql<number>`coalesce(sum(${usageRecords.aiTokensUsed}), 0)::bigint`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.tenantId, tenantId),
        sql`${usageRecords.periodStart} >= date_trunc('month', current_date)::date`,
      ),
    );

  const [invoiceAgg] = await db
    .select({
      paid: sql<string>`coalesce(sum(${invoices.amount}) filter (where ${invoices.status} = 'paid'), 0)`,
      pending: sql<string>`coalesce(sum(${invoices.amount}) filter (where ${invoices.status} = 'pending'), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .where(eq(invoices.tenantId, tenantId));

  const aiTokens = Number(usage?.aiTokens ?? 0);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      isActive: tenant.isActive,
      timezone: tenant.timezone,
      createdAt: tenant.createdAt,
      config: tenant.config,
    },
    users: tenantUsers,
    subscription: subRow?.subscription
      ? {
          id: subRow.subscription.id,
          status: subRow.subscription.status,
          planName: subRow.plan?.name ?? null,
          planDisplayName: subRow.plan?.displayName ?? null,
          trialEndsAt: subRow.subscription.trialEndsAt,
          currentPeriodStart: subRow.subscription.currentPeriodStart,
          currentPeriodEnd: subRow.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subRow.subscription.cancelAtPeriodEnd,
          limits: subRow.plan
            ? {
                maxPipelineHoursPerMonth: subRow.plan.maxPipelineHoursPerMonth,
                maxPublicationsPerMonth: subRow.plan.maxPublicationsPerMonth,
                maxTeamMembers: subRow.plan.maxTeamMembers,
                maxStorageGb: subRow.plan.maxStorageGb,
              }
            : null,
        }
      : null,
    features: featureRows,
    usageThisCycle: {
      publications: usage?.publications ?? 0,
      pipelineHours: Number(usage?.pipelineHours ?? 0),
      transcriptionMinutes: Number(usage?.transcriptionMinutes ?? 0),
      aiTokens,
      // Estimación de costo IA: tarifa plana de referencia sobre tokens.
      estimatedAiCostUsd: Number(((aiTokens / 1_000_000) * 0.6).toFixed(2)),
    },
    billing: {
      paidUsd: Number(invoiceAgg?.paid ?? 0),
      pendingUsd: Number(invoiceAgg?.pending ?? 0),
      invoicesCount: invoiceAgg?.count ?? 0,
    },
    activity: await getTenantActivity(tenantId),
  };
}

/** Últimos eventos de auditoría del tenant (lo que ve el super admin). */
export async function getTenantActivity(tenantId: string, limit = 20) {
  const { auditLog } = await import('../db/schema/index.js');
  return db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      outcome: auditLog.outcome,
      actorEmail: auditLog.actorEmail,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantId))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

/** Búsqueda rápida de tenants para el comandante (usada por el buscador). */
export async function searchTenantIds(term: string): Promise<string[]> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(or(ilike(tenants.name, `%${term}%`), ilike(tenants.slug, `%${term}%`)))
    .limit(10);
  return rows.map((r) => r.id);
}

/** Tenants por ids — usado por operaciones masivas del admin. */
export async function getTenantsByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return db.select().from(tenants).where(inArray(tenants.id, ids));
}

// ── Acciones de super admin (PA-09) ───────────────────────────────────────────

async function getTenantOrThrow(tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new AppError('Tenant no encontrado', 404, 'TENANT_NOT_FOUND');
  return tenant;
}

export async function changeTenantPlan(input: {
  tenantId: string;
  planName: string;
  actorUserId: string;
}): Promise<{ planName: string }> {
  await getTenantOrThrow(input.tenantId);

  const [plan] = await db.select().from(plans).where(eq(plans.name, input.planName)).limit(1);
  if (!plan) throw new AppError('Plan no encontrado', 404, 'PLAN_NOT_FOUND');

  const [existing] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, input.tenantId)).limit(1);

  if (existing) {
    await db.update(subscriptions).set({ planId: plan.id }).where(eq(subscriptions.id, existing.id));
  } else {
    await db.insert(subscriptions).values({
      tenantId: input.tenantId,
      planId: plan.id,
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  }

  // Los features del plan se recalculan; los overrides se respetan.
  await syncTenantFeaturesForTenant(input.tenantId);

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_PLAN_CHANGED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'subscription',
    entityId: existing?.id ?? null,
    metadata: { from: existing?.planId ?? null, to: plan.name },
  });

  return { planName: plan.name };
}

export async function extendTenantTrial(input: {
  tenantId: string;
  days: number;
  actorUserId: string;
}): Promise<{ trialEndsAt: Date }> {
  await getTenantOrThrow(input.tenantId);
  const days = Math.max(1, Math.min(90, Math.round(input.days)));

  const [existing] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, input.tenantId)).limit(1);

  const base = existing?.trialEndsAt && existing.trialEndsAt > new Date() ? existing.trialEndsAt : new Date();
  const trialEndsAt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  if (existing) {
    await db.update(subscriptions)
      .set({ trialEndsAt, status: existing.status === 'expired' ? 'trialing' : existing.status })
      .where(eq(subscriptions.id, existing.id));
  } else {
    const [trialPlan] = await db.select().from(plans).where(eq(plans.name, 'trial')).limit(1);
    if (!trialPlan) throw new AppError('No existe el plan trial para crear la suscripción', 409, 'NO_TRIAL_PLAN');
    await db.insert(subscriptions).values({
      tenantId: input.tenantId,
      planId: trialPlan.id,
      status: 'trialing',
      trialEndsAt,
    });
    await syncTenantFeaturesForTenant(input.tenantId);
  }

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_TRIAL_EXTENDED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'subscription',
    entityId: existing?.id ?? null,
    metadata: { days, trialEndsAt },
  });

  return { trialEndsAt };
}

/**
 * Otorga transmisiones extra al ciclo actual. El consumo real lo hace Épica B
 * (metering); acá se guarda el crédito en `tenants.config.extraTransmissions`.
 */
export async function grantExtraTransmissions(input: {
  tenantId: string;
  count: number;
  actorUserId: string;
}): Promise<{ extraTransmissions: number }> {
  const tenant = await getTenantOrThrow(input.tenantId);
  const count = Math.max(1, Math.min(100, Math.round(input.count)));
  const config = (tenant.config && typeof tenant.config === 'object' ? tenant.config : {}) as Record<string, unknown>;
  const current = typeof config.extraTransmissions === 'number' ? config.extraTransmissions : 0;
  const extraTransmissions = current + count;

  await db.update(tenants)
    .set({ config: { ...config, extraTransmissions } })
    .where(eq(tenants.id, input.tenantId));

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_QUOTA_GRANTED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'tenant',
    entityId: input.tenantId,
    metadata: { count, extraTransmissions },
  });

  return { extraTransmissions };
}

export async function setTenantSuspended(input: {
  tenantId: string;
  suspended: boolean;
  reason?: string;
  actorUserId: string;
}): Promise<void> {
  await getTenantOrThrow(input.tenantId);

  await db.update(tenants).set({ isActive: !input.suspended }).where(eq(tenants.id, input.tenantId));

  const [existing] = await db.select().from(subscriptions)
    .where(eq(subscriptions.tenantId, input.tenantId)).limit(1);
  if (existing) {
    await db.update(subscriptions)
      .set({ status: input.suspended ? 'suspended' : 'active' })
      .where(eq(subscriptions.id, existing.id));
  }

  await recordAuditEvent({
    action: input.suspended ? AUDIT_ACTIONS.ADMIN_TENANT_SUSPENDED : AUDIT_ACTIONS.ADMIN_TENANT_REACTIVATED,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'tenant',
    entityId: input.tenantId,
    metadata: { reason: input.reason ?? null },
  });
}

// ── Feature flags desde admin (PA-11) ─────────────────────────────────────────

export async function overrideTenantFeature(input: {
  tenantId: string;
  featureKey: string;
  enabled: boolean;
  notes?: string | null;
  actorUserId: string;
}) {
  await getTenantOrThrow(input.tenantId);
  const state = await setFeatureFlag({
    tenantId: input.tenantId,
    featureKey: input.featureKey,
    enabled: input.enabled,
    source: 'admin',
    changedByUserId: input.actorUserId,
    notes: input.notes ?? null,
  });

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_FEATURE_OVERRIDE,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'tenant_feature',
    entityId: `${input.tenantId}:${input.featureKey}`,
    metadata: { enabled: input.enabled },
  });

  return state;
}

export async function resetTenantFeature(input: {
  tenantId: string;
  featureKey: string;
  actorUserId: string;
}) {
  await getTenantOrThrow(input.tenantId);
  const state = await resetFeatureOverride(input.tenantId, input.featureKey, input.actorUserId);

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_FEATURE_OVERRIDE,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    entityType: 'tenant_feature',
    entityId: `${input.tenantId}:${input.featureKey}`,
    metadata: { reset: true },
  });

  return state;
}

// ── Impersonación auditada (PA-10) ────────────────────────────────────────────

export const IMPERSONATION_TTL_MINUTES = 30;

/**
 * Abre una sesión de "ver como": devuelve un JWT de 30 minutos con el claim
 * `imp` = id de la sesión y `impBy` = admin que la abrió. Cada request con ese
 * token queda auditada por el middleware.
 */
export async function startImpersonation(input: {
  tenantId: string;
  targetUserId?: string | null;
  reason?: string | null;
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<{ sessionId: string; token: string; expiresAt: Date; targetUserId: string }> {
  await getTenantOrThrow(input.tenantId);

  let targetUserId = input.targetUserId ?? null;
  if (!targetUserId) {
    const [owner] = await db.select({ id: users.id }).from(users)
      .where(and(eq(users.tenantId, input.tenantId), eq(users.role, 'owner')))
      .limit(1);
    const [anyUser] = owner ? [owner] : await db.select({ id: users.id }).from(users)
      .where(eq(users.tenantId, input.tenantId)).limit(1);
    if (!anyUser) throw new AppError('El tenant no tiene usuarios para impersonar', 409, 'NO_TARGET_USER');
    targetUserId = anyUser.id;
  }

  const [target] = await db.select().from(users).where(
    and(eq(users.id, targetUserId), eq(users.tenantId, input.tenantId)),
  ).limit(1);
  if (!target) throw new AppError('Usuario objetivo no pertenece al tenant', 404, 'TARGET_NOT_FOUND');

  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60 * 1000);

  const [session] = await db.insert(impersonationSessions).values({
    adminUserId: input.actorUserId,
    tenantId: input.tenantId,
    impersonatedUserId: target.id,
    reason: input.reason ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    expiresAt,
  }).returning();

  const token = jwt.sign(
    {
      userId: target.id,
      tenantId: target.tenantId,
      email: target.email,
      role: target.role,
      impersonatedBy: input.actorUserId,
      imp: session.id,
    },
    JWT_SECRET,
    { expiresIn: `${IMPERSONATION_TTL_MINUTES}m`, algorithm: 'HS256' },
  );

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_IMPERSONATION_START,
    tenantId: input.tenantId,
    userId: input.actorUserId,
    actorRole: 'platform_admin',
    entityType: 'impersonation_session',
    entityId: session.id,
    metadata: { targetUserId: target.id, reason: input.reason ?? null },
  });

  return { sessionId: session.id, token, expiresAt, targetUserId: target.id };
}

export async function endImpersonation(input: {
  sessionId: string;
  actorUserId: string;
}): Promise<void> {
  const [session] = await db.select().from(impersonationSessions)
    .where(eq(impersonationSessions.id, input.sessionId)).limit(1);
  if (!session) throw new AppError('Sesión de impersonación no encontrada', 404, 'SESSION_NOT_FOUND');

  await db.update(impersonationSessions)
    .set({ endedAt: new Date() })
    .where(eq(impersonationSessions.id, session.id));

  await recordAuditEvent({
    action: AUDIT_ACTIONS.ADMIN_IMPERSONATION_END,
    tenantId: session.tenantId,
    userId: input.actorUserId,
    actorRole: 'platform_admin',
    entityType: 'impersonation_session',
    entityId: session.id,
  });
}
