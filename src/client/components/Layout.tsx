import { useState, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { NotificationBell } from './NotificationBell';
import { useAuth } from '../contexts/AuthContext';
import { ArrowLeft, Menu, Moon, Sun } from 'lucide-react';
import { ImpersonationBanner } from './ImpersonationBanner';
import { Toaster } from './ui/toaster';

const PAGE_TITLES: Record<string, string> = {
  '/en-vivo': 'En vivo',
  '/assets': 'Bandeja de assets',
  '/dashboard': 'Dashboard',
  '/review': 'Revisión editorial',
  '/clips': 'Clips',
  '/programs': 'Programas',
  '/agenda': 'Agenda',
  '/publish': 'Publicación',
  '/persons': 'Personas',
  '/editorial': 'Línea editorial',
  '/editor': 'Pipeline Editor',
  '/connections': 'Conexiones',
  '/scheduled': 'Programados',
  '/analytics': 'Analytics',
  '/settings': 'Configuracion',
  '/billing': 'Billing',
};

const PAGE_DESCRIPTIONS: Record<string, string> = {
  '/en-vivo': 'Sala de monitoreo de la transmisión activa',
  '/dashboard': 'Centro de control de tu newsroom',
  '/review': 'Validá el contenido pendiente antes de publicar',
  '/clips': 'Editá y aprobá clips de la producción',
  '/programs': 'Organizá la programación del canal',
  '/agenda': 'Planificá la cobertura y los contenidos',
  '/publish': 'Seguimiento de trabajos listos para salir',
  '/persons': 'Biblioteca de personas del canal',
  '/editorial': 'Tono, reglas y formatos del canal y por programa',
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
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem('periodistapp-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const nextIsDark = storedTheme ? storedTheme === 'dark' : prefersDark;

    setIsDark(nextIsDark);
    document.documentElement.classList.toggle('dark', nextIsDark);
    document.documentElement.style.colorScheme = nextIsDark ? 'dark' : 'light';
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Drawer mode: Escape closes the sidebar overlay (touch + keyboard parity).
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen]);

  const toggleTheme = () => {
    const nextIsDark = !isDark;
    setIsDark(nextIsDark);
    window.localStorage.setItem('periodistapp-theme', nextIsDark ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', nextIsDark);
    document.documentElement.style.colorScheme = nextIsDark ? 'dark' : 'light';
  };

  const pageTitle = Object.entries(PAGE_TITLES).find(
    ([path]) => location.pathname.startsWith(path)
  )?.[1] || '';

  const pageDesc = Object.entries(PAGE_DESCRIPTIONS).find(
    ([path]) => location.pathname.startsWith(path)
  )?.[1] || '';

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-void relative">
      <ImpersonationBanner />
      <div className="flex-1 flex overflow-hidden relative">
      {/* Background ambient */}
      <div className="layout-ambient-1" />
      <div className="layout-ambient-2" />
      <div className="layout-ambient-3" />

      {/* Backdrop overlay — drawer mode (<lg) only, when sidebar is open */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 min-w-0 flex flex-col relative z-10">
        {/* Header */}
        <header className="layout-header">
          <div className="layout-header-left">
            {/* Hamburger — drawer mode (<lg) only */}
            <button
              type="button"
              className="lg:hidden w-11 h-11 flex items-center justify-center rounded-lg text-white/70 hover:text-white hover:bg-white/5"
              onClick={() => setSidebarOpen(true)}
              aria-label="Abrir navegación"
              aria-expanded={sidebarOpen}
              aria-controls="newsroom-navigation"
            >
              <Menu size={22} />
            </button>

            <div>
              <h1 className="layout-header-title">{pageTitle}</h1>
              <p className="layout-header-desc">{pageDesc}</p>
            </div>
          </div>

          <div className="layout-header-right">
            <button
              type="button"
              className="theme-toggle tap-target hidden sm:inline-flex"
              onClick={() => navigate(-1)}
              aria-label="Volver a la página anterior"
              title="Volver"
            >
              <ArrowLeft size={16} />
            </button>
            <button
              type="button"
              className="theme-toggle tap-target"
              onClick={toggleTheme}
              aria-label={isDark ? 'Activar tema claro' : 'Activar tema oscuro'}
              title={isDark ? 'Activar tema claro' : 'Activar tema oscuro'}
            >
              {isDark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
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
      <Toaster />
    </div>
  );
}
