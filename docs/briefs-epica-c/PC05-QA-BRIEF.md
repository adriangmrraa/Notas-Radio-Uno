# PC-05 QA FINAL — read-only, contexto fresco

Revisá el commit `2410ff3` de la rama `pc-05-editorial-ui` contra la base `e6c0757`. **Read-only**: no modifiques,
no stages, no commitees, no push, no merge, no deploy. `PC05-QA-BRIEF.md` puede quedar untracked.

## Contexto

PC-05 = **línea editorial**: resolución del perfil efectivo (default del tenant → override por programa, merge por
campo) + API `/api/editorial/*` + UI `EditorialPage` (`/editorial`). El schema `editorial_profiles` ya existía
(PC-01) y **no debe** haber sido tocado. El commit agrega `src/server/services/editorialService.ts`,
`src/server/routes/editorial.ts`, `src/client/pages/EditorialPage.tsx`, ruta + nav, y tests
(`tests/editorial-resolution.test.ts`, `tests/helpers/memoryEditorialStore.ts`).

## Qué auditar

### 1. Regla de merge (el corazón del slice)
Decisión de diseño que debe estar implementada:
- base = perfil default del tenant (`program_id IS NULL`); si no existe ⇒ default de plataforma (tono `formal`).
- override de programa: **merge por campo**. Escalares (`name`, `tone`, `industry`, `signature`, `toneDescription`,
  `styleGuide`): el override pisa si **no es null**; `tone` pisa siempre si hay fila de override. Arrays jsonb
  (`rules`, `activeFormats`, `forbiddenTopics`, `examples`): el override pisa **sólo si tiene ≥1 elemento**;
  array vacío ⇒ hereda.
- `sources.overriddenFields` lista exactamente los campos pisados.
Verificá esto leyendo el código **y** mirando los tests. ¿Hay algún campo cuyo merge se desvíe de la regla?
¿`examples` con elementos malformados (no objetos, sin `excerpt`) se filtran o rompen?

### 2. Aislamiento multi-tenant
- Cada query de `editorialService.ts` y `routes/editorial.ts` filtra por `tenant_id` del `req.auth`.
- `programId` de otro tenant ⇒ **404** en PUT/DELETE, y en GET el efectivo se resuelve **sin** el override ajeno.
- `programs` se valida contra el tenant antes de crear el override.
- El `tenant_id` nunca viene del body.

### 3. API
- Rutas y métodos: `GET /api/editorial/profile`, `PUT /api/editorial/profile` (default tenant),
  `PUT /api/editorial/profile/:programId` (override), `DELETE /api/editorial/profile/:programId`,
  `GET /api/editorial/programs`. Montaje en `src/server/index.ts` (`app.use("/api/editorial", ...)`).
- `requireAuth` en todas.
- Validación del body: `tone` ∈ {formal, informal, urgente, analitico, custom}; `rules`/`activeFormats`/
  `forbiddenTopics` = arrays de strings; `examples` = array de `{title, excerpt}`; **qué pasa con input malformado**
  (¿400 con mensaje claro o 500?). ¿El body puede meter `tenantId`/`id` y sobrescribir algo?
- ¿El upsert del default del tenant respeta el unique index `editorial_profiles_tenant_default_unique`?
  (Ojo: un `INSERT` a secas con `program_id=null` puede chocar con ese índice parcial → ¿hace upsert real?)

### 4. UI
- Ruta `/editorial` dentro del bloque `PrivateRoute` de `main.tsx`; ítem de nav en **`Sidebar.tsx`** (`NAV_MAIN`).
- Usa `useApi()` (no `fetch` pelado).
- Permite: editar default del tenant, ver/editar override por programa, resetear (borrar) override, ver qué campos
  vienen del tenant y cuáles del override.
- Estados: carga, vacío honesto, errores visibles. Nada de datos inventados.
- El formulario realmente persiste todos los campos del schema: `name`, `tone`, `toneDescription`, `styleGuide`,
  `rules`, `examples`, `industry`, `activeFormats`, `forbiddenTopics`, `signature`, `isActive`.

### 5. Tests: ¿prueban algo real?
- `tests/editorial-resolution.test.ts` corre contra un store **en memoria**. Auditalo: ¿los asserts reflejan la lógica
  real del merge? ¿el store en memoria replica los filtros por tenant del store drizzle? Enumerá **qué queda sin
  probar** (p.ej.: la capa HTTP, el upsert real contra Postgres, el unique index parcial).
- ¿Los tests de PC-04 (`face-enrollment.test.ts`) siguen pasando? (vitest corre toda la suite.)

### 6. Scope y deriva
- `drizzle/`, `drizzle/meta/` y `src/server/db/schema/` **NO** tocados.
- **NO** hay inyección del perfil en prompts (eso es PC-06): verificá que `newsService.ts`,
  `contentMultiplierService.ts`, `insightService.ts`, `clipService.ts`, `alertService.ts` y `pipelineService.ts`
  NO fueron tocados.
- Sin dependencias nuevas, sin migraciones, sin caracteres corruptos (`grep -n '⬦\|�'`).

### 7. Gates (a completion, exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check e6c0757..HEAD
git status --short
```

## Salida

**GO** o **NO-GO** estricto. CRITICALS primero (archivo:línea + escenario concreto). Después warnings.
Exit codes + línea de resumen de vitest. Si algo no lo pudiste verificar, decilo explícitamente como
**"no verificado"**.
