# SPEC 04: Procesamiento Programado — Scheduled Jobs (Prisma ORM)

> El usuario configura franjas horarias para que su transmisión se procese automáticamente sin intervención manual.

---

## Contexto

El cliente ideal tiene programas con horarios fijos. El model `ScheduledJob` y `JobExecution` ya están definidos en `prisma/schema.prisma` (SPEC-01). Esta spec define la lógica de scheduling, ejecución y UI.

---

## 1. Schedule Service con Prisma

### `src/server/services/scheduleService.ts`

```typescript
import { prisma } from '../lib/prisma.js';
import { AppError } from './authService.js';
import { getSubscription } from './subscriptionService.js';
import { ScheduleType, JobExecutionStatus } from '@prisma/client';

// =============================================
// CREAR SCHEDULED JOB
// =============================================
export async function createScheduledJob(tenantId: string, userId: string, input: {
    name: string;
    description?: string;
    streamUrl: string;
    scheduleType: 'recurring' | 'one_time';
    daysOfWeek: number[];
    startTime: string;
    durationMinutes: number;
    timezone?: string;
    scheduledDate?: string;
    pipelineConfig: Record<string, any>;
    notifyOnComplete?: boolean;
    notifyOnError?: boolean;
    notificationEmail?: string;
}) {
    // 1. Verificar plan
    const sub = await getSubscription(tenantId);
    if (!sub) throw new AppError('Suscripción no encontrada', 402);
    if (!(sub.features as any).scheduled_processing) {
        throw new AppError('Tu plan no incluye procesamiento programado. Actualiza a Starter o superior.', 403);
    }

    // 2. Verificar límite
    if (sub.limits.maxScheduledJobs !== null) {
        const count = await prisma.scheduledJob.count({
            where: { tenantId, isActive: true },
        });
        if (count >= sub.limits.maxScheduledJobs!) {
            throw new AppError(`Límite de ${sub.limits.maxScheduledJobs} trabajos alcanzado.`, 429);
        }
    }

    // 3. Validaciones
    if (input.scheduleType === 'recurring' && input.daysOfWeek.length === 0) {
        throw new AppError('Selecciona al menos un día', 400);
    }
    if (input.durationMinutes < 5 || input.durationMinutes > 480) {
        throw new AppError('Duración: entre 5 minutos y 8 horas', 400);
    }

    // 4. Calcular next_run_at
    const nextRun = calculateNextRun(
        input.scheduleType, input.daysOfWeek, input.startTime,
        input.timezone || 'America/Argentina/Buenos_Aires', input.scheduledDate
    );

    // 5. Crear con Prisma
    return prisma.scheduledJob.create({
        data: {
            tenantId,
            createdById: userId,
            name: input.name,
            description: input.description,
            streamUrl: input.streamUrl,
            scheduleType: input.scheduleType as ScheduleType,
            daysOfWeek: input.daysOfWeek,
            startTime: input.startTime,
            durationMinutes: input.durationMinutes,
            timezone: input.timezone || 'America/Argentina/Buenos_Aires',
            scheduledDate: input.scheduledDate ? new Date(input.scheduledDate) : null,
            pipelineConfig: input.pipelineConfig,
            nextRunAt: nextRun,
            notifyOnComplete: input.notifyOnComplete !== false,
            notifyOnError: input.notifyOnError !== false,
            notificationEmail: input.notificationEmail,
        },
    });
}

// =============================================
// LISTAR JOBS
// =============================================
export async function getScheduledJobs(tenantId: string) {
    return prisma.scheduledJob.findMany({
        where: { tenantId },
        include: {
            _count: {
                select: { executions: true },
            },
        },
        orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }],
    });
}

// =============================================
// OBTENER JOB
// =============================================
export async function getScheduledJob(tenantId: string, jobId: string) {
    const job = await prisma.scheduledJob.findFirst({
        where: { id: jobId, tenantId },
    });
    if (!job) throw new AppError('Trabajo no encontrado', 404);
    return job;
}

// =============================================
// ACTUALIZAR JOB
// =============================================
export async function updateScheduledJob(tenantId: string, jobId: string, input: any) {
    await getScheduledJob(tenantId, jobId); // verificar existencia

    const job = await prisma.scheduledJob.update({
        where: { id: jobId },
        data: input,
    });

    // Recalcular nextRunAt si cambió el horario
    if (input.startTime || input.daysOfWeek || input.scheduledDate || input.isActive !== undefined) {
        if (job.isActive) {
            const nextRun = calculateNextRun(
                job.scheduleType, job.daysOfWeek, job.startTime,
                job.timezone, job.scheduledDate?.toISOString().slice(0, 10)
            );
            await prisma.scheduledJob.update({
                where: { id: jobId },
                data: { nextRunAt: nextRun },
            });
        } else {
            await prisma.scheduledJob.update({
                where: { id: jobId },
                data: { nextRunAt: null },
            });
        }
    }

    return job;
}

// =============================================
// ELIMINAR JOB
// =============================================
export async function deleteScheduledJob(tenantId: string, jobId: string) {
    await getScheduledJob(tenantId, jobId);
    await prisma.scheduledJob.delete({ where: { id: jobId } });
}

// =============================================
// TOGGLE ACTIVO/INACTIVO
// =============================================
export async function toggleJob(tenantId: string, jobId: string) {
    const job = await getScheduledJob(tenantId, jobId);
    const newActive = !job.isActive;

    let nextRun: Date | null = null;
    if (newActive) {
        nextRun = calculateNextRun(
            job.scheduleType, job.daysOfWeek, job.startTime,
            job.timezone, job.scheduledDate?.toISOString().slice(0, 10)
        );
    }

    return prisma.scheduledJob.update({
        where: { id: jobId },
        data: { isActive: newActive, nextRunAt: nextRun },
    });
}

// =============================================
// HISTORIAL DE EJECUCIONES
// =============================================
export async function getJobExecutions(tenantId: string, jobId: string, limit = 20, offset = 0) {
    const [items, total] = await prisma.$transaction([
        prisma.jobExecution.findMany({
            where: { jobId, tenantId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
        }),
        prisma.jobExecution.count({ where: { jobId, tenantId } }),
    ]);
    return { items, total };
}

// =============================================
// OBTENER JOBS PENDIENTES (para scheduler)
// =============================================
export async function getDueJobs(now: Date) {
    return prisma.scheduledJob.findMany({
        where: {
            isActive: true,
            nextRunAt: { lte: now },
            tenant: {
                isActive: true,
                subscription: {
                    status: { in: ['active', 'trialing'] },
                },
            },
            // No hay ejecución corriendo
            executions: {
                none: { status: JobExecutionStatus.running },
            },
        },
        include: {
            tenant: { select: { name: true } },
        },
    });
}

// =============================================
// AVANZAR NEXT RUN
// =============================================
export async function advanceNextRun(jobId: string) {
    const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    if (job.scheduleType === ScheduleType.one_time) {
        await prisma.scheduledJob.update({
            where: { id: jobId },
            data: { isActive: false, nextRunAt: null },
        });
        return;
    }

    const nextRun = calculateNextRun(
        job.scheduleType, job.daysOfWeek, job.startTime,
        job.timezone, null
    );

    await prisma.scheduledJob.update({
        where: { id: jobId },
        data: { nextRunAt: nextRun, lastRunAt: new Date() },
    });
}

// =============================================
// CALCULAR PRÓXIMA EJECUCIÓN
// =============================================
export function calculateNextRun(
    scheduleType: string, daysOfWeek: number[], startTime: string,
    timezone: string, scheduledDate?: string | null
): Date | null {
    const now = new Date();
    const [hours, minutes] = startTime.split(':').map(Number);

    if (scheduleType === 'one_time') {
        if (!scheduledDate) return null;
        const [year, month, day] = scheduledDate.split('-').map(Number);
        const runDate = new Date(year, month - 1, day, hours, minutes);
        return runDate > now ? runDate : null;
    }

    for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
        const candidate = new Date(now);
        candidate.setDate(candidate.getDate() + daysAhead);
        candidate.setHours(hours, minutes, 0, 0);

        let isoDay = candidate.getDay();
        if (isoDay === 0) isoDay = 7;

        if (daysOfWeek.includes(isoDay) && candidate > now) return candidate;
    }

    return null;
}
```

---

## 2. Scheduler Runner con Prisma

### `src/server/services/schedulerRunner.ts`

La lógica de ejecución se mantiene igual que la spec original. Las únicas diferencias son las operaciones de DB:

```typescript
// Crear execution
const execution = await prisma.jobExecution.create({
    data: {
        jobId: job.id,
        tenantId: job.tenantId,
        status: JobExecutionStatus.pending,
        scheduledFor: new Date(job.nextRunAt!),
    },
});

// Actualizar execution a running
await prisma.jobExecution.update({
    where: { id: execution.id },
    data: { status: JobExecutionStatus.running, startedAt: new Date() },
});

// Actualizar job status
await prisma.scheduledJob.update({
    where: { id: job.id },
    data: { lastRunStatus: 'running', lastRunAt: new Date() },
});

// Completar execution
await prisma.jobExecution.update({
    where: { id: execution.id },
    data: {
        status: JobExecutionStatus.completed,
        finishedAt: new Date(),
        publicationsGenerated: count,
        transcriptionMinutes: minutes,
        topicsDetected: topics,
        executionLog: log,
    },
});

// Error
await prisma.jobExecution.update({
    where: { id: execution.id },
    data: {
        status: error.message.includes('Timeout')
            ? JobExecutionStatus.timeout
            : JobExecutionStatus.failed,
        finishedAt: new Date(),
        errorMessage: error.message,
        errorCount: 1,
        executionLog: log,
    },
});

// Obtener email del owner
const owner = await prisma.user.findFirst({
    where: { tenantId: job.tenantId, role: 'owner' },
    select: { email: true },
});
```

---

## 3. Rutas y resto de la spec

Las rutas de schedule (`src/server/routes/schedule.ts`) se mantienen idénticas — llaman a funciones del service que ahora usan Prisma internamente.

---

## 4. Testing Checklist

- [ ] Crear job usa `prisma.scheduledJob.create()`
- [ ] Listar jobs incluye `_count.executions` via Prisma include
- [ ] `getDueJobs` filtra por suscripción activa con nested relation filter
- [ ] Toggle recalcula nextRunAt y persiste via Prisma
- [ ] Job one_time se desactiva después de ejecutar
- [ ] Ejecuciones se crean/actualizan via Prisma con tipos enum auto-generados
- [ ] Historial paginado usa `$transaction` con findMany + count
- [ ] Todos los enum values (`ScheduleType`, `JobExecutionStatus`) son type-safe
