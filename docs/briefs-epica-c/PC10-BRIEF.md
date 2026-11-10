# PC-10 — Onboarding wizard de 4 pasos (canal → programa → personas → Zernio) con estado `onboarding_completed`

Ejecutá este brief **end to end, de forma autónoma**. Nunca esperes aprobación. Si algo del brief es imposible,
NO lo simules: dejalo sin hacer, explicá por qué en el reporte y seguí con el resto.

## Objetivo del slice (último item de la Épica C)

Un tenant nuevo debe poder **configurar su canal en 4 pasos guiados** y quedar marcado como onboardeado. Estado
persistido: **`onboarding_completed`**.

## Contexto real (verificado)

- Repo `periodistapp`: **Express 4 + TypeScript (API) + React SPA (Vite) + Drizzle/Postgres**.
- Base: `origin/master` @ `b0c090f` (PC-01..PC-09 ya integrados).
- **Estado persistente**: el repo ya tiene la tabla `settings` (`src/server/db/schema/misc.ts`) con PK
  `(tenant_id, key)` y `value text`. Y el service `databaseService.ts` con `getSetting(key, tenantId)`,
  `setSetting(key, value, tenantId)`, `getSettingsByPrefix(prefix, tenantId)`, `deleteSetting(key, tenantId)` —
  **todos con `tenantId` obligatorio** (decisión de PA-12: no se confía en el tenant implícito).
  **Usá `settings`**: no hace falta migración nueva. Claves sugeridas (documentá las que elijas):
  `onboarding_completed` (`'true'`/`'false'`) y `onboarding_step` (JSON con el avance).
- **Los 4 pasos y con qué se llenan** (todo ya existe en master, no hay que inventar módulos):
  1. **Canal**: datos del canal ⇒ `tenants` (`name`, `slug`, `platformName`, `timezone`, `logoUrl`…,
     `src/server/db/schema/tenants.ts`). El tenant del usuario es `req.auth!.tenantId`.
     OJO: `slug` es **único global**; si el wizard lo edita, validá el formato (slugify) y el conflicto (409).
  2. **Programa**: ⇒ `programs` (`src/server/db/schema/programs.ts`) — ya hay API CRUD en
     `src/server/routes/programs.ts` (`GET/POST /api/programs`, `GET/PUT/DELETE /api/programs/:id`).
  3. **Personas**: ⇒ `persons` (`src/server/db/schema/persons.ts`) — ya hay API CRUD en
     `src/server/routes/persons.ts` (`GET/POST /api/persons`, `GET/PATCH/DELETE /api/persons/:id`) y la UI
     `src/client/pages/PersonsPage.tsx`. **Reutilizá esas APIs**, no dupliques la lógica.
  4. **Zernio**: **OJO** — en este repo **no existe** Zernio (verificado: `grep -rn "zernio" src` → 0 hits).
     Lo que hay son **canales/redes**: `social_portfolios` + `business_assets`
     (`src/server/db/schema/social.ts`) y la API `src/server/routes/connections.ts`
     (`GET/POST /api/connections/portfolios`, `DELETE /api/connections/portfolios/:id`, `POST .../twitter`).
     **El paso 4 debe ser el de "canales/redes"**: listar las redes disponibles, permitir elegir cuáles activar y
     **guardar la preferencia**. Si el producto lo llama "Zernio" en otros documentos, aclará en el reporte que en
     esta base de código el equivalente es el bloque de canales/redes (`social_portfolios`).
     **No inventes una integración con Zernio que no existe.**

## Decisiones de diseño (aplicalas)

1. **Estado**: `onboarding_completed` en `settings` con clave exacta `onboarding_completed`, valor `'true'` o
   `'false'`. El estado del wizard (paso actual, pasos completados) va en `onboarding_state` (JSON).
2. **Endpoints** (nuevo router `src/server/routes/onboarding.ts`, montado `app.use("/api/onboarding", ...)`,
   `requireAuth` en todas):
   - `GET /api/onboarding/status` ⇒ `{ completed: boolean, currentStep: number, steps: [{ id, title, completed,
     required, done }], data?: {...} }`. `completed` sale de `settings.onboarding_completed === 'true'`.
   - `POST /api/onboarding/step/:stepId` ⇒ guarda el avance de **un** paso (`channel|program|persons|channels`)
     y devuelve el status recalculado. Body por paso:
     - `channel`: `{ name?, platformName?, timezone?, slug? }` (aplica a `tenants` del usuario).
     - `program`: `{ programId }` (o `{ name, ... }` para crear uno nuevo vía la API de programas) — **reusá**
       `src/server/routes/programs.ts` / el service de programas si lo hay.
     - `persons`: `{ personIds: string[] }` (ids ya creados por el usuario) — o `{ create: [{name, role}] }`.
       **Reusá** la API de personas.
     - `channels`: `{ portfolioIds: string[] }` (redes activadas) — o `{ create: [{ name }] }`.
   - `POST /api/onboarding/complete` ⇒ marca `onboarding_completed = 'true'` **sólo si los pasos requeridos están
     cumplidos**; si no, **400** con el detalle de qué falta.
   - `POST /api/onboarding/reset` ⇒ vuelve a `onboarding_completed = 'false'` y limpia `onboarding_state`
     (sólo para el owner del tenant; usá el gate de rol que ya exista en el repo — mirá `requireRole`).
3. **Wizard en el cliente**: nueva página `src/client/pages/OnboardingPage.tsx` + ruta `/onboarding` en
   `src/client/main.tsx` (dentro del bloque `PrivateRoute` + `Layout`). Cuatro pasos con indicador de avance,
   cada uno con su formulario, botón "Siguiente"/"Atrás" y validación **en el cliente** (lo obvio) **y** en el
   servidor (lo real).
4. **Redirección**: si el tenant **no** tiene `onboarding_completed`, las páginas principales del producto
   (por ejemplo `/dashboard`) deben **redirigir a `/onboarding`**. Y si ya lo tiene, `/onboarding` debe redirigir
   a `/dashboard`. Implementalo en el cliente (un guard en el router o en `AuthContext`/`Layout`) **sin**
   romper el login ni las rutas públicas (`/login`, `/register`, `/forgot-password`, `/accept-invite`).
   Ojo: `Layout.tsx` renderiza el `Sidebar` + contenido; el guard debe dejar pasar las páginas de auth.
5. **Aislamiento**: todo por `req.auth!.tenantId`. El `tenant_id` nunca viene del body. Los ids de programa,
   persona o portfolio que lleguen en el body se **validan contra el tenant** antes de usarlos (404/400).
6. **Escribí el paso 4 con el nombre real del dominio**: "Canales y redes" (con la aclaración Zernio en el reporte).

## Qué hay que construir

### A. Backend
- `src/server/routes/onboarding.ts` (nuevo) con los 4 endpoints de arriba.
- `src/server/services/onboardingService.ts` (nuevo): lectura/escritura del estado en `settings`
  (`onboarding_completed`, `onboarding_state`), cálculo de pasos cumplidos y la validación de "puedo completar".
  **Reusa** `getSetting`/`setSetting` de `databaseService.ts` (con `tenantId` explícito).
- Montaje en `src/server/index.ts`.

### B. Frontend
- `src/client/pages/OnboardingPage.tsx` (nuevo): los 4 pasos.
- Ruta `/onboarding` + guard de redirección (§4).
- Usá `useApi()` y los componentes/estilos existentes. Nada de datos inventados.

### C. Tests
`npx vitest run` verde. Lo testeable sin DB:
- El **cálculo de pasos cumplidos** y la **regla de "puedo completar"** como funciones puras testeables
  (p.ej. `computeOnboardingStatus(state)` y `missingRequirements(state)`): tenant sin nada ⇒ paso 1 pendiente;
  canal completo ⇒ paso 1 cumplido; los 4 cumplidos ⇒ `canComplete = true`; con `onboarding_completed` ya en
  `'true'` ⇒ `completed = true`.
- La **validación de ids contra el tenant** de los ids del body (programa/persona/portfolio de otro tenant ⇒
  error), como función pura.

## Verificación (exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

`npm run build` debe seguir imprimiendo **"No schema changes, nothing to migrate"** (esta slice **no** debe tocar
el schema: el estado va en `settings`).
Ojo: el runner PGlite puede fallar con `stdin is not a tty` de forma transitoria; si pasa, re-corré y reportá la
corrida que terminó.

## Fuera de scope (NO lo implementes)

- Cualquier integración real con Zernio (no existe en esta base de código).
- El pipeline de ingesta, el scheduler, los estados en vivo (Épica D).
- Cambios de schema/migraciones. No agregues columnas a `tenants` ni a `settings`.
- No reescribas los módulos existentes (programas, personas, canales): el wizard los **consume**.
- No agregues dependencias.

## Límites duros

- **NO push**, **NO merge** a master, **NO deploy**.
- **NO toques** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`: todo en este worktree.
- **NO uses `git add -A` ni `git add .`**: commit con **paths explícitos**.
- Commit **conventional** (`feat(onboarding): ...`), **sin atribución de IA**, sin `Co-Authored-By`.
- No borres ni reescribas untracked preexistentes.
- Si algo es imposible, no lo simules: explicá por qué en el reporte y seguí con el resto.

## Reporte final (obligatorio)

1. SHA del commit + `git show --stat`.
2. Exit code de cada gate + línea "No schema changes…" + línea de resumen de vitest.
3. Endpoints creados (método + ruta + códigos) y rutas de UI.
4. **Claves de `settings` usadas** y su formato exacto; cómo se calcula `onboarding_completed`.
5. La regla de "puedo completar" (qué exige cada paso) y qué pasa si se intenta completar antes.
6. Cómo funciona el guard de redirección sin romper el login.
7. La aclaración del paso 4 (Zernio vs canales/redes en este repo).
8. Qué quedó fuera y por qué.
