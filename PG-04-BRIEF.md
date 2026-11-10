# PG-04 — Integración Zernio: conexión de cuentas → `social_connections`

Rama actual: `pg-01-unified-inbox` (tip `866368d`). PG-01 (`ef87d8a`) y PG-02 (`bced945`..`866368d`)
ya estáncerrados y verificados: **no los reviertas**. Implementá **sólo PG-04**.

Leyé primero `BRIEF-ZERNIO-API.md` (referencia verificada de la API de Zernio: endpoints, modelos de
respuesta, códigos de error). **No inventes endpoints ni campos**: usá esa referencia (si falta algo,
verificá en `https://docs.zernio.com` o el OpenAPI `https://zernio.com/openapi.yaml`).

## Objetivo
Que un cliente conecte su Instagram (y otras redes) **sin que PeriodistApp nunca vea credenciales**:
el OAuth lo hospeda Zernio, PeriodistApp sólo guarda identificadores opacos de cuenta
(`accountId`, `username`, `platform`) y el `profileId` de Zernio.

## Decisiones SDD (aplicar, no discutir)
- **D-4 — CONVIVENCIA**: Zernio **no reemplaza** a `publishService`. Zernio es el canal **default para
  plataformas nuevas** (TikTok, Instagram, YouTube, LinkedIn, Threads, Bluesky, …). El **Meta directo
  (y Twitter directo) queda como canal legacy opcional** para portfolios/`businessAssets` ya
  existentes. En este slice **no** borres ni migres nada de Meta/Twitter: sólo no lo rompas.
- **Un perfil Zernio por tenant**, con `externalId = tenantId` (guía multi-tenant de Zernio).
  `profileId` es la vía de aislamiento de las llamadas.
- **Connect embebido white-label**: `welcome=true` + `brandName` + `logoUrl` → pantalla propia de
  Zernio antes de la OAuth. El branding sale de la config del tenant ya existente (`brandingService`).
- **Nunca ver credenciales sociales**: no se almacenan tokens, ni access tokens, ni secretos de las
  redes. Sólo ids opacos de Zernio. La API key de la plataforma (`ZERNIO_API_KEY`, env) nunca se
  loguea, nunca sale por API, nunca se escribe en DB ni en commits.

## Alcance

### 1) Migración — `social_connections` (+ perfil Zernio del tenant)
El número de migración lo asigna `drizzle-kit` (0016 si es la primera pendiente en la rama; si PG-03
ya generó una, será la siguiente: **no fuerces el número ni renumeres migraciones existentes**).
`src/server/db/schema/social.ts` (o un schema nuevo si encaja mejor) + export en `index.ts`:
- `social_connections`: `id` uuid PK, `tenant_id` NOT NULL FK tenants cascade + index,
  `platform` varchar(32) NOT NULL (valor API de Zernio: `instagram`, `tiktok`, `linkedin`, …),
  `account_id` varchar(64) NOT NULL (id de cuenta **de Zernio**, no de la red),
  `username` varchar(255), `display_name` varchar(255),
  `status` varchar(20) NOT NULL default 'connected' (`connected` | `disconnected` | `error`),
  `zernio_profile_id` varchar(64) NOT NULL,
  `last_synced_at` timestamp, `created_at`, `updated_at`.
  UNIQUE `(tenant_id, platform, account_id)` + índice `(tenant_id, status)`.
- **Perfil Zernio del tenant**: tabla propia tenant-scoped (p. ej. `zernio_profiles`: `tenant_id`
  UNIQUE FK cascade, `profile_id` varchar(64) NOT NULL, `name`, `created_at`, `updated_at`) **o** una
  fila en `settings` con key por tenant — **decidí y documentá**. Preferí tabla propia: el
  `profile_id` es un recurso externo con vida propia y merece FK/índice y no mezclarlo con
  settings genéricos.
- Migración Drizzle (`npx drizzle-kit generate`) + sección nueva en
  `scripts/verify-migration-pglite.mjs` que compruebe tablas/columnas/índices y **idempotencia**
  (aplicar dos veces). SQL idempotente según `periodistapp-gates`.

### 2) Cliente Zernio (`src/server/services/zernioService.ts`)
- Wrapper HTTP con `fetch` (o axios, ya está en el repo) y base `https://zernio.com/api/v1`,
  header `Authorization: Bearer ${process.env.ZERNIO_API_KEY}`.
- **Si `ZERNIO_API_KEY` no está**: no romper imports ni tests. La función debe fallar en runtime con
  un error claro (`AppError` 503 `zernio_not_configured`) **sólo** cuando se usa.
- Funciones mínimas: `ensureProfileForTenant(tenantId)` (idempotente: `POST /v1/profiles` con
  `externalId=tenantId` + `Idempotency-Key`; si responde 409, recuperar con
  `GET /v1/profiles?externalId=<tenantId>`; si el GET tampoco lo trae, crearlo),
  `getConnectUrl({profileId, platform, redirectUrl, brandName, logoUrl})`
  (`GET /v1/connect/{platform}` con `welcome=true`), `listAccounts(profileId)`
  (`GET /v1/accounts?profileId=…`), `disconnectAccount(accountId)` (`DELETE /v1/accounts/{id}`).
- **Inyectable** para tests (patrón `deps` del repo): los tests **no** pegan a la red real.
- Timeouts razonables y errores mapeados a `AppError` con `code` (no filtrar la API key en el error
  ni en el log).

### 3) Rutas (`src/server/routes/socialConnections.ts` + registro en `src/server/index.ts`)
Todas con `requireAuth` y `req.auth!.tenantId`; **todo** filtrado por `tenant_id`.
- `GET /api/social-connections` → lista las conexiones del tenant (desde DB, no desde Zernio).
- `GET /api/social-connections/accounts` → lista las cuentas que Zernio reporta para el perfil del
  tenant (sirve para "traer cuentas que ya estaban conectadas");Response con `platform`, `accountId`,
  `username`, `displayName`, `status`.
- `POST /api/social-connections/connect` body `{ platform }` → devuelve `{ authUrl, state }`:
  1) `ensureProfileForTenant`, 2) `getConnectUrl` con `welcome=true`, `brandName`/`logoUrl` del
  branding del tenant, 3) `redirect_url` a **una ruta de callback propia** que Include un **state
  firmado** (HMAC con `JWT_SECRET` o similar) que liga el callback a `tenantId` + `platform` +
  expiración (ej. 15 min). Sin state válido el callback no puede escribir nada.
  Validar `platform` contra la lista de plataformas de Zernio (la de `BRIEF-ZERNIO-API.md`).
- `GET /api/social-connections/callback` (o POST si lo preferís) → recibe los params que Zernio
  agrega al `redirect_url`: `connected`, `profileId`, `accountId`, `username` (+ `request_id`, `stage`).
  Verificá el **state firmado** ⇒ `tenantId`; verificá que el `profileId` recibido sea el del tenant;
  verificá `connected`; recién entonces hacé upsert en `social_connections`
  (UNIQUE `(tenant_id, platform, account_id)`). Después redirigí al cliente (frontend) con un
  resultado ok/error. **Nunca** aceptes un `tenantId` que venga del query sin firmar.
- `DELETE /api/social-connections/:id` → desconecta (borra/desactiva la fila local; llama a Zernio
  `DELETE /v1/accounts/{accountId}` si la API lo soporta y propagá el error real).
- `POST /api/social-connections/sync` → re-sincroniza las cuentas de Zernio con la tabla local
  (marca `disconnected` a las que Zernio ya no reporta). Tenant-scoped.

### 4) UI (español)
- Nueva sección/página de conexiones (o extension de `ConnectionsPage`) para **Zernio**: listar
  conexiones (plataforma, usuario, estado), botón "Conectar Instagram" (y las otras plataformas
  soportadas) que abre `authUrl` en pestaña nueva, manejar el retorno (callback) y refrescar la lista.
  Todo en **español**, con estados loading/error/vacío coherentes con el resto del cliente.
- La UI **nunca** recibe la API key ni tokens.

### 5) Límite de plan
Al conectar: si el plan del tenant tiene `maxConnectedPlatforms` y el tenant ya tiene ese número de
plataformas conectadas, **rechazar con 403 y mensaje claro** (`max_connected_platforms`). Reutilizá
el patrón existente de `connections.ts` / `onboardingService.ts`.

## Calidad (gates obligatorios, con salida real)
- `npx tsc --noEmit` → EXIT 0.
- `npx vitest run` (suite completa: PG-01/PG-02 no deben romperse) → verde, con el resumen.
- `node scripts/verify-migration-pglite.mjs` → EXIT 0 (incluye la sección nueva de 0016).
- `npm run build` → EXIT 0 y **"No schema changes, nothing to migrate"** (si genera migración
  nueva, es drift: investigá y arreglalo).
- `git diff --check` → EXIT 0.
- Tests focalizados nuevos, como mínimo: (a) conectar sin API key ⇒ error honesto, (b) state inválido o
  de otro tenant ⇒ no escribe nada, (c) upsert de conexión es idempotente y tenant-scoped, (d) el
  `authUrl` que se devuelve incluye `welcome=true` y el `profileId` del tenant, (e) límite de plan
  ⇒ 403, (f) **la API key no aparece en ningún log/respuesta**.
- Nada de llamadas a la red real en tests/imports.

## Reglas de git
- Commit convencional con **paths explícitos** (nunca `git add -A` ni `git add .`), sin atribución de IA.
- **No** incluyas en los commits: `BRIEF.md`, `PG-02-BRIEF.md`, `PG-02-REPAIR-BRIEF.md`,
  `BRIEF-ZERNIO-API.md`, `PG-04-BRIEF.md` ni `remotion/package-lock.json`.
- **NO push, NO merge a master, NO deploy.**

## Reporte final
SHA de los commits + archivos + endpoints/UI agregados + salida de los gates + decisiones tomadas
(dónde guardaste el `profile_id`, cómo firmaste el `state`, cómo se limita por plan) + cualquier
límite real que quede (p. ej. plataformas que Zernio hospeda pero que no expusiste).
