# PG-05 — `publish_jobs`: aprobar → encolar por red/cuenta → Zernio API → estados + reintento

Rama actual: `pg-01-unified-inbox`. PG-01, PG-02 y PG-03 ya están cerrados: **no los reviertas**.
Implementá **sólo PG-05**.

Dependencias (deben estar en la rama cuando corras esto): PG-04 dejó `social_connections` +
`zernioService.ts` + las rutas de conexión. **Usá esos servicios; no reimplementes el cliente Zernio.**
Leyé `BRIEF-ZERNIO-API.md` para los endpoints exactos de publicación y reintento.

## Objetivo
El circuito real de publicación: cuando se **aprueba** un asset/publicación, se crea **un job por
red y cuenta**, se **encola**, un worker lo **publica contra la API de Zernio**, y el job queda con
**estado observable** (`queued → publishing → published | partial | failed`) y **reintento** seguro.

## Decisiones SDD (aplicar)
- **D-4 — CONVIVENCIA**: Zernio **no reemplaza** a `publishService`. El flujo nuevo (jobs + Zernio)
  es el camino **default para plataformas con conexión Zernio**. El **Meta/Twitter directo queda como
  canal legacy opcional** (PG-07 lo formaliza): en este slice **no borres ni reescribas**
  `publishService`/`metaPublishService`/`twitterService` — sólo **no los rompas** y dejá claro en el
  código cuál es el camino nuevo vs el legacy.
- **Nunca ver credenciales sociales**: el job guarda `platform` + `accountId` (id opaco de Zernio),
  nunca tokens.
- **`tenant_id` en todas las queries** del store y del worker.
- Idempotencia: cada job lógico lleva un `idempotency_key` estable y se manda como header
  `Idempotency-Key` a Zernio ⇒ reintentar no duplica posts.

## Alcance

### 1) Migración — `publish_jobs`
Schema nuevo (p. ej. `src/server/db/schema/publishJobs.ts`) + export en `index.ts`:
- `id` uuid PK, `tenant_id` NOT NULL FK tenants cascade + index,
- `asset_id` uuid NULL FK assets ON DELETE SET NULL (origen editorial),
- `publication_id` uuid NULL FK publications ON DELETE SET NULL (origen legacy),
- `connection_id` uuid NULL FK social_connections ON DELETE SET NULL,
- `platform` varchar(32) NOT NULL, `account_id` varchar(64) NOT NULL,
- `status` varchar(20) NOT NULL default 'queued'
  (`queued` | `publishing` | `published` | `partial` | `failed` | `cancelled`),
- `zernio_post_id` varchar(64) NULL, `idempotency_key` varchar(255) NOT NULL UNIQUE,
- `content` text NOT NULL, `media_urls` jsonb NOT NULL default '[]',
- `attempts` integer NOT NULL default 0, `max_attempts` integer NOT NULL default 3,
- `last_error` text NULL, `last_error_category` varchar(32) NULL, `last_error_source` varchar(16) NULL,
- `scheduled_for` timestamp NULL, `published_at` timestamp NULL, `platform_post_url` text NULL,
- `created_at`, `updated_at`.
- Índices: `(tenant_id, status)`, `(tenant_id, created_at)`.
- `npx drizzle-kit generate` + sección nueva en `scripts/verify-migration-pglite.mjs` con
  **idempotencia**. El número lo asigna `drizzle-kit`; no renumeres migraciones existentes.

### 2) Servicio `publishJobService.ts`
- Store pattern del repo: `PublishJobStore` + `createDrizzlePublishJobStore(db)` + memory store en
  `tests/helpers/`.
- API (todo tenant-scoped):
  - `enqueuePublishJobs({tenantId, assetId?, publicationId?, targets: {platform, accountId, connectionId}[], content, mediaUrls, scheduledFor?})`
    → crea **un job por target** con `idempotency_key` derivada de un UUID v5/determinista de
    (tenantId, assetId|publicationId, platform, accountId) para que re-encolar no duplique.
  - `listPublishJobs(tenantId, {status?, limit?, offset?})`, `getPublishJob(tenantId, id)`.
  - `claimNextJob()` (worker) — **excepción documentada** al scoping por tenant, como
    `claimNext` de `clipRenderQueueService`: el worker es global; el tenant viaja en la fila.
  - `markPublishing/markPublished/markPartial/markFailed/markCancelled` + `recordAttempt`.
  - `retryPublishJob(tenantId, id)`: reencola un job fallido/partial (respeta `max_attempts`).
- Transiciones válidas: `queued → publishing → published|partial|failed`, `failed → queued` (retry),
  cualquier estado → `cancelled`. `canTransition` pura y testeada.

### 3) Publicación contra Zernio + worker
- `src/server/services/zernioPublishService.ts` (o ampliar el `zernioService` de PG-04):
  `publishPost({profileId, content, mediaUrls, platforms:[{platform, accountId}], scheduledFor?,
  idempotencyKey})` → `POST /v1/posts` con header `Idempotency-Key`.
  Mapeo de respuestas (según `BRIEF-ZERNIO-API.md`):
  - **201** ⇒ creado (mirá `post.status`: `published` | `partial` | `failed` | `scheduled` | `publishing`),
  - **200** ⇒ replay idempotente (no es error: es el mismo post),
  - **202** ⇒ X sin fondos (queda esperando funding → estado `queued`/`publishing` con nota),
  - **207** ⇒ creado con publicación parcial (branchear por `post.status`, nunca por "no lanzó"),
  - **400/401/403/409/422** ⇒ `failed` con `last_error_category` según la tabla de `errorCategory`
    (`auth_expired`, `user_content`, `user_abuse`, `platform_rate_limit`, `quota_exhausted`,
    `account_issue`, `platform_rejected`, `platform_error`, `system_error`, `unknown`),
  - **429/503** ⇒ **reintentable** (backoff), no marcar `failed` definitivo.
- Worker `src/server/services/publishWorker.ts`, **patrón espejo de `clipRenderWorker.ts`**: poll con
  intervalo por env (`PUBLISH_WORKER_POLL_MS`), claim, publish, mark, y **emit de evento al tenant**
  con el mecanismo de eventos que ya usa el repo (`emitToTenant`) para `publish:job:*`.
- **Reintento**:
  - Automático: hasta `max_attempts` con backoff para errores reintentables (`platform_error`,
    `system_error`, `platform_rate_limit`, 429/503).
  - Manual: `POST /v1/posts/{postId}/retry` de Zernio para un post ya creado que falló en una red ⇒
    implementá `retryZernioPost(postId)` y exponelo en la API de jobs.

### 4) Rutas (`src/server/routes/publishJobs.ts` + registro en `src/server/index.ts`)
Con `requireAuth` y `req.auth!.tenantId`:
- `GET /api/publish-jobs` → lista del tenant (filtros por estado, paginado).
- `GET /api/publish-jobs/:id` → detalle (con el último error real, sin credenciales).
- `POST /api/publish-jobs` → encola manual (body: `assetId` o `publicationId`, `targets[]`,
  `content`, `mediaUrls?`, `scheduledFor?`). 202 con los jobs creados.
- `POST /api/publish-jobs/:id/retry` → reintenta un job fallido/partial (409 si no corresponde).
- `POST /api/publish-jobs/:id/cancel` → cancela un job `queued`/`publishing`.
- **Aprobar**: conectá el circuito con la aprobación real. Opciones (elegí y justificá):
  (a) una ruta nueva `POST /api/assets/:id/approve` que use la transición editorial de PG-01 y encole
  los jobs según las conexiones Zernio del tenant + la config de auto-publicación de PG-03; o
  (b) extender `POST /api/review/:id/approve` para que, cuando el tenant tenga conexiones Zernio,
  encole jobs en vez de publicar directo a los canales legacy.
  **Regla**: si no hay ninguna conexión Zernio ⇒ **comportamiento actual intacto** (legacy), sin
  romper nada. Si la hay ⇒ se encolan jobs y la UI muestra el estado.
- Al publicar con éxito, el asset/publicación de origen pasa a `published` (máquina de estados de
  PG-01, write-through) — o queda en `approved` si el job quedó `partial`. Documentá la decisión.

### 5) UI (español)
- Sección "Publicaciones" (en `/assets` o página propia con entrada en el `Sidebar`): lista de jobs
  con plataforma, cuenta, estado (con badge), intentos, último error, y acciones **Reintentar** /
  **Cancelar**. Estados loading/error/vacío. Todo en español.
- Desde la bandeja, al aprobar un asset, mostrar el resultado (jobs encolados o el motivo por el que
  no se encoló).

## Calidad (gates obligatorios, con salida real)
- `npx tsc --noEmit` → EXIT 0.
- `npx vitest run` (suite completa) → verde con el resumen.
- `node scripts/verify-migration-pglite.mjs` → EXIT 0 (incluye la sección de `publish_jobs`).
- `npm run build` → EXIT 0 y **"No schema changes, nothing to migrate"**.
- `git diff --check` → EXIT 0.
- Tests focalizados nuevos, como mínimo: (a) aprobar encola **un job por red/cuenta**, (b) el worker
  publica con `Idempotency-Key` y mapea 201/200/207/202 a los estados correctos, (c) 429/503 ⇒
  reintentable y 4xx de contenido ⇒ `failed` con categoría, (d) retry respeta `max_attempts` y
  `canTransition`, (e) aislamiento por tenant (un tenant no ve jobs de otro), (f) **sin conexiones
  Zernio ⇒ el approve legacy sigue funcionando igual**.
- Nada de llamadas a la red real en tests/imports (todo inyectado).

## Reglas de git
- Commit convencional con **paths explícitos** (nunca `git add -A` ni `git add .`), sin atribución de IA.
- **No** incluyas en los commits los `BRIEF*.md` ni `remotion/package-lock.json`.
- **NO push, NO merge a master, NO deploy.**

## Reporte final
SHA + archivos + cómo quedó el circuito aprobar→job→publicación→estado→reintento + salida de los
gates + decisiones (cómo elegiste el camino de approve, qué hace el legacy) + límites reales.
