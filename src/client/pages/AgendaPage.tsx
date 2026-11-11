import { useState, useEffect, useMemo, useCallback } from 'react';
import {
    CalendarDays, Plus, Pencil, Trash2, Play, Power, X, Clock,
    ChevronLeft, ChevronRight, List, Calendar, Radio, Zap, Globe,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAsyncData } from '../hooks/useAsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';

// ─── Types ───────────────────────────────────────────────────────────────────

type ScheduleMode = 'once' | 'weekly' | 'daily';

interface DerivedSchedule {
    mode: ScheduleMode;
    date?: string;
    time: string;
    daysOfWeek: number[];
    endsAt?: string;
}

interface AgendaItem {
    id: string;
    name: string;
    description: string | null;
    streamUrl: string;
    programId: string | null;
    programName: string | null;
    rrule: string;
    rruleDescription: string;
    schedule: DerivedSchedule;
    timezone: string;
    startsAt: string;
    endsAt: string | null;
    durationMinutes: number;
    autoStart: boolean;
    pipelineConfig: Record<string, unknown>;
    isActive: boolean;
    nextRunAt: string | null;
    lastRunAt: string | null;
    occurrences?: string[];
}

interface RunItem {
    id: string;
    status: string;
    source: string;
    programName: string | null;
    scheduledName: string | null;
    durationMinutes: number | null;
    startedAt: string | null;
    endedAt: string | null;
    errorMessage: string | null;
    createdAt: string;
}

interface Program {
    id: string;
    name: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TIMEZONES = [
    'America/Argentina/Buenos_Aires',
    'America/Montevideo',
    'America/Asuncion',
    'America/Santiago',
    'America/Sao_Paulo',
    'America/La_Paz',
    'America/Lima',
    'America/Bogota',
    'America/Mexico_City',
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'Europe/Madrid',
    'Europe/London',
    'UTC',
];

const WEEKDAY_LABELS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']; // ISO 1..7
const MONTH_NAMES = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const TONES = ['formal', 'informal', 'urgente', 'analitico'];
const STRUCTURES = ['flash', 'corta', 'completa', 'cronica'];
const MODE_LABELS: Record<ScheduleMode, string> = {
    once: 'Puntual',
    weekly: 'Semanal',
    daily: 'Diario',
};

const pad2 = (n: number) => String(n).padStart(2, '0');

// ─── Formatters (la hora siempre en la timezone de la entrada, no del server) ─

const localDateFmtCache = new Map<string, Intl.DateTimeFormat>();
function localDateFormatter(tz: string): Intl.DateTimeFormat {
    let fmt = localDateFmtCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        });
        localDateFmtCache.set(tz, fmt);
    }
    return fmt;
}

const localTimeFmtCache = new Map<string, Intl.DateTimeFormat>();
function localTimeFormatter(tz: string): Intl.DateTimeFormat {
    let fmt = localTimeFmtCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('es-AR', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
        });
        localTimeFmtCache.set(tz, fmt);
    }
    return fmt;
}

/** 'YYYY-MM-DD' del instante en la timezone de la entrada. */
function localDateKey(instant: Date, tz: string): string {
    return localDateFormatter(tz).format(instant);
}

function localTime(instant: Date, tz: string): string {
    return localTimeFormatter(tz).format(instant);
}

function formatRunAt(iso: string | null, tz: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${localDateKey(d, tz)} ${localTime(d, tz)}`;
}

const STATUS_BADGE: Record<string, string> = {
    scheduled: 'badge-info',
    waiting: 'badge-info',
    live: 'badge-success',
    processing: 'badge-info',
    done: '',
    error: 'badge-danger',
    canceled: '',
};

// ─── Schedule Dialog ─────────────────────────────────────────────────────────

interface ScheduleDialogProps {
    item: AgendaItem | null;
    programs: Program[];
    onClose: () => void;
    onSaved: () => void;
}

function ScheduleDialog({ item, programs, onClose, onSaved }: ScheduleDialogProps) {
    const { fetchApi } = useApi();
    const isEdit = !!item;
    const cfg = (item?.pipelineConfig ?? {}) as Record<string, unknown>;

    const todayLocal = () => {
        const now = new Date();
        return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    };

    const [name, setName] = useState(item?.name ?? '');
    const [description, setDescription] = useState(item?.description ?? '');
    const [streamUrl, setStreamUrl] = useState(item?.streamUrl ?? '');
    const [programId, setProgramId] = useState(item?.programId ?? '');
    const [mode, setMode] = useState<ScheduleMode>(item?.schedule.mode ?? 'once');
    const [date, setDate] = useState(item?.schedule.date ?? todayLocal());
    const [time, setTime] = useState(item?.schedule.time ?? '18:00');
    const [daysOfWeek, setDaysOfWeek] = useState<number[]>(
        item?.schedule.daysOfWeek?.length ? item.schedule.daysOfWeek : [1, 3, 5],
    );
    const [timezone, setTimezone] = useState(item?.timezone ?? 'America/Argentina/Buenos_Aires');
    const [durationMinutes, setDurationMinutes] = useState(item?.durationMinutes ?? 60);
    const [autoStart, setAutoStart] = useState(item?.autoStart ?? true);
    const [endsAt, setEndsAt] = useState(item?.schedule.endsAt ?? '');
    const [tone, setTone] = useState(typeof cfg.tone === 'string' ? cfg.tone : 'formal');
    const [structure, setStructure] = useState(typeof cfg.structure === 'string' ? cfg.structure : 'completa');
    const [autoPublish, setAutoPublish] = useState(cfg.autoPublish === true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const toggleDay = (day: number) => {
        setDaysOfWeek((days) =>
            days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b),
        );
    };

    const save = async () => {
        if (!name.trim()) { setError('El nombre es obligatorio'); return; }
        if (!streamUrl.trim()) { setError('La URL del stream es obligatoria'); return; }
        if (mode === 'weekly' && daysOfWeek.length === 0) {
            setError('Elegí al menos un día de la semana');
            return;
        }
        setSaving(true);
        setError('');
        try {
            const body: Record<string, unknown> = {
                name: name.trim(),
                description: description.trim() || undefined,
                streamUrl: streamUrl.trim(),
                programId: programId || undefined,
                mode,
                time,
                timezone,
                durationMinutes,
                autoStart,
                pipelineConfig: { tone, structure, autoPublish },
            };
            if (mode === 'once') body.date = date;
            if (mode === 'weekly') body.daysOfWeek = daysOfWeek;
            if (mode !== 'once' && endsAt) body.endsAt = endsAt;

            if (isEdit) {
                await fetchApi(`/transmissions/scheduled/${item!.id}`, { method: 'PUT', body });
            } else {
                await fetchApi('/transmissions/scheduled', { method: 'POST', body });
            }
            onSaved();
            onClose();
        } catch (err: any) {
            setError(err.message || 'Error al guardar');
        }
        setSaving(false);
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal-content max-w-2xl w-full">
                <div className="modal-header">
                    <h2 className="text-base font-semibold text-white/85">
                        {isEdit ? 'Editar transmisión programada' : 'Nueva transmisión programada'}
                    </h2>
                    <button onClick={onClose} className="tap-target w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors">
                        <X className="w-4 h-4 text-white/50" />
                    </button>
                </div>
                <div className="modal-body space-y-5">
                    {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Nombre *</label>
                            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                                className="input-premium" placeholder="Ej: Informativo de la tarde" autoFocus />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">URL del stream *</label>
                            <input type="url" value={streamUrl} onChange={(e) => setStreamUrl(e.target.value)}
                                className="input-premium" placeholder="https://youtube.com/@MiCanal" />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Descripción</label>
                        <textarea value={description} onChange={(e) => setDescription(e.target.value)}
                            className="input-premium resize-none" rows={2} placeholder="Opcional…" />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Programa</label>
                            <select value={programId} onChange={(e) => setProgramId(e.target.value)} className="input-premium">
                                <option value="">Sin programa</option>
                                {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Modo</label>
                            <select value={mode} onChange={(e) => setMode(e.target.value as ScheduleMode)} className="input-premium">
                                {(Object.keys(MODE_LABELS) as ScheduleMode[]).map((m) => (
                                    <option key={m} value={m}>{MODE_LABELS[m]}</option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Zona horaria</label>
                            <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="input-premium">
                                {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {mode === 'once' && (
                            <div>
                                <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Fecha</label>
                                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input-premium" />
                            </div>
                        )}
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Hora</label>
                            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="input-premium" />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Duración (min)</label>
                            <input type="number" value={durationMinutes}
                                onChange={(e) => setDurationMinutes(parseInt(e.target.value) || 60)}
                                min={5} max={480} className="input-premium" />
                        </div>
                        {mode !== 'once' && (
                            <div>
                                <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Hasta (opcional)</label>
                                <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="input-premium" />
                            </div>
                        )}
                    </div>

                    {mode === 'weekly' && (
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Días de la semana</label>
                            <div className="flex flex-wrap gap-1">
                                {WEEKDAY_LABELS.map((label, i) => {
                                    const day = i + 1; // ISO 1..7
                                    return (
                                        <button key={day} type="button" onClick={() => toggleDay(day)}
                                            className={`px-2.5 py-2 rounded-lg text-xs font-medium transition-all duration-300 ${
                                                daysOfWeek.includes(day)
                                                    ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25 shadow-glow-cyan'
                                                    : 'bg-white/[0.03] text-white/25 border border-white/[0.06] hover:border-white/[0.12]'
                                            }`}>
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Tono</label>
                            <select value={tone} onChange={(e) => setTone(e.target.value)} className="input-premium">
                                {TONES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Estructura</label>
                            <select value={structure} onChange={(e) => setStructure(e.target.value)} className="input-premium">
                                {STRUCTURES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                            </select>
                        </div>
                        <div className="flex items-end pb-1">
                            <label className="flex items-center gap-2.5 text-sm text-white/50 cursor-pointer group">
                                <input type="checkbox" checked={autoPublish} onChange={(e) => setAutoPublish(e.target.checked)}
                                    className="rounded border-white/20 bg-white/[0.04] text-cyan-500 focus:ring-cyan-500/30" />
                                <span className="group-hover:text-white/70 transition-colors duration-300">Publicar automáticamente</span>
                            </label>
                        </div>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-white/[0.04]">
                        <label className="flex items-center gap-2.5 text-sm text-white/50 cursor-pointer group">
                            <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)}
                                className="rounded border-white/20 bg-white/[0.04] text-cyan-500 focus:ring-cyan-500/30" />
                            <span className="group-hover:text-white/70 transition-colors duration-300">
                                Auto-start (dispara la transmisión sola a la hora programada)
                            </span>
                        </label>
                        <button onClick={save} disabled={saving || !name.trim() || !streamUrl.trim()}
                            className="btn-primary inline-flex items-center gap-2">
                            <Zap className="w-4 h-4" />
                            {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Calendar ────────────────────────────────────────────────────────────────

interface CalCell { date: Date; inMonth: boolean; key: string }

function buildMonthCells(cursor: Date): CalCell[] {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // lunes = 0
    const cells: CalCell[] = [];
    for (let i = 0; i < 42; i++) {
        const d = new Date(year, month, 1 - offset + i);
        cells.push({
            date: d,
            inMonth: d.getMonth() === month,
            key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
        });
    }
    return cells;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function AgendaPage() {
    const { fetchApi } = useApi();
    const [runs, setRuns] = useState<RunItem[]>([]);
    const [programs, setPrograms] = useState<Program[]>([]);
    const [notice, setNotice] = useState('');
    const [view, setView] = useState<'calendar' | 'list'>('calendar');
    const [cursor, setCursor] = useState(() => new Date());
    const [dialog, setDialog] = useState<{ item: AgendaItem | null } | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const monthParam = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`;

    const { data, loading, error, reload } = useAsyncData(
        () => fetchApi<{ items: AgendaItem[] }>(`/transmissions/scheduled?month=${monthParam}`),
        [monthParam],
    );
    const items = data?.items ?? [];

    const loadRuns = useCallback(async () => {
        try {
            const data = await fetchApi<{ items: RunItem[] }>('/transmissions?limit=8');
            setRuns(data.items);
        } catch { /* las corridas son secundarias */ }
    }, []);

    const loadPrograms = useCallback(async () => {
        try {
            const data = await fetchApi<{ programs: Program[] }>('/programs');
            setPrograms(data.programs);
        } catch { /* el selector queda vacío */ }
    }, []);

    useEffect(() => { loadRuns(); loadPrograms(); }, []);

    // Instantes → bucket por fecha local EN LA TIMEZONE DE CADA ENTRADA.
    const occurrencesByDay = useMemo(() => {
        const map = new Map<string, { item: AgendaItem; instant: Date }[]>();
        for (const item of items) {
            for (const iso of item.occurrences ?? []) {
                const instant = new Date(iso);
                const key = localDateKey(instant, item.timezone);
                const list = map.get(key) ?? [];
                list.push({ item, instant });
                map.set(key, list);
            }
        }
        for (const list of map.values()) {
            list.sort((a, b) => a.instant.getTime() - b.instant.getTime());
        }
        return map;
    }, [items]);

    const cells = useMemo(() => buildMonthCells(cursor), [cursor]);
    const todayKey = (() => {
        const t = new Date();
        return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
    })();

    const shiftMonth = (delta: number) => {
        setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
    };

    const startNow = async (item: AgendaItem) => {
        setBusyId(item.id);
        setNotice('');
        try {
            const data = await fetchApi<{ transmission: RunItem }>(
                `/transmissions/scheduled/${item.id}/start`,
                { method: 'POST' },
            );
            setNotice(`Transmisión disparada: "${item.name}" quedó en estado ${data.transmission.status}.`);
            await Promise.all([reload(), loadRuns()]);
        } catch (err: any) {
            setNotice(`Error al disparar: ${err.message}`);
        }
        setBusyId(null);
    };

    const toggleActive = async (item: AgendaItem) => {
        setBusyId(item.id);
        try {
            await fetchApi(`/transmissions/scheduled/${item.id}`, {
                method: 'PUT',
                body: { isActive: !item.isActive },
            });
            await reload();
        } catch (err: any) {
            alert(err.message);
        }
        setBusyId(null);
    };

    const remove = async (item: AgendaItem) => {
        if (!confirm(`¿Eliminar "${item.name}" de la agenda? Las transmisiones ya corridas se conservan.`)) return;
        setBusyId(item.id);
        try {
            await fetchApi(`/transmissions/scheduled/${item.id}`, { method: 'DELETE' });
            await reload();
        } catch (err: any) {
            alert(err.message);
        }
        setBusyId(null);
    };

    if (loading) {
        return <LoadingState text="Cargando agenda…" className="h-full" />;
    }

    return (
        <div className="p-4 md:p-8 max-w-6xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                    <CalendarDays className="w-5 h-5 text-cyan-400" />
                    <h1 className="text-xl font-semibold">Agenda</h1>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex rounded-lg overflow-hidden border border-white/[0.08]">
                        <button onClick={() => setView('calendar')}
                            className={`px-3 py-2 text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                                view === 'calendar' ? 'bg-cyan-500/15 text-cyan-400' : 'bg-white/[0.03] text-white/30 hover:text-white/50'
                            }`}>
                            <Calendar className="w-3.5 h-3.5" /> Calendario
                        </button>
                        <button onClick={() => setView('list')}
                            className={`px-3 py-2 text-xs font-medium inline-flex items-center gap-1.5 transition-colors ${
                                view === 'list' ? 'bg-cyan-500/15 text-cyan-400' : 'bg-white/[0.03] text-white/30 hover:text-white/50'
                            }`}>
                            <List className="w-3.5 h-3.5" /> Lista
                        </button>
                    </div>
                    <button onClick={() => setDialog({ item: null })} className="btn-primary inline-flex items-center gap-2">
                        <Plus className="w-4 h-4" /> Nueva transmisión
                    </button>
                </div>
            </div>

            {error && <ErrorState error={error} compact className="mb-4" onRetry={() => void reload()} />}
            {notice && <p className="mb-4 text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">{notice}</p>}

            {/* Empty state */}
            {!error && items.length === 0 && (
                <EmptyState
                    icon={<CalendarDays />}
                    title="Todavía no hay transmisiones programadas"
                    description="Programá una emisión puntual o recurrente y va a aparecer en el calendario."
                    action={{ label: 'Nueva transmisión', onClick: () => setDialog({ item: null }) }}
                />
            )}

            {/* Calendar view */}
            {!error && items.length > 0 && view === 'calendar' && (
                <div className="glass-card-static p-5">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="font-semibold capitalize">
                            {MONTH_NAMES[cursor.getMonth()]} {cursor.getFullYear()}
                        </h2>
                        <div className="flex items-center gap-1">
                            <button onClick={() => shiftMonth(-1)} className="tap-target p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-colors">
                                <ChevronLeft className="w-4 h-4" />
                            </button>
                            <button onClick={() => setCursor(new Date())} className="px-3 py-1.5 rounded-lg text-xs text-white/40 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors">
                                Hoy
                            </button>
                            <button onClick={() => shiftMonth(1)} className="tap-target p-2 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/[0.05] transition-colors">
                                <ChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-7 gap-px rounded-xl overflow-hidden bg-white/[0.05] border border-white/[0.06]">
                        {WEEKDAY_LABELS.map((d) => (
                            <div key={d} className="bg-[#0b0b10] px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wider text-white/25">
                                {d}
                            </div>
                        ))}
                        {cells.map((cell) => {
                            const occ = occurrencesByDay.get(cell.key) ?? [];
                            return (
                                <div key={cell.key}
                                    className={`min-h-[86px] bg-[#0b0b10] px-1.5 py-1.5 ${
                                        cell.inMonth ? '' : 'opacity-35'
                                    } ${cell.key === todayKey ? 'ring-1 ring-inset ring-cyan-500/40' : ''}`}>
                                    <div className={`text-[11px] font-medium mb-1 ${
                                        cell.key === todayKey ? 'text-cyan-400' : 'text-white/35'
                                    }`}>
                                        {cell.date.getDate()}
                                    </div>
                                    <div className="space-y-0.5">
                                        {occ.slice(0, 3).map(({ item, instant }) => (
                                            <button key={`${item.id}-${instant.toISOString()}`}
                                                onClick={() => setDialog({ item })}
                                                title={`${item.name} — ${item.rruleDescription} (${item.timezone})`}
                                                className={`w-full text-left px-1.5 py-0.5 rounded text-[10px] leading-tight truncate transition-colors ${
                                                    item.isActive
                                                        ? 'bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20'
                                                        : 'bg-white/[0.05] text-white/30 hover:bg-white/[0.08]'
                                                }`}>
                                                <span className="font-semibold">{localTime(instant, item.timezone)}</span>{' '}{item.name}
                                            </button>
                                        ))}
                                        {occ.length > 3 && (
                                            <div className="text-[9px] text-white/20 px-1">+{occ.length - 3} más</div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <p className="mt-3 text-[11px] text-white/20 flex items-center gap-1.5">
                        <Globe className="w-3 h-3" />
                        Las horas se muestran en la zona horaria de cada entrada.
                    </p>
                </div>
            )}

            {/* List view */}
            {!error && items.length > 0 && view === 'list' && (
                <div className="space-y-4 stagger-children">
                    {items.map((item) => (
                        <div key={item.id} className="glass-card overflow-hidden">
                            <div className="p-5">
                                <div className="flex items-center justify-between mb-2">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${item.isActive ? 'bg-cyan-400' : 'bg-white/15'}`} />
                                        <h3 className="font-semibold truncate">{item.name}</h3>
                                        {!item.isActive && (
                                            <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>Pausada</span>
                                        )}
                                        {item.autoStart && (
                                            <span className="badge badge-info">Auto-start</span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                        <button onClick={() => startNow(item)} disabled={busyId === item.id}
                                            className="tap-target p-2 rounded-lg text-white/25 hover:text-emerald-400 hover:bg-emerald-500/5 transition-all duration-300"
                                            title="Disparar ahora">
                                            <Play className="w-4 h-4" />
                                        </button>
                                        <button onClick={() => setDialog({ item })}
                                            className="tap-target p-2 rounded-lg text-white/25 hover:text-cyan-400 hover:bg-cyan-500/5 transition-all duration-300"
                                            title="Editar">
                                            <Pencil className="w-4 h-4" />
                                        </button>
                                        <button onClick={() => toggleActive(item)} disabled={busyId === item.id}
                                            className="tap-target p-2 rounded-lg text-white/25 hover:text-amber-400 hover:bg-amber-500/5 transition-all duration-300"
                                            title={item.isActive ? 'Desactivar' : 'Activar'}>
                                            <Power className="w-4 h-4" />
                                        </button>
                                        <button onClick={() => remove(item)} disabled={busyId === item.id}
                                            className="tap-target p-2 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/5 transition-all duration-300"
                                            title="Eliminar">
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>

                                <p className="text-sm text-white/30 mb-3 truncate font-mono text-xs">{item.streamUrl}</p>

                                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-white/25">
                                    <span className="flex items-center gap-1.5">
                                        <CalendarDays className="w-3 h-3" />{item.rruleDescription}
                                    </span>
                                    <span className="flex items-center gap-1.5">
                                        <Clock className="w-3 h-3" />{item.durationMinutes} min
                                    </span>
                                    <span className="flex items-center gap-1.5">
                                        <Globe className="w-3 h-3" />{item.timezone}
                                    </span>
                                    {item.programName && (
                                        <span className="flex items-center gap-1.5">
                                            <Radio className="w-3 h-3" />{item.programName}
                                        </span>
                                    )}
                                    <span>
                                        Próxima: <span className="text-white/45">{formatRunAt(item.nextRunAt, item.timezone)}</span>
                                    </span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Últimas emisiones */}
            {runs.length > 0 && (
                <div className="glass-card-static p-5 mt-8">
                    <h2 className="font-semibold mb-4 flex items-center gap-2">
                        <Radio className="w-4 h-4 text-cyan-400" /> Últimas emisiones
                    </h2>
                    <div className="space-y-1.5">
                        {runs.map((run) => (
                            <div key={run.id} className="flex items-center justify-between text-xs py-2 px-3 rounded-lg hover:bg-white/[0.02] transition-colors">
                                <div className="flex items-center gap-3 min-w-0">
                                    <span className={`badge ${STATUS_BADGE[run.status] ?? ''}`}>{run.status}</span>
                                    <span className="text-white/40 truncate">
                                        {run.scheduledName ?? run.programName ?? 'Transmisión'}
                                    </span>
                                    <span className="text-white/20">{run.source === 'manual' ? 'manual' : run.source}</span>
                                </div>
                                <span className="text-white/25 flex-shrink-0">{new Date(run.createdAt).toLocaleString('es-AR')}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {dialog && (
                <ScheduleDialog
                    item={dialog.item}
                    programs={programs}
                    onClose={() => setDialog(null)}
                    onSaved={reload}
                />
            )}
        </div>
    );
}
