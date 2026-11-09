/**
 * quotaMath.ts — Matemática pura de cuota y prorrateo (Épica B).
 *
 * Sin DB, sin IO: funciones testeables que el metering y el billing reusan.
 */

/** Transmisiones restantes del ciclo. `unlimited` cortocircuita a MAX_SAFE_INTEGER. */
export function computeRemaining(input: {
  included: number;
  addon: number;
  extra: number;
  used: number;
  unlimited?: boolean;
}): number {
  if (input.unlimited) return Number.MAX_SAFE_INTEGER;
  const total = input.included + input.addon + input.extra;
  return Math.max(0, total - input.used);
}

/** % de cuota consumida (0-100, entero). Ilimitado → 0. Sin cupo total → 100. */
export function computePercentUsed(input: {
  included: number;
  addon: number;
  extra: number;
  used: number;
  unlimited?: boolean;
}): number {
  if (input.unlimited) return 0;
  const total = input.included + input.addon + input.extra;
  if (total <= 0) return 100;
  return Math.min(100, Math.round((input.used / total) * 100));
}

/** Aviso de cuota: >80% consumido (el paywall/banner se muestra acá). */
export function isWarning(percentUsed: number, threshold = 80): boolean {
  return percentUsed > threshold;
}

/**
 * Prorrateo de cambio de plan a mitad de ciclo (o cualquier punto):
 * cuánto se cobra/acredita por los días restantes del período al precio nuevo.
 * Devuelve centavos redondeados: `remaining/total * priceCents`.
 */
export function computeProrationAmount(input: {
  priceCents: number;
  periodStart: Date;
  periodEnd: Date;
  at?: Date;
}): number {
  const at = (input.at ?? new Date()).getTime();
  const start = input.periodStart.getTime();
  const end = input.periodEnd.getTime();
  if (end <= start || input.priceCents <= 0) return 0;
  const clampedAt = Math.min(Math.max(at, start), end);
  const remainingMs = end - clampedAt;
  const totalMs = end - start;
  return Math.round((remainingMs / totalMs) * input.priceCents);
}
