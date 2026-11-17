/**
 * envInt — parseo de env vars enteras con default (Épica J / PJ-04).
 *
 * Regla: valor ausente, vacío, no-numérico o <= 0 → `defaultValue`.
 * Los workers/schedulers lo usan para sus caps de concurrencia; un valor
 * roto NUNCA debe dejar el cap en NaN/0 (0 apagaría el worker de facto).
 */
export function envInt(name: string, defaultValue: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultValue;
}
