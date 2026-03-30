import { useState, useEffect } from 'react';
import { Settings, Save, Key, Webhook, Users, Building2, CheckCircle, Shield } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';

export function SettingsPage() {
    const { fetchApi } = useApi();
    const { user } = useAuth();
    const [activeTab, setActiveTab] = useState<'general' | 'webhooks' | 'apikeys' | 'team'>('general');
    const [webhooks, setWebhooks] = useState({ webhook_pipeline: '', webhook_nuevo_boton: '', webhook_viejo_boton: '', webhook_tercer_boton: '' });
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        fetchApi<Record<string, string>>('/settings/webhooks').then(setWebhooks).catch(() => {});
    }, []);

    const saveWebhooks = async () => {
        setSaving(true);
        try {
            await fetchApi('/settings/webhooks', { method: 'POST', body: webhooks });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch { /* ignore */ }
        setSaving(false);
    };

    const tabs = [
        { key: 'general' as const, label: 'General', icon: Building2 },
        { key: 'webhooks' as const, label: 'Webhooks', icon: Webhook },
        { key: 'apikeys' as const, label: 'API Keys', icon: Key },
        { key: 'team' as const, label: 'Equipo', icon: Users },
    ];

    return (
        <div className="p-8 max-w-4xl mx-auto">
            <div className="flex items-center gap-3 mb-1">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/15 to-cyan-600/5 flex items-center justify-center ring-1 ring-cyan-500/20">
                    <Settings className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold">Configuracion</h1>
                    <p className="text-white/30 text-sm">Gestiona tu organizacion, webhooks y equipo</p>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 bg-white/[0.03] rounded-2xl p-1.5 mt-8 mb-8 border border-white/[0.04]">
                {tabs.map(({ key, label, icon: Icon }) => (
                    <button
                        key={key}
                        onClick={() => setActiveTab(key)}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm transition-all duration-300 ${
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
