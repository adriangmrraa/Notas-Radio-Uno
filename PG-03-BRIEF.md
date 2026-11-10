# PG-03 — Configuración de auto-publicación por tenant/programa (respeta plan)

Rama actual: `pg-01-unified-inbox` (tip `866368d`). PG-01 (`ef87d8a`) y PG-02 (`bced945`..`866368d`)
ya están cerrados y verificados: **no los reviertas**. Implementá **sólo PG-03**.

## Objetivo
Que cada tenant/programa defina **cuándo y a qué plataformas se publica automáticamente** el
contenido que ya sale del pipeline editorial, y que esa configuración **respete el plan del tenant**
(ni una función ni una plataforma de más: si el plan no lo cubre, la config no se guarda / no se activa).

Contexto ya existente que debés reutilizar (no inventar otro):
- `assets` + máquina de estados editorial (`src/server/services/assetsService.ts`, PG-01) — el asset
  aprobado es el que se publica.
- Planes y límites: tabla `plans` (`maxPublicationsPerMonth`, `maxConnectedPlatforms`, `features`
  jsonb) + `tenant_features` (flags efectivos por tenant) + `tenantFeaturesService.ts`
  (`isFeatureEnabled`, `getTenantPlan`, `getTenantFeatureMap`, `FEATURE_CATALOG`).
- `usageTracker.ts` ya trackea publicaciones por mes (mirá cómo calcula `maxPublicationsPerMonth`).
- `programs` (tenant-scoped), `social_connections` **todavía no existe** (es PG-04): por eso esta
  config guarda **plataformas objetivo** (nombre de red), no `accountId`. PG-04/PG-05 la conectarán.

## Alcance

### 1) Migración 0016 — configuración de auto-publicación
Schema nuevo (p. ej. `src/server/db/schema/autoPublish.ts`) + export en `index.ts`:
- `auto_publish_configs`: `id` uuid PK, `tenant_id` NOT NULL FK tenants cascade + index,
  `program_id` uuid NULL FK programs ON DELETE CASCADE + index (NULL = aplica a todo el tenant),
  `mode` varchar(24) NOT NULL default 'off' (`off` | `on_approval` | `scheduled`),
  `platforms` jsonb NOT NULL default '[]' (array de plataformas objetivo; validar contra una lista
  cerrada y **persistir sólo valores válidos**),
  `publish_days` jsonb NOT NULL default '[]' (array 0-6, sólo si `mode='scheduled'`),
  `publish_time` varchar(5) NULL (HH:MM, sólo si `mode='scheduled'`),
  `timezone` varchar(64) NOT NULL default 'America/Argentina/Buenos_Aires',
  `is_active` boolean NOT NULL default true,
  `created_at`, `updated_at`.
  UNIQUE `(tenant_id, program_id)` — ojo: en Postgres `NULL` en un UNIQUE no deduplica ⇒ **el UNIQUE
  debe ser parcial o usar una columna `program_key` NOT NULL** (`'__all__'` para el global). Elegí una
  y justificá en el reporte.
- `npx drizzle-kit generate` + sección nueva en `scripts/verify-migration-pglite.mjs` (tablas,
  columnas, índices y **idempotencia**: aplicar dos veces). SQL idempotente según `periodistapp-gates`.
  (El número de migración lo asigna `drizzle-kit`; no fuerces el número ni renumeres las existentes.)

### 2) Servicio (`src/server/services/autoPublishService.ts`)
- Store pattern del repo: interface `AutoPublishStore` + `createDrizzleAutoPublishStore(db)` +
  memory store en `tests/helpers/` (mismo estilo que `memoryAssetsStore.ts`).
- API del servicio, **tenant-scoped en todas las queries**:
  `getAutoPublishConfig(tenantId, programId?)`, `upsertAutoPublishConfig({tenantId, programId, ...})`,
  `listAutoPublishConfigs(tenantId)`, `deleteAutoPublishConfig(tenantId, id)`.
- **Respeto del plan (OBLIGATORIO, es el acceptance criterion)**:
  - El feature flag `auto_publish` debe existir en `FEATURE_CATALOG` con `byPlan` coherente con los
    planes del repo (`trial`, `creator`, `media`, `network`, `enterprise`) — fijate cómo están definidos
    los demás flags y sumalo de forma consistente, **sin romper** `resolvePlanFeatureDefaults` ni la
    sincronización de `tenant_features` (si un tenant ya tiene filas, `syncTenantFeaturesForTenant`
    debe seguir funcionando: corré los tests de billing/features).
  - Si el feature está deshabilitado para el tenant ⇒ la API responde **403** con motivo claro
    (`feature_disabled`), no guarda nada.
  - Si `mode`Require publicar en N plataformas y el plan define `maxConnectedPlatforms` ⇒ no se puede
    superar ese límite (rechazo con 403 `plan_limit_exceeded` o similar). Si el plan no define
    límite (NULL) ⇒ sin tope.
  - **No inventes precios ni límites**: usá los que ya están en `plans`.
- Validación estricta de la entrada: `mode` ∈ lista cerrada; `platforms` ⊂ lista cerrada de redes
  (instagram, facebook, tiktok, youtube, linkedin, twitter, threads, pinterest, reddit, bluesky…);
  `publish_days` ⊂ 0..6; `publish_time` con regex HH:MM; `programId` debe ser **del tenant** (si no,
  404); `mode='scheduled'` ⇒ `publish_days` no vacío y `publish_time` presente; otros modos ⇒ esos
  campos se ignoran (no se guardan).

### 3) Rutas (`src/server/routes/autoPublish.ts` + registro en `src/server/index.ts`)
Con `requireAuth` y `req.auth!.tenantId`:
- `GET /api/auto-publish` → configs del tenant (con la info de plan que corresponde mostrar:
  p. ej. `planAllowsAutoPublish`, `maxPlatforms`, `usedPlatforms`).
- `PUT /api/auto-publish` body `{ programId?, mode, platforms, publishDays?, publishTime?, timezone? }`
  → upsert tenant-scoped. 200 con la config guardada, 400 validación, 403 feature/plan, 404 programa
  ajeno.
- `DELETE /api/auto-publish/:id` → borra la config del tenant.

### 4) UI (español)
- En `SettingsPage` (o página propia con entrada en el `Sidebar`) una sección **"Auto-publicación"**:
  elegir programa (o "todos los programas"), modo (off / al aprobar / programado), plataformas
  destino (checkboxs), días y hora si es programado, y guardar. Mostrar el estado del plan cuando
  la función no esté disponible (no esconder el motivo). Todo en **español**, con loading/error/vacío
  consistentes con el resto del cliente.

### 5) Lo que NO entra en este slice
- No publiques nada (eso es PG-05 `publish_jobs`), no invoques a Zernio (PG-04), no menciones personas
  (PG-06), no toques Meta/Twitter legacy (PG-07).
- La config no necesita lista de cuentas ni `accountId`: sólo plataformas.

## Calidad (gates obligatorios, con salida real)
- `npx tsc --noEmit` → EXIT 0.
- `npx vitest run` (suite completa) → verde con el resumen.
- `node scripts/verify-migration-pglite.mjs` → EXIT 0 (incluye la sección 0016).
- `npm run build` → EXIT 0 y **"No schema changes, nothing to migrate"**.
- `git diff --check` → EXIT 0.
- Tests focalizados nuevos, como mínimo: (a) upsert + lectura tenant-scoped, (b) `programId` de otro
  tenant ⇒ 404, (c) feature deshabilitado ⇒ 403 y nada guardado, (d) superar `maxConnectedPlatforms`
  ⇒ 403, (e) validación de `mode`/`platforms`/`publishDays`/`publishTime`, (f) el UNIQUE del
  `(tenant_id, program_id)` funciona también para el global (`program_key`).

## Reglas de git
- Commit convencional con **paths explícitos** (nunca `git add -A` ni `git add .`), sin atribución de IA.
- **No** incluyas en los commits: `BRIEF.md`, `PG-02-BRIEF.md`, `PG-02-REPAIR-BRIEF.md`,
  `BRIEF-ZERNIO-API.md`, `PG-03-BRIEF.md`, `PG-04-BRIEF.md` ni `remotion/package-lock.json`.
- **NO push, NO merge a master, NO deploy.**

## Reporte final
SHA de los commits + archivos + endpoints/UI + salida de los gates + decisiones (cómo resolviste el
UNIQUE con `program_id` NULL, qué `byPlan` le diste a `auto_publish`, cómo se calcula el límite de
plataformas) + límites reales que queden.
