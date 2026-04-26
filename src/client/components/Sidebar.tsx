import { NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';
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
  Mic,
  ClipboardCheck,
  Film,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

const NAV_MAIN = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/review', icon: ClipboardCheck, label: 'Revisión' },
  { to: '/clips', icon: Film, label: 'Clips' },
  { to: '/editor', icon: Workflow, label: 'Pipeline Editor' },
  { to: '/programs', icon: Mic, label: 'Programas' },
  { to: '/connections', icon: Share2, label: 'Conexiones' },
  { to: '/scheduled', icon: CalendarClock, label: 'Programados' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
];

const NAV_BOTTOM = [
  { to: '/settings', icon: Settings, label: 'Configuracion' },
  { to: '/billing', icon: CreditCard, label: 'Billing' },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    fetch('/api/review?status=pending_review&limit=1', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => setPendingCount(d.total || 0))
      .catch(() => {});
  }, []);

  return (
    <aside
      className={[
        'sidebar-root',
        // Mobile: fixed overlay, slides in/out
        'fixed inset-y-0 left-0 z-50',
        'transition-transform duration-300 ease-in-out',
        isOpen ? 'translate-x-0' : '-translate-x-full',
        // Desktop: always visible, part of normal flow
        'md:relative md:translate-x-0 md:z-auto',
      ].join(' ')}
    >
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
            onClick={() => onClose()}
          >
            {({ isActive }) => (
              <>
                <div className={`sidebar-item-indicator ${isActive ? 'visible' : ''}`} />
                <div className={`sidebar-item-icon ${isActive ? 'active' : ''}`}>
                  <Icon className="w-[18px] h-[18px]" />
                </div>
                <span className="sidebar-item-label">{label}</span>
                {to === '/review' && pendingCount > 0 && !isActive && (
                  <span
                    style={{
                      fontSize: '10px',
                      fontWeight: 700,
                      lineHeight: 1,
                      padding: '3px 6px',
                      borderRadius: '9999px',
                      background: 'rgba(245, 158, 11, 0.15)',
                      color: '#fbbf24',
                      border: '1px solid rgba(245, 158, 11, 0.2)',
                      marginLeft: 'auto',
                    }}
                  >
                    {pendingCount}
                  </span>
                )}
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
            onClick={() => onClose()}
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
