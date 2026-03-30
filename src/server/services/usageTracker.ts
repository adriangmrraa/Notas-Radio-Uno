import { prisma } from '../lib/prisma.js';

function getPeriodStart(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function getOrCreateUsage(tenantId: string) {
    const periodStart = getPeriodStart();
    let usage = await prisma.usageRecord.findFirst({
        where: { tenantId, periodStart },
    });
    if (!usage) {
        usage = await prisma.usageRecord.create({
            data: { tenantId, periodStart },
        });
    }
    return usage;
}

export async function trackPipelineMinutes(tenantId: string, minutes: number) {
    const periodStart = getPeriodStart();
    await prisma.usageRecord.upsert({
        where: { tenantId_periodStart: { tenantId, periodStart } },
        update: { pipelineHoursUsed: { increment: minutes / 60 } },
        create: { tenantId, periodStart, pipelineHoursUsed: minutes / 60 },
    });
}

export async function trackPublication(tenantId: string) {
    const periodStart = getPeriodStart();
    await prisma.usageRecord.upsert({
        where: { tenantId_periodStart: { tenantId, periodStart } },
        update: { publicationsCount: { increment: 1 } },
        create: { tenantId, periodStart, publicationsCount: 1 },
    });
}

export async function trackTranscriptionMinutes(tenantId: string, minutes: number) {
    const periodStart = getPeriodStart();
    await prisma.usageRecord.upsert({
        where: { tenantId_periodStart: { tenantId, periodStart } },
        update: { transcriptionMinutes: { increment: minutes } },
        create: { tenantId, periodStart, transcriptionMinutes: minutes },
    });
}

export async function trackAiTokens(tenantId: string, tokens: number) {
    const periodStart = getPeriodStart();
    await prisma.usageRecord.upsert({
        where: { tenantId_periodStart: { tenantId, periodStart } },
        update: { aiTokensUsed: { increment: tokens } },
        create: { tenantId, periodStart, aiTokensUsed: BigInt(tokens) },
    });
}

export async function checkUsageLimits(tenantId: string) {
    const subscription = await prisma.subscription.findUnique({
        where: { tenantId },
        include: { plan: true },
    });

    if (!subscription) {
        return { allowed: false, reason: 'No subscription' };
    }

    const usage = await getOrCreateUsage(tenantId);
    const plan = subscription.plan;

    const maxPubs = plan.maxPublicationsPerMonth ?? -1;
    const maxHours = plan.maxPipelineHoursPerMonth ?? -1;

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
