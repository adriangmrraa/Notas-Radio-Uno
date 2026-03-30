import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Zap,
  FileText,
  Radio,
  Clock,
  TrendingUp,
  Workflow,
  CalendarClock,
  Share2,
  ArrowRight,
  Sparkles,
  Activity,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import App from '../App';

export function Dashboard() {
  const { user } = useAuth();

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Buenos dias';
    if (h < 18) return 'Buenas tardes';
    return 'Buenas noches';
  };

  const firstName = user?.fullName?.split(' ')[0] || 'Usuario';
  const planName = user?.subscription?.planName || 'trial';
  const trialDays = user?.subscription?.trialDaysRemaining;

  return (
    <div className="p-8 lg:p-10 space-y-8 max-w-[1440px] mx-auto">
      {/* Welcome */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6 animate-slide-up">
        <div>
          <p className="text-white/30 text-sm font-medium mb-1">
            {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className="text-3xl lg:text-4xl font-bold tracking-tight leading-tight">
            {greeting()},{' '}
            <span className="bg-gradient-to-r from-cyan-400 via-cyan-300 to-blue-400 bg-clip-text text-transparent">
              {firstName}
            </span>
          </h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {trialDays !== undefined && trialDays !== null && (
            <div className="badge badge-info flex items-center gap-2 px-4 py-1.5">
              <Clock className="w-3.5 h-3.5" />
              <span>{trialDays} dias restantes</span>
            </div>
          )}
          <div className="badge badge-purple flex items-center gap-2 px-4 py-1.5 capitalize">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Plan {planName}</span>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 stagger-children">
        <KpiCard icon={<FileText />} label="Publicaciones" value={0} color="cyan" />
        <KpiCard icon={<Radio />} label="Transcripciones" value={0} color="emerald" />
        <KpiCard icon={<Clock />} label="Horas Pipeline" value={0} suffix="h" color="amber" />
        <KpiCard icon={<TrendingUp />} label="Temas Detectados" value={0} color="purple" />
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 stagger-children">
        <QuickAction to="/editor" icon={<Workflow />} title="Pipeline Editor" desc="Configura los pasos del pipeline visual" color="cyan" />
        <QuickAction to="/scheduled" icon={<CalendarClock />} title="Programados" desc="Gestiona capturas automaticas" color="emerald" />
        <QuickAction to="/connections" icon={<Share2 />} title="Conexiones" desc="Conecta tus redes sociales" color="purple" />
      </div>

      {/* Pipeline Section */}
      <div className="animate-slide-up" style={{ animationDelay: '400ms' }}>
        <div className="flex items-center gap-5 mb-6">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
          <div className="flex items-center gap-2.5 px-5 py-2 rounded-full bg-white/[0.02] border border-white/[0.05]">
            <Activity className="w-4 h-4 text-cyan-400" />
            <span className="text-white/40 text-xs font-semibold uppercase tracking-widest">Pipeline en Vivo</span>
          </div>
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
        </div>

        <div className="glass-card-static overflow-hidden rounded-2xl">
          <App />
        </div>
      </div>
    </div>
  );
}

/* ─── KPI Card ─── */

function KpiCard({ icon, label, value, suffix = '', color }: {
  icon: React.ReactNode; label: string; value: number; suffix?: string;
  color: 'cyan' | 'emerald' | 'amber' | 'purple';
}) {
  const palette = {
    cyan:    { bg: 'from-cyan-500/12 to-cyan-600/4', border: 'border-cyan-500/10', icon: 'text-cyan-400', val: 'text-cyan-300', glow: 'shadow-[0_0_24px_rgba(34,211,238,0.06)]' },
    emerald: { bg: 'from-emerald-500/12 to-emerald-600/4', border: 'border-emerald-500/10', icon: 'text-emerald-400', val: 'text-emerald-300', glow: 'shadow-[0_0_24px_rgba(16,185,129,0.06)]' },
    amber:   { bg: 'from-amber-500/12 to-amber-600/4', border: 'border-amber-500/10', icon: 'text-amber-400', val: 'text-amber-300', glow: 'shadow-[0_0_24px_rgba(245,158,11,0.06)]' },
    purple:  { bg: 'from-purple-500/12 to-purple-600/4', border: 'border-purple-500/10', icon: 'text-purple-400', val: 'text-purple-300', glow: 'shadow-[0_0_24px_rgba(124,58,237,0.06)]' },
  };
  const c = palette[color];

  return (
    <div className={`glass-card group p-6 ${c.glow}`}>
      <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${c.bg} border ${c.border} flex items-center justify-center ${c.icon} mb-4 transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3`}>
        <div className="w-5 h-5">{icon}</div>
      </div>
      <div className={`text-3xl font-bold ${c.val} tracking-tight mb-1`}>
        {value}
        {suffix && <span className="text-lg font-normal text-white/20 ml-1">{suffix}</span>}
      </div>
      <p className="text-xs text-white/30 font-medium tracking-wide">{label}</p>
    </div>
  );
}

/* ─── Quick Action ─── */

function QuickAction({ to, icon, title, desc, color }: {
  to: string; icon: React.ReactNode; title: string; desc: string;
  color: 'cyan' | 'emerald' | 'purple';
}) {
  const palette = {
    cyan:    { hover: 'hover:border-cyan-500/20', icon: 'text-cyan-400', arrow: 'group-hover:text-cyan-400' },
    emerald: { hover: 'hover:border-emerald-500/20', icon: 'text-emerald-400', arrow: 'group-hover:text-emerald-400' },
    purple:  { hover: 'hover:border-purple-500/20', icon: 'text-purple-400', arrow: 'group-hover:text-purple-400' },
  };
  const c = palette[color];

  return (
    <Link to={to} className={`glass-card group flex items-center gap-5 p-5 ${c.hover} cursor-pointer no-underline`}>
      <div className={`${c.icon} w-5 h-5 flex-shrink-0`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white/85 mb-0.5">{title}</p>
        <p className="text-xs text-white/25">{desc}</p>
      </div>
      <ArrowRight className={`w-4 h-4 text-white/10 transition-all duration-300 ${c.arrow} group-hover:translate-x-1.5`} />
    </Link>
  );
}
