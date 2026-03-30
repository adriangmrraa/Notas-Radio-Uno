import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationBell } from './NotificationBell';
import { useAuth } from '../contexts/AuthContext';
import { Search } from 'lucide-react';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/editor': 'Pipeline Editor',
  '/connections': 'Conexiones',
  '/scheduled': 'Programados',
  '/analytics': 'Analytics',
  '/settings': 'Configuracion',
  '/billing': 'Billing',
};

const PAGE_DESCRIPTIONS: Record<string, string> = {
  '/dashboard': 'Centro de control de tu newsroom',
  '/editor': 'Disena el flujo de tu pipeline',
  '/connections': 'Gestiona tus plataformas',
  '/scheduled': 'Automatiza tus capturas',
  '/analytics': 'Metricas y rendimiento',
  '/settings': 'Ajustes de tu organizacion',
  '/billing': 'Suscripcion y pagos',
};

export function Layout() {
  const { user } = useAuth();
  const location = useLocation();

  const pageTitle = Object.entries(PAGE_TITLES).find(
    ([path]) => location.pathname.startsWith(path)
  )?.[1] || '';

  const pageDesc = Object.entries(PAGE_DESCRIPTIONS).find(
    ([path]) => location.pathname.startsWith(path)
  )?.[1] || '';

  return (
    <div className="h-screen overflow-hidden flex bg-void relative">
      {/* Background ambient */}
      <div className="layout-ambient-1" />
      <div className="layout-ambient-2" />
      <div className="layout-ambient-3" />

      <Sidebar />

      <div className="flex-1 min-w-0 flex flex-col relative z-10">
        {/* Header */}
        <header className="layout-header">
          <div className="layout-header-left">
            <div>
              <h1 className="layout-header-title">{pageTitle}</h1>
              <p className="layout-header-desc">{pageDesc}</p>
            </div>
          </div>

          <div className="layout-header-right">
            <NotificationBell />
            <div className="layout-header-divider" />
            <div className="layout-header-user">
              <div className="layout-header-avatar">
                {user?.fullName?.charAt(0)?.toUpperCase() || 'U'}
              </div>
              <div className="layout-header-user-info">
                <span className="layout-header-user-name">{user?.fullName || 'Usuario'}</span>
                <span className="layout-header-user-role">{user?.role || 'owner'}</span>
              </div>
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 min-h-0 overflow-y-auto layout-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
