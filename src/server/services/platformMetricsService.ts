import type { SubscriptionStatus } from '../db/schema/enums.js';

// ---------------------------------------------------------------------------
// platformMetricsService — métricas globales de plataforma (T-42 / super-admin)
//
//   Funciones PURAS sobre filas ya cargadas: sin IO, testeables. El loader de
//   datos vive en adminService.getPlatformMetrics().
//
//   Reglas del spec:
//   - MRR = Σ frozen_price de suscripciones NO canceladas (sin precio
//     congelado → se excluyen y se cuentan aparte, nunca se estiman).
//   - churn mensual = canceladas en el mes / activas al inicio del mes.
//   - conversión trial = trial_converted / trial_started (billing_events).
//   - payment_failed recientes = alertas < 7 días.
// ---------------------------------------------------------------------------

export interface SubscriptionMetricsRow {
    status: SubscriptionStatus;
    frozenPrice: string | number | null;
    frozenCurrency: string | null;
    canceledAt: Date | null;
    createdAt: Date;
}

export interface BillingEventMetricsRow {
    type: string;
    tenantId: string | null;
    createdAt: Date;
}

export interface PlatformMetrics {
    /** MRR en USD — solo filas con frozen_price numérico (USD). */
    mrrUsd: number;
    /** Suscripciones contadas en MRR vs excluidas por falta de precio. */
    mrrCounted: number;
    mrrExcludedNoPrice: number;
    /** Tenants con suscripción en estado operativo. */
    activeTenants: number;
    trialingTenants: number;
    pastDueTenants: number;
    suspendedTenants: number;
    /** Churn del mes corriente: canceledAt en el mes / activos al inicio. */
    monthlyChurn: number;
    monthlyChurnRate: number | null;
    /** Conversión trial → pago (eventos acumulados). */
    trialStarted: number;
    trialConverted: number;
    trialConversionRate: number | null;
    /** Alertas: tenants con payment_failed en los últimos 7 días. */
    recentPaymentFailures: { tenantId: string; at: Date }[];
}

const MRR_STATUSES = new Set<SubscriptionStatus>(['active', 'past_due']);

export function computePlatformMetrics(input: {
    subscriptions: SubscriptionMetricsRow[];
    billingEvents: BillingEventMetricsRow[];
    now?: Date;
}): PlatformMetrics {
    const now = input.now ?? new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let mrrUsd = 0;
    let mrrCounted = 0;
    let mrrExcludedNoPrice = 0;
    let activeTenants = 0;
    let trialingTenants = 0;
    let pastDueTenants = 0;
    let suspendedTenants = 0;
    let monthlyChurn = 0;
    let activeAtMonthStart = 0;

    for (const sub of input.subscriptions) {
        if (sub.status === 'active') activeTenants++;
        else if (sub.status === 'trialing') trialingTenants++;
        else if (sub.status === 'past_due') { pastDueTenants++; activeTenants++; }
        else if (sub.status === 'suspended') suspendedTenants++;

        // MRR: solo USD congelado de no-canceladas; excluidas se cuentan, no se estiman.
        if (MRR_STATUSES.has(sub.status)) {
            const price = Number(sub.frozenPrice);
            if (Number.isFinite(price) && price > 0 && (sub.frozenCurrency ?? 'USD') === 'USD') {
                mrrUsd += price;
                mrrCounted++;
            } else {
                mrrExcludedNoPrice++;
            }
        }

        // Churn del mes: canceladas este mes vs activas al inicio del mes.
        if (sub.canceledAt && sub.canceledAt >= monthStart) {
            monthlyChurn++;
            activeAtMonthStart++; // estaba activa al entrar el mes
        } else if (sub.status !== 'canceled' && sub.createdAt < monthStart) {
            activeAtMonthStart++;
        }
    }

    let trialStarted = 0;
    let trialConverted = 0;
    const recentFailures = new Map<string, Date>();
    for (const ev of input.billingEvents) {
        if (ev.type === 'trial_started') trialStarted++;
        else if (ev.type === 'trial_converted') trialConverted++;
        else if (ev.type === 'payment_failed' && ev.createdAt >= sevenDaysAgo && ev.tenantId) {
            const prev = recentFailures.get(ev.tenantId);
            if (!prev || ev.createdAt > prev) recentFailures.set(ev.tenantId, ev.createdAt);
        }
    }

    return {
        mrrUsd: Number(mrrUsd.toFixed(2)),
        mrrCounted,
        mrrExcludedNoPrice,
        activeTenants,
        trialingTenants,
        pastDueTenants,
        suspendedTenants,
        monthlyChurn,
        monthlyChurnRate: activeAtMonthStart > 0
            ? Number((monthlyChurn / activeAtMonthStart).toFixed(4))
            : null,
        trialStarted,
        trialConverted,
        trialConversionRate: trialStarted > 0
            ? Number((trialConverted / trialStarted).toFixed(4))
            : null,
        recentPaymentFailures: [...recentFailures.entries()]
            .map(([tenantId, at]) => ({ tenantId, at }))
            .sort((a, b) => b.at.getTime() - a.at.getTime()),
    };
}

/** Aprobación de assets: published+approved / total con estado terminal. */
export function computeAssetApprovalRate(rows: { status: string }[]): number | null {
    let approved = 0;
    let terminal = 0;
    for (const r of rows) {
        if (r.status === 'approved' || r.status === 'published') { approved++; terminal++; }
        else if (r.status === 'rejected') terminal++;
    }
    return terminal > 0 ? Number((approved / terminal).toFixed(4)) : null;
}
