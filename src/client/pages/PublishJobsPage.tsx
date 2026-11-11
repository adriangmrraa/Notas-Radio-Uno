import { useState, useEffect } from 'react';
import {
    Send, RefreshCw, ExternalLink, XCircle, RotateCcw,
    CalendarClock, AlertTriangle, AtSign, Hash, Scissors,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAsyncData } from '../hooks/useAsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { useSocket } from '../hooks/useSocket';

// ------------------------------------------------------------------
// PG-05 — Cola de publicación vía Zernio.
// Un job por (pieza de contenido × red × cuenta). La UI sólo ve ids
// opacos de Zernio (accountId) — nunca credenciales ni handles reales.
// ------------------------------------------------------------------

// PG-06: composición persistida por job (publish_jobs.payload jsonb) —
// menciones reales resueltas de persons.social_links + etiquetas finales.
interface PublishJobPayload {
    mentions?: Array<{ personId: string; name: string; handle: string }>;
    hashtags?: string[];
    excludedPersonIds?: string[];
    truncated?: boolean;
}

interface PublishJob {
    id: string;
    platform: string;
    accountId: string;
    status: string;
    content: string;
    payload?: PublishJobPayload;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    lastErrorCategory: string | null;
    scheduledFor: string | null;
    publishedAt: string | null;
    platformPostUrl: string | null;
    nextAttemptAt: string | null;
    createdAt: string;
}

interface SocialConnectionLite {
    id: string;
    platform: string;
    accountId: string;
    username: string | null;
    displayName: string | null;
    status: string;
}

const JOB_STATUSES = [
    { key: '', label: 'Todos' },
    { key: 'queued', label: 'En cola' },
    { key: 'publishing', label: 'Publicando' },
    { key: 'published', label: 'Publicados' },
    { key: 'partial', label: 'Parciales' },
    { key: 'failed', label: 'Fallidos' },
    { key: 'cancelled', label: 'Cancelados' },
];

const STATUS_LABELS: Record<string, string> = {
    queued: 'En cola',
    publishing: 'Publicando',
    published: 'Publicado',
    partial: 'Parcial',
    failed: 'Fallido',
    cancelled: 'Cancelado',
};

const ERROR_CATEGORY_LABELS: Record<string, string> = {
    auth_expired: 'Conexión vencida',
    user_content: 'Contenido rechazado',
    user_abuse: 'Uso no permitido',
    platform_rate_limit: 'Límite de la red',
    quota_exhausted: 'Cuota agotada',
    account_issue: 'Problema de la cuenta',
    platform_rejected: 'Rechazado por la red',
    platform_error: 'Error de la red',
    system_error: 'Error del sistema',
    unknown: 'Error',
};

const statusBadge = (status: string) => {
    switch (status) {
        case 'published':
            return <span className="badge badge-success">Publicado</span>;
        case 'publishing':
            return <span className="badge badge-info">Publicando</span>;
        case 'partial':
            return <span className="badge badge-warning">Parcial</span>;
        case 'failed':
            return <span className="badge badge-danger">Fallido</span>;
        case 'cancelled':
            return <span className="badge">Cancelado</span>;
        default:
            return <span className="badge badge-info">En cola</span>;
    }
};

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export function PublishJobsPage() {
    const { fetchApi } = useApi();
    const { socket } = useSocket();
    const [status, setStatus] = useState('');
    const [acting, setActing] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
    const [connections, setConnections] = useState<SocialConnectionLite[]>([]);

    const { data, loading, error, reload } = useAsyncData(
        () => fetchApi<{ jobs: PublishJob[]; total: number }>(
            `/publish-jobs${status ? `?status=${status}&` : '?'}limit=100&offset=0`,
        ),
        [status],
    );
    const jobs = data?.jobs ?? [];
    const total = data?.total ?? 0;

    useEffect(() => {
        fetchApi<{ connections: SocialConnectionLite[] }>('/social-connections')
            .then((d) => setConnections(d.connections ?? []))
            .catch(() => {});
    }, [fetchApi]);

    // El worker emite publish:job:* por room tenant — refrescamos la lista.
    useEffect(() => {
        if (!socket) return;
        const refresh = () => { void reload(); };
        for (const ev of ['published', 'partial', 'failed', 'cancelled']) {
            socket.on(`publish:job:${ev}`, refresh);
        }
        return () => {
            for (const ev of ['published', 'partial', 'failed', 'cancelled']) {
                socket.off(`publish:job:${ev}`, refresh);
            }
        };
    }, [socket, reload]);

    const retry = async (id: string) => {
        setActing(id);
        setFeedback(null);
        try {
            await fetchApi(`/publish-jobs/${id}/retry`, { method: 'POST' });
            setFeedback({ kind: 'ok', text: 'Job re-encolado para reintentar.' });
            await reload();
        } catch (err: any) {
            setFeedback({ kind: 'error', text: err.message || 'No se pudo reintentar.' });
        }
        setActing(null);
    };

    const cancel = async (id: string) => {
        if (!confirm('Cancelar este job? No va a publicarse.')) return;
        setActing(id);
        setFeedback(null);
        try {
            await fetchApi(`/publish-jobs/${id}/cancel`, { method: 'POST' });
            await reload();
        } catch (err: any) {
            setFeedback({ kind: 'error', text: err.message || 'No se pudo cancelar.' });
        }
        setActing(null);
    };

    // Label humano de la cuenta: username/displayName de la conexión si
    // existe; si no, el accountId opaco de Zernio recortado.
    const accountLabel = (job: PublishJob): string => {
        const conn = connections.find(
            (c) => c.platform === job.platform && c.accountId === job.accountId,
        );
        if (conn) return `@${conn.username ?? conn.displayName ?? shortId(conn.accountId)}`;
        return shortId(job.accountId);
    };

    if (loading) {
        return <LoadingState text="Cargando publicaciones…" className="h-full" />;
    }

    return (
        <div className="p-4 md:p-8 max-w-5xl mx-auto">
            <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-cyan-400/[0.1] flex items-center justify-center">
                        <Send className="w-5 h-5 text-cyan-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-white/90 tracking-tight">
                            Publicación en redes
                        </h1>
                        <p className="text-xs text-white/30 mt-0.5">
                            Cola de publicación: un job por cuenta destino · {total} job{total !== 1 ? 's' : ''}
                        </p>
                    </div>
                </div>
                <button
                    onClick={() => void reload()}
                    className="btn-secondary inline-flex items-center gap-2 text-xs !py-2"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Actualizar
                </button>
            </div>

            {feedback && (
                <div className={`mb-4 px-4 py-3 rounded-xl text-sm border ${
                    feedback.kind === 'ok'
                        ? 'bg-emerald-500/[0.06] border-emerald-500/15 text-emerald-300'
                        : 'bg-red-500/[0.06] border-red-500/15 text-red-300'
                }`}>
                    {feedback.text}
                </div>
            )}

            {/* Status filter */}
            <div className="flex items-center gap-1 border-b border-white/[0.06] mb-6 overflow-x-auto">
                {JOB_STATUSES.map((s) => (
                    <button
                        key={s.key}
                        onClick={() => setStatus(s.key)}
                        className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                            status === s.key
                                ? 'border-cyan-400 text-cyan-400'
                                : 'border-transparent text-white/40 hover:text-white/60'
                        }`}
                    >
                        {s.label}
                    </button>
                ))}
            </div>

            {error ? (
                <ErrorState error={error} onRetry={() => void reload()} />
            ) : jobs.length === 0 ? (
                <EmptyState
                    icon={<Send />}
                    title="Sin jobs de publicación"
                    description="Cuando apruebes contenido con cuentas conectadas, cada publicación encola un job por red."
                    action={{ label: 'Conectar cuentas', to: '/connections' }}
                />
            ) : (
                <div className="space-y-3 stagger-children">
                    {jobs.map((job) => (
                        <div key={job.id} className="glass-card p-4">
                            <div className="flex items-start justify-between gap-3 flex-wrap">
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap mb-1">
                                        <span className="text-sm font-semibold capitalize">{job.platform}</span>
                                        <span className="text-xs text-white/35">{accountLabel(job)}</span>
                                        {statusBadge(job.status)}
                                        {job.payload?.truncated && (
                                            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/20 font-medium">
                                                <Scissors className="w-2.5 h-2.5" />
                                                Texto recortado al límite
                                            </span>
                                        )}
                                    </div>
                                    {/* PG-06: texto final tal como se manda a la red. */}
                                    <p className="text-xs text-white/50 leading-relaxed whitespace-pre-wrap">{job.content}</p>
                                    {(job.payload?.mentions?.length || job.payload?.hashtags?.length) ? (
                                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                                            {job.payload?.mentions?.map((m) => (
                                                <span
                                                    key={m.personId}
                                                    title={m.name}
                                                    className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-sky-400/10 text-sky-300 border border-sky-400/20 font-medium"
                                                >
                                                    <AtSign className="w-2.5 h-2.5" />
                                                    {m.handle} · {m.name}
                                                </span>
                                            ))}
                                            {job.payload?.hashtags?.map((h) => (
                                                <span
                                                    key={h}
                                                    className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-purple-400/10 text-purple-300 border border-purple-400/20 font-medium"
                                                >
                                                    <Hash className="w-2.5 h-2.5" />
                                                    {h}
                                                </span>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    {job.platformPostUrl && (
                                        <a
                                            href={job.platformPostUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="p-2 rounded-lg text-white/25 hover:text-cyan-400 hover:bg-cyan-500/5 transition-all duration-300"
                                            title="Ver en la red"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    )}
                                    {(job.status === 'failed' || job.status === 'partial') && (
                                        <button
                                            onClick={() => retry(job.id)}
                                            disabled={acting === job.id}
                                            className="btn-secondary inline-flex items-center gap-1.5 !py-1.5 !px-3 text-xs"
                                            title="Reintentar"
                                        >
                                            <RotateCcw className={`w-3.5 h-3.5 ${acting === job.id ? 'animate-spin' : ''}`} />
                                            Reintentar
                                        </button>
                                    )}
                                    {(job.status === 'queued' || job.status === 'publishing') && (
                                        <button
                                            onClick={() => cancel(job.id)}
                                            disabled={acting === job.id}
                                            className="p-2 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/5 transition-all duration-300"
                                            title="Cancelar"
                                        >
                                            <XCircle className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-white/25">
                                <span>Intentos: {job.attempts}/{job.maxAttempts}</span>
                                {job.scheduledFor && (
                                    <span className="inline-flex items-center gap-1">
                                        <CalendarClock className="w-3 h-3" />
                                        Programado {new Date(job.scheduledFor).toLocaleString()}
                                    </span>
                                )}
                                {job.nextAttemptAt && job.status === 'queued' && (
                                    <span>Próximo intento {new Date(job.nextAttemptAt).toLocaleString()}</span>
                                )}
                                {job.publishedAt && (
                                    <span>Publicado {new Date(job.publishedAt).toLocaleString()}</span>
                                )}
                            </div>

                            {job.lastError && (
                                <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/[0.05] border border-red-500/[0.08]">
                                    <AlertTriangle className="w-3.5 h-3.5 text-red-400/80 shrink-0 mt-0.5" />
                                    <div className="text-xs">
                                        <span className="text-red-300/90 font-medium">
                                            {ERROR_CATEGORY_LABELS[job.lastErrorCategory ?? ''] ?? 'Error'}
                                        </span>
                                        <span className="text-white/35"> — {job.lastError}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
