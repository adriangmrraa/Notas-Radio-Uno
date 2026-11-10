# BRIEF — PF-07 Flyers/quote-cards con foto REAL de la persona detectada

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-07, 3 pts)
**Base**: `2221302` (master tip: PF-06 notas con quotes jsonb)
**Branch**: `pf-07-quote-flyers`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-07-quote-flyers`

## Contexto

Las notas (PF-06) ya guardan `publications.quotes` jsonb = AttributedQuote[] con
`personId`/`personName`. Este slice genera **quote-cards 1080x1080 con la foto REAL de la
persona** (no avatar genérico): la foto sale de `person_photos` (enrolada con
face_detection, PE-03/PC-04).

Contratos existentes (verificados):
- `processQuoteFlyer(quote, speakerPhotoData: Buffer|null, branding)` → `Promise<string>`
  en `imageService.ts:141` — canvas 1080x1080, cita centrada, línea separadora dorada,
  foto circular 100px (¡leer bien sus params: usa `quote.text` y nombre vía campos del
  objeto — pasarle shape compatible con AttributedQuote), logo top-right, devuelve path
  del PNG en output/. REUSAR — no re-escribir el canvas.
- `person_photos` (schema/persons.ts:72): `photoData` bytea, `isPrimary`,
  `tenantId`, `personId` — la foto real. Query: primary primero, sino la más reciente.
- `attributedQuotesService.listAttributedQuotes(tenantId, transmissionId)` →
  AttributedQuote[] con `personId`, `personName`, `personPhotoUrl` (URL API — el
  BUFFER está en person_photos.photoData).
- `publications.quoteFlyerPaths` jsonb (default []) — campo destino, YA EXISTE.
- `publications.quotes` jsonb — array de AttributedQuote serializadas (PF-06 las pone).
- `loadTenantBranding(tenantId)` → {logoBuffer, platformName, fontFamily, templateId}.
- `publications` NO tiene transmissionId — los quotes viven en el jsonb; el flyer se
  genera por publicación, no por transmisión.

## Alcance

### 1) `quoteFlyerService.ts` — Store pattern

`QuoteFlyerStore` + `createDrizzleQuoteFlyerStore`:
- `getPublication(pubId, tenantId)` → {id, quotes}
- `getPersonPhoto(tenantId, personId)` → {photoData: Buffer} | null — primary primero
  (`orderBy desc(isPrimary), asc(createdAt)`)
- `appendFlyerPaths(pubId, tenantId, paths: string[])` — merge jsonb (patrón `||` +
  COALESCE como patchClipMetadata de PF-05) o read-merge simple

### 2) `generateQuoteFlyers({tenantId, publicationId, onlyPersonsWithPhotos?})`

1. Publication tenant-scoped → `publication_not_found`; `quotes` array → si vacío
   `no_quotes`.
2. Por cada quote con `personId` (skip sin personId — cita sin atribuir no lleva foto):
   - `getPersonPhoto` → si null, marcar `skipped_no_photo` (NO usar placeholder —
     el AC dice foto REAL; sin foto → flyer sin foto o skip según
     `onlyPersonsWithPhotos` default false → flyer igual con photoData=null, el canvas
     ya tolera null).
   - `processQuoteFlyer(quoteShape, photoData, branding)` → path
3. `appendFlyerPaths` con los paths generados.
4. Return `{publicationId, flyers: [{quoteIndex, personId, path}], skipped: n}`.

Deps inyectables: `{store, renderFlyer, loadBranding, now}` — `renderFlyer` default =
processQuoteFlyer (canvas real); en tests, fake que devuelve path sintético y captura
args (¡NUNCA canvas real en tests!).

### 3) Endpoint — `routes/notes.ts` (extender el router de PF-06) o `routes/publications.ts` si existe

`POST /api/publications/:id/quote-flyers` → `generateQuoteFlyers` →
`201 {publicationId, flyers, skipped}`; 404 publication; 422 no_quotes.
Revisar si ya existe un router de publications para colgarlo ahí (patrón del repo:
routes/notes.ts se montó en index.ts — seguir el mismo). `req.auth!.tenantId`.

### 4) Tests deterministas

`tests/helpers/memoryQuoteFlyerStore.ts` + `tests/quoteFlyers.test.ts`:
- flyer por quote con personId → renderFlyer recibe (quote, photoData buffer, branding)
- sin personId → skip, no llama renderFlyer
- person sin foto → photoData null al render (o skip si onlyPersonsWithPhotos)
- appendFlyerPaths mergea sin pisar paths previos
- publication_not_found / no_quotes / tenant isolation
- ruta: 201/404/422

## NO TOCAR

- `imageService.ts` (processQuoteFlyer se CONSUME — solo verificar su firma real al
  pasarle el quote shape; si el shape difiere, adaptar en el servicio nuevo, no tocar)
- `attributedQuotesService.ts`, `noteFactoryService.ts`, schemas (cero migraciones)
- `pipelineService.ts` (línea vieja — no se toca ni se refactoriza)
- NO placeholder/silhouette cuando falta foto: photoData=null → el canvas decide

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx tsc --noEmit          # EXIT 0
npx vitest run            # 604 base + nuevos
npm run build             # verde — sin schema changes
```

## Reporte

`DONE: PF-07 → <SHA>` + archivos + gates + decisiones (dónde colgó la ruta, política
sin-foto elegida). `BLOCKED: <razón>`.
