import { useState, useEffect, useCallback } from 'react';
import { CalendarClock, Plus, Play, Pause, Trash2, Clock, Square, ChevronDown, ChevronUp, Radio, Zap, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';

interface Job {
    id: string;
    name: string;
    description: string | null;
    streamUrl: string;
    scheduleType: string;
    daysOfWeek: number[];
    startTime: string;
    durationMinutes: number;
    isActive: boolean;
    isRunning: boolean;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    pipelineConfig: Record<string, unknown>;
}

interface Execution {
    id: string;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    publicationsGenerated: number;
    transcriptionMinutes: string;
    errorMessage: string | null;
    createdAt: string;
}

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
const TONES = ['formal', 'informal', 'urgente', 'analitico'];
const STRUCTURES = ['flash', 'corta', 'completa', 'cronica'];

export function ScheduledJobsPage() {
    const { fetchApi } = useApi();
    const [jobs, setJobs] = useState<Job[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [expandedJob, setExpandedJob] = useState<string | null>(null);
    const [executions, setExecutions] = useState<Execution[]>([]);
    const [saving, setSaving] = useState(false);
    const [form, setForm] = useState({
        name: '', streamUrl: '', startTime: '08:00', durationMinutes: 120,
        daysOfWeek: [1, 2, 3, 4, 5] as number[],
        tone: 'formal', structure: 'completa', imageModel: 'gemini', autoPublish: true,
    });

    const loadJobs = useCallback(async () => {
        try {
            const data = await fetchApi<Job[]>('/jobs');
            setJobs(data);
        } catch { /* */ }
        setLoading(false);
    }, []);

    useEffect(() => { loadJobs(); }, []);

    const createJob = async () => {
        if (!form.name.trim() || !form.streamUrl.trim()) return;
        setSaving(true);
        try {
            await fetchApi('/jobs', {
                method: 'POST',
                body: {
                    name: form.name, streamUrl: form.streamUrl, scheduleType: 'recurring',
                    daysOfWeek: form.daysOfWeek, startTime: form.startTime,
                    durationMinutes: form.durationMinutes,
                    pipelineConfig: { tone: form.tone, structure: form.structure, imageModel: form.imageModel, autoPublish: form.autoPublish },
                },
            });
            setShowForm(false);
            setForm({ name: '', streamUrl: '', startTime: '08:00', durationMinutes: 120, daysOfWeek: [1, 2, 3, 4, 5], tone: 'formal', structure: 'completa', imageModel: 'gemini', autoPublish: true });
            await loadJobs();
        } catch (err: any) { alert(err.message); }
        setSaving(false);
    };

    const toggleJob = async (id: string) => {
        await fetchApi(`/jobs/${id}/toggle`, { method: 'POST' });
        await loadJobs();
    };

    const stopJob = async (id: string) => {
        await fetchApi(`/jobs/${id}/stop`, { method: 'POST' });
        await loadJobs();
    };

    const deleteJob = async (id: string) => {
        if (!confirm('Eliminar este job programado?')) return;
        await fetchApi(`/jobs/${id}`, { method: 'DELETE' });
        await loadJobs();
    };

    const toggleDay = (day: number) => {
        setForm(f => ({
            ...f,
            daysOfWeek: f.daysOfWeek.includes(day) ? f.daysOfWeek.filter(d => d !== day) : [...f.daysOfWeek, day].sort(),
        }));
    };

    const loadExecutions = async (jobId: string) => {
        if (expandedJob === jobId) { setExpandedJob(null); return; }
        const data = await fetchApi<Execution[]>(`/jobs/${jobId}/executions`);
        setExecutions(data);
        setExpandedJob(jobId);
    };

    if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" /></div>;

    return (
        <div className="p-8 max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/15 to-cyan-600/5 flex items-center justify-center ring-1 ring-cyan-500/20">
                        <CalendarClock className="w-5 h-5 text-cyan-400" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold">Jobs Programados</h1>
                        <p className="text-white/30 text-sm">Configura capturas automaticas — el sistema detecta el live y arranca solo</p>
                    </div>
                </div>
                <button onClick={() => setShowForm(!showForm)} className="btn-primary inline-flex items-center gap-2">
                    {showForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                    {showForm ? 'Cancelar' : 'Nuevo Job'}
                </button>
            </div>

            {/* Create Form */}
            {showForm && (
                <div className="glass-card-static p-6 mb-8 relative overflow-hidden animate-scale-in">
                    <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />

                    <div className="flex items-center gap-2 mb-5">
                        <Zap className="w-5 h-5 text-cyan-400" />
                        <h3 className="font-semibold text-lg">Nuevo Job Programado</h3>
                    </div>

                    <div className="space-y-5">
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Nombre del job</label>
                                <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                                    placeholder="Mi programa de radio" className="input-premium" />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">URL del canal (no del live)</label>
                                <input type="url" value={form.streamUrl} onChange={e => setForm({ ...form, streamUrl: e.target.value })}
                                    placeholder="https://youtube.com/@MiCanal" className="input-premium" />
                            </div>
                        </div>

                        <div className="grid grid-cols-3 gap-4">
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Hora de inicio</label>
                                <input type="time" value={form.startTime} onChange={e => setForm({ ...form, startTime: e.target.value })}
                                    className="input-premium" />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Duracion maxima (min)</label>
                                <input type="number" value={form.durationMinutes} onChange={e => setForm({ ...form, durationMinutes: parseInt(e.target.value) || 120 })}
                                    min={30} max={480} className="input-premium" />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Dias de la semana</label>
                                <div className="flex gap-1">
                                    {DAY_NAMES.map((name, i) => (
                                        <button key={i} onClick={() => toggleDay(i)}
                                            className={`px-2.5 py-2 rounded-lg text-xs font-medium transition-all duration-300 ${
                                                form.daysOfWeek.includes(i)
                                                    ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25 shadow-glow-cyan'
                                                    : 'bg-white/[0.03] text-white/25 border border-white/[0.06] hover:border-white/[0.12]'
                                            }`}>
                                            {name}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-3 gap-4">
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Tono</label>
                                <select value={form.tone} onChange={e => setForm({ ...form, tone: e.target.value })}
                                    className="input-premium">
                                    {TONES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Estructura</label>
                                <select value={form.structure} onChange={e => setForm({ ...form, structure: e.target.value })}
                                    className="input-premium">
                                    {STRUCTURES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Modelo de imagen</label>
                                <select value={form.imageModel} onChange={e => setForm({ ...form, imageModel: e.target.value })}
                                    className="input-premium">
                                    <option value="gemini">Gemini</option>
                                    <option value="grok">Grok (xAI)</option>
                                </select>
                            </div>
                        </div>

                        <div className="flex items-center justify-between pt-3 border-t border-white/[0.04]">
                            <label className="flex items-center gap-2.5 text-sm text-white/50 cursor-pointer group">
                                <input type="checkbox" checked={form.autoPublish} onChange={e => setForm({ ...form, autoPublish: e.target.checked })} className="rounded border-white/20 bg-white/[0.04] text-cyan-500 focus:ring-cyan-500/30" />
                                <span className="group-hover:text-white/70 transition-colors duration-300">Publicar automaticamente en redes</span>
                            </label>
                            <button onClick={createJob} disabled={saving || !form.name.trim() || !form.streamUrl.trim()}
                                className="btn-primary inline-flex items-center gap-2">
                                <Zap className="w-4 h-4" />
                                {saving ? 'Creando...' : 'Crear Job'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Empty State */}
            {jobs.length === 0 && !showForm && (
                <div className="glass-card-static p-12 text-center animate-in">
                    <div className="w-16 h-16 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4 ring-1 ring-white/[0.06]">
                        <Radio className="w-7 h-7 text-white/15" />
                    </div>
                    <h3 className="text-lg font-medium mb-2">Sin jobs programados</h3>
                    <p className="text-white/25 text-sm">Configura un job y el sistema detectara el live automaticamente a la hora indicada</p>
                </div>
            )}

            {/* Jobs List */}
            <div className="space-y-4 stagger-children">
                {jobs.map((job) => (
                    <div key={job.id} className={`glass-card overflow-hidden ${job.isRunning ? '!border-emerald-500/20' : ''}`}>
                        {/* Running glow */}
                        {job.isRunning && (
                            <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-500/60 to-transparent" />
                        )}

                        <div className="p-5">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-3">
                                    <div className={`w-2.5 h-2.5 rounded-full ${job.isRunning ? 'bg-emerald-400 animate-pulse-soft' : job.isActive ? 'bg-cyan-400' : 'bg-white/15'}`} />
                                    <h3 className="font-semibold">{job.name}</h3>
                                    {job.isRunning && <span className="badge badge-success flex items-center gap-1"><div className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />En vivo</span>}
                                    {!job.isActive && !job.isRunning && <span className="badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>Pausado</span>}
                                </div>
                                <div className="flex items-center gap-1.5">
                                    {job.isRunning && (
                                        <button onClick={() => stopJob(job.id)} className="p-2 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/5 transition-all duration-300" title="Detener">
                                            <Square className="w-4 h-4" />
                                        </button>
                                    )}
                                    <button onClick={() => toggleJob(job.id)} className="p-2 rounded-lg text-white/25 hover:text-cyan-400 hover:bg-cyan-500/5 transition-all duration-300" title={job.isActive ? 'Pausar' : 'Activar'}>
                                        {job.isActive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                                    </button>
                                    <button onClick={() => deleteJob(job.id)} className="p-2 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/5 transition-all duration-300" title="Eliminar">
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                            <p className="text-sm text-white/30 mb-3 truncate font-mono text-xs">{job.streamUrl}</p>
                            <div className="flex items-center gap-4 text-xs text-white/25">
                                <span className="flex items-center gap-1.5"><Clock className="w-3 h-3" />{job.startTime} — {job.durationMinutes}min</span>
                                <span className="flex gap-1">{job.daysOfWeek.map((d: number) => (
                                    <span key={d} className="px-1.5 py-0.5 rounded bg-white/[0.04] text-[10px]">{DAY_NAMES[d]}</span>
                                ))}</span>
                                {job.lastRunStatus && (
                                    <span className={`badge ${job.lastRunStatus === 'completed' ? 'badge-success' : job.lastRunStatus === 'running' ? 'badge-info' : 'badge-danger'}`}>
                                        {job.lastRunStatus}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Execution History Toggle */}
                        <button onClick={() => loadExecutions(job.id)}
                            className="w-full flex items-center justify-center gap-1.5 py-2.5 border-t border-white/[0.04] text-xs text-white/15 hover:text-white/30 hover:bg-white/[0.02] transition-all duration-300">
                            Historial {expandedJob === job.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>

                        {expandedJob === job.id && (
                            <div className="border-t border-white/[0.04] px-5 py-3 space-y-2 max-h-48 overflow-y-auto animate-slide-up">
                                {executions.length === 0 && <p className="text-xs text-white/15 text-center py-3">Sin ejecuciones</p>}
                                {executions.map((ex) => (
                                    <div key={ex.id} className="flex items-center justify-between text-xs py-1.5 px-2 rounded-lg hover:bg-white/[0.02] transition-colors">
                                        <span className="text-white/30">{new Date(ex.createdAt).toLocaleString()}</span>
                                        <span className={`badge ${ex.status === 'completed' ? 'badge-success' : ex.status === 'running' ? 'badge-info' : 'badge-danger'}`}>
                                            {ex.status}
                                        </span>
                                        <span className="text-white/25">{ex.publicationsGenerated} notas</span>
                                        <span className="text-white/15">{Math.round(Number(ex.transcriptionMinutes))}min</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
