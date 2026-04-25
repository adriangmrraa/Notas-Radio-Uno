import { useState, useEffect, useRef } from 'react';
import { Settings, Save, Key, Webhook, Users, Building2, CheckCircle, Shield, Palette, Upload, Trash2, ImageOff } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';

interface BrandingData {
    platformName: string;
    fontFamily: string;
    templateId: string;
}

interface FontOption {
    id: string;
    name: string;
    family: string;
}

interface TemplateOption {
    id: string;
    name: string;
    description: string;
}

const DEFAULT_FONTS: FontOption[] = [
    { id: 'bebas-kai', name: 'Bebas Kai', family: 'Bebas Kai' },
    { id: 'oswald', name: 'Oswald', family: 'Oswald' },
    { id: 'roboto-condensed', name: 'Roboto Condensed', family: 'Roboto Condensed' },
    { id: 'montserrat', name: 'Montserrat', family: 'Montserrat' },
    { id: 'lato', name: 'Lato', family: 'Lato' },
    { id: 'playfair-display', name: 'Playfair Display', family: 'Playfair Display' },
];

const DEFAULT_TEMPLATES: TemplateOption[] = [
    { id: 'gradient-dark', name: 'Gradiente Oscuro', description: 'Fondo degradado oscuro con texto claro' },
    { id: 'solid-bar', name: 'Barra Sólida', description: 'Barra de color sólido con logo y titular' },
    { id: 'minimal', name: 'Minimal', description: 'Diseño limpio con tipografía protagonista' },
    { id: 'split', name: 'Split', description: 'Imagen dividida con bloque de texto lateral' },
    { id: 'vignette', name: 'Viñeta', description: 'Viñeta oscura sobre imagen de fondo' },
];

export function SettingsPage() {
    const { fetchApi } = useApi();
    const { user } = useAuth();
    const [activeTab, setActiveTab] = useState<'general' | 'webhooks' | 'apikeys' | 'team' | 'branding'>('general');
    const [webhooks, setWebhooks] = useState({ webhook_pipeline: '', webhook_nuevo_boton: '', webhook_viejo_boton: '', webhook_tercer_boton: '' });
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    // Branding state
    const [branding, setBranding] = useState<BrandingData>({ platformName: '', fontFamily: 'bebas-kai', templateId: 'gradient-dark' });
    const [brandingOriginal, setBrandingOriginal] = useState<BrandingData>({ platformName: '', fontFamily: 'bebas-kai', templateId: 'gradient-dark' });
    const [logoUrl, setLogoUrl] = useState<string | null>(null);
    const [fonts, setFonts] = useState<FontOption[]>(DEFAULT_FONTS);
    const [templates, setTemplates] = useState<TemplateOption[]>(DEFAULT_TEMPLATES);
    const [brandingSaving, setBrandingSaving] = useState(false);
    const [brandingToast, setBrandingToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
    const [logoUploading, setLogoUploading] = useState(false);
    const [logoDeleting, setLogoDeleting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const brandingDirty =
        branding.platformName !== brandingOriginal.platformName ||
        branding.fontFamily !== brandingOriginal.fontFamily ||
        branding.templateId !== brandingOriginal.templateId;

    useEffect(() => {
        fetchApi<Record<string, string>>('/settings/webhooks').then(setWebhooks).catch(() => {});
    }, []);

    useEffect(() => {
        if (activeTab !== 'branding') return;
        // Fetch current branding
        fetchApi<BrandingData>('/branding').then((data) => {
            setBranding(data);
            setBrandingOriginal(data);
        }).catch(() => {});
        // Fetch fonts
        fetchApi<FontOption[]>('/branding/fonts').then(setFonts).catch(() => {});
        // Fetch templates
        fetchApi<TemplateOption[]>('/branding/templates').then(setTemplates).catch(() => {});
        // Fetch logo as blob URL
        fetchApi<Response>('/branding/logo').then(async () => {
            const res = await fetch('/api/branding/logo', { credentials: 'include' });
            if (res.ok) {
                const blob = await res.blob();
                setLogoUrl(URL.createObjectURL(blob));
            }
        }).catch(() => { setLogoUrl(null); });
    }, [activeTab]);

    const saveWebhooks = async () => {
        setSaving(true);
        try {
            await fetchApi('/settings/webhooks', { method: 'POST', body: webhooks });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch { /* ignore */ }
        setSaving(false);
    };

    const saveBranding = async () => {
        setBrandingSaving(true);
        try {
            await fetchApi('/branding', {
                method: 'PUT',
                body: { platformName: branding.platformName, fontFamily: branding.fontFamily, templateId: branding.templateId },
            });
            setBrandingOriginal({ ...branding });
            setBrandingToast({ type: 'success', msg: 'Cambios guardados correctamente' });
        } catch (err: any) {
            setBrandingToast({ type: 'error', msg: err.message || 'Error al guardar' });
        }
        setBrandingSaving(false);
        setTimeout(() => setBrandingToast(null), 3000);
    };

    const uploadLogo = async (file: File) => {
        if (file.size > 2 * 1024 * 1024) {
            setBrandingToast({ type: 'error', msg: 'El archivo supera los 2MB permitidos' });
            setTimeout(() => setBrandingToast(null), 3000);
            return;
        }
        setLogoUploading(true);
        try {
            const fd = new FormData();
            fd.append('logo', file);
            await fetchApi('/branding/logo', { method: 'POST', body: fd });
            const res = await fetch('/api/branding/logo', { credentials: 'include' });
            if (res.ok) {
                const blob = await res.blob();
                setLogoUrl(URL.createObjectURL(blob));
            }
            setBrandingToast({ type: 'success', msg: 'Logo actualizado' });
        } catch (err: any) {
            setBrandingToast({ type: 'error', msg: err.message || 'Error al subir el logo' });
        }
        setLogoUploading(false);
        setTimeout(() => setBrandingToast(null), 3000);
    };

    const deleteLogo = async () => {
        if (!confirm('¿Eliminar el logo actual?')) return;
        setLogoDeleting(true);
        try {
            await fetchApi('/branding/logo', { method: 'DELETE' });
            setLogoUrl(null);
            setBrandingToast({ type: 'success', msg: 'Logo eliminado' });
        } catch (err: any) {
            setBrandingToast({ type: 'error', msg: err.message || 'Error al eliminar el logo' });
        }
        setLogoDeleting(false);
        setTimeout(() => setBrandingToast(null), 3000);
    };

    const tabs = [
        { key: 'general' as const, label: 'General', icon: Building2 },
        { key: 'branding' as const, label: 'Marca', icon: Palette },
        { key: 'webhooks' as const, label: 'Webhooks', icon: Webhook },
        { key: 'apikeys' as const, label: 'API Keys', icon: Key },
        { key: 'team' as const, label: 'Equipo', icon: Users },
    ];

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto">
            {/* Tabs */}
            <div className="flex gap-1 bg-white/[0.03] rounded-2xl p-1.5 mb-8 border border-white/[0.04] overflow-x-auto scrollbar-none">
                {tabs.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => setActiveTab(key)}
                        className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 rounded-xl text-sm transition-all duration-300 shrink-0 ${
                            activeTab === key
                                ? 'bg-white/[0.08] text-white font-medium shadow-soft'
                                : 'text-white/35 hover:text-white/60 hover:bg-white/[0.03]'
                        }`}
                    >
                        <Icon className={`w-4 h-4 ${activeTab === key ? 'text-cyan-400' : ''}`} />
                        {label}
                    </button>
                ))}
            </div>

            {/* Branding toast */}
            {brandingToast && (
                <div className={`fixed bottom-6 right-6 z-50 toast ${brandingToast.type === 'success' ? 'toast-success' : 'toast-error'} flex items-center gap-3`}>
                    {brandingToast.type === 'success'
                        ? <CheckCircle className="w-4 h-4 shrink-0" />
                        : <Shield className="w-4 h-4 shrink-0" />}
                    <span className="text-sm font-medium">{brandingToast.msg}</span>
                </div>
            )}

            <div className="animate-in">
                {/* General */}
                {activeTab === 'general' && (
                    <div className="glass-card-static p-6 space-y-5">
                        {[
                            { label: 'Nombre del medio', value: user?.tenant?.name || '', hint: 'Contacta soporte para cambiar el nombre' },
                            { label: 'Email', value: user?.email || '' },
                            { label: 'Rol', value: user?.role || '' },
                        ].map(({ label, value, hint }) => (
                            <div key={label}>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">{label}</label>
                                <input type="text" defaultValue={value} disabled className="input-premium opacity-60 cursor-not-allowed" />
                                {hint && <p className="text-xs text-white/15 mt-1.5">{hint}</p>}
                            </div>
                        ))}
                    </div>
                )}

                {/* Marca / Branding */}
                {activeTab === 'branding' && (
                    <div className="space-y-6">
                        {/* Logo */}
                        <div className="glass-card-static p-6">
                            <h3 className="text-sm font-semibold text-white/70 mb-4 flex items-center gap-2">
                                <Upload className="w-4 h-4 text-cyan-400" />
                                Logo del medio
                            </h3>
                            <div className="flex items-start gap-5 flex-wrap">
                                <div className="w-28 h-28 rounded-2xl bg-white/[0.03] border border-white/[0.08] flex items-center justify-center overflow-hidden shrink-0">
                                    {logoUrl
                                        ? <img src={logoUrl} alt="Logo actual" className="w-full h-full object-contain p-2" />
                                        : <ImageOff className="w-8 h-8 text-white/15" />
                                    }
                                </div>
                                <div className="flex flex-col gap-3">
                                    <div className="flex gap-2 flex-wrap">
                                        <button
                                            onClick={() => fileInputRef.current?.click()}
                                            disabled={logoUploading}
                                            className="btn-secondary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                                        >
                                            <Upload className="w-4 h-4" />
                                            {logoUploading ? 'Subiendo...' : 'Subir Logo'}
                                        </button>
                                        {logoUrl && (
                                            <button
                                                onClick={deleteLogo}
                                                disabled={logoDeleting}
                                                className="btn-danger inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                {logoDeleting ? 'Eliminando...' : 'Eliminar Logo'}
                                            </button>
                                        )}
                                    </div>
                                    <p className="text-xs text-white/25">PNG o JPEG · Máximo 2MB</p>
                                </div>
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/png,image/jpeg"
                                className="hidden"
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ''; }}
                            />
                        </div>

                        {/* Nombre de plataforma */}
                        <div className="glass-card-static p-6">
                            <h3 className="text-sm font-semibold text-white/70 mb-4 flex items-center gap-2">
                                <Settings className="w-4 h-4 text-cyan-400" />
                                Nombre de la plataforma
                            </h3>
                            <input
                                type="text"
                                value={branding.platformName}
                                onChange={(e) => setBranding({ ...branding, platformName: e.target.value })}
                                className="input-premium"
                                placeholder="Ej: Radio Uno Noticias"
                            />
                            <p className="text-xs text-white/25 mt-2">Aparece en los flyers generados</p>
                        </div>

                        {/* Tipografía */}
                        <div className="glass-card-static p-6">
                            <h3 className="text-sm font-semibold text-white/70 mb-4 flex items-center gap-2">
                                <Palette className="w-4 h-4 text-cyan-400" />
                                Tipografía
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {fonts.map((font) => (
                                    <button
                                        key={font.id}
                                        onClick={() => setBranding({ ...branding, fontFamily: font.id })}
                                        className={`px-4 py-3.5 rounded-xl border text-left transition-all duration-200 ${
                                            branding.fontFamily === font.id
                                                ? 'border-cyan-400/40 bg-cyan-400/[0.06] ring-1 ring-cyan-400/20'
                                                : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.15] hover:bg-white/[0.04]'
                                        }`}
                                    >
                                        <p
                                            className="text-xl text-white/90 tracking-tight leading-tight mb-1"
                                            style={{ fontFamily: font.family, fontWeight: 700 }}
                                        >
                                            NOTICIAS DE HOY
                                        </p>
                                        <p className="text-xs text-white/35 font-sans">{font.name}</p>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Plantilla */}
                        <div className="glass-card-static p-6">
                            <h3 className="text-sm font-semibold text-white/70 mb-4 flex items-center gap-2">
                                <Palette className="w-4 h-4 text-cyan-400" />
                                Plantilla de flyer
                            </h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {templates.map((tpl) => (
                                    <button
                                        key={tpl.id}
                                        onClick={() => setBranding({ ...branding, templateId: tpl.id })}
                                        className={`px-4 py-4 rounded-xl border text-left transition-all duration-200 ${
                                            branding.templateId === tpl.id
                                                ? 'border-cyan-400/40 bg-cyan-400/[0.06] ring-1 ring-cyan-400/20'
                                                : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.15] hover:bg-white/[0.04]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            {branding.templateId === tpl.id && (
                                                <CheckCircle className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                                            )}
                                            <p className="text-sm font-semibold text-white/85">{tpl.name}</p>
                                        </div>
                                        <p className="text-xs text-white/35 leading-snug">{tpl.description}</p>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Save */}
                        <div className="flex items-center justify-end gap-3">
                            <button
                                onClick={saveBranding}
                                disabled={!brandingDirty || brandingSaving}
                                className="btn-primary inline-flex items-center gap-2"
                            >
                                <Save className="w-4 h-4" />
                                {brandingSaving ? 'Guardando...' : 'Guardar cambios'}
                            </button>
                        </div>
                    </div>
                )}

                {/* Webhooks */}
                {activeTab === 'webhooks' && (
                    <div className="glass-card-static p-6 space-y-5">
                        <p className="text-sm text-white/35 mb-2">Configura URLs de webhook para integrar con Make.com, N8N u otras plataformas</p>
                        {Object.entries(webhooks).map(([key, value]) => (
                            <div key={key}>
                                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">{key.replace(/_/g, ' ')}</label>
                                <input
                                    type="url"
                                    value={value}
                                    onChange={(e) => setWebhooks({ ...webhooks, [key]: e.target.value })}
                                    className="input-premium"
                                    placeholder="https://hook.us2.make.com/..."
                                />
                            </div>
                        ))}
                        <button
                            onClick={saveWebhooks}
                            disabled={saving}
                            className="btn-primary inline-flex items-center gap-2"
                        >
                            {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                            {saved ? 'Guardado!' : saving ? 'Guardando...' : 'Guardar Webhooks'}
                        </button>
                    </div>
                )}

                {/* API Keys */}
                {activeTab === 'apikeys' && (
                    <div className="glass-card-static p-6">
                        <p className="text-sm text-white/35 mb-5">
                            Tus API keys estan encriptadas en la base de datos. Configuralas en el archivo .env del servidor.
                        </p>
                        <div className="space-y-2 stagger-children">
                            {['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'META_APP_ID', 'TWITTER_CLIENT_ID'].map((key) => (
                                <div key={key} className="flex items-center justify-between px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.05] hover:border-white/[0.1] transition-all duration-300 group">
                                    <div className="flex items-center gap-3">
                                        <Shield className="w-4 h-4 text-white/20 group-hover:text-cyan-400/50 transition-colors duration-300" />
                                        <span className="text-sm font-mono text-white/70">{key}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                        <span className="text-xs text-emerald-400/60">Configurado</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Team */}
                {activeTab === 'team' && (
                    <div className="glass-card-static p-6">
                        <p className="text-sm text-white/35 mb-5">Invita miembros a tu organizacion (proximamente)</p>
                        <div className="border border-dashed border-white/[0.08] rounded-2xl p-12 text-center">
                            <div className="w-16 h-16 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4 ring-1 ring-white/[0.06]">
                                <Users className="w-7 h-7 text-white/15" />
                            </div>
                            <p className="text-white/25 text-sm">Funcion de equipo disponible en planes Starter+</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
