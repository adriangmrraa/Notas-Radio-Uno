/**
 * LiveRoomPage — Sala "En vivo" (PD-05).
 *
 *   /en-vivo               → selector: últimas transmisiones del tenant.
 *   /en-vivo/:transmissionId → la sala.
 *
 * La sala pide el payload completo a `GET /api/live/transmissions/:id` y se
 * mantiene fresco por dos vías:
 *
 *   1. Socket.IO — `useTransmissionEvents` escucha `transmission:status` y
 *      `transmission:updated` (y emite subscribe/unsubscribe al room de la
 *      transmisión); cada evento dispara un refetch.
 *   2. Polling de respaldo cada 10s mientras el estado sea `live` — cubre
 *      eventos perdidos (los utterances y clips no viajan por socket,
 *      siempre se leen de la API).
 *
 * El mark manual (clip/nota) sólo se habilita con `status === 'live'` — el
 * server además lo valida (409 si no hay señal).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
    AlertTriangle, Bookmark, Circle, Loader2, Radio, Scissors,
    Square, WifiOff,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useTransmissionEvents } from '../hooks/useTransmissionEvents';
import { useToast } from '../components/ui/use-toast';
import { LiveTimeline, formatMs } from '../components/live/LiveTimeline';
import { LiveClipsPanel } from '../components/live/LiveClipsPanel';
import type { LiveRoomMarkResult, LiveRoomState } from '../../shared/types';

const POLL_INTERVAL_MS = 10_000;

const STATUS_BADGE: Record<string, string> = {
    scheduled: 'badge-info',
    waiting: 'badge-warning',
    live: 'badge-success',
    processing: 'badge-info',
    done: '',
    error: 'badge-danger',
    canceled: '',
};

const STATUS_LABEL: Record<string, string> = {
    scheduled: 'Programada',
    waiting: 'Esperando señal',
    live: 'En vivo',
    processing: 'Procesando',
    done: 'Finalizada',
    error: 'Error',
    canceled: 'Cancelada',
};

interface RunListItem {
    id: string;
    status: string;
    source: string;
    programName: string | null;
    scheduledName: string | null;
    startedAt: string | null;
    createdAt: string;
}

// ─── Selector de transmisión (/en-vivo sin id) ────────────────────────────────

function TransmissionPicker() {
    const { fetchApi } = useApi();
    const navigate = useNavigate();
    const [items, setItems] = useState<RunListItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchApi<{ items: RunListItem[] }>('/transmissions?limit=15')
            .then((d) => setItems(d.items))
            .catch((err) => setError(err.message || 'Error al cargar transmisiones'))
            .finally(() => setLoading(false));
    }, [fetchApi]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-24 text-white/40">
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="max-w-3xl mx-auto">
            <div className="mb-6">
                <h2 className="text-lg font-semibold text-white/85 flex items-center gap-2">
                    <Radio className="w-5 h-5 text-cyan-400" />
                    Sala en vivo
                </h2>
                <p className="text-sm text-white/40 mt-1">
                    Elegí una transmisión para monitorearla: transcripción,
                    momentos detectados y clips en tiempo real.
                </p>
            </div>
            {error && (
                <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-4">
                    {error}
                </p>
            )}
            {items.length === 0 ? (
                <div className="glass-card-static p-10 text-center text-white/35 text-sm">
                    No hay transmisiones recientes. Programá una desde Agenda o
                    iniciá una captura en vivo.
                </div>
            ) : (
                <ul className="space-y-2">
                    {items.map((t) => (
                        <li key={t.id}>
                            <button
                                onClick={() => navigate(`/en-vivo/${t.id}`)}
                                className="w-full glass-card-static p-4 flex items-center gap-4 text-left hover:bg-white/[0.045] transition-colors"
                            >
                                <span
                                    className={`badge ${STATUS_BADGE[t.status] ?? ''} inline-flex items-center gap-1.5`}
                                >
                                    {t.status === 'live' && (
                                        <Circle className="w-2 h-2 fill-current animate-pulse" />
                                    )}
                                    {STATUS_LABEL[t.status] ?? t.status}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-medium text-white/80 truncate">
                                        {t.programName ?? t.scheduledName ?? 'Transmisión sin nombre'}
                                    </span>
                                    <span className="block text-[11px] text-white/30">
                                        {t.startedAt
                                            ? `Iniciada ${new Date(t.startedAt).toLocaleString('es-AR')}`
                                            : `Creada ${new Date(t.createdAt).toLocaleString('es-AR')}`}
                                    </span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// ─── Sala (/en-vivo/:transmissionId) ──────────────────────────────────────────

function LiveRoom({ transmissionId }: { transmissionId: string }) {
    const { fetchApi } = useApi();
    const { toast } = useToast();
    const navigate = useNavigate();
    const [room, setRoom] = useState<LiveRoomState | null>(null);
    const [notFound, setNotFound] = useState(false);
    const [error, setError] = useState('');
    const [marking, setMarking] = useState<'clip' | 'note' | null>(null);
    const [stopping, setStopping] = useState(false);
    const [noteOpen, setNoteOpen] = useState(false);
    const [noteTitle, setNoteTitle] = useState('');
    const [nowMs, setNowMs] = useState(0);

    const load = useCallback(async () => {
        try {
            const data = await fetchApi<LiveRoomState>(
                `/live/transmissions/${transmissionId}`,
            );
            setRoom(data);
            setError('');
        } catch (err: any) {
            // Un 404 estable no se "reintenta" con error parpadeante: la
            // transmisión no es de este tenant o no existe.
            if (err?.message === 'Transmisión no encontrada') {
                setNotFound(true);
            }
            setError(err.message || 'Error al cargar la sala');
        }
    }, [fetchApi, transmissionId]);

    useEffect(() => {
        setRoom(null);
        setNotFound(false);
        load();
    }, [load]);

    const status = room?.transmission.status ?? 'scheduled';
    const isLive = status === 'live';

    // Refresco del reloj: posición actual del eje temporal (para el badge
    // "al aire hace mm:ss" y el ancla del mark).
    useEffect(() => {
        if (!isLive || !room?.transmission.startedAt) return;
        const started = new Date(room.transmission.startedAt).getTime();
        const tick = () => setNowMs(Math.max(0, Date.now() - started));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [isLive, room?.transmission.startedAt]);

    // Socket: status/updated → refetch (los bloques de la sala siempre se
    // leen de la API; el socket sólo dispara). El hook emite
    // transmission:subscribe/unsubscribe al room de esta transmisión.
    const loadRef = useRef(load);
    loadRef.current = load;
    useTransmissionEvents(
        useMemo(
            () => ({
                onStatus: (p) => {
                    if (p.transmissionId === transmissionId) loadRef.current();
                },
                onUpdated: (t) => {
                    if (t.id === transmissionId) loadRef.current();
                },
            }),
            [transmissionId],
        ),
        transmissionId,
    );

    // Polling de respaldo mientras hay señal: si un evento se pierde (caída
    // de socket, race del emit), la sala igual se actualiza cada 10s.
    useEffect(() => {
        if (!isLive) return;
        const id = setInterval(() => loadRef.current(), POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [isLive]);

    const doMark = async (type: 'clip' | 'note') => {
        setMarking(type);
        try {
            const body: Record<string, unknown> = { type };
            if (type === 'note' && noteTitle.trim()) {
                body.title = noteTitle.trim();
            }
            const result = await fetchApi<LiveRoomMarkResult>(
                `/live/transmissions/${transmissionId}/mark`,
                { method: 'POST', body },
            );
            toast({
                title:
                    type === 'clip'
                        ? 'Mark registrado: clip en generación'
                        : 'Nota registrada',
                description:
                    type === 'clip'
                        ? `Ventana ${formatMs(result.moment.startMs)}–${formatMs(result.moment.endMs)}`
                        : result.moment.title ?? '',
            });
            setNoteOpen(false);
            setNoteTitle('');
            await load();
        } catch (err: any) {
            toast({
                title: 'No se pudo registrar el mark',
                description: err.message || 'Error inesperado',
                variant: 'destructive',
            });
        } finally {
            setMarking(null);
        }
    };

    const doStop = async () => {
        setStopping(true);
        try {
            await fetchApi(`/live/transmissions/${transmissionId}/stop`, {
                method: 'POST',
                body: {},
            });
            toast({ title: 'Transmisión finalizada' });
            await load();
        } catch (err: any) {
            toast({
                title: 'No se pudo finalizar',
                description: err.message || 'Error inesperado',
                variant: 'destructive',
            });
        } finally {
            setStopping(false);
        }
    };

    if (notFound) {
        return (
            <div className="max-w-lg mx-auto text-center py-24">
                <p className="text-white/50 text-sm mb-4">
                    Transmisión no encontrada — no existe o pertenece a otra
                    organización.
                </p>
                <button className="btn-secondary" onClick={() => navigate('/en-vivo')}>
                    Volver al listado
                </button>
            </div>
        );
    }

    if (!room) {
        return (
            <div className="flex flex-col items-center justify-center py-24 gap-3 text-white/40">
                <Loader2 className="w-5 h-5 animate-spin" />
                {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
        );
    }

    const tx = room.transmission;
    const title = tx.programName ?? 'Transmisión en vivo';
    const markDisabledReason = isLive
        ? undefined
        : 'El mark manual sólo está disponible con la transmisión en vivo';

    return (
        <div className="space-y-4">
            {/* Encabezado */}
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-white/85 flex items-center gap-2 min-w-0">
                    <Radio className="w-5 h-5 text-cyan-400 shrink-0" />
                    <span className="truncate">{title}</span>
                </h2>
                <span className={`badge ${STATUS_BADGE[status] ?? ''} inline-flex items-center gap-1.5`}>
                    {isLive && <Circle className="w-2 h-2 fill-current animate-pulse" />}
                    {STATUS_LABEL[status] ?? status}
                </span>
                {isLive && (
                    <span className="text-[11px] font-mono text-white/35">
                        {formatMs(nowMs)}
                    </span>
                )}

                <div className="ml-auto flex items-center gap-2">
                    <button
                        className="btn-primary inline-flex items-center gap-2"
                        disabled={!isLive || marking !== null}
                        title={markDisabledReason}
                        onClick={() => doMark('clip')}
                    >
                        {marking === 'clip' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Scissors className="w-4 h-4" />
                        )}
                        Generar clip ahora
                    </button>
                    <button
                        className="btn-secondary inline-flex items-center gap-2"
                        disabled={!isLive || marking !== null}
                        title={markDisabledReason}
                        onClick={() => setNoteOpen((v) => !v)}
                    >
                        <Bookmark className="w-4 h-4" />
                        Generar nota
                    </button>
                    {isLive && (
                        <button
                            className="btn-danger inline-flex items-center gap-2"
                            disabled={stopping}
                            onClick={doStop}
                        >
                            {stopping ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Square className="w-4 h-4" />
                            )}
                            Finalizar
                        </button>
                    )}
                </div>
            </div>

            {/* Formulario inline de la nota */}
            {noteOpen && isLive && (
                <div className="glass-card-static p-3 flex items-center gap-2">
                    <input
                        className="input-premium flex-1"
                        placeholder="Título de la nota (ej: chequear cifra mencionada)…"
                        value={noteTitle}
                        onChange={(e) => setNoteTitle(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && doMark('note')}
                        autoFocus
                    />
                    <button
                        className="btn-primary"
                        disabled={marking !== null}
                        onClick={() => doMark('note')}
                    >
                        {marking === 'note' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            'Guardar'
                        )}
                    </button>
                </div>
            )}

            {/* Banners por estado */}
            {status === 'waiting' && (
                <div className="glass-card-static p-4 flex items-center gap-3 text-amber-300/90">
                    <WifiOff className="w-5 h-5 shrink-0" />
                    <div>
                        <p className="text-sm font-medium">Esperando señal…</p>
                        <p className="text-xs text-white/40">
                            La transmisión está creada pero la captura todavía
                            no enganchó. La sala se actualiza sola cuando
                            arranca — sin recargar.
                        </p>
                    </div>
                </div>
            )}
            {status === 'error' && (
                <div className="glass-card-static p-4 flex items-center gap-3 text-red-300/90">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    <div>
                        <p className="text-sm font-medium">
                            La transmisión cayó{tx.errorMessage ? ':' : '.'}
                        </p>
                        {tx.errorMessage && (
                            <p className="text-xs text-white/40">{tx.errorMessage}</p>
                        )}
                    </div>
                </div>
            )}
            {status === 'processing' && (
                <div className="glass-card-static p-4 flex items-center gap-3 text-cyan-300/90">
                    <Loader2 className="w-5 h-5 animate-spin shrink-0" />
                    <p className="text-sm">
                        Señal finalizada — el postproceso (empaquetado del
                        crudo, análisis) está en curso.
                    </p>
                </div>
            )}
            {status === 'done' && (
                <div className="glass-card-static p-4">
                    <p className="text-sm font-medium text-white/80 mb-1">
                        Resumen de la transmisión
                    </p>
                    <p className="text-xs text-white/40">
                        {tx.durationMinutes != null && `${tx.durationMinutes} min · `}
                        {room.segments.length > 0 && `${room.segments.length} segmentos grabados · `}
                        {room.timeline.length} segmentos transcritos ·{' '}
                        {room.moments.length} momentos · {room.clips.length} clips
                        {room.recording?.totalBytes
                            ? ` · ${(room.recording.totalBytes / 1e6).toFixed(1)} MB`
                            : ''}
                    </p>
                </div>
            )}

            {error && room && (
                <p className="text-xs text-amber-300/70">
                    Último refresh falló: {error}
                </p>
            )}

            {/* Cuerpo: timeline + rail */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
                <section className="lg:col-span-2 glass-card-static p-4 flex flex-col min-h-[420px] max-h-[70vh]">
                    <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
                        Transcripción en vivo
                    </h3>
                    <LiveTimeline items={room.timeline} />
                </section>
                <LiveClipsPanel
                    moments={room.moments}
                    clips={room.clips}
                    people={room.people}
                />
            </div>
        </div>
    );
}

export function LiveRoomPage() {
    const { transmissionId } = useParams<{ transmissionId: string }>();
    if (!transmissionId) return <TransmissionPicker />;
    return <LiveRoom transmissionId={transmissionId} />;
}
