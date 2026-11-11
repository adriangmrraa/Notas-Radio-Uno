import { Navigate, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Building2, LayoutDashboard, LogOut, ArrowLeft, ShieldCheck, CreditCard, ListChecks } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

const NAV = [
  { to: '/admin', icon: LayoutDashboard, label: 'Resumen', end: true },
  { to: '/admin/tenants', icon: Building2, label: 'Tenants', end: false },
  { to: '/admin/plans', icon: CreditCard, label: 'Planes', end: false },
  { to: '/admin/jobs', icon: ListChecks, label: 'Jobs', end: false },
];

export function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user?.isPlatformAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="min-h-screen bg-void text-white">
      <header className="border-b border-white/[0.06] bg-white/[0.02]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500/25 to-cyan-500/15 flex items-center justify-center border border-white/[0.08]">
              <ShieldCheck className="w-5 h-5 text-purple-300" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-tight">Super Admin</p>
              <p className="text-[11px] text-white/30 leading-tight">PeriodistApp · plataforma</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/dashboard')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-white/50 hover:text-white/80 hover:bg-white/[0.04] transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Volver a la app
            </button>
            <button
              onClick={logout}
              className="p-2 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Salir"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        <nav className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1 pb-2">
          {NAV.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors ${
                  isActive ? 'bg-white/[0.06] text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/[0.03]'
                }`
              }
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
