# PD-01/D-1 — Schema del crudo + storage adapter (base de PD-02)

Ejecutá este brief **end-to-end, de forma totalmente autónoma**. No esperes aprobación de nadie.
Nunca dejes la tarea a medias: si un gate falla, arreglalo antes de reportar.

## Contexto del repo

- Worktree: `C:/Users/Asus/orca/workspaces/periodistapp/pd-01-raw-storage`
- Rama: `pd-01-raw-storage`, base `origin/master` @ `c5507ee` (ÉPICA C ya integrada).
- Stack: **Express 4 + TypeScript + React 19 SPA + Drizzle ORM + Postgres (Neon)**. ESM (`"type": "module"`).
- Migraciones Drizzle en `drizzle/*.sql` + snapshots en `drizzle/meta/`.
- Tests: `vitest` en `tests/*.test.ts`.

**Leer ANTES de escribir código** (obligatorio):
1. `src/server/db/schema/transmissions.ts` — tablas `transmissions` y `scheduled_transmissions` (ya existen; NO las modifiques salvo que el brief lo pida).
2. `src/server/db/schema/enums.ts` — `TransmissionStatus` (7 valores) y `TransmissionSource` (3 valores).
3. `src/server/db/schema/index.ts` — cómo se exportan las tablas y cómo se declaran las `relations`.
4. `src/server/db/schema/billing.ts` — tabla `plans` (ya tiene `rawRetentionDays` → columna `raw_retention_days`).
5. `src/server/db/schema/clips.ts` — ejemplo de tabla simple con `tenantId` + índices.
6. `drizzle/0008_supreme_ghost_rider.sql` — ejemplo de migración idempotente de este repo (enums + tablas + índices).
7. `drizzle/0010_pc09_dossier_transmission.sql` — ejemplo de migración con FK sobre tabla existente.
8. `scripts/verify-migration-pglite.mjs` — el verificador PGlite que hay que extender.
9. `src/server/db/schema/persons.ts` — ejemplo de tabla con FK circular/compleja.

## Objetivo

Crear la **capa de persistencia del crudo de video** que después consumirá el recorder (slice siguiente):
`stream_recordings` + `recording_segments`, su migración Drizzle idempotente, y un **storage adapter** genérico
(filesystem primero) para escribir/leer/borrar segmentos.

Este slice es **schema + storage, NO captura** (no ejecutes ffmpeg/yt-dlp todavía).

## 1. Schema Drizzle — `src/server/db/schema/recordings.ts`

Exactamente este diseño (los nombres de columna físicos están en snake_case; las claves TS en camelCase):

### `stream_recordings`
| Columna TS | Columna SQL | Tipo | Notas |
|---|---|---|---|
| `id` | `id` | `uuid` PK defaultRandom | |
| `tenantId` | `tenant_id` | `uuid` NOT NULL | FK → `tenants.id` ON DELETE CASCADE, con índice |
| `transmissionId` | `transmission_id` | `uuid` NOT NULL | FK → `transmissions.id` ON DELETE CASCADE, UNIQUE (1 grabación por transmisión) |
| `storagePrefix` | `storage_prefix` | `text` NOT NULL | raíz de storage, ej. `{tenantId}/{transmissionId}` |
| `status` | `status` | `varchar(20)` NOT NULL default `'recording'` | valores: `'recording' \| 'completed' \| 'error'` |
| `totalBytes` | `total_bytes` | `bigint` NOT NULL default `0` | |
| `startedAt` | `started_at` | `timestamp({withTimezone:true})` NOT NULL defaultNow | ancla wall-clock |
| `endedAt` | `ended_at` | `timestamp({withTimezone:true})` | null mientras graba |
| `createdAt` / `updatedAt` | `created_at` / `updated_at` | `timestamp({withTimezone:true})` NOT NULL defaultNow | `updatedAt` con `$onUpdateFn` |

Índices: `stream_recordings_tenant_id_idx` (tenantId), `stream_recordings_transmission_id_idx` (transmissionId).
La UNIQUE de `transmission_id` ya crea índice — no dupliques.

### `recording_segments`
| Columna TS | Columna SQL | Tipo | Notas |
|---|---|---|---|
| `id` | `id` | `uuid` PK defaultRandom | |
| `tenantId` | `tenant_id` | `uuid` NOT NULL | FK → `tenants.id` ON DELETE CASCADE, con índice |
| `recordingId` | `recording_id` | `uuid` NOT NULL | FK → `stream_recordings.id` ON DELETE CASCADE |
| `sequence` | `sequence` | `integer` NOT NULL | UNIQUE junto a `recording_id` |
| `startMs` | `start_ms` | `bigint` NOT NULL | offset wall-clock relativo al `startedAt` de la grabación |
| `endMs` | `end_ms` | `bigint` | null = segmento aún escribiendo |
| `fileRef` | `file_ref` | `text` NOT NULL | clave relativa dentro del storage, ej. `seg-00001.mp4` |
| `bytes` | `bytes` | `bigint` NOT NULL default `0` | |
| `status` | `status` | `varchar(20)` NOT NULL default `'active'` | valores: `'active' \| 'corrupt' \| 'purged'` |
| `createdAt` | `created_at` | `timestamp({withTimezone:true})` NOT NULL defaultNow | |

Índices: `recording_segments_tenant_id_idx` (tenantId), `recording_segments_recording_id_idx` (recordingId),
`recording_segments_recording_id_start_ms_idx` (recordingId, startMs) — este último es el lookup de ventana de clip.
UNIQUE `(recording_id, sequence)`.

**Requisitos duros del schema:**
- `tenantId` **NOT NULL** en las dos tablas. `tenant_id` en toda query nueva — sin excepciones.
- Cada FK tiene su índice (el QA de ÉPICA C rechazó FKs sin índice).
- `bigint` para `startMs`/`endMs`/`bytes`/`totalBytes` (en Drizzle pg-core es `bigint('start_ms', { mode: 'number' })` — **verificá el modo que usa el repo** en `customTypes.ts`/otras tablas y sé consistente; si el repo usa `mode: 'number'` usalo, si usa `mode: 'bigint'` usalo).

**NO agregues** en este slice: `transmission_segments`, `person_appearances`, `assets`, ni ninguna otra tabla — son de otras épicas.

## 2. Integración con el schema existente

- `src/server/db/schema/index.ts`: exportá `export * from './recordings.js';` y agregá las tablas nuevas al import de relaciones + las `relations` correspondientes (`tenantsRelations.many(streamRecordings)`, `tenantsRelations.many(recordingSegments)`, `transmissionsRelations.one(streamRecording)` con `relationName` si hace falta, `streamRecordingsRelations.one(transmission)`, `streamRecordingsRelations.many(recordingSegments)`, `recordingSegmentsRelations.one(recording)`).
  - Ojo: `transmissions` ↔ `stream_recordings` es 1-a-1 (UNIQUE en `transmission_id`). Usá `relationName` explícito si Drizzle lo pide para no ambiguar.
- `src/server/db/schema/recordings.ts` es un archivo NUEVO. No toques `transmissions.ts`.

## 3. Migración Drizzle

- Generala con `npx drizzle-kit generate` (NO la escribas a mano) y renombrá el archivo a `0011_pd01_recordings.sql` (si `drizzle-kit` genera `0011_<random>`, renombrá el `.sql` **y** actualizá `drizzle/meta/_journal.json` con el mismo `tag`, y renombrá el snapshot para que quede consistente con el tag).
- **La migración tiene que ser IDEMPOTENTE**, con el patrón del repo:
  - `CREATE TABLE IF NOT EXISTS`
  - `CREATE INDEX IF NOT EXISTS`
  - `CREATE TYPE` → `DO $$ BEGIN CREATE TYPE ...; EXCEPTION WHEN duplicate_object THEN NULL; END $$;` (con `;` antes de `EXCEPTION`)
  - `ALTER TABLE ... ADD CONSTRAINT` → mismo DO block, `EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;` (**con `;` antes de `EXCEPTION`**)
  - Separador de statements: `--> statement-breakpoint`
- No debe alterar ni borrar migraciones previas (`0000`..`0010`).
- `npm run build` debe terminar con **"No schema changes, nothing to migrate"** (o generar exactamente una migración nueva y que el snapshot quede en sync — no dejes drift).

## 4. Storage adapter — `src/server/services/rawStorageService.ts`

Interfaz chica y testeable, sin dependencia de AWS (esa parte es del slice siguiente / futuro):

```ts
export interface RawStorage {
  writeFile(key: string, data: Buffer): Promise<void>;
  appendFile?(key: string, data: Buffer): Promise<void>;   // opcional
  readFile(key: string): Promise<Buffer>;
  statFile(key: string): Promise<{ size: number } | null>;
  deleteFile(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  publicPath(key: string): string;   // ruta/URL servible del archivo
}
```

Implementación `FilesystemRawStorage`:
- Raíz: `process.env.STORAGE_ROOT` o `<repoRoot>/data/raw` (resolvé el repo root como lo hacen `transcriptionService.ts` / `clipService.ts`: `path.resolve(__dirname, '..','..','..')`).
- `key` es una ruta relativa tipo `{tenantId}/{transmissionId}/seg-00001.mp4`. **Sanitizá el `key`**: rejeitá `..`, separadores absolutos y cualquier cosa que pueda escapar de la raíz (path traversal). Devolvé error descriptivo si es inválido.
- `writeFile` crea los directorios padre (`mkdir -p`).
- `deletePrefix` borra recursivamente y no falla si no existe.
- `publicPath` devuelve la ruta absoluta bajo la raíz.

Factory: `getRawStorage(): RawStorage` que devuelve la implementación filesystem. Dejá el punto de extensión para S3/R2 (interfaz, no implementación) — **NO agregues dependencias nuevas al package.json**.

## 5. Tests — `tests/rawStorageService.test.ts`

Usá `vitest`. Cubrí con casos REALES:
- `writeFile` + `readFile` round-trip.
- `statFile` devuelve el tamaño correcto; devuelve `null` si no existe.
- `exists`.
- `deleteFile` + `exists` falso después.
- `deletePrefix` borra todos los archivos del prefijo y **no** toca archivos de otro prefijo (usá un tmp dir por test con `fs.mkdtemp`).
- **Path traversal rejected**: `writeFile('../evil.txt', ...)` y `writeFile('/abs/evil.txt', ...)` lanzan error y NO escriben fuera de la raíz. Este test es OBLIGATORIO.
- `publicPath` devuelve algo bajo la raíz.

Para los tests usá un `tmpdir` real (os.tmpdir() / `fs.mkdtemp`), NO una ruta dentro del repo — el repo tiene `output/` y `data/` con datos del usuario, no los toques.

## 6. Verificador PGlite — extender `scripts/verify-migration-pglite.mjs`

- Agregá asserts REALES (no triviales) que comprueben:
  - Que existen las tablas `stream_recordings` y `recording_segments`.
  - Sus columnas clave con los tipos correctos (`tenant_id` NOT NULL, `transmission_id` UNIQUE, `start_ms` bigint, `file_ref` text NOT NULL, `status` con los default esperados).
  - Las FKs: `stream_recordings.transmission_id` → `transmissions(id)`, `recording_segments.recording_id` → `stream_recordings(id)`, y que `tenant_id` → `tenants(id)` en ambas.
  - Los índices nuevos existen.
- La migración nueva debe **reaplicarse** (idempotencia) — agregala a la lista de migraciones que se aplican 2 veces (mirá cómo el script ya lo hace con `0005`/`0006`/`0008`/`0009`).
- El verificador debe imprimir un resumen claro al final.

## 7. Gates — TODOS tienen que dar EXIT 0 real

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
```

**Criterio de "hecho"**: los 5 de arriba con exit code 0, y en la salida de `npm run build` el `drizzle-kit generate` **sin** generar una migración nueva inesperada (o, si la genera, que sea exactamente la de este slice y esté consistente con el snapshot). Un gate que no imprime su línea de resumen NO está verificado — reportá el exit code real y la línea de resumen en tu informe final.

## 8. Commit

- **UN solo commit** al final, cuando todos los gates estén verdes.
- Conventional Commits. Mensaje en español, sin atribución a IA, sin `Co-Authored-By`, sin "Generated with".
  - Sugerido: `feat(recordings): schema del crudo de video con storage adapter`
- **Paths explícitos**, nunca `git add -A` / `git add .`:
  ```
  git add src/server/db/schema/recordings.ts src/server/db/schema/index.ts \
          src/server/services/rawStorageService.ts tests/rawStorageService.test.ts \
          scripts/verify-migration-pglite.mjs drizzle/0011_pd01_recordings.sql \
          drizzle/meta/_journal.json drizzle/meta/0011_snapshot.json
  ```
  (ajustá los nombres si difieren, pero listá los paths explícitamente).
- **NO** hagas `git push`, **NO** hagas merge, **NO** hagas deploy.
- `remotion/package-lock.json` aparece como untracked en este worktree: **NO lo agregues al commit** (es residuo del setup).

## 9. Informe final (obligatorio, en español)

Reportá:
1. Archivos creados/modificados (paths).
2. El **exit code real** de cada uno de los 5 gates + la línea de resumen de vitest + la salida final del verificador PGlite.
3. La salida de `npm run build`: qué imprimió `drizzle-kit generate` (¿"No schema changes"?).
4. El SHA del commit.
5. `git status --short` final (debe estar limpio salvo `remotion/package-lock.json`).
6. Cualquier límite o supuesto que hayas tomado, explícito.

No inventes resultados: si un gate no lo pudiste correr, decilo. Nada de "debería funcionar".
