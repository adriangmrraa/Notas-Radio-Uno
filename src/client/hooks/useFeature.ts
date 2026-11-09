import { useEffect, useState } from 'react';

/**
 * useFeature — feature flags del tenant en el cliente.
 *
 * Un solo fetch por sesión de página (cache a nivel módulo + suscriptores) y
 * fallback a `false`: si el flag no llegó, la feature se oculta en vez de
 * romper la UI.
 */

export interface FeatureState {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  limitValue: number | null;
  source: 'plan' | 'override' | 'admin';
  planDefaultEnabled: boolean;
}

type FeatureMap = Record<string, FeatureState>;

const listeners = new Set<(map: FeatureMap) => void>();
let cache: FeatureMap | null = null;
let inFlight: Promise<FeatureMap> | null = null;

function loadFeatures(): Promise<FeatureMap> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;

  inFlight = fetch('/api/features', { credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const map = (await res.json()) as FeatureMap;
      cache = map;
      listeners.forEach((listener) => listener(map));
      return map;
    })
    .catch(() => ({}) as FeatureMap)
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Invalida el cache (después de que el admin cambia un flag, por ejemplo). */
export function invalidateFeatures(): void {
  cache = null;
}

export function useFeatures(): { features: FeatureMap; loading: boolean } {
  const [features, setFeatures] = useState<FeatureMap>(cache ?? {});
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    let mounted = true;
    listeners.add(setFeatures);
    loadFeatures().then((map) => {
      if (!mounted) return;
      setFeatures(map);
      setLoading(false);
    });
    return () => {
      mounted = false;
      listeners.delete(setFeatures);
    };
  }, []);

  return { features, loading };
}

/** Atajo para un flag puntual. */
export function useFeature(key: string): { enabled: boolean; loading: boolean } {
  const { features, loading } = useFeatures();
  return { enabled: features[key]?.enabled ?? false, loading };
}
