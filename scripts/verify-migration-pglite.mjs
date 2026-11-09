/**
 * verify-migration-pglite.mjs — Verificación de migraciones sobre PGlite en
 * memoria (Épica B gate 3, extendido a Épica C PC-01).
 *
 *   - Levanta @electric-sql/pglite en memoria.
 *   - Aplica en orden TODOS los drizzle/*.sql.
 *   - Aplica 0005 y 0006 DOS VECES (prueba de idempotencia).
 *   - Imprime OK + tablas/columnas nuevas de Épica B y Épica C.
 *
 * Limitación documentada: PGlite (WASM) no trae pgvector. Se omiten los
 * statements CREATE EXTENSION vector y los índices USING hnsw, y el tipo
 * vector(N) se sustituye por bytea sólo dentro de esta verificación. El SQL
 * real corre tal cual sobre Postgres con pgvector (Neon/Render).
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
const pc02Migration = files.find((file) => file.startsWith('0007_'));

// Statements que PGlite no puede ejecutar por falta de pgvector; devuelve
// null para saltearlos o el SQL transformado cuando aplica.
const pgliteCompat = (stmt) => {
  if (/CREATE\s+EXTENSION/i.test(stmt) && /\bvector\b/i.test(stmt)) return null;
  if (/USING\s+hnsw/i.test(stmt)) return null;
  return stmt.replace(/\bvector\s*\(\s*\d+\s*\)/gi, 'bytea');
};

const apply = async (file) => {
  const sql = readFileSync(join(drizzleDir, file), 'utf8');
  // Las migraciones de drizzle-kit usan `--> statement-breakpoint` como
  // separador; PGlite exec sólo acepta un statement por llamada.
  const statements = sql
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    const compat = pgliteCompat(stmt);
    if (compat === null) continue;
    await db.exec(compat);
  }
};

// 1) Todas las migraciones en orden.
for (const file of files.filter((file) => file !== pc02Migration)) {
  await apply(file);
  console.log(`applied ${file}`);
}

if (pc02Migration) {
  await db.exec(`
    INSERT INTO tenants (id, name, slug) VALUES
      ('00000000-0000-4000-8000-000000000001', 'Tenant one', 'tenant-one'),
      ('00000000-0000-4000-8000-000000000002', 'Tenant two', 'tenant-two');
    INSERT INTO programs (id, tenant_id, name) VALUES
      ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Morning show'),
      ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'Evening show');
    INSERT INTO conductors (id, tenant_id, program_id, name, role, bio, is_active) VALUES
      ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'Ana Columnista', 'columnista', 'Legacy conductor bio', true),
      ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', NULL, 'Bruno Otro', 'other', NULL, false),
      ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'Cross tenant conductor', 'conductor', NULL, true);
    INSERT INTO guests (id, tenant_id, program_id, name, role, bio, scheduled_date, is_active) VALUES
      ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'Carla Invitada', 'Investigadora', 'Legacy guest bio', '2026-11-09', true);
  `);
  await apply(pc02Migration);
  console.log(`applied ${pc02Migration}`);

  const ids = `(
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000103',
    '00000000-0000-4000-8000-000000000201'
  )`;
  const { rows: firstPassPersons } = await db.query(`SELECT id FROM persons WHERE id IN ${ids}`);
  await apply(pc02Migration);
  console.log(`re-applied ${pc02Migration} (idempotent)`);
  const { rows: secondPassPersons } = await db.query(`SELECT id FROM persons WHERE id IN ${ids}`);
  if (firstPassPersons.length !== 4 || secondPassPersons.length !== 4) {
    throw new Error('PC-02 duplicated or omitted migrated persons on re-application');
  }

  const { rows: mappings } = await db.query(`
    SELECT id, person_id, tenant_id FROM conductors
    WHERE id IN ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000103')
    UNION ALL
    SELECT id, person_id, tenant_id FROM guests
    WHERE id = '00000000-0000-4000-8000-000000000201'
  `);
  if (mappings.length !== 4 || mappings.some((row) => row.id !== row.person_id)) {
    throw new Error('PC-02 did not link every legacy row to its deterministic person');
  }

  const { rows: tenantCounts } = await db.query(`
    SELECT tenant_id, COUNT(*)::int AS count FROM persons
    WHERE tenant_id IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
    GROUP BY tenant_id ORDER BY tenant_id
  `);
  if (tenantCounts.length !== 2 || Number(tenantCounts[0].count) !== 3 || Number(tenantCounts[1].count) !== 1) {
    throw new Error('PC-02 failed tenant isolation for migrated persons');
  }

  const { rows: roles } = await db.query(`SELECT id, role FROM persons WHERE id IN ${ids}`);
  const rolesById = new Map(roles.map((row) => [row.id, row.role]));
  if (rolesById.get('00000000-0000-4000-8000-000000000101') !== 'columnista'
    || rolesById.get('00000000-0000-4000-8000-000000000102') !== 'otro'
    || rolesById.get('00000000-0000-4000-8000-000000000103') !== 'conductor'
    || rolesById.get('00000000-0000-4000-8000-000000000201') !== 'invitado') {
    throw new Error('PC-02 assigned an incorrect person role');
  }

  const { rows: programLinks } = await db.query(`
    SELECT person_id FROM person_program
    WHERE person_id IN ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000201')
  `);
  if (programLinks.length !== 2) {
    throw new Error('PC-02 did not preserve legacy program relationships');
  }

  const { rows: crossTenantLinks } = await db.query(`
    SELECT pp.person_id
    FROM person_program pp
    WHERE pp.person_id = '00000000-0000-4000-8000-000000000103'
      AND pp.program_id = '00000000-0000-4000-8000-000000000012'
  `);
  if (crossTenantLinks.length !== 0) {
    throw new Error('PC-02 created a cross-tenant person-program relationship');
  }
}

// 2) Idempotencia: la 0005 (Épica B) y la 0006 (Épica C) se aplican dos veces.
for (const tag of ['0005', '0006']) {
  const migration = files.find((f) => f.includes(tag));
  if (!migration) {
    console.error(`No se encontró la migración ${tag}`);
    process.exit(1);
  }
  await apply(migration);
  console.log(`re-applied ${migration} (idempotente)`);
}

// 3) Tablas nuevas de Épica B y Épica C.
const { rows: tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('usage_cycles','quota_operations','plan_addons','addon_purchases','billing_events',
      'persons','person_photos','face_embeddings','person_program','editorial_profiles')
  ORDER BY tablename
`);
const tableNames = tables.map((r) => r.tablename);
const expectedTables = [
  'addon_purchases', 'billing_events', 'plan_addons', 'quota_operations', 'usage_cycles',
  'persons', 'person_photos', 'face_embeddings', 'person_program', 'editorial_profiles',
];
const missingTables = expectedTables.filter((t) => !tableNames.includes(t));
if (missingTables.length > 0) {
  console.error(`Faltan tablas: ${missingTables.join(', ')}`);
  process.exit(1);
}

// 4) Columnas nuevas en plans, subscriptions y tablas preexistentes de Épica C.
const { rows: cols } = await db.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'plans' AND column_name IN ('transmissions_per_cycle','max_transmission_minutes','max_clips_per_transmission','max_people','raw_retention_days'))
      OR (table_name = 'subscriptions' AND column_name IN ('past_due_since','grace_ends_at','dunning_attempts','last_dunning_at','suspended_at','trial_transmissions_included'))
      OR (table_name = 'conductors' AND column_name IN ('person_id'))
      OR (table_name = 'guests' AND column_name IN ('person_id')))
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
  'conductors.person_id',
  'guests.person_id',
];
const haveCols = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
const missingCols = expectedCols.filter((c) => !haveCols.has(c));
if (missingCols.length > 0) {
  console.error(`Faltan columnas: ${missingCols.join(', ')}`);
  process.exit(1);
}

// 5) Columnas clave de las tablas nuevas de Épica C (embedding incluido: en
//    PGlite queda como bytea por el shim, pero debe existir).
const { rows: cCols } = await db.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'persons' AND column_name IN ('tenant_id','name','role','embedding_ref','face_status','consent_given'))
      OR (table_name = 'face_embeddings' AND column_name IN ('tenant_id','person_id','person_photo_id','model','dimensions','embedding'))
      OR (table_name = 'person_program' AND column_name IN ('tenant_id','person_id','program_id','created_by_user_id'))
      OR (table_name = 'editorial_profiles' AND column_name IN ('tenant_id','program_id','tone'))
      OR (table_name = 'person_photos' AND column_name IN ('tenant_id','person_id','photo_data')))
  ORDER BY table_name, column_name
`);
const expectedCCols = [
  'persons.tenant_id', 'persons.name', 'persons.role', 'persons.embedding_ref', 'persons.face_status', 'persons.consent_given',
  'face_embeddings.tenant_id', 'face_embeddings.person_id', 'face_embeddings.person_photo_id', 'face_embeddings.model', 'face_embeddings.dimensions', 'face_embeddings.embedding',
  'person_program.tenant_id', 'person_program.person_id', 'person_program.program_id', 'person_program.created_by_user_id',
  'editorial_profiles.tenant_id', 'editorial_profiles.program_id', 'editorial_profiles.tone',
  'person_photos.tenant_id', 'person_photos.person_id', 'person_photos.photo_data',
];
const haveCCols = new Set(cCols.map((r) => `${r.table_name}.${r.column_name}`));
const missingCCols = expectedCCols.filter((c) => !haveCCols.has(c));
if (missingCCols.length > 0) {
  console.error(`Faltan columnas en tablas Épica C: ${missingCCols.join(', ')}`);
  process.exit(1);
}

console.log('OK');
console.log('tablas nuevas:', tableNames.join(', '));
console.log('columnas nuevas:', expectedCols.join(', '));
await db.close();
process.exit(0);
