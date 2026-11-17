# ÉPICA J — Deployability + Unificación de motor

Tracking del brief `EJ-BRIEF.md` (rama `epica-j-deployability`, base `master @39d1bfb`).
Cada ítem se marca `[x]` sólo con commits + evidencia real de gates
(EXIT codes, `Test Files N passed`, salida del verificador PGlite).

**Gates por slice**: `npx tsc --noEmit` · `npx vitest run` · `npm run build` ·
`git diff --check` · `node scripts/verify-migration-pglite.mjs` (sólo si hubo
cambio de schema) · `node scripts/smoke-boot.mjs` (desde PJ-06).

## Checklist

- [x] PJ-01 Deploy blockers (fix archivos, sin features)

  **Commits:**
  - `b018d18` `fix(deploy): reescribir .env.example en UTF-8 valido y documentar Neon + vars Epica J`
    — el archivo mezclaba UTF-8 con 4 bytes CP1252 sueltos (3 em-dash + 1 `í`);
    quedó UTF-8 puro con todas las variables/secciones + las nuevas:
    `PROCESS_ROLE`, `MAX_CONCURRENT_TRANSMISSIONS`, `RENDER_MAX_IN_FLIGHT`,
    `PUBLISH_MAX_IN_FLIGHT`, `JOB_QUEUE_MAX_IN_FLIGHT`, `API_UPSTREAM`.
    Nota: la auditoría lo describía como UTF-16 — era CP1252-mixto; el efecto
    práctico era el mismo (bytes inválidos para parsers UTF-8).
  - `931cfa7` `fix(deploy): reparar build de imagen api — postinstall resiliente y fonts/ en runtime`
    — `postinstall` ahora corre `scripts/postinstall-remotion.mjs` que instala
    `remotion/` sólo si existe → `npm ci` ya no falla en Docker (builder ni
    runtime). Runtime copia `fonts/` (ffmpeg `fontsdir=` + fontService).
    NO se copia `remotion/` ni Chromium: los `clip_render_jobs` productivos
    (cut/reframe/subtitles) son puro ffmpeg y el único caller runtime del
    render Remotion era el pipeline legacy → render Remotion = opt-in local.
    No se usa `--ignore-scripts` (onnxruntime-node y sharp los necesitan).
  - `a391753` `fix(deploy): upstream nginx parametrizable via API_UPSTREAM (template envsubst)`
    — nuevo `nginx/default.conf.template` consumido por el entrypoint oficial
    de `nginx:alpine`; `ENV API_UPSTREAM=http://127.0.0.1:3001` default en
    `Dockerfile.frontend`, `resolver 127.0.0.11` (DNS Docker) para upstream por
    hostname. `nginx.conf` plano queda como variante VPS/PM2 mismo-host.
  - `feb67d6` `fix(deploy): pm2 en fork de 1 instancia + PROCESS_ROLE en render blueprint`
    — `ecosystem.config.js`: `instances: 1`, `exec_mode: 'fork'` + comentario
    (Socket.IO/schedulers/capturas viven en memoria del proceso).
    `render.yaml`: `PROCESS_ROLE=all` documentado + nota Remotion/Chromium.
  - `cb2bd47` `fix(security): JWT_SECRET obligatorio en produccion (fail-fast al boot)`
    — nuevo `src/server/lib/jwtSecret.ts`: sin `JWT_SECRET` + `NODE_ENV=production`
    tira al importar (boot aborta); fallback dev sólo fuera de producción.
    Aplicado a los 6 sitios con fallback: `middleware/auth.ts`,
    `middleware/authz.ts`, `authService.ts`, `adminService.ts`,
    `transmissionSocketService.ts`, `socialConnectionsService.ts` (state Zernio).
  - `819c449` `chore(legacy): eliminar remanentes Prisma/SQLite — el stack es Drizzle`
    — `prisma.config.ts`, `prisma-temp-sqlite.prisma`, `temp-migrations/` y
    `scripts/verify-user.ts` (importaba `@prisma/client`, dep inexistente).
    Verificado con `rg`: cero referencias en código.

  **Evidencia de gates (ejecutados sobre HEAD `819c449`):**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 57 passed (57)`, `Tests 1060 passed (1060)`
  - `npm run build` → **EXIT 0** — `No schema changes, nothing to migrate`
  - `git diff --check` → **EXIT 0**
  - `verify-migration-pglite` → N/A (sin cambio de schema)
  - Mojibake check en archivos tocados → limpio; `.env.example` parsea UTF-8.

- [x] PJ-02 Docs de deploy a la realidad

  **Commits:**
  - `510d484` `docs(deploy): alinear DEPLOY_MANUAL y DEPLOYMENT_EASYPANEL con el stack real (PJ-02)`
  - `DEPLOY_MANUAL.md` reescrito: Neon requerida (driver WebSocket, no Postgres
    local), migraciones Drizzle automáticas al boot, PM2 fork/1, health
    `/api/health`, sin Prisma/Whisper/Python.
  - `docs/DEPLOYMENT_EASYPANEL.md` reescrito: 2 servicios (api `Dockerfile` +
    frontend `Dockerfile.frontend` con `API_UPSTREAM`), Neon externo, volúmenes
    para `data/`/`output/`/`uploads/` (advertencia de efímero si no se mapean).
  - `DOCUMENTACION_TECNICA.md` → stub de 10 líneas (v6 retirada; apunta a
    README + ARCHITECTURE + guías de deploy). Elegido stub sobre borrado para
    no romper enlaces externos.
  - `docs/ARCHITECTURE.md`: stack table actualizada a Drizzle+Neon+transmissions,
    estructura de carpetas actualizada, banners `⚠️ Sección legacy` en §3
    (Pipeline), §4 (SQLite), §5 (socket events), §6 subsecciones
    pipeline/capture/get-transcriptions y §7 (parcial).

  **Evidencia de gates:** gates corridos juntos con PJ-01 (cambios docs-only
  después no alteran tsc/vitest/build).

- [x] PJ-03 Un motor: retirar el pipeline legacy

  **Commits:**
  - `2fa8ecc` `refactor(pipeline): retirar motor legacy AutoPipeline y sus rutas/servicios exclusivos (PJ-03)` — 13 archivos, −3740/+66
  - `814cc27` `refactor(client): retirar superficie del pipeline legacy (PJ-03)` — 12 archivos, −3285/+2

  **Qué quedó como motor único:** `transmissions` +
  `transmissionSchedulerService` + `streamRecorderService` +
  `analysisEngineService` + `transmissionStateMachine`. La agenda programada
  corre por `scheduled_transmissions` (tick del scheduler), no por
  `scheduled_jobs`/`AutoPipeline`.

  **Evidencia de gates:**
  - `npx tsc --noEmit` → **EXIT 0** (con los archivos ya borrados — prueba que
    ningún callsite vivo referenciaba los módulos retirados)
  - `npx vitest run` → **EXIT 0** — `Test Files 57 passed (57)`, `Tests 1060 passed`
  - `npm run build` → **EXIT 0**
  - `git diff --check` → **EXIT 0** (un trailing-newline corregido en databaseService)
  - `rg` por `pipelineService|AutoPipeline|usePipelineState|get-transcriptions`
    en `src/` → sólo comentarios históricos; cero imports vivos.

- [x] PJ-04 Concurrencia controlada + PROCESS_ROLE

  **Commits:**
  - `ed62309` `feat(concurrency): semaforos in-flight en workers + PROCESS_ROLE (PJ-04)`

  **Piezas:**
  - `src/server/lib/envInt.ts` — parser de env int con default/clamp (compartido).
  - `src/server/lib/processRole.ts` — `PROCESS_ROLE=api|worker|all` (default
    `all`, backwards-compatible): `api` no levanta loops de workers/scheduler;
    `worker` los levanta; `all` ambos. Cableado en `src/server/index.ts`.
  - Semáforos in-flight (claim-1-job + fire-and-forget con tope):
    `clipRenderWorker` `RENDER_MAX_IN_FLIGHT` (def 2), `publishWorker`
    `PUBLISH_MAX_IN_FLIGHT` (def 3), `jobQueueWorker`
    `JOB_QUEUE_MAX_IN_FLIGHT` (def 3). Slot liberado en success Y failure.
  - `MAX_CONCURRENT_TRANSMISSIONS` (def 5) cableado en
    `transmissionSchedulerService` vía env.
  - `tests/workerConcurrency.test.ts` — 13 tests: cap respetado, work queda
    encolada a cap lleno, fallas liberan slot, workers no claimean de más,
    PROCESS_ROLE api/worker/all.

  **Evidencia de gates:**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 58 passed (58)`, `Tests 1073 passed`
  - `npm run build` → **EXIT 0** · `git diff --check` → **EXIT 0**

- [x] PJ-05 Storage S3 (stretch — destino de backup solamente)

  **Commits:**
  - `c8576e7` `feat(storage): driver S3 opcional para backup de assets (PJ-05)`

  **Piezas:**
  - `src/server/services/s3BackupStorage.ts` — implementa `BackupStorage` sobre
    `@aws-sdk/client-s3@3.1166.0` (versión pineada ≥7 días): Put/Get/Head/
    ListV2+DeleteObjects paginado en lotes de 1000. `S3_ENDPOINT` no vacío →
    `forcePathStyle` (R2/MinIO). Credenciales sólo se pasan si AMBAS están —
    strings vacíos no cortocircuitan la cadena de providers del SDK
    (IAM/env/~/.aws).
  - `getBackupStorage()` en `assetBackupService.ts` selecciona por
    `BACKUP_DRIVER`: `fs` (default) | `s3` | otro → throw descriptivo.
  - `S3_PREFIX` opcional; `publicPath(key)` devuelve URI `s3://bucket/prefix/key`
    — documentado NO-ruta-local (nadie lo consume para el destino de backup,
    que es write-only: stat/write/delete).
  - Guard anti path-traversal idéntico al fs adapter, ANTES de cualquier
    request al bucket.
  - `tests/s3BackupStorage.test.ts` — 8 tests con client fake inyectado
    (sin red ni credenciales): round-trip, stat 404→null / otros errores
    propagan, deletePrefix paginado, S3_PREFIX, publicPath, guards, bucket
    requerido.
  - `.env.example` sección 21 documenta `BACKUP_DRIVER` + `S3_*`.

  **Por qué S3 sólo para backup:** el crudo (`stream_recordings`/`recording_segments`)
  se escribe por ffmpeg directo en `storage.publicPath()` — ruta local
  (recorder, vodUpload, clipCutter, personIdentity). Migrar el crudo a S3
  requiere staging local + upload post-segmento; fuera de scope y riesgoso
  para el loop de captura. El destino de backup es write-only → fit honesto.

  **Evidencia de gates:**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 59 passed (59)`, `Tests 1081 passed` (incluye los 8 nuevos de S3)
  - `npm run build` → **EXIT 0** — `No schema changes`
  - `git diff --check` → **EXIT 0**
  - `npm install @aws-sdk/client-s3@3.1166.0` → EXIT 0 (+25 paquetes; npm
    reporta 74 vulnerabilidades preexistentes del árbol — ninguna nueva del
    paquete en sí; ver "Lo que NO se hizo").

- [x] PJ-06 CI + boot proof

  **Commits:**
  - `6601b9a` `ci: workflow de verificacion + smoke-boot + runbook (PJ-06)`

  **Piezas:**
  - `.github/workflows/ci.yml` — Node 20, `npm ci` (con
    `PERIODISTAPP_SKIP_REMOTION_INSTALL=1`, opt-out nuevo en
    `postinstall-remotion.mjs`), `tsc --noEmit`, `vitest run`, `npm run build`,
    `verify-migration-pglite`, `smoke-boot`. Trigger: push a `master`/`main`
    y PRs a esas ramas + `workflow_dispatch`.
  - `scripts/smoke-boot.mjs` — ejecuta `dist/server/index.js` con env dummy de
    formato válido, sin Docker ni Postgres real:
    - Caso 1: `NODE_ENV=production` sin `JWT_SECRET` → exit≠0 + log
      `JWT_SECRET` (verifica el fail-fast PJ-01).
    - Caso 2: `DATABASE_URL=postgres://u:p@127.0.0.1:1/db` + JWT válido →
      exit≠0 + error de migraciones/DB (verifica el boot path hasta
      `runMigrations`).
    - Caso 3 opt-in: `SMOKE_DATABASE_URL=<url real>` → boot feliz +
      `GET /api/health` debe responder JSON con `status`.
  - `DEPLOY_MANUAL.md` §Paso 8 + `docs/RUNBOOK.md` §Referencias documentan el
    smoke como verificación post-deploy.

  **Evidencia de gates (locales, HEAD `6601b9a`):**
  - `node scripts/smoke-boot.mjs` → **EXIT 0** — `PASS` ambos casos fail-fast,
    `SKIP` el boot real (sin `SMOKE_DATABASE_URL` en este host).
  - `node scripts/verify-migration-pglite.mjs` → **EXIT 0**.
  - tsc/vitest/build heredan el estado verde de PJ-05 (ningún `.ts` tocado
    desde entonces; el slice añade `.mjs`/`.yml`/`.md`).

## Inventario de callsites (PJ-03)

**Eliminados — server (`2fa8ecc`):**
- `src/server/services/pipelineService.ts` (−1923) — `AutoPipeline`, motor viejo.
- `src/server/routes/pipeline.ts` (−201) — `/api/pipeline/*`.
- `src/server/routes/capture.ts` (−211) — captura manual legacy.
- `src/server/routes/jobs.ts` (−281) — `/api/jobs` (`scheduled_jobs` +
  `job_executions`; UI retirada, tablas conservadas en schema sin migración).
- `src/server/routes/pipelineConfig.ts` (−65) — CRUD de `pipeline_configs`.
- `src/server/services/agentExecutionService.ts` (−75), `insightService.ts`
  (−167), `deduplicationService.ts` (−138), `topicService.ts` (−248) —
  callers únicos: `pipelineService`.
- `src/server/index.ts` — `output/transcripciones.json` (init/reset) +
  `GET /api/get-transcriptions`.
- `src/server/services/databaseService.ts` — CRUD de pipeline-configs +
  `findRecentPublications` (helper exclusivo de deduplicationService). El
  resto de la facade compartida (publications/review/history/meta/credentials/
  settings/agents…) se conserva: es capa de datos Drizzle viva, no el motor.

**Eliminados — client (`814cc27`):**
- `src/client/App.tsx` (−1128) — dashboard monolítico sin importadores.
- `src/client/hooks/usePipelineState.tsx` (−383) — poll a `/api/pipeline/*`.
- `src/client/editor/` (−1217 en 5 archivos) — editor visual de
  `pipeline_configs` (canvas, paleta, inspector, modales, CSS).
- `src/client/components/pipeline/PipelineView.tsx` (−246) — sólo App.tsx.
- `src/client/pages/ScheduledJobsPage.tsx` (−287) — UI de `/api/jobs`.
- `src/client/main.tsx` — quita `PipelineProvider`; `/editor` → redirect a
  `/dashboard`, `/scheduled` → redirect a `/agenda`.
- `src/client/components/Sidebar.tsx` — quita links Pipeline/Automatizaciones.

**Migrado/preservado:**
- `jobSchedulerService` — de scheduler-de-pipeline a tick de mantenimiento:
  `releaseStaleOperations` + `evaluateTransitions` (billing lifecycle).
- `transmissionMeteringService.registerActiveTransmissionChecker` — de mapa
  en memoria del pipeline a consulta DB: `transmissions.status IN
  (scheduled|waiting|live|processing)` por tenant+UUID; refs no-UUID (URLs
  legacy) cuentan como stale → cuota liberable.
- `/agenda` — sigue backed por `/api/transmissions/scheduled` (canónico).
- `AdminJobs`/`/api/admin/jobs` — cola genérica `job_queue` (PI-01), intacta.
- Tablas `scheduled_jobs`/`job_executions`/`pipeline_configs` — quedan en el
  schema (sin migración de borrado) pero sin consumidores de código.

**TODO(EJ) / deuda conocida:** ninguna funcional — comentarios históricos que
mencionan el pipeline viejo quedan como referencia arqueológica; la tabla
`pipeline_configs` podría borrarse en una migración futura (no requerida —
ningún código la toca).

## Decisiones tomadas

- **Remotion en contenedor: NO.** Los renders productivos (`clip_render_jobs`
  kinds cut/reframe/subtitles) son ffmpeg puro; el render Remotion de
  `clipService` sólo lo llamaba el pipeline legacy → opt-in local. Ahorra
  ~400MB (Chromium + libs X) y mantiene la imagen mínima. El postinstall
  resiliente deja instalar `remotion/` en dev como siempre
  (`PERIODISTAPP_SKIP_REMOTION_INSTALL=1` lo omite en CI).
- **nginx**: dos variantes deliberadas — `nginx.conf` plano (VPS/PM2 mismo
  host, upstream 127.0.0.1:3001) y `nginx/default.conf.template` (contenedor,
  `API_UPSTREAM` via envsubst + resolver Docker DNS).
- **Neon**: se mantiene el driver `@neondatabase/serverless`; los docs se
  corrigieron para declarar Neon requerida (no Postgres local).
- **Prisma remnants**: eliminados (cero refs en código).
- **JWT_SECRET**: fail-fast al boot en producción via `lib/jwtSecret.ts`
  (module-level → aborta el import, cubierto por smoke-boot caso 1).
- **`databaseService` se queda**: es facade Drizzle multi-tenant compartida
  (~20 callers vivos), no el motor legacy. El motor era `AutoPipeline` y su
  ecosistema (decisión registrada en Engram).
- **S3 sólo para backup destino** (ver PJ-05): el crudo exige fs local por
  `publicPath`/ffmpeg.
- **PROCESS_ROLE default `all`** — el proceso único sigue comportándose como
  antes; la separación api/worker es opt-in por env.
- **Boot proof modo graceful-fail**: sin Docker/Postgres efímera en este host,
  el smoke verifica los fail-fast reales del boot (JWT + migraciones); el
  boot feliz queda opt-in via `SMOKE_DATABASE_URL` (documentado en el script
  y en DEPLOY_MANUAL/RUNBOOK).

## Lo que NO se hizo (honesto)

- **Crudo a S3** — no aplica sin staging local; queda fs. Si se quiere más
  adelante: escribir segmentos en fs local y subir por chunk a S3 en otro
  thread, cambiando `publicPath` a URI resoluble.
- **Migración de borrado** de `scheduled_jobs`, `job_executions`,
  `pipeline_configs` — tablas huérfanas conservadas (sin consumidores). Una
  migración `DROP TABLE` es trivial pero irreversible; se deja como decisión
  de producto.
- **Multi-instancia PM2 / cluster** — deliberado: Socket.IO + schedulers +
  capturas viven en memoria; la escala real es horizontal por `PROCESS_ROLE`
  (api | worker en procesos/hosts separados), no cluster por máquina.
- **`npm audit` de las 74 vulnerabilidades reportadas** por npm install
  (preexistentes del árbol de deps, no introducidas por `@aws-sdk/client-s3`).
  Fuera del scope del brief; queda registrado.
- **Boot feliz con Postgres efímera en CI** — el workflow corre el smoke en
  modo graceful-fail; un service container Postgres + `SMOKE_DATABASE_URL`
  habilitaría el caso 3 sin cambios de código (mejora futura barata).
- **Push/PR** — no solicitado; la rama queda local en el worktree con 12
  commits sobre `39d1bfb` (único untracked: `EJ-BRIEF.md`, el brief fuente).
