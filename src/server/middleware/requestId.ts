/**
 * requestId.ts — middleware de correlación por request (PI-02).
 *
 * - Adopta `X-Request-Id` entrante SÓLO si es seguro (1..128 chars de
 *   `[A-Za-z0-9._:-]`) — así un gateway o el cliente puede propagar su
 *   correlación. Un header sucio NO se propaga ni tira 400: se genera un
 *   request-id nuevo (no se rompe tráfico por un header malformado).
 * - Devuelve `X-Request-Id` en TODA respuesta (2xx/4xx/5xx alike).
 * - Corre el resto de la cadena dentro de `runWithRequestContext`: el
 *   logger inyecta `requestId` en cada línea emitida en el scope.
 * - En `res.on('finish')` emite UNA línea de acceso con method, path,
 *   status, durationMs, requestId y `tenantId` si está disponible.
 *
 * Tenant: este middleware corre ANTES de `optionalAuth`, así que `req.auth`
 * todavía no existe cuando arranca — se lee `req.auth?.tenantId` recién en
 * el `finish` (ya populateado por auth si la request llevaba credenciales).
 *
 * `path` se loguea SIN query string: la query puede llevar tokens y
 * NUNCA se loguea (misma regla que bodies/headers de autenticación).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { log } from '../lib/logger.js';
import { runWithRequestContext } from '../lib/requestContext.js';

/** Formato adoptable de un request-id entrante: 1..128 de [A-Za-z0-9._:-]. */
export const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function adoptableRequestId(req: Request): string | undefined {
  const raw = req.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

export const requestIdMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const requestId = adoptableRequestId(req) ?? uuidv4();
  res.setHeader('X-Request-Id', requestId);

  const startedAt = Date.now();
  res.on('finish', () => {
    const tenantId = req.auth?.tenantId;
    log.info('http.request', {
      method: req.method,
      path: (req.originalUrl ?? req.url).split('?')[0],
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      requestId,
      ...(tenantId ? { tenantId } : {}),
    });
  });

  runWithRequestContext({ requestId }, () => next());
};
