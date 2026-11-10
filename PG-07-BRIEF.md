# PG-07 — Migración gradual: Meta/Twitter directo queda como canal legacy opcional

Rama actual: `pg-01-unified-inbox`. PG-01..PG-06 ya están cerrados: **no los reviertas**.
Implementá **sólo PG-07**.

## Objetivo
Que la migración a Zernio sea **gradual y explícita**, sin romper a los tenants que hoy publican con
Meta/Twitter directo: el tenant elige su modo de publicación y el sistema le dice **qué se publica
por dónde** y **qué queda pendiente de migrar**.

## Decisión SDD (aplicar)
- **D-4 — CONVIVENCIA**: Zernio **no reemplaza** a `publishService`. El **Meta directo (Facebook /
  Instagram vía Graph API) y el Twitter directo quedan como canal LEGACY OPCIONAL** para portfolios /
  `businessAssets` que ya existen. Las plataformas nuevas (TikTok, YouTube, LinkedIn, Threads,
  Bluesky, …) van **sólo** por Zernio.
- En este slice **no borres** `publishService`, `metaPublishService`, `twitterService` ni las rutas
  legacy de `connections.ts`. Lo que cambia es **cómo se decide** el camino y **cómo se ve**.

## Alcance

### 1) Configuración del modo de publicación por tenant
- Un modo por tenant, persistido de forma tenant-scoped. Opciones (elegí una y justificá):
  - fila en `settings` con key por tenant (p. ej. `publish_channel_mode`), o
  - tabla propia `publish_channel_settings` (tenant_id UNIQUE, mode, notes, updated_at).
  `mode` ∈ `zernio` | `legacy` | `hybrid`.
  - `zernio`: todo lo publicable va por Zernio (jobs). El legacy queda disponible **bajo demanda
    explícita** (el usuario elige "publicar por canal legacy" en esa publicación), nunca por defecto.
  - `legacy`: se mantiene el comportamiento actual (publicación directa) para Meta/Twitter; las
    plataformas nuevas **no** tienen camino legacy ⇒ si no hay conexión Zernio, se informa.
  - `hybrid` (default de Tenant nuevo y **default de los tenants existentes sin config**): Zernio
    para las plataformas con conexión Zernio; Meta/Twitter directo para los portfolios/`businessAssets`
    legacy que todavía no se migraron.
- **Default seguro**: un tenant sin configuración debe seguir comportándose **igual que hoy**
  (hoy publica por Meta/Twitter directo) ⇒ el default efectivo tiene que ser `hybrid`, no `zernio`.
  Documentá el default y por qué.
- Config **desde la API** (`GET`/`PUT`) con `requireAuth` + `req.auth!.tenantId`, validando el
  `mode` contra la lista cerrada. Registrar auditoría con `auditFromRequest` como hacen las demás
  rutas del repo.

### 2) Resolución del camino de publicación (una sola fuente de verdad)
- Una función/servicio del dominio, p. ej. `resolvePublishChannels({tenantId, platform})`, que
  responda: para esa plataforma y ese tenant, ¿va por Zernio, por legacy, o no hay camino?
  Reglas:
  - Plataforma **nueva** (TikTok, YouTube, LinkedIn, Threads, Bluesky, Pinterest, Reddit…): sólo
    Zernio. Si no hay conexión ⇒ error claro ("conectá la cuenta en Conexiones").
  - Meta/Twitter: Zernio si el tenant tiene una **conexión Zernio** de esa plataforma **y** su
    portfolio/`businessAsset` legacy **no** está marcado como "legacy-only"; si no, legacy.
  - El criterio "legacy-only" debe ser **explícito y persistido** (p. ej. una marca en
    `business_assets` / `social_portfolios` o en la propia conexión), no una heurística invisible.
    Elegí el mecanismo y justificá.
- **Integrarlo con el circuito de PG-05**: el approve (o el encolado de jobs) debe usar esta
  resolución para elegir canal, en lugar de decidir "si hay conexión Zernio, va por Zernio" a
  ciegas. Si el modo es `legacy` y la plataforma es legacy ⇒ sigue el camino legacy **igual que hoy**
  (mismo `publishToChannels`), sin cambios de comportamiento.
- `tenant_id` en todas las queries. Cero regresiones: si no hay config, el comportamiento es el de hoy.

### 3) Estado de migración visible (UI, español)
- En la sección de **Conexiones** (la que construyó PG-04) y/o en **Configuración**, mostrar por
  plataforma: **conectado por Zernio** / **legacy (Meta directo)** / **sin conectar**, y qué queda
  pendiente de migrar. Que el usuario pueda marcar un portfolio legacy como "legacy-only" (o
  equivalente) y cambiar el modo del tenant.
- Todo en español, con loading/error/vacío. Mostrar el motivo cuando una plataforma no tiene camino.

### 4) Documentación
- Un doc corto en `docs/` (p. ej. `docs/PUBLICACION-CANAALES.md`) explicando: los dos caminos, el
  default `hybrid`, cómo se migra un portfolio de Meta directo a Zernio, y qué queda deprecado pero
  soportado. Sin inventar features ni precios.

## Calidad (gates obligatorios, con salida real)
- `npx tsc --noEmit` → EXIT 0.
- `npx vitest run` (suite completa) → verde con el resumen.
- `node scripts/verify-migration-pglite.mjs` → EXIT 0 (incluye la sección nueva si hubo migración).
- `npm run build` → EXIT 0 y **"No schema changes, nothing to migrate"**.
- `git diff --check` → EXIT 0.
- Tests focalizados nuevos, como mínimo: (a) tenant sin config ⇒ comportamiento legacy (regresión
  cero), (b) modo `zernio` ⇒ plataforma nueva va por Zernio y legacy sólo bajo demanda,
  (c) modo `legacy` + portfolio legacy ⇒ camino legacy, (d) `hybrid` ⇒ Zernio para lo conectado y
  legacy para lo no migrado, (e) plataforma nueva sin conexión Zernio ⇒ error claro, (f) aislamiento
  por tenant, (g) la UI/estado de migración refleja el modo real.

## Reglas de git
- Commit convencional con **paths explícitos** (nunca `git add -A` ni `git add .`), sin atribución de IA.
- **No** incluyas en los commits los `BRIEF*.md` ni `remotion/package-lock.json`.
- **NO push, NO merge a master, NO deploy.**

## Reporte final
SHA + archivos + cómo se decide el canal por plataforma + salida de los gates + decisiones (dónde
vive el modo, cómo se marca "legacy-only", default y por qué) + límites reales.
