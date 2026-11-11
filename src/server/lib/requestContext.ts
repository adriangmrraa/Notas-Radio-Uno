/**
 * requestContext.ts — contexto asíncrono por request (PI-02).
 *
 * AsyncLocalStorage de `node:async_hooks`: el middleware de request-id abre
 * un scope por petición (`runWithRequestContext`) y TODO lo que corra dentro
 * — handlers, awaits y listeners `res.on('finish')` registrados en el scope —
 * ve el mismo contexto. El logger lo lee en cada emisión, así las líneas
 * llevan `requestId`/`tenantId`/`transmissionId` sin pasarlos a mano por
 * call-site.
 *
 * Semántica de anidado: el scope interno hereda las claves del externo y
 * gana donde se solapan; al salir, el externo vuelve intacto (ALS lo
 * restaura y el merge va sobre un objeto NUEVO — un `setRequestContext`
 * interno no se filtra al padre).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Contexto visible para el logger: sólo las claves definidas se propagan. */
export interface RequestContext {
  requestId?: string;
  tenantId?: string;
  transmissionId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Contexto del scope actual, o undefined fuera de un scope de request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Ejecuta `fn` con `ctx` como contexto activo. Si ya hay uno, el nuevo lo
 * hereda y pisa las claves que se solapan; el externo se restaura al salir.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  const parent = storage.getStore();
  return storage.run(parent ? { ...parent, ...ctx } : { ...ctx }, fn);
}

/**
 * Fusiona `patch` en el contexto del scope actual. No-op fuera de scope
 * (p.ej. código que corre sin el middleware de request-id). Muta la copia
 * del scope — nunca el objeto del padre.
 */
export function setRequestContext(patch: RequestContext): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}
