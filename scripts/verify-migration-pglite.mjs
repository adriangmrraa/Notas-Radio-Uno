/**
 * verify-migration-pglite.mjs — Verificación de migraciones sobre PGlite en
 * memoria (Épica B, gate 3).
 *
 *   - Levanta @electric-sql/pglite en memoria.
 *   - Aplica en orden TODOS los drizzle/*.sql.
 *   - Aplica 0005 DOS VECES (prueba de idempotencia).
 *   - Imprime OK + tablas nuevas y columnas nuevas de plans/subscriptions.
 *
 * Correr: node scripts/verify-migration-pglite.mjs → EXIT 0.
 */
import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const drizzleDir = join(root, 'drizzle');

const files = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
if (files.length === 0) {
  console.error('No se encontraron migraciones en drizzle/');
  process.exit(1);
}

const db = new PGlite();

const apply = async (file) => {
  const sql = readFileSync(join(drizzleDir, file), 'utf8');
  // Las migraciones de drizzle-kit usan `--> statement-breakpoint` como
  // separador; PGlite exec sólo acepta un statement por llamada.
  const statements = sql
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.exec(stmt);
  }
};

// 1) Todas las migraciones en orden.
for (const file of files) {
  await apply(file);
  console.log(`applied ${file}`);
}

// 2) Idempotencia: la 0005 se aplica dos veces y no debe fallar.
const epicB = files.find((f) => f.includes('0005'));
if (!epicB) {
  console.error('No se encontró la migración 0005 de Épica B');
  process.exit(1);
}
await apply(epicB);
console.log(`re-applied ${epicB} (idempotente)`);

// 3) Tablas nuevas de Épica B.
const { rows: tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('usage_cycles','quota_operations','plan_addons','addon_purchases','billing_events')
  ORDER BY tablename
`);
const tableNames = tables.map((r) => r.tablename);
const expectedTables = ['addon_purchases', 'billing_events', 'plan_addons', 'quota_operations', 'usage_cycles'];
const missingTables = expectedTables.filter((t) => !tableNames.includes(t));
if (missingTables.length > 0) {
  console.error(`Faltan tablas: ${missingTables.join(', ')}`);
  process.exit(1);
}

// 4) Columnas nuevas en plans y subscriptions.
const { rows: cols } = await db.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'plans' AND column_name IN ('transmissions_per_cycle','max_transmission_minutes','max_clips_per_transmission','max_people','raw_retention_days'))
      OR (table_name = 'subscriptions' AND column_name IN ('past_due_since','grace_ends_at','dunning_attempts','last_dunning_at','suspended_at','trial_transmissions_included')))
  ORDER BY table_name, column_name
`);
const expectedCols = [
  'plans.transmissions_per_cycle',
  'plans.max_transmission_minutes',
  'plans.max_clips_per_transmission',
  'plans.max_people',
  'plans.raw_retention_days',
  'subscriptions.past_due_since',
  'subscriptions.grace_ends_at',
  'subscriptions.dunning_attempts',
  'subscriptions.last_dunning_at',
  'subscriptions.suspended_at',
  'subscriptions.trial_transmissions_included',
];
const haveCols = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
const missingCols = expectedCols.filter((c) => !haveCols.has(c));
if (missingCols.length > 0) {
  console.error(`Faltan columnas: ${missingCols.join(', ')}`);
  process.exit(1);
}

console.log('OK');
console.log('tablas nuevas:', tableNames.join(', '));
console.log('columnas nuevas:', expectedCols.join(', '));
await db.close();
process.exit(0);
