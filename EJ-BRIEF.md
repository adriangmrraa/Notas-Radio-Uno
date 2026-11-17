# BRIEF — ÉPICA J: Deployability + Unificación de motor

**Contexto**: Auditoría de arquitectura sobre `master @39d1bfb` (worktree `kelp`). El producto es maduro por dentro pero la capa de despliegue está rota y conviven DOS motores de pipeline. Esta épica corrige los defectos de despliegue, retira el motor legacy y deja el repo desplegable de verdad en VPS/contenedor.

**Objetivo**: `main` queda desplegable con instrucciones correctas, un solo motor de pipeline (transmissions), concurrencia controlada y CI.

**Reglas duras**:
- Conventional commits, SIN atribución AI, SIN push. Un commit (o pocos) por unidad lógica de cada slice.
- Toda query de negocio filtra por `tenant_id` (regla dura del repo — no romperla).
- Los tests existentes deben seguir verdes o actualizarse como parte del refactor. NO se borran tests para que pasen.
- Gates REALES al final de CADA slice (pegar EXIT + summary en el reporte y en `docs/EPICA-J.md`):
  1. `npx tsc --noEmit` → EXIT 0
  2. `npx vitest run` → EXIT 0 (pegar línea `Test Files N passed` + `Tests N passed`)
  3. `npm run build` → EXIT 0
  4. `git diff --check` → EXIT 0
  5. `node scripts/verify-migration-pglite.mjs` → EXIT 0 (solo si hubo cambio de schema)
- Si un gate no puede terminar de correr, eso es NO VERIFICADO — jamás verde.
- Archivos nuevos SIEMPRE UTF-8. No reescribir archivos con acentos salvo necesidad (en Windows se corrompen). Después de cada slice: `grep -rn '⬦\|�' <archivos tocados>` y si hay corrupción, fix en commit aparte.
- No inventar: si un callsite no tiene equivalente en el motor nuevo, reportarlo en vez de improvisar.
- `npm install` primero (el worktree no trae node_modules; el postinstall instala `remotion/`).
- Nada de cambios fuera del scope. No tocar configuración de producción real ni deployar nada.

---

## Estado auditado (hechos verificados, no supuestos)

1. **Dockerfile roto**: `RUN npm ci` en builder ejecuta el postinstall `cd remotion && npm install` pero `remotion/` nunca se copia → el build de imagen falla. Runtime además no copia `fonts/` ni tiene Chromium (Remotion render imposible).
2. **Docs de deploy para otra stack**: `DEPLOY_MANUAL.md` y `docs/DEPLOYMENT_EASYPANEL.md` instruyen `npx prisma migrate deploy` — el repo usa **Drizzle** (no hay `schema.prisma` ni dep `prisma` en package.json). `DOCUMENTACION_TECNICA.md` describe la v6 muerta (Cohere, Python Whisper, SQLite).
3. **Driver DB solo-Neon**: `src/server/db/index.ts` usa `@neondatabase/serverless` (WebSocket al proxy de Neon) — NO conecta con un Postgres local del VPS como indica DEPLOY_MANUAL. Decisión: quedarse con Neon, arreglar los docs.
4. **`.env.example` en UTF-16**: `dotenv` no lo parsea → quien hace `cp .env.example .env` queda con cero vars en silencio.
5. **`ecosystem.config.js`**: `instances: 'max'` + `exec_mode: 'cluster'` rompe Socket.IO y duplica los workers/schedulers. DEPLOY_MANUAL recomienda `instances: 1`. Debe quedar `instances: 1`, `exec_mode: 'fork'`.
6. **`nginx.conf`**: `proxy_pass http://127.0.0.1:3001` — roto para el deploy de 2 contenedores (frontend nginx + api) que propone DEPLOYMENT_EASYPANEL; también para cualquier Docker Compose.
7. **Dos motores**: `pipelineService.ts` (AutoPipeline, 1923 líneas, `Map<tenantId>` en memoria, `output/transcripciones.json` como estado) + `routes/pipeline.ts` + `routes/capture.ts` (spawnea `python scripts/audio_capture.py` que NO existe — `*.py` está gitignored — y mata con `taskkill` de Windows) + `GET /api/get-transcriptions`. El motor nuevo (transmissions + stream_recording + recording_segments + analysisEngine + FSM) es el canónico.
8. **Renders sin tope**: `clipRenderWorker`/`publishWorker`/`jobQueueWorker` claimean 1 job por tick (10s) fire-and-forget — los renders se acumulan en paralelo sin límite.
9. **Sin `PROCESS_ROLE`**: TODO explícito en `index.ts` (~línea 316). API + WS + 5 schedulers/workers en un proceso.
10. **Storage local único**: `data/raw`, `output/`, `uploads/`, `data/backup`. Interfaz `RawStorage` existe; no hay driver S3.
11. **Restos Prisma/SQLite**: `prisma.config.ts`, `prisma-temp-sqlite.prisma`, `temp-migrations/schema-backup.prisma`.
12. **Sin CI**: no hay `.github/workflows`. Los 1000+ tests no corren en PRs.
13. **`JWT_SECRET` fallback** `'dev-secret-change-in-production'` en middleware/authz.ts y middleware/auth.ts.
14. `Dockerfile.frontend` con `nginx.conf` misma falla del punto 6.

---

## Slices (ejecutar EN ORDEN, en ESTA misma rama `epica-j-deployability`)

### PJ-01 — Deploy blockers (fix archivos, sin features)

- **`.env.example`**: reescribir como UTF-8. Conservar TODAS las variables y secciones actuales; agregar las nuevas introducidas por esta épica (PROCESS_ROLE, MAX_CONCURRENT_TRANSMISSIONS, RENDER_MAX_IN_FLIGHT, PUBLISH_MAX_IN_FLIGHT, JOB_QUEUE_MAX_IN_FLIGHT, STORAGE_DRIVER/S3_* si PJ-05 se hace, API_UPSTREAM para nginx).
- **`Dockerfile`**: copiar `remotion/` y `fonts/` antes de `npm ci` (o reordenar para que el postinstall encuentre `remotion/`). Runtime: copiar `fonts/` y `remotion/` (con sus node_modules o reinstalando en runtime — elegir y documentar el que dé imagen más chica y render funcional). Agregar Chromium + deps SOLO si se decide soportar Remotion render en contenedor — evaluar: si el path ffmpeg (`clip_render_jobs` kinds cut/reframe/subtitles) ya cubre los clips en producción, documentar que Remotion render es opt-in local y NO agrandar la imagen; dejar el `clipService` (Remotion) detrás del flag/availability-check existente.
- **`Dockerfile.frontend` + `nginx.conf`**: upstream parametrizable. Usar templates de nginx-alpine (`/etc/nginx/templates/*.conf.template` con envsubst) — variable `API_UPSTREAM` (default `http://127.0.0.1:3001`). Dejar `nginx.conf` plano como referencia documentada o migrarlo a template — decidir y documentar.
- **`ecosystem.config.js`**: `instances: 1`, `exec_mode: 'fork'` con comentario explicando por qué NUNCA cluster (estado en proceso: Socket.IO, schedulers, capturas).
- **`render.yaml`**: agregar `plan`/`env` lo mínimo — documentar en comentario que Remotion render requiere Chromium (sin cambiar el runtime de Render si no aplica).
- **Prisma remnants**: borrar `prisma.config.ts`, `prisma-temp-sqlite.prisma`, `temp-migrations/`. Verificar con `rg` que nada los referencia antes de borrar.
- **`JWT_SECRET`**: fallar rápido en producción si no está seteado (mantener fallback solo en `NODE_ENV !== 'production'`).

Gates completos. Commit: `fix(deploy): ...` por unidad (docker, env, pm2, nginx, secrets-guard, cleanup).

### PJ-02 — Docs de deploy a la realidad

- Reescribir `DEPLOY_MANUAL.md`: Drizzle (`npm run db:push`/`db:generate`+`db:migrate` según corresponda al repo — verificar scripts reales en package.json), **Neon como DB requerida** (explicar que el driver es serverless/WebSocket y no habla con Postgres local), pasos corregidos, `instances: 1`, health check `/api/health`.
- Reescribir `docs/DEPLOYMENT_EASYPANEL.md`: 2 servicios (frontend nginx con `API_UPSTREAM`, api Node), Neon externo, env vars correctas, volúmenes para `data/`/`output/`/`uploads/` (o advertir efímero + `STORAGE_DRIVER=s3` si PJ-05 se hizo).
- `DOCUMENTACION_TECNICA.md`: reemplazar por stub de 10 líneas que apunte a `docs/ARCHITECTURE.md` + README y diga que la v6 fue retirada (o borrar el archivo — decidir; si se borra, limpiar referencias).
- `docs/ARCHITECTURE.md`: es enorme y describe SQLite/Whisper-Python/DeepSeek — actualizar SOLO las secciones de stack/DB/servicios a la realidad (Drizzle+Neon, AssemblyAI/Whisper API, Gemini principal, transmissions). No reescribir todo el doc: marcar secciones legacy claramente con un banner `> ⚠️ Sección legacy (motor v6 retirado en Épica J)` donde aplique.
- `docs/EPICA-J.md`: crear tracking doc igual que `docs/EPICA-I.md` (checklist con commits + evidencia de gates).

### PJ-03 — Un motor: retirar el pipeline legacy (EL SLICE GRANDE)

**Meta**: `transmissions` es EL motor. AutoPipeline sale del runtime.

Orden obligatorio:
1. **Inventario PRIMERO** (commit de doc, `docs/EPICA-J.md` o nota en el slice): `rg` de todos los callsites —
   - client: quién llama `/api/pipeline/*`, `/api/start-capture`, `/api/stop-capture`, `/api/get-transcriptions`
   - server: quién importa `pipelineService`, `routes/capture.ts`, `databaseService` (funciones: `getSetting`, `isMetaConnected`, `createPublication`, `createTranscription`, `getActivePipelineConfig`, `getAgent` — tienen callers fuera del motor viejo: metaPublishService, review, settings; NUNCA borrar la función sin migrar el caller)
   - Distinguir `routes/pipeline.ts` (AutoPipeline) de `routes/pipelineConfig.ts` (editor visual — NO es legacy, NO tocar).
2. **Migrar client**: las llamadas del frontend a `/api/pipeline/*` pasan a la API de transmissions (`/api/transmissions`, `/api/live`). Verificar forma de respuesta real en las rutas — no inventar shapes.
3. **Portar lo que sirve del viejo** SOLO si falta en el motor nuevo (verificar antes de portar, no asumir):
   - `deduplicationService` (duplicados 24h+sesión): verificar si `noteFactoryService`/publications ya deduplica; si no, integrar el check en el flujo de generación de notas del motor nuevo.
   - Confirmación de temas en 2 fases: verificar si `analysisEngineService`/`transmissionSegmentsService` ya tiene equivalente; si no, portar como lógica pura dentro del análisis (patrón store+DI).
   - `contentMultiplierService` (1→5 variantes), publicación Meta/Drive/webhooks: verificar si `publishService`/`publishJobs`/`socialConnections` (Zernio) ya cubren; integrar faltantes en el flujo de aprobación/publicación, no en el pipeline.
   - `alertService`/`detectAlerts` del viejo: verificar contra `liveAlertsService` del nuevo.
4. **Borrar**: `services/pipelineService.ts` (AutoPipeline), `routes/pipeline.ts`, `routes/capture.ts`, `services/databaseService.ts` si queda vacío tras migrar callers (o reducirlo a lo que los callers reales usan), `output/transcripciones.json` + bloque de init en `index.ts` + endpoint `/api/get-transcriptions`, referencias a `audio_capture.py`/`taskkill`. Desregistrar en `index.ts` (`registerPipelineRoutes`, `registerCaptureRoutes`, `registerGenerateRoutes` SI el flujo de generate queda cubierto por otro módulo — VERIFICAR primero: `generate.ts` puede ser un feature standalone de placas desde URL/imagen, no necesariamente legacy del pipeline; si es feature real y funciona, SE QUEDA).
5. Actualizar tests que importen lo borrado; agregar tests de las piezas portadas (patrón memory store existente).
6. `registerActiveTransmissionChecker` en transmissionMeteringService: rehacer para que consulte transmissions `live|processing` en DB (el `Map` de pipelines ya no existe).

Restricción: si algún callsite real no tiene equivalente en el motor nuevo, NO improvisar — anotar en el reporte y dejar el código con un comentario `TODO(EJ)` claro.

Commit por unidad: `refactor(pipeline): ...`, `feat(transmissions): port X`, `chore(legacy): remove Y`, `test(...): ...`.

### PJ-04 — Concurrencia controlada + PROCESS_ROLE

- **Semáforo de in-flight** en `clipRenderWorker`, `publishWorker`, `jobQueueWorker`: cap env-configurable (`RENDER_MAX_IN_FLIGHT` default 2, `PUBLISH_MAX_IN_FLIGHT` default 3, `JOB_QUEUE_MAX_IN_FLIGHT` default 3). El tick no despacha si hay `inFlight >= cap` — tracking en memoria del worker (los jobs `running` ya están marcados en DB). Tests con inyección como el resto del repo.
- `maxConcurrent` de `transmissionSchedulerService`: env `MAX_CONCURRENT_TRANSMISSIONS` (default 5).
- **`PROCESS_ROLE`** (`api` | `worker` | `all`, default `all`): en `index.ts`, los inits de schedulers/workers (`initJobScheduler`, `initTransmissionScheduler`, `initClipRenderWorker`, `initPublishWorker`, `initJobQueueWorker`, `initDossierScheduler`) solo arrancan si role ∈ {worker, all}. Documentar en `.env.example` que hoy `worker` aísla cómputo pero los eventos socket emitidos por workers no llegan a clientes (sin adapter) — limitación honesta, no workaround.
- Resolución del TODO en index.ts línea ~316 reemplazada por la implementación real.

Tests: semáforo (no claimea con cap lleno, libera al terminar), env parsing, role gating. Commits `feat(workers): ...`.

### PJ-05 — Storage S3 (STRETCH — solo si PJ-01..04 quedaron limpios)

- `RawStorage` driver S3-compatible (`STORAGE_DRIVER=fs|s3`, vars `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`, path-style para MinIO/R2). Implementar con `@aws-sdk/client-s3` (agregar dep) o fetch firmado manual — elegir el más simple; si agrega demasiada superficie, implementar solo `writeFile/readFile/statFile/deleteFile/exists` + `publicPath` documentado.
- Misma interfaz, mismas garantías anti path-traversal. Tests con fake.
- Si no entra: dejar issue/TODO documentado, NO a medias.

### PJ-06 — CI + boot proof

- `.github/workflows/ci.yml`: Node 20, `npm ci`, `tsc --noEmit`, `vitest run`, `npm run build`, `verify-migration-pglite` — en push a master y PRs.
- `scripts/smoke-boot.mjs`: arranca `dist/server/index.js` con env dummy de FORMATO VÁLIDO (documentarlas: `DATABASE_URL=postgres://u:p@127.0.0.1:1/db`, `JWT_SECRET=dummy-32hex`, `NODE_ENV=production`) esperando que falle en migraciones con mensaje claro (prueba env validation + boot path) — o, mejor, boot real contra Postgres efímero SI hay forma sin docker en este host (investigar; si no, queda el modo graceful-fail + checklist manual documentado).
- Actualizar `docs/RUNBOOK.md`/`DEPLOYMENT_GUIDE.md` con el smoke como paso de verificación post-deploy.

---

## Reporte final obligatorio

Al terminar (aunque queden slices sin hacer), escribir reporte en el transcript y commitear `docs/EPICA-J.md` actualizado:
- Por cada slice: commits (SHA + subject), gates con EXIT real y línea de summary.
- Inventario de callsites del PJ-03 y qué se portó/eliminó/dejó como TODO(EJ).
- Decisiones tomadas (Remotion-in-docker, nginx template, S3 sí/no) y por qué.
- Lista honesta de lo que NO se hizo.

Recordá: corrés solo y desatendido — no pidas aprobación, commiteá por unidad, nunca pushees. Si algo bloquea (dependencia que no instala, gate que no termina), dejalo asentado en el reporte y seguí con el siguiente slice.
