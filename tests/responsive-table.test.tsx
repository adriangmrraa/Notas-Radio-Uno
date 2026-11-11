// @vitest-environment jsdom
/**
 * PH-07 — primitive compartido ResponsiveTable: scroll horizontal contenido.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResponsiveTable } from '../src/client/components/ResponsiveTable';

afterEach(cleanup);

describe('ResponsiveTable', () => {
  it('renderiza la tabla hija dentro del contenedor', () => {
    render(
      <ResponsiveTable label="Tabla de prueba">
        <table>
          <tbody>
            <tr><td>celda</td></tr>
          </tbody>
        </table>
      </ResponsiveTable>,
    );
    expect(screen.getByText('celda')).toBeTruthy();
  });

  it('el contenedor es una región nombrada y scrolleable', () => {
    render(
      <ResponsiveTable label="Tabla de personas">
        <table />
      </ResponsiveTable>,
    );
    const region = screen.getByRole('region', { name: 'Tabla de personas' });
    expect(region.className).toContain('overflow-x-auto');
    expect(region.getAttribute('tabindex')).toBe('0');
  });

  it('no fija posición ni ancho: el scroll queda contenido en el wrapper', () => {
    const { container } = render(
      <ResponsiveTable label="r">
        <table />
      </ResponsiveTable>,
    );
    const region = container.firstElementChild as HTMLElement;
    // El wrapper es el único nodo: nada escapa al body.
    expect(region).toBeTruthy();
    expect(region.tagName).toBe('DIV');
    expect(container.children.length).toBe(1);
  });

  it('acepta className adicional preservando overflow-x-auto', () => {
    render(
      <ResponsiveTable label="r" className="rounded-xl">
        <table />
      </ResponsiveTable>,
    );
    const region = screen.getByRole('region', { name: 'r' });
    expect(region.className).toContain('overflow-x-auto');
    expect(region.className).toContain('rounded-xl');
  });
});
