# BRIEF — PF-09 Variantes por red: copy + hashtags + menciones con handles reales

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-09, 3 pts)
**Base**: `5379a04` (master tip)
**Branch**: `pf-09-network-variants`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-09-network-variants`

## Contexto

`generateContentVariants` (contentMultiplierService) ya produce copy por red — pero NO
hashtags ni menciones. Este slice agrega **menciones con handles REALES** resueltas
determinísticamente desde `persons.social_links` (los handles son hechos — NUNCA los
genera el LLM) + hashtags, persistido en `publications.contentVariants` (jsonb, ya existe).

Contratos existentes (verificados):
- `persons.socialLinks` jsonb `{twitter, instagram, linkedin, x, web, email, ...}`
  (schema/persons.ts:43).
- `ContentVariants` (shared/types.ts:153): `{twitterThread: string[],
  instagramCarousel: string[], linkedinPost: string, youtubeDescription: string,
  newsletterBlurb: string}` — shape FIJO que el client ya consume. Extensión: agregar
  campo opcional `extras` aditivo (no rompe nada).
- `publications.contentVariants` jsonb (nullable) — destino.
- `publications.quotes` jsonb = AttributedQuote[] con `personId`+`personName` (PF-06/07).
- `chatCompletion({systemPrompt, userPrompt, temperature, maxTokens, jsonMode})` en
  `aiSdkService.ts:142` — dep inyectable para el LLM (NUNCA real en tests).
- `resolveEditorialPromptBlock(tenantId, programId?)` — mismo patrón que PF-06.
- `activeVariantKeys(activeFormats)` — decide qué variantes pedir según línea editorial.

## Alcance

### 1) `networkVariantService.ts` — Store pattern

`NetworkVariantStore` + `createDrizzleNetworkVariantStore`:
- `getPublication(pubId, tenantId)` → {id, title, content, quotes}
- `getPersonSocialLinks(tenantId, personIds: string[])` → `[{id, name, socialLinks}]`
  tenant-scoped (`inArray` + eq tenant)
- `updateContentVariants(pubId, tenantId, variants)` — UPDATE de la columna
  (no merge atómico necesario: una corrida reemplaza, es regenerable)

### 2) Menciones determinísticas (puras — corazón del slice)

`NETWORK_HANDLE_KEYS: Record<NetworkKey, string[]>` —
`twitter → ['x','twitter']`, `instagram → ['instagram']`,
`linkedin → ['linkedin']`, `youtube → ['youtube']`, `newsletter → []` (sin menciones).

`resolveMentions(persons, network)` → `[{personId, name, handle}]` (pura): por cada
persona toma `socialLinks[key]` del primer key presente de la red; normaliza `@`
(agregar si falta); sin handle en esa red → no aparece. Deduplicar por handle.

`extractPersonIds(quotes)` → personIds únicos con personId no-null (pura).

### 3) `generateVariants({tenantId, publicationId, networks?})`

1. Publication → `publication_not_found`; title+content requeridos (`no_content`).
2. `networks` opcional: default = `activeVariantKeys` de la línea editorial → si todo
   vacío, las 5 de ContentVariants. Validar ∈ keys válidas → `invalid_network`.
3. `extractPersonIds(quotes)` → `getPersonSocialLinks` → por red: `resolveMentions`
   → mention map `{handle: personName}` para el prompt + `mentions[]` estructurado.
4. LLM (dep `generate` inyectable, default lazy chatCompletion): prompt con
   title+content+quotes atribuidas+handles disponibles por red → JSON
   `{twitterThread: {tweets:[], hashtags:[]}, instagramCarousel: {slides:[], hashtags:[]}, ...}`
   — hashtags se piden al modelo (son creativos); menciones NO (se inyectan del mapa).
5. Persistir `contentVariants` = shape ContentVariants canonical para compat
   (twitterThread=tweets, instagramCarousel=slides, linkedinPost=post,
   youtubeDescription=desc, newsletterBlurb=blurb) + `extras` (nuevo campo opcional en
   shared/types.ts — aditivo): `{twitter: {hashtags, mentions:[{name,handle}]},
   instagram: {...}, linkedin: {...}, youtube: {...}, newsletter: {...}}` solo para
   las redes pedidas. Actualizar `ContentVariants` type en shared/types.ts con
   `extras?: Partial<Record<NetworkVariantKey, NetworkExtras>>` — ADITIVO, no rompe.
6. Return `{publicationId, variants (lo persistido), mentionsResolved}`.

Errores: `publication_not_found` 404 / `no_content` 422 / `invalid_network` 422 /
`invalid_model_response` 502 (mismo patrón PF-06).

Deps: `{store, generate, editorialBlock, now}` — generate default lazy import
chatCompletion; editorialBlock default lazy resolveEditorialPromptBlock.

### 4) Endpoint — `routes/publications.ts` (extender — YA EXISTE de PF-07)

`POST /:id/variants` body `{networks?: string[]}` → `generateVariants` →
`201 {publicationId, variants, mentionsResolved}`; 400 body inválido; 404; 422.
`publicationsRouteDeps` extender con los deps nuevos (mismo patrón).

### 5) Tests deterministas

`tests/helpers/memoryNetworkVariantStore.ts` + `tests/networkVariants.test.ts`:
- `resolveMentions`: x antes que twitter en key list, normalización @, persona sin
  handle en la red → no aparece, dedupe por handle, newsletter → []
- `extractPersonIds`: únicos, nulls fuera
- generateVariants: LLM fake devuelve copy+hashtags → persistido = canonical keys +
  extras con mentions resueltas (¡el handle REAL de socialLinks, no el que invente el LLM!);
  contentVariants shape compat
- redes pedidas ⊆ válidas; invalid_network; publication_not_found; no_content
- tenant isolation; ruta 201/400/404/422

## NO TOCAR

- `contentMultiplierService.ts` (línea vieja — no se toca; el servicio nuevo es el
  camino ÉPICA F)
- `imageService.ts`, `quoteFlyerService.ts`, `noteFactoryService.ts`
- Schemas — cero migraciones (contentVariants jsonb ya existe)
- shared/types.ts — SOLO el campo aditivo `extras` + types nuevos
- El LLM NO genera handles: `resolveMentions` es determinístico desde socialLinks

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx tsc --noEmit          # EXIT 0
npx vitest run            # 646 base + nuevos
npm run build             # verde — sin schema changes
```

## Reporte

`DONE: PF-09 → <SHA>` + archivos + gates + decisiones (mapa de keys por red, shape
extras, política de menciones). `BLOCKED: <razón>`.
