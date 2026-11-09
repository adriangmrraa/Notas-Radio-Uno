import { db } from '../db/index.js';
import { tenants, subscriptions, plans, tenantQuotas, quotaOperations } from '../db/schema/index.js';
import { sql, eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// quotaService — cuota por transmisiones, TZ-aware e idempotente (D9)
// - Período 'YYYY-MM' calculado en tenant.timezone (Intl)
// - consume: INSERT quota_operations ON CONFLICT + UPDATE condicional RETURNING
// - release: reversa por fallo temprano (mismo operation_id)
// - grant: créditos extra del ciclo (admin/add-ons)
// ---------------------------------------------------------------------------

export type QuotaMetric = 'transmission' | 'pipeline_hours';

const METRIC_COLUMN: Record<QuotaMetric, string> = {
    transmission: 'transmissions_count',
    pipeline_hours: 'pipeline_hours',
};

export interface ConsumeResult {
    allowed: boolean;
    /** Contador resultante del período (tras el consumo si fue aceptado). */
    count: number;
    /** Límite efectivo (plan + extra). -1 = ilimitado. */
    effectiveLimit: number;
    period: string;
    /** true cuando la reserva fue rechazada por límite (paywall). */
    skipped?: true;
}

export interface QuotaStatus {
    period: string;
    transmissionsUsed: number;
    extraTransmissions: number;
    effectiveLimit: number;
}

// ── Período en timezone del tenant ────────────────────────────────────────────
export function periodForDate(date: Date, timezone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
    }).formatToParts(date);
    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    return `${year}-${month}`;
}

async function getTenantContext(tenantId: string) {
    const [row] = await db
        .select({
            timezone: tenants.timezone,
            subscriptionId: subscriptions.id,
            subscriptionStatus: subscriptions.status,
            maxTransmissions: plans.maxTransmissionsPerMonth,
            maxPipelineHours: plans.maxPipelineHoursPerMonth,
        })
        .from(tenants)
        .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(tenants.id, tenantId))
        .limit(1);
    return row ?? null;
}

/**
 * Límite efectivo: plan.maxTransmissionsPerMonth (null = ilimitado) del plan de
 * la suscripción si está trialing/active/past_due (past_due conserva acceso en
 * grace); sin suscripción elegible → base 0. + extra_transmissions del ciclo.
 * -1 = ilimitado.
 */
function computeEffectiveLimit(
    base: number | null | undefined,
    subscriptionActive: boolean,
    extraTransmissions: number,
): number {
    if (!subscriptionActive) {
        return Math.max(0, extraTransmissions);
    }
    if (base == null) return -1; // plan ilimitado
    return base + extraTransmissions;
}

const ACTIVE_SUB_STATUSES = ['trialing', 'active', 'past_due'] as const;

// ── getPlanLimits — límites del plan vigente del tenant (null = no definido) ──
export interface PlanLimits {
    maxTransmissionsPerMonth: number | null;
    maxPipelineHoursPerMonth: number | null;
    maxDurationMinutes: number | null;
    maxClipsPerTransmission: number | null;
    maxPersons: number | null;
    subscriptionActive: boolean;
}

export async function getPlanLimits(tenantId: string): Promise<PlanLimits> {
    const [row] = await db
        .select({
            subscriptionStatus: subscriptions.status,
            maxTransmissionsPerMonth: plans.maxTransmissionsPerMonth,
            maxPipelineHoursPerMonth: plans.maxPipelineHoursPerMonth,
            maxDurationMinutes: plans.maxDurationMinutes,
            maxClipsPerTransmission: plans.maxClipsPerTransmission,
            maxPersons: plans.maxPersons,
        })
        .from(tenants)
        .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(tenants.id, tenantId))
        .limit(1);

    return {
        maxTransmissionsPerMonth: row?.maxTransmissionsPerMonth ?? null,
        maxPipelineHoursPerMonth: row?.maxPipelineHoursPerMonth ?? null,
        maxDurationMinutes: row?.maxDurationMinutes ?? null,
        maxClipsPerTransmission: row?.maxClipsPerTransmission ?? null,
        maxPersons: row?.maxPersons ?? null,
        subscriptionActive: !!row?.subscriptionStatus
            && (ACTIVE_SUB_STATUSES as readonly string[]).includes(row.subscriptionStatus),
    };
}

// ── consume ───────────────────────────────────────────────────────────────────
export async function consume(
    tenantId: string,
    operationId: string,
    metric: QuotaMetric = 'transmission',
    n = 1,
): Promise<ConsumeResult> {
    const ctx = await getTenantContext(tenantId);
    const timezone = ctx?.timezone ?? 'UTC';
    const period = periodForDate(new Date(), timezone);
    const col = METRIC_COLUMN[metric];

    return db.transaction(async (tx): Promise<ConsumeResult> => {
        // Fila de cuota del período (lazy create)
        await tx.execute(sql`
            INSERT INTO "tenant_quotas" ("tenant_id", "period")
            VALUES (${tenantId}, ${period})
            ON CONFLICT ("tenant_id", "period") DO NOTHING
        `);

        const [quotaRow] = await tx.execute(sql`
            SELECT "transmissions_count", "pipeline_hours", "extra_transmissions"
            FROM "tenant_quotas"
            WHERE "tenant_id" = ${tenantId} AND "period" = ${period}
        `).then((r) => r.rows as Array<{ transmissions_count: number; pipeline_hours: string; extra_transmissions: number }>);

        const subscriptionActive = !!ctx?.subscriptionStatus
            && (ACTIVE_SUB_STATUSES as readonly string[]).includes(ctx.subscriptionStatus);
        const base = metric === 'transmission' ? ctx?.maxTransmissions : ctx?.maxPipelineHours;
        const effectiveLimit = metric === 'transmission'
            ? computeEffectiveLimit(base, subscriptionActive, quotaRow?.extra_transmissions ?? 0)
            : (subscriptionActive ? (base ?? -1) : 0);

        // Idempotencia: operation_id único — el retry devuelve el resultado original
        const opIns = await tx.execute(sql`
            INSERT INTO "quota_operations"
                ("tenant_id", "operation_id", "period", "kind", "metric", "delta", "metadata")
            VALUES
                (${tenantId}, ${operationId}, ${period}, 'consume', ${metric}, ${n}, '{}'::jsonb)
            ON CONFLICT ("operation_id") DO NOTHING
            RETURNING "id"
        `);

        if (opIns.rows.length === 0) {
            const [existing] = await tx.select().from(quotaOperations)
                .where(eq(quotaOperations.operationId, operationId))
                .limit(1);
            const meta = (existing?.metadata ?? {}) as { allowed?: boolean; count?: number };
            const prevAllowed = meta.allowed === true;
            const retryResult: ConsumeResult = {
                allowed: prevAllowed,
                count: Number(meta.count ?? existing?.resultingCount ?? 0),
                effectiveLimit,
                period,
                skipped: prevAllowed ? undefined : true,
            };
            return retryResult;
        }

        // Reserva atómica: una sola query decide — sin carrera entre despachos
        const upd = await tx.execute(sql`
            UPDATE "tenant_quotas"
            SET ${sql.raw(`"${col}"`)} = ${sql.raw(`"${col}"`)} + ${n},
                "updated_at" = now()
            WHERE "tenant_id" = ${tenantId}
              AND "period" = ${period}
              AND (${effectiveLimit} < 0 OR ${sql.raw(`"${col}"`)} + ${n} <= ${effectiveLimit})
            RETURNING ${sql.raw(`"${col}"`)} AS "count"
        `);

        const allowed = upd.rows.length > 0;
        const count = allowed
            ? Number((upd.rows[0] as { count: number | string }).count)
            : Number((quotaRow as Record<string, unknown> | undefined)?.[col] ?? 0);

        // Registrar el resultado en la operación (retry-safe)
        await tx.execute(sql`
            UPDATE "quota_operations"
            SET "resulting_count" = ${count},
                "metadata" = ${JSON.stringify({ allowed, count })}
            WHERE "operation_id" = ${operationId}
        `);

        const result: ConsumeResult = { allowed, count, effectiveLimit, period, skipped: allowed ? undefined : true };
        return result;
    }).then((result) => {
        // Trial eligibility (F5): la 2.ª transmisión consumida agota el trial —
        // el primer consume rechazado dispara 'trial_quota_exhausted' → expired.
        if (
            !result.allowed
            && metric === 'transmission'
            && ctx?.subscriptionStatus === 'trialing'
            && ctx.subscriptionId
        ) {
            void import('./subscriptionMachine.js').then(({ applyTransition }) =>
                applyTransition(ctx.subscriptionId!, 'trial_quota_exhausted', {
                    provider: 'system',
                    actor: 'system:quota_consume',
                    payload: { operationId, period: result.period },
                }),
            ).catch((e) => console.warn('[Quota] trial_quota_exhausted transition:', e));
        }
        return result;
    });
}

// ── release — reversa por fallo < MIN_CAPTURE_MS (mismo operation_id) ─────────
export async function release(operationId: string): Promise<{ released: boolean; already?: boolean }> {
    const [op] = await db.select().from(quotaOperations)
        .where(and(eq(quotaOperations.operationId, operationId), eq(quotaOperations.kind, 'consume')))
        .limit(1);
    if (!op) return { released: false };

    const col = METRIC_COLUMN[(op.metric as QuotaMetric) ?? 'transmission'] ?? METRIC_COLUMN.transmission;
    const releaseId = `${operationId}:release`;
    const delta = Number(op.delta);

    return db.transaction(async (tx) => {
        const ins = await tx.execute(sql`
            INSERT INTO "quota_operations"
                ("tenant_id", "operation_id", "period", "kind", "metric", "delta", "metadata")
            VALUES
                (${op.tenantId}, ${releaseId}, ${op.period}, 'release', ${op.metric}, ${-delta}, '{}'::jsonb)
            ON CONFLICT ("operation_id") DO NOTHING
            RETURNING "id"
        `);
        if (ins.rows.length === 0) {
            return { released: true, already: true };
        }

        const upd = await tx.execute(sql`
            UPDATE "tenant_quotas"
            SET ${sql.raw(`"${col}"`)} = GREATEST(0, ${sql.raw(`"${col}"`)} - ${delta}),
                "updated_at" = now()
            WHERE "tenant_id" = ${op.tenantId} AND "period" = ${op.period}
            RETURNING ${sql.raw(`"${col}"`)} AS "count"
        `);

        const count = Number((upd.rows[0] as { count: number | string } | undefined)?.count ?? 0);
        await tx.execute(sql`
            UPDATE "quota_operations" SET "resulting_count" = ${count} WHERE "operation_id" = ${releaseId}
        `);
        return { released: true };
    });
}

// ── grant — créditos +N transmisiones del ciclo vigente (admin/add-ons) ───────
export async function grant(
    tenantId: string,
    n: number,
    adminId?: string | null,
    operationId?: string,
): Promise<{ operationId: string; extraTransmissions: number; period: string }> {
    const ctx = await getTenantContext(tenantId);
    const period = periodForDate(new Date(), ctx?.timezone ?? 'UTC');
    const opId = operationId ?? `grant:${randomUUID()}`;

    return db.transaction(async (tx) => {
        await tx.execute(sql`
            INSERT INTO "tenant_quotas" ("tenant_id", "period")
            VALUES (${tenantId}, ${period})
            ON CONFLICT ("tenant_id", "period") DO NOTHING
        `);

        const ins = await tx.execute(sql`
            INSERT INTO "quota_operations"
                ("tenant_id", "operation_id", "period", "kind", "metric", "delta", "metadata")
            VALUES
                (${tenantId}, ${opId}, ${period}, 'grant', 'transmission', ${n},
                 ${JSON.stringify(adminId ? { grantedBy: adminId } : {})}::jsonb)
            ON CONFLICT ("operation_id") DO NOTHING
            RETURNING "id"
        `);

        if (ins.rows.length > 0) {
            await tx.execute(sql`
                UPDATE "tenant_quotas"
                SET "extra_transmissions" = "extra_transmissions" + ${n},
                    "updated_at" = now()
                WHERE "tenant_id" = ${tenantId} AND "period" = ${period}
            `);
        }

        const [row] = await tx.execute(sql`
            SELECT "extra_transmissions" FROM "tenant_quotas"
            WHERE "tenant_id" = ${tenantId} AND "period" = ${period}
        `).then((r) => r.rows as Array<{ extra_transmissions: number }>);

        await tx.execute(sql`
            UPDATE "quota_operations" SET "resulting_count" = ${row?.extra_transmissions ?? 0}
            WHERE "operation_id" = ${opId}
        `);

        return { operationId: opId, extraTransmissions: Number(row?.extra_transmissions ?? 0), period };
    });
}

// ── status — medidor visible "usaste X de Y" ──────────────────────────────────
export async function getQuotaStatus(tenantId: string): Promise<QuotaStatus> {
    const ctx = await getTenantContext(tenantId);
    const period = periodForDate(new Date(), ctx?.timezone ?? 'UTC');

    const [row] = await db.select().from(tenantQuotas)
        .where(and(eq(tenantQuotas.tenantId, tenantId), eq(tenantQuotas.period, period)))
        .limit(1);

    const subscriptionActive = !!ctx?.subscriptionStatus
        && (ACTIVE_SUB_STATUSES as readonly string[]).includes(ctx.subscriptionStatus);
    const effectiveLimit = computeEffectiveLimit(
        ctx?.maxTransmissions,
        subscriptionActive,
        row?.extraTransmissions ?? 0,
    );

    return {
        period,
        transmissionsUsed: row?.transmissionsCount ?? 0,
        extraTransmissions: row?.extraTransmissions ?? 0,
        effectiveLimit,
    };
}
