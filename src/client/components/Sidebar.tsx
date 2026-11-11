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
  CalendarDays,
  LogOut,
  Newspaper,
  ChevronRight,
  Mic,
  ClipboardCheck,
  Film,
  Inbox,
  ShieldCheck,
  Users,
  PenLine,
  Radio,
  Send,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useFeatures } from '../hooks/useFeature';

const NAV_SECTIONS = [
  {
    label: 'Ahora',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Panel de control' },
      { to: '/en-vivo', icon: Radio, label: 'Operación en vivo' },
    ],
  },
  {
    label: 'Producción editorial',
    items: [
      { to: '/review', icon: ClipboardCheck, label: 'Revisión' },
      { to: '/clips', icon: Film, label: 'Clips', feature: 'clips' },
      { to: '/editor', icon: Workflow, label: 'Pipeline', feature: 'pipeline_editor' },
      { to: '/programs', icon: Mic, label: 'Programas' },
      { to: '/persons', icon: Users, label: 'Personas' },
      { to: '/editorial', icon: PenLine, label: 'Línea editorial' },
    ],
  },
  {
    label: 'Contenido',
    items: [{ to: '/assets', icon: Inbox, label: 'Assets' }],
  },
  {
    label: 'Publicación',
    items: [{ to: '/publish', icon: Send, label: 'Cola de publicación' }],
  },
  {
    label: 'Programación',
    items: [
      { to: '/scheduled', icon: CalendarClock, label: 'Automatizaciones' },
      { to: '/agenda', icon: CalendarDays, label: 'Agenda' },
    ],
  },
  {
    label: 'Analítica',
    items: [{ to: '/analytics', icon: BarChart3, label: 'Rendimiento' }],
  },
];

const NAV_SYSTEM = [
  { to: '/connections', icon: Share2, label: 'Conexiones' },
  { to: '/settings', icon: Settings, label: 'Configuracion' },
  { to: '/billing', icon: CreditCard, label: 'Billing' },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const { features } = useFeatures();
  const [pendingCount, setPendingCount] = useState(0);

  // A disabled flag hides only its entry; server-side authorization remains authoritative.
  const visibleItems = (items: typeof NAV_SECTIONS[number]['items']) => items.filter((item) => {
    const feature = (item as { feature?: string }).feature;
    return !feature || features[feature]?.enabled !== false;
  });

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
        // <lg (tablet/phone): fixed overlay, slides in/out
        'fixed inset-y-0 left-0 z-50',
        'transition-transform duration-300 ease-in-out',
        isOpen ? 'translate-x-0' : '-translate-x-full',
        // Desktop: always visible, part of normal flow
        'lg:relative lg:translate-x-0 lg:z-auto',
      ].join(' ')}
    >
      {/* Ambient glow */}
      <div className="sidebar-glow" />
      <div className="sidebar-glow-2" />

      {/* Top accent line */}
      <div className="sidebar-accent-line" />

      {/* Close button — drawer mode (<lg) only */}
      <button
        type="button"
        onClick={onClose}
        className="lg:hidden absolute top-5 right-4 w-11 h-11 z-10 rounded-lg flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
        aria-label="Cerrar navegación"
      >
        <X className="w-5 h-5" />
      </button>

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

      <nav className="sidebar-nav" id="newsroom-navigation" aria-label="Navegación principal">
        {NAV_SECTIONS.map((section) => {
          const items = visibleItems(section.items);
          if (items.length === 0) return null;

          return (
            <section key={section.label} aria-label={section.label}>
              <div className="sidebar-nav-label">{section.label}</div>
              {items.map(({ to, icon: Icon, label }) => (
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
            </section>
          );
        })}

        <div className="sidebar-divider" />
        {user?.isPlatformAdmin && (
          <>
            <div className="sidebar-nav-label">Plataforma</div>
            <NavLink
              to="/admin"
              className={({ isActive }) => `sidebar-item ${isActive ? 'active' : ''}`}
              onClick={() => onClose()}
            >
              {({ isActive }) => (
                <>
                  <div className={`sidebar-item-indicator ${isActive ? 'visible' : ''}`} />
                  <div className={`sidebar-item-icon ${isActive ? 'active' : ''}`}>
                    <ShieldCheck className="w-[18px] h-[18px]" />
                  </div>
                  <span className="sidebar-item-label">Super Admin</span>
                  {isActive && <ChevronRight className="sidebar-item-chevron" />}
                </>
              )}
            </NavLink>
          </>
        )}

        <div className="sidebar-nav-label">Configuración</div>

        {NAV_SYSTEM.map(({ to, icon: Icon, label }) => (
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
        <button onClick={logout} className="sidebar-logout tap-target" aria-label="Cerrar sesión" title="Cerrar sesión">
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
