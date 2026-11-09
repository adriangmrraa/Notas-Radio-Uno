import { db } from '../db/index.js';
import { aiCostRecords } from '../db/schema/index.js';
import type { AiCostKind, AiCostUnit } from '../db/schema/saas.js';
import { sql, eq, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// aiCostMeter — métricas de costo IA por tenant/transmisión (PI-03)
// Costos estimados (pricing del provider puede cambiar) — auditables por evento.
// Best-effort: un fallo de metering nunca rompe el pipeline.
// ---------------------------------------------------------------------------

export interface AiCostInput {
    tenantId: string;
    transmissionId?: string | null;
    provider: string;
    kind: AiCostKind;
    units: number;
    unit: AiCostUnit;
    /** USD estimado del evento. */
    costEstimateUsd: number;
}

export async function recordAiCost(input: AiCostInput): Promise<void> {
    try {
        await db.insert(aiCostRecords).values({
            tenantId: input.tenantId,
            transmissionId: input.transmissionId ?? null,
            provider: input.provider,
            kind: input.kind,
            units: String(input.units),
            unit: input.unit,
            costEstimateUsd: String(input.costEstimateUsd),
        });
    } catch (err) {
        console.warn(`[AiCost] metering failed for ${input.provider}/${input.kind} (best-effort):`, err);
    }
}

export interface AiCostSummary {
    totalUsd: number;
    byProvider: Record<string, number>;
    byKind: Record<string, number>;
    records: number;
}

/** Agregado de costo por tenant y opcionalmente transmisión (panel admin). */
export async function getAiCostSummary(
    tenantId: string,
    transmissionId?: string,
): Promise<AiCostSummary> {
    const conditions = [eq(aiCostRecords.tenantId, tenantId)];
    if (transmissionId) conditions.push(eq(aiCostRecords.transmissionId, transmissionId));

    const rows = await db
        .select({
            provider: aiCostRecords.provider,
            kind: aiCostRecords.kind,
            cost: aiCostRecords.costEstimateUsd,
        })
        .from(aiCostRecords)
        .where(and(...conditions));

    const summary: AiCostSummary = { totalUsd: 0, byProvider: {}, byKind: {}, records: rows.length };
    for (const r of rows) {
        const cost = Number(r.cost ?? 0);
        summary.totalUsd += cost;
        if (r.provider) summary.byProvider[r.provider] = (summary.byProvider[r.provider] ?? 0) + cost;
        if (r.kind) summary.byKind[r.kind] = (summary.byKind[r.kind] ?? 0) + cost;
    }
    summary.totalUsd = Number(summary.totalUsd.toFixed(5));
    return summary;
}
