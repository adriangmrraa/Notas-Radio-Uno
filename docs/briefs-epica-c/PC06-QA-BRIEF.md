# PC-06 QA FINAL — read-only, contexto fresco

Revisá el commit `e2d4016` de la rama `pc-06-editorial-prompts` contra la base `c67d397`. **Read-only**: no modifiques,
no stages, no commitees, no push, no merge, no deploy. `PC06-QA-BRIEF.md` puede quedar untracked.

## Contexto

PC-06 = **inyectar la línea editorial efectiva en los prompts**. El perfil ya existe (PC-05:
`getEffectiveProfile(tenantId, programId?)` en `src/server/services/editorialService.ts`). El commit agrega
`src/server/services/editorialPromptService.ts` (serializador puro) y lo inyecta en: nota (`newsService.generateNewsCopy`),
título (`newsService.generateTitle`), copies (`contentMultiplierService.generateContentVariants` / `regenerateVariant`),
momentos/clips (`clipService.detectHighlights`), alertas (`alertService.detectAlerts`) e insights
(`insightService.extractInsights`). Call sites: `pipelineService.ts`, `routes/generate.ts`, `routes/review.ts`.

## Qué auditar

### 1. El bloque editorial (contrato)
- `buildEditorialPromptBlock(profile)`: perfil vacío ⇒ `""`; `isActive=false` ⇒ `""`; con datos ⇒ menciona tono,
  descripción, guide, reglas, ejemplos, rubro, formatos activos, temas prohibidos y firma.
- **Reglas y temas prohibidos como restricciones**, no como contexto decorativo (buscá el texto exacto).
- ¿El bloque puede filtrar datos de otro tenant? (sólo debe usar el shape ya resuelto).
- Límite de tamaño: ¿el bloque puede explotar el prompt? (perfil con 500 reglas / ejemplos gigantic ⇒ ¿hay tope?)

### 2. ¿Se inyecta de verdad? — el AC del slice
Recorré **cada** punto de generación y confirmá que el bloque llega al prompt:
- `generateNewsCopy` y `generateTitle` (newsService).
- `generateContentVariants` y `regenerateVariant` (contentMultiplierService).
- `detectHighlights` (clipService), `detectAlerts` (alertService), `extractInsights` (insightService).
Para cada uno: ¿el parámetro es **opcional** (no rompe call sites viejos)? ¿el bloque se intercala en el prompt?
**Ojo**: un parámetro opcional que nadie pasa en el call site real = el perfil NO llega ⇒ eso sería un CRITICAL.
Verificá los call sites: `pipelineService.ts` debe resolver el bloque **con `this.tenantId` y
`this.config.programId`** y pasarlo; `routes/generate.ts` y `routes/review.ts` deben resolverlo con
`req.auth.tenantId` y pasar el `programId` opcional **validando que sea del tenant**.

### 3. Resolución y aislamiento
- ¿Se usa `getEffectiveProfile` (tenant → override por programa)? ¿El `programId` del body se valida contra el
  tenant antes de usarlo (404/400 si es ajeno)? ¿El `tenant_id` sale siempre del auth?
- ¿Hay algún path donde el perfil de otro tenant pueda entrar al prompt?

### 4. Fallback / degradación (honestidad)
- Sin perfil ⇒ el prompt queda **igual que hoy** (comportamiento actual intacto).
- Si la resolución del perfil lanza (error de DB) ⇒ **no se rompe la generación**: log + contexto vacío.
  Verificá que el `catch` exista y que no se propague la excepción.
- `isActive=false` ⇒ no se inyecta.

### 5. `activeFormats` (filtrado de formatos)
- `activeFormats` vacío/undefined ⇒ las 5 variantes (default histórico).
- `activeFormats` = `["twitter","linkedin"]` ⇒ el prompt pide sólo esas y las otras quedan vacías
  (`instagramCarousel: []`, `youtubeDescription: ""`, `newsletterBlurb: ""`), **sin romper el shape** de
  `ContentVariants` (`src/shared/types.ts`).
- `activeFormats` con formatos que no son de variantes (ej. `["flash","corta"]`) ⇒ no restringe las variantes.
- Mapeo de nombres: ¿`twitter` ↔ `twitterThread`, `instagram` ↔ `instagramCarousel`, `linkedin` ↔ `linkedinPost`,
  `youtube` ↔ `youtubeDescription`, `newsletter` ↔ `newsletterBlurb`? Verificá que no haya discrepancias.

### 6. Precedencia de tono
- El `tone` histórico (`TONE_PROMPTS`) y el `tone` del perfil: ¿el brief dice que el perfil declara el tono de la
  línea editorial y el histórico sigue estando? ¿El código es coherente con esa decisión y está documentado?

### 7. Tests
- `tests/editorial-prompts.test.ts` (24 tests): ¿prueban el serializador y el filtro de formatos de verdad?
  ¿qué queda sin probar (p.ej.: que el bloque llegue al prompt de cada servicio, la capa HTTP)?
- ¿La suite completa (64 tests) sigue verde?

### 8. Scope
- `drizzle/`, `drizzle/meta/`, `src/server/db/schema/` NO tocados; `src/client/` sin cambios.
- Sin dependencias nuevas. PC-07/08/09/10 fuera de scope.
- `git diff --name-only c67d397..HEAD` debería tener **11 archivos** (10 de src + 1 test) — verificá.

### 9. Gates (a completion, exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check c67d397..HEAD
git status --short
```

## Salida

**GO** o **NO-GO** estricto. CRITICALS primero (archivo:línea + escenario concreto). Después warnings.
Exit codes + línea de resumen de vitest. Lo no verificado, explícito.
