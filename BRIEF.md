# BRIEF — PF-06 Notas por rubro con citas atribuidas (plantillas por rubro editorial)

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-06, 3 pts)
**Base**: `d258ced` (master tip: pipeline clips completo + re-corte)
**Branch**: `pf-06-rubric-notes`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-06-rubric-notes`

## Contexto

Del contenido ya analizado en vivo (`transmission_segments` + citas con `persons.name`
vía PE-05) hay que generar **notas periodísticas por rubro** — cada rubro con su
plantilla — y guardarlas en `publications` con las citas atribuidas embebidas.

Contratos existentes (verificados):
- `attributedQuotesService.listAttributedQuotes(tenantId, transmissionId)` →
  `AttributedQuote[]` computed-on-read (personName + foto, ver interface en
  `attributedQuotesService.ts:76`) — citas con nombre REAL resuelto por PE-03.
- `transmission_segments` (PE-06): title/reason/startMs/endMs + jsonb speakers;
  `transmissionSegmentsService.listByTransmission(tenantId, transmissionId)`.
- `resolveEditorialPromptBlock(tenantId, programId?, store?)` → bloque de prompt con
  línea editorial del tenant (tono, reglas, formatos activos).
- `EDITORIAL_FORMATS` (editorialService.ts:64): flash|corta|completa|cronica|twitter|
  linkedin|instagram|youtube|newsletter — los "rubros".
- `publications` table: `title`, `content`, `quotes` jsonb, `source`
  (enum pipeline|manual|scheduled → usar 'pipeline'), `status` default 'pending_review',
  `imagePath/imageUrl`, `editHistory` jsonb.
- `createPublication` existe en `databaseService.ts:383` — revisar su firma; si no calza
  (faltan campos tenant-scoped o metadata), el store propio inserta directo.
- `resolveAnalysisProvider('analysis')` + `callAnalysisProvider(provider, prompt)`
  (PRIVADA en `analysisEngineService.ts:526`) — para el `generate` default podés
  EXPORTAR `callAnalysisProvider` (cambio aditivo permitido) o implementar el call
  equivalente con el provider resuelto.
- `programBelongsToTenant(tenantId, programId)` para validar programId opcional.

## Alcance

### 1) `noteFactoryService.ts` — Store pattern

`NoteFactoryStore` + `createDrizzleNoteFactoryStore`:
- `getTransmission(tenantId, transmissionId)` → {id, programId, status}
- `listSegments(tenantId, transmissionId)` → transmission_segments (title, reason,
  startMs, endMs, speakers)
- `insertPublication({tenantId, title, content, quotes, source:'pipeline',
  status:'pending_review'})` → publication row

### 2) Plantillas por rubro (puras, testeables — el corazón del slice)

`RUBRO_TEMPLATES: Record<RubroKey, RubroTemplate>` — rubros editoriales (NO los 9
formatos de red — esos son PF-09). Rubros: `flash` (breaking 3-4 líneas + bullets),
`corta` (1 párrafo + 1 cita), `completa` (lead + 3 cuerpos + cierres + citas),
`cronica` (narrativa temporal por startMs de segmentos). Cada template:
`{key, label, instructions, maxChars?, includeQuotes: boolean}`.

`buildNotePrompt({format, segments, quotes, editorialBlock, transmissionMeta})` → string
(pura): editorialBlock + instrucciones del template + segmentos (título+franja horaria
formateada mm:ss) + citas atribuidas `“texto” — Nombre` si includeQuotes.
Instrucciones: responder SOLO JSON `{"title": "...", "body": "..."}`.

`parseNoteResponse(raw)` → {title, body} (pura, tolerante a ```json fences, reusa el
patrón de parseAnalysisResult si existe).

### 3) `generateNote({tenantId, transmissionId, format, programId?})`

1. Transmission tenant-scoped → `transmission_not_found`. programId opcional validado
   con programBelongsToTenant → `invalid_program`.
2. Segments + attributed quotes en paralelo. Sin segments → `no_content` (error tipado,
   no nota vacía).
3. Prompt = buildNotePrompt + resolveEditorialPromptBlock(tenantId, programId).
4. `generate(prompt)` inyectable → parseNoteResponse → title/body.
5. `insertPublication` con `quotes` = array de las AttributedQuote usadas (jsonb tal
   cual — incluye personName; así la nota muestra quién dijo qué).
6. Return `{publication, segmentsUsed, quotesUsed}`.

Deps inyectables: `{store, generate, editorialBlock, listQuotes, now}` — defaults:
store drizzle, `listQuotes` → attributedQuotesService, `editorialBlock` →
resolveEditorialPromptBlock, `generate` → provider 'analysis' vía callAnalysisProvider
(exportarla si hace falta — cambio aditivo permitido).

### 4) Endpoint (superficie API mínima)

`POST /api/transmissions/:id/notes` en `routes/live.ts` o nuevo `routes/notes.ts`
(elegir el que siga el patrón del repo): body `{format}` → validar formato ∈ rubros →
`generateNote` → `201 {publication}`; 404 transmission/program ajeno; 422 formato
inválido o `no_content`; 400 body mal formado. `req.auth!.tenantId`.

### 5) Tests deterministas

`tests/helpers/memoryNoteFactoryStore.ts` + `tests/noteFactory.test.ts`:
- `buildNotePrompt`: cada rubro produce instrucciones distintas; citas atribuidas con
  personName aparecen `"— Nombre"`; editorial block incluido; segmentos con mm:ss
- `parseNoteResponse`: JSON limpio, fences, título/body, basura → error tipado
- `generateNote` completo: generate fake → insertPublication con quotes jsonb =
  citas atribuidas, source 'pipeline', status 'pending_review'
- transmission_not_found / invalid_program / no_content / invalid_format
- tenant isolation en todo
- ruta: 201/400/404/422

## NO TOCAR

- `attributedQuotesService.ts`, `transmissionSegmentsService.ts`, `clipRenderWorker.ts`
- `analysisEngineService.ts` — SOLO export aditivo de `callAnalysisProvider` si lo
  necesitás; nada de lógica
- Schemas — cero migraciones (`publications` ya tiene todo)
- `clipService.ts`, `pipelineService.ts`, `databaseService.ts` (insertar vía store propio)

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx tsc --noEmit          # EXIT 0
npx vitest run            # 579 base + nuevos
npm run build             # verde — sin schema changes
```

## Reporte

`DONE: PF-06 → <SHA>` + archivos + gates + decisiones (rubros elegidos, firma del
endpoint, si reutilizaste createPublication o insert propio). `BLOCKED: <razón>`.
