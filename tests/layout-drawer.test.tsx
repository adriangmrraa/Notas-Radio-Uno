// @vitest-environment jsdom
/**
 * PH-07 — drawer de navegación en <lg: hamburger abre el overlay, el
 * backdrop / Escape / el botón de cierre lo cierran, y el breakpoint del
 * drawer es `lg` (no `md`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

const mockFetchApi = vi.fn<(path: string, opts?: unknown) => Promise<unknown>>();

vi.mock('../src/client/hooks/useApi', () => ({
  useApi: () => ({ fetchApi: mockFetchApi }),
}));

vi.mock('../src/client/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null }),
}));

vi.mock('../src/client/hooks/useFeature', () => ({
  useFeatures: () => ({ features: {}, loading: false }),
}));

vi.mock('../src/client/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { fullName: 'Test User', role: 'owner', tenant: { name: 'Tenant' } },
    logout: vi.fn(),
  }),
}));

import { Layout } from '../src/client/components/Layout';

const wrap = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  mockFetchApi.mockReset();
  mockFetchApi.mockResolvedValue({ notifications: [], unreadCount: 0 });
  // Sidebar hace fetch('/api/review?…') para el badge de pendientes.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ total: 0 }),
  }));
  // jsdom no implementa matchMedia (el Layout lo usa para el tema).
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sidebar = () => document.querySelector('aside.sidebar-root') as HTMLElement;

describe('Layout — drawer de navegación (<lg)', () => {
  it('el sidebar arranca cerrado (fuera de pantalla)', () => {
    wrap(<Layout />);
    expect(sidebar().className).toContain('-translate-x-full');
  });

  it('el breakpoint del drawer es lg: el sidebar vuelve al flujo en lg, no en md', () => {
    wrap(<Layout />);
    const aside = sidebar();
    expect(aside.className).toContain('lg:relative');
    expect(aside.className).toContain('lg:translate-x-0');
    expect(aside.className).not.toContain('md:relative');
    expect(screen.getByRole('button', { name: 'Abrir navegación' }).className).toContain('lg:hidden');
  });

  it('hamburger abre el drawer y muestra el backdrop', () => {
    const { container } = wrap(<Layout />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    expect(sidebar().className).toContain('translate-x-0');
    expect(sidebar().className).not.toContain('-translate-x-full');
    // Backdrop: overlay fijo con z-40, sólo en drawer mode.
    const backdrop = container.querySelector('.fixed.inset-0.z-40') as HTMLElement;
    expect(backdrop).toBeTruthy();
    expect(backdrop.className).toContain('lg:hidden');
  });

  it('click en el backdrop cierra el drawer', () => {
    const { container } = wrap(<Layout />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    const backdrop = container.querySelector('.fixed.inset-0.z-40') as HTMLElement;
    fireEvent.click(backdrop);
    expect(sidebar().className).toContain('-translate-x-full');
  });

  it('Escape cierra el drawer', () => {
    wrap(<Layout />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    expect(sidebar().className).toContain('translate-x-0');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(sidebar().className).toContain('-translate-x-full');
  });

  it('el botón de cierre interno cierra el drawer y tiene target ≥44px', () => {
    wrap(<Layout />);
    fireEvent.click(screen.getByRole('button', { name: 'Abrir navegación' }));
    const close = screen.getByRole('button', { name: 'Cerrar navegación' });
    expect(close.className).toContain('lg:hidden');
    expect(close.className).toContain('w-11');
    expect(close.className).toContain('h-11');
    fireEvent.click(close);
    expect(sidebar().className).toContain('-translate-x-full');
  });

  it('el hamburger mide ≥44px (w-11 h-11)', () => {
    wrap(<Layout />);
    const hamburger = screen.getByRole('button', { name: 'Abrir navegación' });
    expect(hamburger.className).toContain('w-11');
    expect(hamburger.className).toContain('h-11');
    expect(hamburger.getAttribute('aria-controls')).toBe('newsroom-navigation');
  });
});
