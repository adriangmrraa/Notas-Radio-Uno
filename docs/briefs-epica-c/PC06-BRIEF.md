# PC-06 — Línea editorial en prompts: inyectar el perfil en la generación de notas/copies/momentos

Ejecutá este brief **end to end, de forma autónoma**. Nunca esperes aprobación. Si algo es imposible, NO lo
simules: dejalo sin hacer, explicá por qué y seguí con el resto.

## Contexto real (verificado)

- Repo `periodistapp`: **Express 4 + TypeScript + React SPA + Drizzle/Postgres**.
- Base: `origin/master` @ `c67d397` (PC-01 schema, PC-02 datos, PC-03 Personas, PC-04 rostros, PC-05 línea editorial).
- **PC-05 ya está en disco**:
  - `src/server/services/editorialService.ts` expone el perfil efectivo. **Leé el archivo y usá su API real**:
    `getEffectiveProfile(tenantId, programId?)` devuelve el shape resuelto (default del tenant + override del
    programa, merge por campo) con `sources.overriddenFields`. El shape incluye (según el schema
    `src/server/db/schema/editorialProfiles.ts`): `tone`, `toneDescription`, `styleGuide`, `rules` (string[]),
    `examples` ({title, excerpt}[]), `industry`, `activeFormats` (string[]), `forbiddenTopics` (string[]),
    `signature`, `isActive`.
  - `src/server/routes/editorial.ts` monta `/api/editorial/*`; la UI es `src/client/pages/EditorialPage.tsx`.
- **Dónde se genera hoy el contenido** (todo verificado en master):
  - **Notas**: `src/server/services/newsService.ts` → `generateNewsCopy(options)` (prompt con `TONE_PROMPTS[tone]` +
    `STRUCTURE_PROMPTS[structure]` + transcripción + insights + webContext + contexto del editor) y
    `generateTitle(transcription, insights?)`.
    Se llama desde `src/server/services/pipelineService.ts:853` (pipeline automático, con `this.tenantId` y
    `this.config.programId`) y desde `src/server/routes/generate.ts:404` (`POST /api/generateNewsCopy`, manual).
  - **Copies (variantes multiplataforma)**: `src/server/services/contentMultiplierService.ts` →
    `generateContentVariants(title, content, tone)` (recibe un `tone` string) y `regenerateVariant(...)`.
    Se llama desde `pipelineService.ts:1075` (con `this.config.tone`) y desde `src/server/routes/review.ts:385`
    (con `"formal"` hardcodeado).
  - **Momentos (clips)**: `src/server/services/clipService.ts` → `detectHighlights(text, utterances)`
    (prompt "productor de contenido viral"), llamada desde `pipelineService.ts:926`.
  - **Momentos/alertas en vivo**: `src/server/services/alertService.ts` → `detectAlerts(text, keywords, speakerContext?)`
    (prompt de análisis de momentos relevantes), llamada desde `pipelineService.ts:1817`.
  - **Insights**: `src/server/services/insightService.ts` → `extractInsights(transcriptionText, speakerContext?)`.
- **Objetivo del slice**: que el **tono, reglas, ejemplos, rubro, formatos activos, temas prohibidos y firma** del
  perfil editorial (tenant + override del programa) **influencien de verdad** lo que genera la IA.

## Decisiones de diseño (aplicalas, no las re-debatan)

1. **Un único serializador**: `src/server/services/editorialPromptService.ts` (nuevo) con una función pura
   `buildEditorialPromptBlock(profile): string` que devuelve el bloque de instrucciones en español (o `""` si el
   perfil no aporta nada). **Puro y testeable**: sin DB, sin `chatCompletion`.
   El bloque debe incluir, sólo si el dato existe: tono (con su descripción), guide de estilo, reglas (lista),
   ejemplos de referencia (título + extracto), rubro, formatos activos, temas prohibidos, firma/cierre.
   **Nunca debe filtrar datos de otro tenant** (sólo usa el shape que ya viene resuelto).
2. **Fallback honesto**: si no hay perfil para el tenant (ni default ni override), el bloque es `""` y el
   comportamiento de generación queda **igual que hoy** (no se rompe nada). Si el perfil existe pero
   `isActive === false`, el bloque es `""` (línea editorial desactivada ⇒ no se inyecta).
3. **Precedencia de tono**: el `tone` que hoy se pasa como parámetro (`this.config.tone`) manda sobre el `tone` del
   perfil **sólo si el pipeline lo setó explícitamente**; si el perfil define un `tone`, el bloque editorial lo
   declara como **tono de la línea editorial** y el prompt lo presenta como la directriz principal del canal
   (el `TONE_PROMPTS` histórico sigue estando, pero el bloque editorial va después y es más específico).
   Documentá esta precedencia en el código.
4. **Reglas y temas prohibidos van como restricciones explícitas** ("Si una regla o tema prohibido aparece en la
   transcripción, NO lo incluyas"), no como contexto decorativo.
5. **Resolución por programa**: el perfil efectivo se resuelve con `getEffectiveProfile(tenantId, programId)`. En el
   pipeline, `programId` = `this.config.programId` (puede ser null → perfil default del tenant). En los endpoints
   manuales (`/api/generateNewsCopy`, `/api/review/...`), `programId` puede venir en el body **opcionalmente**:
   si viene, validá que el programa sea del tenant (404/400 si no) antes de usarlo.
6. **Degradación**: si la resolución del perfil falla (error de DB), **no rompas la generación**: logueá el error y
   seguí con el prompt sin bloque editorial. La generación de contenido es más importante que el perfil.

## Qué hay que tocar

### A. `src/server/services/editorialPromptService.ts` (nuevo)
- `buildEditorialPromptBlock(profile): string` — puro.
- `resolveEditorialPromptBlock(tenantId, programId?): Promise<string>` — convenience: resuelve el perfil con
  `getEffectiveProfile` y devuelve el bloque; **degrada a `""`** si algo falla (log, no throw).
- Si `profile.isActive === false` ⇒ `""`.

### B. Inyección en la generación

1. **Notas** — `src/server/services/newsService.ts`:
   - `generateNewsCopy`: agregá un parámetro **opcional** `editorialBlock?: string` (o `editorialProfile?`) que se
     inyecte en el `userPrompt` (después del bloque de tono/estructura y antes de la transcripción, o donde tenga
     más sentido para que el modelo lo lea).
   - `generateTitle`: idem — el título también debe respetar la línea editorial (firma, tono, formato).
   - **No cambies** la firma que usan los call sites actuales más de lo necesario: los parámetros nuevos deben ser
     opcionales para no romper los call sites que no los pasan.
2. **Copies** — `src/server/services/contentMultiplierService.ts`:
   - `generateContentVariants(title, content, tone, editorialBlock?)` y `regenerateVariant(..., editorialBlock?)`.
   - `activeFormats` del perfil debe **filtrar** qué variantes se generan: si el perfil define `activeFormats`
     (ej. `["twitter","linkedin"]`), las variantes **no activas** (instagram, youtube, newsletter) **no se generan**
     (se devuelven como arrays/objeto vacío según el shape de `ContentVariants`) y el prompt pide explícitamente
     **sólo** los formatos activos. Esto es parte del AC del slice: "formatos activos".
   - Ojo: `ContentVariants` (`src/shared/types.ts`) tiene forma fija (`twitterThread`, `instagramCarousel`,
     `linkedinPost`, `youtubeDescription`, `newsletterBlurb`) — devolvé los campos no activos como vacíos
     (`[]` / `""`), **no** cambies el tipo.
3. **Momentos (clips)** — `src/server/services/clipService.ts`: `detectHighlights(text, utterances, editorialBlock?)`.
4. **Momentos en vivo (alertas)** — `src/server/services/alertService.ts`: `detectAlerts(text, keywords,
   speakerContext?, editorialBlock?)`.
5. **Insights** — `src/server/services/insightService.ts`: `extractInsights(text, speakerContext?, editorialBlock?)`
   (los insights alimentan las notas; es razonable incluirlos — **decídilo y documentalo**).
6. **Call sites** — `src/server/services/pipelineService.ts`:
   - resolvé el bloque **una vez por corrida** (no por llamada): en el pipeline ya tenés `this.tenantId` y
     `this.config.programId`. Cachealo en el servicio (con una clave `tenantId:programId`) o resolvedlo localmente
     en el método que genera la nota y pasalo a las 4 funciones.
   - pasalo a `generateNewsCopy`, `generateTitle`, `detectHighlights`, `detectAlerts`, `extractInsights` y
     `generateContentVariants`.
   - **Cuidado**: `generateContentVariants` ahora puede filtrar por `activeFormats` ⇒ el pipeline debe seguir
     funcionando si el perfil no define formatos (default: todos los formatos activos).
7. **Call sites HTTP** — `src/server/routes/generate.ts` (`POST /api/generateNewsCopy`) y
   `src/server/routes/review.ts` (regeneración de variantes):
   - resolvé el perfil del tenant (`req.auth.tenantId`) con el `programId` opcional del body (validando que
     pertenezca al tenant) y pasá el bloque.
   - En `review.ts`, el `tone` hardcodeado `"formal"` debe pasar a ser el tono del perfil si existe.

## Tests (obligatorios)

`npx vitest run` verde. Tests de lo que se puede testear sin DB ni IA:
- `buildEditorialPromptBlock`: con perfil vacío ⇒ `""`; con cada campo ⇒ el bloque lo menciona (tono, reglas,
  ejemplos, rubro, formatos, temas prohibidos, firma); con `isActive=false` ⇒ `""`; **reglas/temas prohibidos
  aparecen como restricciones**, no como contexto.
- `generateContentVariants` con `activeFormats` restringido: las variantes no activas quedan vacías (probá el
  **filtro** de formatos: si lo implementás como una función pura tipo `filterActiveFormats(profile, variants)`,
  testeala directo; si va adentro del prompt, al menos testeá la función que decide qué formatos se piden).
- No inventes un mock de `chatCompletion` si no hace falta: lo que se testea es el serializador y el filtro.

## Gates (exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

`npm run build` debe seguir imprimiendo **"No schema changes, nothing to migrate"** (si genera migración, hay drift).

## Fuera de scope (NO lo implementes)

- PC-07/PC-08 (transmisiones, agenda, RRULE), PC-09 (dossier), PC-10 (onboarding).
- Búsqueda por similitud de rostros.
- Cambios de schema/migraciones — **NO toques** `drizzle/`, `drizzle/meta/` ni `src/server/db/schema/`.
- No agregues dependencias. No toques `src/client/` salvo que sea imprescindible (esta es una slice de backend:
  **no debería haber cambios de UI**).

## Límites duros

- **NO push**, **NO merge** a master, **NO deploy**.
- **NO toques** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`: todo en este worktree.
- **NO uses `git add -A` ni `git add .`**: commit con **paths explícitos**.
- Commit **conventional** (`feat(editorial): ...`), **sin atribución de IA**, sin `Co-Authored-By`.
- No borres ni reescribas untracked preexistentes.
- Si algo es imposible, no lo simules: explicá por qué en el reporte y seguí con el resto.

## Reporte final (obligatorio)

1. SHA del commit + `git show --stat`.
2. Exit code de cada gate + línea de resumen de vitest.
3. **Qué se inyecta y dónde**: tabla con cada punto de generación (nota, título, copies, momentos/clips,
   alertas, insights) → función tocada → qué bloque se le pasa.
4. Cómo se resuelve el perfil (tenant → override de programa) en cada call site y qué pasa si no hay perfil
   o si la resolución falla.
5. Cómo se implementó el filtrado por `activeFormats` (con el ejemplo de qué queda vacío).
6. Confirmación de que `drizzle/` y `src/server/db/schema/` NO fueron tocados y que no hubo cambios de UI.
7. Qué quedó fuera y por qué.
