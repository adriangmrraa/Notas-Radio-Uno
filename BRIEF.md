# BRIEF — PF-08 Imágenes multi-modelo: provider seleccionable por tenant + fallback

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-08, 3 pts)
**Base**: `1d7a96c` (master tip)
**Branch**: `pf-08-image-models`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-08-image-models`

## Contexto

Decisión D de la épica: registry `image_models` con Gemini, GPT Image, Ideogram, FLUX,
Recraft (+ Grok que YA EXISTE en el pipeline viejo), default por tenant, fallback y
plan gating. Hoy la generación de imágenes está hardcodeada en
`pipelineService.generateAIBackground` (gemini + grok inline, línea ~1271-1460).

Contratos existentes (verificados):
- `pipelineService.ts:1333` `generateWithGemini` — POST
  `generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview`,
  soporta reference images como input. `:1433` `generateWithGrok` — POST
  `api.x.ai/v1/images/generations {model:'grok-2-image', prompt, n:1,
  response_format:'b64_json'}` (XAI_API_KEY). Patrón fallback: selected model → otro.
- `isFeatureEnabled(tenantId, key)` (tenantFeaturesService.ts) + `FEATURE_CATALOG`
  con `byPlan` + `fallback` — agregar key nueva es ADITIVO (sin migración; filas se
  sincronizan del catálogo).
- `tenants.config` jsonb — el default del tenant vive ahí (`config.imageModel`,
  mismo campo que `pipelineConfig.imageModel` usa en el pipeline viejo: 'gemini'|'grok').
- `limiters.imageGen` existe en pipelineService para rate-limit — opcional reusar.
- Output convention: `output/` dir, paths servidos como `/output/…`.

## Alcance

### 1) `imageModelService.ts` — Store pattern

**Registry** `IMAGE_MODEL_REGISTRY: readonly ImageModelDef[]`:
```
gemini    | GEMINI_API_KEY   | gemini-3.1-flash-image-preview | supportsReferenceImages
grok      | XAI_API_KEY      | grok-2-image                   | text-only
gpt-image | OPENAI_API_KEY   | gpt-image-1                    | text-only
ideogram  | IDEOGRAM_API_KEY | ideogram-v3                    | text-only
flux      | BFL_API_KEY      | flux-1.1-pro                   | text-only
recraft   | RECRAFT_API_KEY  | recraft-v3                     | text-only
```
`ImageModelDef`: `{id, label, envKeys, defaultModel, modelEnvKey, supportsReferenceImages}`.

Funciones puras exportadas (el corazón testeable):
- `isModelConfigured(def, env)` → todas las envKeys presentes
- `resolveModelChain({requestedModel?, tenantModel?, env, needsReferenceImages})` →
  `ImageModelDef[]` ordenado: 1) requested si configured, 2) tenantModel si configured,
  3) resto del registry en orden filtrando configured (+ supportsReferenceImages cuando
  `needsReferenceImages`). Sin duplicados.
- `callImageModel(def, {prompt, apiKey, model, referenceImages?})` — dep inyectable con
  implementaciones REALES solo para `gemini` y `grok` (portar los dos patrones de
  pipelineService: Gemini generateContent b64 + Grok images/generations b64_json);
  los demás ids → throw `model_not_implemented` (la chain los salta por no estar
  configured sin sus API keys de todos modos — el registry queda completo para cuando
  lleguen las keys).

### 2) `generateImage({tenantId, prompt, referenceImages?, model?})`

1. Plan gating: `isFeatureEnabled(tenantId, 'ai_image_models')` → off ⇒ `feature_disabled`.
   Agregar entrada a `FEATURE_CATALOG` (aditiva): `key:'ai_image_models'`, name
   'Modelos de imagen IA', byPlan creator+ (trial:false, creator:true, media:true,
   network:true, enterprise:true), fallback:false.
2. Tenant default: leer `tenants.config.imageModel` (query tenant-scoped en el store —
   `getTenantImageModel(tenantId)` → string | null).
3. `resolveModelChain` → vacío ⇒ `no_provider_configured`.
4. Por cada def: `callImageModel` → éxito ⇒ escribir buffer a `output/<uuid>.png` →
   return `{path, model: def.id, attempts: [{model, ok|error}]}`; fallo ⇒ registrar y
   seguir (fallback real).
5. Todos fallaron ⇒ `all_providers_failed` con attempts.

Deps inyectables: `{store, callModel, isEnabled, env, outputDir, newId, now}` —
`callModel` default = dispatcher real por def.id (lazy import de axios como en
pipelineService si hace falta; tests inyectan fake siempre).

### 3) Store

`ImageModelStore` + `createDrizzleImageModelStore`:
- `getTenantImageModel(tenantId)` → `tenants.config->>'imageModel'` | null
(una sola query — el resto del servicio es puro).

### 4) Tests deterministas

`tests/helpers/memoryImageModelStore.ts` + `tests/imageModels.test.ts`:
- `isModelConfigured` por envKeys
- `resolveModelChain`: requested primero, tenant default segundo, configured-only,
  needsReferenceImages filtra text-only, sin duplicados, vacío si nada configured
- `generateImage`: gating off → feature_disabled; chain vacía → no_provider_configured;
  primer callModel OK → path + model correcto; primero falla → fallback al segundo
  (attempts registra ambos); todos fallan → all_providers_failed
- tenant isolation (store query)
- NO calls HTTP reales — callModel siempre fake en tests

## NO TOCAR

- `pipelineService.ts` (la línea vieja sigue como está — el registry nuevo es para el
  camino ÉPICA F; refactor del pipeline viejo es otro slice)
- `analysisProviders.ts` (registry separado — image_models tiene needs distintas)
- Schemas — cero migraciones (config va en `tenants.config` jsonb existente)
- `tenantFeaturesService.ts` — SOLO la entrada aditiva en FEATURE_CATALOG
- NO implementar HTTP real para ideogram/flux/recraft/gpt-image (registry + contract;
  solo gemini+grok que YA existen los patrones)

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx tsc --noEmit          # EXIT 0
npx vitest run            # 623 base + nuevos
npm run build             # verde — sin schema changes
```

## Reporte

`DONE: PF-08 → <SHA>` + archivos + gates + decisiones (key de feature, orden del
registry, manejo de reference images). `BLOCKED: <razón>`.
