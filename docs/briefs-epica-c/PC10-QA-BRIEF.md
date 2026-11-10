# PC-10 QA FINAL — read-only, contexto fresco

Revisá el commit `21cb9a9` de la rama `pc-10-onboarding-wizard` contra la base `b0c090f`. **Read-only**: no modifiques,
no stages, no commitees, no push, no merge, no deploy. `PC10-QA-BRIEF.md` puede quedar untracked.

## Contexto

PC-10 = **onboarding wizard de 4 pasos** (canal → programa → personas → canales/redes) con estado
`onboarding_completed`. El estado vive en la tabla `settings` (clave `onboarding_completed` + `onboarding_state`),
**sin migración nueva**. El commit agrega `src/server/routes/onboarding.ts`, `src/server/services/onboardingService.ts`,
`src/server/lib/onboardingRules.ts`, `src/client/pages/OnboardingPage.tsx`, `src/client/components/OnboardingGuard.tsx`,
ruta `/onboarding`, **extrae** `src/server/services/programService.ts` desde `routes/programs.ts` (170 líneas movidas),
y `tests/onboarding.test.ts` (239 líneas).

## Qué auditar

### 1. Estado persistido
- ¿Las claves de `settings` son exactamente `onboarding_completed` (`'true'`/`'false'`) y `onboarding_state` (JSON)?
- ¿Se usan `getSetting`/`setSetting`/`deleteSetting` de `databaseService.ts` **con `tenantId` explícito** (nunca el
  tenant implícito)? Esto es crítico: el repo decidió (PA-12) que el tenant **nunca** se trusts por defecto.
- `onboarding_completed` se lee como `'true'` exacto (no truthy de string: `'false'` es truthy en JS — buscá ese bug).
- ¿El estado es **por tenant**? (otro tenant no debe ver ni pisar el estado).

### 2. Endpoints
`GET /api/onboarding/status`, `POST /api/onboarding/step/:stepId`, `POST /api/onboarding/complete`,
`POST /api/onboarding/reset` — mounted en `src/server/index.ts` (`app.use("/api/onboarding", ...)`).
- `requireAuth` en todas. ¿`reset` exige rol owner (mirá `requireRole` en el repo)?
- `complete` antes de tiempo ⇒ **400** con el detalle de qué falta.
- `step/:stepId` con un `stepId` inválido ⇒ 400 con mensaje claro.
- **Aislamiento**: todo por `req.auth!.tenantId`; el `tenant_id` nunca del body; los ids de programa/persona/
  portfolio del body se validan contra el tenant (id ajeno ⇒ 404/400, **nunca** se acepta).

### 3. El guard de redirección (`OnboardingGuard.tsx`) — **punto de riesgo**
- ¿Envuelve **sólo** el grupo privado de `main.tsx`? ¿`/login`, `/register`, `/forgot-password`,
  `/accept-invite` quedan fuera del guard (si no, el login se rompe en loop)?
- Si el tenant no completed ⇒ redirige a `/onboarding`; si completed y está en `/onboarding` ⇒ `/dashboard`.
- ¿Qué pasa con una sesión **sin tenant** (platform admin) y con un **viewer**? El autor dice que los exime —
  verificá que sea así y que no rompa nada.
- Si el `GET /status` **falla** (red/500), ¿el guard deja pasar (fail-open) o bloquea la app? Fail-open es lo
  correcto (no dejar la app inservible por un fallo de red), pero un fallo silencioso de seguridad también es malo:
  el wizard no es una gate de seguridad, así que fail-open está bien — **verificá que sea explícito**.
- ¿El estado se consulta en cada navegación (posible loop de requests)? ¿Hay cache o es aceptable?

### 4. La extracción de `programService.ts` — **riesgo de regresión**
El commit movió ~170 líneas de `routes/programs.ts` a `services/programService.ts` y refactorizó el router.
Esto **no** era necesario para el wizard. Auditalo con lupa:
- ¿La API de programas se comporta **igual**? (mensajes, códigos, transacción con `program_urls`, `ensureUniqueSlug`).
- ¿`slugify` sigue一样? Verificá que el regex de diacríticos y el de caracteres no permitidos sigan iguales
  (el autor lo reescribió con escapes `\u0300-\u036f` — verificá que sea **equivalente** al original).
- Si algo cambió de comportamiento, es un CRITICAL (regresión silenciosa en un módulo preexistente).
- ¿Los tests existentes del repo cubren programas? Si no, decilo como hueco.

### 5. Los 4 pasos
- Paso 1 canal: ¿edita `tenants` del usuario (name/slug/platformName/timezone)? ¿El slug es único global ⇒ 409 si
  choca? ¿Valida formato?
- Paso 2 programa: ¿reusa la API/servicio de programas (crear o referenciar por id)?
- Paso 3 personas: ¿reusa la API de personas (`persons`)?
- Paso 4 canales/redes: usa `social_portfolios`/`business_assets` vía `/api/connections/portfolios`; ids validados
  contra el tenant; opción "(sin emisión)" no aplica acá pero sí debe haber un camino de "sin canales".
- ¿La UI permite volver atrás, saltar pasos ya cumplidos, y muestra qué falta?

### 6. Tests
- `tests/onboarding.test.ts` (239 líneas): ¿prueba el cálculo de pasos, la regla de "puedo completar", la lectura de
  `'true'`/`'false'` y el aislamiento de ids? ¿Qué queda sin probar?
- Suite completa verde (esperado: 7 files / 144 tests).

### 7. Scope
- **Sin** migraciones ni cambios de schema (`drizzle/` y `src/server/db/schema/` intactos).
- Sin integración Zernio (no existe en el repo); el paso 4 es canales/redes.
- Sin dependencias nuevas.

### 8. Gates (a completion, exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check b0c090f..HEAD
git status --short
```

Ojo: el runner PGlite falla de forma **transitoria** con `stdin is not a tty` (ya se vio en varios slices). Si te
pasa, **re-corré** y reportá el resultado de la corrida que terminó (la 2ª/3ª dan 0).

## Salida

**GO** o **NO-GO** estricto. CRITICALS primero (archivo:línea + escenario concreto). Después warnings.
Exit codes + línea de resumen de vitest. Lo no verificado, explícito.
