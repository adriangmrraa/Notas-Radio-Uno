// @vitest-environment jsdom
/**
 * PH-05 — componentes compartidos EmptyState / LoadingState / ErrorState.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EmptyState, LoadingState, ErrorState } from '../src/client/components/feedback';
import { ApiError, type AsyncError } from '../src/client/lib/errors';

afterEach(cleanup);

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('LoadingState', () => {
  it('renderiza spinner accesible por default', () => {
    wrap(<LoadingState />);
    const status = screen.getByRole('status');
    expect(status).toBeTruthy();
    expect(status.getAttribute('aria-busy')).toBe('true');
  });

  it('muestra el texto indicado', () => {
    wrap(<LoadingState text="Cargando cosas…" />);
    expect(screen.getByText('Cargando cosas…')).toBeTruthy();
  });

  it('con rows renderiza skeletons en lugar del spinner', () => {
    const { container } = wrap(<LoadingState rows={3} />);
    expect(container.querySelectorAll('.skeleton').length).toBe(3);
  });
});

describe('EmptyState', () => {
  it('renderiza título y descripción', () => {
    wrap(<EmptyState title="Sin items" description="Creá el primero" />);
    expect(screen.getByText('Sin items')).toBeTruthy();
    expect(screen.getByText('Creá el primero')).toBeTruthy();
  });

  it('action con `to` renderiza un Link', () => {
    wrap(<EmptyState title="Vacío" action={{ label: 'Ir', to: '/en-vivo' }} />);
    const link = screen.getByRole('link', { name: /Ir/ }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/en-vivo');
  });

  it('action con `onClick` renderiza un botón que dispara el handler', () => {
    const onClick = vi.fn();
    wrap(<EmptyState title="Vacío" action={{ label: 'Limpiar', onClick }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorState', () => {
  it('offline ⇒ copy de conexión', () => {
    wrap(<ErrorState error={{ kind: 'offline' }} />);
    expect(screen.getByText('Sin conexión')).toBeTruthy();
  });

  it('403 ⇒ copy de acceso denegado', () => {
    wrap(<ErrorState error={{ kind: 'forbidden', status: 403 }} />);
    expect(screen.getByText('No tenés acceso a esto')).toBeTruthy();
  });

  it('404 ⇒ copy de no encontrado', () => {
    wrap(<ErrorState error={{ kind: 'notFound', status: 404 }} />);
    expect(screen.getByText('No encontrado')).toBeTruthy();
  });

  it('5xx ⇒ copy de servidor', () => {
    wrap(<ErrorState error={{ kind: 'server', status: 500 }} />);
    expect(screen.getByText('El servidor tuvo un problema')).toBeTruthy();
  });

  it('generic ⇒ copy default', () => {
    wrap(<ErrorState error={{ kind: 'generic' }} />);
    expect(screen.getByText('No pudimos cargar esta sección')).toBeTruthy();
  });

  it('NUNCA renderiza el mensaje crudo del backend (debugMessage)', () => {
    const raw = 'SQL: relation "users" does not exist';
    wrap(<ErrorState error={{ kind: 'server', status: 500, debugMessage: raw }} />);
    expect(screen.queryByText(new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull();
    expect(screen.getByText('El servidor tuvo un problema')).toBeTruthy();
  });

  it('onRetry renderiza botón Reintentar que invoca el handler', () => {
    const onRetry = vi.fn();
    wrap(<ErrorState error={{ kind: 'generic' } as AsyncError} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('sin onRetry no muestra botón', () => {
    wrap(<ErrorState error={{ kind: 'generic' }} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('permite overrides de título/descripción', () => {
    wrap(<ErrorState error={{ kind: 'notFound' }} title="Transmisión no encontrada" description="Se cerró o nunca existió." />);
    expect(screen.getByText('Transmisión no encontrada')).toBeTruthy();
    expect(screen.getByText('Se cerró o nunca existió.')).toBeTruthy();
  });

  it('tiene role="alert"', () => {
    wrap(<ErrorState error={new ApiError('x', 500) as unknown as AsyncError} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
