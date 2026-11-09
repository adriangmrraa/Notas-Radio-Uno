import { useState, useEffect, useRef, useCallback } from 'react';
import {
    Plus, Pencil, Trash2, Users, X, Star, ChevronDown, Camera,
    ChevronLeft, ChevronRight, Search,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PersonPhoto {
    id: string;
    personId: string;
    mimeType: string;
    isPrimary: boolean;
    faceDetected: boolean;
    faceCount: number;
    width: number | null;
    height: number | null;
    createdAt: string;
}

interface PersonProgramLink {
    id: string;
    programId: string;
    roleOnProgram: string | null;
    isPrimary: boolean;
    programName: string;
}

interface Person {
    id: string;
    name: string;
    role: string;
    roleLabel: string | null;
    bio: string | null;
    notes: string | null;
    socialLinks: Record<string, string>;
    isActive: boolean;
    createdAt: string;
    photos: PersonPhoto[];
    programs: PersonProgramLink[];
}

interface Program {
    id: string;
    name: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PERSON_ROLES = [
    { value: 'conductor', label: 'Conductor' },
    { value: 'columnista', label: 'Columnista' },
    { value: 'productor', label: 'Productor' },
    { value: 'invitado', label: 'Invitado' },
    { value: 'colaborador', label: 'Colaborador' },
    { value: 'otro', label: 'Otro' },
];

const SOCIAL_FIELDS = [
    { key: 'twitter', label: 'Twitter' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'linkedin', label: 'LinkedIn' },
    { key: 'x', label: 'X' },
    { key: 'web', label: 'Web' },
    { key: 'email', label: 'Email' },
] as const;

const PAGE_SIZE = 20;
const MAX_PHOTOS = 5;

function roleLabelFor(role: string): string {
    return PERSON_ROLES.find((r) => r.value === role)?.label ?? role;
}

function personPhotoSrc(personId: string, photoId: string): string {
    return `/api/persons/${personId}/photos/${photoId}`;
}

function initialsOf(name: string): string {
    return name
        .split(' ')
        .map((w) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
}

// ─── Person Dialog ───────────────────────────────────────────────────────────

interface PersonDialogProps {
    person: Person | null;
    programs: Program[];
    onClose: () => void;
    onSaved: () => void;
}

function PersonDialog({ person, programs, onClose, onSaved }: PersonDialogProps) {
    const { fetchApi } = useApi();

    const [personId, setPersonId] = useState<string | null>(person?.id ?? null);
    const isEdit = !!personId;

    const [name, setName] = useState(person?.name ?? '');
    const [role, setRole] = useState(person?.role ?? 'conductor');
    const [roleLabel, setRoleLabel] = useState(person?.roleLabel ?? '');
    const [bio, setBio] = useState(person?.bio ?? '');
    const [notes, setNotes] = useState(person?.notes ?? '');
    const [isActive, setIsActive] = useState(person?.isActive ?? true);
    const [socialLinks, setSocialLinks] = useState<Record<string, string>>(
        () => ({ ...(person?.socialLinks ?? {}) }),
    );
    const [programIds, setProgramIds] = useState<string[]>(
        () => person?.programs.map((p) => p.programId) ?? [],
    );
    const [roleOnProgram, setRoleOnProgram] = useState<Record<string, string>>(() => {
        const map: Record<string, string> = {};
        for (const p of person?.programs ?? []) {
            if (p.roleOnProgram) map[p.programId] = p.roleOnProgram;
        }
        return map;
    });

    const [photos, setPhotos] = useState<PersonPhoto[]>(person?.photos ?? []);
    const [photoUploading, setPhotoUploading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [justCreated, setJustCreated] = useState(false);
    const [error, setError] = useState('');
    const photoInputRef = useRef<HTMLInputElement>(null);

    const toggleProgram = (programId: string) => {
        setProgramIds((prev) =>
            prev.includes(programId) ? prev.filter((p) => p !== programId) : [...prev, programId],
        );
    };

    const setSocial = (key: string, value: string) => {
        setSocialLinks((prev) => ({ ...prev, [key]: value }));
    };

    const save = async (): Promise<string | null> => {
        if (!name.trim()) { setError('El nombre es obligatorio'); return null; }
        setSaving(true);
        setError('');
        try {
            const cleanSocial: Record<string, string> = {};
            for (const [k, v] of Object.entries(socialLinks)) {
                if (v && v.trim()) cleanSocial[k] = v.trim();
            }
            const body = {
                name: name.trim(),
                role,
                roleLabel: roleLabel.trim() || undefined,
                bio: bio.trim() || undefined,
                notes: notes.trim() || undefined,
                socialLinks: cleanSocial,
                isActive,
                programIds,
                roleOnProgram,
            };
            if (isEdit) {
                const res = await fetchApi<{ person: Person }>(`/persons/${personId}`, { method: 'PATCH', body });
                setPhotos(res.person.photos);
                return personId;
            }
            const res = await fetchApi<{ person: Person }>('/persons', { method: 'POST', body });
            setPersonId(res.person.id);
            setJustCreated(true);
            return res.person.id;
        } catch (err: any) {
            setError(err.message || 'Error al guardar');
            return null;
        } finally {
            setSaving(false);
        }
    };

    const saveAndClose = async () => {
        const id = await save();
        if (id) {
            onSaved();
            onClose();
        }
    };

    const uploadPhoto = async (file: File) => {
        if (file.size > 5 * 1024 * 1024) {
            setError('El archivo supera los 5MB permitidos');
            return;
        }
        if (!personId) return;
        setPhotoUploading(true);
        setError('');
        try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetchApi<{ photo: PersonPhoto }>(`/persons/${personId}/photos`, { method: 'POST', body: fd });
            setPhotos((prev) => [...prev, res.photo]);
        } catch (err: any) {
            setError(err.message || 'Error al subir la foto');
        }
        setPhotoUploading(false);
    };

    const deletePhoto = async (photoId: string) => {
        if (!personId) return;
        try {
            await fetchApi(`/persons/${personId}/photos/${photoId}`, { method: 'DELETE' });
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
        if (!personId) return;
        try {
            await fetchApi(`/persons/${personId}/photos/${photoId}/primary`, { method: 'PUT' });
            setPhotos((prev) => prev.map((p) => ({ ...p, isPrimary: p.id === photoId })));
        } catch (err: any) {
            setError(err.message || 'Error al actualizar la foto primaria');
        }
    };

    const initials = initialsOf(name || 'P');

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal-content max-w-2xl w-full">
                <div className="modal-header">
                    <h2 className="text-base font-semibold text-white/85">
                        {isEdit ? 'Editar persona' : 'Nueva persona'}
                    </h2>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors">
                        <X className="w-4 h-4 text-white/50" />
                    </button>
                </div>
                <div className="modal-body space-y-5">
                    {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Nombre *</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                className="input-premium"
                                placeholder="Ej: Ana García"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Rol</label>
                            <div className="relative">
                                <select
                                    value={role}
                                    onChange={(e) => setRole(e.target.value)}
                                    className="input-premium appearance-none pr-8 cursor-pointer w-full"
                                >
                                    {PERSON_ROLES.map((r) => (
                                        <option key={r.value} value={r.value} className="bg-[#0c1018]">{r.label}</option>
                                    ))}
                                </select>
                                <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Rol personalizado</label>
                        <input
                            type="text"
                            value={roleLabel}
                            onChange={(e) => setRoleLabel(e.target.value)}
                            className="input-premium"
                            placeholder="Ej: Conductora principal"
                            maxLength={120}
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Bio</label>
                        <textarea
                            value={bio}
                            onChange={(e) => setBio(e.target.value)}
                            className="input-premium resize-none"
                            rows={3}
                            placeholder="Biografía breve..."
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Notas internas</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            className="input-premium resize-none"
                            rows={2}
                            placeholder="Notas privadas del equipo..."
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Redes y contacto</label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {SOCIAL_FIELDS.map(({ key, label }) => (
                                <input
                                    key={key}
                                    type="text"
                                    value={socialLinks[key] ?? ''}
                                    onChange={(e) => setSocial(key, e.target.value)}
                                    className="input-premium !py-2.5 text-sm"
                                    placeholder={label}
                                />
                            ))}
                        </div>
                    </div>

                    {programs.length > 0 && (
                        <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">Programas asociados</label>
                            <div className="space-y-2">
                                {programs.map((program) => {
                                    const checked = programIds.includes(program.id);
                                    return (
                                        <div key={program.id} className="rounded-xl bg-white/[0.02] border border-white/[0.06] px-3 py-2.5">
                                            <label className="flex items-center gap-3 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => toggleProgram(program.id)}
                                                    className="w-4 h-4 accent-cyan-400"
                                                />
                                                <span className="text-sm text-white/80 flex-1">{program.name}</span>
                                            </label>
                                            {checked && (
                                                <input
                                                    type="text"
                                                    value={roleOnProgram[program.id] ?? ''}
                                                    onChange={(e) =>
                                                        setRoleOnProgram((prev) => ({ ...prev, [program.id]: e.target.value }))
                                                    }
                                                    className="input-premium !py-2 mt-2 text-sm"
                                                    placeholder="Rol en este programa (opcional)"
                                                    maxLength={80}
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <div className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
                        <div>
                            <p className="text-sm font-medium text-white/80">Activa</p>
                            <p className="text-xs text-white/35 mt-0.5">Las personas inactivas no aparecen en las listas activas</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setIsActive(!isActive)}
                            className={`relative inline-flex rounded-full transition-colors duration-200 flex-shrink-0 ${
                                isActive ? 'bg-cyan-400' : 'bg-white/15'
                            }`}
                            style={{ height: '22px', width: '40px' }}
                        >
                            <span
                                className="absolute top-0.5 rounded-full bg-white shadow transition-transform duration-200"
                                style={{ height: '18px', width: '18px', top: '2px', left: '2px', transform: isActive ? 'translateX(19px)' : 'translateX(0)' }}
                            />
                        </button>
                    </div>

                    {/* ── Fotos ── */}
                    <div>
                        <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">
                            Fotos ({photos.length}/{MAX_PHOTOS})
                        </label>
                        {isEdit ? (
                            <>
                                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                                    {photos.map((photo) => (
                                        <div key={photo.id} className="relative group aspect-square rounded-xl overflow-hidden border border-white/[0.08] bg-white/[0.03]">
                                            <img
                                                src={personPhotoSrc(personId, photo.id)}
                                                alt=""
                                                className="w-full h-full object-cover"
                                            />
                                            {photo.isPrimary && (
                                                <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-md bg-cyan-400/90 flex items-center justify-center" title="Foto principal">
                                                    <Star className="w-3 h-3 text-black fill-black" />
                                                </div>
                                            )}
                                            <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                                {!photo.isPrimary && (
                                                    <button
                                                        onClick={() => setPrimaryPhoto(photo.id)}
                                                        className="w-7 h-7 rounded-lg bg-white/10 hover:bg-cyan-400/30 flex items-center justify-center transition-colors"
                                                        title="Marcar como principal"
                                                    >
                                                        <Star className="w-3.5 h-3.5 text-white/80" />
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => deletePhoto(photo.id)}
                                                    className="w-7 h-7 rounded-lg bg-white/10 hover:bg-red-500/30 flex items-center justify-center transition-colors"
                                                    title="Eliminar foto"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5 text-white/80" />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                    {photos.length < MAX_PHOTOS && (
                                        <button
                                            onClick={() => photoInputRef.current?.click()}
                                            disabled={photoUploading}
                                            className="aspect-square rounded-xl border border-dashed border-white/[0.12] bg-white/[0.02] hover:bg-white/[0.05] hover:border-cyan-400/30 flex flex-col items-center justify-center gap-1.5 transition-colors text-white/30 hover:text-cyan-400/70"
                                        >
                                            <Camera className="w-5 h-5" />
                                            <span className="text-[10px] font-medium">{photoUploading ? 'Subiendo...' : 'Subir'}</span>
                                        </button>
                                    )}
                                </div>
                                <input
                                    ref={photoInputRef}
                                    type="file"
                                    accept="image/png,image/jpeg"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) uploadPhoto(file);
                                        e.target.value = '';
                                    }}
                                />
                                <p className="text-xs text-white/25 mt-2">PNG o JPEG, máximo 5MB. La primera foto queda como principal.</p>
                            </>
                        ) : (
                            <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-6 text-center">
                                <div className="w-12 h-12 rounded-xl bg-white/[0.04] flex items-center justify-center mx-auto mb-2">
                                    <span className="text-sm font-bold text-white/40">{initials}</span>
                                </div>
                                <p className="text-xs text-white/30">Guardá la persona para poder subir fotos.</p>
                                <button
                                    onClick={save}
                                    disabled={saving}
                                    className="btn-secondary !py-2 !px-4 !text-xs mt-3 inline-flex items-center gap-2"
                                >
                                    {saving ? 'Guardando...' : 'Guardar y habilitar fotos'}
                                </button>
                                {justCreated && <p className="text-xs text-cyan-400/70 mt-2">Persona creada — ya podés subir fotos.</p>}
                            </div>
                        )}
                    </div>
                </div>
                <div className="modal-footer">
                    <button onClick={onClose} className="btn-secondary !py-2.5 !px-5 !text-sm">Cancelar</button>
                    <button onClick={saveAndClose} disabled={saving} className="btn-primary !py-2.5 !px-5 !text-sm inline-flex items-center gap-2">
                        {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear persona'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function PersonsPage() {
    const { fetchApi } = useApi();

    const [persons, setPersons] = useState<Person[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('');
    const [programFilter, setProgramFilter] = useState('');
    const [activeFilter, setActiveFilter] = useState('all');

    const [programs, setPrograms] = useState<Program[]>([]);
    const [dialog, setDialog] = useState<{ open: boolean; person: Person | null }>({ open: false, person: null });
    const [deleting, setDeleting] = useState<string | null>(null);

    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(t);
    }, [search]);

    const loadPrograms = useCallback(async () => {
        try {
            const data = await fetchApi<{ programs: Program[] }>('/programs');
            setPrograms(data.programs);
        } catch {
            // Los filtros por programa quedan vacíos si falla la carga.
        }
    }, [fetchApi]);

    const loadPersons = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams();
            if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
            if (roleFilter) params.set('role', roleFilter);
            if (programFilter) params.set('programId', programFilter);
            params.set('active', activeFilter);
            params.set('page', String(page));
            params.set('limit', String(PAGE_SIZE));

            const data = await fetchApi<{ items: Person[]; total: number }>(`/persons?${params.toString()}`);
            setPersons(data.items);
            setTotal(data.total);
        } catch (err: any) {
            setError(err.message || 'Error al cargar las personas');
        }
        setLoading(false);
    }, [fetchApi, debouncedSearch, roleFilter, programFilter, activeFilter, page]);

    useEffect(() => { loadPrograms(); }, [loadPrograms]);
    useEffect(() => { loadPersons(); }, [loadPersons]);

    useEffect(() => { setPage(1); }, [debouncedSearch, roleFilter, programFilter, activeFilter]);

    const deletePerson = async (person: Person) => {
        if (!window.confirm(`¿Eliminar a ${person.name}? Esta acción no se puede deshacer.`)) return;
        setDeleting(person.id);
        setError('');
        try {
            await fetchApi(`/persons/${person.id}`, { method: 'DELETE' });
            await loadPersons();
        } catch (err: any) {
            setError(err.message || 'Error al eliminar la persona');
        }
        setDeleting(null);
    };

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <div className="space-y-5">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="w-4 h-4 text-white/30 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="input-premium !pl-10"
                        placeholder="Buscar por nombre..."
                    />
                </div>
                <div className="relative">
                    <select
                        value={roleFilter}
                        onChange={(e) => setRoleFilter(e.target.value)}
                        className="input-premium appearance-none pr-8 cursor-pointer !w-auto"
                    >
                        <option value="" className="bg-[#0c1018]">Todos los roles</option>
                        {PERSON_ROLES.map((r) => (
                            <option key={r.value} value={r.value} className="bg-[#0c1018]">{r.label}</option>
                        ))}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
                <div className="relative">
                    <select
                        value={programFilter}
                        onChange={(e) => setProgramFilter(e.target.value)}
                        className="input-premium appearance-none pr-8 cursor-pointer !w-auto"
                    >
                        <option value="" className="bg-[#0c1018]">Todos los programas</option>
                        {programs.map((p) => (
                            <option key={p.id} value={p.id} className="bg-[#0c1018]">{p.name}</option>
                        ))}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
                <div className="relative">
                    <select
                        value={activeFilter}
                        onChange={(e) => setActiveFilter(e.target.value)}
                        className="input-premium appearance-none pr-8 cursor-pointer !w-auto"
                    >
                        <option value="all" className="bg-[#0c1018]">Todos</option>
                        <option value="true" className="bg-[#0c1018]">Activas</option>
                        <option value="false" className="bg-[#0c1018]">Inactivas</option>
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
                <button
                    onClick={() => setDialog({ open: true, person: null })}
                    className="btn-primary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm shrink-0"
                >
                    <Plus className="w-4 h-4" />
                    Nueva persona
                </button>
            </div>

            {error && (
                <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">{error}</p>
            )}

            {/* Table */}
            <div className="glass-card-static overflow-hidden">
                {loading ? (
                    <div className="p-4 space-y-3">
                        {[1, 2, 3].map((i) => (
                            <div key={i} className="skeleton h-14 rounded-xl" />
                        ))}
                    </div>
                ) : persons.length === 0 ? (
                    <div className="p-14 text-center">
                        <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3 ring-1 ring-white/[0.06]">
                            <Users className="w-6 h-6 text-white/15" />
                        </div>
                        <p className="text-white/40 text-sm font-medium">
                            {debouncedSearch || roleFilter || programFilter || activeFilter !== 'all'
                                ? 'No hay personas que coincidan con los filtros.'
                                : 'Todavía no hay personas.'}
                        </p>
                        <p className="text-white/25 text-xs mt-1">Creá la primera persona del canal para empezar.</p>
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/[0.06] text-left">
                                <th className="px-4 py-3 text-xs font-medium text-white/35 uppercase tracking-wider w-14">Foto</th>
                                <th className="px-4 py-3 text-xs font-medium text-white/35 uppercase tracking-wider">Nombre</th>
                                <th className="px-4 py-3 text-xs font-medium text-white/35 uppercase tracking-wider">Rol</th>
                                <th className="px-4 py-3 text-xs font-medium text-white/35 uppercase tracking-wider">Programas</th>
                                <th className="px-4 py-3 text-xs font-medium text-white/35 uppercase tracking-wider">Estado</th>
                                <th className="px-4 py-3 text-xs font-medium text-white/35 uppercase tracking-wider">Fotos</th>
                                <th className="px-4 py-3 text-xs font-medium text-white/35 uppercase tracking-wider w-24 text-right">Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            {persons.map((person) => {
                                const primary = person.photos.find((p) => p.isPrimary) ?? person.photos[0];
                                return (
                                    <tr key={person.id} className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors">
                                        <td className="px-4 py-3">
                                            <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.07] flex items-center justify-center overflow-hidden">
                                                {primary
                                                    ? <img src={personPhotoSrc(person.id, primary.id)} alt={person.name} className="w-full h-full object-cover" />
                                                    : <span className="text-xs font-bold text-white/40">{initialsOf(person.name)}</span>
                                                }
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <p className="font-medium text-white/85 truncate max-w-[220px]">{person.name}</p>
                                            {person.roleLabel && <p className="text-xs text-white/30 truncate max-w-[220px]">{person.roleLabel}</p>}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="badge badge-purple capitalize">{roleLabelFor(person.role)}</span>
                                        </td>
                                        <td className="px-4 py-3">
                                            {person.programs.length === 0 ? (
                                                <span className="text-white/20 text-xs">—</span>
                                            ) : (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {person.programs.map((link) => (
                                                        <span key={link.id} className="badge badge-info">{link.programName}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            {person.isActive
                                                ? <span className="badge badge-success">Activa</span>
                                                : <span className="badge text-white/40">Inactiva</span>
                                            }
                                        </td>
                                        <td className="px-4 py-3 text-white/40">{person.photos.length}</td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-1.5 justify-end">
                                                <button
                                                    onClick={() => setDialog({ open: true, person })}
                                                    className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors text-white/40 hover:text-white/70"
                                                    title="Editar"
                                                >
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </button>
                                                <button
                                                    onClick={() => deletePerson(person)}
                                                    disabled={deleting === person.id}
                                                    className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-red-500/10 flex items-center justify-center transition-colors text-white/40 hover:text-red-400 disabled:opacity-40"
                                                    title="Eliminar"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Pagination */}
            {!loading && total > 0 && (
                <div className="flex items-center justify-between text-xs text-white/30">
                    <span>{total} {total === 1 ? 'persona' : 'personas'} · Página {page} de {totalPages}</span>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page <= 1}
                            className="btn-secondary !py-1.5 !px-3 !text-xs inline-flex items-center gap-1 disabled:opacity-40"
                        >
                            <ChevronLeft className="w-3.5 h-3.5" />
                            Anterior
                        </button>
                        <button
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages}
                            className="btn-secondary !py-1.5 !px-3 !text-xs inline-flex items-center gap-1 disabled:opacity-40"
                        >
                            Siguiente
                            <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            )}

            {dialog.open && (
                <PersonDialog
                    person={dialog.person}
                    programs={programs}
                    onClose={() => setDialog({ open: false, person: null })}
                    onSaved={loadPersons}
                />
            )}
        </div>
    );
}
