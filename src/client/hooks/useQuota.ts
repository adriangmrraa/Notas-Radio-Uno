import { useCallback, useEffect, useState } from 'react';
import { useApi } from './useApi';
import type { QuotaInfo } from '../lib/billing';

/**
 * useQuota — Estado de transmisiones del ciclo vigente (GET /api/billing/quota).
 * `refresh()` vuelve a consultar (tras iniciar una transmisión o comprar add-ons).
 */
export function useQuota() {
  const { fetchApi } = useApi();
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchApi<QuotaInfo>('/billing/quota', { skipRedirect: true });
      setQuota(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando cuota');
    } finally {
      setLoading(false);
    }
  }, [fetchApi]);

  useEffect(() => { refresh(); }, [refresh]);

  return { quota, loading, error, refresh };
}
