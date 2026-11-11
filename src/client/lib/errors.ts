/**
 * errors.ts — clasificación de errores de API/red para la capa de
 * presentación (PH-05).
 *
 * `ApiError` conserva el status HTTP que `useApi` parsea del body;
 * `classifyError` lo traduce a categorías mostrables. El mensaje crudo del
 * backend queda en `debugMessage` (logging) y NUNCA se renderiza.
 */

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export type AsyncErrorKind = 'offline' | 'forbidden' | 'notFound' | 'server' | 'generic';

export interface AsyncError {
  kind: AsyncErrorKind;
  status?: number;
  /** Mensaje original, solo para debugging. No mostrar al usuario. */
  debugMessage?: string;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function debugOf(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

/**
 * Traduce la excepción de un loader a una categoría de error:
 * - `TypeError` de fetch o `navigator.onLine === false` ⇒ 'offline'
 * - status 403 ⇒ 'forbidden'
 * - status 404 ⇒ 'notFound'
 * - status 5xx ⇒ 'server'
 * - resto ⇒ 'generic'
 */
export function classifyError(error: unknown): AsyncError {
  const status = statusOf(error);
  const offline =
    error instanceof TypeError ||
    (typeof navigator !== 'undefined' && navigator.onLine === false);
  const kind: AsyncErrorKind =
    status === 403 ? 'forbidden'
    : status === 404 ? 'notFound'
    : status !== undefined && status >= 500 ? 'server'
    : offline ? 'offline'
    : 'generic';
  return { kind, status, debugMessage: debugOf(error) };
}
