import { db } from '../db/index.js';
import { usageRecords, subscriptions, plans } from '../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';

function getPeriodStart(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

async function getOrCreateUsage(tenantId: string) {
    const periodStart = getPeriodStart();
    let [usage] = await db.select().from(usageRecords)
        .where(and(
            eq(usageRecords.tenantId, tenantId),
            eq(usageRecords.periodStart, periodStart)
        ))
        .limit(1);

    if (!usage) {
        [usage] = await db.insert(usageRecords).values({
            tenantId,
            periodStart,
        }).returning();
    }
    return usage;
}

export async function trackPipelineMinutes(tenantId: string, minutes: number) {
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

export async function trackTranscriptionMinutes(tenantId: string, minutes: number) {
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
}

export async function trackAiTokens(tenantId: string, tokens: number) {
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
}

export async function checkUsageLimits(tenantId: string) {
    const [subRow] = await db.select({ sub: subscriptions, plan: plans })
        .from(subscriptions)
        .leftJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.tenantId, tenantId))
        .limit(1);

    if (!subRow?.sub) {
        return { allowed: false, reason: 'No subscription' };
    }

    const usage = await getOrCreateUsage(tenantId);
    const plan = subRow.plan;

    const maxPubs = plan?.maxPublicationsPerMonth ?? -1;
    const maxHours = plan?.maxPipelineHoursPerMonth ?? -1;

    const pubsExceeded = maxPubs !== -1 && usage.publicationsCount >= maxPubs;
    const hoursExceeded = maxHours !== -1 && Number(usage.pipelineHoursUsed) >= maxHours;

    return {
        allowed: !pubsExceeded && !hoursExceeded,
        publicationsUsed: usage.publicationsCount,
        publicationsLimit: maxPubs,
        pipelineHoursUsed: Number(usage.pipelineHoursUsed),
        pipelineHoursLimit: maxHours,
        pubsExceeded,
        hoursExceeded,
    };
}
