/**
 * verify-quota-math.ts — Verificación de la matemática pura de cuota (Épica B).
 * Correr: npx tsx scripts/verify-quota-math.ts → imprime "quota-math OK".
 */
import assert from 'node:assert/strict';
import {
  computeRemaining,
  computePercentUsed,
  isWarning,
  computeProrationAmount,
} from '../src/server/lib/quotaMath.js';

// ── computeRemaining ──────────────────────────────────────────────────────────

// Caso: remaining 0 — todo consumido.
assert.equal(computeRemaining({ included: 20, addon: 5, extra: 0, used: 25 }), 0);
// Caso: over-used nunca da negativo.
assert.equal(computeRemaining({ included: 10, addon: 0, extra: 0, used: 99 }), 0);
// Caso: suma plan + addon + extra.
assert.equal(computeRemaining({ included: 20, addon: 15, extra: 3, used: 10 }), 28);
// Caso: ilimitado.
assert.equal(
  computeRemaining({ included: 0, addon: 0, extra: 0, used: 500, unlimited: true }),
  Number.MAX_SAFE_INTEGER,
);

// ── computePercentUsed ────────────────────────────────────────────────────────

assert.equal(computePercentUsed({ included: 20, addon: 0, extra: 0, used: 0 }), 0);
assert.equal(computePercentUsed({ included: 20, addon: 0, extra: 0, used: 10 }), 50);
// Tope en 100 aunque used supere el total.
assert.equal(computePercentUsed({ included: 10, addon: 0, extra: 0, used: 30 }), 100);
// Sin cupo total → 100 (bloqueo).
assert.equal(computePercentUsed({ included: 0, addon: 0, extra: 0, used: 0 }), 100);
// Ilimitado → 0 (nunca entra en warning).
assert.equal(computePercentUsed({ included: 0, addon: 0, extra: 0, used: 9999, unlimited: true }), 0);

// ── isWarning ─────────────────────────────────────────────────────────────────

// Caso: warning con uso > 80%.
assert.equal(isWarning(81), true);
assert.equal(isWarning(100), true);
// En el umbral exacto (80) NO avisa: el banner es ">80%".
assert.equal(isWarning(80), false);
assert.equal(isWarning(0), false);
// Umbral configurable.
assert.equal(isWarning(50, 40), true);

// ── computeProrationAmount ────────────────────────────────────────────────────

// Caso: prorrateo a mitad de ciclo → exactamente la mitad del precio.
{
  const start = new Date('2025-01-01T00:00:00Z');
  const end = new Date('2025-01-31T00:00:00Z');
  const mid = new Date('2025-01-16T00:00:00Z'); // 15d de 30 → 50%
  assert.equal(
    computeProrationAmount({ priceCents: 2900, periodStart: start, periodEnd: end, at: mid }),
    1450,
  );
}
// Al inicio del período → precio completo.
{
  const start = new Date('2025-01-01T00:00:00Z');
  const end = new Date('2025-01-31T00:00:00Z');
  assert.equal(
    computeProrationAmount({ priceCents: 2900, periodStart: start, periodEnd: end, at: start }),
    2900,
  );
}
// Al final del período → 0.
{
  const start = new Date('2025-01-01T00:00:00Z');
  const end = new Date('2025-01-31T00:00:00Z');
  assert.equal(
    computeProrationAmount({ priceCents: 2900, periodStart: start, periodEnd: end, at: end }),
    0,
  );
}
// Período degenerado o precio 0 → 0 (sin NaN ni negativos).
{
  const d = new Date('2025-01-01T00:00:00Z');
  assert.equal(computeProrationAmount({ priceCents: 2900, periodStart: d, periodEnd: d }), 0);
  assert.equal(computeProrationAmount({ priceCents: 0, periodStart: d, periodEnd: new Date('2025-02-01T00:00:00Z') }), 0);
}

console.log('quota-math OK');
