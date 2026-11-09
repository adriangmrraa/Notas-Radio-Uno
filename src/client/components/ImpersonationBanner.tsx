import { useEffect, useState } from 'react';
import { Eye, LogOut } from 'lucide-react';

/**
 * ImpersonationBanner — banner persistente de "estás viendo como".
 *
 * La sesión de impersonación vive en sessionStorage (token + vencimiento) y el
 * accessToken impersonado reemplaza al del admin en localStorage. Al salir se
 * restaura el token del admin y se cierra la sesión en el backend (auditada).
 */

interface ImpersonationState {
  sessionId: string;
  expiresAt: string;
  tenantName: string;
  adminToken: string | null;
}

function readState(): ImpersonationState | null {
  try {
    const raw = sessionStorage.getItem('impersonation');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImpersonationState;
    if (!parsed.expiresAt || new Date(parsed.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem('impersonation');
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function ImpersonationBanner() {
  const [state, setState] = useState<ImpersonationState | null>(null);
  const [remaining, setRemaining] = useState('');
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    const current = readState();
    setState(current);
    if (!current) return;

    const tick = () => {
      const ms = new Date(current.expiresAt).getTime() - Date.now();
      if (ms <= 0) {
        sessionStorage.removeItem('impersonation');
        setState(null);
        return;
      }
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      setRemaining(`${minutes}:${String(seconds).padStart(2, '0')}`);
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, []);

  const exit = async () => {
    if (!state) return;
    setEnding(true);
    try {
      // Restaurar la sesión del admin ANTES de cerrar, para que el request vaya
      // firmado por el admin y no por el usuario impersonado.
      if (state.adminToken) {
        localStorage.setItem('accessToken', state.adminToken);
      } else {
        localStorage.removeItem('accessToken');
      }
      await fetch(`/api/admin/impersonation/${state.sessionId}/end`, {
        method: 'POST',
        credentials: 'include',
        headers: state.adminToken ? { Authorization: `Bearer ${state.adminToken}` } : {},
      });
    } catch {
      /* la sesión expira sola; no bloqueamos la salida */
    } finally {
      sessionStorage.removeItem('impersonation');
      window.location.href = '/admin/tenants';
    }
  };

  if (!state) return null;

  return (
    <div className="flex items-center justify-center gap-3 px-4 py-1.5 bg-purple-500/15 border-b border-purple-400/20 text-[12px] text-purple-200">
      <Eye className="w-3.5 h-3.5 shrink-0" />
      <span>
        Estás viendo <strong>{state.tenantName}</strong> como super admin — expira en {remaining}
      </span>
      <button
        onClick={exit}
        disabled={ending}
        className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/20 hover:bg-purple-500/30 disabled:opacity-50"
      >
        <LogOut className="w-3 h-3" />
        Salir
      </button>
    </div>
  );
}
