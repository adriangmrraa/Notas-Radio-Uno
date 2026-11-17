# ÉPICA J — Deployability + Unificación de motor

Tracking del brief `EJ-BRIEF.md` (rama `epica-j-deployability`, base `master @39d1bfb`).
Cada ítem se marca `[x]` sólo con commits + evidencia real de gates
(EXIT codes, `Test Files N passed`, salida del verificador PGlite).

**Gates por slice**: `npx tsc --noEmit` · `npx vitest run` · `npm run build` ·
`git diff --check` · `node scripts/verify-migration-pglite.mjs` (sólo si hubo
cambio de schema).

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
  - (ver `git log` — commits `docs(deploy)` sobre esta rama)
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

- [ ] PJ-03 Un motor: retirar el pipeline legacy
- [ ] PJ-04 Concurrencia controlada + PROCESS_ROLE
- [ ] PJ-05 Storage S3 (stretch)
- [ ] PJ-06 CI + boot proof

## Inventario de callsites (PJ-03)

(pendiente — se llena al ejecutar el slice)

## Decisiones tomadas

- **Remotion en contenedor: NO.** Los renders productivos (`clip_render_jobs`
  kinds cut/reframe/subtitles) son ffmpeg puro; el render Remotion de
  `clipService` sólo lo llamaba el pipeline legacy → opt-in local. Ahorra
  ~400MB (Chromium + libs X) y mantiene la imagen mínima. El postinstall
  resiliente deja instalar `remotion/` en dev como siempre.
- **nginx**: dos variantes deliberadas — `nginx.conf` plano (VPS/PM2 mismo
  host, upstream 127.0.0.1:3001) y `nginx/default.conf.template` (contenedor,
  `API_UPSTREAM` via envsubst + resolver Docker DNS).
- **Neon**: se mantiene el driver `@neondatabase/serverless`; los docs se
  corrigieron para declarar Neon requerida (no Postgres local).
- **Prisma remnants**: eliminados (cero refs en código).
- **JWT_SECRET**: fail-fast al boot en producción via `lib/jwtSecret.ts`.

## Lo que NO se hizo (honesto)

(se actualiza al cierre)
