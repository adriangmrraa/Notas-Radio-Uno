import { useState, useEffect, useCallback } from 'react';
import { Share2, Plus, Trash2, ExternalLink, Unplug, Globe, MessageCircle, AtSign, FolderOpen } from 'lucide-react';
import { useApi } from '../hooks/useApi';

interface Asset {
    id: string;
    assetType: string;
    externalId: string;
    name: string | null;
    metadata: Record<string, unknown>;
    isActive: boolean;
}

interface Portfolio {
    id: string;
    name: string;
    isActive: boolean;
    assets: Asset[];
}

export function ConnectionsPage() {
    const { fetchApi } = useApi();
    const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
    const [loading, setLoading] = useState(true);
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);
    const [connectingMeta, setConnectingMeta] = useState<string | null>(null);
    const [connectingTwitter, setConnectingTwitter] = useState<string | null>(null);

    const loadPortfolios = useCallback(async () => {
        try {
            const data = await fetchApi<Portfolio[]>('/connections/portfolios');
            setPortfolios(data);
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    useEffect(() => { loadPortfolios(); }, []);

    const createPortfolio = async () => {
        if (!newName.trim()) return;
        setCreating(true);
        try {
            await fetchApi('/connections/portfolios', { method: 'POST', body: { name: newName.trim() } });
            setNewName('');
            await loadPortfolios();
        } catch (err: any) {
            alert(err.message);
        }
        setCreating(false);
    };

    const deletePortfolio = async (id: string) => {
        if (!confirm('Eliminar este portfolio y desconectar sus redes?')) return;
        await fetchApi(`/connections/portfolios/${id}`, { method: 'DELETE' });
        await loadPortfolios();
    };

    const disconnectAsset = async (id: string) => {
        await fetchApi(`/connections/assets/${id}`, { method: 'DELETE' });
        await loadPortfolios();
    };

    const connectMeta = async (portfolioId: string) => {
        setConnectingMeta(portfolioId);
        try {
            const appId = import.meta.env.VITE_META_APP_ID;
            const configId = import.meta.env.VITE_META_CONFIG_ID;

            if (!appId) {
                alert('META_APP_ID no configurado. Agrega VITE_META_APP_ID en .env');
                setConnectingMeta(null);
                return;
            }

            if (!(window as any).FB) {
                await new Promise<void>((resolve) => {
                    const script = document.createElement('script');
                    script.src = 'https://connect.facebook.net/en_US/sdk.js';
                    script.onload = () => {
                        (window as any).FB.init({ appId, version: 'v22.0' });
                        resolve();
                    };
                    document.body.appendChild(script);
                });
            }

            const loginParams: any = {
                scope: 'pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish',
            };
            if (configId) {
                loginParams.config_id = configId;
                loginParams.response_type = 'code';
                loginParams.override_default_response_type = true;
            }

            (window as any).FB.login(async (response: any) => {
                const accessToken = response.authResponse?.accessToken;
                const code = response.authResponse?.code || response.code;

                if (accessToken || code) {
                    await fetchApi(`/connections/portfolios/${portfolioId}/meta`, {
                        method: 'POST',
                        body: { accessToken, code },
                    });
                    await loadPortfolios();
                }
                setConnectingMeta(null);
            }, loginParams);
        } catch (err) {
            console.error('Meta connect error:', err);
            setConnectingMeta(null);
        }
    };

    const connectTwitter = async (portfolioId: string) => {
        setConnectingTwitter(portfolioId);
        try {
            const { authUrl, codeVerifier, redirectUri } = await fetchApi<{
                authUrl: string; codeVerifier: string; state: string; redirectUri: string;
            }>('/connections/twitter/auth-url');

            sessionStorage.setItem('twitter_code_verifier', codeVerifier);
            sessionStorage.setItem('twitter_redirect_uri', redirectUri);
            sessionStorage.setItem('twitter_portfolio_id', portfolioId);

            const popup = window.open(authUrl, 'twitter_auth', 'width=600,height=700');

            const interval = setInterval(async () => {
                try {
                    if (!popup || popup.closed) {
                        clearInterval(interval);
                        setConnectingTwitter(null);
                        return;
                    }
                    const popupUrl = popup.location.href;
                    if (popupUrl.includes('/connections/twitter/callback')) {
                        clearInterval(interval);
                        const url = new URL(popupUrl);
                        const code = url.searchParams.get('code');
                        popup.close();

                        if (code) {
                            await fetchApi(`/connections/portfolios/${portfolioId}/twitter`, {
                                method: 'POST',
                                body: {
                                    code,
                                    codeVerifier: sessionStorage.getItem('twitter_code_verifier'),
                                    redirectUri: sessionStorage.getItem('twitter_redirect_uri'),
                                },
                            });
                            await loadPortfolios();
                        }
                        setConnectingTwitter(null);
                    }
                } catch {
                    // Cross-origin — still waiting
                }
            }, 500);
        } catch (err: any) {
            alert(err.message);
            setConnectingTwitter(null);
        }
    };

    const getAssetIcon = (type: string) => {
        switch (type) {
            case 'facebook_page': return <Globe className="w-4 h-4 text-blue-400" />;
            case 'instagram_account': return <AtSign className="w-4 h-4 text-pink-400" />;
            case 'twitter_account': return <MessageCircle className="w-4 h-4 text-sky-400" />;
            default: return <ExternalLink className="w-4 h-4 text-white/40" />;
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="p-8 max-w-4xl mx-auto">
            <div className="flex items-center gap-3 mb-1">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/15 to-cyan-600/5 flex items-center justify-center ring-1 ring-cyan-500/20">
                    <Share2 className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold">Conexiones</h1>
                    <p className="text-white/30 text-sm">Conecta tus redes sociales para publicar automaticamente</p>
                </div>
            </div>

            {/* Create Portfolio */}
            <div className="flex gap-3 mt-8 mb-8">
                <div className="relative flex-1 group">
                    <FolderOpen className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors duration-300" />
                    <input
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="Nombre del portfolio (ej: Mi Radio, Canal Deportes)"
                        className="input-premium pl-11"
                        onKeyDown={(e) => e.key === 'Enter' && createPortfolio()}
                    />
                </div>
                <button
                    onClick={createPortfolio}
                    disabled={creating || !newName.trim()}
                    className="btn-primary inline-flex items-center gap-2 shrink-0"
                >
                    <Plus className="w-4 h-4" />
                    Crear Portfolio
                </button>
            </div>

            {/* Empty State */}
            {portfolios.length === 0 && (
                <div className="glass-card-static p-12 text-center animate-in">
                    <div className="w-16 h-16 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4 ring-1 ring-white/[0.06]">
                        <Share2 className="w-7 h-7 text-white/15" />
                    </div>
                    <p className="text-white/25 text-sm">Crea tu primer portfolio para conectar redes sociales</p>
                </div>
            )}

            {/* Portfolios */}
            <div className="space-y-5 stagger-children">
                {portfolios.map((portfolio) => (
                    <div key={portfolio.id} className="glass-card p-6">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center ring-1 ring-white/[0.08]">
                                    <FolderOpen className="w-4 h-4 text-white/40" />
                                </div>
                                <h3 className="text-lg font-semibold">{portfolio.name}</h3>
                                <span className="badge badge-info">{portfolio.assets.length} conectado{portfolio.assets.length !== 1 ? 's' : ''}</span>
                            </div>
                            <button onClick={() => deletePortfolio(portfolio.id)} className="p-2 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/5 transition-all duration-300">
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>

                        {/* Connected Assets */}
                        {portfolio.assets.length > 0 && (
                            <div className="space-y-2 mb-5">
                                {portfolio.assets.map((asset) => (
                                    <div key={asset.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.05] hover:border-white/[0.1] transition-all duration-300 group">
                                        <div className="flex items-center gap-3">
                                            {getAssetIcon(asset.assetType)}
                                            <span className="text-sm font-medium">{asset.name || asset.externalId}</span>
                                            <span className="text-[10px] text-white/20 uppercase tracking-wider">{asset.assetType.replace('_', ' ')}</span>
                                        </div>
                                        <button onClick={() => disconnectAsset(asset.id)} className="opacity-0 group-hover:opacity-100 text-white/20 hover:text-red-400 transition-all duration-300" title="Desconectar">
                                            <Unplug className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Connect Buttons */}
                        <div className="flex gap-3">
                            <button
                                onClick={() => connectMeta(portfolio.id)}
                                disabled={connectingMeta === portfolio.id}
                                className="btn-secondary inline-flex items-center gap-2 text-sm !py-2.5 !border-blue-500/15 !text-blue-400 hover:!bg-blue-500/10"
                            >
                                <Globe className="w-4 h-4" />
                                {connectingMeta === portfolio.id ? 'Conectando...' : 'Conectar Meta'}
                            </button>
                            <button
                                onClick={() => connectTwitter(portfolio.id)}
                                disabled={connectingTwitter === portfolio.id}
                                className="btn-secondary inline-flex items-center gap-2 text-sm !py-2.5 !border-sky-500/15 !text-sky-400 hover:!bg-sky-500/10"
                            >
                                <MessageCircle className="w-4 h-4" />
                                {connectingTwitter === portfolio.id ? 'Conectando...' : 'Conectar Twitter/X'}
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
