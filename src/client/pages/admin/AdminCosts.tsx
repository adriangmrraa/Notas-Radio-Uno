import { useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useAsyncData } from '../../hooks/useAsyncData';
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { ResponsiveTable } from '../../components/ResponsiveTable';

interface UsageTotals {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface AiUsageSummary {
  totals: UsageTotals;
  byTenant: Array<UsageTotals & { tenantId: string }>;
  byFeature: Array<UsageTotals & { feature: string }>;
  byProvider: Array<UsageTotals & { provider: string }>;
  topTransmissions: Array<UsageTotals & { transmissionId: string; tenantId: string }>;
}

interface AdminAiUsageResponse {
  summary: AiUsageSummary;
}

const fmtInt = new Intl.NumberFormat('es-AR');

function formatUsd(value: number): string {
  // Los montos por llamada son centésimas de centavo — 4 decimales mínimo
  // para que el ranking no colapse todo a $0.00.
  if (value !== 0 && Math.abs(value) < 0.0001) return '<$0.0001';
  return `$${value.toFixed(4)}`;
}

function TotalsRow({ label, t, mono }: { label: string; t: UsageTotals; mono?: boolean }) {
  return (
    <tr className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
      <td className={`px-4 py-3 ${mono ? 'font-mono text-[11px] text-white/60' : 'text-white/75'}`} title={label}>
        {mono && label.length > 16 ? `${label.slice(0, 8)}…` : label}
      </td>
      <td className="px-4 py-3 text-white/75">{fmtInt.format(t.calls)}</td>
      <td className="px-4 py-3 text-white/60">
        {t.errors > 0 ? <span className="text-red-400">{fmtInt.format(t.errors)}</span> : '0'}
      </td>
      <td className="px-4 py-3 text-white/60">{fmtInt.format(t.totalTokens)}</td>
      <td className="px-4 py-3 text-right font-medium text-emerald-300">{formatUsd(t.costUsd)}</td>
    </tr>
  );
}

function UsageTable({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <ResponsiveTable label={label}>
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
            <th className="px-4 py-3 font-medium">Nombre</th>
            <th className="px-4 py-3 font-medium">Llamadas</th>
            <th className="px-4 py-3 font-medium">Errores</th>
            <th className="px-4 py-3 font-medium">Tokens</th>
            <th className="px-4 py-3 font-medium text-right">Costo (USD)</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </ResponsiveTable>
  );
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export function AdminCosts() {
  const { fetchApi } = useApi();
  const [tenant, setTenant] = useState('');
  const [feature, setFeature] = useState('');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState('');
  const [debouncedTenant, setDebouncedTenant] = useState('');
  const [debouncedFeature, setDebouncedFeature] = useState('');

  const { data, loading, error, reload } = useAsyncData(
    () => {
      const params = new URLSearchParams({ top: '10' });
      if (debouncedTenant.trim()) params.set('tenantId', debouncedTenant.trim());
      if (debouncedFeature.trim()) params.set('feature', debouncedFeature.trim());
      if (from) params.set('from', new Date(`${from}T00:00:00Z`).toISOString());
      if (to) params.set('to', new Date(`${to}T00:00:00Z`).toISOString());
      return fetchApi<AdminAiUsageResponse>(`/admin/ai-usage?${params.toString()}`);
    },
    [debouncedTenant, debouncedFeature, from, to],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTenant(tenant);
      setDebouncedFeature(feature);
    }, 250);
    return () => clearTimeout(timer);
  }, [tenant, feature]);

  const summary = data?.summary;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Coins className="w-5 h-5 text-emerald-400" />
        <div>
          <h1 className="text-lg font-semibold">Costos de IA</h1>
          <p className="text-xs text-white/30">
            Consumo estimado del ledger <code>ai_usage_events</code> (todos los tenants). Lectura solamente.
          </p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="input-premium"
          title="Desde"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="input-premium"
          title="Hasta (exclusivo)"
        />
        <input
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
          placeholder="Filtrar por tenant (uuid)"
          className="input-premium flex-1 font-mono text-xs"
        />
        <input
          value={feature}
          onChange={(e) => setFeature(e.target.value)}
          placeholder="Filtrar por feature (p. ej. news-generate)"
          className="input-premium flex-1"
        />
      </div>

      {/* Totales del rango */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: 'Llamadas', value: fmtInt.format(summary.totals.calls) },
            { label: 'Errores', value: fmtInt.format(summary.totals.errors) },
            { label: 'Tokens', value: fmtInt.format(summary.totals.totalTokens) },
            { label: 'Costo estimado', value: formatUsd(summary.totals.costUsd) },
          ].map((c) => (
            <div key={c.label} className="glass-card-static px-4 py-3">
              <p className="text-[11px] uppercase tracking-wider text-white/30">{c.label}</p>
              <p className="text-lg font-semibold mt-1">{c.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="glass-card-static overflow-hidden">
        {loading && !data ? (
          <div className="p-4">
            <LoadingState rows={4} text="Cargando uso de IA…" />
          </div>
        ) : error ? (
          <ErrorState error={error} compact onRetry={() => void reload()} />
        ) : !summary || summary.totals.calls === 0 ? (
          <EmptyState
            compact
            icon={<Coins className="w-6 h-6" />}
            title="Sin eventos de uso en el rango"
            description="Cuando los gateways de IA registren llamadas con usageContext van a aparecer acá. Si esperabas ver datos, ajustá el rango o limpiá los filtros."
            action={{ label: 'Limpiar filtros', onClick: () => { setTenant(''); setFeature(''); setFrom(''); setTo(''); } }}
          />
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {/* Por tenant */}
            <div>
              <h2 className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-white/40">
                Por tenant
              </h2>
              <UsageTable label="Uso de IA por tenant">
                {summary.byTenant.map((t) => (
                  <TotalsRow key={t.tenantId} label={t.tenantId} t={t} mono />
                ))}
              </UsageTable>
            </div>

            {/* Top transmisiones */}
            <div>
              <h2 className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-white/40">
                Top transmisiones por costo
              </h2>
              {summary.topTransmissions.length === 0 ? (
                <p className="px-4 py-4 text-xs text-white/25">
                  Ninguna llamada del rango está anclada a una transmisión.
                </p>
              ) : (
                <ResponsiveTable label="Top transmisiones por costo">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                        <th className="px-4 py-3 font-medium">Transmisión</th>
                        <th className="px-4 py-3 font-medium">Tenant</th>
                        <th className="px-4 py-3 font-medium">Llamadas</th>
                        <th className="px-4 py-3 font-medium">Errores</th>
                        <th className="px-4 py-3 font-medium">Tokens</th>
                        <th className="px-4 py-3 font-medium text-right">Costo (USD)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.topTransmissions.map((t) => (
                        <tr
                          key={`${t.tenantId}:${t.transmissionId}`}
                          className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors"
                        >
                          <td className="px-4 py-3">
                            <span className="font-mono text-[11px] text-white/60" title={t.transmissionId}>
                              {t.transmissionId.slice(0, 8)}…
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-mono text-[11px] text-white/40" title={t.tenantId}>
                              {t.tenantId.slice(0, 8)}…
                            </span>
                          </td>
                          <td className="px-4 py-3 text-white/75">{fmtInt.format(t.calls)}</td>
                          <td className="px-4 py-3 text-white/60">
                            {t.errors > 0 ? <span className="text-red-400">{fmtInt.format(t.errors)}</span> : '0'}
                          </td>
                          <td className="px-4 py-3 text-white/60">{fmtInt.format(t.totalTokens)}</td>
                          <td className="px-4 py-3 text-right font-medium text-emerald-300">{formatUsd(t.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ResponsiveTable>
              )}
            </div>

            {/* Por feature + por provider */}
            <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-white/[0.06]">
              <div>
                <h2 className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-white/40">
                  Por feature
                </h2>
                <UsageTable label="Uso de IA por feature">
                  {summary.byFeature.map((t) => (
                    <TotalsRow key={t.feature} label={t.feature} t={t} />
                  ))}
                </UsageTable>
              </div>
              <div>
                <h2 className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wider text-white/40">
                  Por provider
                </h2>
                <UsageTable label="Uso de IA por provider">
                  {summary.byProvider.map((t) => (
                    <TotalsRow key={t.provider} label={t.provider} t={t} />
                  ))}
                </UsageTable>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
