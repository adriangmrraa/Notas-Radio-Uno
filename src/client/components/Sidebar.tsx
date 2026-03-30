import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Workflow,
  Share2,
  Settings,
  CreditCard,
  BarChart3,
  CalendarClock,
  LogOut,
  Newspaper,
  ChevronRight,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const NAV_MAIN = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/editor', icon: Workflow, label: 'Pipeline Editor' },
  { to: '/connections', icon: Share2, label: 'Conexiones' },
  { to: '/scheduled', icon: CalendarClock, label: 'Programados' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
];

const NAV_BOTTOM = [
  { to: '/settings', icon: Settings, label: 'Configuracion' },
  { to: '/billing', icon: CreditCard, label: 'Billing' },
];

export function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside className="sidebar-root">
      {/* Ambient glow */}
      <div className="sidebar-glow" />
      <div className="sidebar-glow-2" />

      {/* Top accent line */}
      <div className="sidebar-accent-line" />

      {/* Logo */}
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">
          <Newspaper className="w-5 h-5" />
        </div>
        <div className="sidebar-logo-text">
          <span className="sidebar-logo-title">PeriodistApp</span>
          <span className="sidebar-logo-sub">AI NEWSROOM</span>
        </div>
      </div>

      {/* Main nav */}
      <nav className="sidebar-nav">
        <div className="sidebar-nav-label">Menu</div>
        {NAV_MAIN.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            {({ isActive }) => (
              <>
                <div className={`sidebar-item-indicator ${isActive ? 'visible' : ''}`} />
                <div className={`sidebar-item-icon ${isActive ? 'active' : ''}`}>
                  <Icon className="w-[18px] h-[18px]" />
                </div>
                <span className="sidebar-item-label">{label}</span>
                {isActive && <ChevronRight className="sidebar-item-chevron" />}
              </>
            )}
          </NavLink>
        ))}

        <div className="sidebar-divider" />
        <div className="sidebar-nav-label">Sistema</div>

        {NAV_BOTTOM.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar-item ${isActive ? 'active' : ''}`
            }
          >
            {({ isActive }) => (
              <>
                <div className={`sidebar-item-indicator ${isActive ? 'visible' : ''}`} />
                <div className={`sidebar-item-icon ${isActive ? 'active' : ''}`}>
                  <Icon className="w-[18px] h-[18px]" />
                </div>
                <span className="sidebar-item-label">{label}</span>
                {isActive && <ChevronRight className="sidebar-item-chevron" />}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* User card */}
      <div className="sidebar-user">
        <div className="sidebar-user-card">
          <div className="sidebar-avatar">
            <span>{user?.fullName?.charAt(0)?.toUpperCase() || 'U'}</span>
            <div className="sidebar-avatar-status" />
          </div>
          <div className="sidebar-user-info">
            <p className="sidebar-user-name">{user?.fullName || 'Usuario'}</p>
            <p className="sidebar-user-org">{user?.tenant?.name || 'Organizacion'}</p>
          </div>
        </div>
        <button onClick={logout} className="sidebar-logout">
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
