# PC-09 — Dossier de invitados vinculado a la transmisión programada (mejora del existente)

Ejecutá este brief **end to end, de forma autónoma**. Nunca esperes aprobación. Si algo del brief es imposible,
NO lo simules: dejalo sin hacer, explicá por qué y seguí con el resto.

## Objetivo del slice

Hoy el dossier de un invitado está atado a **programa + fecha** (`guest_dossiers.program_id` + `scheduled_date`)
y se genera/consulta por invitado (`GET/POST /api/guests/:id/dossier`). Con la agenda ya existir (PC-07/PC-08:
`scheduled_transmissions` + `transmissions`), el dossier tiene que quedar **vinculado a la transmisión programada**
para que: (a) el equipo sepa **para qué emisión** se preparó, (b) se pueda listar/filtrar por emisión, y
(c) cuando se dispare una transmisión, el dossier de sus invitados quede a mano.

**Scope acotado (2 puntos)**: mejorar el dossier existente, no reescribirlo.

## Contexto real (verificado)

- Repo `periodistapp`: **Express 4 + TypeScript (API) + React SPA (Vite) + Drizzle/Postgres**.
- Base: `origin/master` @ `0b734ab` (PC-01..PC-08 ya integrados, incluido multi-tenant N:M).
- **Schema actual del dossier** (`src/server/db/schema/dossiers.ts`): tabla `guest_dossiers` con
  `id`, `guest_id` (FK `guests.id` cascade, NOT NULL), `tenant_id` (NOT NULL), `program_id` (FK `programs.id`,
  **NOT NULL**), `guest_name` (varchar 200 NOT NULL), `scheduled_date` (**date NOT NULL**), `content` (jsonb),
  `status` (varchar 30, default `'generating'`), `generated_at`, `created_at`.
  Índices: `guest_dossiers_guest_id_idx`, `guest_dossiers_tenant_id_idx`, `guest_dossiers_program_date_idx`.
- **Servicio actual** (`src/server/services/dossierService.ts`, 265 líneas):
  `generateGuestDossier(guestId, tenantId)` (crea la fila `status='generating'` y dispara la generación async),
  `runDossierGeneration(...)` (web search + IA → `content` jsonb con `summary`, `bio`, `recentActivity`,
  `controversies`, `suggestedQuestions`, `keyFacts`, `relatedTopics`, `talkingPoints`),
  `getLatestDossier(guestId, tenantId)`, `listDossiers(tenantId, { programId?, date? })`,
  `initDossierScheduler()` (chequeo horario automático).
- **Rutas actuales** (`src/server/routes/guests.ts`): `GET /api/guests/:id/dossier`, `POST /api/guests/:id/dossier`,
  `GET /api/dossiers` (filtros `programId`, `date`).
- **UI actual**: `src/client/pages/ProgramsPage.tsx` tiene el componente `DossierPanel({ guestId, guestName })`
  (tabs "datos"/"dossier" en el diálogo de invitado), con polling del estado `generating`, botón generar/regenerar,
  y la vista completa del dossier.
- **Ya existe** (PC-07/PC-08): `scheduled_transmissions` (agenda, con `program_id`, `name`, `starts_at`,
  `timezone`, `rrule`, `auto_start`) y `transmissions` (corridas, con `scheduled_transmission_id`, `program_id`,
  `status`, `stream_url`), y la API `/api/transmissions/scheduled` (listado por mes, con `occurrences`) +
  `POST /api/transmissions/scheduled/:id/start` (disparo manual que crea la fila en `transmissions`).
- **IMPORTANTE**: el schema de `guest_dossiers` **exige** `program_id` y `scheduled_date` NOT NULL, y `guest_id`
  NOT NULL (FK a `guests`). El invitado legacy sigue siendo la fuente de verdad de "quién es el invitado"
  (PC-02 migró `guests` → `persons` con `guests.person_id` como puente, pero la tabla `guests` **sigue existiendo**
  y `guest_dossiers.guest_id` apunta a ella).

## Decisiones de diseño (aplicalas)

1. **Vinculación**: agregá `scheduled_transmission_id` (uuid, **nullable**, FK → `scheduled_transmissions.id`
   `on delete: 'set null'`) a `guest_dossiers`, con su índice. Es nullable porque: (a) hay dossiers preexistentes,
   (b) un dossier puede generarse sin emisión (invitado que viene pero no está en agenda).
   Cuando el dossier **sí** está atado a una emisión, la fila lo dice.
2. **Migración**: nueva migración Drizzle **idempotente** (patrón `drizzle/0006`/`0008`: `ALTER TABLE ... ADD COLUMN
   IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, y el FK con `DO $$ ... EXCEPTION WHEN duplicate_object OR
   duplicate_table THEN NULL; END $$;`). Actualizá `_journal.json` y el snapshot para que `npm run build` siga
   imprimiendo **"No schema changes, nothing to migrate"**.
3. **No romper lo existente**: `guest_dossiers.program_id` y `scheduled_date` **siguen NOT NULL** — no los
   relaxes (romperías el flujo legacy de dossier por fecha).
4. **Endpoint de generación**: `POST /api/guests/:id/dossier` acepta ahora un body opcional
   `{ scheduledTransmissionId?: string }`. Si viene:
   - la transmisión programada debe existir **y ser del tenant** ⇒ si no, **404**;
   - su `program_id` (si tiene) debe coincidir con el `program_id` del invitado ⇒ si no, **400** con mensaje claro;
   - se guarda `scheduled_transmission_id` en la fila del dossier.
   Si no viene, el comportamiento es **exactamente el de hoy** (dossier por invitado, sin emisión).
5. **Consulta**: `GET /api/guests/:id/dossier` devuelve la fila con `scheduledTransmissionId` (y, si el dossier
   tiene emisión, también el **nombre de la emisión** y la **programa**, para que la UI muestre "Para: <emisión>").
   `GET /api/dossiers` acepta un filtro nuevo `?scheduledTransmissionId=` (además de `programId` y `date`).
6. **Vínculo con la corrida**: cuando se dispara una transmisión (`POST /api/transmissions/scheduled/:id/start`),
   las filas de `transmissions` quedanLinked. **No** hace falta tocar ese endpoint para este slice: el vínculo
   dossier→emisión se hace por `scheduled_transmission_id`, que es **estable** entre corridas (varias corridas
   pueden salir de la misma entrada de agenda). Documentá esa decisión.
7. **UI**: en `DossierPanel` (ProgramsPage), cuando el dossier tiene emisión, mostrá **a qué emisión pertenece**
   (nombre + fecha/hora de la emisión en su timezone). Y **permití elegir la emisión** al generar: un selector
   con las entradas de agenda del programa del invitado (usá `GET /api/transmissions/scheduled` y filtrá por
   `programId`), con una opción "(sin emisión)".
   Ojo: `ProgramsPage.tsx` es un archivo grande que también usa el slice de Personas/Agenda — **tocá lo mínimo**
   (el `DossierPanel` y lo justo para el selector).
8. **Aislamiento**: toda query filtra por `tenant_id` del `req.auth`. El `tenant_id` nunca viene del body.

## Qué hay que construir

### A. Schema + migración
- `src/server/db/schema/dossiers.ts`: agregar `scheduledTransmissionId` + FK + índice.
- Migración nueva (el número lo decide drizzle-kit: debería ser `0009_*` o el que siga; **no renumeres** las
  migraciones existentes) con el patrón idempotente del repo.
- **Ampliá `scripts/verify-migration-pglite.mjs`** con asserts de la columna nueva y de la FK
  (`scheduled_transmissions`), y agregá la migración nueva al loop de reaplicación (idempotencia).

### B. Servicio (`dossierService.ts`)
- `generateGuestDossier(guestId, tenantId, scheduledTransmissionId?)`: acepta el vínculo opcional, lo valida
  (existe + del tenant + programa compatible) y lo persiste.
- `getLatestDossier(guestId, tenantId)`: devolvé también el nombre de la emisión y el nombre de la programa
  (join con `scheduled_transmissions` y `programs`), filtrando por tenant.
- `listDossiers(tenantId, filters)`: soporte `scheduledTransmissionId` como filtro adicional.

### C. Rutas (`routes/guests.ts`)
- `POST /api/guests/:id/dossier`: parsear el body opcional y pasar el vínculo; **404** si la transmisión es ajena,
  **400** si el programa no coincide.
- `GET /api/guests/:id/dossier`: devolver los campos nuevos.
- `GET /api/dossiers`: filtro `scheduledTransmissionId`.

### D. UI (`ProgramsPage.tsx` — sólo el `DossierPanel` y lo mínimo)
- Mostrar "Para: <emisión> (<fecha>)" cuando el dossier tiene emisión.
- Selector de emisión al generar/regenerar (opciones = agenda del programa del invitado + "(sin emisión)").

### E. Tests
`npx vitest run` verde. Tests de lo testeable sin DB:
- La **validación del vínculo** (existe/tenant/programa) como función pura testeable: extraé la regla a una función
  (p.ej. `assertDossierTransmissionLink({ guestProgramId, transmission })`) y testea: transmisión de otro tenant ⇒
  error de "no encontrada"; programa distinto ⇒ error de "programa incompatible"; misma ⇒ OK.
- Si el repo tiene forma de testear queries con store inyectable (como en PC-04/PC-05), cubrí que el listado por
  `scheduledTransmissionId` filtra por tenant.

## Verificación (exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

`npm run build` debe seguir imprimiendo **"No schema changes, nothing to migrate"**.
Ojo: el runner PGlite puede fallar con `stdin is not a tty` de forma transitoria; si pasa, re-corré y reportá la
corrida que terminó.

## Fuera de scope (NO lo implementes)

- **PC-10** (onboarding wizard).
- El worker/scheduler que dispara transmisiones (PD-03, Épica D), los estados en vivo, Socket.IO, la ingesta y
  el crudo.
- **No** regeneres ni reescribas el prompt del dossier ni el contenido: el dossier sigue generándose igual
  (web + IA). Este slice sólo lo **vincula** y lo **exibe**.
- No toques `scheduled_jobs` / `ScheduledJobsPage` / `jobSchedulerService`, ni `ProgramsPage` más allá del
  `DossierPanel` (o lo mínimo indispensable para el selector).
- No agregues dependencias.

## Límites duros

- **NO push**, **NO merge** a master, **NO deploy**.
- **NO toques** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`: todo en este worktree.
- **NO uses `git add -A` ni `git add .`**: commit con **paths explícitos**.
- Commit **conventional** (`feat(dossier): ...`), **sin atribución de IA**, sin `Co-Authored-By`.
- No borres ni reescribas untracked preexistentes.
- Si algo es imposible, no lo simules: explicá por qué en el reporte y seguí con el resto.

## Reporte final (obligatorio)

1. SHA del commit + `git show --stat`.
2. Exit code de cada gate + la línea "No schema changes…" del build + línea de resumen de vitest.
3. El DDL de la columna nueva + FK + índice, y la salida del verificador PGlite con las asserts nuevas.
4. Endpoints: qué cambió en cada uno (body nuevo, códigos de estado, mensajes).
5. Cómo se ve el vínculo en la UI y qué pasa si el dossier no tiene emisión.
6. Cómo se comprueba el aislamiento multi-tenant (qué query filtra por tenant).
7. Qué quedó fuera y por qué.
