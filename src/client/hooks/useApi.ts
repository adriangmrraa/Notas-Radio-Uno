import { useCallback } from 'react';
import { QuotaExceededError, type QuotaInfo, type QuotaUpsell } from '../lib/billing';
import { ApiError } from '../lib/errors';

interface FetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  skipRedirect?: boolean;
}

/**
 * Extrae el mensaje de error del body de una respuesta no-OK.
 * Pura y exportada para poder testearla: el backend manda
 * `{ error }` (o `message`/`detail`); si el body no es JSON o no
 * trae mensaje, se queda `HTTP <status>`.
 */
export function parseErrorMessage(text: string, status: number): string {
  const fallback = `HTTP ${status}`;
  try {
    const json = JSON.parse(text);
    return json.error || json.message || json.detail || fallback;
  } catch {
    return fallback;
  }
}

export function useApi() {
  const fetchApi = useCallback(async <T = unknown>(endpoint: string, options: FetchOptions = {}): Promise<T> => {
    const isFormData = options.body instanceof FormData;
    const headers: Record<string, string> = {
      ...options.headers,
    };

    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }

    // El token explícito (impersonación o sesión recién creada) manda sobre la cookie.
    const bearer = typeof localStorage !== 'undefined' ? localStorage.getItem('accessToken') : null;
    if (bearer && !headers.Authorization) {
      headers.Authorization = `Bearer ${bearer}`;
    }

    const url = endpoint.startsWith('http') ? endpoint : `/api${endpoint}`;

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: isFormData
        ? (options.body as FormData)
        : options.body
          ? JSON.stringify(options.body)
          : undefined,
      credentials: 'include',
    });

    if (response.status === 402) {
      // Leer el código para distinguir cuota agotada de suscripción inactiva:
      // QUOTA_EXCEEDED NO redirige — el caller decide (UpgradeModal); el resto
      // de los 402 mantiene el comportamiento anterior (redirect a /billing).
      let payload: { error?: string; code?: string; quota?: QuotaInfo; upsell?: QuotaUpsell } = {};
      try { payload = await response.json(); } catch { /* body no-JSON */ }

      if (payload.code === 'QUOTA_EXCEEDED') {
        throw new QuotaExceededError(payload.error || 'Sin transmisiones disponibles', payload.quota, payload.upsell);
      }

      if (!options.skipRedirect && !window.location.pathname.startsWith('/billing')) {
        window.location.href = '/billing';
      }
      throw new ApiError(payload.error || 'Suscripción requerida', 402);
    }

    if (response.status === 401) {
      if (!options.skipRedirect && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      throw new ApiError('No autenticado', 401);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(parseErrorMessage(text, response.status), response.status);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return (await response.json()) as T;
    }
    return (await response.text()) as unknown as T;
  }, []);

  return { fetchApi };
}
