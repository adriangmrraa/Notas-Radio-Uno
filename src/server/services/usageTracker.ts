import { db } from '../db/index.js';
import { usageRecords } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { getQuotaStatus, getPlanLimits } from './quotaService.js';
import { recordAiCost } from './aiCostMeter.js';

// ---------------------------------------------------------------------------
// usageTracker — contadores legacy (usage_records) + delegación a quotaService
//
//   T-43: `checkUsageLimits` ya NO calcula límites contra usage_records —
//   delega en quotaService (veredicto de cuota real, período TZ del tenant).
//   Los track* siguen escribiendo usage_records (histórico) y ADEMÁS emiten
//   ai_cost_records para las métricas con costo IA asociado (PI-03).
// ---------------------------------------------------------------------------

function getPeriodStart(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

export async function trackPipelineMinutes(tenantId: string, minutes: number, transmissionId?: string) {
    const periodStart = getPeriodStart();
    await db.insert(usageRecords).values({
        tenantId,
        periodStart,
        pipelineHoursUsed: String(minutes / 60),
    }).onConflictDoUpdate({
        target: [usageRecords.tenantId, usageRecords.periodStart],
        set: {
            pipelineHoursUsed: sql`${usageRecords.pipelineHoursUsed} + ${minutes / 60}`,
        },
    });
    // Costo IA asociado al procesamiento de pipeline (minutos de análisis).
    void recordAiCost({
        tenantId,
        transmissionId,
        provider: 'pipeline',
        kind: 'video_analysis',
        units: minutes,
        unit: 'minutes',
        costEstimateUsd: 0, // costo absorbido por la plataforma (v1, margen por plan)
    });
}

export async function trackPublication(tenantId: string) {
    const periodStart = getPeriodStart();
    await db.insert(usageRecords).values({
        tenantId,
        periodStart,
        publicationsCount: 1,
    }).onConflictDoUpdate({
        target: [usageRecords.tenantId, usageRecords.periodStart],
        set: {
            publicationsCount: sql`${usageRecords.publicationsCount} + 1`,
        },
    });
}

export async function trackTranscriptionMinutes(tenantId: string, minutes: number, transmissionId?: string) {
    const periodStart = getPeriodStart();
    await db.insert(usageRecords).values({
        tenantId,
        periodStart,
        transcriptionMinutes: String(minutes),
    }).onConflictDoUpdate({
        target: [usageRecords.tenantId, usageRecords.periodStart],
        set: {
            transcriptionMinutes: sql`${usageRecords.transcriptionMinutes} + ${minutes}`,
        },
    });
    // Transcripción = costo IA medible (AssemblyAI ≈ USD 0.37/hora).
    void recordAiCost({
        tenantId,
        transmissionId,
        provider: 'assemblyai',
        kind: 'transcription',
        units: minutes,
        unit: 'minutes',
        costEstimateUsd: minutes * 0.0062,
    });
}

export async function trackAiTokens(tenantId: string, tokens: number, transmissionId?: string) {
    const periodStart = getPeriodStart();
    await db.insert(usageRecords).values({
        tenantId,
        periodStart,
        aiTokensUsed: tokens,
    }).onConflictDoUpdate({
        target: [usageRecords.tenantId, usageRecords.periodStart],
        set: {
            aiTokensUsed: sql`${usageRecords.aiTokensUsed} + ${tokens}`,
        },
    });
    void recordAiCost({
        tenantId,
        transmissionId,
        provider: 'ai',
        kind: 'text',
        units: tokens,
        unit: 'tokens',
        costEstimateUsd: 0, // mezcla de modelos — el meter detallado vive en el pipeline
    });
}

/**
 * T-43 — veredicto de cuota REAL vía quotaService (transmisiones del ciclo en
 * TZ del tenant + extra_transmissions). Mantiene la shape legacy para los
 * llamadores históricos (pubs/hours de usage_records, ahora informativos).
 */
export async function checkUsageLimits(tenantId: string) {
    const quota = await getQuotaStatus(tenantId);
    const limits = await getPlanLimits(tenantId);

    const transmissionsExceeded = quota.effectiveLimit >= 0
        && quota.transmissionsUsed >= quota.effectiveLimit;

    const periodStart = getPeriodStart();
    const [usage] = await db.select().from(usageRecords)
        .where(and(eq(usageRecords.tenantId, tenantId), eq(usageRecords.periodStart, periodStart)))
        .limit(1);

    const maxPubs = -1; // publications ya no se enforza por acá (quota = transmisiones)
    const maxHours = limits.maxPipelineHoursPerMonth ?? -1;
    const hoursExceeded = maxHours !== -1 && Number(usage?.pipelineHoursUsed ?? 0) >= maxHours;

    return {
        allowed: !transmissionsExceeded && !hoursExceeded,
        reason: transmissionsExceeded ? 'QUOTA_EXCEEDED' : (hoursExceeded ? 'HOURS_EXCEEDED' : undefined),
        // Veredicto de cuota real (autoridad)
        period: quota.period,
        transmissionsUsed: quota.transmissionsUsed,
        transmissionsLimit: quota.effectiveLimit < 0 ? null : quota.effectiveLimit,
        extraTransmissions: quota.extraTransmissions,
        quotaExceeded: transmissionsExceeded,
        // Contadores legacy (informativos)
        publicationsUsed: usage?.publicationsCount ?? 0,
        publicationsLimit: maxPubs,
        pipelineHoursUsed: Number(usage?.pipelineHoursUsed ?? 0),
        pipelineHoursLimit: maxHours,
        pubsExceeded: false,
        hoursExceeded,
    };
}
