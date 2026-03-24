# SPEC 07: Tracking de Uso y Analytics Dashboard (Prisma ORM)

> Medir consumo real por tenant, enforcement de límites, y dashboard de analytics para el usuario.

---

## Contexto

El model `DailyMetric` ya está definido en `prisma/schema.prisma` (SPEC-01). Esta spec define cómo se trackea cada acción facturable y qué métricas ve el usuario.

---

## 1. Usage Tracker con Prisma

### `src/server/services/usageTracker.ts`

```typescript
import { prisma } from '../lib/prisma.js';

// =============================================
// INCREMENTAR MÉTRICA DIARIA (Prisma upsert)
// =============================================
export async function trackMetric(
    tenantId: string,
    field: keyof typeof METRIC_DEFAULTS,
    amount: number = 1
): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await prisma.dailyMetric.upsert({
        where: {
            tenantId_metricDate: { tenantId, metricDate: today },
        },
        update: {
            [field]: { increment: field === 'aiTokensUsed' ? BigInt(amount) : amount },
        },
        create: {
            tenantId,
            metricDate: today,
            [field]: field === 'aiTokensUsed' ? BigInt(amount) : amount,
        },
    });
}

const METRIC_DEFAULTS = {
    pipelineRuns: 0,
    pipelineMinutes: 0,
    scheduledRuns: 0,
    scheduledMinutes: 0,
    publicationsGenerated: 0,
    publicationsAuto: 0,
    publicationsManual: 0,
    publicationsScheduled: 0,
    transcriptionChunks: 0,
    transcriptionMinutes: 0,
    topicsDetected: 0,
    aiTokensUsed: BigInt(0),
    agentsExecuted: 0,
    twitterPosts: 0,
    facebookPosts: 0,
    instagramPosts: 0,
    webhookCalls: 0,
    pipelineErrors: 0,
    publishErrors: 0,
} as const;

// =============================================
// OBTENER ANALYTICS
// =============================================
export async function getAnalytics(
    tenantId: string,
    period: 'week' | 'month' | 'quarter' = 'month'
) {
    const days = { week: 7, month: 30, quarter: 90 }[period];
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    // Métricas diarias via Prisma
    const daily = await prisma.dailyMetric.findMany({
        where: {
            tenantId,
            metricDate: { gte: since },
        },
        orderBy: { metricDate: 'asc' },
    });

    // Totales agregados via Prisma groupBy + aggregate
    const totals = await prisma.dailyMetric.aggregate({
        where: { tenantId, metricDate: { gte: since } },
        _sum: {
            pipelineRuns: true,
            pipelineMinutes: true,
            scheduledRuns: true,
            publicationsGenerated: true,
            transcriptionMinutes: true,
            topicsDetected: true,
            aiTokensUsed: true,
            agentsExecuted: true,
            twitterPosts: true,
            facebookPosts: true,
            instagramPosts: true,
            webhookCalls: true,
            pipelineErrors: true,
            publishErrors: true,
        },
    });

    // Top publicaciones
    const topTopics = await prisma.publication.groupBy({
        by: ['title'],
        where: {
            tenantId,
            createdAt: { gte: since },
            title: { not: null },
        },
        _count: { title: true },
        orderBy: { _count: { title: 'desc' } },
        take: 10,
    });

    return {
        period,
        days,
        daily,
        totals: totals._sum,
        topTopics: topTopics.map(t => ({ title: t.title, count: t._count.title })),
    };
}

// =============================================
// RESUMEN PARA DASHBOARD
// =============================================
export async function getDashboardSummary(tenantId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    // Hoy
    const todayMetrics = await prisma.dailyMetric.findUnique({
        where: { tenantId_metricDate: { tenantId, metricDate: today } },
    });

    // Este mes (Prisma aggregate)
    const monthTotals = await prisma.dailyMetric.aggregate({
        where: { tenantId, metricDate: { gte: monthStart } },
        _sum: {
            publicationsGenerated: true,
            pipelineMinutes: true,
            transcriptionMinutes: true,
            topicsDetected: true,
        },
    });

    // Uso vs límites
    const usage = await prisma.usageRecord.findFirst({
        where: { tenantId, periodStart: monthStart },
    });

    const sub = await prisma.subscription.findUnique({
        where: { tenantId },
        include: { plan: true },
    });

    // Scheduled jobs activos
    const [activeJobs, runningJobs] = await prisma.$transaction([
        prisma.scheduledJob.count({ where: { tenantId, isActive: true } }),
        prisma.jobExecution.count({ where: { tenantId, status: 'running' } }),
    ]);

    return {
        today: {
            publications: todayMetrics?.publicationsGenerated ?? 0,
            pipelineMinutes: Number(todayMetrics?.pipelineMinutes ?? 0),
            topics: todayMetrics?.topicsDetected ?? 0,
            errors: (todayMetrics?.pipelineErrors ?? 0) + (todayMetrics?.publishErrors ?? 0),
        },
        thisMonth: {
            publications: monthTotals._sum.publicationsGenerated ?? 0,
            pipelineMinutes: Number(monthTotals._sum.pipelineMinutes ?? 0),
            transcriptionMinutes: Number(monthTotals._sum.transcriptionMinutes ?? 0),
            topics: monthTotals._sum.topicsDetected ?? 0,
        },
        usage: usage ? {
            pipelineHoursUsed: Number(usage.pipelineHoursUsed),
            publicationsCount: usage.publicationsCount,
            limit: sub?.plan ? {
                maxPipelineHours: sub.plan.maxPipelineHoursPerMonth,
                maxPublications: sub.plan.maxPublicationsPerMonth,
            } : null,
        } : null,
        jobs: { activeJobs, runningJobs },
    };
}
```

---

## 2. Puntos de Tracking en el Pipeline

Se mantienen idénticos a la spec original. `trackMetric()` y `incrementUsageSafe()` (de SPEC-02) se llaman en los mismos puntos del pipeline.

---

## 3. Rutas de Analytics

```typescript
import { Router } from 'express';
import * as tracker from '../services/usageTracker.js';

const router = Router();

router.get('/summary', async (req, res, next) => {
    try {
        const summary = await tracker.getDashboardSummary(req.tenantId!);
        res.json(summary);
    } catch (error) { next(error); }
});

router.get('/detailed', async (req, res, next) => {
    try {
        const period = (req.query.period as string) || 'month';
        const analytics = await tracker.getAnalytics(req.tenantId!, period as any);
        res.json(analytics);
    } catch (error) { next(error); }
});

export function registerAnalyticsRoutes(app: any) {
    app.use('/api/analytics', router);
}
```

---

## 4. Testing Checklist

- [ ] `trackMetric` usa Prisma `upsert` con `increment`
- [ ] `getDashboardSummary` usa Prisma `aggregate` para totales mensuales
- [ ] `getAnalytics` usa Prisma `findMany` + `aggregate` + `groupBy`
- [ ] `groupBy` para top publicaciones funciona correctamente
- [ ] BigInt para `aiTokensUsed` se maneja correctamente
- [ ] Métricas aisladas por tenant (where: { tenantId })
- [ ] Prisma genera tipos correctos para DailyMetric
