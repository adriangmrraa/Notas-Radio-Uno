import { useEffect, useState } from 'react';
import { AlertCircle, ListChecks, RotateCcw } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useAsyncData } from '../../hooks/useAsyncData';
import { EmptyState, ErrorState, LoadingState } from '../../components/feedback';
import { ResponsiveTable } from '../../components/ResponsiveTable';

type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

interface AdminJob {
  id: string;
  tenantId: string;
  kind: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deadLetteredAt: string | null;
  lastError: string | null;
  errorCategory: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AdminJobsResponse {
  jobs: AdminJob[];
  total: number;
  counts: Record<JobStatus, number>;
}

const STATUS_OPTIONS: Array<{ value: 'all' | JobStatus; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'running', label: 'Corriendo' },
  { value: 'succeeded', label: 'Exitosos' },
  { value: 'failed', label: 'Fallidos' },
  { value: 'dead', label: 'Dead-letter' },
  { value: 'cancelled', label: 'Cancelados' },
];

const STATUS_PILL: Record<JobStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-400',
  running: 'bg-cyan-500/10 text-cyan-400',
  succeeded: 'bg-emerald-500/10 text-emerald-400',
  failed: 'bg-red-500/10 text-red-400',
  dead: 'bg-rose-500/15 text-rose-300',
  cancelled: 'bg-white/[0.06] text-white/40',
};

const PAGE_SIZE = 50;

function formatTs(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('es-AR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function StatusPill({ status }: { status: JobStatus }) {
  return (
    <span className={`text-[11px] px-2 py-1 rounded-lg ${STATUS_PILL[status] ?? 'bg-white/[0.06] text-white/50'}`}>
      {status}
    </span>
  );
}

export function AdminJobs() {
  const { fetchApi } = useApi();
  const [status, setStatus] = useState<'all' | JobStatus>('all');
  const [kind, setKind] = useState('');
  const [tenant, setTenant] = useState('');
  const [debouncedKind, setDebouncedKind] = useState('');
  const [debouncedTenant, setDebouncedTenant] = useState('');
  const [offset, setOffset] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const { data, loading, error, reload } = useAsyncData(
    () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (status !== 'all') params.set('status', status);
      if (debouncedKind.trim()) params.set('kind', debouncedKind.trim());
      if (debouncedTenant.trim()) params.set('tenantId', debouncedTenant.trim());
      return fetchApi<AdminJobsResponse>(`/admin/jobs?${params.toString()}`);
    },
    [status, debouncedKind, debouncedTenant, offset],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKind(kind);
      setDebouncedTenant(tenant);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [kind, tenant]);

  const retryJob = async (job: AdminJob) => {
    setRetrying(job.id);
    setActionError('');
    setNotice('');
    try {
      await fetchApi(`/admin/jobs/${job.id}/retry`, { method: 'POST' });
      setNotice(`Job ${job.id.slice(0, 8)} re-encolado`);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Error re-encolando el job');
    } finally {
      setRetrying(null);
    }
  };

  const jobs = data?.jobs ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const counts = data?.counts;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ListChecks className="w-5 h-5 text-cyan-400" />
        <div>
          <h1 className="text-lg font-semibold">Jobs</h1>
          <p className="text-xs text-white/30">
            Cola genérica de la plataforma (todos los tenants). La dead-letter se re-encola desde acá.
          </p>
        </div>
      </div>

      {/* Conteos por estado */}
      {counts && (
        <div className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.filter((o) => o.value !== 'all').map((o) => (
            <span
              key={o.value}
              className={`text-[11px] px-2.5 py-1 rounded-lg border border-white/[0.06] ${
                (counts[o.value as JobStatus] ?? 0) > 0 ? STATUS_PILL[o.value as JobStatus] : 'text-white/25'
              }`}
            >
              {o.label}: {counts[o.value as JobStatus] ?? 0}
            </span>
          ))}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setOffset(0);
          }}
          className="px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white/70"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          placeholder="Filtrar por kind (p. ej. retention.purge)"
          className="input-premium flex-1"
        />
        <input
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
          placeholder="Filtrar por tenant (uuid)"
          className="input-premium flex-1 font-mono text-xs"
        />
      </div>

      {actionError && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5" /> {actionError}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 rounded-lg px-3 py-2">
          {notice}
        </div>
      )}

      {/* Tabla */}
      <div className="glass-card-static overflow-hidden">
        {loading && !data ? (
          <div className="p-4">
            <LoadingState rows={4} text="Cargando jobs…" />
          </div>
        ) : error ? (
          <ErrorState error={error} compact onRetry={() => void reload()} />
        ) : jobs.length === 0 ? (
          <EmptyState
            compact
            icon={<ListChecks className="w-6 h-6" />}
            title="No hay jobs en la cola"
            description="Cuando haya trabajo diferido (purgas de retención u otros procesos) va a aparecer acá. Si esperabas ver algo, ajustá o limpiá los filtros."
            action={{ label: 'Limpiar filtros', onClick: () => { setStatus('all'); setKind(''); setTenant(''); setOffset(0); } }}
          />
        ) : (
          <ResponsiveTable label="Tabla de jobs de la plataforma">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                  <th className="px-4 py-3 font-medium">Tenant</th>
                  <th className="px-4 py-3 font-medium">Kind</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Intentos</th>
                  <th className="px-4 py-3 font-medium">Run at</th>
                  <th className="px-4 py-3 font-medium">Último error</th>
                  <th className="px-4 py-3 font-medium text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                    <td className="px-4 py-3">
                      <span className="font-mono text-[11px] text-white/60" title={job.tenantId}>
                        {job.tenantId.slice(0, 8)}…
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/75">{job.kind}</td>
                    <td className="px-4 py-3"><StatusPill status={job.status} /></td>
                    <td className="px-4 py-3 text-white/60">
                      {job.attempts}/{job.maxAttempts}
                    </td>
                    <td className="px-4 py-3 text-white/40 text-xs" title={job.runAt}>
                      {formatTs(job.runAt)}
                    </td>
                    <td className="px-4 py-3 max-w-[240px]">
                      {job.lastError ? (
                        <p className="text-[11px] text-red-300/80 truncate" title={job.lastError}>
                          {job.lastError}
                        </p>
                      ) : (
                        <span className="text-white/20">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(job.status === 'dead' || job.status === 'failed') && (
                        <button
                          type="button"
                          onClick={() => retryJob(job)}
                          disabled={retrying === job.id}
                          className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <RotateCcw className={`w-3 h-3 ${retrying === job.id ? 'animate-spin' : ''}`} />
                          Re-encolar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        )}

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06] text-xs text-white/40">
            <span>
              {total} jobs · página {page} de {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                disabled={offset <= 0}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30"
              >
                Anterior
              </button>
              <button
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                disabled={page >= totalPages}
                className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-30"
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
