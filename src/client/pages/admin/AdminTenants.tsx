import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Building2, Search, Users, FileText, Sparkles, DollarSign, ChevronRight,
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useAsyncData } from '../../hooks/useAsyncData';
import { ErrorState, LoadingState } from '../../components/feedback';

interface PlatformStats {
  tenants: { total: number; active: number; suspended: number; newLast30d: number };
  users: { total: number; active: number; platformAdmins: number };
  subscriptions: { byStatus: Record<string, number>; trialing: number; active: number };
  revenue: { activeMrrUsd: number };
  usage: { publications30d: number; pipelineHours30d: number };
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  createdAt: string;
  ownerEmail: string | null;
  ownerName: string | null;
  planName: string | null;
  planDisplayName: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  usersCount: number;
  publicationsThisCycle: number;
  enabledFeatures: number;
}

interface TenantListResponse {
  tenants: TenantRow[];
  total: number;
  page: number;
  pageSize: number;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: '2-digit' });
  } catch {
    return '—';
  }
}

function StatusPill({ tenant }: { tenant: TenantRow }) {
  if (!tenant.isActive) {
    return <span className="text-[11px] px-2 py-1 rounded-lg bg-red-500/10 text-red-400">Suspendido</span>;
  }
  if (tenant.subscriptionStatus === 'trialing') {
    return <span className="text-[11px] px-2 py-1 rounded-lg bg-amber-500/10 text-amber-400">Trial</span>;
  }
  if (tenant.subscriptionStatus === 'past_due') {
    return <span className="text-[11px] px-2 py-1 rounded-lg bg-orange-500/10 text-orange-400">Pago pendiente</span>;
  }
  return <span className="text-[11px] px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-400">Activo</span>;
}

function Kpi({ icon: Icon, label, value, hint }: { icon: typeof Users; label: string; value: string; hint?: string }) {
  return (
    <div className="glass-card-static p-4">
      <div className="flex items-center gap-2 text-white/35 text-[11px] uppercase tracking-wider mb-2">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <p className="text-2xl font-semibold">{value}</p>
      {hint && <p className="text-[11px] text-white/25 mt-1">{hint}</p>}
    </div>
  );
}

export function AdminTenants() {
  const { fetchApi } = useApi();
  const navigate = useNavigate();

  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'suspended' | 'trialing'>('all');
  const [page, setPage] = useState(1);

  const loadStats = useCallback(async () => {
    try {
      setStats(await fetchApi<PlatformStats>('/admin/stats'));
    } catch {
      /* el listado sigue funcionando aunque fallen los KPIs */
    }
  }, [fetchApi]);

  const { data, loading, error, reload } = useAsyncData(
    () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '25', status });
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      return fetchApi<TenantListResponse>(`/admin/tenants?${params.toString()}`);
    },
    [page, status, debouncedSearch],
  );

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Tenants</h1>
        <p className="text-sm text-white/35 mt-1">Estado, plan y uso de cada organización.</p>
      </div>

      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Kpi
            icon={Building2}
            label="Tenants"
            value={String(stats.tenants.total)}
            hint={`${stats.tenants.active} activos · ${stats.tenants.suspended} suspendidos`}
          />
          <Kpi
            icon={Users}
            label="Usuarios"
            value={String(stats.users.total)}
            hint={`${stats.users.active} activos · ${stats.users.platformAdmins} admins`}
          />
          <Kpi
            icon={DollarSign}
            label="MRR estimado"
            value={`USD ${stats.revenue.activeMrrUsd.toFixed(0)}`}
            hint={`${stats.subscriptions.active} activas · ${stats.subscriptions.trialing} en trial`}
          />
          <Kpi
            icon={FileText}
            label="Publicaciones 30d"
            value={String(stats.usage.publications30d)}
            hint={`${stats.usage.pipelineHours30d.toFixed(1)} h de pipeline`}
          />
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Buscar por nombre, slug o email del owner"
            className="input-premium pl-11"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setPage(1);
          }}
          className="px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white/70"
        >
          <option value="all">Todos</option>
          <option value="active">Activos</option>
          <option value="suspended">Suspendidos</option>
          <option value="trialing">En trial</option>
        </select>
      </div>

      {error && data && (
        <ErrorState error={error} compact onRetry={() => void reload()} />
      )}

      {/* Tabla */}
      <div className="glass-card-static overflow-hidden">
        {loading && !data ? (
          <div className="p-4">
            <LoadingState rows={4} text="Cargando tenants…" />
          </div>
        ) : error ? (
          <ErrorState error={error} compact onRetry={() => void reload()} />
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                <th className="px-4 py-3 font-medium">Organización</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 font-medium">Usuarios</th>
                <th className="px-4 py-3 font-medium">Publicaciones</th>
                <th className="px-4 py-3 font-medium">Alta</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {data?.tenants.map((tenant) => (
                <tr
                  key={tenant.id}
                  onClick={() => navigate(`/admin/tenants/${tenant.id}`)}
                  className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <p className="text-white/85">{tenant.name}</p>
                    <p className="text-[11px] text-white/30">{tenant.slug}</p>
                  </td>
                  <td className="px-4 py-3 text-white/60">{tenant.planDisplayName ?? tenant.planName ?? '—'}</td>
                  <td className="px-4 py-3"><StatusPill tenant={tenant} /></td>
                  <td className="px-4 py-3 text-white/60">{tenant.usersCount}</td>
                  <td className="px-4 py-3 text-white/60">{tenant.publicationsThisCycle}</td>
                  <td className="px-4 py-3 text-white/40 text-xs">{formatDate(tenant.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <ChevronRight className="w-4 h-4 text-white/20 inline" />
                  </td>
                </tr>
              ))}

              {data && data.tenants.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-white/30 text-sm">
                    No hay tenants que coincidan con el filtro.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}

        {data && data.total > data.pageSize && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06] text-xs text-white/40">
            <span>
              {data.total} tenants · página {data.page} de {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30"
              >
                Anterior
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-white/20 flex items-center gap-1.5">
        <Sparkles className="w-3 h-3" />
        Toda acción administrativa queda auditada. Para sumar transmisiones o extender trials entrá al detalle del tenant.
      </p>

      <Link to="/dashboard" className="text-xs text-cyan-400/70 hover:text-cyan-400">
        ← Volver a la app
      </Link>
    </div>
  );
}
