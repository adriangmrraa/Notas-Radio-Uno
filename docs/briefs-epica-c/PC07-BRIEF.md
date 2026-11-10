# PC-07 — Schema de transmisiones: `transmissions` + `scheduled_transmissions` (RRULE) + vínculo a programa

Ejecutá este brief **end to end, de forma autónoma**. Nunca esperes aprobación. Si algo del brief es imposible,
NO lo simules: dejalo sin hacer, explicá por qué y seguí con el resto.

## Objetivo del slice

Este slice es **schema + migración real, sin UI**. Prepara el terreno para:
- **PC-08** (agenda UI: crear/editar transmisión programada, auto-start, calendario),
- **ÉPICA D / PD-01..PD-04** (ingesta de video en vivo, scheduler que dispara transmisiones, estados
  `scheduled→waiting→live→processing→done/error`).

El checklist de la épica pide: *"PC-07 Schema transmisiones: `transmissions` + `scheduled_transmissions`
(recurrencia RRULE) + vínculo a programa"*.

## Contexto real (verificado)

- Repo `periodistapp`: **Express 4 + TypeScript + React SPA + Drizzle/Postgres**.
- Base: `origin/master` @ `e2d4016` (PC-01 persons/editorial schema, PC-02 datos, PC-03 personas UI,
  PC-04 rostros, PC-05 línea editorial, PC-06 prompts).
- **Ya existe `scheduled_jobs`** (`src/server/db/schema/jobs.ts`): tabla con `schedule_type` enum
  (`recurring|one_time`), `days_of_week int[]`, `start_time varchar(5)`, `duration_minutes`, `timezone`,
  `scheduled_date date`, `pipeline_config jsonb`, `next_run_at`, `last_run_at`, `last_run_status`, `is_active`,
  y `job_executions`. **NO la modifiques ni la reemplaces**: es el motor de jobs actual.
  `scheduled_transmissions` es una tabla **nueva y distinta**: la *agenda de transmisiones* del canal
  (qué se transmite, de qué programa, con qué recurrencia RRULE).
- **Ya existe `programs`** (`src/server/db/schema/programs.ts`) — leé el archivo para conocer sus columnas
  (`tenant_id`, `name`, `slug`, …) y confirmar los nombres exactos.
- **Ya existe `persons`** (`src/server/db/schema/persons.ts`) con `tenant_id`, `program_id` vía `person_program`.
- Referencia de implementación (rama `gurnard` de este mismo repo, **NO está en master**):
  `C:/Users/Asus/orca/workspaces/periodistapp/gurnard/src/server/db/schema/transmissions.ts` +
  `C:/Users/Asus/orca/workspaces/periodistapp/gurnard/drizzle/0010_transmissions_pipeline_config.sql`.
  **Leelos y adaptá**: esa rama tiene un schema más grande (incluye `stream_recordings`, `recording_segments`,
  `transmission_segments`, que son de la **ÉPICA D**, no de este slice). Tomá de referencia el **patrón**
  (enums, índices, nombres de columnas de `transmissions`), **no** copies el alcance.
- **Patrón de migración idempotente del repo** (mirá `drizzle/0006_epic_c_pc01_context.sql`):
  `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE TYPE` dentro de
  `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  y constraints con `DO $$ ... EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;`.
  El verificador `scripts/verify-migration-pglite.mjs` aplica **todas** las migraciones y las **reaplica** para
  probar idempotencia: **tu migración tiene que pasar ese gate sin error**.

## Qué hay que construir

### 1. `src/server/db/schema/transmissions.ts` (archivo nuevo)

Dos tablas nuevas + los enums que needs. **Diseñá el schema así** (ajustá nombres sólo si el repo obliga):

#### `transmissions` — una corrida/estado de una transmisión
| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | `defaultRandom()` |
| `tenant_id` | uuid **NOT NULL** | FK → `tenants.id` `onDelete: 'cascade'` |
| `program_id` | uuid nullable | FK → `programs.id` `onDelete: 'set null'` — **vínculo a programa** |
| `scheduled_transmission_id` | uuid nullable | FK → `scheduled_transmissions.id` `onDelete: 'set null'` |
| `source` | enum NOT NULL | valores: `live_capture`, `vod_upload`, `manual` |
| `status` | enum NOT NULL default `scheduled` | valores: `scheduled`, `waiting`, `live`, `processing`, `done`, `error`, `canceled` (**son los estados que Épica D va a usar**) |
| `stream_url` | text nullable | URL de origen (HLS/RTMP/YouTube live/upload) |
| `resolved_stream_url` | text nullable | URL final resuelta (la resuelve la ingesta, PC-07 no la resuelve) |
| `crudo_ref` | text nullable | referencia al crudo grabado (lo llena PD-02; lo declarás ahora porque Épica D lo espera) |
| `duration_minutes` | integer nullable | |
| `started_at` / `ended_at` | timestamptz nullable | |
| `waiting_since` | timestamptz nullable | desde cuándo espera el stream (auto-start tardío, PD-03) |
| `last_heartbeat_at` | timestamptz nullable | |
| `error_message` | text nullable | |
| `pipeline_config` | jsonb NOT NULL default `{}` | config del pipeline para esta corrida (tono, estructura, autoPublish…) |
| `created_at` / `updated_at` | timestamptz | |

Índices (mínimo): `(tenant_id, status)`, `(tenant_id, created_at)`, y **un índice en cada FK**
(`program_id`, `scheduled_transmission_id`) — el QA de PC-01 ya rechazó FKs sin índice.

#### `scheduled_transmissions` — la agenda (recurrencia RRULE)
| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid **NOT NULL** | FK → `tenants.id` cascade |
| `program_id` | uuid nullable | FK → `programs.id` `set null` — **vínculo a programa** |
| `name` | varchar(255) NOT NULL | título de la emisión |
| `description` | text nullable | |
| `stream_url` | text NOT NULL | |
| `rrule` | varchar(255) NOT NULL | **recurrencia RRULE en formato iCalendar/RFC 5545**, p.ej. `FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0` |
| `timezone` | varchar(64) NOT NULL default `'America/Argentina/Buenos_Aires'` | IANA — la comparación de "qué día es hoy" se hace en **esta** tz, no en la del server |
| `starts_at` | timestamptz NOT NULL | inicio de la primera emisión |
| `ends_at` | timestamptz nullable | fin de la recurrencia (null = sin fin) |
| `duration_minutes` | integer NOT NULL default 60 | |
| `auto_start` | boolean NOT NULL default true | si el scheduler debe disparar la transmisión solo (PC-08/PD-03) |
| `pipeline_config` | jsonb NOT NULL default `{}` | |
| `is_active` | boolean NOT NULL default true | |
| `next_run_at` | timestamptz nullable | próxima ejecución calculada (lo calcula el scheduler) |
| `last_run_at` | timestamptz nullable | |
| `last_transmission_id` | uuid nullable | FK → `transmissions.id` `set null` — última corrida generada |
| `created_at` / `updated_at` | timestamptz | |

Índices: `(tenant_id, is_active)`, `(tenant_id, next_run_at)`, **índice en cada FK** (`program_id`,
`last_transmission_id`).

#### Enums
- `TransmissionSource`: `live_capture | vod_upload | manual`
- `TransmissionStatus`: `scheduled | waiting | live | processing | done | error | canceled`
Defínelos donde el repo define los enums (`src/server/db/schema/enums.ts` — leé cómo están hechos los demás y
seguí el patrón: `pgEnum` + objeto `const` + `type`).

### 2. Migración real

- Generá la migración con `npx drizzle-kit generate` (o escribila a mano si el generador no cooperra) y
  **asegurate de que el SQL sea idempotente** con el patrón de `0006`/`0007` (IF NOT EXISTS + DO blocks para
  `CREATE TYPE` y constraints). Los enums nuevos deben crearse con el `DO $$ ... duplicate_object ...` pattern.
- Actualizá `drizzle/meta/_journal.json` **y** el snapshot (`drizzle/meta/00XX_snapshot.json`) para que
  `npm run build` (que corre `npx drizzle-kit generate`) siga imprimiendo **"No schema changes, nothing to migrate"**.
  Ese es el gate de no-drift: si el build genera una migración nueva, el snapshot quedó mal.
- **NO** borres ni reescribas `drizzle/0000`..`0007` ni sus snapshots.

### 3. Verificación de la migración

- `node scripts/verify-migration-pglite.mjs` tiene que seguir dando **EXIT 0** (aplica tus tablas y las
  **reaplica** ⇒ idempotencia real).
- **Ampliá el verificador** para que **afirme explícitamente** que las tablas nuevas existen y que las
  columnas clave están (mismo estilo que las asserts que ya hay para `persons`/`editorial_profiles`):
  - `transmissions` existe y tiene `tenant_id`, `program_id`, `scheduled_transmission_id`, `status`, `source`,
    `crudo_ref`, `pipeline_config`.
  - `scheduled_transmissions` existe y tiene `tenant_id`, `program_id`, `rrule`, `timezone`, `starts_at`,
    `auto_start`, `next_run_at`, `last_transmission_id`.
  - Los 2 enums existen con sus valores (`information_schema` / `pg_type`).
  - Las FKs de `transmissions`/`scheduled_transmissions` apuntan a las tablas correctas
    (`information_schema.referential_constraints` / `key_column_usage`).
  Ojo: el verificador corre en **PGlite**, que **no tiene pgvector**: el shim ya existente saltea
  `CREATE EXTENSION vector` y los índices `USING hnsw` y convierte `vector(N)` en `bytea`. Tus tablas no usan
  pgvector, así que no necesitás nada nuevo, pero **no rompas el shim existente**.

### 4. Helper de RRULE (mínimo, testeable) — `src/server/lib/rrule.ts` (nuevo)

El schema guarda el RRULE como texto; hace falta **algo** que lo use, aunque la UI (PC-08) y el scheduler
(PD-03) sean de otros slices. Entregá una función ** pura y testeable**:

- `parseRRule(rrule: string): ParsedRRule` — parsea `FREQ`, `INTERVAL`, `BYDAY`, `BYHOUR`, `BYMINUTE`,
  `BYMONTHDAY`, `UNTIL`/`COUNT` si aparecen. **Tolerante**: si falta `FREQ` o el string está vacío, **lanza un
  error descriptivo** (no devuelve algo silenciosamente incorrecto).
- `nextOccurrence(rrule: string, from: Date, timezone: string): Date | null` — calcula la próxima ocurrencia
  **en la timezone indicada** (IANA). Si la recurrencia ya venció (`UNTIL` pasado, o `COUNT` agotado) ⇒ `null`.
- `describeRRule(rrule: string): string` — descripción en español para la UI (ej. "Todos los lunes, miércoles y
  viernes a las 18:00"). Se usa en PC-08; tiene que ser razonable hoy.

**Regla de implementation importante**: la aritmética de fecha/hora debe hacerse **en la timezone del
tenant/programa**, no en la del server (el server puede correr en UTC). Usá `Intl.DateTimeFormat` con `timeZone`
para expandir/contractear fechas locales (el repo ya usa `Intl.DateTimeFormat` en el scheduler, mirá
`src/server/services/jobSchedulerService.ts` para el patrón).

### 5. Tests (obligatorios)

`npx vitest run` verde. Tests de `rrule.ts` (sin DB):
- `FREQ=DAILY` ⇒ próxima ocurrencia = mañana a la hora indicada.
- `FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0` ⇒ la próxima es el próximo día de esos, a las 18:00.
- `INTERVAL=2` con `FREQ=WEEKLY` ⇒ salta una semana.
- `UNTIL` pasado ⇒ `null`; `COUNT` agotado ⇒ `null`.
- RRULE inválido (vacío, sin `FREQ`, `BYDAY` con día inexistente) ⇒ **error descriptivo**.
- **Timezone**: el mismo RRULE calculado en `America/Argentina/Buenos_Aires` vs `UTC` da **horarios distintos**
  (demuestra que la tz manda). Este test es el que prueba el requisito "comparar en `job.timezone`, no en la TZ
  del server".

### 6. Verificación (exit code real)

```bash
npx tsc --noEmit
npm run build                    # debe imprimir "No schema changes, nothing to migrate"
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

## Fuera de scope (NO lo implementes)

- **PC-08** (agenda UI), **PC-09** (dossier), **PC-10** (onboarding).
- **ÉPICA D**: ingesta de video, `stream_recordings`, `recording_segments`, `transmission_segments`,
  `person_appearances`, el worker del scheduler y los eventos Socket.IO. **Este slice es sólo schema + RRULE.**
- API HTTP de transmisiones, endpoints, UI, auto-start real, worker que dispara. (Podés dejar el schema listo;
  lo demás es de otros slices.)
- No modifiques `scheduled_jobs` ni `jobSchedulerService`.
- No agregues dependencias (vitest ya está).

## Límites duros

- **NO push**, **NO merge** a master, **NO deploy**.
- **NO toques** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`: todo en este worktree.
- **NO uses `git add -A` ni `git add .`**: commit con **paths explícitos**.
- Commit **conventional** (`feat(transmissions): ...`), **sin atribución de IA**, sin `Co-Authored-By`.
- No borres ni reescribas untracked preexistentes (`remotion/package-lock.json`, etc.).
- Si algo es imposible, no lo simules: explicá por qué en el reporte y seguí con el resto.

## Reporte final (obligatorio)

1. SHA del commit + `git show --stat`.
2. Exit code de cada gate + la línea "No schema changes…" del build + la línea de resumen de vitest.
3. El **DDL final** de las 2 tablas (columnas, tipos, nullability, defaults, FKs con `on delete`, índices) —
   en texto plano, para que se pueda revisar sin abrir el repo.
4. La salida del verificador PGlite con las asserts nuevas de las 2 tablas y los 2 enums.
5. Cómo funciona `nextOccurrence` con la timezone (con el ejemplo BA vs UTC).
6. Confirmación de que `scheduled_jobs` y `jobSchedulerService` NO fueron tocados y que no hubo UI ni API.
7. Qué quedó fuera y por qué.
