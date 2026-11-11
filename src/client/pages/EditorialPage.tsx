import { useState, useEffect, useCallback } from 'react';
import {
    ChevronDown, Newspaper, PenLine, Plus, RotateCcw, X,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAsyncData } from '../hooks/useAsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { classifyError, type AsyncError } from '../lib/errors';

// ─── Types (espejo de editorialService) ──────────────────────────────────────

interface EditorialExample {
    title: string;
    excerpt: string;
}

interface EditorialShape {
    name: string | null;
    tone: string;
    toneDescription: string | null;
    styleGuide: string | null;
    rules: string[];
    examples: EditorialExample[];
    industry: string | null;
    activeFormats: string[];
    forbiddenTopics: string[];
    signature: string | null;
    isActive: boolean;
}

interface EffectiveProfile extends EditorialShape {
    sources: {
        hasTenantProfile: boolean;
        overriddenFields: string[];
    };
}

interface ProfileRow extends EditorialShape {
    id: string;
    tenantId: string;
    programId: string | null;
    createdAt: string;
    updatedAt: string;
}

interface ProgramOverrideSummary {
    programId: string;
    programName: string;
    overriddenFields: string[];
    isActive: boolean;
}

interface ProfileResponse {
    effective: EffectiveProfile;
    tenantProfile: ProfileRow | null;
    programOverrides: ProgramOverrideSummary[];
    programOverride: ProfileRow | null;
}

interface Program {
    id: string;
    name: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TONES = [
    { value: 'formal', label: 'Formal' },
    { value: 'informal', label: 'Informal' },
    { value: 'urgente', label: 'Urgente' },
    { value: 'analitico', label: 'Analítico' },
    { value: 'custom', label: 'Custom' },
];

const FORMATS = [
    { value: 'flash', label: 'Flash' },
    { value: 'corta', label: 'Corta' },
    { value: 'completa', label: 'Completa' },
    { value: 'cronica', label: 'Crónica' },
    { value: 'twitter', label: 'Twitter' },
    { value: 'linkedin', label: 'LinkedIn' },
    { value: 'instagram', label: 'Instagram' },
    { value: 'youtube', label: 'YouTube' },
    { value: 'newsletter', label: 'Newsletter' },
];

const FIELD_LABELS: Record<string, string> = {
    name: 'Nombre',
    tone: 'Tono',
    toneDescription: 'Descripción del tono',
    styleGuide: 'Guía de estilo',
    rules: 'Reglas',
    examples: 'Ejemplos',
    industry: 'Rubro',
    activeFormats: 'Formatos activos',
    forbiddenTopics: 'Temas prohibidos',
    signature: 'Firma',
    isActive: 'Activo',
};

const EMPTY_SHAPE: EditorialShape = {
    name: null,
    tone: 'formal',
    toneDescription: null,
    styleGuide: null,
    rules: [],
    examples: [],
    industry: null,
    activeFormats: [],
    forbiddenTopics: [],
    signature: null,
    isActive: true,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shapeFromRow(row: ProfileRow | null): EditorialShape {
    if (!row) return { ...EMPTY_SHAPE, rules: [], examples: [], activeFormats: [], forbiddenTopics: [] };
    const { name, tone, toneDescription, styleGuide, rules, examples, industry, activeFormats, forbiddenTopics, signature, isActive } = row;
    return { name, tone, toneDescription, styleGuide, rules, examples, industry, activeFormats, forbiddenTopics, signature, isActive };
}

interface FormState {
    name: string;
    tone: string;
    toneDescription: string;
    styleGuide: string;
    industry: string;
    signature: string;
    rules: string[];
    examples: EditorialExample[];
    activeFormats: string[];
    forbiddenTopics: string[];
    isActive: boolean;
}

function formFromShape(shape: EditorialShape): FormState {
    return {
        name: shape.name ?? '',
        tone: shape.tone,
        toneDescription: shape.toneDescription ?? '',
        styleGuide: shape.styleGuide ?? '',
        industry: shape.industry ?? '',
        signature: shape.signature ?? '',
        rules: [...shape.rules],
        examples: shape.examples.map((e) => ({ ...e })),
        activeFormats: [...shape.activeFormats],
        forbiddenTopics: [...shape.forbiddenTopics],
        isActive: shape.isActive,
    };
}

function emptyForm(inherited: EditorialShape): FormState {
    // Override nuevo: todo vacío (hereda) salvo tone/isActive, que el override
    // siempre define — se inicializan con el valor del canal.
    return { ...formFromShape(EMPTY_SHAPE), tone: inherited.tone, isActive: inherited.isActive };
}

function bodyFromForm(form: FormState) {
    return {
        name: form.name.trim() || null,
        tone: form.tone,
        toneDescription: form.toneDescription.trim() || null,
        styleGuide: form.styleGuide.trim() || null,
        industry: form.industry.trim() || null,
        signature: form.signature.trim() || null,
        rules: form.rules,
        examples: form.examples,
        activeFormats: form.activeFormats,
        forbiddenTopics: form.forbiddenTopics,
        isActive: form.isActive,
    };
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function FieldLabel({ label, state }: { label: string; state?: 'inherited' | 'override' }) {
    return (
        <div className="flex items-center gap-2 mb-2">
            <label className="text-xs font-medium text-white/40 uppercase tracking-wider">{label}</label>
            {state === 'inherited' && <span className="badge text-white/30">Hereda</span>}
            {state === 'override' && <span className="badge badge-info">Override</span>}
        </div>
    );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            type="button"
            onClick={() => onChange(!checked)}
            className={`relative inline-flex rounded-full transition-colors duration-200 flex-shrink-0 ${
                checked ? 'bg-cyan-400' : 'bg-white/15'
            }`}
            style={{ height: '22px', width: '40px' }}
        >
            <span
                className="absolute top-0.5 rounded-full bg-white shadow transition-transform duration-200"
                style={{ height: '18px', width: '18px', top: '2px', left: '2px', transform: checked ? 'translateX(19px)' : 'translateX(0)' }}
            />
        </button>
    );
}

function StringListEditor({
    items,
    onChange,
    placeholder,
    addLabel,
}: {
    items: string[];
    onChange: (items: string[]) => void;
    placeholder: string;
    addLabel: string;
}) {
    const [draft, setDraft] = useState('');

    const add = () => {
        const v = draft.trim();
        if (!v) return;
        onChange([...items, v]);
        setDraft('');
    };

    return (
        <div className="space-y-2.5">
            {items.length > 0 && (
                <div className="space-y-1.5">
                    {items.map((item, i) => (
                        <div
                            key={`${i}-${item.slice(0, 16)}`}
                            className="flex items-center gap-2 rounded-xl bg-white/[0.02] border border-white/[0.06] px-3 py-2"
                        >
                            <span className="text-sm text-white/80 flex-1">{item}</span>
                            <button
                                type="button"
                                onClick={() => onChange(items.filter((_, j) => j !== i))}
                                className="w-6 h-6 rounded-md bg-white/[0.04] hover:bg-red-500/10 flex items-center justify-center text-white/30 hover:text-red-400 transition-colors"
                                title="Quitar"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                    className="input-premium !py-2.5 text-sm flex-1"
                    placeholder={placeholder}
                />
                <button
                    type="button"
                    onClick={add}
                    disabled={!draft.trim()}
                    className="btn-secondary !py-2.5 !px-3 !text-xs inline-flex items-center gap-1.5 shrink-0"
                >
                    <Plus className="w-3.5 h-3.5" />
                    {addLabel}
                </button>
            </div>
        </div>
    );
}

function ExamplesEditor({
    items,
    onChange,
}: {
    items: EditorialExample[];
    onChange: (items: EditorialExample[]) => void;
}) {
    const [title, setTitle] = useState('');
    const [excerpt, setExcerpt] = useState('');

    const add = () => {
        const t = title.trim();
        const x = excerpt.trim();
        if (!t || !x) return;
        onChange([...items, { title: t, excerpt: x }]);
        setTitle('');
        setExcerpt('');
    };

    return (
        <div className="space-y-2.5">
            {items.length > 0 && (
                <div className="space-y-1.5">
                    {items.map((item, i) => (
                        <div
                            key={`${i}-${item.title.slice(0, 16)}`}
                            className="flex items-start gap-2 rounded-xl bg-white/[0.02] border border-white/[0.06] px-3 py-2.5"
                        >
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white/80 truncate">{item.title}</p>
                                <p className="text-xs text-white/35 mt-0.5 line-clamp-2">{item.excerpt}</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => onChange(items.filter((_, j) => j !== i))}
                                className="w-6 h-6 rounded-md bg-white/[0.04] hover:bg-red-500/10 flex items-center justify-center text-white/30 hover:text-red-400 transition-colors shrink-0"
                                title="Quitar"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-3 space-y-2">
                <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    className="input-premium !py-2 text-sm"
                    placeholder="Título del ejemplo"
                    maxLength={200}
                />
                <textarea
                    value={excerpt}
                    onChange={(e) => setExcerpt(e.target.value)}
                    className="input-premium !py-2 text-sm resize-none"
                    rows={2}
                    placeholder="Extracto de referencia..."
                />
                <div className="flex justify-end">
                    <button
                        type="button"
                        onClick={add}
                        disabled={!title.trim() || !excerpt.trim()}
                        className="btn-secondary !py-2 !px-3 !text-xs inline-flex items-center gap-1.5"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Agregar ejemplo
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── ProfileForm — compartido entre el perfil del canal y el override ────────

interface ProfileFormProps {
    form: FormState;
    onChange: (form: FormState) => void;
    /** Modo override: muestra badges Hereda/Override y placeholders del canal. */
    inherited?: EditorialShape | null;
}

function ProfileForm({ form, onChange, inherited }: ProfileFormProps) {
    const isOverride = !!inherited;
    const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
        onChange({ ...form, [key]: value });

    const scalarState = (v: string) => (v.trim() === '' ? 'inherited' : 'override');
    const arrayState = (v: unknown[]) => (v.length === 0 ? 'inherited' : 'override');
    const fieldState = (s: 'inherited' | 'override') => (isOverride ? s : undefined);
    const inheritedText = (v: string | null) =>
        isOverride && v ? `Hereda: ${v.length > 60 ? `${v.slice(0, 60)}…` : v}` : undefined;

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                    <FieldLabel label="Nombre" state={fieldState(scalarState(form.name))} />
                    <input
                        type="text"
                        value={form.name}
                        onChange={(e) => set('name', e.target.value)}
                        className="input-premium"
                        placeholder={inheritedText(inherited?.name ?? null) ?? 'Ej: Canal 12 Noticias'}
                        maxLength={120}
                    />
                </div>
                <div>
                    <FieldLabel label="Tono *" state={isOverride ? 'override' : undefined} />
                    <div className="relative">
                        <select
                            value={form.tone}
                            onChange={(e) => set('tone', e.target.value)}
                            className="input-premium appearance-none pr-8 cursor-pointer w-full"
                        >
                            {TONES.map((t) => (
                                <option key={t.value} value={t.value} className="bg-[#0c1018]">{t.label}</option>
                            ))}
                        </select>
                        <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                    {isOverride && (
                        <p className="text-[11px] text-white/25 mt-1">
                            El tono de un override siempre pisa al del canal.
                        </p>
                    )}
                </div>
            </div>

            <div>
                <FieldLabel label="Descripción del tono" state={fieldState(scalarState(form.toneDescription))} />
                <textarea
                    value={form.toneDescription}
                    onChange={(e) => set('toneDescription', e.target.value)}
                    className="input-premium resize-none"
                    rows={2}
                    placeholder={inheritedText(inherited?.toneDescription ?? null) ?? 'Cómo suena el canal al aire...'}
                />
            </div>

            <div>
                <FieldLabel label="Guía de estilo" state={fieldState(scalarState(form.styleGuide))} />
                <textarea
                    value={form.styleGuide}
                    onChange={(e) => set('styleGuide', e.target.value)}
                    className="input-premium resize-none"
                    rows={3}
                    placeholder={inheritedText(inherited?.styleGuide ?? null) ?? 'Reglas de estilo, voz, estructura de las notas...'}
                />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                    <FieldLabel label="Rubro" state={fieldState(scalarState(form.industry))} />
                    <input
                        type="text"
                        value={form.industry}
                        onChange={(e) => set('industry', e.target.value)}
                        className="input-premium"
                        placeholder={inheritedText(inherited?.industry ?? null) ?? 'Ej: noticias, deportes'}
                        maxLength={80}
                    />
                </div>
                <div>
                    <FieldLabel label="Firma / cierre" state={fieldState(scalarState(form.signature))} />
                    <input
                        type="text"
                        value={form.signature}
                        onChange={(e) => set('signature', e.target.value)}
                        className="input-premium"
                        placeholder={inheritedText(inherited?.signature ?? null) ?? 'Ej: "Canal 12 informa"'}
                        maxLength={500}
                    />
                </div>
            </div>

            <div>
                <FieldLabel
                    label="Formatos activos"
                    state={fieldState(arrayState(form.activeFormats))}
                />
                {isOverride && form.activeFormats.length === 0 && (
                    <p className="text-[11px] text-white/25 mb-2">
                        Sin marcar = hereda del canal ({(inherited?.activeFormats ?? []).join(', ') || 'ninguno'}).
                    </p>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {FORMATS.map((f) => {
                        const checked = form.activeFormats.includes(f.value);
                        return (
                            <label
                                key={f.value}
                                className="flex items-center gap-2.5 rounded-xl bg-white/[0.02] border border-white/[0.06] px-3 py-2 cursor-pointer hover:bg-white/[0.04] transition-colors"
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() =>
                                        set(
                                            'activeFormats',
                                            checked
                                                ? form.activeFormats.filter((v) => v !== f.value)
                                                : [...form.activeFormats, f.value],
                                        )
                                    }
                                    className="w-4 h-4 accent-cyan-400"
                                />
                                <span className="text-sm text-white/75">{f.label}</span>
                            </label>
                        );
                    })}
                </div>
            </div>

            <div>
                <FieldLabel label="Reglas" state={fieldState(arrayState(form.rules))} />
                {isOverride && form.rules.length === 0 && (
                    <p className="text-[11px] text-white/25 mb-2">
                        Vacío = hereda las {inherited?.rules.length ?? 0} reglas del canal.
                    </p>
                )}
                <StringListEditor
                    items={form.rules}
                    onChange={(v) => set('rules', v)}
                    placeholder='Ej: "Nunca nombrar menores"'
                    addLabel="Agregar regla"
                />
            </div>

            <div>
                <FieldLabel label="Temas prohibidos" state={fieldState(arrayState(form.forbiddenTopics))} />
                {isOverride && form.forbiddenTopics.length === 0 && (
                    <p className="text-[11px] text-white/25 mb-2">
                        Vacío = hereda los {inherited?.forbiddenTopics.length ?? 0} temas del canal.
                    </p>
                )}
                <StringListEditor
                    items={form.forbiddenTopics}
                    onChange={(v) => set('forbiddenTopics', v)}
                    placeholder="Ej: espectáculos, política partidaria"
                    addLabel="Agregar tema"
                />
            </div>

            <div>
                <FieldLabel label="Ejemplos de referencia" state={fieldState(arrayState(form.examples))} />
                {isOverride && form.examples.length === 0 && (
                    <p className="text-[11px] text-white/25 mb-2">
                        Vacío = hereda los {inherited?.examples.length ?? 0} ejemplos del canal.
                    </p>
                )}
                <ExamplesEditor items={form.examples} onChange={(v) => set('examples', v)} />
            </div>

            <div className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3">
                <div>
                    <p className="text-sm font-medium text-white/80">Activa</p>
                    <p className="text-xs text-white/35 mt-0.5">
                        {isOverride
                            ? 'El estado de un override siempre pisa al del canal'
                            : 'Una línea editorial inactiva no se aplica en la generación'}
                    </p>
                </div>
                <Toggle checked={form.isActive} onChange={(v) => set('isActive', v)} />
            </div>
        </div>
    );
}

// ─── ProgramOverrideDialog ───────────────────────────────────────────────────

function ProgramOverrideDialog({
    program,
    onClose,
    onSaved,
}: {
    program: Program;
    onClose: () => void;
    onSaved: () => void;
}) {
    const { fetchApi } = useApi();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState<AsyncError | null>(null);
    const [form, setForm] = useState<FormState | null>(null);
    const [inherited, setInherited] = useState<EditorialShape>(EMPTY_SHAPE);
    const [hasOverride, setHasOverride] = useState(false);
    const [storedFields, setStoredFields] = useState<string[]>([]);

    const loadOverride = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
            const data = await fetchApi<ProfileResponse>(`/editorial/profile?programId=${program.id}`);
            const tenantShape = shapeFromRow(data.tenantProfile);
            setInherited(tenantShape);
            setStoredFields(data.effective.sources.overriddenFields);
            setHasOverride(!!data.programOverride);
            setForm(
                data.programOverride
                    ? formFromShape(shapeFromRow(data.programOverride))
                    : emptyForm(tenantShape),
            );
        } catch (err: unknown) {
            setLoadError(classifyError(err));
        }
        setLoading(false);
    }, [fetchApi, program.id]);

    useEffect(() => {
        // Se difiere el load: setLoading(true) sincrónico dentro del efecto viola
        // react-hooks/set-state-in-effect.
        void Promise.resolve().then(() => loadOverride());
    }, [loadOverride]);

    const save = async () => {
        if (!form) return;
        setSaving(true);
        setError('');
        try {
            await fetchApi(`/editorial/profile/${program.id}`, {
                method: 'PUT',
                body: bodyFromForm(form),
            });
            onSaved();
            onClose();
        } catch (err: any) {
            setError(err.message || 'Error al guardar el override');
        }
        setSaving(false);
    };

    const reset = async () => {
        if (!window.confirm(`¿Resetear el override de "${program.name}"? El programa vuelve a heredar todo del canal.`)) return;
        setDeleting(true);
        setError('');
        try {
            await fetchApi(`/editorial/profile/${program.id}`, { method: 'DELETE' });
            onSaved();
            onClose();
        } catch (err: any) {
            setError(err.message || 'Error al resetear el override');
        }
        setDeleting(false);
    };

    return (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal-content max-w-3xl w-full">
                <div className="modal-header">
                    <div>
                        <h2 className="text-base font-semibold text-white/85">
                            Override editorial — {program.name}
                        </h2>
                        <p className="text-xs text-white/35 mt-1">
                            Los campos vacíos heredan del perfil del canal.
                            {storedFields.length > 0 && (
                                <> Pisa actualmente: <span className="text-cyan-300/80">{storedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}</span>.</>
                            )}
                        </p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors shrink-0">
                        <X className="w-4 h-4 text-white/50" />
                    </button>
                </div>
                <div className="modal-body">
                    {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-5">{error}</p>}
                    {loading ? (
                        <LoadingState rows={4} text="Cargando override…" />
                    ) : loadError && !form ? (
                        <ErrorState error={loadError} compact onRetry={() => void loadOverride()} />
                    ) : form ? (
                        <ProfileForm form={form} onChange={setForm} inherited={inherited} />
                    ) : null}
                </div>
                <div className="modal-footer">
                    {hasOverride && (
                        <button
                            onClick={reset}
                            disabled={deleting || saving}
                            className="btn-secondary !py-2.5 !px-4 !text-sm inline-flex items-center gap-2 !mr-auto text-red-300/80 hover:!text-red-300"
                        >
                            <RotateCcw className="w-4 h-4" />
                            {deleting ? 'Reseteando...' : 'Resetear override'}
                        </button>
                    )}
                    <button onClick={onClose} className="btn-secondary !py-2.5 !px-4 !text-sm">
                        Cancelar
                    </button>
                    <button
                        onClick={save}
                        disabled={saving || loading || !form}
                        className="btn-primary !py-2.5 !px-4 !text-sm inline-flex items-center gap-2"
                    >
                        {saving ? 'Guardando...' : hasOverride ? 'Guardar override' : 'Crear override'}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ─── EditorialPage ───────────────────────────────────────────────────────────

export function EditorialPage() {
    const { fetchApi } = useApi();

    const [saveError, setSaveError] = useState('');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const [form, setForm] = useState<FormState | null>(null);
    const [dialogProgram, setDialogProgram] = useState<Program | null>(null);

    const { data, loading, error, reload, setData } = useAsyncData(
        async () => {
            const [profileData, programsData] = await Promise.all([
                fetchApi<ProfileResponse>('/editorial/profile'),
                fetchApi<{ items: Program[] }>('/editorial/programs'),
            ]);
            setForm(formFromShape(shapeFromRow(profileData.tenantProfile)));
            return { profileData, programsData };
        },
        [],
    );
    const tenantProfile = data?.profileData.tenantProfile ?? null;
    const overrides = data?.profileData.programOverrides ?? [];
    const programs = data?.programsData.items ?? [];

    const saveTenant = async () => {
        if (!form) return;
        setSaving(true);
        setSaveError('');
        setSaved(false);
        try {
            const res = await fetchApi<{ profile: ProfileRow }>('/editorial/profile', {
                method: 'PUT',
                body: bodyFromForm(form),
            });
            setData((prev) =>
                prev
                    ? { ...prev, profileData: { ...prev.profileData, tenantProfile: res.profile } }
                    : prev,
            );
            setForm(formFromShape(shapeFromRow(res.profile)));
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err: any) {
            setSaveError(err.message || 'Error al guardar el perfil');
        }
        setSaving(false);
    };

    const overrideByProgram = new Map(overrides.map((o) => [o.programId, o]));

    return (
        <div className="space-y-5">
            {error ? (
                <ErrorState error={error} onRetry={() => void reload()} />
            ) : (
            <>
            {/* Perfil del canal */}
            <div className="glass-card-static p-6">
                <div className="flex items-start justify-between gap-4 mb-6">
                    <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-xl bg-cyan-400/10 border border-cyan-400/15 flex items-center justify-center shrink-0">
                            <Newspaper className="w-5 h-5 text-cyan-300" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-white/85">Perfil del canal</h2>
                            <p className="text-xs text-white/35 mt-0.5">
                                La línea editorial default: la heredan todos los programas salvo los campos que cada uno pise con su override.
                            </p>
                        </div>
                    </div>
                    {tenantProfile && (
                        tenantProfile.isActive
                            ? <span className="badge badge-success shrink-0">Activa</span>
                            : <span className="badge text-white/40 shrink-0">Inactiva</span>
                    )}
                </div>

                {loading || !form ? (
                    <LoadingState rows={5} text="Cargando línea editorial…" />
                ) : (
                    <>
                        {!tenantProfile && (
                            <p className="text-xs text-amber-300/80 bg-amber-500/[0.07] border border-amber-500/15 rounded-xl px-4 py-3 mb-5">
                                Todavía no definiste una línea editorial: se usa el default de plataforma (tono formal, sin reglas). Guardá el formulario para crearla.
                            </p>
                        )}
                        {saveError && (
                            <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-5">{saveError}</p>
                        )}
                        <ProfileForm form={form} onChange={setForm} />
                        <div className="flex items-center justify-end gap-3 mt-6 pt-5 border-t border-white/[0.05]">
                            {saved && <span className="text-xs text-emerald-300/80">Guardado</span>}
                            <button
                                onClick={saveTenant}
                                disabled={saving}
                                className="btn-primary !py-2.5 !px-5 !text-sm inline-flex items-center gap-2"
                            >
                                <PenLine className="w-4 h-4" />
                                {saving ? 'Guardando...' : 'Guardar línea editorial'}
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* Overrides por programa */}
            <div className="glass-card-static p-6">
                <div className="mb-5">
                    <h2 className="text-base font-semibold text-white/85">Overrides por programa</h2>
                    <p className="text-xs text-white/35 mt-0.5">
                        Un programa puede pisar sólo algunos campos (ej. tono urgente para un flash informativo) y heredar el resto del canal.
                    </p>
                </div>

                {loading ? (
                    <LoadingState rows={2} text="Cargando programas…" />
                ) : programs.length === 0 ? (
                    <EmptyState
                        compact
                        icon={<PenLine />}
                        title="No hay programas creados."
                        description="Creá un programa para poder definirle un override editorial."
                        action={{ label: 'Ir a Programas', to: '/programs' }}
                        className="!py-10"
                    />
                ) : (
                    <div className="space-y-2">
                        {programs.map((program) => {
                            const ov = overrideByProgram.get(program.id);
                            return (
                                <div
                                    key={program.id}
                                    className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
                                >
                                    <div className="flex-1 min-w-[200px]">
                                        <p className="text-sm font-medium text-white/85">{program.name}</p>
                                        {ov ? (
                                            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                                <span className="text-[11px] text-white/30">Pisa:</span>
                                                {ov.overriddenFields.map((f) => (
                                                    <span key={f} className="badge badge-info">{FIELD_LABELS[f] ?? f}</span>
                                                ))}
                                                {ov.overriddenFields.length === 0 && (
                                                    <span className="text-[11px] text-white/30">nada (hereda todo)</span>
                                                )}
                                            </div>
                                        ) : (
                                            <p className="text-[11px] text-white/25 mt-1">Hereda todo del canal</p>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {ov && (
                                            <span className={`badge ${ov.isActive ? 'badge-success' : 'text-white/40'}`}>
                                                {ov.isActive ? 'Override activo' : 'Override inactivo'}
                                            </span>
                                        )}
                                        <button
                                            onClick={() => setDialogProgram(program)}
                                            className="btn-secondary !py-2 !px-3.5 !text-xs inline-flex items-center gap-1.5"
                                        >
                                            <PenLine className="w-3.5 h-3.5" />
                                            {ov ? 'Editar override' : 'Crear override'}
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            </>
            )}
            {dialogProgram && (
                <ProgramOverrideDialog
                    program={dialogProgram}
                    onClose={() => setDialogProgram(null)}
                    onSaved={() => void reload()}
                />
            )}
        </div>
    );
}
