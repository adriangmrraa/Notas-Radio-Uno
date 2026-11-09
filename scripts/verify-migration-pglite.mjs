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
//    (PD-01 crudo de video) y la 0012 (PD-05 sala en vivo) se aplican dos veces.
for (const tag of ['0005', '0006', '0008', '0009', '0010', '0011', '0012']) {
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
await db.close();
process.exit(0);
