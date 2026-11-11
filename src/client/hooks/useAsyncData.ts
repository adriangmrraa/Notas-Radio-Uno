import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type SetStateAction } from 'react';
import { classifyError, type AsyncError } from '../lib/errors';

export interface AsyncData<T> {
  /** `null` hasta que el loader resuelve por primera vez (o si falló). */
  data: T | null;
  loading: boolean;
  /** Error del último load, clasificado por categoría (ver `classifyError`). */
  error: AsyncError | null;
  /** Vuelve a ejecutar el loader — es el "Reintentar" de `ErrorState`. */
  reload: () => Promise<void>;
  /** Permite mutaciones locales (editar/borrar items sin refetch). */
  setData: Dispatch<SetStateAction<T | null>>;
}

/**
 * useAsyncData — estado async compartido para vistas de datos (PH-05).
 *
 * Devuelve `{ data, loading, error, reload }`. El `error` es el del endpoint
 * que falló (cada llamada al hook es independiente: un error parcial de una
 * vista con varios loaders no contamina el resto).
 *
 * El primer load se difiere con `Promise.resolve().then()`: setear `loading`
 * de forma sincrónica dentro del `useEffect` viola la regla
 * `react-hooks/set-state-in-effect` que usa este repo.
 */
export function useAsyncData<T>(loader: () => Promise<T>, deps: DependencyList = []): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AsyncError | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loaderRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(classifyError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps las define el caller
  }, deps);

  return { data, loading, error, reload: load, setData };
}
