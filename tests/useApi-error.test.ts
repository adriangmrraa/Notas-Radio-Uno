/**
 * Tests del repair W3: `parseErrorMessage` debe conservar el mensaje de
 * error que manda el backend en lugar de degradarlo a "HTTP <status>".
 *
 * Antes, el `throw` dentro del `try` lo capturaba el propio `catch` y el
 * usuario veía "HTTP 409" en vez de "Ese slug ya está en uso".
 */
import { describe, expect, it } from 'vitest';
import { parseErrorMessage } from '../src/client/hooks/useApi';

describe('parseErrorMessage', () => {
  it('body {error} ⇒ devuelve el mensaje del backend (caso W3)', () => {
    const text = JSON.stringify({ error: 'Ese slug ya está en uso por otra organización' });
    expect(parseErrorMessage(text, 409)).toBe('Ese slug ya está en uso por otra organización');
  });

  it('fallbacks del backend: {message} y {detail}', () => {
    expect(parseErrorMessage(JSON.stringify({ message: 'm custom' }), 400)).toBe('m custom');
    expect(parseErrorMessage(JSON.stringify({ detail: 'd custom' }), 400)).toBe('d custom');
  });

  it('body no-JSON ⇒ "HTTP <status>"', () => {
    expect(parseErrorMessage('<html>Bad Gateway</html>', 502)).toBe('HTTP 502');
    expect(parseErrorMessage('no json', 500)).toBe('HTTP 500');
    expect(parseErrorMessage('', 404)).toBe('HTTP 404');
  });

  it('JSON válido pero sin mensaje ⇒ "HTTP <status>"', () => {
    expect(parseErrorMessage('{}', 400)).toBe('HTTP 400');
    expect(parseErrorMessage('{"error":""}', 400)).toBe('HTTP 400');
    expect(parseErrorMessage('[1,2]', 400)).toBe('HTTP 400');
  });
});
