/**
 * processRole — separación de roles de proceso (Épica J / PJ-04).
 *
 * `PROCESS_ROLE` decide qué arranca este proceso:
 *   - 'all'    (default): API + workers/schedulers — despliegue monolítico.
 *   - 'api':   sólo HTTP + Socket.IO — ningún worker ni scheduler corre.
 *   - 'worker': sólo workers/schedulers (la API igualmente se monta hoy —
 *              ver limitación documentada en index.ts).
 *
 * Un valor desconocido cae a 'all' (fail-open para no dejar un proceso sin
 * workers por un typo): el caller loguea el warning.
 */
export type ProcessRole = 'api' | 'worker' | 'all';

export const PROCESS_ROLES: readonly ProcessRole[] = ['api', 'worker', 'all'];

export function parseProcessRole(raw: string | undefined | null): ProcessRole {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'api' || value === 'worker' || value === 'all') return value;
  return 'all';
}

/** ¿Este proceso debe levantar workers y schedulers? */
export function isWorkerRole(role: ProcessRole): boolean {
  return role !== 'api';
}
