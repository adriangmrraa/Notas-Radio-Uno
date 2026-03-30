import { useState, useEffect } from 'react';
import { CreditCard, Check, X, AlertTriangle, Zap, Clock, Crown, Sparkles } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';

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
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    limits: Record<string, number>;
    features: Record<string, boolean>;
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
    const [plans, setPlans] = useState<Plan[]>([]);
    const [subscription, setSubscription] = useState<Subscription | null>(null);
    const [usage, setUsage] = useState<Usage | null>(null);
    const [invoices, setInvoices] = useState<Invoice[]>([]);
    const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');
    const [currency, setCurrency] = useState<'USD' | 'ARS'>('USD');
    const [loading, setLoading] = useState(true);
    const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

    useEffect(() => {
        Promise.all([
            fetchApi<Plan[]>('/billing/plans').catch(() => []),
            fetchApi<{ subscription: Subscription | null }>('/billing/my-subscription').catch(() => ({ subscription: null })),
            fetchApi<Usage>('/billing/usage').catch(() => null),
            fetchApi<Invoice[]>('/billing/invoices').catch(() => []),
        ]).then(([p, s, u, i]) => {
            setPlans(p);
            setSubscription(s.subscription);
            setUsage(u);
            setInvoices(i);
            setLoading(false);
        });
    }, []);

    const handleCheckout = async (planName: string, provider: 'stripe' | 'mercadopago') => {
        setCheckoutLoading(`${planName}-${provider}`);
        try {
            const result = await fetchApi<{ checkoutUrl: string }>('/billing/checkout', {
                method: 'POST',
                body: { planName, billingPeriod, provider },
            });
            if (provider === 'stripe') {
                window.location.href = result.checkoutUrl;
            } else {
                window.open(result.checkoutUrl, '_blank');
            }
        } catch (err) {
            console.error('Checkout error:', err);
        } finally {
            setCheckoutLoading(null);
        }
    };

    const handleCancel = async () => {
        if (!confirm('Estas seguro? Tu suscripcion seguira activa hasta el final del periodo.')) return;
        try {
            await fetchApi('/billing/cancel', { method: 'POST' });
            const s = await fetchApi<{ subscription: Subscription | null }>('/billing/my-subscription');
            setSubscription(s.subscription);
        } catch (err) {
            console.error('Cancel error:', err);
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
        return (
            <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-cyan-400/40 border-t-cyan-400 rounded-full animate-spin" />
            </div>
        );
    }

    const isActive = subscription?.status === 'active';
    const isTrialing = subscription?.status === 'trialing';
    const isExpired = subscription?.status === 'expired' || subscription?.status === 'canceled';
    const paidPlans = plans.filter(p => p.name !== 'trial');

    return (
        <div className="p-8 max-w-6xl mx-auto">
            <div className="flex items-center gap-3 mb-1">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500/15 to-cyan-600/5 flex items-center justify-center ring-1 ring-cyan-500/20">
                    <CreditCard className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold">Billing</h1>
                    <p className="text-white/30 text-sm">Gestiona tu suscripcion y facturacion</p>
                </div>
            </div>

            {/* Banners */}
            <div className="mt-8 space-y-4">
                {isTrialing && subscription.trialDaysRemaining !== null && (
                    <div className="toast toast-info flex items-center gap-3 animate-slide-up">
                        <Clock className="w-5 h-5 shrink-0" />
                        <p className="text-sm">
                            <span className="font-semibold">{subscription.trialDaysRemaining} dias</span> restantes de tu prueba gratuita.
                            Elige un plan para seguir usando PeriodistApp.
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

                {isActive && (
                    <div className="toast toast-success flex items-center justify-between animate-slide-up">
                        <div className="flex items-center gap-3">
                            <Zap className="w-5 h-5 shrink-0" />
                            <p className="text-sm">
                                Plan <span className="font-semibold">{subscription.planDisplayName}</span> activo
                            </p>
                        </div>
                        <button onClick={handleCancel} className="text-xs text-white/30 hover:text-red-400 transition-colors duration-300">
                            Cancelar suscripcion
                        </button>
                    </div>
                )}
            </div>

            {/* Usage Section */}
            {(isActive || isTrialing) && usage && subscription && (
                <div className="mt-8">
                    <h2 className="text-lg font-semibold mb-4">Uso este mes</h2>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
                        <UsageCard label="Publicaciones" used={usage.publicationsCount} limit={subscription.limits.maxPublicationsPerMonth} />
                        <UsageCard label="Pipeline (horas)" used={Math.round(usage.pipelineHoursUsed * 10) / 10} limit={subscription.limits.maxPipelineHoursPerMonth} />
                        <UsageCard label="Transcripcion (min)" used={Math.round(usage.transcriptionMinutes)} limit={-1} />
                        <UsageCard label="Tokens IA" used={usage.aiTokensUsed} limit={-1} />
                    </div>
                </div>
            )}

            {/* Period & Currency toggles */}
            <div className="flex items-center gap-4 mt-8 mb-6">
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10 stagger-children">
                {paidPlans.map((plan, idx) => {
                    const isCurrent = subscription?.planName === plan.name && isActive;
                    const isPopular = idx === 1;
                    return (
                        <div key={plan.id} className={`glass-card-static p-6 flex flex-col relative overflow-hidden transition-all duration-300 hover:border-white/[0.12] ${
                            isCurrent ? '!border-cyan-500/30 shadow-glow-cyan' : isPopular ? '!border-purple-500/20' : ''
                        }`}>
                            {/* Top accent */}
                            <div className={`absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r ${
                                isCurrent ? 'from-transparent via-cyan-500/60 to-transparent' : isPopular ? 'from-transparent via-purple-500/40 to-transparent' : 'from-transparent via-white/10 to-transparent'
                            }`} />

                            {isPopular && !isCurrent && (
                                <span className="badge badge-purple self-start mb-3 flex items-center gap-1">
                                    <Crown className="w-3 h-3" />
                                    POPULAR
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
