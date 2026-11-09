/**
 * seed-plans.ts — Siembra el catálogo de planes (Épica B).
 *
 * Uso:
 *   npx tsx scripts/seed-plans.ts
 *
 * Idempotente: inserta los planes faltantes y sólo completa columnas NULL de
 * los existentes. Requiere DATABASE_URL.
 */

import 'dotenv/config';
import { db, disconnectDb } from '../src/server/db/index.js';
import { seedPlans } from '../src/server/services/planService.js';
import { seedAddons } from '../src/server/services/addonService.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL no configurada. Nada que hacer.');
    process.exit(1);
  }

  const result = await seedPlans();
  console.log(`[seed-plans] OK — insertados: ${result.inserted.length}, completados: ${result.updated.length}`);

  const addons = await seedAddons();
  console.log(`[seed-plans] Add-ons — insertados: ${addons.inserted.length}`);

  const { plans } = await import('../src/server/db/schema/index.js');
  const { asc } = await import('drizzle-orm');
  const all = await db.select({ name: plans.name, displayName: plans.displayName, isActive: plans.isActive }).from(plans).orderBy(asc(plans.sortOrder));
  for (const p of all) {
    console.log(`  ${p.isActive ? '✓' : '·'} ${p.name} (${p.displayName})`);
  }
}

main()
  .catch((err) => {
    console.error('[seed-plans] Error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
