import { prisma } from '../lib/prisma.js';
import type { Server } from 'socket.io';

let ioRef: Server | null = null;

export function initNotificationService(io: Server) {
    ioRef = io;
}

interface NotifyParams {
    tenantId: string;
    jobId?: string;
    type: string;
    title: string;
    message?: string;
    icon?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Creates a persistent notification in DB and pushes it via Socket.IO to the tenant.
 * This mirrors the pipeline visual steps but as notifications for background jobs.
 */
export async function notify(params: NotifyParams) {
    const { tenantId, jobId, type, title, message, icon, metadata } = params;

    const notification = await prisma.notification.create({
        data: {
            tenantId,
            jobId,
            type,
            title,
            message,
            icon,
            metadata: (metadata || {}) as any,
        },
    });

    // Push real-time to tenant room
    if (ioRef) {
        ioRef.to(`tenant:${tenantId}`).emit('notification', {
            id: notification.id,
            type,
            title,
            message,
            icon,
            jobId,
            metadata,
            createdAt: notification.createdAt,
        });
    }

    return notification;
}

// Icon map for pipeline sub-steps
const ICON_MAP: Record<string, string> = {
    satellite: '📡', mic: '🎤', check: '✅', clock: '🕐', brain: '🧠',
    warning: '⚠️', search: '🔍', info: 'ℹ️', image: '🖼️', layers: '🎨',
    upload: '📤',
};

// Convenience methods matching pipeline step names
export const jobNotify = {
    started: (tenantId: string, jobId: string, jobName: string, liveTitle?: string) =>
        notify({ tenantId, jobId, type: 'job_started', title: `Job "${jobName}" iniciado`, message: liveTitle ? `Live detectado: ${liveTitle}` : 'Buscando live stream...', icon: '🚀' }),

    detecting: (tenantId: string, jobId: string, jobName: string) =>
        notify({ tenantId, jobId, type: 'job_step', title: `Buscando live en canal`, message: `Job "${jobName}" — Escaneando...`, icon: '🔍' }),

    retrying: (tenantId: string, jobId: string, attempt: number, maxAttempts: number) =>
        notify({ tenantId, jobId, type: 'job_retry', title: `Reintentando (${attempt}/${maxAttempts})`, message: 'No se encontro live, reintentando en 2 min...', icon: '🔄' }),

    // ---------------------------------------------------------------------------
    // Pipeline-mirrored notifications — every visual canvas step becomes a notif
    // ---------------------------------------------------------------------------

    /** Generic pipeline detail step — mirrors every detail event from the canvas */
    pipelineDetail: (tenantId: string, jobId: string, data: Record<string, unknown>) => {
        const step = String(data.step || '');
        const sub = String(data.sub || '');
        const message = String(data.message || '');
        const iconKey = String(data.icon || '');
        const icon = ICON_MAP[iconKey] || '📋';

        // Build a concise title from step + sub
        const STEP_LABELS: Record<string, string> = {
            capturing: '🎤 Captura',
            transcribing: '📝 Transcripción',
            analyzing: '🔍 Análisis',
            searching: '🌐 Investigación',
            generating: '✏️ Redacción',
            creating_flyer: '🖼️ Placa',
            publishing: '📤 Publicación',
        };
        const title = STEP_LABELS[step] || `📋 ${step}`;

        return notify({ tenantId, jobId, type: 'job_detail', title, message, icon });
    },

    /** Main pipeline step change (capturing → transcribing → analyzing...) */
    pipelineStep: (tenantId: string, jobId: string, data: Record<string, unknown>) => {
        const step = String(data.step || '');
        const message = String(data.message || '');
        const STEP_ICONS: Record<string, string> = {
            capturing: '🎤', transcribing: '📝', analyzing: '🔍',
            searching: '🌐', generating: '✏️', creating_flyer: '🖼️',
            publishing: '📤',
        };
        return notify({ tenantId, jobId, type: 'job_step', title: message || `Paso: ${step}`, message: null as any, icon: STEP_ICONS[step] || '▶️' });
    },

    /** Transcription chunk completed */
    pipelineTranscription: (tenantId: string, jobId: string, data: Record<string, unknown>) => {
        const preview = String(data.text || '').slice(0, 120);
        return notify({ tenantId, jobId, type: 'job_transcription', title: '📝 Transcripción recibida', message: preview || 'Texto procesado', icon: '📝' });
    },

    /** Note generated */
    pipelineNote: (tenantId: string, jobId: string, data: Record<string, unknown>) => {
        const title = String(data.title || 'Sin título');
        return notify({ tenantId, jobId, type: 'job_note', title: `✏️ Nota generada: ${title}`, message: String(data.content || '').slice(0, 150), icon: '✏️' });
    },

    /** Flyer/image created */
    pipelineFlyer: (tenantId: string, jobId: string, data: Record<string, unknown>) => {
        return notify({ tenantId, jobId, type: 'job_flyer', title: '🖼️ Placa creada', message: data.previewUrl ? `Preview: ${data.previewUrl}` : 'Imagen lista', icon: '🖼️', metadata: { previewUrl: data.previewUrl } });
    },

    /** Note published to social */
    pipelinePublished: (tenantId: string, jobId: string, data: Record<string, unknown>) => {
        const title = String(data.title || '');
        const total = data.totalPublished || 0;
        return notify({ tenantId, jobId, type: 'job_published', title: `📤 Publicado: ${title}`, message: `Total publicadas: ${total}`, icon: '📤', metadata: { topic: data.topic } });
    },

    /** Pipeline error */
    pipelineError: (tenantId: string, jobId: string, data: Record<string, unknown>) => {
        return notify({ tenantId, jobId, type: 'job_error', title: `⚠️ Error en ${data.step || 'pipeline'}`, message: String(data.message || 'Error desconocido'), icon: '⚠️' });
    },

    // ---------------------------------------------------------------------------
    // Job lifecycle notifications
    // ---------------------------------------------------------------------------

    completed: (tenantId: string, jobId: string, jobName: string, stats: { publications: number; durationMin: number }) =>
        notify({ tenantId, jobId, type: 'job_completed', title: `Job "${jobName}" finalizado`, message: `${stats.publications} notas en ${stats.durationMin} min`, icon: '✅' }),

    failed: (tenantId: string, jobId: string, jobName: string, error: string) =>
        notify({ tenantId, jobId, type: 'job_failed', title: `Job "${jobName}" falló`, message: error, icon: '❌' }),

    noLiveFound: (tenantId: string, jobId: string, jobName: string) =>
        notify({ tenantId, jobId, type: 'job_failed', title: `No se encontró live`, message: `Job "${jobName}" — Se agotaron los reintentos`, icon: '📡' }),
};
