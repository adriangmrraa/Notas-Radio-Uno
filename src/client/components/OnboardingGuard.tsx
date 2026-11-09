/**
 * OnboardingGuard — redirección del wizard de onboarding (PC-10).
 *
 * Envuelve las rutas privadas con Layout (no toca /login, /register,
 * /forgot-password, /accept-invite ni la consola /admin):
 *   - tenant SIN onboarding_completed → toda página privada redirige a /onboarding
 *   - tenant CON onboarding_completed → /onboarding redirige a /dashboard
 *
 * Excepciones (no se fuerza onboarding):
 *   - sesiones sin tenant activo (platform admin en consola)
 *   - rol viewer: no puede ejecutar los POST del wizard (viewerWriteGuard),
 *     redirigirlo sería un callejón sin salida — entra en solo-lectura.
 *
 * Si el fetch de status falla, fail-open: deja pasar (no bloquea la app).
 * Expone `useOnboarding().refresh()` para que OnboardingPage re-evalue el
 * guard apenas marca completed (si no, el estado cacheado la rebotaría).
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../contexts/AuthContext';

interface OnboardingContextValue {
  /** Re-fetchea /api/onboarding/status y actualiza el guard. */
  refresh: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingContextValue>({ refresh: async () => {} });

export function useOnboarding(): OnboardingContextValue {
  return useContext(OnboardingContext);
}

type GuardState = 'loading' | 'pending' | 'completed' | 'error';

export function OnboardingGuard({ children }: { children: ReactNode }) {
  const { fetchApi } = useApi();
  const { user } = useAuth();
  const location = useLocation();
  const [state, setState] = useState<GuardState>('loading');

  // Sin tenant (platform admin) o rol de solo-lectura: no se fuerza el wizard.
  const exempt = !user?.tenantId || user.role === 'viewer';

  const refresh = useCallback(async () => {
    try {
      const status = await fetchApi<{ completed: boolean }>('/onboarding/status', { skipRedirect: true });
      setState(status?.completed ? 'completed' : 'pending');
    } catch {
      setState('error');
    }
  }, [fetchApi]);

  useEffect(() => {
    if (!exempt) void refresh();
  }, [exempt, refresh]);

  if (exempt) {
    return <OnboardingContext.Provider value={{ refresh }}>{children}</OnboardingContext.Provider>;
  }

  if (state === 'loading') {
    return (
      <div className="h-screen flex items-center justify-center bg-void">
        <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (state !== 'error') {
    const onOnboarding = location.pathname.startsWith('/onboarding');
    if (state === 'pending' && !onOnboarding) {
      return <Navigate to="/onboarding" replace />;
    }
    if (state === 'completed' && onOnboarding) {
      return <Navigate to="/dashboard" replace />;
    }
  }

  return <OnboardingContext.Provider value={{ refresh }}>{children}</OnboardingContext.Provider>;
}
