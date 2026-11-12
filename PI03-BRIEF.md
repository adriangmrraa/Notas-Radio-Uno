# PI-03 — Métricas de costo de IA por tenant/transmisión

Tarjeta Hermes: `t_1da234af` (ÉPICA I). Este brief es la fuente de verdad del slice.
Trabajás en el branch `pi-03-cost-metrics` sobre `origin/master` @ `00c7809` (ya incluye PI-01 job queue + PI-02 structured logger).

## Objetivo

Registrar **cada llamada a un modelo de IA** con tokens consumidos y costo estimado,
agregable por `tenant_id` y por `transmission_id`, y exponerlo al super admin
(panel admin existente). [3 pts]

## Contexto real del código (verificado — no inventar)

- `src/server/services/aiSdkService.ts` — gateway central de IA. Exporta
  `chatCompletion`, `generateText`, `streamText`, `generateTextWithFallback`
  con fallback `deepseek -> google -> openai`. **Hoy descarta `result.usage`**
  del SDK — ese es el punto de instrumentación.
- Callers del gateway: `src/server/routes/assets.ts`, `src/server/routes/review.ts`,
  `src/server/services/contentMultiplierService.ts`, `insightService.ts`,
  `networkVariantService.ts`, `newsService.ts`. Buscá también otros callers de
  `@ai-sdk/*` o `ai` directo (transcripción/análisis en vivo pueden usar otro path —
  `liveAnalysisRunner`, `scraperService.ts`).
- Admin existente: `src/server/routes/admin.ts` (patrón de auth admin) +
  `src/client/pages/admin/AdminJobs.tsx` (panel agregado por PI-01 — seguí ese
  patrón de tabla/filtros) y `AdminLayout.tsx` (nav).
- Logger estructurado: `src/server/lib/logger.ts` (PI-02). Usá `log`, nunca `console.*`.
- Schema: `src/server/db/schema/*.ts` + `index.ts` export. Migraciones drizzle en
  `drizzle/` — `npm run build` corre `drizzle-kit generate` al final.
- Spec relacionada: `docs/specs/SPEC-07-USAGE-ANALYTICS.md` — leerla y alinear
  nombres/contratos si aplica.
- Tests: `tests/*.test.ts` con vitest; `tests/helpers/memoryJobQueueStore.ts` es el
  patrón de store en memoria determinista.

## Requisitos

1. **Tabla `ai_usage_events`** (schema drizzle + migración): `id`, `tenant_id` (FK
   cascade, NOT NULL), `transmission_id` (FK nullable), `feature`/`call_site`
   (text, p. ej. `"transcription"`, `"asset-edit"`, `"news-generate"`),
   `provider`, `model`, `prompt_tokens`, `completion_tokens`, `total_tokens`,
   `estimated_cost_usd` (numeric), `success` (bool), `error` (text nullable),
   `duration_ms`, `created_at`. Índices: `(tenant_id, created_at)` y
   `(transmission_id)`. `tenant_id` en TODA query.
2. **Instrumentación**: capturar `usage` del resultado del AI SDK en
   `aiSdkService` (para `streamText`, el usage llega en `onFinish`/final result).
   Extendé la API con un parámetro opcional de contexto
   `{ tenantId, transmissionId?, feature }` y actualizá los callers para
   pasarlo. El registro **nunca debe romper la llamada IA** (try/catch + log warn).
   Registrá también los fallos de provider con `success=false`.
3. **Tabla de pricing** en código (constante documentada, fácil de actualizar):
   `deepseek-chat`, `gemini-2.0-flash`, `gpt-4o-mini` — input/output por 1M tokens.
   Costo estimado = prompt_tokens*in + completion_tokens*out.
4. **Endpoints**: tenant `GET /api/ai-usage/summary` (solo su tenant: totales por
   período, por feature, por provider) + admin `GET /api/admin/ai-usage`
   (todos los tenants, filtros tenant/rango) usando el patrón de auth de
   `routes/admin.ts`. **No inventar shapes** — leé las respuestas reales de
   endpoints vecinos y declará el contrato en el reporte.
5. **Panel admin**: `AdminCosts.tsx` (o nombre consistente) siguiendo el patrón de
   `AdminJobs.tsx`, conectado en `AdminLayout.tsx` — totales por tenant, top
   transmissions por costo, por feature/provider.
6. **Tests deterministas** (sin red): cálculo de costo, agregación por
   tenant/transmission, aislamiento tenant (A no ve B), registro no rompe si la
   tabla falla, caller pasa contexto.
7. **Docs**: marcá `[x] PI-03` en `docs/EPICA-I.md` con SHAs + evidencia de gates.

## Gates obligatorios (EXIT real, citar en el reporte)

- `npx tsc --noEmit` → EXIT 0
- `npx vitest run` → EXIT 0 con línea `Test Files N passed` / `Tests N passed`
- `npm run build` → EXIT 0 (corre drizzle-kit generate; la migración nueva debe
  aparecer en `drizzle/`)
- `git diff --check` → EXIT 0

## Reglas

- `npm install` primero si falta `node_modules` (el postinstall instala `remotion/`;
  si falla por red, seguí y reportalo).
- Commits conventional por unidad (`feat(usage):`, `test(usage):`, `docs(epica-i):`),
  paths explícitos, SIN atribución IA, nunca `git add -A` ni `.`.
- **Nunca push, nunca merge a master, nunca deploy ni migración contra DB real.**
- Corré todo autónomo: no esperes aprobación humana en ningún paso.
- Reporte final: unidades commiteadas con SHA, evidencia de gates, contratos de
  endpoints creados, archivos tocados, y cualquier cosa NO verificada declarada.
