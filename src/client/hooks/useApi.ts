import { useCallback } from 'react';

interface FetchOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  skipRedirect?: boolean;
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
      if (!options.skipRedirect && !window.location.pathname.startsWith('/billing')) {
        window.location.href = '/billing';
      }
      throw new Error('Suscripción requerida');
    }

    if (response.status === 401) {
      if (!options.skipRedirect && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
      throw new Error('No autenticado');
    }

    if (!response.ok) {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        throw new Error(json.error || json.message || json.detail || `HTTP ${response.status}`);
      } catch {
        throw new Error(`HTTP ${response.status}`);
      }
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return (await response.json()) as T;
    }
    return (await response.text()) as unknown as T;
  }, []);

  return { fetchApi };
}
