# BRIEF — ÉPICA I / PI-01: Cola de jobs (Postgres MVP) con reintentos + dead-letter + panel de jobs

**KANBAN_TASK_ID**: `t_1da234af` (PeriodistApp — ÉPICA I: Robustez, observabilidad y lanzamiento)
**Base**: `1b06da1` (cúspide de `origin/ph-07-responsive` — incluye ÉPICA G + PH-01..07)
**NO partir de `73b043a` (master) ni de `ba5d2af`.**
**Branch**: `periodistapp/t_1da234af-periodistapp-epica-i-robustez-observabilidad-y-lanzamiento`
**Worktree**: `C:/Users/Asus/Documents/estabilizacion/periodistapp/.worktrees/t_1da234af`

> OJO: el `BRIEF.md` de la raíz de este worktree es **stale** (describe la ÉPICA F / PF-10, ya
> integrada en master). **Este archivo es el brief válido de esta tarjeta.** No ejecutes PF-10.

---

## 1. Objetivo de este slice (PI-01, primer `- [ ]` de la ÉPICA I)

Cola de jobs en **Postgres (MVP)** con **reintentos** y **dead-letter**, más un **panel de jobs
en el admin**. Decisión de diseño ya tomada (D-6, no se reabre): la cola es una **tabla Postgres**,
no un broker externo. La extracción a workers/cola dedicada sólo se reconsidera si aparecen
>10–20 streams simultáneos.

## 2. Estado real del repo (VERIFICADO el 2026-11-11 — no re-descubrir, no re-implementar)

Ya existen y **NO se tocan** en este slice:

| Pieza | Dónde | Por qué NO se toca |
|---|---|---|
| `scheduled_jobs` + `job_executions` | `src/server/db/schema/jobs.ts` | Jobs **recurrentes** de programación de transmisiones, NO son cola de trabajo. |
| `publish_jobs` (cola Zernio) | `src/server/db/schema/publishJobs.ts` + `publishJobService.ts` + `publishWorker.ts` | Cola **de dominio** (publicación). Ya tiene `attempts`/`max_attempts`, pero **sin dead-letter** y sin panel. Fuera de alcance. |
| `clip_render_jobs` (cola de render) | `src/server/db/schema/renderJobs.ts` + `clipRenderQueueService.ts` + `clipRenderWorker.ts` | Cola **de dominio** (render). Ídem. Fuera de alcance. |
| Purga de crudo | `rawRetentionService.ts` → `purgeExpiredRecordings(now, { tenantId, dryRun })` | Servicio existente, ya tenant-scoped. **PI-01 lo USA como handler real** de la cola (ver §3.6), no lo reescribas. |
| Panel admin | `src/client/pages/admin/{AdminLayout,AdminTenants,AdminPlans}.tsx` + `src/server/routes/admin.ts` | Patrón a replicar para el panel de jobs. |
| Estados compartidos | `src/client/components/feedback/{EmptyState,LoadingState,ErrorState}.tsx`, `src/client/hooks/useAsyncData.ts` | Contrato PH-05. **Usarlos, no reimplementar try/catch.** |
| Tabla responsive | `src/client/components/ResponsiveTable.tsx` | Contrato PH-07. **Usarla** en la tabla del panel. |

**Lo que NO existe y este slice construye**: una cola **genérica** (`job_queue`) con reintentos +
dead-letter, expuesta por API tenant-scoped, visible y operable desde el panel de admin.

**OJO — no existe RLS en este repo** (0 hits de `ROW LEVEL SECURITY` / `CREATE POLICY`). El
aislamiento es **por `tenant_id` en la query**. Eso es lo que este slice garantiza.

## 3. Alcance (lo que entra en PI-01)

### 3.1 Schema — `src/server/db/schema/jobQueue.ts` (tabla nueva `job_queue`)

- `id` uuid PK `defaultRandom()`
- `tenant_id` uuid NOT NULL FK `tenants.id` **ON DELETE CASCADE** + índice
- `kind` varchar(64) NOT NULL — discriminador del tipo de job (`'retention.purge'`, y extensible)
- `status` varchar(20) NOT NULL default `'pending'` — **exactamente** estos valores:
  `'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled'`
  (varchar, NO enum de DB — para poder agregar estados sin migración; es la convención de
  `clip_render_jobs` y `publish_jobs`)
- `payload` jsonb NOT NULL default `{}`
- `attempts` integer NOT NULL default 0
- `max_attempts` integer NOT NULL default 5
- `run_at` timestamptz NOT NULL defaultNow — **gate del claim** (el backoff lo posterga; la query
  del claim es `status='pending' AND run_at <= now`; convención de `clip_render_jobs`)
- `started_at`, `finished_at`, `dead_lettered_at` timestamptz (nullable)
- `last_error` text, `error_category` varchar(32)
- `created_at`, `updated_at` timestamptz NOT NULL defaultNow (patrón repo con `$onUpdateFn`)
- Índices: `(tenant_id, status)`, `(status, run_at)` (query del claim), `(tenant_id, created_at)`

**Exportá la tabla en `src/server/db/schema/index.ts`** — sin eso `drizzle-kit generate` no la ve.

### 3.2 Migración `0020_*` (generada + idempotente)

- `npx drizzle-kit generate` → produce `drizzle/0020_<nombre>.sql` + `drizzle/meta/0020_snapshot.json`.
- **Editá a mano el SQL generado para que sea IDEMPOTENTE** (convención del repo, ver skill
  `periodistapp-gates`): `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
  Sin esto, el verificador pglite falla al re-aplicar la migración.
- `drizzle/meta/0020_snapshot.json` **también va commiteado** (si no, `npm run build` regenera
  drift y el gate falla).
- Agregá una **sección nueva** (la siguiente del `scripts/verify-migration-pglite.mjs`, que hoy
  llega hasta la 20) que verifique: tabla `job_queue` existe, columnas clave con tipo/nullabilidad,
  FK a `tenants` **ON DELETE CASCADE**, índices presentes, y que la migración es **idempotente**
  (re-aplicarla). Mismo estilo que las secciones 18/19/20 del script.
- **NO apliques la migración a ninguna base real.** Sólo pglite local.

### 3.3 Servicio — `src/server/services/jobQueueService.ts`

Patrón **Store** del repo (copiá la forma de `clipRenderQueueService.ts`):

- Interface `JobQueueStore` + `createDrizzleJobQueueStore(executor: Database = db)` +
  `createJobQueueService(store)` con un singleton exportado `jobQueueService`.
- Operaciones (todas con el mismo WHERE que el drizzle):
  - `enqueue({ tenantId, kind, payload, maxAttempts? })`
  - `claimNext(tenantId, now)` → claim **atómico y tenant-scoped** (ver §3.4)
  - `markSucceeded(jobId, tenantId)`
  - `markFailed(jobId, tenantId, error, { category?, retryAt? })` → si `attempts < max_attempts`
    vuelve a `'pending'` con `run_at = retryAt` + `last_error`; si no, queda `'dead'` terminal +
    `dead_lettered_at` + `last_error` preservado
  - `retry(jobId, tenantId)` → desde `'dead'`/`'failed'`/`'cancelled'` → `'pending'`, `attempts=0`,
    `run_at=now`, `last_error=null`, `dead_lettered_at=null`; otro estado → `null` (no-op)
  - `cancel(jobId, tenantId)` → desde `'pending'`/`'running'` → `'cancelled'` + `finished_at`
  - `getById(jobId, tenantId)`
  - `listByTenant(tenantId, { status?, kind?, limit, offset })` → `{ jobs, total }`
  - `listDeadLetters(tenantId, { limit, offset })`
  - `countByStatus(tenantId?)` → `Record<status, number>`
- **Backoff determinista y testeable**, función pura exportada:
  `backoffMs(attempt) = min(60_000 * 2 ** (attempt - 1), 3_600_000)` (60 s, 2 min, 4 min, … tope 1 h).
- `kind` y `status` validados contra listas de constantes exportadas (`JOB_QUEUE_KINDS`,
  `JOB_QUEUE_STATUSES`); un `kind` o `status` inválido debe producir error 400 en la API.

### 3.4 REGLA `tenant_id` — sin excepciones (inviolable)

**TODA query de la cola filtra por `tenant_id`.** Incluido el claim:

- `claimNext(tenantId, now)` → `WHERE tenant_id = $tenant AND status='pending' AND run_at <= now`.
- El worker **no** adivina el tenant: recorre los tenants (lectura de la tabla `tenants`, que es
  identidad de plataforma, no dato de negocio) y claimea por tenant. Documentá esto en el docblock.
- Atómico sin `FOR UPDATE SKIP LOCKED` (mismo patrón que `clipRenderQueueService.claimNext`):
  select de la candidata + `UPDATE ... WHERE id=$id AND status='pending' AND tenant_id=$tenant`;
  si otro worker ganó la carrera, el UPDATE hace 0 filas → se prueba la siguiente candidata
  (máx 3 intentos).
- Un `job_id` de otro tenant ⇒ **`null` / 404**, nunca el dato ajeno.

### 3.5 API — tenant-scoped `src/server/routes/jobQueue.ts` (montada en `/api/job-queue`)

Guards: `requireAuth` en cada ruta. `tenantId` sale **siempre** de `req.auth!.tenantId`, nunca del
body. Patroná el archivo con `src/server/routes/publishJobs.ts` (helper `handleError`, `AppError`,
UUID_RE, `isXxxStatus`).

| Método | Ruta | Body / query | Respuesta |
|---|---|---|---|
| GET | `/api/job-queue` | `status?`, `kind?`, `limit?` (1..200, def 50), `offset?` | `200 { jobs, total }` |
| GET | `/api/job-queue/:id` | — | `200 { job }` · `404 { error, code:'job_not_found' }` · `400 { error }` (uuid inválido) |
| POST | `/api/job-queue` | `{ kind, payload?, maxAttempts? }` | `202 { job }` · `400 { error, code:'invalid_kind' }` |
| POST | `/api/job-queue/:id/retry` | — | `200 { job }` · `404` · `409 { error, code:'invalid_transition' }` |
| POST | `/api/job-queue/:id/cancel` | — | `200 { job }` · `404` · `409 { error, code:'invalid_transition' }` |

**Shape de la fila que viaja al cliente** (idéntico en tenant API y admin API):
`{ id, tenantId, kind, status, payload, attempts, maxAttempts, runAt, startedAt, finishedAt,
deadLetteredAt, lastError, errorCategory, createdAt, updatedAt }`

### 3.6 Worker — `src/server/services/jobQueueWorker.ts`

- Registro de handlers **extensible**: `registerJobHandler(kind, handler)` + mapa por `kind`.
- `tick()` claimea **un** job por tenant y lo despacha. Determinista: `now` y `backoffMs`
  inyectables; **sin timers propios en los tests** (`worker.tick()` se llama a mano, patrón de
  `publishWorker`/`clipRenderWorker`).
- Handler seed real (el único): `kind='retention.purge'` → llama
  `purgeExpiredRecordings(now, { tenantId: job.tenantId, dryRun: false })`.
  Esto le da a la cola **un consumidor real** (no una tabla huérfana) y reutiliza código existente.
- Éxito → `markSucceeded`. Error → `markFailed` con backoff; al agotar `max_attempts` → `'dead'`.
- `initJobQueueWorker(io)` / `stopJobQueueWorker()`, con **env-guard
  `JOB_QUEUE_WORKER_ENABLED !== "0"`** en `src/server/index.ts` (mismo patrón que
  `RENDER_WORKER_ENABLED` / `PUBLISH_WORKER_ENABLED`).
- `initJobQueueWorker` se llama en `src/server/index.ts` **dentro del bloque del env-guard**, y el
  router `jobQueueRouter` se monta con `app.use("/api/job-queue", jobQueueRouter)`.

### 3.7 Panel de jobs en admin

**API admin** (`src/server/routes/admin.ts`, que ya tiene `requireAuth + requirePlatformAdmin` en el
`use` del router + `mutationLimiter` + helper `fail()`):

| Método | Ruta | Query | Respuesta |
|---|---|---|---|
| GET | `/api/admin/jobs` | `status?`, `kind?`, `tenantId?`, `limit?` (1..200, def 50), `offset?` | `200 { jobs, total, counts }` |
| POST | `/api/admin/jobs/:id/retry` | — | `200 { job }` · `404` · `409 { error, code:'invalid_transition' }` |

- `counts` = `Record<status, number>` (conteos por estado sobre el filtro aplicado).
- Es **cross-tenant por definición** (igual que `adminService.ts`: el guard es
  `requirePlatformAdmin`, no `tenant_id`). Documentalo en el docblock del handler.
- **Auditoría**: cada mutación llama `recordAuditEvent` (o `auditFromRequest`) con una acción
  **NUEVA** en `AUDIT_ACTIONS` de `src/server/services/auditService.ts`:
  `ADMIN_JOB_REQUEUED: 'admin.job_requeued'`. Usá `actor(req)` + `requestIp(req)` como el resto del
  router admin.

**Vista React** — `src/client/pages/admin/AdminJobs.tsx` (nuevo):

- Ruta `<Route path="jobs" element={<AdminJobs />} />` dentro del `<Route path="/admin">` de
  `src/client/main.tsx` + import.
- Entrada de nav en `AdminLayout.tsx`: `{ to: '/admin/jobs', icon: <ícono lucide>, label: 'Jobs' }`
  (usá un ícono de `lucide-react` ya usado en el repo, p.ej. `ListChecks`/`Activity`).
- **Reutilizá el patrón visual exacto** de `AdminPlans.tsx`/`AdminTenants.tsx` (mismas clases
  Tailwind: `bg-void text-white`, `bg-white/[0.03] border-white/[0.08]`, `rounded-xl`, etc.) — no
  inventes un design system nuevo en esta vista.
- Datos con `useApi()` → `fetchApi` + **`useAsyncData`** (contrato PH-05). Estados con
  `LoadingState` / `ErrorState` / `EmptyState` de `src/client/components/feedback`.
- Tabla con **`ResponsiveTable`** (contrato PH-07), columnas: tenant, kind, status, attempts
  (`attempts/maxAttempts`), `run_at`, último error, acciones.
- Filtros: estado (select), kind (input), tenant (input por id). Botón **Re-encolar** visible sólo
  en filas `dead`/`failed` → `POST /admin/jobs/:id/retry` → `reload()`.
- `EmptyState` cuando no hay jobs: título **"No hay jobs en la cola"** + descripción que diga qué
  hacer (no un "ocurrió un error" genérico).

### 3.8 Tests — `tests/jobQueue.test.ts` + `tests/helpers/memoryJobQueueStore.ts`

Deterministas: **sin DB real** (store en memoria con los MISMOS filtros por tenant que el drizzle),
**sin red**, **sin timers** (`now` inyectado, `worker.tick()` a mano).

Store en memoria con los MISMOS WHERE que el drizzle (mismo criterio que
`tests/helpers/memoryRenderJobsStore.ts`): `retry`/`cancel`/`getById` matchean por
`id AND tenant_id`; `claimNext` es tenant-scoped y respeta `run_at <= now`; `markFailed` decide
`dead` vs vuelta a `pending` por `attempts >= maxAttempts`.

Casos **obligatorios** (si falta uno, el slice está incompleto):

1. `enqueue` → `status='pending'`, `attempts=0`, `run_at=now`.
2. `claimNext` respeta el gate `run_at`: un job con `run_at` futuro **no** se claimea.
3. `claimNext` incrementa `attempts` y deja `status='running'` + `started_at`.
4. `claimNext` es **tenant-scoped**: el job del tenant A **no** lo claimea el tenant B.
5. `markFailed` con `attempts < max_attempts` → vuelve a `'pending'`, `run_at` = backoff,
   `last_error` preservado.
6. `markFailed` con `attempts >= max_attempts` → `'dead'` + `dead_lettered_at` + `last_error`.
7. `retry` desde `'dead'` → `'pending'`, `attempts=0`, `run_at=now`, `last_error=null`,
   `dead_lettered_at=null`; desde `'pending'` → `null`.
8. `cancel` desde `'pending'` → `'cancelled'`; desde `'succeeded'` → `null`.
9. `backoffMs`: 60 000 / 120 000 / 240 000… y **tope** 3 600 000.
10. Aislamiento de tenant en `listByTenant`/`getById`/`retry`/`cancel`: un id ajeno → `null`/404.
11. Rutas tenant: `GET /` devuelve `{ jobs, total }`; `GET /:id` de otro tenant → **404**;
    `POST /` → **202**; `POST /:id/retry` → **200**; `POST /:id/cancel` → **200**;
    uuid inválido → **400**; sin auth → **401**.
12. Rutas admin: sin platform-admin → **401/403**; con platform-admin lista cross-tenant y el
    **retry** de un job `dead` devuelve **200**; la mutación **queda auditada**.
13. Worker: `tick()` con un handler fake que tira → el job vuelve a `'pending'` con backoff;
    tras agotar `max_attempts` → `'dead'`; handler que resuelve → `'succeeded'`.

**No copies el patrón de auth mockeado a ciegas**: `tests/publishJobs.test.ts` mockea
`../src/server/db/index.js` **parcialmente** (`...await io()` + `db: {}`) y
`../src/server/middleware/auth.js` con el header `x-test-tenant`. Reutilizá ese patrón exacto.

## 4. Reglas de dominio (inviolables)

- **`tenant_id` en TODA query** de la cola, incluido el claim (§3.4).
- Las migraciones se **generan y verifican**, pero **NO se aplican a ninguna base real**
  (ni prod, ni staging). La verificación es local con pglite.
- Nunca expongas credenciales ni connection strings en código, logs, commits o reportes.
- BYOK cifrado: no lo toques en este slice.
- **Fuera de alcance** (no lo hagas): PI-02 logging estructurado, PI-03 métricas de costo IA,
  PI-04 ingesta, PI-05 política de borrado de crudos, PI-06 go-live, PI-07 piloto.

## 5. Gates exactos (EXIT real, sin pipe — el exit code tiene que verse)

```bash
npx tsc --noEmit          # EXIT 0
npx vitest run            # debe imprimir "Test Files N passed (N)"
npm run build             # EXIT 0 — build:client + build:server + drizzle-kit generate
node scripts/verify-migration-pglite.mjs   # EXIT 0 + la sección nueva en verde
git diff --check          # EXIT 0
```

**`npm run build` tiene que imprimir `No schema changes, nothing to migrate`** — si genera una
migración nueva, hay drift de snapshot (falta commitear `drizzle/meta/0020_snapshot.json`).

Si algún gate falla por un archivo **ajeno** a tu slice (no tuyo), NO lo arregles: dejalo,
reportalo explícitamente en el reporte final y seguí. No toques archivos fuera del alcance.

## 6. Commits

- Conventional commits, **un commit por unidad de trabajo**:
  1. `feat(jobs): add job_queue table with retries and dead-letter` (schema + migración + snapshot
     + servicio + worker + API tenant)
  2. `feat(admin): add jobs panel with filters and dead-letter requeue` (API admin + vista React +
     `AUDIT_ACTIONS`)
  3. `test(jobs): add deterministic job queue and admin jobs tests` (store en memoria + tests)
  4. `docs(epica-i): mark PI-01 complete with SHA and gate evidence` (el checklist de §7)
- **Paths explícitos** en `git add` — **NUNCA** `git add -A`, `git add .`, `git stash`, `git checkout`.
- **Sin atribución IA** (nada de `Co-Authored-By`, nada de "generated by").
- **NO push**: commiteá y dejá la rama lista. El orquestador pushea el backup después de verificar.

## 7. Checklist de la ÉPICA I — actualizálo vos

El checklist de la ÉPICA I **no vive en el repo**: creá `docs/EPICA-I.md` con los 7 ítems
(PI-01..PI-07, con su puntaje entre corchetes, textual igual al de la tarjeta) y marcá **PI-01**
como `[x]` **con el SHA de tus commits + la evidencia real de los gates** (línea `Test Files N
passed (N)`, EXIT codes, y la salida de `verify-migration-pglite.mjs`). Los otros 6 quedan `- [ ]`.
Commit: `docs(epica-i): mark PI-01 complete with SHA and gate evidence`.

## 8. Límites duros (respetalos o el trabajo se rechaza)

- **NO push** a `master`/`main`, **NO merge**, **NO deploy**.
- **NO migraciones** contra ninguna base real.
- **NO tocar** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`
  (sólo lectura para vos; todo el trabajo va en este worktree).
- **NO tocar** `publish_jobs`, `clip_render_jobs`, `scheduled_jobs`, `job_executions` ni sus
  servicios/workers (ver §2).
- La integración a `master` espera la **firma de Adrián** en la tarjeta `t_851c4b77`.

## 9. Reporte final (obligatorio, en el cuerpo de la respuesta)

1. Qué ya existía y qué completaste (con `file:line`).
2. Salida real de los gates (con los EXIT codes y las líneas `Test Files N passed`).
3. SHA de los commits y `git log --oneline` final + `git status --porcelain` (debe estar limpio).
4. `tenant_id`: cómo quedó garantizado en cada query nueva (incluido el claim).
5. Lo que **NO** quedó verificado, declarado explícitamente.
