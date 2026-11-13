/**
 * seed-demo.ts — Siembra el dataset DEMO multi-tenant (PI-06).
 *
 * Uso:
 *   DEMO_SEED_PASSWORD='una-clave-demo' npx tsx scripts/seed-demo.ts
 *
 * Crea los tenants `demo-radio-norte` y `demo-canal-sur` con usuarios,
 * membresías (user_tenants), programas (sedes) y una transmisión demo por
 * tenant. IDEMPOTENTE: re-run sin duplicar (claves naturales +
 * pipelineConfig.demoKey). Requiere DATABASE_URL.
 *
 * La password de las cuentas demo NUEVAS se toma de DEMO_SEED_PASSWORD;
 * si no está seteada se genera una aleatoria irrecuperable (las cuentas
 * quedan inaccesibles hasta un reset — nunca se imprime ninguna clave).
 * Las cuentas ya existentes no se tocan.
 *
 * NO corre en producción salvo decisión explícita: es contenido de
 * demostración, no datos reales.
 */

import 'dotenv/config';
import { db, disconnectDb } from '../src/server/db/index.js';
import {
  createDrizzleDemoStore,
  seedDemoData,
} from '../src/server/services/demoDataService.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL no configurada. Nada que hacer.');
    process.exit(1);
  }
  if (!process.env.DEMO_SEED_PASSWORD) {
    console.warn(
      '[seed-demo] DEMO_SEED_PASSWORD no seteada: las cuentas demo nuevas ' +
        'quedan con password aleatoria irrecuperable.',
    );
  }

  const store = createDrizzleDemoStore(db);
  const summary = await seedDemoData(store, {
    demoPassword: process.env.DEMO_SEED_PASSWORD,
  });

  console.log('[seed-demo] OK');
  for (const [entity, r] of Object.entries(summary)) {
    console.log(
      `  ${entity}: insertados=${r.inserted.length} reusados=${r.reused.length}` +
        (r.inserted.length ? ` [${r.inserted.join(', ')}]` : ''),
    );
  }
}

main()
  .catch((err) => {
    console.error('[seed-demo] Error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
