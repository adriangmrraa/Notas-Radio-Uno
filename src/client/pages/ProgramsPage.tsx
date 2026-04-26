import { useState, useEffect, useRef } from 'react';
import { Plus, Pencil, Trash2, Mic, Users, Link2, Star, X, ChevronDown, Calendar, FileSearch, RefreshCw, Copy, Check, AlertTriangle, BookOpen, Lightbulb, MessageSquare, Tag, ChevronRight } from 'lucide-react';
import { useApi } from '../hooks/useApi';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProgramUrl {
    id?: string;
    type: string;
    url: string;
}

interface Program {
    id: string;
    name: string;
    description?: string;
    schedule?: string;
    urls?: ProgramUrl[];
    conductorCount?: number;
}

interface ConductorPhoto {
    id: string;
    conductorId: string;
    mimeType: string;
    isPrimary: boolean;
    createdAt?: string;
}

interface Conductor {
    id: string;
    name: string;
    role: string;
    bio?: string;
    photos?: ConductorPhoto[];
}

interface GuestPhoto {
    id: string;
    guestId: string;
    mimeType: string;
    isPrimary: boolean;
}

interface Guest {
    id: string;
    name: string;
    role: string;
    bio?: string;
    scheduledDate: string;
    scheduledTimeStart?: string;
    scheduledTimeEnd?: string;
    photos?: GuestPhoto[];
}

interface DossierContent {
    summary: string;
    bio: string;
    recentActivity: string[];
    controversies: string[];
    suggestedQuestions: string[];
    keyFacts: string[];
    relatedTopics: string[];
    talkingPoints: string[];
}

interface GuestDossier {
    id: string;
    guestId: string;
    guestName: string;
    status: 'generating' | 'ready' | 'error';
    content: DossierContent | null;
    generatedAt: string | null;
    createdAt: string;
}

function photoSrc(conductorId: string, photoId: string): string {
    return `/api/conductors/${conductorId}/photos/${photoId}`;
}

function guestPhotoSrc(guestId: string, photoId: string): string {
    return `/api/guests/${guestId}/photos/${photoId}`;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const URL_TYPES = [
    { value: 'youtube', label: 'YouTube' },
    { value: 'facebook', label: 'Facebook' },
    { value: 'kick', label: 'Kick' },
    { value: 'twitch', label: 'Twitch' },
    { value: 'radio_stream', label: 'Radio Stream' },
    { value: 'web', label: 'Web' },
    { value: 'otro', label: 'Otro' },
];

const CONDUCTOR_ROLES = [
    { value: 'conductor', label: 'Conductor' },
    { value: 'columnista', label: 'Columnista' },
    { value: 'productor', label: 'Productor' },
    { value: 'invitado', label: 'Invitado' },
    { value: 'otro', label: 'Otro' },
];

const GUEST_ROLES = [
    { value: 'entrevistado', label: 'Entrevistado' },
    { value: 'panelista', label: 'Panelista' },
    { value: 'especialista', label: 'Especialista' },
    { value: 'artista', label: 'Artista' },
    { value: 'politico', label: 'Político' },
    { value: 'otro', label: 'Otro' },
];

// ─── Program Dialog ───────────────────────────────────────────────────────────

interface ProgramDialogProps {
    program: Partial<Program> | null;
    onClose: () => void;
    onSaved: () => void;
}

function ProgramDialog({ program, onClose, onSaved }: ProgramDialogProps) {
    const { fetchApi } = useApi();
    const isEdit = !!program?.id;

    const [name, setName] = useState(program?.name ?? '');
    const [description, setDescription] = useState(program?.description ?? '');
    const [schedule, setSchedule] = useState(program?.schedule ?? '');
    const [urls, setUrls] = useState<ProgramUrl[]>(program?.urls ?? []);
    const [newUrlType, setNewUrlType] = useState('youtube');
    const [newUrlValue, setNewUrlValue] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const addUrl = () => {
        if (!newUrlValue.trim()) return;
        setUrls([...urls, { type: newUrlType, url: newUrlValue.trim() }]);
        setNewUrlValue('');
    };

    const removeUrl = (idx: number) => {
        setUrls(urls.filter((_, i) => i !== idx));
    };

    const save = async () => {
        if (!name.trim()) { setError('El nombre es obligatorio'); return; }
        setSaving(true);
        setError('');
        try {
            const body = { name: name.trim(), description, schedule, urls };
            if (isEdit) {
                await fetchApi(`/programs/${program!.id}`, { method: 'PUT', body });
            } else {
                await fetchApi('/programs', { method: 'POST', body });
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
            <div className="modal-content max-w-lg w-full">
                <div className="modal-header">
                    <h2 className="text-base font-semibold text-white/85">
                        {isEdit ? 'Editar programa' : 'Nuevo programa'}
                    </h2>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors">
                        <X className="w-4 h-4 text-white/50" />
                    </button>
                </div>
                <div className="modal-body space-y-5">
                    {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>}

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Nombre *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="input-premium"
                            placeholder="Ej: Informativo de la Mañana"
                            autoFocus
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Descripción</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            className="input-premium resize-none"
                            rows={3}
                            placeholder="Descripción breve del programa..."
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Horario</label>
                        <input
                            type="text"
                            value={schedule}
                            onChange={(e) => setSchedule(e.target.value)}
                            className="input-premium"
                            placeholder="Ej: Lunes a Viernes 9-12hs"
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">
                            <Link2 className="w-3.5 h-3.5 inline mr-1" />
                            Enlaces
                        </label>

                        {urls.length > 0 && (
                            <div className="space-y-2 mb-3">
                                {urls.map((u, idx) => (
                                    <div key={idx} className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                                        <span className="badge badge-info shrink-0 capitalize">{u.type}</span>
                                        <span className="text-sm text-white/60 flex-1 truncate">{u.url}</span>
                                        <button onClick={() => removeUrl(idx)} className="text-white/25 hover:text-red-400 transition-colors shrink-0">
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="flex gap-2">
                            <div className="relative">
                                <select
                                    value={newUrlType}
                                    onChange={(e) => setNewUrlType(e.target.value)}
                                    className="input-premium appearance-none pr-8 !py-3 !px-4 text-sm cursor-pointer w-40"
                                >
                                    {URL_TYPES.map((t) => (
                                        <option key={t.value} value={t.value} className="bg-[#0c1018]">{t.label}</option>
                                    ))}
                                </select>
                                <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                            <input
                                type="url"
                                value={newUrlValue}
                                onChange={(e) => setNewUrlValue(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && addUrl()}
                                className="input-premium !py-3 flex-1 text-sm"
                                placeholder="https://..."
                            />
                            <button
                                onClick={addUrl}
                                className="btn-secondary !py-2 !px-4 !text-sm shrink-0"
                            >
                                Agregar
                            </button>
                        </div>
                    </div>
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} className="btn-secondary !py-2.5 !px-5 !text-sm">Cancelar</button>
                    <button onClick={save} disabled={saving} className="btn-primary !py-2.5 !px-5 !text-sm inline-flex items-center gap-2">
                        {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear programa'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Conductor Dialog ─────────────────────────────────────────────────────────

interface ConductorDialogProps {
    conductor: Partial<Conductor> | null;
    programId: string;
    onClose: () => void;
    onSaved: () => void;
}

function ConductorDialog({ conductor, programId, onClose, onSaved }: ConductorDialogProps) {
    const { fetchApi } = useApi();

    // conductorId tracks the persisted ID — starts with conductor.id (edit) or null (create)
    const [conductorId, setConductorId] = useState<string | null>(conductor?.id ?? null);
    const isEdit = !!conductorId;

    const [name, setName] = useState(conductor?.name ?? '');
    const [role, setRole] = useState(conductor?.role ?? 'conductor');
    const [bio, setBio] = useState(conductor?.bio ?? '');
    const [photos, setPhotos] = useState<ConductorPhoto[]>(conductor?.photos ?? []);
    const [photoUploading, setPhotoUploading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [justCreated, setJustCreated] = useState(false);
    const [error, setError] = useState('');
    const photoInputRef = useRef<HTMLInputElement>(null);

    const primaryPhoto = photos.find((p) => p.isPrimary) ?? photos[0] ?? null;
    const initials = name
        .split(' ')
        .map((w) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

    const uploadPhoto = async (file: File) => {
        if (file.size > 2 * 1024 * 1024) {
            setError('El archivo supera los 2MB permitidos');
            return;
        }
        if (!conductorId) return;
        setPhotoUploading(true);
        try {
            const fd = new FormData();
            fd.append('photo', file);
            const res = await fetchApi<{ photo: ConductorPhoto }>(`/conductors/${conductorId}/photos`, { method: 'POST', body: fd });
            setPhotos((prev) => [...prev, res.photo]);
        } catch (err: any) {
            setError(err.message || 'Error al subir la foto');
        }
        setPhotoUploading(false);
    };

    const deletePhoto = async (photoId: string) => {
        if (!conductorId) return;
        try {
            await fetchApi(`/conductors/${conductorId}/photos/${photoId}`, { method: 'DELETE' });
            setPhotos((prev) => {
                const remaining = prev.filter((p) => p.id !== photoId);
                // If deleted photo was primary, promote the first remaining
                const wasDeleted = prev.find((p) => p.id === photoId);
                if (wasDeleted?.isPrimary && remaining.length > 0) {
                    return remaining.map((p, i) => ({ ...p, isPrimary: i === 0 }));
                }
                return remaining;
            });
        } catch (err: any) {
            setError(err.message || 'Error al eliminar la foto');
        }
    };

    const setPrimaryPhoto = async (photoId: string) => {
        if (!conductorId) return;
        try {
            await fetchApi(`/conductors/${conductorId}/photos/${photoId}/primary`, { method: 'PUT' });
            setPhotos((prev) => prev.map((p) => ({ ...p, isPrimary: p.id === photoId })));
        } catch (err: any) {
            setError(err.message || 'Error al actualizar foto principal');
        }
    };

    const save = async () => {
        if (!name.trim()) { setError('El nombre es obligatorio'); return; }
        setSaving(true);
        setError('');
        try {
            const body = { name: name.trim(), role, bio, programId };
            if (isEdit) {
                await fetchApi(`/conductors/${conductorId}`, { method: 'PUT', body });
                onSaved();
                onClose();
            } else {
                const res = await fetchApi<{ conductor: Conductor }>('/conductors', { method: 'POST', body });
                // Switch to edit mode so photos can be uploaded immediately
                setConductorId(res.conductor.id);
                setJustCreated(true);
                onSaved();
            }
        } catch (err: any) {
            setError(err.message || 'Error al guardar');
        }
        setSaving(false);
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal-content max-w-lg w-full">
                <div className="modal-header">
                    <h2 className="text-base font-semibold text-white/85">
                        {isEdit ? (justCreated ? 'Conductor creado' : 'Editar conductor') : 'Nuevo conductor'}
                    </h2>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors">
                        <X className="w-4 h-4 text-white/50" />
                    </button>
                </div>
                <div className="modal-body space-y-5">
                    {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>}

                    {justCreated && (
                        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/20">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                            <p className="text-sm text-green-300">Conductor creado. Ahora podés agregar fotos.</p>
                        </div>
                    )}

                    {/* Profile photo header — shown in edit mode */}
                    {isEdit && (
                        <div className="flex items-center gap-4 px-1">
                            <div className="relative shrink-0">
                                <div className="w-20 h-20 rounded-2xl bg-white/[0.04] border border-white/[0.08] overflow-hidden flex items-center justify-center">
                                    {primaryPhoto
                                        ? <img
                                            src={photoSrc(conductorId!, primaryPhoto.id)}
                                            alt={name}
                                            className="w-full h-full object-cover"
                                          />
                                        : <span className="text-xl font-bold text-white/30">{initials || '?'}</span>
                                    }
                                </div>
                                {primaryPhoto && (
                                    <div className="absolute -top-1 -right-1 bg-yellow-400 rounded-full p-0.5 ring-2 ring-[#0c1018]">
                                        <Star className="w-2.5 h-2.5 text-black" />
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-white/80 truncate">{name || 'Sin nombre'}</p>
                                <p className="text-xs text-white/35 mt-0.5 capitalize">{CONDUCTOR_ROLES.find((r) => r.value === role)?.label ?? role}</p>
                                {photos.length > 0 && (
                                    <p className="text-xs text-white/25 mt-1">{photos.length} {photos.length === 1 ? 'foto' : 'fotos'}</p>
                                )}
                            </div>
                        </div>
                    )}

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Nombre *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="input-premium"
                            placeholder="Ej: María García"
                            autoFocus={!isEdit}
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Rol</label>
                        <div className="relative">
                            <select
                                value={role}
                                onChange={(e) => setRole(e.target.value)}
                                className="input-premium appearance-none pr-8 cursor-pointer"
                            >
                                {CONDUCTOR_ROLES.map((r) => (
                                    <option key={r.value} value={r.value} className="bg-[#0c1018]">{r.label}</option>
                                ))}
                            </select>
                            <ChevronDown className="w-4 h-4 text-white/30 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Biografía</label>
                        <textarea
                            value={bio}
                            onChange={(e) => setBio(e.target.value)}
                            className="input-premium resize-none"
                            rows={3}
                            placeholder="Breve descripción del conductor..."
                        />
                    </div>

                    {isEdit && (
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Fotos</label>
                            {photos.length > 0 && (
                                <div className="grid grid-cols-3 gap-2 mb-3">
                                    {photos.map((photo) => (
                                        <div key={photo.id} className="relative group rounded-xl overflow-hidden aspect-square bg-white/[0.03] border border-white/[0.07]">
                                            <img
                                                src={photoSrc(conductorId!, photo.id)}
                                                alt=""
                                                className="w-full h-full object-cover"
                                            />
                                            {photo.isPrimary && (
                                                <div className="absolute top-1.5 left-1.5 bg-yellow-400/90 rounded-full p-0.5">
                                                    <Star className="w-3 h-3 text-black" />
                                                </div>
                                            )}
                                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1.5 p-1">
                                                {!photo.isPrimary && (
                                                    <button
                                                        onClick={() => setPrimaryPhoto(photo.id)}
                                                        className="text-xs text-yellow-300 hover:text-yellow-200 transition-colors font-medium"
                                                    >
                                                        Hacer principal
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => deletePhoto(photo.id)}
                                                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                                                >
                                                    Eliminar
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {photos.length < 5 && (
                                <button
                                    onClick={() => photoInputRef.current?.click()}
                                    disabled={photoUploading}
                                    className="btn-secondary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                                >
                                    <Plus className="w-4 h-4" />
                                    {photoUploading ? 'Subiendo...' : 'Agregar foto'}
                                </button>
                            )}
                            <p className="text-xs text-white/25 mt-2">PNG o JPEG · Máximo 2MB · Hasta 5 fotos</p>
                            <input
                                ref={photoInputRef}
                                type="file"
                                accept="image/png,image/jpeg"
                                className="hidden"
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = ''; }}
                            />
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} className="btn-secondary !py-2.5 !px-5 !text-sm">
                        {justCreated ? 'Listo' : 'Cancelar'}
                    </button>
                    <button onClick={save} disabled={saving} className="btn-primary !py-2.5 !px-5 !text-sm inline-flex items-center gap-2">
                        {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear conductor'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Dossier Panel (Premium Intelligence Brief) ─────────────────────────────

function DossierPanel({ guestId, guestName }: { guestId: string; guestName: string }) {
    const { fetchApi } = useApi();
    const [dossier, setDossier] = useState<GuestDossier | null>(null);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
    const [checkedTalking, setCheckedTalking] = useState<Set<number>>(new Set());
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchDossier = async () => {
        try {
            const data = await fetchApi<{ dossier: GuestDossier | null }>(`/guests/${guestId}/dossier`);
            setDossier(data.dossier);
            if (data.dossier?.status === 'generating') {
                startPolling();
            } else {
                stopPolling();
                setGenerating(false);
            }
        } catch { /* ignore */ }
        setLoading(false);
    };

    const startPolling = () => {
        if (pollRef.current) return;
        pollRef.current = setInterval(fetchDossier, 4000);
    };

    const stopPolling = () => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    };

    useEffect(() => {
        fetchDossier();
        return () => stopPolling();
    }, [guestId]);

    const generate = async () => {
        setGenerating(true);
        try {
            await fetchApi(`/guests/${guestId}/dossier`, { method: 'POST' });
            await fetchDossier();
        } catch {
            setGenerating(false);
        }
    };

    const copyQuestion = (text: string, idx: number) => {
        navigator.clipboard.writeText(text);
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 1500);
    };

    const toggleTalking = (idx: number) => {
        setCheckedTalking((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx);
            else next.add(idx);
            return next;
        });
    };

    // Loading state
    if (loading) {
        return (
            <div className="space-y-3 animate-pulse">
                <div className="h-20 rounded-xl bg-white/[0.03]" />
                <div className="h-32 rounded-xl bg-white/[0.03]" />
                <div className="h-24 rounded-xl bg-white/[0.03]" />
            </div>
        );
    }

    // No dossier — generate button
    if (!dossier || dossier.status === 'error') {
        return (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/10 to-purple-500/10 flex items-center justify-center mb-4 ring-1 ring-white/[0.06]">
                    <FileSearch className="w-7 h-7 text-cyan-400/60" />
                </div>
                {dossier?.status === 'error' && (
                    <p className="text-xs text-amber-400/70 mb-2">El dossier anterior tuvo un error.</p>
                )}
                <p className="text-sm text-white/40 mb-4">
                    Genera un informe de inteligencia sobre <span className="text-white/60 font-medium">{guestName}</span>
                </p>
                <button
                    onClick={generate}
                    disabled={generating}
                    className="btn-primary inline-flex items-center gap-2 !py-2.5 !px-5 !text-sm"
                >
                    {generating ? (
                        <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            Investigando...
                        </>
                    ) : (
                        <>
                            <FileSearch className="w-4 h-4" />
                            Generar Dossier
                        </>
                    )}
                </button>
            </div>
        );
    }

    // Generating — skeleton with pulse
    if (dossier.status === 'generating') {
        return (
            <div className="space-y-3">
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-cyan-500/5 border border-cyan-500/15">
                    <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin shrink-0" />
                    <div>
                        <p className="text-sm text-cyan-300 font-medium">Investigando...</p>
                        <p className="text-xs text-white/30 mt-0.5">Buscando en la web y generando el dossier con IA</p>
                    </div>
                </div>
                <div className="space-y-2 animate-pulse">
                    {[1, 2, 3, 4, 5].map((i) => (
                        <div key={i} className="rounded-xl bg-white/[0.02] border border-white/[0.04]" style={{ height: `${40 + i * 12}px` }} />
                    ))}
                </div>
            </div>
        );
    }

    // Ready — full dossier view
    const c = dossier.content!;

    return (
        <div className="space-y-4">
            {/* Summary card — gradient accent */}
            <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-gradient-to-br from-cyan-500/[0.06] via-transparent to-purple-500/[0.04] p-4">
                <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-cyan-400/40 via-purple-400/30 to-transparent" />
                <p className="text-sm text-white/75 leading-relaxed">{c.summary}</p>
                {dossier.generatedAt && (
                    <p className="text-[10px] text-white/20 mt-3 uppercase tracking-wider">
                        Generado {new Date(dossier.generatedAt).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </p>
                )}
            </div>

            {/* Bio */}
            {c.bio && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <BookOpen className="w-3.5 h-3.5 text-cyan-400/60" />
                        <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Biografia</h4>
                    </div>
                    <p className="text-sm text-white/60 leading-relaxed">{c.bio}</p>
                </div>
            )}

            {/* Recent Activity — timeline */}
            {c.recentActivity.length > 0 && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <Lightbulb className="w-3.5 h-3.5 text-cyan-400/60" />
                        <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Actividad Reciente</h4>
                    </div>
                    <div className="space-y-2">
                        {c.recentActivity.map((item, i) => (
                            <div key={i} className="flex gap-3 items-start">
                                <div className="mt-1.5 shrink-0">
                                    <div className="w-1.5 h-1.5 rounded-full bg-cyan-400/40" />
                                </div>
                                <p className="text-sm text-white/55 leading-relaxed">{item}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Controversies — warning cards */}
            {c.controversies.length > 0 && c.controversies[0] !== 'Sin controversias conocidas' && (
                <div className="rounded-xl border border-amber-500/15 bg-amber-500/[0.03] p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70" />
                        <h4 className="text-xs font-semibold text-amber-400/60 uppercase tracking-wider">Temas Sensibles</h4>
                    </div>
                    <div className="space-y-2">
                        {c.controversies.map((item, i) => (
                            <div key={i} className="flex gap-3 items-start px-3 py-2 rounded-lg bg-amber-500/[0.04] border border-amber-500/10">
                                <ChevronRight className="w-3.5 h-3.5 text-amber-400/50 mt-0.5 shrink-0" />
                                <p className="text-sm text-amber-200/60 leading-relaxed">{item}</p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Suggested Questions — numbered with copy */}
            {c.suggestedQuestions.length > 0 && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <MessageSquare className="w-3.5 h-3.5 text-purple-400/60" />
                        <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Preguntas Sugeridas</h4>
                    </div>
                    <div className="space-y-1.5">
                        {c.suggestedQuestions.map((q, i) => (
                            <div key={i} className="group flex items-start gap-3 px-3 py-2.5 rounded-lg hover:bg-white/[0.03] transition-colors">
                                <span className="text-xs font-bold text-purple-400/40 mt-0.5 w-5 shrink-0 text-right">{i + 1}.</span>
                                <p className="text-sm text-white/60 leading-relaxed flex-1">{q}</p>
                                <button
                                    onClick={() => copyQuestion(q, i)}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5"
                                    title="Copiar pregunta"
                                >
                                    {copiedIdx === i
                                        ? <Check className="w-3.5 h-3.5 text-green-400" />
                                        : <Copy className="w-3.5 h-3.5 text-white/25 hover:text-white/50" />
                                    }
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Key Facts — pill badges */}
            {c.keyFacts.length > 0 && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <Tag className="w-3.5 h-3.5 text-cyan-400/60" />
                        <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Datos Clave</h4>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {c.keyFacts.map((fact, i) => (
                            <span key={i} className="inline-flex items-center px-3 py-1.5 rounded-full text-xs text-white/55 bg-white/[0.04] border border-white/[0.08] leading-tight">
                                {fact}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Talking Points — checklist */}
            {c.talkingPoints.length > 0 && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <Check className="w-3.5 h-3.5 text-green-400/60" />
                        <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Puntos de Conversacion</h4>
                    </div>
                    <div className="space-y-1">
                        {c.talkingPoints.map((point, i) => (
                            <button
                                key={i}
                                onClick={() => toggleTalking(i)}
                                className="w-full flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.03] transition-colors text-left"
                            >
                                <div className={`mt-0.5 w-4 h-4 rounded border shrink-0 flex items-center justify-center transition-colors ${
                                    checkedTalking.has(i)
                                        ? 'bg-green-500/20 border-green-500/30'
                                        : 'border-white/15 bg-white/[0.02]'
                                }`}>
                                    {checkedTalking.has(i) && <Check className="w-2.5 h-2.5 text-green-400" />}
                                </div>
                                <span className={`text-sm leading-relaxed transition-colors ${
                                    checkedTalking.has(i) ? 'text-white/30 line-through' : 'text-white/55'
                                }`}>
                                    {point}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Related Topics */}
            {c.relatedTopics.length > 0 && (
                <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-center gap-2 mb-3">
                        <Link2 className="w-3.5 h-3.5 text-white/30" />
                        <h4 className="text-xs font-semibold text-white/50 uppercase tracking-wider">Temas Relacionados</h4>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {c.relatedTopics.map((topic, i) => (
                            <span key={i} className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs text-white/40 bg-white/[0.03] border border-white/[0.05]">
                                {topic}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Regenerate button */}
            <div className="pt-2 flex justify-center">
                <button
                    onClick={generate}
                    disabled={generating}
                    className="btn-secondary inline-flex items-center gap-2 !py-2 !px-4 !text-xs"
                >
                    {generating ? (
                        <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            Regenerando...
                        </>
                    ) : (
                        <>
                            <RefreshCw className="w-3.5 h-3.5" />
                            Regenerar dossier
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}

// ─── Guest Dialog ─────────────────────────────────────────────────────────────

interface GuestDialogProps {
    guest: Partial<Guest> | null;
    programId: string;
    onClose: () => void;
    onSaved: () => void;
}

function GuestDialog({ guest, programId, onClose, onSaved }: GuestDialogProps) {
    const { fetchApi } = useApi();

    const [guestId, setGuestId] = useState<string | null>(guest?.id ?? null);
    const isEdit = !!guestId;

    const [name, setName] = useState(guest?.name ?? '');
    const [role, setRole] = useState(guest?.role ?? 'entrevistado');
    const [bio, setBio] = useState(guest?.bio ?? '');
    const [scheduledDate, setScheduledDate] = useState(guest?.scheduledDate ?? new Date().toISOString().split('T')[0]);
    const [scheduledTimeStart, setScheduledTimeStart] = useState(guest?.scheduledTimeStart ?? '');
    const [scheduledTimeEnd, setScheduledTimeEnd] = useState(guest?.scheduledTimeEnd ?? '');
    const [photos, setPhotos] = useState<GuestPhoto[]>(guest?.photos ?? []);
    const [photoUploading, setPhotoUploading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [justCreated, setJustCreated] = useState(false);
    const [error, setError] = useState('');
    const [dialogTab, setDialogTab] = useState<'datos' | 'dossier'>('datos');
    const photoInputRef = useRef<HTMLInputElement>(null);

    const primaryPhoto = photos.find((p) => p.isPrimary) ?? photos[0] ?? null;
    const initials = name
        .split(' ')
        .map((w) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();

    const uploadPhoto = async (file: File) => {
        if (file.size > 2 * 1024 * 1024) {
            setError('El archivo supera los 2MB permitidos');
            return;
        }
        if (!guestId) return;
        setPhotoUploading(true);
        try {
            const fd = new FormData();
            fd.append('photo', file);
            const res = await fetchApi<{ photo: GuestPhoto }>(`/guests/${guestId}/photos`, { method: 'POST', body: fd });
            setPhotos((prev) => [...prev, res.photo]);
        } catch (err: any) {
            setError(err.message || 'Error al subir la foto');
        }
        setPhotoUploading(false);
    };

    const deletePhoto = async (photoId: string) => {
        if (!guestId) return;
        try {
            await fetchApi(`/guests/${guestId}/photos/${photoId}`, { method: 'DELETE' });
            setPhotos((prev) => {
                const remaining = prev.filter((p) => p.id !== photoId);
                const wasDeleted = prev.find((p) => p.id === photoId);
                if (wasDeleted?.isPrimary && remaining.length > 0) {
                    return remaining.map((p, i) => ({ ...p, isPrimary: i === 0 }));
                }
                return remaining;
            });
        } catch (err: any) {
            setError(err.message || 'Error al eliminar la foto');
        }
    };

    const setPrimaryPhoto = async (photoId: string) => {
        if (!guestId) return;
        try {
            await fetchApi(`/guests/${guestId}/photos/${photoId}/primary`, { method: 'PUT' });
            setPhotos((prev) => prev.map((p) => ({ ...p, isPrimary: p.id === photoId })));
        } catch (err: any) {
            setError(err.message || 'Error al actualizar foto principal');
        }
    };

    const save = async () => {
        if (!name.trim()) { setError('El nombre es obligatorio'); return; }
        if (!scheduledDate) { setError('La fecha es obligatoria'); return; }
        if (scheduledTimeStart && scheduledTimeEnd && scheduledTimeEnd <= scheduledTimeStart) {
            setError('La hora de fin debe ser posterior a la hora de inicio');
            return;
        }
        setSaving(true);
        setError('');
        try {
            const body = {
                name: name.trim(),
                role,
                bio,
                programId,
                scheduledDate,
                scheduledTimeStart: scheduledTimeStart || undefined,
                scheduledTimeEnd: scheduledTimeEnd || undefined,
            };
            if (isEdit) {
                await fetchApi(`/guests/${guestId}`, { method: 'PUT', body });
                onSaved();
                onClose();
            } else {
                const res = await fetchApi<{ guest: Guest }>('/guests', { method: 'POST', body });
                setGuestId(res.guest.id);
                setJustCreated(true);
                onSaved();
            }
        } catch (err: any) {
            setError(err.message || 'Error al guardar');
        }
        setSaving(false);
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className={`modal-content w-full ${isEdit ? 'max-w-2xl' : 'max-w-lg'}`}>
                <div className="modal-header">
                    <h2 className="text-base font-semibold text-white/85">
                        {isEdit ? (justCreated ? 'Invitado creado' : 'Editar invitado') : 'Nuevo invitado'}
                    </h2>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors">
                        <X className="w-4 h-4 text-white/50" />
                    </button>
                </div>

                {/* Tabs — only in edit mode */}
                {isEdit && (
                    <div className="flex items-center gap-1 px-6 border-b border-white/[0.06]">
                        <button
                            onClick={() => setDialogTab('datos')}
                            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                dialogTab === 'datos'
                                    ? 'border-cyan-400 text-cyan-400'
                                    : 'border-transparent text-white/40 hover:text-white/60'
                            }`}
                        >
                            Datos
                        </button>
                        <button
                            onClick={() => setDialogTab('dossier')}
                            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors inline-flex items-center gap-1.5 ${
                                dialogTab === 'dossier'
                                    ? 'border-purple-400 text-purple-400'
                                    : 'border-transparent text-white/40 hover:text-white/60'
                            }`}
                        >
                            <FileSearch className="w-3.5 h-3.5" />
                            Dossier
                        </button>
                    </div>
                )}

                {/* ── Datos tab ── */}
                {dialogTab === 'datos' && (
                    <>
                        <div className="modal-body space-y-5">
                            {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>}

                            {justCreated && (
                                <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/20">
                                    <div className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                                    <p className="text-sm text-green-300">Invitado creado. Ahora podes agregar fotos.</p>
                                </div>
                            )}

                            {isEdit && (
                                <div className="flex items-center gap-4 px-1">
                                    <div className="relative shrink-0">
                                        <div className="w-20 h-20 rounded-2xl bg-white/[0.04] border border-white/[0.08] overflow-hidden flex items-center justify-center">
                                            {primaryPhoto
                                                ? <img
                                                    src={guestPhotoSrc(guestId!, primaryPhoto.id)}
                                                    alt={name}
                                                    className="w-full h-full object-cover"
                                                  />
                                                : <span className="text-xl font-bold text-white/30">{initials || '?'}</span>
                                            }
                                        </div>
                                        {primaryPhoto && (
                                            <div className="absolute -top-1 -right-1 bg-yellow-400 rounded-full p-0.5 ring-2 ring-[#0c1018]">
                                                <Star className="w-2.5 h-2.5 text-black" />
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-white/80 truncate">{name || 'Sin nombre'}</p>
                                        <p className="text-xs text-white/35 mt-0.5 capitalize">{GUEST_ROLES.find((r) => r.value === role)?.label ?? role}</p>
                                        {photos.length > 0 && (
                                            <p className="text-xs text-white/25 mt-1">{photos.length} {photos.length === 1 ? 'foto' : 'fotos'}</p>
                                        )}
                                    </div>
                                </div>
                            )}

                            <div>
                                <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Nombre *</label>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    className="input-premium"
                                    placeholder="Ej: Juan Perez"
                                    autoFocus={!isEdit}
                                />
                            </div>

                            <div>
                                <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Rol</label>
                                <div className="relative">
                                    <select
                                        value={role}
                                        onChange={(e) => setRole(e.target.value)}
                                        className="input-premium appearance-none pr-8 cursor-pointer"
                                    >
                                        {GUEST_ROLES.map((r) => (
                                            <option key={r.value} value={r.value} className="bg-[#0c1018]">{r.label}</option>
                                        ))}
                                    </select>
                                    <ChevronDown className="w-4 h-4 text-white/30 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>

                            <div>
                                <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Biografia</label>
                                <textarea
                                    value={bio}
                                    onChange={(e) => setBio(e.target.value)}
                                    className="input-premium resize-none"
                                    rows={3}
                                    placeholder="Breve descripcion del invitado..."
                                />
                            </div>

                            <div>
                                <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Fecha *</label>
                                <input
                                    type="date"
                                    value={scheduledDate}
                                    onChange={(e) => setScheduledDate(e.target.value)}
                                    className="input-premium"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Hora inicio</label>
                                    <input
                                        type="time"
                                        value={scheduledTimeStart}
                                        onChange={(e) => {
                                            setScheduledTimeStart(e.target.value);
                                            if (!e.target.value) setScheduledTimeEnd('');
                                        }}
                                        className="input-premium"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Hora fin</label>
                                    <input
                                        type="time"
                                        value={scheduledTimeEnd}
                                        onChange={(e) => setScheduledTimeEnd(e.target.value)}
                                        className="input-premium"
                                        disabled={!scheduledTimeStart}
                                    />
                                </div>
                            </div>

                            {isEdit && (
                                <div>
                                    <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Fotos</label>
                                    {photos.length > 0 && (
                                        <div className="grid grid-cols-3 gap-2 mb-3">
                                            {photos.map((photo) => (
                                                <div key={photo.id} className="relative group rounded-xl overflow-hidden aspect-square bg-white/[0.03] border border-white/[0.07]">
                                                    <img
                                                        src={guestPhotoSrc(guestId!, photo.id)}
                                                        alt=""
                                                        className="w-full h-full object-cover"
                                                    />
                                                    {photo.isPrimary && (
                                                        <div className="absolute top-1.5 left-1.5 bg-yellow-400/90 rounded-full p-0.5">
                                                            <Star className="w-3 h-3 text-black" />
                                                        </div>
                                                    )}
                                                    <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1.5 p-1">
                                                        {!photo.isPrimary && (
                                                            <button
                                                                onClick={() => setPrimaryPhoto(photo.id)}
                                                                className="text-xs text-yellow-300 hover:text-yellow-200 transition-colors font-medium"
                                                            >
                                                                Hacer principal
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => deletePhoto(photo.id)}
                                                            className="text-xs text-red-400 hover:text-red-300 transition-colors"
                                                        >
                                                            Eliminar
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {photos.length < 5 && (
                                        <button
                                            onClick={() => photoInputRef.current?.click()}
                                            disabled={photoUploading}
                                            className="btn-secondary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                                        >
                                            <Plus className="w-4 h-4" />
                                            {photoUploading ? 'Subiendo...' : 'Agregar foto'}
                                        </button>
                                    )}
                                    <p className="text-xs text-white/25 mt-2">PNG o JPEG - Maximo 2MB - Hasta 5 fotos</p>
                                    <input
                                        ref={photoInputRef}
                                        type="file"
                                        accept="image/png,image/jpeg"
                                        className="hidden"
                                        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = ''; }}
                                    />
                                </div>
                            )}
                        </div>
                        <div className="modal-footer">
                            <button onClick={onClose} className="btn-secondary !py-2.5 !px-5 !text-sm">
                                {justCreated ? 'Listo' : 'Cancelar'}
                            </button>
                            <button onClick={save} disabled={saving} className="btn-primary !py-2.5 !px-5 !text-sm inline-flex items-center gap-2">
                                {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear invitado'}
                            </button>
                        </div>
                    </>
                )}

                {/* ── Dossier tab ── */}
                {dialogTab === 'dossier' && isEdit && (
                    <div className="modal-body max-h-[70vh] overflow-y-auto">
                        <DossierPanel guestId={guestId!} guestName={name} />
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── Programs Page ─────────────────────────────────────────────────────────────

export function ProgramsPage() {
    const { fetchApi } = useApi();

    // Programs
    const [programs, setPrograms] = useState<Program[]>([]);
    const [loadingPrograms, setLoadingPrograms] = useState(true);
    const [selectedProgram, setSelectedProgram] = useState<Program | null>(null);
    const [programDialog, setProgramDialog] = useState<{ open: boolean; program: Partial<Program> | null }>({ open: false, program: null });

    // Tabs
    const [activeTab, setActiveTab] = useState<'conductors' | 'guests'>('conductors');

    // Conductors
    const [conductors, setConductors] = useState<Conductor[]>([]);
    const [loadingConductors, setLoadingConductors] = useState(false);
    const [conductorDialog, setConductorDialog] = useState<{ open: boolean; conductor: Partial<Conductor> | null }>({ open: false, conductor: null });

    // Guests
    const [guests, setGuests] = useState<Guest[]>([]);
    const [loadingGuests, setLoadingGuests] = useState(false);
    const [guestDialog, setGuestDialog] = useState<{ open: boolean; guest: Partial<Guest> | null }>({ open: false, guest: null });
    const [guestDateFilter, setGuestDateFilter] = useState(new Date().toISOString().split('T')[0]);
    const [dossierStatuses, setDossierStatuses] = useState<Record<string, string>>({});

    const loadPrograms = async () => {
        setLoadingPrograms(true);
        try {
            const data = await fetchApi<{ programs: Program[] }>('/programs');
            setPrograms(data.programs);
        } catch { /* ignore */ }
        setLoadingPrograms(false);
    };

    const loadConductors = async (programId: string) => {
        setLoadingConductors(true);
        try {
            const data = await fetchApi<{ conductors: Conductor[] }>(`/conductors?programId=${programId}`);
            setConductors(data.conductors);
        } catch { /* ignore */ }
        setLoadingConductors(false);
    };

    const loadGuests = async (programId: string, date?: string) => {
        setLoadingGuests(true);
        try {
            const dateParam = date || guestDateFilter;
            const data = await fetchApi<{ guests: Guest[] }>(`/guests?programId=${programId}&date=${dateParam}`);
            setGuests(data.guests);
            // Load dossier statuses for all guests
            loadDossierStatuses(data.guests.map((g) => g.id));
        } catch { /* ignore */ }
        setLoadingGuests(false);
    };

    const loadDossierStatuses = async (guestIds: string[]) => {
        const statuses: Record<string, string> = {};
        for (const id of guestIds) {
            try {
                const data = await fetchApi<{ dossier: GuestDossier | null }>(`/guests/${id}/dossier`);
                if (data.dossier) statuses[id] = data.dossier.status;
            } catch { /* ignore */ }
        }
        setDossierStatuses(statuses);
    };

    useEffect(() => { loadPrograms(); }, []);

    useEffect(() => {
        if (selectedProgram) loadConductors(selectedProgram.id);
        else setConductors([]);
    }, [selectedProgram]);

    useEffect(() => {
        if (selectedProgram && activeTab === 'guests') loadGuests(selectedProgram.id);
        else setGuests([]);
    }, [selectedProgram, activeTab, guestDateFilter]);

    const deleteProgram = async (id: string) => {
        if (!window.confirm('¿Eliminar este programa y todos sus conductores?')) return;
        try {
            await fetchApi(`/programs/${id}`, { method: 'DELETE' });
            if (selectedProgram?.id === id) setSelectedProgram(null);
            await loadPrograms();
        } catch (err: any) {
            alert(err.message || 'Error al eliminar');
        }
    };

    const deleteConductor = async (id: string) => {
        if (!window.confirm('¿Eliminar este conductor?')) return;
        try {
            await fetchApi(`/conductors/${id}`, { method: 'DELETE' });
            if (selectedProgram) await loadConductors(selectedProgram.id);
        } catch (err: any) {
            alert(err.message || 'Error al eliminar');
        }
    };

    const deleteGuest = async (id: string) => {
        if (!window.confirm('¿Eliminar este invitado?')) return;
        try {
            await fetchApi(`/guests/${id}`, { method: 'DELETE' });
            if (selectedProgram) loadGuests(selectedProgram.id);
        } catch { /* ignore */ }
    };

    const roleLabelFor = (value: string) => CONDUCTOR_ROLES.find((r) => r.value === value)?.label ?? value;

    const today = new Date().toISOString().split('T')[0];

    return (
        <div className="p-4 md:p-8 max-w-6xl mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* ── Programs List ── */}
                <div>
                    <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-xl bg-cyan-400/[0.1] flex items-center justify-center">
                                <Mic className="w-4 h-4 text-cyan-400" />
                            </div>
                            <h2 className="text-base font-bold text-white/85">Programas</h2>
                        </div>
                        <button
                            onClick={() => setProgramDialog({ open: true, program: null })}
                            className="btn-primary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                        >
                            <Plus className="w-4 h-4" />
                            Nuevo Programa
                        </button>
                    </div>

                    {loadingPrograms ? (
                        <div className="space-y-3">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="skeleton h-20 rounded-2xl" />
                            ))}
                        </div>
                    ) : programs.length === 0 ? (
                        <div className="glass-card-static p-10 text-center">
                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3 ring-1 ring-white/[0.06]">
                                <Mic className="w-6 h-6 text-white/15" />
                            </div>
                            <p className="text-white/30 text-sm">Aún no tenés programas. ¡Creá el primero!</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {programs.map((program) => (
                                <div
                                    key={program.id}
                                    onClick={() => setSelectedProgram(program.id === selectedProgram?.id ? null : program)}
                                    className={`glass-card-static p-4 cursor-pointer transition-all duration-200 ${
                                        selectedProgram?.id === program.id
                                            ? 'border-cyan-400/30 bg-cyan-400/[0.04] ring-1 ring-cyan-400/15'
                                            : 'hover:border-white/[0.1]'
                                    }`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <h3 className="text-sm font-semibold text-white/85 truncate">{program.name}</h3>
                                            {program.schedule && (
                                                <p className="text-xs text-white/40 mt-0.5">{program.schedule}</p>
                                            )}
                                            <div className="flex items-center gap-2 mt-2">
                                                {(program.urls?.length ?? 0) > 0 && (
                                                    <span className="badge badge-info">
                                                        <Link2 className="w-2.5 h-2.5 mr-1" />
                                                        {program.urls!.length} {program.urls!.length === 1 ? 'enlace' : 'enlaces'}
                                                    </span>
                                                )}
                                                {(program.conductorCount ?? 0) > 0 && (
                                                    <span className="badge badge-purple">
                                                        <Users className="w-2.5 h-2.5 mr-1" />
                                                        {program.conductorCount} {program.conductorCount === 1 ? 'conductor' : 'conductores'}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                                            <button
                                                onClick={() => setProgramDialog({ open: true, program })}
                                                className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors text-white/40 hover:text-white/70"
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                                onClick={() => deleteProgram(program.id)}
                                                className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-red-500/10 flex items-center justify-center transition-colors text-white/40 hover:text-red-400"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ── Right Panel (Conductors / Guests) ── */}
                <div>
                    {selectedProgram ? (
                        <>
                            {/* Panel header */}
                            <div className="flex items-center gap-2 mb-1">
                                <div className="w-8 h-8 rounded-xl bg-purple-400/[0.1] flex items-center justify-center shrink-0">
                                    <Users className="w-4 h-4 text-purple-400" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-xs text-white/30 leading-tight truncate">{selectedProgram.name}</p>
                                </div>
                            </div>

                            {/* Tab bar */}
                            <div className="flex items-center gap-1 border-b border-white/[0.06] mb-4">
                                <button
                                    onClick={() => setActiveTab('conductors')}
                                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                        activeTab === 'conductors'
                                            ? 'border-cyan-400 text-cyan-400'
                                            : 'border-transparent text-white/40 hover:text-white/60'
                                    }`}
                                >
                                    Conductores {conductors.length > 0 && `(${conductors.length})`}
                                </button>
                                <button
                                    onClick={() => setActiveTab('guests')}
                                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                        activeTab === 'guests'
                                            ? 'border-cyan-400 text-cyan-400'
                                            : 'border-transparent text-white/40 hover:text-white/60'
                                    }`}
                                >
                                    Invitados {guests.length > 0 && `(${guests.length})`}
                                </button>
                            </div>

                            {/* ── Conductors tab ── */}
                            {activeTab === 'conductors' && (
                                <>
                                    <div className="flex items-center justify-between mb-4">
                                        <p className="text-xs text-white/30">{conductors.length} {conductors.length === 1 ? 'conductor' : 'conductores'}</p>
                                        <button
                                            onClick={() => setConductorDialog({ open: true, conductor: null })}
                                            className="btn-secondary inline-flex items-center gap-2 !py-2 !px-3 !text-xs"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                            Nuevo Conductor
                                        </button>
                                    </div>

                                    {loadingConductors ? (
                                        <div className="space-y-3">
                                            {[1, 2].map((i) => (
                                                <div key={i} className="skeleton h-20 rounded-2xl" />
                                            ))}
                                        </div>
                                    ) : conductors.length === 0 ? (
                                        <div className="glass-card-static p-10 text-center">
                                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3 ring-1 ring-white/[0.06]">
                                                <Users className="w-6 h-6 text-white/15" />
                                            </div>
                                            <p className="text-white/30 text-sm">Este programa todavía no tiene conductores.</p>
                                        </div>
                                    ) : (
                                        <div className="space-y-3">
                                            {conductors.map((conductor) => {
                                                const primary = conductor.photos?.find((p) => p.isPrimary) ?? conductor.photos?.[0];
                                                const initials = conductor.name
                                                    .split(' ')
                                                    .map((w) => w[0])
                                                    .slice(0, 2)
                                                    .join('')
                                                    .toUpperCase();
                                                return (
                                                    <div key={conductor.id} className="glass-card-static p-4">
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-12 h-12 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center overflow-hidden shrink-0">
                                                                {primary
                                                                    ? <img src={photoSrc(conductor.id, primary.id)} alt={conductor.name} className="w-full h-full object-cover" />
                                                                    : <span className="text-sm font-bold text-white/40">{initials}</span>
                                                                }
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-sm font-semibold text-white/85 truncate">{conductor.name}</p>
                                                                <div className="flex items-center gap-2 mt-1">
                                                                    <span className="badge badge-purple capitalize">{roleLabelFor(conductor.role)}</span>
                                                                    {(conductor.photos?.length ?? 0) > 0 && (
                                                                        <span className="text-xs text-white/25">
                                                                            {conductor.photos!.length} {conductor.photos!.length === 1 ? 'foto' : 'fotos'}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 shrink-0">
                                                                <button
                                                                    onClick={() => setConductorDialog({ open: true, conductor })}
                                                                    className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors text-white/40 hover:text-white/70"
                                                                >
                                                                    <Pencil className="w-3.5 h-3.5" />
                                                                </button>
                                                                <button
                                                                    onClick={() => deleteConductor(conductor.id)}
                                                                    className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-red-500/10 flex items-center justify-center transition-colors text-white/40 hover:text-red-400"
                                                                >
                                                                    <Trash2 className="w-3.5 h-3.5" />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </>
                            )}

                            {/* ── Guests tab ── */}
                            {activeTab === 'guests' && (
                                <>
                                    {/* Date filter bar */}
                                    <div className="flex items-center gap-2 mb-4">
                                        <button
                                            onClick={() => setGuestDateFilter(today)}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                                guestDateFilter === today
                                                    ? 'bg-cyan-400/15 text-cyan-400 border border-cyan-400/20'
                                                    : 'bg-white/[0.04] text-white/40 hover:text-white/60 border border-white/[0.06]'
                                            }`}
                                        >
                                            Hoy
                                        </button>
                                        <div className="relative flex-1">
                                            <Calendar className="w-3.5 h-3.5 text-white/30 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                            <input
                                                type="date"
                                                value={guestDateFilter}
                                                onChange={(e) => setGuestDateFilter(e.target.value)}
                                                className="input-premium !py-1.5 !pl-9 !text-xs w-full"
                                            />
                                        </div>
                                        <button
                                            onClick={() => setGuestDialog({ open: true, guest: null })}
                                            className="btn-secondary inline-flex items-center gap-2 !py-2 !px-3 !text-xs shrink-0"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                            Nuevo Invitado
                                        </button>
                                    </div>

                                    {loadingGuests ? (
                                        <div className="space-y-3">
                                            {[1, 2].map((i) => (
                                                <div key={i} className="skeleton h-16 rounded-2xl" />
                                            ))}
                                        </div>
                                    ) : guests.length === 0 ? (
                                        <div className="glass-card-static p-10 text-center">
                                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3 ring-1 ring-white/[0.06]">
                                                <Users className="w-6 h-6 text-white/15" />
                                            </div>
                                            <p className="text-white/30 text-sm">No hay invitados para esta fecha.</p>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {guests.map((guest) => {
                                                const primaryPhoto = guest.photos?.find((p) => p.isPrimary) ?? guest.photos?.[0];
                                                const initials = guest.name
                                                    .split(' ')
                                                    .map((w) => w[0])
                                                    .slice(0, 2)
                                                    .join('')
                                                    .toUpperCase();
                                                return (
                                                    <div key={guest.id} className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06]">
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-10 h-10 rounded-full bg-white/[0.06] overflow-hidden flex items-center justify-center shrink-0">
                                                                {primaryPhoto
                                                                    ? <img src={guestPhotoSrc(guest.id, primaryPhoto.id)} className="w-full h-full object-cover" alt={guest.name} />
                                                                    : <span className="text-xs font-bold text-white/30">{initials}</span>
                                                                }
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-sm font-medium text-white/80 truncate">{guest.name}</p>
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-xs text-white/40">{GUEST_ROLES.find((r) => r.value === guest.role)?.label ?? guest.role}</span>
                                                                    {guest.scheduledTimeStart && (
                                                                        <span className="text-xs text-cyan-400/60">
                                                                            {guest.scheduledTimeStart}{guest.scheduledTimeEnd ? ` - ${guest.scheduledTimeEnd}` : ''}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 shrink-0">
                                                                {dossierStatuses[guest.id] === 'ready' && (
                                                                    <div className="w-6 h-6 rounded-md bg-green-500/10 flex items-center justify-center" title="Dossier listo">
                                                                        <FileSearch className="w-3 h-3 text-green-400" />
                                                                    </div>
                                                                )}
                                                                {dossierStatuses[guest.id] === 'generating' && (
                                                                    <div className="w-6 h-6 rounded-md bg-cyan-500/10 flex items-center justify-center" title="Generando dossier...">
                                                                        <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin" />
                                                                    </div>
                                                                )}
                                                                <button
                                                                    onClick={() => setGuestDialog({ open: true, guest })}
                                                                    className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors text-white/40 hover:text-white/70"
                                                                >
                                                                    <Pencil className="w-3.5 h-3.5" />
                                                                </button>
                                                                <button
                                                                    onClick={() => deleteGuest(guest.id)}
                                                                    className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-red-500/10 flex items-center justify-center transition-colors text-white/40 hover:text-red-400"
                                                                >
                                                                    <Trash2 className="w-3.5 h-3.5" />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </>
                            )}
                        </>
                    ) : (
                        <div className="glass-card-static p-10 text-center h-full flex flex-col items-center justify-center min-h-[200px]">
                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3 ring-1 ring-white/[0.06]">
                                <Users className="w-6 h-6 text-white/15" />
                            </div>
                            <p className="text-white/25 text-sm">Seleccioná un programa para ver sus conductores e invitados</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Dialogs */}
            {programDialog.open && (
                <ProgramDialog
                    program={programDialog.program}
                    onClose={() => setProgramDialog({ open: false, program: null })}
                    onSaved={loadPrograms}
                />
            )}

            {conductorDialog.open && selectedProgram && (
                <ConductorDialog
                    conductor={conductorDialog.conductor}
                    programId={selectedProgram.id}
                    onClose={() => setConductorDialog({ open: false, conductor: null })}
                    onSaved={() => loadConductors(selectedProgram.id)}
                />
            )}

            {guestDialog.open && selectedProgram && (
                <GuestDialog
                    guest={guestDialog.guest}
                    programId={selectedProgram.id}
                    onClose={() => setGuestDialog({ open: false, guest: null })}
                    onSaved={() => loadGuests(selectedProgram.id)}
                />
            )}
        </div>
    );
}
