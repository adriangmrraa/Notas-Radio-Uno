/**
 * PH-05 — ApiError + classifyError.
 *
 * `ApiError` conserva el status HTTP que el backend respondió;
 * `classifyError` traduce excepciones a categorías de UI estables.
 * El mensaje crudo del backend va a `debugMessage` (nunca a la UI).
 */
import { describe, expect, it } from 'vitest';
import { ApiError, classifyError } from '../src/client/lib/errors';

describe('ApiError', () => {
  it('conserva message y status', () => {
    const err = new ApiError('Ese slug ya está en uso', 409);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.message).toBe('Ese slug ya está en uso');
    expect(err.status).toBe(409);
  });
});

describe('classifyError', () => {
  it('403 ⇒ forbidden', () => {
    expect(classifyError(new ApiError('sin permiso', 403)).kind).toBe('forbidden');
  });

  it('404 ⇒ notFound', () => {
    expect(classifyError(new ApiError('no existe', 404)).kind).toBe('notFound');
  });

  it('5xx ⇒ server', () => {
    expect(classifyError(new ApiError('boom', 500)).kind).toBe('server');
    expect(classifyError(new ApiError('bad gateway', 502)).kind).toBe('server');
    expect(classifyError(new ApiError('unavailable', 503)).kind).toBe('server');
  });

  it('TypeError de fetch (red caída) ⇒ offline', () => {
    expect(classifyError(new TypeError('Failed to fetch')).kind).toBe('offline');
  });

  it('navigator.onLine === false ⇒ offline', () => {
    const prev = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
    });
    try {
      expect(classifyError(new ApiError('cualquier cosa', 400)).kind).toBe('offline');
    } finally {
      if (prev) Object.defineProperty(globalThis.navigator, 'onLine', prev);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it('otros errores ⇒ generic', () => {
    expect(classifyError(new ApiError('conflict', 409)).kind).toBe('generic');
    expect(classifyError(new Error('random')).kind).toBe('generic');
    expect(classifyError('string error').kind).toBe('generic');
  });

  it('prioridad: status conocido gana aunque el error también sea offline-ish', () => {
    // Un ApiError 403 con navigator offline sigue siendo 'forbidden'
    // (el status es más específico que la condición de red).
    const prev = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, 'onLine');
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true,
    });
    try {
      expect(classifyError(new ApiError('sin permiso', 403)).kind).toBe('forbidden');
    } finally {
      if (prev) Object.defineProperty(globalThis.navigator, 'onLine', prev);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it('el mensaje crudo del backend queda en debugMessage, nunca en kind', () => {
    const err = classifyError(new ApiError('SQL: relation "users" does not exist', 500));
    expect(err.kind).toBe('server');
    expect(err.status).toBe(500);
    expect(err.debugMessage).toBe('SQL: relation "users" does not exist');
  });
});
