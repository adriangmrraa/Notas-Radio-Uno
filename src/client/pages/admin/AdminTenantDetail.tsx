import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Users, Activity, ToggleLeft, ToggleRight, CalendarClock,
  Ban, PlayCircle, Eye, CreditCard, Gauge, Sparkles, RotateCcw,
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useAsyncData } from '../../hooks/useAsyncData';
import { ErrorState, LoadingState } from '../../components/feedback';

interface TenantDetail {
  tenant: {
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    timezone: string;
    createdAt: string;
    config: Record<string, unknown>;
  };
  users: Array<{
    id: string;
    email: string;
    fullName: string;
    role: string;
    status: string;
    lastLoginAt: string | null;
    createdAt: string;
  }>;
  subscription: {
    id: string;
    status: string;
    planName: string | null;
    planDisplayName: string | null;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    limits: {
      maxPipelineHoursPerMonth: number | null;
      maxPublicationsPerMonth: number | null;
      maxTeamMembers: number | null;
      maxStorageGb: number | null;
    } | null;
  } | null;
  features: Array<{
    id: string;
    featureKey: string;
    enabled: boolean;
    source: string;
    planDefaultEnabled: boolean;
    overriddenAt: string | null;
    notes: string | null;
  }>;
  usageThisCycle: {
    publications: number;
    pipelineHours: number;
    transcriptionMinutes: number;
    aiTokens: number;
    estimatedAiCostUsd: number;
  };
  billing: { paidUsd: number; pendingUsd: number; invoicesCount: number };
  activity: Array<{
    id: string;
    action: string;
    outcome: string;
    actorEmail: string | null;
    entityType: string | null;
    entityId: string | null;
    createdAt: string;
  }>;
}

const PLAN_OPTIONS = ['trial', 'creator', 'media', 'network', 'enterprise'];

function fmt(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('es-AR', {
      day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function AdminTenantDetail() {
  const { id } = useParams<{ id: string }>();
  const { fetchApi } = useApi();
  const navigate = useNavigate();

  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [plan, setPlan] = useState('');
  const [days, setDays] = useState(7);
  const [transmissions, setTransmissions] = useState(5);

  const { data, loading, error, reload } = useAsyncData(
    async () => {
      if (!id) throw new Error('missing-tenant-id');
      const result = await fetchApi<TenantDetail>(`/admin/tenants/${id}`);
      setPlan(result.subscription?.planName ?? '');
      return result;
    },
    [id],
  );

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const run = async (action: string, fn: () => Promise<unknown>, successMsg: string) => {
    setBusy(action);
    try {
      await fn();
      showToast('success', successMsg);
      await reload();
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'La operación falló');
    } finally {
      setBusy(null);
    }
  };

  const changePlan = () =>
    run('plan', () => fetchApi(`/admin/tenants/${id}/plan`, { method: 'PATCH', body: { planName: plan } }), 'Plan actualizado');

  const extendTrial = () =>
    run('trial', () => fetchApi(`/admin/tenants/${id}/trial/extend`, { method: 'POST', body: { days } }), `Trial extendido ${days} días`);

  const grantTransmissions = () =>
    run('transmissions', () => fetchApi(`/admin/tenants/${id}/transmissions`, { method: 'POST', body: { count: transmissions } }), `+${transmissions} transmisiones`);

  const toggleSuspend = (suspended: boolean) =>
    run('suspend', () => fetchApi(`/admin/tenants/${id}/suspend`, { method: 'POST', body: { suspended } }), suspended ? 'Tenant suspendido' : 'Tenant reactivado');

  const setFeature = (key: string, enabled: boolean) =>
    run(`feature:${key}`, () => fetchApi(`/admin/tenants/${id}/features/${key}`, { method: 'PUT', body: { enabled } }), `${key} → ${enabled ? 'on' : 'off'}`);

  const resetFeature = (key: string) =>
    run(`feature:${key}`, () => fetchApi(`/admin/tenants/${id}/features/${key}`, { method: 'DELETE' }), `${key} vuelve al plan`);

  const impersonate = async () => {
    setBusy('impersonate');
    try {
      const result = await fetchApi<{ token: string; sessionId: string; expiresAt: string; targetUserId: string }>(
        `/admin/tenants/${id}/impersonate`,
        { method: 'POST', body: { reason: 'Soporte desde super admin' } },
      );

      sessionStorage.setItem('impersonation', JSON.stringify({
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
        tenantName: data?.tenant.name ?? 'tenant',
        adminToken: localStorage.getItem('accessToken'),
      }));
      localStorage.setItem('accessToken', result.token);
      navigate('/dashboard');
      window.location.reload();
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo impersonar');
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) {
    return <LoadingState text="Cargando tenant…" />;
  }

  if (error && !data) {
    return <ErrorState error={error} onRetry={() => void reload()} />;
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 toast ${toast.type === 'success' ? 'toast-success' : 'toast-error'}`}>
          <span className="text-sm">{toast.msg}</span>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => navigate('/admin/tenants')}
            className="text-xs text-white/35 hover:text-white/70 flex items-center gap-1.5 mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Tenants
          </button>
          <h1 className="text-xl font-semibold flex items-center gap-3">
            {data.tenant.name}
            <span className={`text-[11px] px-2 py-1 rounded-lg ${data.tenant.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
              {data.tenant.isActive ? 'Activo' : 'Suspendido'}
            </span>
          </h1>
          <p className="text-xs text-white/30 mt-1">
            {data.tenant.slug} · alta {fmt(data.tenant.createdAt)} · {data.tenant.timezone}
          </p>
        </div>

        <button
          onClick={impersonate}
          disabled={busy === 'impersonate'}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-500/10 text-purple-300 text-xs hover:bg-purple-500/15 disabled:opacity-40"
          title="Ver la app como este tenant (30 min, auditado)"
        >
          <Eye className="w-3.5 h-3.5" />
          Ver como
        </button>
      </div>

      {/* Uso + billing */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="glass-card-static p-4">
          <p className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Publicaciones (ciclo)</p>
          <p className="text-xl font-semibold">{data.usageThisCycle.publications}</p>
          <p className="text-[11px] text-white/25">límite {data.subscription?.limits?.maxPublicationsPerMonth ?? '∞'}</p>
        </div>
        <div className="glass-card-static p-4">
          <p className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Pipeline</p>
          <p className="text-xl font-semibold">{data.usageThisCycle.pipelineHours.toFixed(1)} h</p>
          <p className="text-[11px] text-white/25">límite {data.subscription?.limits?.maxPipelineHoursPerMonth ?? '∞'} h</p>
        </div>
        <div className="glass-card-static p-4">
          <p className="text-[11px] uppercase tracking-wider text-white/30 mb-1 flex items-center gap-1">
            <Sparkles className="w-3 h-3" /> Costo IA estimado
          </p>
          <p className="text-xl font-semibold">USD {data.usageThisCycle.estimatedAiCostUsd.toFixed(2)}</p>
          <p className="text-[11px] text-white/25">{data.usageThisCycle.aiTokens.toLocaleString('es-AR')} tokens</p>
        </div>
        <div className="glass-card-static p-4">
          <p className="text-[11px] uppercase tracking-wider text-white/30 mb-1 flex items-center gap-1">
            <CreditCard className="w-3 h-3" /> Facturado
          </p>
          <p className="text-xl font-semibold">USD {data.billing.paidUsd.toFixed(2)}</p>
          <p className="text-[11px] text-white/25">
            {data.billing.invoicesCount} facturas · pendiente USD {data.billing.pendingUsd.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Acciones */}
      <div className="glass-card-static p-5 space-y-4">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Gauge className="w-4 h-4 text-cyan-400" />
          Acciones
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Plan */}
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wider text-white/30">Plan</p>
            <div className="flex gap-2">
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white/70"
              >
                {PLAN_OPTIONS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button
                onClick={changePlan}
                disabled={busy === 'plan' || !plan}
                className="px-3 py-2 rounded-lg bg-cyan-500/10 text-cyan-300 text-xs hover:bg-cyan-500/15 disabled:opacity-40"
              >
                Aplicar
              </button>
            </div>
            <p className="text-[11px] text-white/25">
              Plan actual: {data.subscription?.planDisplayName ?? '—'} ({data.subscription?.status ?? 'sin suscripción'})
            </p>
          </div>

          {/* Trial */}
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wider text-white/30 flex items-center gap-1">
              <CalendarClock className="w-3 h-3" /> Trial
            </p>
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-20 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white/70"
              />
              <button
                onClick={extendTrial}
                disabled={busy === 'trial'}
                className="px-3 py-2 rounded-lg bg-cyan-500/10 text-cyan-300 text-xs hover:bg-cyan-500/15 disabled:opacity-40"
              >
                Extender días
              </button>
            </div>
            <p className="text-[11px] text-white/25">Vence: {fmt(data.subscription?.trialEndsAt)}</p>
          </div>

          {/* Transmisiones */}
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wider text-white/30">Transmisiones extra</p>
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                max={100}
                value={transmissions}
                onChange={(e) => setTransmissions(Number(e.target.value))}
                className="w-20 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-white/70"
              />
              <button
                onClick={grantTransmissions}
                disabled={busy === 'transmissions'}
                className="px-3 py-2 rounded-lg bg-cyan-500/10 text-cyan-300 text-xs hover:bg-cyan-500/15 disabled:opacity-40"
              >
                Otorgar
              </button>
            </div>
            <p className="text-[11px] text-white/25">
              Crédito actual: {String((data.tenant.config as Record<string, unknown>)?.extraTransmissions ?? 0)}
            </p>
          </div>
        </div>

        <div className="pt-3 border-t border-white/[0.05] flex flex-wrap gap-2">
          {data.tenant.isActive ? (
            <button
              onClick={() => toggleSuspend(true)}
              disabled={busy === 'suspend'}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-xs hover:bg-red-500/15 disabled:opacity-40"
            >
              <Ban className="w-3.5 h-3.5" />
              Suspender tenant
            </button>
          ) : (
            <button
              onClick={() => toggleSuspend(false)}
              disabled={busy === 'suspend'}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs hover:bg-emerald-500/15 disabled:opacity-40"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              Reactivar tenant
            </button>
          )}
        </div>
      </div>

      {/* Feature flags */}
      <div className="glass-card-static p-5">
        <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
          <ToggleRight className="w-4 h-4 text-cyan-400" />
          Feature flags
        </h2>
        <div className="space-y-2">
          {data.features.map((feature) => (
            <div
              key={feature.featureKey}
              className="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.04]"
            >
              <div className="min-w-0">
                <p className="text-sm text-white/80">{feature.featureKey}</p>
                <p className="text-[11px] text-white/30">
                  {feature.source === 'plan'
                    ? `del plan (${feature.planDefaultEnabled ? 'on' : 'off'})`
                    : `override ${feature.source}`}
                  {feature.overriddenAt ? ` · ${fmt(feature.overriddenAt)}` : ''}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setFeature(feature.featureKey, !feature.enabled)}
                  disabled={busy === `feature:${feature.featureKey}`}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-40 ${
                    feature.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/[0.04] text-white/40'
                  }`}
                >
                  {feature.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                  {feature.enabled ? 'Activo' : 'Inactivo'}
                </button>
                {feature.source !== 'plan' && (
                  <button
                    onClick={() => resetFeature(feature.featureKey)}
                    disabled={busy === `feature:${feature.featureKey}`}
                    title="Volver al valor del plan"
                    className="p-2 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/[0.05] disabled:opacity-40"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
          {data.features.length === 0 && (
            <p className="text-xs text-white/25">El tenant todavía no tiene flags materializados.</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Usuarios */}
        <div className="glass-card-static p-5">
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
            <Users className="w-4 h-4 text-cyan-400" />
            Usuarios ({data.users.length})
          </h2>
          <div className="space-y-2">
            {data.users.map((user) => (
              <div key={user.id} className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-white/[0.02]">
                <div className="min-w-0">
                  <p className="text-sm text-white/80 truncate">{user.fullName}</p>
                  <p className="text-[11px] text-white/30 truncate">{user.email}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[11px] text-white/50">{user.role}</p>
                  <p className="text-[11px] text-white/25">{user.status} · {fmt(user.lastLoginAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Actividad */}
        <div className="glass-card-static p-5">
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-cyan-400" />
            Actividad reciente
          </h2>
          <div className="space-y-2">
            {data.activity.map((event) => (
              <div key={event.id} className="flex items-start justify-between gap-2 p-2.5 rounded-lg bg-white/[0.02]">
                <div className="min-w-0">
                  <p className="text-xs text-white/75 truncate">{event.action}</p>
                  <p className="text-[11px] text-white/30 truncate">
                    {event.actorEmail ?? 'sistema'}
                    {event.entityType ? ` · ${event.entityType}` : ''}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className={`text-[11px] ${event.outcome === 'denied' ? 'text-red-400/70' : event.outcome === 'error' ? 'text-amber-400/70' : 'text-emerald-400/60'}`}>
                    {event.outcome}
                  </p>
                  <p className="text-[11px] text-white/25">{fmt(event.createdAt)}</p>
                </div>
              </div>
            ))}
            {data.activity.length === 0 && <p className="text-xs text-white/25">Sin eventos registrados.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
