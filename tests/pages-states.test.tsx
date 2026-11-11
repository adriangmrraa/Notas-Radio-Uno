// @vitest-environment jsdom
/**
 * PH-05 — integración a nivel página: `[]` ⇒ EmptyState, falla ⇒ ErrorState
 * sanitizado con retry, nunca pantalla en blanco ni errores crudos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../src/client/lib/errors';

const mockFetchApi = vi.fn<(path: string, opts?: unknown) => Promise<unknown>>();

vi.mock('../src/client/hooks/useApi', () => ({
  useApi: () => ({ fetchApi: mockFetchApi }),
  QuotaExceededError: class QuotaExceededError extends Error {},
}));

vi.mock('../src/client/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null }),
}));

import { AssetsInboxPage } from '../src/client/pages/AssetsInboxPage';
import { PublishJobsPage } from '../src/client/pages/PublishJobsPage';

function route(path: string, main: () => Promise<unknown>): Promise<unknown> {
  if (path.startsWith('/assets?')) return main();
  if (path === '/programs') return Promise.resolve({ programs: [] });
  if (path === '/transmissions') return Promise.resolve({ transmissions: [] });
  if (path === '/social-connections') return Promise.resolve({ connections: [] });
  if (path.startsWith('/publish-jobs')) return main();
  return Promise.reject(new Error(`unmocked ${path}`));
}

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  mockFetchApi.mockReset();
});

describe('AssetsInboxPage', () => {
  it('lista vacía ⇒ EmptyState con acción "Ir a En vivo"', async () => {
    mockFetchApi.mockImplementation((path) =>
      route(path, () => Promise.resolve({ assets: [], total: 0, page: 1, pageSize: 25 })),
    );
    wrap(<AssetsInboxPage />);

    await waitFor(() => screen.getByText('Todavía no hay materiales'));
    const link = screen.getByRole('link', { name: /Ir a En vivo/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/en-vivo');
  });

  it('falla de API ⇒ ErrorState sanitizado (nunca el mensaje crudo)', async () => {
    mockFetchApi.mockImplementation((path) =>
      route(path, () => Promise.reject(new ApiError('SQL: relation "assets" does not exist', 500))),
    );
    wrap(<AssetsInboxPage />);

    await waitFor(() => screen.getByText('El servidor tuvo un problema'));
    expect(screen.queryByText(/relation "assets"/)).toBeNull();
  });

  it('403 ⇒ ErrorState de acceso denegado', async () => {
    mockFetchApi.mockImplementation((path) =>
      route(path, () => Promise.reject(new ApiError('forbidden', 403))),
    );
    wrap(<AssetsInboxPage />);

    await waitFor(() => screen.getByText('No tenés acceso a esto'));
  });

  it('Reintentar re-ejecuta el fetch y muestra el resultado', async () => {
    let calls = 0;
    mockFetchApi.mockImplementation((path) => {
      if (path.startsWith('/assets?')) {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiError('down', 500))
          : Promise.resolve({ assets: [], total: 0, page: 1, pageSize: 25 });
      }
      return route(path, Promise.resolve({}));
    });
    wrap(<AssetsInboxPage />);

    await waitFor(() => screen.getByText('El servidor tuvo un problema'));
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    await waitFor(() => screen.getByText('Todavía no hay materiales'));
    expect(calls).toBe(2);
  });
});

describe('PublishJobsPage', () => {
  it('lista vacía ⇒ EmptyState "Sin jobs de publicación"', async () => {
    mockFetchApi.mockImplementation((path) =>
      route(path, () => Promise.resolve({ jobs: [], total: 0 })),
    );
    wrap(<PublishJobsPage />);

    await waitFor(() => screen.getByText('Sin jobs de publicación'));
    const link = screen.getByRole('link', { name: /Conectar cuentas/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/connections');
  });

  it('falla de API ⇒ ErrorState con retry, sin mensaje crudo', async () => {
    mockFetchApi.mockImplementation((path) =>
      route(path, () => Promise.reject(new ApiError('zernio internal stacktrace xyz', 500))),
    );
    wrap(<PublishJobsPage />);

    await waitFor(() => screen.getByText('El servidor tuvo un problema'));
    expect(screen.queryByText(/zernio internal/)).toBeNull();
    expect(screen.getByRole('button', { name: /Reintentar/ })).toBeTruthy();
  });
});
