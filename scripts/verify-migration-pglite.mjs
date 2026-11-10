/**
 * verify-migration-pglite.mjs — Verificación de migraciones sobre PGlite en
 * memoria (Épica B gate 3, extendido a Épica C PC-01, PC-07, PC-09 y PD-01).
 *
 *   - Levanta @electric-sql/pglite en memoria.
 *   - Aplica en orden TODOS los drizzle/*.sql.
 *   - Aplica 0005, 0006, 0008, 0009, 0010 y 0011 DOS VECES (prueba de idempotencia).
 *   - Imprime OK + tablas/columnas nuevas de Épica B, Épica C, PC-07, PC-09 y PD-01.
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
      ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'Cross tenant conductor', 'conductor', NULL, true),
      ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012', 'Elena Rol Largo', 'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDDEEEEEEEEEEFFFFFFFFFFGGGGGGGGGGHHHHHHHHHHIIIIIIIIIIJJJJJJJJJJ', NULL, true);
    INSERT INTO guests (id, tenant_id, program_id, name, role, bio, scheduled_date, is_active) VALUES
      ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'Carla Invitada', 'Investigadora', 'Legacy guest bio', '2026-11-09', true),
      ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'Diana Cross tenant', 'Panelista', NULL, '2026-11-10', true);
  `);
  await apply(pc02Migration);
  console.log(`applied ${pc02Migration}`);

  const ids = `(
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000103',
    '00000000-0000-4000-8000-000000000104',
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000202'
  )`;
  const { rows: firstPassPersons } = await db.query(`SELECT id FROM persons WHERE id IN ${ids}`);
  await apply(pc02Migration);
  console.log(`re-applied ${pc02Migration} (idempotent)`);
  const { rows: secondPassPersons } = await db.query(`SELECT id FROM persons WHERE id IN ${ids}`);
  if (firstPassPersons.length !== 6 || secondPassPersons.length !== 6) {
    throw new Error('PC-02 duplicated or omitted migrated persons on re-application');
  }

  const { rows: mappings } = await db.query(`
    SELECT id, person_id, tenant_id FROM conductors
    WHERE id IN ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000104')
    UNION ALL
    SELECT id, person_id, tenant_id FROM guests
    WHERE id IN ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000202')
  `);
  if (mappings.length !== 6 || mappings.some((row) => row.id !== row.person_id)) {
    throw new Error('PC-02 did not link every legacy row to its deterministic person');
  }

  const { rows: tenantCounts } = await db.query(`
    SELECT tenant_id, COUNT(*)::int AS count FROM persons
    WHERE tenant_id IN ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
    GROUP BY tenant_id ORDER BY tenant_id
  `);
  if (tenantCounts.length !== 2 || Number(tenantCounts[0].count) !== 4 || Number(tenantCounts[1].count) !== 2) {
    throw new Error('PC-02 failed tenant isolation for migrated persons');
  }

  const { rows: roles } = await db.query(`SELECT id, role FROM persons WHERE id IN ${ids}`);
  const rolesById = new Map(roles.map((row) => [row.id, row.role]));
  if (rolesById.get('00000000-0000-4000-8000-000000000101') !== 'columnista'
    || rolesById.get('00000000-0000-4000-8000-000000000102') !== 'otro'
    || rolesById.get('00000000-0000-4000-8000-000000000103') !== 'conductor'
    || rolesById.get('00000000-0000-4000-8000-000000000104') !== 'conductor'
    || rolesById.get('00000000-0000-4000-8000-000000000201') !== 'invitado'
    || rolesById.get('00000000-0000-4000-8000-000000000202') !== 'invitado') {
    throw new Error('PC-02 assigned an incorrect person role');
  }

  const { rows: programLinks } = await db.query(`
    SELECT person_id FROM person_program
  `);
  if (programLinks.length !== 3) {
    throw new Error('PC-02 did not preserve legacy program relationships');
  }

  const { rows: truncated } = await db.query(`
    SELECT LENGTH(pp.role_on_program)::int AS rel_len, LENGTH(p.role_label)::int AS label_len
    FROM person_program pp
    INNER JOIN persons p ON p.id = pp.person_id
    WHERE pp.person_id = '00000000-0000-4000-8000-000000000104'
  `);
  if (truncated.length !== 1 || truncated[0].rel_len !== 80 || truncated[0].label_len !== 100) {
    throw new Error('PC-02 failed deterministic role_on_program truncation or role_label preservation');
  }

  const { rows: crossTenantLinks } = await db.query(`
    SELECT pp.person_id
    FROM person_program pp
    WHERE pp.person_id IN ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000202')
      AND pp.program_id = '00000000-0000-4000-8000-000000000012'
  `);
  if (crossTenantLinks.length !== 0) {
    throw new Error('PC-02 created a cross-tenant person-program relationship');
  }
}

// 2) Idempotencia: la 0005 (Épica B), la 0006 (Épica C), la 0008 (PC-07), la
//    0009 (membresías N:M), la 0010 (PC-09 dossier↔emisión), la 0011
//    (PD-01 crudo de video), la 0012 (PD-05 sala en vivo), la 0016
//    (PG-03 auto-publicación) y la 0017 (PG-04 Zernio) se aplican dos veces.
for (const tag of ['0005', '0006', '0008', '0009', '0010', '0011', '0012', '0016', '0017', '0018']) {
  const migration = files.find((f) => f.includes(tag));
  if (!migration) {
    console.error(`No se encontró la migración ${tag}`);
    process.exit(1);
  }
  await apply(migration);
  console.log(`re-applied ${migration} (idempotente)`);
}

// 3) Tablas nuevas de Épica B, Épica C y PC-07.
const { rows: tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('usage_cycles','quota_operations','plan_addons','addon_purchases','billing_events',
      'persons','person_photos','face_embeddings','person_program','editorial_profiles',
      'transmissions','scheduled_transmissions','user_tenants')
  ORDER BY tablename
`);
const tableNames = tables.map((r) => r.tablename);
const expectedTables = [
  'addon_purchases', 'billing_events', 'plan_addons', 'quota_operations', 'usage_cycles',
  'persons', 'person_photos', 'face_embeddings', 'person_program', 'editorial_profiles',
  'transmissions', 'scheduled_transmissions', 'user_tenants',
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

// 5) Membresías N:M: tabla nueva y users.tenant_id como legacy nullable.
const { rows: membershipCols } = await db.query(`
  SELECT table_name, column_name, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'user_tenants' AND column_name IN ('user_id','tenant_id','role','status','last_used_at'))
      OR (table_name = 'users' AND column_name = 'tenant_id'))
`);
const expectedMembershipCols = [
  'user_tenants.user_id', 'user_tenants.tenant_id', 'user_tenants.role',
  'user_tenants.status', 'user_tenants.last_used_at', 'users.tenant_id',
];
const membershipColumnSet = new Set(membershipCols.map((row) => `${row.table_name}.${row.column_name}`));
const missingMembershipCols = expectedMembershipCols.filter((column) => !membershipColumnSet.has(column));
const legacyTenant = membershipCols.find((row) => row.table_name === 'users' && row.column_name === 'tenant_id');
if (missingMembershipCols.length > 0 || legacyTenant?.is_nullable !== 'YES') {
  throw new Error(`Membresías N:M incompletas: faltan ${missingMembershipCols.join(', ') || 'ninguna'}; users.tenant_id nullable=${legacyTenant?.is_nullable}`);
}

// 6) Columnas clave de las tablas nuevas de Épica C (embedding incluido: en
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

// 7) PC-07: columnas clave de transmissions y scheduled_transmissions.
const { rows: tCols } = await db.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'transmissions' AND column_name IN ('tenant_id','program_id','scheduled_transmission_id','status','source','crudo_ref','pipeline_config'))
      OR (table_name = 'scheduled_transmissions' AND column_name IN ('tenant_id','program_id','rrule','timezone','starts_at','auto_start','next_run_at','last_transmission_id')))
  ORDER BY table_name, column_name
`);
const expectedTCols = [
  'transmissions.tenant_id', 'transmissions.program_id', 'transmissions.scheduled_transmission_id',
  'transmissions.status', 'transmissions.source', 'transmissions.crudo_ref', 'transmissions.pipeline_config',
  'scheduled_transmissions.tenant_id', 'scheduled_transmissions.program_id', 'scheduled_transmissions.rrule',
  'scheduled_transmissions.timezone', 'scheduled_transmissions.starts_at', 'scheduled_transmissions.auto_start',
  'scheduled_transmissions.next_run_at', 'scheduled_transmissions.last_transmission_id',
];
const haveTCols = new Set(tCols.map((r) => `${r.table_name}.${r.column_name}`));
const missingTCols = expectedTCols.filter((c) => !haveTCols.has(c));
if (missingTCols.length > 0) {
  console.error(`Faltan columnas en tablas PC-07: ${missingTCols.join(', ')}`);
  process.exit(1);
}

// 8) PC-07: los 2 enums existen con todos sus valores.
const { rows: enumRows } = await db.query(`
  SELECT t.typname, e.enumlabel
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname IN ('TransmissionSource', 'TransmissionStatus')
  ORDER BY t.typname, e.enumsortorder
`);
const expectedEnums = {
  TransmissionSource: ['live_capture', 'vod_upload', 'manual'],
  TransmissionStatus: ['scheduled', 'waiting', 'live', 'processing', 'done', 'error', 'canceled'],
};
const gotEnums = {};
for (const row of enumRows) (gotEnums[row.typname] ??= []).push(row.enumlabel);
for (const [typeName, labels] of Object.entries(expectedEnums)) {
  const got = gotEnums[typeName] ?? [];
  if (JSON.stringify(got) !== JSON.stringify(labels)) {
    console.error(`Enum ${typeName} incorrecto: esperado [${labels}], encontrado [${got}]`);
    process.exit(1);
  }
}

// 9) PC-07: las FKs apuntan a las tablas correctas.
const { rows: fkRows } = await db.query(`
  SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name IN ('transmissions', 'scheduled_transmissions')
`);
const expectedFks = [
  'transmissions.tenant_id->tenants',
  'transmissions.program_id->programs',
  'transmissions.scheduled_transmission_id->scheduled_transmissions',
  'scheduled_transmissions.tenant_id->tenants',
  'scheduled_transmissions.program_id->programs',
  'scheduled_transmissions.last_transmission_id->transmissions',
];
const haveFks = new Set(fkRows.map((r) => `${r.table_name}.${r.column_name}->${r.foreign_table}`));
const missingFks = expectedFks.filter((fk) => !haveFks.has(fk));
if (missingFks.length > 0) {
  console.error(`Faltan o apuntan mal las FKs PC-07: ${missingFks.join(', ')}`);
  process.exit(1);
}

// 10) PC-09: guest_dossiers.scheduled_transmission_id existe, es NULLABLE y
//     tiene FK a scheduled_transmissions + su índice.
const { rows: pc09Cols } = await db.query(`
  SELECT column_name, is_nullable FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'guest_dossiers' AND column_name = 'scheduled_transmission_id'
`);
if (pc09Cols.length !== 1 || pc09Cols[0].is_nullable !== 'YES') {
  console.error('PC-09: falta guest_dossiers.scheduled_transmission_id o no es nullable');
  process.exit(1);
}

const { rows: pc09Fks } = await db.query(`
  SELECT ccu.table_name AS foreign_table
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
    AND tc.table_name = 'guest_dossiers'
    AND kcu.column_name = 'scheduled_transmission_id'
`);
if (pc09Fks.length !== 1 || pc09Fks[0].foreign_table !== 'scheduled_transmissions') {
  console.error('PC-09: la FK de scheduled_transmission_id no apunta a scheduled_transmissions');
  process.exit(1);
}

const { rows: pc09Idx } = await db.query(`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'guest_dossiers'
    AND indexname = 'guest_dossiers_scheduled_transmission_id_idx'
`);
if (pc09Idx.length !== 1) {
  console.error('PC-09: falta el índice guest_dossiers_scheduled_transmission_id_idx');
  process.exit(1);
}

// 11) PD-01: stream_recordings y recording_segments existen.
const { rows: pd01Tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('stream_recordings', 'recording_segments')
  ORDER BY tablename
`);
if (pd01Tables.length !== 2) {
  console.error(`PD-01: faltan tablas del crudo (encontradas: ${pd01Tables.map((r) => r.tablename).join(', ') || 'ninguna'})`);
  process.exit(1);
}

// 12) PD-01: columnas clave con tipo, nullabilidad y presencia de DEFAULT.
const { rows: pd01Cols } = await db.query(`
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('stream_recordings', 'recording_segments')
`);
const colInfo = new Map(pd01Cols.map((r) => [`${r.table_name}.${r.column_name}`, r]));
const checkCol = (fqcol, dataType, nullable, needsDefault) => {
  const c = colInfo.get(fqcol);
  if (!c) return `falta ${fqcol}`;
  if (c.data_type !== dataType) return `${fqcol} tipo=${c.data_type} (esperado ${dataType})`;
  if (c.is_nullable !== nullable) return `${fqcol} is_nullable=${c.is_nullable} (esperado ${nullable})`;
  if (needsDefault && c.column_default === null) return `${fqcol} sin DEFAULT`;
  return null;
};
const pd01ColErrors = [
  // stream_recordings
  ['stream_recordings.id', 'uuid', 'NO', true],
  ['stream_recordings.tenant_id', 'uuid', 'NO', false],
  ['stream_recordings.transmission_id', 'uuid', 'NO', false],
  ['stream_recordings.storage_prefix', 'text', 'NO', false],
  ['stream_recordings.status', 'character varying', 'NO', true],
  ['stream_recordings.total_bytes', 'bigint', 'NO', true],
  ['stream_recordings.started_at', 'timestamp with time zone', 'NO', true],
  ['stream_recordings.ended_at', 'timestamp with time zone', 'YES', false],
  ['stream_recordings.created_at', 'timestamp with time zone', 'NO', true],
  ['stream_recordings.updated_at', 'timestamp with time zone', 'NO', true],
  // recording_segments
  ['recording_segments.id', 'uuid', 'NO', true],
  ['recording_segments.tenant_id', 'uuid', 'NO', false],
  ['recording_segments.recording_id', 'uuid', 'NO', false],
  ['recording_segments.sequence', 'integer', 'NO', false],
  ['recording_segments.start_ms', 'bigint', 'NO', false],
  ['recording_segments.end_ms', 'bigint', 'YES', false],
  ['recording_segments.file_ref', 'text', 'NO', false],
  ['recording_segments.bytes', 'bigint', 'NO', true],
  ['recording_segments.status', 'character varying', 'NO', true],
  ['recording_segments.created_at', 'timestamp with time zone', 'NO', true],
].map(([c, t, n, d]) => checkCol(c, t, n, d)).filter(Boolean);
if (pd01ColErrors.length > 0) {
  console.error(`PD-01 columnas incorrectas:\n  ${pd01ColErrors.join('\n  ')}`);
  process.exit(1);
}
const recStatusDef = colInfo.get('stream_recordings.status')?.column_default ?? '';
const segStatusDef = colInfo.get('recording_segments.status')?.column_default ?? '';
if (!recStatusDef.includes("'recording'") || !segStatusDef.includes("'active'")) {
  console.error(`PD-01: defaults de status incorrectos (stream_recordings=${recStatusDef}, recording_segments=${segStatusDef})`);
  process.exit(1);
}

// 13) PD-01: las 4 FKs apuntan a la tabla correcta y borran en cascada.
const { rows: pd01Fks } = await db.query(`
  SELECT con.conrelid::regclass::text AS table_name,
         att.attname AS column_name,
         con.confrelid::regclass::text AS foreign_table,
         con.confdeltype
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f'
    AND con.conrelid::regclass::text IN ('stream_recordings', 'recording_segments')
`);
const pd01FkMap = new Map(pd01Fks.map((r) => [`${r.table_name}.${r.column_name}`, r]));
const expectedPd01Fks = [
  'stream_recordings.tenant_id->tenants',
  'stream_recordings.transmission_id->transmissions',
  'recording_segments.tenant_id->tenants',
  'recording_segments.recording_id->stream_recordings',
];
const badPd01Fks = expectedPd01Fks.filter((fk) => {
  const [col, target] = fk.split('->');
  const row = pd01FkMap.get(col);
  return !row || row.foreign_table !== target || row.confdeltype !== 'c';
});
if (badPd01Fks.length > 0) {
  console.error(`PD-01: faltan FKs, apuntan mal o no son ON DELETE CASCADE: ${badPd01Fks.join(', ')}`);
  process.exit(1);
}

// 14) PD-01: los índices del crudo existen y la unicidad es efectiva.
const { rows: pd01Idx } = await db.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename IN ('stream_recordings', 'recording_segments')
`);
const idxByName = new Map(pd01Idx.map((r) => [r.indexname, r.indexdef]));
const expectedPd01Idx = [
  'stream_recordings_tenant_id_idx',
  'stream_recordings_transmission_id_idx',
  'recording_segments_tenant_id_idx',
  'recording_segments_recording_id_idx',
  'recording_segments_recording_id_start_ms_idx',
  'recording_segments_recording_id_sequence_unique',
];
const missingPd01Idx = expectedPd01Idx.filter((name) => !idxByName.has(name));
if (missingPd01Idx.length > 0) {
  console.error(`PD-01: faltan índices: ${missingPd01Idx.join(', ')}`);
  process.exit(1);
}
const txIdx = idxByName.get('stream_recordings_transmission_id_idx') ?? '';
const seqIdx = idxByName.get('recording_segments_recording_id_sequence_unique') ?? '';
if (!/CREATE UNIQUE INDEX/i.test(txIdx) || !/UNIQUE INDEX/i.test(seqIdx)) {
  console.error('PD-01: transmission_id y/o (recording_id, sequence) no tienen índice UNIQUE');
  process.exit(1);
}

// 15) PD-05: transcript_segments, transmission_moments y clips.transmission_id.
const { rows: pd05Tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('transcript_segments', 'transmission_moments')
  ORDER BY tablename
`);
if (pd05Tables.length !== 2) {
  console.error(`PD-05: faltan tablas de la sala en vivo (encontradas: ${pd05Tables.map((r) => r.tablename).join(', ') || 'ninguna'})`);
  process.exit(1);
}

const { rows: pd05Cols } = await db.query(`
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('transcript_segments', 'transmission_moments', 'clips')
`);
const pd05ColInfo = new Map(pd05Cols.map((r) => [`${r.table_name}.${r.column_name}`, r]));
const checkPd05Col = (fqcol, dataType, nullable, needsDefault) => {
  const c = pd05ColInfo.get(fqcol);
  if (!c) return `falta ${fqcol}`;
  if (c.data_type !== dataType) return `${fqcol} tipo=${c.data_type} (esperado ${dataType})`;
  if (c.is_nullable !== nullable) return `${fqcol} is_nullable=${c.is_nullable} (esperado ${nullable})`;
  if (needsDefault && c.column_default === null) return `${fqcol} sin DEFAULT`;
  return null;
};
const pd05ColErrors = [
  // transcript_segments
  ['transcript_segments.id', 'uuid', 'NO', true],
  ['transcript_segments.tenant_id', 'uuid', 'NO', false],
  ['transcript_segments.transmission_id', 'uuid', 'NO', false],
  ['transcript_segments.start_ms', 'bigint', 'NO', false],
  ['transcript_segments.end_ms', 'bigint', 'NO', false],
  ['transcript_segments.speaker_label', 'character varying', 'YES', false],
  ['transcript_segments.person_id', 'uuid', 'YES', false],
  ['transcript_segments.text', 'text', 'NO', false],
  ['transcript_segments.confidence', 'real', 'YES', false],
  ['transcript_segments.created_at', 'timestamp with time zone', 'NO', true],
  // transmission_moments
  ['transmission_moments.id', 'uuid', 'NO', true],
  ['transmission_moments.tenant_id', 'uuid', 'NO', false],
  ['transmission_moments.transmission_id', 'uuid', 'NO', false],
  ['transmission_moments.kind', 'character varying', 'NO', true],
  ['transmission_moments.start_ms', 'bigint', 'NO', false],
  ['transmission_moments.end_ms', 'bigint', 'NO', false],
  ['transmission_moments.title', 'text', 'YES', false],
  ['transmission_moments.reason', 'text', 'YES', false],
  ['transmission_moments.score', 'real', 'YES', false],
  ['transmission_moments.clip_id', 'uuid', 'YES', false],
  ['transmission_moments.created_at', 'timestamp with time zone', 'NO', true],
  // clips.transmission_id (columna nueva, nullable, SET NULL)
  ['clips.transmission_id', 'uuid', 'YES', false],
].map(([c, t, n, d]) => checkPd05Col(c, t, n, d)).filter(Boolean);
if (pd05ColErrors.length > 0) {
  console.error(`PD-05 columnas incorrectas:\n  ${pd05ColErrors.join('\n  ')}`);
  process.exit(1);
}
const momentKindDef = pd05ColInfo.get('transmission_moments.kind')?.column_default ?? '';
if (!momentKindDef.includes("'detected'")) {
  console.error(`PD-05: default de transmission_moments.kind incorrecto (${momentKindDef})`);
  process.exit(1);
}

// 16) PD-05: las FKs apuntan a la tabla correcta con el ON DELETE esperado.
const { rows: pd05Fks } = await db.query(`
  SELECT con.conrelid::regclass::text AS table_name,
         att.attname AS column_name,
         con.confrelid::regclass::text AS foreign_table,
         con.confdeltype
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f'
    AND con.conrelid::regclass::text IN ('transcript_segments', 'transmission_moments', 'clips')
`);
const pd05FkMap = new Map(pd05Fks.map((r) => [`${r.table_name}.${r.column_name}`, r]));
const expectedPd05Fks = [
  // [columna, tabla destino, confdeltype ('c' cascade, 'n' set null)]
  ['transcript_segments.tenant_id', 'tenants', 'c'],
  ['transcript_segments.transmission_id', 'transmissions', 'c'],
  ['transcript_segments.person_id', 'persons', 'n'],
  ['transmission_moments.tenant_id', 'tenants', 'c'],
  ['transmission_moments.transmission_id', 'transmissions', 'c'],
  ['transmission_moments.clip_id', 'clips', 'n'],
  ['clips.transmission_id', 'transmissions', 'n'],
];
const badPd05Fks = expectedPd05Fks.filter(([col, target, deltype]) => {
  const row = pd05FkMap.get(col);
  return !row || row.foreign_table !== target || row.confdeltype !== deltype;
});
if (badPd05Fks.length > 0) {
  console.error(`PD-05: faltan FKs, apuntan mal o el ON DELETE no es el esperado: ${badPd05Fks.map((f) => f[0]).join(', ')}`);
  process.exit(1);
}

// 17) PD-05: los índices de la sala existen.
const { rows: pd05Idx } = await db.query(`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename IN ('transcript_segments', 'transmission_moments', 'clips')
`);
const pd05IdxNames = new Set(pd05Idx.map((r) => r.indexname));
const expectedPd05Idx = [
  'transcript_segments_tenant_id_idx',
  'transcript_segments_transmission_id_start_ms_idx',
  'transcript_segments_person_id_idx',
  'transmission_moments_tenant_id_idx',
  'transmission_moments_transmission_id_start_ms_idx',
  'clips_transmission_id_idx',
];
const missingPd05Idx = expectedPd05Idx.filter((name) => !pd05IdxNames.has(name));
if (missingPd05Idx.length > 0) {
  console.error(`PD-05: faltan índices: ${missingPd05Idx.join(', ')}`);
  process.exit(1);
}

// 18) PF-04: clip_render_jobs existe con columnas, FKs e índices.
const { rows: pf04Cols } = await db.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'clip_render_jobs'
`);
const pf04ColInfo = new Map(pf04Cols.map((r) => [r.column_name, r]));
const checkPf04Col = (col, dataType, nullable, needsDefault) => {
  const c = pf04ColInfo.get(col);
  if (!c) return `falta clip_render_jobs.${col}`;
  if (c.data_type !== dataType) return `clip_render_jobs.${col} tipo=${c.data_type} (esperado ${dataType})`;
  if (c.is_nullable !== nullable) return `clip_render_jobs.${col} is_nullable=${c.is_nullable} (esperado ${nullable})`;
  if (needsDefault && c.column_default === null) return `clip_render_jobs.${col} sin DEFAULT`;
  return null;
};
const pf04ColErrors = [
  ['id', 'uuid', 'NO', true],
  ['tenant_id', 'uuid', 'NO', false],
  ['clip_id', 'uuid', 'YES', false], // nullable: 'cut' lo rellena el worker
  ['kind', 'character varying', 'NO', false],
  ['status', 'character varying', 'NO', true],
  ['payload', 'jsonb', 'NO', true],
  ['attempts', 'integer', 'NO', true],
  ['max_attempts', 'integer', 'NO', true],
  ['last_error', 'text', 'YES', false],
  ['run_at', 'timestamp with time zone', 'NO', true],
  ['started_at', 'timestamp with time zone', 'YES', false],
  ['finished_at', 'timestamp with time zone', 'YES', false],
  ['created_at', 'timestamp with time zone', 'NO', true],
  ['updated_at', 'timestamp with time zone', 'NO', true],
].map(([c, t, n, d]) => checkPf04Col(c, t, n, d)).filter(Boolean);
if (pf04ColErrors.length > 0) {
  console.error(`PF-04 columnas incorrectas:\n  ${pf04ColErrors.join('\n  ')}`);
  process.exit(1);
}
const jobStatusDef = pf04ColInfo.get('status')?.column_default ?? '';
if (!jobStatusDef.includes("'pending'")) {
  console.error(`PF-04: default de clip_render_jobs.status incorrecto (${jobStatusDef})`);
  process.exit(1);
}

const { rows: pf04Fks } = await db.query(`
  SELECT con.conrelid::regclass::text AS table_name,
         att.attname AS column_name,
         con.confrelid::regclass::text AS foreign_table,
         con.confdeltype
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f' AND con.conrelid::regclass::text = 'clip_render_jobs'
`);
const pf04FkMap = new Map(pf04Fks.map((r) => [r.column_name, r]));
const expectedPf04Fks = [
  ['tenant_id', 'tenants'],
  ['clip_id', 'clips'],
];
const badPf04Fks = expectedPf04Fks.filter(([col, target]) => {
  const row = pf04FkMap.get(col);
  return !row || row.foreign_table !== target || row.confdeltype !== 'c';
});
if (badPf04Fks.length > 0) {
  console.error(`PF-04: faltan FKs, apuntan mal o no son ON DELETE CASCADE: ${badPf04Fks.map((f) => f[0]).join(', ')}`);
  process.exit(1);
}

const { rows: pf04Idx } = await db.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'clip_render_jobs'
`);
const pf04IdxMap = new Map(pf04Idx.map((r) => [r.indexname, r.indexdef]));
const expectedPf04Idx = [
  'clip_render_jobs_tenant_id_idx',
  'clip_render_jobs_clip_id_idx',
  'clip_render_jobs_status_run_at_idx',
];
const missingPf04Idx = expectedPf04Idx.filter((name) => !pf04IdxMap.has(name));
if (missingPf04Idx.length > 0) {
  console.error(`PF-04: faltan índices: ${missingPf04Idx.join(', ')}`);
  process.exit(1);
}
const claimIdxDef = pf04IdxMap.get('clip_render_jobs_status_run_at_idx') ?? '';
if (!/\("?status"?,\s*"?run_at"?\)|\(status,run_at\)|status.*run_at/.test(claimIdxDef) || !claimIdxDef.includes('status') || !claimIdxDef.includes('run_at')) {
  console.error(`PF-04: el índice del claim no cubre (status, run_at): ${claimIdxDef}`);
  process.exit(1);
}

// 19) PF-10: assets (ledger editorial unificado) existe con columnas, FKs,
//     índices y la UNIQUE (tenant_id, source_table, ref_id) del sync.
const { rows: pf10Tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'assets'
`);
if (pf10Tables.length !== 1) {
  console.error('PF-10: falta la tabla assets');
  process.exit(1);
}

const { rows: pf10Cols } = await db.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'assets'
`);
const pf10ColInfo = new Map(pf10Cols.map((r) => [r.column_name, r]));
const checkPf10Col = (col, dataType, nullable, needsDefault) => {
  const c = pf10ColInfo.get(col);
  if (!c) return `falta assets.${col}`;
  if (c.data_type !== dataType) return `assets.${col} tipo=${c.data_type} (esperado ${dataType})`;
  if (c.is_nullable !== nullable) return `assets.${col} is_nullable=${c.is_nullable} (esperado ${nullable})`;
  if (needsDefault && c.column_default === null) return `assets.${col} sin DEFAULT`;
  return null;
};
const pf10ColErrors = [
  ['id', 'uuid', 'NO', true],
  ['tenant_id', 'uuid', 'NO', false],
  ['kind', 'character varying', 'NO', false],
  ['source_table', 'character varying', 'NO', false],
  ['ref_id', 'uuid', 'NO', false],
  ['parent_asset_id', 'uuid', 'YES', false],
  ['title', 'text', 'YES', false],
  ['status', 'character varying', 'NO', true],
  ['payload', 'jsonb', 'NO', true],
  ['transmission_id', 'uuid', 'YES', false],
  ['created_at', 'timestamp with time zone', 'NO', true],
  ['updated_at', 'timestamp with time zone', 'NO', true],
].map(([c, t, n, d]) => checkPf10Col(c, t, n, d)).filter(Boolean);
if (pf10ColErrors.length > 0) {
  console.error(`PF-10 columnas incorrectas:\n  ${pf10ColErrors.join('\n  ')}`);
  process.exit(1);
}
const assetStatusDef = pf10ColInfo.get('status')?.column_default ?? '';
if (!assetStatusDef.includes("'draft'")) {
  console.error(`PF-10: default de assets.status incorrecto (${assetStatusDef})`);
  process.exit(1);
}

// FKs: tenant cascade; parent_asset_id self SET NULL; transmission SET NULL.
// ref_id NO debe tener FK (el flyer apunta a un path dentro de un jsonb).
const { rows: pf10Fks } = await db.query(`
  SELECT con.conrelid::regclass::text AS table_name,
         att.attname AS column_name,
         con.confrelid::regclass::text AS foreign_table,
         con.confdeltype
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f' AND con.conrelid::regclass::text = 'assets'
`);
const pf10FkMap = new Map(pf10Fks.map((r) => [r.column_name, r]));
const expectedPf10Fks = [
  // [columna, tabla destino, confdeltype ('c' cascade, 'n' set null)]
  ['tenant_id', 'tenants', 'c'],
  ['parent_asset_id', 'assets', 'n'],
  ['transmission_id', 'transmissions', 'n'],
];
const badPf10Fks = expectedPf10Fks.filter(([col, target, deltype]) => {
  const row = pf10FkMap.get(col);
  return !row || row.foreign_table !== target || row.confdeltype !== deltype;
});
if (badPf10Fks.length > 0) {
  console.error(`PF-10: faltan FKs, apuntan mal o el ON DELETE no es el esperado: ${badPf10Fks.map((f) => f[0]).join(', ')}`);
  process.exit(1);
}
if (pf10FkMap.has('ref_id')) {
  console.error('PF-10: ref_id tiene FK y no debe (flyer referencia un path jsonb, no una fila)');
  process.exit(1);
}

// Índices + la UNIQUE compuesta (contrato de idempotencia del sync).
const { rows: pf10Idx } = await db.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'assets'
`);
const pf10IdxMap = new Map(pf10Idx.map((r) => [r.indexname, r.indexdef]));
const expectedPf10Idx = [
  'assets_tenant_id_idx',
  'assets_tenant_id_kind_idx',
  'assets_tenant_id_status_idx',
  'assets_transmission_id_idx',
  'assets_tenant_source_ref_unique',
];
const missingPf10Idx = expectedPf10Idx.filter((name) => !pf10IdxMap.has(name));
if (missingPf10Idx.length > 0) {
  console.error(`PF-10: faltan índices/unique: ${missingPf10Idx.join(', ')}`);
  process.exit(1);
}
const pf10UniqueDef = pf10IdxMap.get('assets_tenant_source_ref_unique') ?? '';
if (!/UNIQUE/i.test(pf10UniqueDef)
  || !pf10UniqueDef.includes('tenant_id')
  || !pf10UniqueDef.includes('source_table')
  || !pf10UniqueDef.includes('ref_id')) {
  console.error(`PF-10: la unique no cubre (tenant_id, source_table, ref_id): ${pf10UniqueDef}`);
  process.exit(1);
}

// Funcional: el upsert del sync (INSERT ... ON CONFLICT DO UPDATE sin status
// en el SET) es idempotente y preserva el estado editorial transicionado.
await db.exec(`
  INSERT INTO tenants (id, name, slug) VALUES
    ('00000000-0000-4000-8000-00000000ff10', 'Tenant pf10', 'tenant-pf10')
  ON CONFLICT (id) DO NOTHING
`);
const pf10Tenant = '00000000-0000-4000-8000-00000000ff10';
const pf10ClipRef = '00000000-0000-4000-8000-00000000c110';
await db.exec(`
  INSERT INTO assets (tenant_id, kind, source_table, ref_id, title, status, payload)
  VALUES ('${pf10Tenant}', 'clip', 'clips', '${pf10ClipRef}', 'Clip A', 'draft', '{"videoPath":"v1.mp4"}'::jsonb)
  ON CONFLICT (tenant_id, source_table, ref_id)
  DO UPDATE SET title = EXCLUDED.title, payload = EXCLUDED.payload, updated_at = now()
`);
await db.exec(`
  UPDATE assets SET status = 'approved' WHERE tenant_id = '${pf10Tenant}' AND ref_id = '${pf10ClipRef}'
`);
// Re-sync: mismas columnas del conflicto — status queda 'approved' (preservado).
await db.exec(`
  INSERT INTO assets (tenant_id, kind, source_table, ref_id, title, status, payload)
  VALUES ('${pf10Tenant}', 'clip', 'clips', '${pf10ClipRef}', 'Clip A v2', 'draft', '{"videoPath":"v2.mp4"}'::jsonb)
  ON CONFLICT (tenant_id, source_table, ref_id)
  DO UPDATE SET title = EXCLUDED.title, payload = EXCLUDED.payload, updated_at = now()
`);
const { rows: pf10Rows } = await db.query(`
  SELECT title, status, payload->>'videoPath' AS video_path
  FROM assets WHERE tenant_id = '${pf10Tenant}' AND source_table = 'clips' AND ref_id = '${pf10ClipRef}'
`);
if (pf10Rows.length !== 1 || pf10Rows[0].status !== 'approved' || pf10Rows[0].title !== 'Clip A v2' || pf10Rows[0].video_path !== 'v2.mp4') {
  console.error(`PF-10: el upsert del sync no es idempotente o pisó el status editorial: ${JSON.stringify(pf10Rows)}`);
  process.exit(1);
}

// 20) PG-03: auto_publish_configs existe con columnas, FKs, índices y la
//     UNIQUE (tenant_id, program_key) que también cubre la config global
//     (program_id NULL + program_key '__all__').
const { rows: pg03Tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'auto_publish_configs'
`);
if (pg03Tables.length !== 1) {
  console.error('PG-03: falta la tabla auto_publish_configs');
  process.exit(1);
}

const { rows: pg03Cols } = await db.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'auto_publish_configs'
`);
const pg03ColInfo = new Map(pg03Cols.map((r) => [r.column_name, r]));
const checkPg03Col = (col, dataType, nullable, needsDefault) => {
  const c = pg03ColInfo.get(col);
  if (!c) return `falta auto_publish_configs.${col}`;
  if (c.data_type !== dataType) return `auto_publish_configs.${col} tipo=${c.data_type} (esperado ${dataType})`;
  if (c.is_nullable !== nullable) return `auto_publish_configs.${col} is_nullable=${c.is_nullable} (esperado ${nullable})`;
  if (needsDefault && c.column_default === null) return `auto_publish_configs.${col} sin DEFAULT`;
  return null;
};
const pg03ColErrors = [
  ['id', 'uuid', 'NO', true],
  ['tenant_id', 'uuid', 'NO', false],
  ['program_id', 'uuid', 'YES', false],
  ['program_key', 'character varying', 'NO', false],
  ['mode', 'character varying', 'NO', true],
  ['platforms', 'jsonb', 'NO', true],
  ['publish_days', 'jsonb', 'NO', true],
  ['publish_time', 'character varying', 'YES', false],
  ['timezone', 'character varying', 'NO', true],
  ['is_active', 'boolean', 'NO', true],
  ['created_at', 'timestamp with time zone', 'NO', true],
  ['updated_at', 'timestamp with time zone', 'NO', true],
].map(([c, t, n, d]) => checkPg03Col(c, t, n, d)).filter(Boolean);
if (pg03ColErrors.length > 0) {
  console.error(`PG-03 columnas incorrectas:\n  ${pg03ColErrors.join('\n  ')}`);
  process.exit(1);
}
const modeDef = pg03ColInfo.get('mode')?.column_default ?? '';
const tzDef = pg03ColInfo.get('timezone')?.column_default ?? '';
if (!modeDef.includes("'off'") || !tzDef.includes('America/Argentina/Buenos_Aires')) {
  console.error(`PG-03: defaults de mode/timezone incorrectos (mode=${modeDef}, timezone=${tzDef})`);
  process.exit(1);
}

// FKs: tenant cascade; program cascade (borrar el programa borra su config).
const { rows: pg03Fks } = await db.query(`
  SELECT con.conrelid::regclass::text AS table_name,
         att.attname AS column_name,
         con.confrelid::regclass::text AS foreign_table,
         con.confdeltype
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f' AND con.conrelid::regclass::text = 'auto_publish_configs'
`);
const pg03FkMap = new Map(pg03Fks.map((r) => [r.column_name, r]));
const expectedPg03Fks = [
  ['tenant_id', 'tenants'],
  ['program_id', 'programs'],
];
const badPg03Fks = expectedPg03Fks.filter(([col, target]) => {
  const row = pg03FkMap.get(col);
  return !row || row.foreign_table !== target || row.confdeltype !== 'c';
});
if (badPg03Fks.length > 0) {
  console.error(`PG-03: faltan FKs, apuntan mal o no son ON DELETE CASCADE: ${badPg03Fks.map((f) => f[0]).join(', ')}`);
  process.exit(1);
}

// Índices + la UNIQUE (tenant_id, program_key) — el contrato de dedupe que
// cubre la config global (un UNIQUE sobre program_id no deduplicaría NULLs).
const { rows: pg03Idx } = await db.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'auto_publish_configs'
`);
const pg03IdxMap = new Map(pg03Idx.map((r) => [r.indexname, r.indexdef]));
const expectedPg03Idx = [
  'auto_publish_configs_tenant_id_idx',
  'auto_publish_configs_program_id_idx',
  'auto_publish_configs_tenant_program_unique',
];
const missingPg03Idx = expectedPg03Idx.filter((name) => !pg03IdxMap.has(name));
if (missingPg03Idx.length > 0) {
  console.error(`PG-03: faltan índices/unique: ${missingPg03Idx.join(', ')}`);
  process.exit(1);
}
const pg03UniqueDef = pg03IdxMap.get('auto_publish_configs_tenant_program_unique') ?? '';
if (!/UNIQUE/i.test(pg03UniqueDef)
  || !pg03UniqueDef.includes('tenant_id')
  || !pg03UniqueDef.includes('program_key')) {
  console.error(`PG-03: la unique no cubre (tenant_id, program_key): ${pg03UniqueDef}`);
  process.exit(1);
}

// Funcional: la UNIQUE deduplica la config global (program_key='__all__',
// program_id NULL) y las de programa; el upsert del servicio
// (ON CONFLICT tenant_id+program_key) es idempotente.
const pg03Tenant = '00000000-0000-4000-8000-00000000aa03';
const pg03Program = '00000000-0000-4000-8000-00000000bb03';
await db.exec(`
  INSERT INTO tenants (id, name, slug) VALUES
    ('${pg03Tenant}', 'Tenant pg03', 'tenant-pg03')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO programs (id, tenant_id, name) VALUES
    ('${pg03Program}', '${pg03Tenant}', 'Programa pg03')
  ON CONFLICT (id) DO NOTHING;
`);
// Dos inserts de la global → una sola fila (la UNIQUE pisa por program_key).
for (let i = 0; i < 2; i++) {
  await db.exec(`
    INSERT INTO auto_publish_configs (tenant_id, program_id, program_key, mode, platforms)
    VALUES ('${pg03Tenant}', NULL, '__all__', 'on_approval', '["instagram"]'::jsonb)
    ON CONFLICT (tenant_id, program_key)
    DO UPDATE SET mode = EXCLUDED.mode, platforms = EXCLUDED.platforms, updated_at = now()
  `);
}
// Upsert de la config del programa — cambia de modo en la segunda corrida.
await db.exec(`
  INSERT INTO auto_publish_configs (tenant_id, program_id, program_key, mode, platforms, publish_days, publish_time)
  VALUES ('${pg03Tenant}', '${pg03Program}', '${pg03Program}', 'scheduled', '["tiktok","youtube"]'::jsonb, '[1,3,5]'::jsonb, '09:30')
  ON CONFLICT (tenant_id, program_key)
  DO UPDATE SET mode = EXCLUDED.mode, platforms = EXCLUDED.platforms, publish_days = EXCLUDED.publish_days, publish_time = EXCLUDED.publish_time, updated_at = now()
`);
await db.exec(`
  INSERT INTO auto_publish_configs (tenant_id, program_id, program_key, mode, platforms, publish_days, publish_time)
  VALUES ('${pg03Tenant}', '${pg03Program}', '${pg03Program}', 'off', '[]'::jsonb, '[]'::jsonb, NULL)
  ON CONFLICT (tenant_id, program_key)
  DO UPDATE SET mode = EXCLUDED.mode, platforms = EXCLUDED.platforms, publish_days = EXCLUDED.publish_days, publish_time = EXCLUDED.publish_time, updated_at = now()
`);
const { rows: pg03Rows } = await db.query(`
  SELECT program_key, mode, jsonb_array_length(platforms) AS n_platforms
  FROM auto_publish_configs WHERE tenant_id = '${pg03Tenant}'
`);
const pg03ByKey = new Map(pg03Rows.map((r) => [r.program_key, r]));
const pg03Global = pg03ByKey.get('__all__');
const pg03Prog = pg03ByKey.get(pg03Program);
if (pg03Rows.length !== 2
  || !pg03Global || pg03Global.mode !== 'on_approval' || Number(pg03Global.n_platforms) !== 1
  || !pg03Prog || pg03Prog.mode !== 'off') {
  console.error(`PG-03: la UNIQUE (tenant_id, program_key) no deduplicó global/programa: ${JSON.stringify(pg03Rows)}`);
  process.exit(1);
}
// Un INSERT directo duplicando la global debe fallar (dedupe real, no upsert).
let pg03DupRejected = false;
try {
  await db.exec(`
    INSERT INTO auto_publish_configs (tenant_id, program_id, program_key, mode)
    VALUES ('${pg03Tenant}', NULL, '__all__', 'off')
  `);
} catch {
  pg03DupRejected = true;
}
if (!pg03DupRejected) {
  console.error('PG-03: la UNIQUE permitió duplicar la config global (__all__)');
  process.exit(1);
}

// ============================================================================
// PG-04: zernio_profiles + social_connections (0017)
// ============================================================================
const { rows: pg04Tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename IN ('zernio_profiles', 'social_connections')
  ORDER BY tablename
`);
if (pg04Tables.length !== 2) {
  console.error(`PG-04: faltan tablas (encontradas: ${pg04Tables.map((r) => r.tablename).join(', ') || 'ninguna'})`);
  process.exit(1);
}

// Columnas: tipo, nullabilidad y DEFAULT.
const { rows: pg04Cols } = await db.query(`
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('zernio_profiles', 'social_connections')
  ORDER BY table_name, column_name
`);
const pg04ColInfo = new Map(pg04Cols.map((r) => [`${r.table_name}.${r.column_name}`, r]));
const checkPg04Col = (fqcol, dataType, nullable, needsDefault) => {
  const c = pg04ColInfo.get(fqcol);
  if (!c) return `falta ${fqcol}`;
  if (c.data_type !== dataType) return `${fqcol} tipo=${c.data_type} (esperado ${dataType})`;
  if (c.is_nullable !== nullable) return `${fqcol} is_nullable=${c.is_nullable} (esperado ${nullable})`;
  if (needsDefault && c.column_default === null) return `${fqcol} sin DEFAULT`;
  return null;
};
const pg04ColErrors = [
  ['social_connections.id', 'uuid', 'NO', true],
  ['social_connections.tenant_id', 'uuid', 'NO', false],
  ['social_connections.platform', 'character varying', 'NO', false],
  ['social_connections.account_id', 'character varying', 'NO', false],
  ['social_connections.username', 'character varying', 'YES', false],
  ['social_connections.display_name', 'character varying', 'YES', false],
  ['social_connections.status', 'character varying', 'NO', true],
  ['social_connections.zernio_profile_id', 'character varying', 'NO', false],
  ['social_connections.last_synced_at', 'timestamp with time zone', 'YES', false],
  ['social_connections.created_at', 'timestamp with time zone', 'NO', true],
  ['social_connections.updated_at', 'timestamp with time zone', 'NO', true],
  ['zernio_profiles.id', 'uuid', 'NO', true],
  ['zernio_profiles.tenant_id', 'uuid', 'NO', false],
  ['zernio_profiles.profile_id', 'character varying', 'NO', false],
  ['zernio_profiles.name', 'character varying', 'YES', false],
  ['zernio_profiles.created_at', 'timestamp with time zone', 'NO', true],
  ['zernio_profiles.updated_at', 'timestamp with time zone', 'NO', true],
].map(([c, t, n, d]) => checkPg04Col(c, t, n, d)).filter(Boolean);
if (pg04ColErrors.length > 0) {
  console.error(`PG-04 columnas incorrectas:\n  ${pg04ColErrors.join('\n  ')}`);
  process.exit(1);
}
const statusDef = pg04ColInfo.get('social_connections.status')?.column_default ?? '';
if (!statusDef.includes("'connected'")) {
  console.error(`PG-04: default de status incorrecto (${statusDef})`);
  process.exit(1);
}

// FKs: tenant cascade en ambas tablas.
const { rows: pg04Fks } = await db.query(`
  SELECT con.conrelid::regclass::text AS table_name,
         att.attname AS column_name,
         con.confrelid::regclass::text AS foreign_table,
         con.confdeltype
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f'
    AND con.conrelid::regclass::text IN ('zernio_profiles', 'social_connections')
`);
const pg04FkMap = new Map(pg04Fks.map((r) => [`${r.table_name}.${r.column_name}`, r]));
const expectedPg04Fks = [
  ['social_connections.tenant_id', 'tenants'],
  ['zernio_profiles.tenant_id', 'tenants'],
];
const badPg04Fks = expectedPg04Fks.filter(([fqcol, target]) => {
  const row = pg04FkMap.get(fqcol);
  return !row || row.foreign_table !== target || row.confdeltype !== 'c';
});
if (badPg04Fks.length > 0) {
  console.error(`PG-04: faltan FKs, apuntan mal o no son ON DELETE CASCADE: ${badPg04Fks.map((f) => f[0]).join(', ')}`);
  process.exit(1);
}

// Índices + UNIQUEs: (tenant_id, platform, account_id) es el contrato de
// dedupe del callback/sync; UNIQUE(tenant_id) en zernio_profiles = un
// perfil por tenant.
const { rows: pg04Idx } = await db.query(`
  SELECT tablename, indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND tablename IN ('zernio_profiles', 'social_connections')
`);
const pg04IdxMap = new Map(pg04Idx.map((r) => [r.indexname, r.indexdef]));
const expectedPg04Idx = [
  'social_connections_tenant_id_idx',
  'social_connections_tenant_id_status_idx',
  'social_connections_tenant_platform_account_unique',
  'zernio_profiles_tenant_id_unique',
];
const missingPg04Idx = expectedPg04Idx.filter((name) => !pg04IdxMap.has(name));
if (missingPg04Idx.length > 0) {
  console.error(`PG-04: faltan índices/unique: ${missingPg04Idx.join(', ')}`);
  process.exit(1);
}
const pg04ConnUnique = pg04IdxMap.get('social_connections_tenant_platform_account_unique') ?? '';
if (!/UNIQUE/i.test(pg04ConnUnique)
  || !pg04ConnUnique.includes('tenant_id')
  || !pg04ConnUnique.includes('platform')
  || !pg04ConnUnique.includes('account_id')) {
  console.error(`PG-04: la unique no cubre (tenant_id, platform, account_id): ${pg04ConnUnique}`);
  process.exit(1);
}
const pg04ProfUnique = pg04IdxMap.get('zernio_profiles_tenant_id_unique') ?? '';
if (!/UNIQUE/i.test(pg04ProfUnique) || !pg04ProfUnique.includes('tenant_id')) {
  console.error(`PG-04: la unique de zernio_profiles no cubre tenant_id: ${pg04ProfUnique}`);
  process.exit(1);
}

// Funcional: (a) el upsert ON CONFLICT (tenant_id,platform,account_id) es
// idempotente; (b) un INSERT crudo duplicado falla; (c) el mismo account_id
// en OTRO tenant no colisiona; (d) borrar el tenant borra perfil+conexiones
// (cascade); (e) un perfil por tenant.
const pg04TenantA = '00000000-0000-4000-8000-00000000aa04';
const pg04TenantB = '00000000-0000-4000-8000-00000000bb04';
await db.exec(`
  INSERT INTO tenants (id, name, slug) VALUES
    ('${pg04TenantA}', 'Tenant pg04a', 'tenant-pg04a'),
    ('${pg04TenantB}', 'Tenant pg04b', 'tenant-pg04b')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO zernio_profiles (tenant_id, profile_id, name) VALUES
    ('${pg04TenantA}', 'zprof_a', 'Tenant pg04a'),
    ('${pg04TenantB}', 'zprof_b', 'Tenant pg04b')
  ON CONFLICT (tenant_id) DO NOTHING;
`);
// (a) upsert idempotente — mismo (tenant, platform, account) dos veces.
for (let i = 0; i < 2; i++) {
  await db.exec(`
    INSERT INTO social_connections (tenant_id, platform, account_id, username, status, zernio_profile_id)
    VALUES ('${pg04TenantA}', 'instagram', 'zacc_1', 'radio.uno', 'connected', 'zprof_a')
    ON CONFLICT (tenant_id, platform, account_id)
    DO UPDATE SET username = EXCLUDED.username, status = EXCLUDED.status, updated_at = now()
  `);
}
// (c) misma account_id en otro tenant — permitido (aislamiento, no choque).
await db.exec(`
  INSERT INTO social_connections (tenant_id, platform, account_id, username, status, zernio_profile_id)
  VALUES ('${pg04TenantB}', 'instagram', 'zacc_1', 'otra.radio', 'connected', 'zprof_b')
`);
const { rows: pg04ConnRows } = await db.query(`
  SELECT tenant_id, platform, account_id, username FROM social_connections
  WHERE tenant_id IN ('${pg04TenantA}', '${pg04TenantB}') ORDER BY tenant_id
`);
if (pg04ConnRows.length !== 2) {
  console.error(`PG-04: dedupe (tenant_id,platform,account_id) incorrecto: ${JSON.stringify(pg04ConnRows)}`);
  process.exit(1);
}
// (b) INSERT crudo duplicado debe fallar.
let pg04DupRejected = false;
try {
  await db.exec(`
    INSERT INTO social_connections (tenant_id, platform, account_id, zernio_profile_id)
    VALUES ('${pg04TenantA}', 'instagram', 'zacc_1', 'zprof_a')
  `);
} catch {
  pg04DupRejected = true;
}
if (!pg04DupRejected) {
  console.error('PG-04: la UNIQUE permitió duplicar (tenant_id, platform, account_id)');
  process.exit(1);
}
// (e) un segundo perfil para el mismo tenant debe fallar.
let pg04ProfDupRejected = false;
try {
  await db.exec(`
    INSERT INTO zernio_profiles (tenant_id, profile_id) VALUES ('${pg04TenantA}', 'zprof_otro')
  `);
} catch {
  pg04ProfDupRejected = true;
}
if (!pg04ProfDupRejected) {
  console.error('PG-04: la UNIQUE de zernio_profiles permitió dos perfiles por tenant');
  process.exit(1);
}
// (d) cascade: borrar el tenant B borra su perfil y su conexión.
await db.exec(`DELETE FROM tenants WHERE id = '${pg04TenantB}'`);
const { rows: pg04AfterCascade } = await db.query(`
  SELECT
    (SELECT COUNT(*)::int FROM zernio_profiles WHERE tenant_id = '${pg04TenantB}') AS profiles,
    (SELECT COUNT(*)::int FROM social_connections WHERE tenant_id = '${pg04TenantB}') AS connections,
    (SELECT COUNT(*)::int FROM zernio_profiles WHERE tenant_id = '${pg04TenantA}') AS profiles_a,
    (SELECT COUNT(*)::int FROM social_connections WHERE tenant_id = '${pg04TenantA}') AS connections_a
`);
const casc = pg04AfterCascade[0];
if (casc.profiles !== 0 || casc.connections !== 0 || casc.profiles_a !== 1 || casc.connections_a !== 1) {
  console.error(`PG-04: el cascade por tenant falló: ${JSON.stringify(casc)}`);
  process.exit(1);
}

// ============================================================================
// PG-05: publish_jobs — cola de publicación vía Zernio (0018)
// ============================================================================
const { rows: pg05Tables } = await db.query(`
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'publish_jobs'
`);
if (pg05Tables.length !== 1) {
  console.error('PG-05: falta la tabla publish_jobs');
  process.exit(1);
}

// Columnas: tipo, nullabilidad y DEFAULT. `next_attempt_at` es la extensión
// del slice (gate del claim del worker — scheduled_for guarda la intención
// editorial del usuario y nunca la pisa el backoff).
const { rows: pg05Cols } = await db.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'publish_jobs'
`);
const pg05ColInfo = new Map(pg05Cols.map((r) => [r.column_name, r]));
const checkPg05Col = (col, dataType, nullable, needsDefault) => {
  const c = pg05ColInfo.get(col);
  if (!c) return `falta publish_jobs.${col}`;
  if (c.data_type !== dataType) return `publish_jobs.${col} tipo=${c.data_type} (esperado ${dataType})`;
  if (c.is_nullable !== nullable) return `publish_jobs.${col} is_nullable=${c.is_nullable} (esperado ${nullable})`;
  if (needsDefault && c.column_default === null) return `publish_jobs.${col} sin DEFAULT`;
  return null;
};
const pg05ColErrors = [
  ['id', 'uuid', 'NO', true],
  ['tenant_id', 'uuid', 'NO', false],
  ['asset_id', 'uuid', 'YES', false],
  ['publication_id', 'uuid', 'YES', false],
  ['connection_id', 'uuid', 'YES', false],
  ['platform', 'character varying', 'NO', false],
  ['account_id', 'character varying', 'NO', false],
  ['status', 'character varying', 'NO', true],
  ['zernio_post_id', 'character varying', 'YES', false],
  ['idempotency_key', 'character varying', 'NO', false],
  ['content', 'text', 'NO', false],
  ['media_urls', 'jsonb', 'NO', true],
  ['attempts', 'integer', 'NO', true],
  ['max_attempts', 'integer', 'NO', true],
  ['last_error', 'text', 'YES', false],
  ['last_error_category', 'character varying', 'YES', false],
  ['last_error_source', 'character varying', 'YES', false],
  ['scheduled_for', 'timestamp with time zone', 'YES', false],
  ['published_at', 'timestamp with time zone', 'YES', false],
  ['platform_post_url', 'text', 'YES', false],
  ['next_attempt_at', 'timestamp with time zone', 'YES', false],
  ['created_at', 'timestamp with time zone', 'NO', true],
  ['updated_at', 'timestamp with time zone', 'NO', true],
].map(([c, t, n, d]) => checkPg05Col(c, t, n, d)).filter(Boolean);
if (pg05ColErrors.length > 0) {
  console.error(`PG-05 columnas incorrectas:\n  ${pg05ColErrors.join('\n  ')}`);
  process.exit(1);
}
const pg05StatusDef = pg05ColInfo.get('status')?.column_default ?? '';
const pg05AttemptsDef = pg05ColInfo.get('attempts')?.column_default ?? '';
const pg05MaxDef = pg05ColInfo.get('max_attempts')?.column_default ?? '';
if (!pg05StatusDef.includes("'queued'") || !pg05AttemptsDef.includes('0') || !pg05MaxDef.includes('3')) {
  console.error(`PG-05: defaults incorrectos (status=${pg05StatusDef}, attempts=${pg05AttemptsDef}, max_attempts=${pg05MaxDef})`);
  process.exit(1);
}

// FKs: tenant cascade; asset/publication/connection SET NULL (borrar el
// origen o desconectar la cuenta no borra el historial del job).
const { rows: pg05Fks } = await db.query(`
  SELECT att.attname AS column_name,
         con.confrelid::regclass::text AS foreign_table,
         con.confdeltype
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.contype = 'f' AND con.conrelid::regclass::text = 'publish_jobs'
`);
const pg05FkMap = new Map(pg05Fks.map((r) => [r.column_name, r]));
const expectedPg05Fks = [
  ['tenant_id', 'tenants', 'c'],
  ['asset_id', 'assets', 'n'],
  ['publication_id', 'publications', 'n'],
  ['connection_id', 'social_connections', 'n'],
];
const badPg05Fks = expectedPg05Fks.filter(([col, target, del]) => {
  const row = pg05FkMap.get(col);
  return !row || row.foreign_table !== target || row.confdeltype !== del;
});
if (badPg05Fks.length > 0) {
  console.error(`PG-05: faltan FKs, apuntan mal o el ON DELETE es incorrecto: ${badPg05Fks.map((f) => f[0]).join(', ')}`);
  process.exit(1);
}

// Índices + UNIQUE(idempotency_key) — el contrato de dedupe del enqueue:
// re-encolar el mismo (tenant, origen, plataforma, cuenta) cae en la misma
// fila y la key viaja a Zernio como Idempotency-Key.
const { rows: pg05Idx } = await db.query(`
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'publish_jobs'
`);
const pg05IdxMap = new Map(pg05Idx.map((r) => [r.indexname, r.indexdef]));
const expectedPg05Idx = [
  'publish_jobs_tenant_id_idx',
  'publish_jobs_tenant_id_status_idx',
  'publish_jobs_tenant_id_created_at_idx',
  'publish_jobs_status_next_attempt_idx',
  'publish_jobs_idempotency_key_unique',
];
const missingPg05Idx = expectedPg05Idx.filter((name) => !pg05IdxMap.has(name));
if (missingPg05Idx.length > 0) {
  console.error(`PG-05: faltan índices/unique: ${missingPg05Idx.join(', ')}`);
  process.exit(1);
}
const pg05Unique = pg05IdxMap.get('publish_jobs_idempotency_key_unique') ?? '';
if (!/UNIQUE/i.test(pg05Unique) || !pg05Unique.includes('idempotency_key')) {
  console.error(`PG-05: la unique no cubre idempotency_key: ${pg05Unique}`);
  process.exit(1);
}

// Funcional: (a) INSERT crudo con idempotency_key duplicada falla;
// (b) ON CONFLICT (idempotency_key) DO NOTHING es idempotente; (c) borrar
// el tenant borra sus jobs (cascade); (d) borrar connection/asset/
// publication deja la fila con la FK en NULL (SET NULL — el historial del
// job sobrevive a la desconexión de la cuenta y al borrado del origen).
const pg05Tenant = '00000000-0000-4000-8000-00000000aa05';
await db.exec(`
  INSERT INTO tenants (id, name, slug) VALUES
    ('${pg05Tenant}', 'Tenant pg05', 'tenant-pg05')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO zernio_profiles (tenant_id, profile_id, name) VALUES
    ('${pg05Tenant}', 'zprof_pg05', 'Tenant pg05')
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO social_connections (tenant_id, platform, account_id, status, zernio_profile_id)
  VALUES ('${pg05Tenant}', 'instagram', 'zacc_pg05', 'connected', 'zprof_pg05')
  ON CONFLICT (tenant_id, platform, account_id) DO NOTHING;
`);
const { rows: pg05Conn } = await db.query(`
  SELECT id FROM social_connections
  WHERE tenant_id = '${pg05Tenant}' AND platform = 'instagram' AND account_id = 'zacc_pg05'
`);
const { rows: pg05Asset } = await db.query(`
  INSERT INTO assets (tenant_id, kind, source_table, ref_id, title, status, payload)
  VALUES ('${pg05Tenant}', 'note', 'publications', '${pg05Tenant}', 'Nota', 'approved', '{}'::jsonb)
  RETURNING id
`);
const { rows: pg05Pub } = await db.query(`
  INSERT INTO publications (tenant_id, title, content)
  VALUES ('${pg05Tenant}', 'Nota', 'Contenido')
  RETURNING id
`);
const insertPg05Job = `
  INSERT INTO publish_jobs (tenant_id, asset_id, publication_id, connection_id,
    platform, account_id, idempotency_key, content)
  VALUES ('${pg05Tenant}', '${pg05Asset[0].id}', '${pg05Pub[0].id}', '${pg05Conn[0].id}',
    'instagram', 'zacc_pg05', 'pj_key_1', 'Contenido del post')
`;
// (b) upsert idempotente por idempotency_key.
for (let i = 0; i < 2; i++) {
  await db.exec(`${insertPg05Job} ON CONFLICT (idempotency_key) DO NOTHING`);
}
const { rows: pg05Rows } = await db.query(`
  SELECT status, attempts, max_attempts, media_urls FROM publish_jobs WHERE tenant_id = '${pg05Tenant}'
`);
if (pg05Rows.length !== 1 || pg05Rows[0].status !== 'queued' || pg05Rows[0].attempts !== 0 || pg05Rows[0].max_attempts !== 3) {
  console.error(`PG-05: el upsert por idempotency_key no es idempotente o los defaults fallaron: ${JSON.stringify(pg05Rows)}`);
  process.exit(1);
}
// (a) INSERT crudo duplicado debe fallar por la UNIQUE.
let pg05DupRejected = false;
try {
  await db.exec(insertPg05Job);
} catch {
  pg05DupRejected = true;
}
if (!pg05DupRejected) {
  console.error('PG-05: la UNIQUE permitió duplicar idempotency_key');
  process.exit(1);
}
// (d) SET NULL: borrar connection + asset + publication deja el job con las FKs en NULL.
await db.exec(`
  DELETE FROM social_connections WHERE id = '${pg05Conn[0].id}';
  DELETE FROM assets WHERE id = '${pg05Asset[0].id}';
  DELETE FROM publications WHERE id = '${pg05Pub[0].id}';
`);
const { rows: pg05AfterSetNull } = await db.query(`
  SELECT connection_id, asset_id, publication_id FROM publish_jobs WHERE tenant_id = '${pg05Tenant}'
`);
const sn = pg05AfterSetNull[0];
if (!sn || sn.connection_id !== null || sn.asset_id !== null || sn.publication_id !== null) {
  console.error(`PG-05: el ON DELETE SET NULL de las FKs falló: ${JSON.stringify(sn)}`);
  process.exit(1);
}
// (c) cascade: borrar el tenant borra sus jobs.
await db.exec(`DELETE FROM tenants WHERE id = '${pg05Tenant}'`);
const { rows: pg05AfterCascade } = await db.query(`
  SELECT COUNT(*)::int AS n FROM publish_jobs WHERE tenant_id = '${pg05Tenant}'
`);
if (pg05AfterCascade[0].n !== 0) {
  console.error('PG-05: el cascade por tenant no borró los jobs');
  process.exit(1);
}

console.log('OK');
console.log('tablas nuevas:', tableNames.join(', '));
console.log('columnas nuevas:', expectedCols.join(', '));
console.log('columnas N:M:', expectedMembershipCols.join(', '));
console.log('columnas PC-07:', expectedTCols.join(', '));
console.log('enums PC-07:', Object.entries(expectedEnums).map(([k, v]) => `${k}(${v.join('|')})`).join(', '));
console.log('fks PC-07:', expectedFks.join(', '));
console.log('PC-09: guest_dossiers.scheduled_transmission_id (nullable) + FK->scheduled_transmissions + idx');
console.log('tablas PD-01:', pd01Tables.map((r) => r.tablename).join(', '));
console.log('fks PD-01 (cascade):', expectedPd01Fks.join(', '));
console.log('índices PD-01:', expectedPd01Idx.join(', '));
console.log('tablas PD-05:', pd05Tables.map((r) => r.tablename).join(', '));
console.log('fks PD-05:', expectedPd05Fks.map(([c, t, d]) => `${c}->${t}(${d})`).join(', '));
console.log('índices PD-05:', expectedPd05Idx.join(', '));
console.log('tabla PF-04: clip_render_jobs (14 columnas) + FKs cascade + índice del claim (status, run_at)');
console.log('tabla PF-10: assets (12 columnas) + UNIQUE (tenant_id,source_table,ref_id) idempotente + FKs (tenant cascade, parent/tx set null)');
console.log('tabla PG-03: auto_publish_configs (12 columnas) + UNIQUE (tenant_id,program_key) cubre global (__all__) + FKs cascade');
console.log('tablas PG-04: zernio_profiles (1/tenant UNIQUE) + social_connections (11 columnas, UNIQUE tenant+platform+account, FKs cascade, idx tenant+status)');
console.log('tabla PG-05: publish_jobs (23 columnas, UNIQUE idempotency_key, FK tenant cascade + asset/publication/connection SET NULL, índices tenant+status y claim)');
await db.close();
process.exit(0);
