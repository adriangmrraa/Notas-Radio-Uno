import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Radio,
  RefreshCw,
  Settings2,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useApi } from '../hooks/useApi';
import { EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { classifyError, type AsyncError } from '../lib/errors';

type Transmission = {
  id: string;
  status: 'scheduled' | 'waiting' | 'live' | 'processing' | 'done' | 'error' | 'canceled';
  programName: string | null;
  scheduledName: string | null;
  startedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
};

type ScheduledTransmission = {
  id: string;
  name: string;
  programName: string | null;
  nextRunAt: string | null;
  isActive: boolean;
};

type PublishJob = {
  id: string;
  platform: string;
  status: 'queued' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';
  scheduledFor: string | null;
  lastError: string | null;
};

type Quota = {
  unlimited: boolean;
  used: number;
  included: number;
  addon: number;
  extra: number;
  remaining: number;
  percentUsed: number;
  periodEnd: string | null;
};

type DashboardData = {
  transmissions: Transmission[];
  scheduled: ScheduledTransmission[];
  jobs: PublishJob[];
  quota: Quota | null;
};

const initialData: DashboardData = { transmissions: [], scheduled: [], jobs: [], quota: null };

const transmissionLabels: Record<Transmission['status'], string> = {
  scheduled: 'Programada',
  waiting: 'Esperando señal',
  live: 'En vivo',
  processing: 'Procesando',
  done: 'Finalizada',
  error: 'Con error',
  canceled: 'Cancelada',
};

function formatDate(value: string | null) {
  if (!value) return 'Sin horario definido';
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function statusClass(status: Transmission['status']) {
  if (status === 'live') return 'badge-success';
  if (status === 'error') return 'badge-danger';
  if (status === 'processing' || status === 'waiting') return 'badge-warning';
  return 'badge-info';
}

export function Dashboard() {
  const { user } = useAuth();
  const { fetchApi } = useApi();
  const [data, setData] = useState<DashboardData>(initialData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ total: boolean; reason?: AsyncError } | null>(null);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [transmissions, scheduled, jobs, quota] = await Promise.allSettled([
      fetchApi<{ items: Transmission[] }>('/transmissions?limit=12'),
      fetchApi<{ items: ScheduledTransmission[] }>('/transmissions/scheduled'),
      fetchApi<{ jobs: PublishJob[] }>('/publish-jobs?limit=50'),
      fetchApi<Quota>('/billing/quota'),
    ]);

    const failures = [transmissions, scheduled, jobs, quota].filter((result) => result.status === 'rejected');
    setData({
      transmissions: transmissions.status === 'fulfilled' ? transmissions.value.items : [],
      scheduled: scheduled.status === 'fulfilled' ? scheduled.value.items : [],
      jobs: jobs.status === 'fulfilled' ? jobs.value.jobs : [],
      quota: quota.status === 'fulfilled' ? quota.value : null,
    });
    // Falla total ⇒ ErrorState bloqueante; parcial ⇒ banner ámbar no bloqueante.
    setError(
      failures.length === 0
        ? null
        : {
            total: failures.length === 4,
            reason: classifyError((failures[0] as PromiseRejectedResult).reason),
          },
    );
    setLoading(false);
  }, [fetchApi]);

  useEffect(() => {
    // Se difiere el load: setLoading(true) sincrónico dentro del efecto viola
    // react-hooks/set-state-in-effect.
    void Promise.resolve().then(() => loadDashboard());
  }, [loadDashboard]);

  const liveTransmissions = useMemo(
    () => data.transmissions.filter((transmission) => ['live', 'waiting', 'processing'].includes(transmission.status)),
    [data.transmissions],
  );
  const upcoming = useMemo(
    () => data.scheduled.filter((transmission) => transmission.isActive && transmission.nextRunAt).slice(0, 4),
    [data.scheduled],
  );
  const pendingJobs = useMemo(
    () => data.jobs.filter((job) => ['queued', 'publishing', 'failed', 'partial'].includes(job.status)),
    [data.jobs],
  );
  const firstName = user?.fullName?.split(' ')[0] || 'equipo';

  return (
    <div className="p-4 md:p-8 lg:p-10 space-y-6 max-w-[1440px] mx-auto">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-white/40 capitalize">
            {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight md:text-3xl">Ahora, {firstName}</h1>
          <p className="mt-1 text-sm text-white/45">Estado operativo de tu producción editorial.</p>
        </div>
        <button onClick={() => void loadDashboard()} className="btn-secondary self-start sm:self-auto" disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Actualizar
        </button>
      </header>

      {error?.total ? (
        <ErrorState error={error.reason} onRetry={() => void loadDashboard()} />
      ) : (
      <>
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4" />No pudimos actualizar toda la información del tablero.</span>
          <button onClick={() => void loadDashboard()} className="underline underline-offset-2">Reintentar</button>
        </div>
      )}

      <section className="grid gap-5 lg:grid-cols-[1.45fr_1fr]">
        <div className="glass-card-static overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500/15 text-rose-300"><Radio className="h-4 w-4" /></span>
              <div><h2 className="font-semibold">En vivo ahora</h2><p className="text-xs text-white/40">Señal y procesamiento en curso</p></div>
            </div>
            <Link to="/en-vivo" className="text-sm text-cyan-300 hover:text-cyan-200">Abrir sala</Link>
          </div>
          <div className="p-5">
            {loading ? <LoadingState rows={2} /> : liveTransmissions.length > 0 ? (
              <div className="space-y-3">
                {liveTransmissions.map((transmission) => (
                  <Link key={transmission.id} to={`/en-vivo/${transmission.id}`} className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-white/[0.025] p-4 transition hover:border-cyan-400/30">
                    <div className="min-w-0"><p className="truncate font-medium">{transmission.programName || transmission.scheduledName || 'Transmisión sin programa'}</p><p className="mt-1 text-xs text-white/40">{transmission.startedAt ? `Inició ${formatDate(transmission.startedAt)}` : 'Aún sin hora de inicio'}</p></div>
                    <span className={`badge shrink-0 ${statusClass(transmission.status)}`}>{transmission.status === 'live' && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}{transmissionLabels[transmission.status]}</span>
                  </Link>
                ))}
              </div>
            ) : <EmptyState compact icon={<WifiOff className="h-5 w-5" />} title="No hay transmisiones activas." action={{ label: 'Iniciar transmisión', to: '/en-vivo' }} />}
          </div>
        </div>

        <CapacityCard loading={loading} quota={data.quota} />
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Panel title="Próximas transmisiones" subtitle="Agenda activa" icon={<CalendarClock className="h-4 w-4" />} actionTo="/agenda" action="Ver agenda">
          {loading ? <LoadingState rows={3} /> : upcoming.length > 0 ? <div className="divide-y divide-white/[0.06]">{upcoming.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.name}</p><p className="text-xs text-white/40">{item.programName || 'Sin programa asociado'}</p></div><p className="shrink-0 text-right text-xs text-white/60">{formatDate(item.nextRunAt)}</p></div>)}</div> : <EmptyState compact icon={<CalendarClock className="h-5 w-5" />} title="No hay transmisiones programadas." action={{ label: 'Programar', to: '/agenda' }} />}
        </Panel>

        <Panel title="Pendientes operativos" subtitle="Publicaciones que requieren seguimiento" icon={<AlertCircle className="h-4 w-4" />} actionTo="/publish" action="Ver publicaciones">
          {loading ? <LoadingState rows={3} /> : pendingJobs.length > 0 ? <div className="divide-y divide-white/[0.06]">{pendingJobs.slice(0, 4).map((job) => <div key={job.id} className="flex items-center justify-between gap-4 py-3"><div className="min-w-0"><p className="text-sm font-medium capitalize">{job.platform}</p><p className="truncate text-xs text-white/40">{job.lastError || (job.scheduledFor ? `Programada ${formatDate(job.scheduledFor)}` : 'En cola para publicar')}</p></div><span className={`badge shrink-0 ${job.status === 'failed' || job.status === 'partial' ? 'badge-danger' : 'badge-warning'}`}>{job.status === 'publishing' ? 'Publicando' : job.status === 'queued' ? 'En cola' : job.status === 'failed' ? 'Fallida' : 'Parcial'}</span></div>)}</div> : <EmptyState compact icon={<CheckCircle2 className="h-5 w-5" />} title="No hay pendientes operativos." action={{ label: 'Ir a publicar', to: '/publish' }} />}
        </Panel>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <QuickLink to="/en-vivo" icon={<Wifi className="h-5 w-5" />} title="Nueva transmisión" description="Abrí la sala de producción en vivo." />
        <QuickLink to="/assets" icon={<Upload className="h-5 w-5" />} title="Gestionar activos" description="Revisá el material listo para producir." />
        <QuickLink to="/settings" icon={<Settings2 className="h-5 w-5" />} title="Configuración" description="Ajustá fuentes, equipo y preferencias." />
      </section>
      </>
      )}
    </div>
  );
}

function CapacityCard({ loading, quota }: { loading: boolean; quota: Quota | null }) {
  return <div className="glass-card-static rounded-2xl p-5"><div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-300"><Clock3 className="h-4 w-4" /></span><div><h2 className="font-semibold">Capacidad del ciclo</h2><p className="text-xs text-white/40">Transmisiones incluidas en tu plan</p></div></div>{loading ? <div className="mt-6 h-20 animate-pulse rounded-xl bg-white/[0.05]" /> : quota ? <div className="mt-6"><div className="flex items-end justify-between gap-3"><p className="text-3xl font-bold">{quota.unlimited ? 'Ilimitada' : `${quota.used} / ${quota.included + quota.addon + quota.extra}`}</p>{!quota.unlimited && <p className="text-sm text-white/50">{quota.remaining} restantes</p>}</div>{!quota.unlimited && <><div className="mt-4 h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className={`h-full rounded-full ${quota.percentUsed > 90 ? 'bg-rose-400' : quota.percentUsed > 70 ? 'bg-amber-400' : 'bg-cyan-400'}`} style={{ width: `${Math.min(quota.percentUsed, 100)}%` }} /></div><p className="mt-3 text-xs text-white/40">{quota.periodEnd ? `Ciclo hasta ${new Date(`${quota.periodEnd}T00:00:00`).toLocaleDateString('es-AR')}` : 'Ciclo vigente'}</p></>}</div> : <EmptyState compact icon={<Clock3 className="h-5 w-5" />} title="La capacidad no está disponible." action={{ label: 'Ver facturación', to: '/billing' }} />}</div>;
}

function Panel({ title, subtitle, icon, action, actionTo, children }: { title: string; subtitle: string; icon: React.ReactNode; action: string; actionTo: string; children: React.ReactNode }) {
  return <div className="glass-card-static rounded-2xl p-5"><div className="mb-3 flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-cyan-300">{icon}<div><h2 className="font-semibold text-white">{title}</h2><p className="text-xs text-white/40">{subtitle}</p></div></div><Link to={actionTo} className="text-xs text-cyan-300 hover:text-cyan-200">{action}</Link></div>{children}</div>;
}

function QuickLink({ to, icon, title, description }: { to: string; icon: React.ReactNode; title: string; description: string }) {
  return <Link to={to} className="glass-card-static group rounded-2xl p-5 transition hover:border-cyan-400/30"><div className="mb-4 text-cyan-300">{icon}</div><h2 className="font-semibold">{title}</h2><p className="mt-1 text-sm text-white/45">{description}</p><span className="mt-4 inline-flex items-center gap-1 text-xs text-cyan-300">Abrir <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-1" /></span></Link>;
}
