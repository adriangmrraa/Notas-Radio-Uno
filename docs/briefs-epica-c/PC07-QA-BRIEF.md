# PC-07 QA FINAL — read-only, contexto fresco

Revisá el commit `e9d2781` de la rama `pc-07-transmissions-schema` contra la base `e2d4016`. **Read-only**: no modifiques,
no stages, no commitees, no push, no merge, no deploy. `PC07-QA-BRIEF.md` puede quedar untracked.

## Contexto

PC-07 = **schema de transmisiones** (sin UI, sin API): tablas `transmissions` + `scheduled_transmissions` (recurrencia
RRULE) con vínculo a programa, enums `TransmissionSource` / `TransmissionStatus`, migración `0008` idempotente,
asserts nuevas en `scripts/verify-migration-pglite.mjs`, y `src/server/lib/rrule.ts` (parse / nextOccurrence /
describe) con tests.

## Qué auditar

### 1. La migración (idempotencia y no-drift)
- Leé `drizzle/0008_supreme_ghost_rider.sql` completo. ¿Todo es idempotente con el patrón del repo
  (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object ... END $$;`
  para `CREATE TYPE` y constraints)?
- **Reaplicación**: el verificador la aplica 2 veces y da OK — pero verificá **a mano** que no hay statements que
  **no** fallarían al repetirse (ej.: `ALTER TABLE ... ADD CONSTRAINT` sin guarda, `COMMENT`, `INSERT` de seed).
- **No-drift**: `npm run build` imprime "No schema changes, nothing to migrate" ⇒ el snapshot `0008_snapshot.json`
  y `_journal.json` están coherentes con el schema TS.
- ¿La migración **borra** o altera migraciones previas (`0000`..`0007`)? No debe.

### 2. DDL final — coherencia schema↔SQL
Compará `src/server/db/schema/transmissions.ts` + los enums en `src/server/db/schema/enums.ts` contra el SQL:
- `transmissions`: ¿tiene TODAS las columnas del brief (`tenant_id` NOT NULL, `program_id`, `scheduled_transmission_id`,
  `source`, `status`, `stream_url`, `resolved_stream_url`, `crudo_ref`, `duration_minutes`, `started_at`, `ended_at`,
  `waiting_since`, `last_heartbeat_at`, `error_message`, `pipeline_config`, `created_at`, `updated_at`)?
- `scheduled_transmissions`: ¿`tenant_id` NOT NULL, `program_id`, `name`, `description`, `stream_url` NOT NULL,
  `rrule` NOT NULL, `timezone` NOT NULL default, `starts_at` NOT NULL, `ends_at`, `duration_minutes`, `auto_start`,
  `pipeline_config`, `is_active`, `next_run_at`, `last_run_at`, `last_transmission_id`, timestamps?
- **FKs**: ¿`on delete` correctos (`tenant` cascade, `program` set null, `scheduled_transmission` set null,
  `last_transmission` set null)? ¿Hay **ciclo** entre `transmissions.scheduled_transmission_id` y
  `scheduled_transmissions.last_transmission_id`? (Dos FKs cruzadas: comprobá que Postgres las acepta y que el
  borrado no se rompe en cascada infinita.)
- **Índices**: ¿cada FK tiene índice? (El QA de PC-01 ya rechazó FKs sin índice.)
- Enums: ¿`TransmissionStatus` tiene los 7 valores (`scheduled|waiting|live|processing|done|error|canceled`) y
  `TransmissionSource` los 3?
- `src/server/db/schema/index.ts`: ¿las relaciones quedaron bien (sin `ambiguous`)? ¿se exportan las tablas nuevas?

### 3. `rrule.ts` — la lógica de recurrencia
- `parseRRule`: ¿parsea `FREQ`, `INTERVAL`, `BYDAY`, `BYHOUR`, `BYMINUTE`, `BYMONTHDAY`, `UNTIL`, `COUNT`? ¿El
  `BYDAY` acepta los 7 días (MO..SU) **y** las variantes con ordinal (`2FR`)? ¿Lanza error descriptivo con RRULE
  inválido (vacío, sin `FREQ`, día inexistente)?
- `nextOccurrence`: ¿DAILY/WEEKLY/MONTHLY/YEARLY? ¿`INTERVAL`? ¿`UNTIL` vencido ⇒ `null`? ¿`COUNT` agotado ⇒ `null`?
  ¿Devuelve una fecha **estrictamente posterior** a `from`?
- **Timezone (requisito clave)**: ¿la aritmética se hace en la tz indicada y no en la del server? ¿El test BA vs UTC
  lo demuestra de verdad (los dos resultados difieren)?
- `describeRRule`: ¿devuelve texto en español razonable? ¿maneja los casos que no conoce (sin inventar)?
- ¿Hay bugs de **off-by-one** (p.ej.: una ocurrencia que cae exactamente en `from`)? Mirá los bordes: fin de mes,
  cambio de horario de verano (AR DST), año bisiesto.

### 4. Verificador PGlite
- ¿Las asserts nuevas son **reales** (no triviales)? ¿Cubren tablas, columnas, enums y FKs?
- ¿El verificador sigue aplicando **todas** las migraciones (incluida 0008) y **reaplicando** 0008?
- ¿El shim de pgvector (PGlite no lo tiene) sigue intacto?

### 5. Scope
- `scheduled_jobs` / `jobSchedulerService` **NO** tocados.
- **NO** hay UI (`src/client/` sin cambios) ni API/endpoints nuevos.
- No hay `stream_recordings`/`recording_segments`/`transmission_segments`/`person_appearances` (Épica D).
- Sin dependencias nuevas.

### 6. Gates (a completion, exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check e2d4016..HEAD
git status --short
```

## Salida

**GO** o **NO-GO** estricto. CRITICALS primero (archivo:línea + escenario concreto). Después warnings.
Exit codes + línea de resumen de vitest + salida del verificador PGlite. Lo no verificado, explícito.
