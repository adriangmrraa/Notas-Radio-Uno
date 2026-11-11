import { useState, useEffect } from 'react';
import { Share2, Plus, Trash2, ExternalLink, Unplug, Globe, MessageCircle, AtSign, FolderOpen, RefreshCw, Link2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAsyncData } from '../hooks/useAsyncData';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';

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

// ------------------------------------------------------------------
// Cuentas sociales vía Zernio (PG-04)
// El OAuth lo hospeda Zernio — nunca pedimos credenciales de la red.
// ------------------------------------------------------------------

interface SocialConnection {
    id: string;
    platform: string;
    accountId: string;
    username: string | null;
    displayName: string | null;
    status: string;
    lastSyncedAt: string | null;
}

interface SocialConnectionsResponse {
    connections: SocialConnection[];
    plan: { maxPlatforms: number | null; usedPlatforms: number };
}

// Subconjunto editorial del enum de Zernio (mismo criterio que el
// auto-publish): destinos de contenido, no de mensajería/identidad.
const SOCIAL_PLATFORMS: { id: string; label: string }[] = [
    { id: 'instagram', label: 'Instagram' },
    { id: 'facebook', label: 'Facebook' },
    { id: 'tiktok', label: 'TikTok' },
    { id: 'youtube', label: 'YouTube' },
    { id: 'linkedin', label: 'LinkedIn' },
    { id: 'twitter', label: 'X (Twitter)' },
    { id: 'threads', label: 'Threads' },
    { id: 'pinterest', label: 'Pinterest' },
    { id: 'reddit', label: 'Reddit' },
    { id: 'bluesky', label: 'Bluesky' },
];

const SOCIAL_ERROR_MESSAGES: Record<string, string> = {
    invalid_state: 'El enlace de conexión expiró o es inválido. Volvé a intentarlo.',
    invalid_state_platform: 'La plataforma del retorno no coincide con la solicitada.',
    connect_failed: 'La conexión no se completó en la red social.',
    connection_not_confirmed: 'La red social no confirmó la conexión.',
    profile_mismatch: 'La cuenta devuelta no pertenece a tu organización.',
    missing_account: 'La red social no devolvió la cuenta conectada.',
    max_connected_platforms: 'Alcanzaste el máximo de plataformas de tu plan.',
    zernio_not_configured: 'La integración de redes no está configurada.',
};

const platformLabel = (id: string): string =>
    SOCIAL_PLATFORMS.find((p) => p.id === id)?.label ?? id;

// ------------------------------------------------------------------
// Canal de publicación por tenant (PG-07)
// ------------------------------------------------------------------

type PublishChannelMode = 'hybrid' | 'zernio' | 'legacy';

interface ChannelPlatformStatus {
    platform: string;
    channel: 'zernio' | 'legacy' | 'none';
    reason: string | null;
    legacyCapable: boolean;
    hasLegacyPath: boolean;
    zernioConnections: { id: string; username: string | null; displayName: string | null; accountId: string; status: string }[];
    legacyAssets: { id: string; name: string | null; assetType: string; externalId: string; legacyOnly: boolean }[];
    pendingMigration: boolean;
}

interface PublishChannelsResponse {
    mode: PublishChannelMode;
    defaultMode: PublishChannelMode;
    configured: boolean;
    platforms: ChannelPlatformStatus[];
}

const MODE_OPTIONS: { id: PublishChannelMode; label: string; description: string }[] = [
    {
        id: 'hybrid',
        label: 'Híbrido',
        description: 'Zernio para las redes conectadas; Meta/Twitter directo para los portfolios que todavía no migraste. Es el modo por defecto — se comporta como siempre.',
    },
    {
        id: 'zernio',
        label: 'Zernio',
        description: 'Todo publica por Zernio. El canal directo de Meta/Twitter queda sólo bajo demanda explícita en cada publicación ("publicar por canal legacy").',
    },
    {
        id: 'legacy',
        label: 'Legacy',
        description: 'Meta/Twitter siguen por el canal directo. Las redes nuevas (TikTok, YouTube, LinkedIn…) publican por Zernio cuando están conectadas.',
    },
];

/** Asset types que pueden marcarse como legacy-only (Meta/Twitter directo). */
const LEGACY_ONLY_ASSET_TYPES = new Set(['facebook_page', 'instagram_account', 'twitter_account']);

const channelBadge = (channel: ChannelPlatformStatus['channel']) => {
    switch (channel) {
        case 'zernio':
            return <span className="badge badge-success">Conectado por Zernio</span>;
        case 'legacy':
            return <span className="badge badge-warning">Legacy (Meta/Twitter directo)</span>;
        default:
            return <span className="badge badge-info">Sin conectar</span>;
    }
};

export function ConnectionsPage() {
    const { fetchApi } = useApi();
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);
    const [connectingMeta, setConnectingMeta] = useState<string | null>(null);
    const [connectingTwitter, setConnectingTwitter] = useState<string | null>(null);

    const [connectingPlatform, setConnectingPlatform] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

    const [modeDraft, setModeDraft] = useState<PublishChannelMode>('hybrid');
    const [savingMode, setSavingMode] = useState(false);
    const [togglingAsset, setTogglingAsset] = useState<string | null>(null);

    const {
        data: portfoliosData,
        loading,
        error: portfoliosError,
        reload: reloadPortfolios,
    } = useAsyncData(() => fetchApi<Portfolio[]>('/connections/portfolios'), []);
    const portfolios = portfoliosData ?? [];

    const {
        data: socialData,
        loading: socialLoading,
        error: socialError,
        reload: reloadSocial,
        setData: setSocialData,
    } = useAsyncData(() => fetchApi<SocialConnectionsResponse>('/social-connections'), []);
    const social = socialData?.connections ?? [];
    const socialPlan = socialData?.plan ?? null;

    // PG-07: canal de publicación — modo del tenant + estado por plataforma.
    const {
        data: channels,
        loading: channelsLoading,
        error: channelsError,
        reload: reloadChannels,
    } = useAsyncData(async () => {
        const data = await fetchApi<PublishChannelsResponse>('/publish-channels');
        setModeDraft(data.mode);
        return data;
    }, []);

    useEffect(() => {
        // Resultado del callback OAuth de Zernio (redirect con
        // ?social_connected=<platform> o ?social_error=<code>).
        const params = new URLSearchParams(window.location.search);
        const connected = params.get('social_connected');
        const errorCode = params.get('social_error');
        if (connected) {
            setFeedback({ kind: 'ok', text: `${platformLabel(connected)} quedó conectada.` });
        } else if (errorCode) {
            setFeedback({
                kind: 'error',
                text: SOCIAL_ERROR_MESSAGES[errorCode] ?? 'No se pudo completar la conexión.',
            });
        }
        if (connected || errorCode) {
            const url = new URL(window.location.href);
            url.searchParams.delete('social_connected');
            url.searchParams.delete('social_error');
            window.history.replaceState({}, '', url.toString());
            void reloadSocial();
        }
    }, [reloadSocial]);

    const createPortfolio = async () => {
        if (!newName.trim()) return;
        setCreating(true);
        try {
            await fetchApi('/connections/portfolios', { method: 'POST', body: { name: newName.trim() } });
            setNewName('');
            await reloadPortfolios();
        } catch (err: any) {
            alert(err.message);
        }
        setCreating(false);
    };

    const deletePortfolio = async (id: string) => {
        if (!confirm('Eliminar este portfolio y desconectar sus redes?')) return;
        await fetchApi(`/connections/portfolios/${id}`, { method: 'DELETE' });
        await reloadPortfolios();
    };

    const disconnectAsset = async (id: string) => {
        await fetchApi(`/connections/assets/${id}`, { method: 'DELETE' });
        await reloadPortfolios();
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
                    await reloadPortfolios();
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
                            await reloadPortfolios();
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

    const connectPlatform = async (platform: string) => {
        setConnectingPlatform(platform);
        setFeedback(null);
        try {
            const { authUrl } = await fetchApi<{ authUrl: string; state: string }>(
                '/social-connections/connect',
                { method: 'POST', body: { platform } },
            );
            // El OAuth lo hospeda Zernio: se abre en pestaña nueva y el
            // callback vuelve a esta página con el resultado en el query.
            window.open(authUrl, '_blank', 'noopener');
        } catch (err: any) {
            setFeedback({ kind: 'error', text: err.message || 'No se pudo iniciar la conexión.' });
        }
        setConnectingPlatform(null);
    };

    const disconnectSocial = async (id: string) => {
        if (!confirm('Desconectar esta cuenta? Vas a poder volver a conectarla cuando quieras.')) return;
        try {
            await fetchApi(`/social-connections/${id}`, { method: 'DELETE' });
            await reloadSocial();
        } catch (err: any) {
            setFeedback({ kind: 'error', text: err.message || 'No se pudo desconectar.' });
        }
    };

    const syncSocial = async () => {
        setSyncing(true);
        setFeedback(null);
        try {
            const result = await fetchApi<{ connections: SocialConnection[]; synced: number; markedDisconnected: number }>(
                '/social-connections/sync',
                { method: 'POST' },
            );
            setSocialData((prev) => prev
                ? { ...prev, connections: result.connections }
                : { connections: result.connections, plan: { maxPlatforms: null, usedPlatforms: result.connections.length } });
            setFeedback({
                kind: 'ok',
                text: `Sincronización lista: ${result.synced} cuenta${result.synced !== 1 ? 's' : ''} actualizada${result.synced !== 1 ? 's' : ''}.`,
            });
        } catch (err: any) {
            setFeedback({ kind: 'error', text: err.message || 'No se pudo sincronizar.' });
        }
        setSyncing(false);
    };

    // PG-07 — modo de canal del tenant.
    const saveChannelMode = async () => {
        setSavingMode(true);
        setFeedback(null);
        try {
            await fetchApi('/publish-channels', { method: 'PUT', body: { mode: modeDraft } });
            await reloadChannels();
            setFeedback({ kind: 'ok', text: 'Modo de publicación guardado.' });
        } catch (err: any) {
            setFeedback({ kind: 'error', text: err.message || 'No se pudo guardar el modo.' });
        }
        setSavingMode(false);
    };

    // PG-07 — marca un asset legacy como "siempre por canal directo".
    const toggleLegacyOnly = async (asset: Asset) => {
        const next = asset.metadata?.legacyOnly !== true;
        setTogglingAsset(asset.id);
        try {
            await fetchApi(`/publish-channels/assets/${asset.id}/legacy-only`, {
                method: 'PUT',
                body: { legacyOnly: next },
            });
            await Promise.all([reloadPortfolios(), reloadChannels()]);
        } catch (err: any) {
            setFeedback({ kind: 'error', text: err.message || 'No se pudo actualizar el asset.' });
        }
        setTogglingAsset(null);
    };

    const statusBadge = (status: string) => {
        switch (status) {
            case 'connected':
                return <span className="badge badge-success">Conectada</span>;
            case 'error':
                return <span className="badge badge-danger">Error</span>;
            default:
                return <span className="badge badge-warning">Desconectada</span>;
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
        return <LoadingState text="Cargando conexiones…" className="h-full" />;
    }

    if (portfoliosError) {
        return <ErrorState error={portfoliosError} onRetry={() => void reloadPortfolios()} />;
    }

    return (
        <div className="p-4 md:p-8 max-w-4xl mx-auto">
            {/* Cuentas sociales — Zernio (PG-04) */}
            <div className="glass-card p-6 mb-8">
                <div className="flex items-center justify-between gap-3 mb-1">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <Link2 className="w-4 h-4 text-cyan-400" />
                        Cuentas sociales
                    </h2>
                    <button
                        onClick={syncSocial}
                        disabled={syncing || socialLoading}
                        className="btn-secondary inline-flex items-center gap-2 text-xs !py-2"
                        title="Releer las cuentas desde Zernio"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                        {syncing ? 'Sincronizando...' : 'Sincronizar'}
                    </button>
                </div>
                <p className="text-white/30 text-xs mb-4">
                    La conexión se hace en la pantalla segura de cada red — nunca te pedimos usuario ni contraseña.
                    {socialPlan?.maxPlatforms != null && (
                        <> Tu plan permite hasta {socialPlan.maxPlatforms} plataforma{socialPlan.maxPlatforms !== 1 ? 's' : ''} ({socialPlan.usedPlatforms} en uso).</>
                    )}
                </p>

                {feedback && (
                    <div className={`mb-4 px-4 py-3 rounded-xl text-sm border ${
                        feedback.kind === 'ok'
                            ? 'bg-emerald-500/[0.06] border-emerald-500/15 text-emerald-300'
                            : 'bg-red-500/[0.06] border-red-500/15 text-red-300'
                    }`}>
                        {feedback.text}
                    </div>
                )}

                {/* Connect buttons */}
                <div className="flex flex-wrap gap-2 mb-5">
                    {SOCIAL_PLATFORMS.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => connectPlatform(p.id)}
                            disabled={connectingPlatform !== null}
                            className="btn-secondary inline-flex items-center gap-2 text-xs !py-2"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            {connectingPlatform === p.id ? 'Conectando...' : `Conectar ${p.label}`}
                        </button>
                    ))}
                </div>

                {/* Connected accounts */}
                {socialLoading ? (
                    <LoadingState rows={2} text="Cargando cuentas…" />
                ) : socialError ? (
                    <ErrorState error={socialError} compact onRetry={() => void reloadSocial()} />
                ) : social.length === 0 ? (
                    <EmptyState
                        compact
                        icon={<AtSign />}
                        title="Todavía no conectaste ninguna cuenta."
                    />
                ) : (
                    <div className="space-y-2">
                        {social.map((conn) => (
                            <div key={conn.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.05] hover:border-white/[0.1] transition-all duration-300 group">
                                <div className="flex items-center gap-3 min-w-0">
                                    <AtSign className="w-4 h-4 text-cyan-400/70 shrink-0" />
                                    <span className="text-sm font-medium truncate">
                                        {conn.displayName || conn.username || conn.accountId}
                                    </span>
                                    <span className="text-[10px] text-white/20 uppercase tracking-wider shrink-0">
                                        {platformLabel(conn.platform)}
                                    </span>
                                    {conn.username && conn.displayName && (
                                        <span className="text-xs text-white/25 truncate">@{conn.username}</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                    {statusBadge(conn.status)}
                                    <button
                                        onClick={() => disconnectSocial(conn.id)}
                                        className="opacity-0 group-hover:opacity-100 text-white/20 hover:text-red-400 transition-all duration-300"
                                        title="Desconectar"
                                    >
                                        <Unplug className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Canal de publicación (PG-07): modo del tenant + migración por red */}
            <div className="glass-card p-6 mb-8">
                <h2 className="text-lg font-semibold flex items-center gap-2 mb-1">
                    <Share2 className="w-4 h-4 text-cyan-400" />
                    Canal de publicación
                </h2>
                <p className="text-white/30 text-xs mb-4">
                    Elegí cómo publica tu organización: por Zernio, por el canal directo de siempre, o mezclado.
                    {!channelsLoading && channels && !channels.configured && (
                        <> No elegiste un modo todavía — está activo el default <span className="text-white/50">híbrido</span>.</>
                    )}
                </p>

                {channelsLoading ? (
                    <LoadingState rows={2} text="Cargando canales…" />
                ) : channelsError ? (
                    <ErrorState error={channelsError} compact onRetry={() => void reloadChannels()} />
                ) : channels ? (
                    <>
                        {/* Modo del tenant */}
                        <div className="space-y-2 mb-5">
                            {MODE_OPTIONS.map((opt) => (
                                <label
                                    key={opt.id}
                                    className={`flex items-start gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all duration-300 ${
                                        modeDraft === opt.id
                                            ? 'bg-cyan-500/[0.07] border-cyan-500/25'
                                            : 'bg-white/[0.03] border-white/[0.05] hover:border-white/[0.12]'
                                    }`}
                                >
                                    <input
                                        type="radio"
                                        name="publish-channel-mode"
                                        className="mt-1 accent-cyan-400"
                                        checked={modeDraft === opt.id}
                                        onChange={() => setModeDraft(opt.id)}
                                    />
                                    <span>
                                        <span className="block text-sm font-medium">{opt.label}</span>
                                        <span className="block text-xs text-white/35 mt-0.5">{opt.description}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                        <div className="mb-6">
                            <button
                                onClick={saveChannelMode}
                                disabled={savingMode || modeDraft === channels.mode}
                                className="btn-secondary inline-flex items-center gap-2 text-xs !py-2"
                            >
                                {savingMode ? 'Guardando...' : 'Guardar modo'}
                            </button>
                        </div>

                        {/* Estado de migración por plataforma */}
                        <h3 className="text-sm font-semibold text-white/60 mb-3">Estado por red</h3>
                        <div className="space-y-2">
                            {channels.platforms.map((p) => (
                                <div
                                    key={p.platform}
                                    className="flex items-start justify-between gap-3 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.05]"
                                >
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-sm font-medium">{platformLabel(p.platform)}</span>
                                            {channelBadge(p.channel)}
                                            {p.pendingMigration && (
                                                <span className="text-[10px] text-amber-300/80 uppercase tracking-wider">
                                                    pendiente de migración
                                                </span>
                                            )}
                                        </div>
                                        {p.reason && (
                                            <p className="text-xs text-white/30 mt-1">{p.reason}</p>
                                        )}
                                        {p.channel === 'zernio' && p.zernioConnections.length > 0 && (
                                            <p className="text-xs text-white/30 mt-1 truncate">
                                                {p.zernioConnections
                                                    .map((c) => c.displayName || c.username || c.accountId)
                                                    .join(' · ')}
                                            </p>
                                        )}
                                        {p.legacyAssets.length > 0 && (
                                            <p className="text-xs text-white/30 mt-1 truncate">
                                                {p.legacyAssets
                                                    .map((a) => `${a.name || a.externalId}${a.legacyOnly ? ' (sólo legacy)' : ''}`)
                                                    .join(' · ')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                ) : null}
            </div>

            {/* Create Portfolio */}
            <div className="flex flex-col sm:flex-row gap-3 mb-8">
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
                <EmptyState
                    icon={<Share2 />}
                    title="Crea tu primer portfolio para conectar redes sociales"
                    className="animate-in"
                />
            )}

            {/* Portfolios */}
            <div className="space-y-5 stagger-children">
                {portfolios.map((portfolio) => (
                    <div key={portfolio.id} className="glass-card p-6">
                        <div className="flex items-center justify-between gap-3 mb-4 min-w-0">
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center ring-1 ring-white/[0.08] shrink-0">
                                    <FolderOpen className="w-4 h-4 text-white/40" />
                                </div>
                                <h3 className="text-lg font-semibold truncate">{portfolio.name}</h3>
                                <span className="badge badge-info shrink-0">{portfolio.assets.length} conectado{portfolio.assets.length !== 1 ? 's' : ''}</span>
                            </div>
                            <button onClick={() => deletePortfolio(portfolio.id)} className="tap-target p-2 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/5 transition-all duration-300 shrink-0">
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
                                        <div className="flex items-center gap-3 shrink-0">
                                            {LEGACY_ONLY_ASSET_TYPES.has(asset.assetType) && (
                                                <button
                                                    onClick={() => toggleLegacyOnly(asset)}
                                                    disabled={togglingAsset === asset.id}
                                                    className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-md border transition-all duration-300 ${
                                                        asset.metadata?.legacyOnly === true
                                                            ? 'border-amber-400/40 text-amber-300 bg-amber-500/10'
                                                            : 'border-white/10 text-white/30 hover:border-white/25 hover:text-white/60'
                                                    }`}
                                                    title="Si está activo, esta red publica siempre por el canal directo aunque haya conexión Zernio"
                                                >
                                                    {asset.metadata?.legacyOnly === true ? 'Sólo legacy' : 'Marcar sólo legacy'}
                                                </button>
                                            )}
                                            <button onClick={() => disconnectAsset(asset.id)} className="opacity-0 group-hover:opacity-100 text-white/20 hover:text-red-400 transition-all duration-300" title="Desconectar">
                                                <Unplug className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Connect Buttons */}
                        <div className="flex flex-wrap gap-3">
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
