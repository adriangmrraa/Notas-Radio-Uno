import { useNavigate } from 'react-router-dom';
import { Zap, TrendingUp, X } from 'lucide-react';
import type { QuotaInfo, QuotaUpsell } from '../../lib/billing';

/**
 * UpgradeModal — Paywall cuando el ciclo se quedó sin transmisiones.
 * Se abre desde el 402 QUOTA_EXCEEDED del pipeline start (no hay redirect ciego:
 * el usuario ve cuánto usó y decide el siguiente paso).
 */
export function UpgradeModal({ quota, upsell, onClose }: {
  quota: QuotaInfo | null;
  upsell?: QuotaUpsell | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const total = quota ? quota.included + quota.addon + quota.extra : 0;

  const go = (path: string) => {
    onClose();
    navigate(path);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <button className="modal-close" onClick={onClose} aria-label="Cerrar">
          <X size={16} />
        </button>

        <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={18} className="text-amber-400" />
          Sin transmisiones disponibles
        </h3>

        <div className="modal-text" style={{ marginTop: 8 }}>
          {quota ? (
            <>
              <p>
                Usaste <strong>{quota.used}</strong> de <strong>{total}</strong> transmisiones
                de este ciclo{quota.periodEnd ? ` (renueva el ${new Date(`${quota.periodEnd}T00:00:00`).toLocaleDateString()})` : ''}.
              </p>
              <div className="mt-3 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                <div className="h-full rounded-full bg-amber-400" style={{ width: `${Math.min(100, quota.percentUsed)}%` }} />
              </div>
            </>
          ) : (
            <p>Tu plan no tiene transmisiones disponibles en este ciclo.</p>
          )}
          <p className="mt-3 text-white/60" style={{ fontSize: 13 }}>
            Podés comprar transmisiones sueltas o pasar a un plan con más cupo.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          {(upsell?.canBuyAddons ?? true) && (
            <button className="btn btn-primary" onClick={() => go('/billing#addons')}>
              <Zap size={14} /> Comprar transmisiones
            </button>
          )}
          {(upsell?.canUpgrade ?? true) && (
            <button className="btn btn-secondary" onClick={() => go('/billing#planes')}>
              <TrendingUp size={14} /> Ver planes
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
