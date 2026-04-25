import { useState, useEffect, useRef } from 'react';
import { Plus, Pencil, Trash2, Mic, Users, Link2, Star, ImageOff, X, ChevronDown } from 'lucide-react';
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

function photoSrc(conductorId: string, photoId: string): string {
    return `/api/conductors/${conductorId}/photos/${photoId}`;
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

// ─── Programs Page ─────────────────────────────────────────────────────────────

export function ProgramsPage() {
    const { fetchApi } = useApi();

    // Programs
    const [programs, setPrograms] = useState<Program[]>([]);
    const [loadingPrograms, setLoadingPrograms] = useState(true);
    const [selectedProgram, setSelectedProgram] = useState<Program | null>(null);
    const [programDialog, setProgramDialog] = useState<{ open: boolean; program: Partial<Program> | null }>({ open: false, program: null });

    // Conductors
    const [conductors, setConductors] = useState<Conductor[]>([]);
    const [loadingConductors, setLoadingConductors] = useState(false);
    const [conductorDialog, setConductorDialog] = useState<{ open: boolean; conductor: Partial<Conductor> | null }>({ open: false, conductor: null });

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

    useEffect(() => { loadPrograms(); }, []);

    useEffect(() => {
        if (selectedProgram) loadConductors(selectedProgram.id);
        else setConductors([]);
    }, [selectedProgram]);

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

    const roleLabelFor = (value: string) => CONDUCTOR_ROLES.find((r) => r.value === value)?.label ?? value;

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

                {/* ── Conductors Panel ── */}
                <div>
                    {selectedProgram ? (
                        <>
                            <div className="flex items-center justify-between mb-5">
                                <div className="flex items-center gap-2">
                                    <div className="w-8 h-8 rounded-xl bg-purple-400/[0.1] flex items-center justify-center">
                                        <Users className="w-4 h-4 text-purple-400" />
                                    </div>
                                    <div>
                                        <h2 className="text-base font-bold text-white/85 leading-tight">Conductores</h2>
                                        <p className="text-xs text-white/30 leading-tight">{selectedProgram.name}</p>
                                    </div>
                                </div>
                                <button
                                    onClick={() => setConductorDialog({ open: true, conductor: null })}
                                    className="btn-secondary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                                >
                                    <Plus className="w-4 h-4" />
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
                    ) : (
                        <div className="glass-card-static p-10 text-center h-full flex flex-col items-center justify-center min-h-[200px]">
                            <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3 ring-1 ring-white/[0.06]">
                                <Users className="w-6 h-6 text-white/15" />
                            </div>
                            <p className="text-white/25 text-sm">Seleccioná un programa para ver sus conductores</p>
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
        </div>
    );
}
