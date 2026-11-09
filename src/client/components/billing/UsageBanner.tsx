import { Link } from 'react-router-dom';
import { AlertTriangle, Zap } from 'lucide-react';
import { useQuota } from '../../hooks/useQuota';

const WARN_THRESHOLD = 80;

/**
 * UsageBanner — aviso de cuota de transmisiones dentro del pipeline.
 * Aparece al superar el 80% del ciclo; en rojo cuando no queda nada.
 * Nunca se muestra en planes ilimitados ni si la cuota no pudo cargarse.
 */
export function UsageBanner() {
  const { quota, loading } = useQuota();

  if (loading || !quota || quota.unlimited) return null;

  const total = quota.included + quota.addon + quota.extra;
  const exhausted = quota.remaining <= 0;
  const warning = !exhausted && quota.percentUsed >= WARN_THRESHOLD;
  if (!exhausted && !warning) return null;

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border text-[13px] ${
        exhausted
          ? 'bg-red-500/10 border-red-500/25 text-red-300'
          : 'bg-amber-500/10 border-amber-500/25 text-amber-300'
      }`}
      role="status"
    >
      {exhausted ? <Zap size={15} className="shrink-0" /> : <AlertTriangle size={15} className="shrink-0" />}
      <span className="flex-1">
        {exhausted ? (
          <>
            Usaste las <strong>{total}</strong> transmisiones del ciclo.
          </>
        ) : (
          <>
            Te quedan <strong>{quota.remaining}</strong> de <strong>{total}</strong> transmisiones ({quota.percentUsed}% usado).
          </>
        )}
      </span>
      <Link
        to="/billing"
        className={`shrink-0 px-2.5 py-1 rounded-lg text-[12px] font-medium transition-colors ${
          exhausted
            ? 'bg-red-500/20 hover:bg-red-500/30 text-red-200'
            : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-200'
        }`}
      >
        {exhausted ? 'Comprar más' : 'Ver uso'}
      </Link>
    </div>
  );
}
