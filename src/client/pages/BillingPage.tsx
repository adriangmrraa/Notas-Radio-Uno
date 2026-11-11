import { useState, useEffect } from 'react';
import { Check, X, AlertTriangle, Zap, Clock, Sparkles, Radio, RotateCcw, PlusCircle, RefreshCw } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAsyncData } from '../hooks/useAsyncData';
import { ErrorState, LoadingState } from '../components/feedback';
import { useAuth } from '../contexts/AuthContext';
import type { QuotaInfo } from '../lib/billing';

interface Plan {
    id: string;
    name: string;
    displayName: string;
    description: string | null;
    priceUsd: string;
    priceUsdYearly: string | null;
    priceArs: string | null;
    priceArsYearly: string | null;
    maxPipelineHoursPerMonth: number;
    maxPublicationsPerMonth: number;
    maxScheduledJobs: number;
    maxCustomAgents: number;
    maxTeamMembers: number;
    maxConnectedPlatforms: number;
    maxStorageGb: number;
    features: Record<string, boolean>;
}

interface Subscription {
    id: string;
    status: string;
    planName: string;
    planDisplayName: string;
    trialDaysRemaining: number | null;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    billingPeriod: 'monthly' | 'yearly' | null;
    paymentProvider: string | null;
    graceEndsAt: string | null;
    dunningAttempts: number;
    suspendedAt: string | null;
    pendingPlan: { planName: string; billingPeriod: string } | null;
    transmissionsPerCycle: number | null;
    limits: Record<string, number>;
    features: Record<string, boolean>;
}

interface Addon {
    id: string;
    name: string;
    transmissions: number;
    priceUsd: string;
    priceArs: string | null;
}

interface Usage {
    pipelineHoursUsed: number;
    publicationsCount: number;
    transcriptionMinutes: number;
    aiTokensUsed: number;
    storageUsedMb: number;
}

interface Invoice {
    id: string;
    amount: string;
    currency: string;
    status: string;
    paymentProvider: string | null;
    createdAt: string;
}

const FEATURE_LABELS: Record<string, string> = {
    webhook_integration: 'Webhooks (Make/N8N)',
    custom_branding: 'Branding personalizado',
    api_access: 'Acceso API',
    priority_transcription: 'Transcripcion prioritaria',
    advanced_analytics: 'Analytics avanzado',
    multi_provider_ai: 'Multi-provider IA',
    image_ai_generation: 'Generacion de imagenes IA',
    scheduled_processing: 'Procesamiento programado',
};

export function BillingPage() {
    const { fetchApi } = useApi();
    const { user } = useAuth();
    const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');
    const [currency, setCurrency] = useState<'USD' | 'ARS'>('USD');
    const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // Cada endpoint de billing se tolera por separado (una cuenta sin
    // suscripción puede 404ear en /quota y eso no es un error de vista).
    // Falla total → ErrorState bloqueante; parcial → banner con reintento.
    const { data, loading, error, reload } = useAsyncData(async () => {
        const results = await Promise.allSettled([
            fetchApi<Plan[]>('/billing/plans'),
            fetchApi<{ subscription: Subscription | null }>('/billing/my-subscription'),
            fetchApi<Usage>('/billing/usage'),
            fetchApi<QuotaInfo>('/billing/quota', { skipRedirect: true }),
            fetchApi<{ addons: Addon[] }>('/billing/addons'),
            fetchApi<Invoice[]>('/billing/invoices'),
        ]);
        if (results.every((r) => r.status === 'rejected')) {
            throw (results[0] as PromiseRejectedResult).reason;
        }
        const partialFailure = results.some((r) => r.status === 'rejected');
        const ok = <T,>(i: number, fallback: T): T =>
            results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<T>).value : fallback;
        return {
            plans: ok<Plan[]>(0, []),
            subscription: ok<{ subscription: Subscription | null }>(1, { subscription: null }).subscription,
            usage: ok<Usage | null>(2, null),
            quota: ok<QuotaInfo | null>(3, null),
            addons: ok<{ addons: Addon[] }>(4, { addons: [] }).addons,
            invoices: ok<Invoice[]>(5, []),
            partialFailure,
        };
    }, []);
    const plans = data?.plans ?? [];
    const subscription = data?.subscription ?? null;
    const usage = data?.usage ?? null;
    const quota = data?.quota ?? null;
    const addons = data?.addons ?? [];
    const invoices = data?.invoices ?? [];
    const partialFailure = data?.partialFailure ?? false;

    useEffect(() => {
        const status = new URLSearchParams(window.location.search).get('status');
        if (status === 'success') setNotice('Pago confirmado. Tu plan se actualiza en unos segundos.');
        if (status === 'addon_success') setNotice('Add-on acreditado. Las transmisiones ya están en tu ciclo.');
        if (status === 'pending') setNotice('Pago pendiente de confirmación por el proveedor.');
        if (status === 'cancel') setNotice('El pago fue cancelado. No se realizó ningún cargo.');
    }, []);

    const handleCheckout = async (planName: string, provider: 'stripe' | 'mercadopago') => {
        setCheckoutLoading(`${planName}-${provider}`);
        try {
            if (subscription && !isExpired) {
                // Suscripción existente → /change-plan: Stripe prorratea,
                // MP difiere a fin de ciclo, sin provider cae a checkout nuevo.
                const result = await fetchApi<
                    | { applied: 'immediate' | 'deferred'; planName: string }
                    | { applied: 'checkout'; checkoutUrl: string | null; provider: string }
                >('/billing/change-plan', {
                    method: 'POST',
                    body: { planName, billingPeriod, provider },
                });
                if (result.applied === 'checkout') {
                    if (result.checkoutUrl) {
                        if (provider === 'stripe') {
                            window.location.href = result.checkoutUrl;
                        } else {
                            window.open(result.checkoutUrl, '_blank');
                        }
                    }
                } else if (result.applied === 'deferred') {
                    setNotice('Cambio de plan programado: se aplica al final del ciclo actual.');
                    await reload();
                } else {
                    setNotice('Plan actualizado.');
                    await reload();
                }
            } else {
                const result = await fetchApi<{ checkoutUrl: string }>('/billing/checkout', {
                    method: 'POST',
                    body: { planName, billingPeriod, provider },
                });
                if (provider === 'stripe') {
                    window.location.href = result.checkoutUrl;
                } else {
                    window.open(result.checkoutUrl, '_blank');
                }
            }
        } catch (err) {
            console.error('Checkout error:', err);
            setNotice(err instanceof Error ? err.message : 'No se pudo procesar el cambio de plan');
        } finally {
            setCheckoutLoading(null);
        }
    };

    const handleBuyAddon = async (addonName: string, provider: 'stripe' | 'mercadopago') => {
        setCheckoutLoading(`addon-${addonName}-${provider}`);
        try {
            const result = await fetchApi<{ checkoutUrl: string | null }>('/billing/addons/checkout', {
                method: 'POST',
                body: { addonName, provider },
            });
            if (result.checkoutUrl) {
                if (provider === 'stripe') {
                    window.location.href = result.checkoutUrl;
                } else {
                    window.open(result.checkoutUrl, '_blank');
                }
            }
        } catch (err) {
            console.error('Addon checkout error:', err);
            setNotice(err instanceof Error ? err.message : 'No se pudo iniciar la compra del add-on');
        } finally {
            setCheckoutLoading(null);
        }
    };

    const handleReactivate = async () => {
        setActionLoading('reactivate');
        try {
            await fetchApi('/billing/reactivate', { method: 'POST' });
            setNotice('Suscripción reactivada. La cancelación programada fue deshecha.');
            await reload();
        } catch (err) {
            setNotice(err instanceof Error ? err.message : 'No se pudo reactivar la suscripción');
        } finally {
            setActionLoading(null);
        }
    };

    const handleCancel = async () => {
        if (!confirm('Estas seguro? Tu suscripcion seguira activa hasta el final del periodo.')) return;
        setActionLoading('cancel');
        try {
            await fetchApi('/billing/cancel', { method: 'POST' });
            await reload();
        } catch (err) {
            console.error('Cancel error:', err);
        } finally {
            setActionLoading(null);
        }
    };

    const getPrice = (plan: Plan) => {
        if (currency === 'ARS') {
            const p = billingPeriod === 'yearly' ? plan.priceArsYearly : plan.priceArs;
            return p ? `$${Number(p).toLocaleString()} ARS` : 'Consultar';
        }
        const p = billingPeriod === 'yearly' ? plan.priceUsdYearly : plan.priceUsd;
        return `$${Number(p)}/mo`;
    };

    const formatLimit = (v: number) => v === -1 ? 'Ilimitado' : String(v);

    if (loading) {
        return <LoadingState text="Cargando facturación…" className="h-full" />;
    }

    if (error) {
        return <ErrorState error={error} onRetry={() => void reload()} />;
    }

    const isActive = subscription?.status === 'active';
    const isTrialing = subscription?.status === 'trialing';
    const isPastDue = subscription?.status === 'past_due';
    const isSuspended = subscription?.status === 'suspended';
    const isExpired = subscription?.status === 'expired' || subscription?.status === 'canceled';
    const paidPlans = plans.filter(p => p.name !== 'trial');

    const graceDaysRemaining = isPastDue && subscription?.graceEndsAt
        ? Math.max(0, Math.ceil((new Date(subscription.graceEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null;

    const visiblePlans = paidPlans.filter(p => p.name === 'owner' ? user?.role === 'owner' : true);

    return (
        <div className="p-4 md:p-8 max-w-6xl mx-auto">
            {/* Banners */}
            <div className="space-y-4">
                {partialFailure && (
                    <div className="toast toast-error flex items-center justify-between gap-3 animate-slide-up">
                        <div className="flex items-center gap-3">
                            <AlertTriangle className="w-5 h-5 shrink-0" />
                            <p className="text-sm">No pudimos cargar toda la información de facturación.</p>
                        </div>
                        <button
                            onClick={() => void reload()}
                            className="text-xs text-cyan-300 hover:text-cyan-200 transition-colors flex items-center gap-1 shrink-0"
                        >
                            <RefreshCw className="w-3 h-3" />
                            Reintentar
                        </button>
                    </div>
                )}

                {notice && (
                    <div className="toast toast-info flex items-center justify-between gap-3 animate-slide-up">
                        <p className="text-sm">{notice}</p>
                        <button onClick={() => setNotice(null)} className="text-white/40 hover:text-white transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                )}

                {isTrialing && subscription.trialDaysRemaining !== null && (
                    <div className="toast toast-info flex items-center gap-3 animate-slide-up">
                        <Clock className="w-5 h-5 shrink-0" />
                        <p className="text-sm">
                            <span className="font-semibold">{subscription.trialDaysRemaining} dias</span> restantes de tu prueba gratuita.
                            Elige un plan para seguir usando PeriodistApp.
                        </p>
                    </div>
                )}

                {isPastDue && (
                    <div className="toast toast-error flex items-center gap-3 animate-slide-up">
                        <AlertTriangle className="w-5 h-5 shrink-0" />
                        <p className="text-sm">
                            <span className="font-semibold">Pago vencido.</span> El servicio sigue activo
                            {graceDaysRemaining !== null && <> por <span className="font-semibold">{graceDaysRemaining} dias</span></>}.
                            Actualizá tu medio de pago para evitar la suspensión.
                        </p>
                    </div>
                )}

                {isSuspended && (
                    <div className="toast toast-error flex items-center gap-3 animate-slide-up">
                        <AlertTriangle className="w-5 h-5 shrink-0" />
                        <p className="text-sm">
                            <span className="font-semibold">Suscripción suspendida</span> por falta de pago.
                            Regularizá el pago para reactivar el servicio.
                        </p>
                    </div>
                )}

                {isExpired && (
                    <div className="toast toast-error flex items-center gap-3 animate-slide-up">
                        <AlertTriangle className="w-5 h-5 shrink-0" />
                        <p className="text-sm">
                            Tu suscripcion expiro. Elige un plan para reactivar tu cuenta.
                        </p>
                    </div>
                )}

                {(isActive || isPastDue) && (
                    <div className="toast toast-success flex items-center justify-between animate-slide-up">
                        <div className="flex items-center gap-3">
                            <Zap className="w-5 h-5 shrink-0" />
                            <p className="text-sm">
                                Plan <span className="font-semibold">{subscription.planDisplayName}</span> activo
                                {subscription.pendingPlan && (
                                    <span className="text-white/50"> — cambio a <span className="font-medium">{subscription.pendingPlan.planName}</span> al final del ciclo</span>
                                )}
                            </p>
                        </div>
                        <div className="flex items-center gap-4">
                            {subscription.cancelAtPeriodEnd ? (
                                <button
                                    onClick={handleReactivate}
                                    disabled={actionLoading === 'reactivate'}
                                    className="text-xs text-cyan-300 hover:text-cyan-200 transition-colors duration-300 flex items-center gap-1"
                                >
                                    <RotateCcw className="w-3 h-3" />
                                    {actionLoading === 'reactivate' ? 'Reactivando...' : 'Reactivar suscripción'}
                                </button>
                            ) : (
                                <button
                                    onClick={handleCancel}
                                    disabled={actionLoading === 'cancel'}
                                    className="text-xs text-white/30 hover:text-red-400 transition-colors duration-300"
                                >
                                    Cancelar suscripcion
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Transmisiones del ciclo */}
            {quota && !isExpired && (
                <div className="mt-8">
                    <h2 className="text-lg font-semibold mb-4">Transmisiones del ciclo</h2>
                    <div className="glass-card-static p-5">
                        <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                                    <Radio className="w-5 h-5 text-cyan-400" />
                                </div>
                                <div>
                                    <p className="text-2xl font-bold tracking-tight">
                                        {quota.unlimited ? 'Ilimitadas' : `${quota.used} / ${quota.included + quota.addon + quota.extra}`}
                                    </p>
                                    <p className="text-xs text-white/35">
                                        {quota.unlimited
                                            ? 'Tu plan no tiene límite de transmisiones'
                                            : `${quota.remaining} restantes · ciclo hasta el ${new Date(quota.periodEnd + 'T00:00:00').toLocaleDateString()}`}
                                    </p>
                                </div>
                            </div>
                            {!quota.unlimited && (
                                <div className="flex items-center gap-2">
                                    <span className="badge badge-info">Plan +{quota.included}</span>
                                    {quota.addon > 0 && <span className="badge badge-success">Add-ons +{quota.addon}</span>}
                                    {quota.extra > 0 && <span className="badge badge-warning">Extra +{quota.extra}</span>}
                                </div>
                            )}
                        </div>
                        {!quota.unlimited && (
                            <div className="progress-bar">
                                <div
                                    className={`progress-bar-fill ${quota.percentUsed > 90 ? 'bg-red-500' : quota.percentUsed > 70 ? 'bg-amber-500' : 'bg-cyan-500'}`}
                                    style={{ width: `${Math.min(quota.percentUsed, 100)}%` }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Add-ons */}
            {addons.length > 0 && !isExpired && (
                <div className="mt-8">
                    <h2 className="text-lg font-semibold mb-1">Add-ons de transmisiones</h2>
                    <p className="text-sm text-white/35 mb-4">
                        Se acreditan al ciclo vigente y expiran cuando termina. No se acumulan entre períodos.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 stagger-children">
                        {addons.map((addon) => (
                            <div key={addon.id} className="glass-card-static p-5 flex flex-col gap-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <PlusCircle className="w-5 h-5 text-emerald-400" />
                                        <div>
                                            <p className="font-semibold">{addon.name} transmisiones</p>
                                            <p className="text-xs text-white/35">Válidas hasta el fin del ciclo actual</p>
                                        </div>
                                    </div>
                                    <p className="text-xl font-bold tracking-tight">
                                        ${Number(addon.priceUsd)} <span className="text-xs text-white/30 font-normal">USD</span>
                                    </p>
                                </div>
                                {addon.priceArs && (
                                    <p className="text-xs text-white/30">${Number(addon.priceArs).toLocaleString()} ARS con MercadoPago</p>
                                )}
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => handleBuyAddon(addon.name, 'stripe')}
                                        disabled={!!checkoutLoading}
                                        className="btn-white flex-1 !py-2 !text-xs"
                                    >
                                        {checkoutLoading === `addon-${addon.name}-stripe` ? 'Procesando...' : 'Tarjeta'}
                                    </button>
                                    <button
                                        onClick={() => handleBuyAddon(addon.name, 'mercadopago')}
                                        disabled={!!checkoutLoading}
                                        className="btn-secondary flex-1 !py-2 !text-xs !text-cyan-400 !border-cyan-500/15"
                                    >
                                        {checkoutLoading === `addon-${addon.name}-mercadopago` ? 'Procesando...' : 'MercadoPago'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Usage Section */}
            {(isActive || isTrialing) && usage && subscription && (
                <div className="mt-8">
                    <h2 className="text-lg font-semibold mb-4">Uso este mes</h2>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 stagger-children">
                        <UsageCard label="Publicaciones" used={usage.publicationsCount} limit={subscription.limits.maxPublicationsPerMonth} />
                        <UsageCard label="Pipeline (horas)" used={Math.round(usage.pipelineHoursUsed * 10) / 10} limit={subscription.limits.maxPipelineHoursPerMonth} />
                        <UsageCard label="Transcripcion (min)" used={Math.round(usage.transcriptionMinutes)} limit={-1} />
                        <UsageCard label="Tokens IA" used={usage.aiTokensUsed} limit={-1} />
                    </div>
                </div>
            )}

            {/* Period & Currency toggles */}
            <div className="flex flex-wrap items-center gap-4 mt-8 mb-6">
                <div className="flex bg-white/[0.03] rounded-xl p-1 border border-white/[0.04]">
                    <button
                        onClick={() => setBillingPeriod('monthly')}
                        className={`px-4 py-2 rounded-lg text-sm transition-all duration-300 ${billingPeriod === 'monthly' ? 'bg-white/[0.08] text-white font-medium shadow-soft' : 'text-white/35'}`}
                    >Mensual</button>
                    <button
                        onClick={() => setBillingPeriod('yearly')}
                        className={`px-4 py-2 rounded-lg text-sm transition-all duration-300 ${billingPeriod === 'yearly' ? 'bg-white/[0.08] text-white font-medium shadow-soft' : 'text-white/35'}`}
                    >
                        Anual <span className="badge badge-success ml-1.5">-20%</span>
                    </button>
                </div>
                <div className="flex bg-white/[0.03] rounded-xl p-1 border border-white/[0.04]">
                    <button
                        onClick={() => setCurrency('USD')}
                        className={`px-3 py-2 rounded-lg text-sm transition-all duration-300 ${currency === 'USD' ? 'bg-white/[0.08] text-white font-medium' : 'text-white/35'}`}
                    >USD</button>
                    <button
                        onClick={() => setCurrency('ARS')}
                        className={`px-3 py-2 rounded-lg text-sm transition-all duration-300 ${currency === 'ARS' ? 'bg-white/[0.08] text-white font-medium' : 'text-white/35'}`}
                    >ARS</button>
                </div>
            </div>

            {/* Plan Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-10 stagger-children">
                {visiblePlans.map((plan) => {
                    const isCurrent = subscription?.planName === plan.name && isActive;
                    const isPopular = plan.name === 'professional';
                    return (
                        <div key={plan.id} className={`glass-card-static p-6 flex flex-col relative overflow-hidden transition-all duration-300 hover:border-white/[0.12] ${
                            isCurrent ? '!border-cyan-500/30 shadow-glow-cyan' : isPopular ? '!border-cyan-500/30 shadow-glow-cyan scale-[1.02]' : ''
                        }`}>
                            {/* Top accent */}
                            <div className={`absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r ${
                                isCurrent ? 'from-transparent via-cyan-500/60 to-transparent' : isPopular ? 'from-transparent via-cyan-500/60 to-transparent' : 'from-transparent via-white/10 to-transparent'
                            }`} />

                            {isPopular && !isCurrent && (
                                <span className="badge badge-success self-start mb-3 flex items-center gap-1">
                                    <Sparkles className="w-3 h-3" />
                                    Popular
                                </span>
                            )}
                            {isCurrent && (
                                <span className="badge badge-info self-start mb-3 flex items-center gap-1">
                                    <Sparkles className="w-3 h-3" />
                                    ACTUAL
                                </span>
                            )}

                            <h3 className="text-xl font-bold mb-1">{plan.displayName}</h3>
                            <p className="text-white/30 text-sm mb-5">{plan.description}</p>
                            <p className="text-3xl font-bold mb-6 tracking-tight">{getPrice(plan)}</p>

                            <div className="space-y-2.5 mb-6 flex-1">
                                <LimitRow label="Pipeline/mes" value={`${formatLimit(plan.maxPipelineHoursPerMonth)}h`} />
                                <LimitRow label="Publicaciones/mes" value={formatLimit(plan.maxPublicationsPerMonth)} />
                                <LimitRow label="Jobs programados" value={formatLimit(plan.maxScheduledJobs)} />
                                <LimitRow label="Agentes IA" value={formatLimit(plan.maxCustomAgents)} />
                                <LimitRow label="Team" value={formatLimit(plan.maxTeamMembers)} />
                                <LimitRow label="Plataformas" value={formatLimit(plan.maxConnectedPlatforms)} />
                                <LimitRow label="Storage" value={`${plan.maxStorageGb}GB`} />

                                <div className="pt-3 border-t border-white/[0.05] mt-3 space-y-1.5">
                                    {Object.entries(FEATURE_LABELS).map(([key, label]) => (
                                        <div key={key} className="flex items-center gap-2 py-0.5">
                                            {plan.features?.[key]
                                                ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                                                : <X className="w-3.5 h-3.5 text-white/15" />}
                                            <span className={`text-xs ${plan.features?.[key] ? 'text-white/60' : 'text-white/15'}`}>{label}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {!isCurrent && (
                                <div className="space-y-2.5">
                                    <button
                                        onClick={() => handleCheckout(plan.name, 'stripe')}
                                        disabled={!!checkoutLoading}
                                        className={`w-full py-3 ${isPopular ? 'btn-primary' : 'btn-white'}`}
                                    >
                                        {checkoutLoading === `${plan.name}-stripe` ? 'Procesando...' : 'Pagar con Tarjeta'}
                                    </button>
                                    <button
                                        onClick={() => handleCheckout(plan.name, 'mercadopago')}
                                        disabled={!!checkoutLoading}
                                        className="btn-secondary w-full !py-3 !text-cyan-400 !border-cyan-500/15"
                                    >
                                        {checkoutLoading === `${plan.name}-mercadopago` ? 'Procesando...' : 'Pagar con MercadoPago'}
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Invoices */}
            {invoices.length > 0 && (
                <div className="animate-slide-up">
                    <h2 className="text-lg font-semibold mb-4">Historial de facturacion</h2>
                    <div className="glass-card-static overflow-hidden">
                        <table className="table-premium">
                            <thead>
                                <tr>
                                    <th>Fecha</th>
                                    <th>Monto</th>
                                    <th>Estado</th>
                                    <th>Provider</th>
                                </tr>
                            </thead>
                            <tbody>
                                {invoices.map((inv) => (
                                    <tr key={inv.id}>
                                        <td>{new Date(inv.createdAt).toLocaleDateString()}</td>
                                        <td className="font-medium">${Number(inv.amount).toFixed(2)} {inv.currency}</td>
                                        <td>
                                            <span className={`badge ${inv.status === 'paid' ? 'badge-success' : 'badge-warning'}`}>
                                                {inv.status}
                                            </span>
                                        </td>
                                        <td className="capitalize">{inv.paymentProvider || '-'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}

function UsageCard({ label, used, limit }: { label: string; used: number; limit: number }) {
    const pct = limit === -1 ? 0 : Math.min((used / limit) * 100, 100);
    const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-cyan-500';
    return (
        <div className="glass-card-static p-4">
            <p className="text-xs text-white/35 mb-1 uppercase tracking-wider font-medium">{label}</p>
            <p className="text-2xl font-bold tracking-tight">{typeof used === 'number' ? used.toLocaleString() : used}</p>
            <p className="text-xs text-white/20 mb-2.5">de {limit === -1 ? '∞' : limit.toLocaleString()}</p>
            {limit !== -1 && (
                <div className="progress-bar">
                    <div className={`progress-bar-fill ${color}`} style={{ width: `${pct}%` }} />
                </div>
            )}
        </div>
    );
}

function LimitRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex justify-between text-sm">
            <span className="text-white/30">{label}</span>
            <span className="text-white/80 font-medium">{value}</span>
        </div>
    );
}
