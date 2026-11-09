import { db } from '../db/index.js';
import type { Server } from 'socket.io';
import { notifications } from '../db/schema/index.js';

let ioRef: Server | null = null;

export function initNotificationService(io: Server) {
    ioRef = io;
}

// ---------------------------------------------------------------------------
// emitToTenant — emisión Socket.IO con relay interno (PROCESS_ROLE split, D1)
// En el proceso `api` (o combinado) ioRef existe y emite directo. En `engine`
// no hay Socket.IO: el evento se reenvía por HTTP al endpoint /internal/emit
// del api (API_INTERNAL_URL) autenticado con el secreto interno.
// ---------------------------------------------------------------------------

const API_INTERNAL_URL = (process.env.API_INTERNAL_URL || '').replace(/\/$/, '');
export const INTERNAL_EMIT_SECRET =
    process.env.INTERNAL_API_SECRET ||
    process.env.MEDIA_SIGNING_SECRET ||
    process.env.JWT_SECRET ||
    'dev-secret-change-in-production';

export function emitToTenant(tenantId: string, event: string, payload: Record<string, unknown>): void {
    if (ioRef) {
        ioRef.to(`tenant:${tenantId}`).emit(event, payload);
        return;
    }
    if (API_INTERNAL_URL) {
        // Best-effort relay al api — nunca bloquea ni tira el proceso engine.
        void fetch(`${API_INTERNAL_URL}/internal/emit`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-internal-token': INTERNAL_EMIT_SECRET,
            },
            body: JSON.stringify({ tenantId, event, payload }),
        }).catch((err) => {
            console.warn(`[Notify] relay /internal/emit failed for '${event}':`, err instanceof Error ? err.message : err);
        });
    }
}

/**
 * Evento de transmisión por Socket.IO (sala en vivo, T-21/T-34).
 * Emite `transmission:{status}` puntual + `transmission:update` genérico.
 */
export function emitTransmissionEvent(
    tenantId: string,
    transmissionId: string,
    status: string,
    extra: Record<string, unknown> = {},
): void {
    const payload = {
        transmissionId,
        status,
        at: new Date().toISOString(),
        ...extra,
    };
    emitToTenant(tenantId, `transmission:${status}`, payload);
    emitToTenant(tenantId, 'transmission:update', payload);
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

    const [notification] = await db.insert(notifications).values({
        tenantId,
        jobId,
        type,
        title,
        message,
        icon,
        metadata: (metadata || {}) as any,
    }).returning();

    // Push real-time to tenant room — directo si hay io, relay /internal/emit
    // en el engine (emitToTenant decide).
    emitToTenant(tenantId, 'notification', {
        id: notification.id,
        type,
        title,
        message,
        icon,
        jobId,
        metadata,
        createdAt: notification.createdAt,
    });

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
