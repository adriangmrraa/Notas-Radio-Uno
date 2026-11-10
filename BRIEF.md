# PE-01 — Capa de proveedores de análisis (registry + config por proceso)

KANBAN_TASK_ID: t_d2f3cad5
Slice de: ÉPICA E — Motor de análisis en vivo
Ejecutor: devin-swe-2-max (sesión de orquestación en worktree master)
Base: b3d105a (master tip — incluye ÉPICA D completa)

## Objetivo

Crear `analysisProviderRegistry`: la capa que permite **cambiar de modelo por proceso
sin reescribir código** (decisión D-2 de la tarjeta). Tres procesos:

- `analysis` — análisis multimodal del vivo (video + transcripción → momentos/temas/citas)
- `transcription` — audio → utterances + diarización
- `image` — análisis visual de frames/segmentos (sampler de PE-03 lo consume)

## Decisiones fijas (de la tarjeta)

- Análisis visual = **Gemini 3.x sampled por segmentos** + **AssemblyAI diarización**
  como timeline primario. NO Gemini Live API. NO reemplazar AssemblyAI.
- Defaults: analysis→gemini, transcription→assemblyai (fallback whisper), image→gemini.
- Override por env: `ANALYSIS_PROVIDER_<PROCESO>` y `ANALYSIS_MODEL_<PROCESO>`.

## Alcance

- Nuevo `src/server/lib/analysisProviders.ts` — registry puro (sin DB, sin axios),
  mismo patrón que `src/server/lib/streamSources.ts` (PD-07).
- Rewirear el dispatch de `transcribeAudio` en `transcriptionService.ts` para que
  consulte el registry — comportamiento idéntico (assemblyai si hay key → whisper).
- Test `tests/analysisProviders.test.ts` (vitest, patrón de streamSources.test.ts).

## Contrato

```ts
export type AnalysisProcess = 'analysis' | 'transcription' | 'image';
export interface AnalysisProviderDef {
  id: string;                        // 'gemini' | 'assemblyai' | 'whisper' | 'openai-vision'
  label: string;
  processes: readonly AnalysisProcess[];
  envKeys: readonly string[];        // env vars requeridas
  defaultModel: string;
  modelEnvKey?: string;              // env para override del modelo
  supports: { diarization?: boolean; videoInput?: boolean; imageInput?: boolean };
}
export function resolveAnalysisProvider(p: AnalysisProcess): ResolvedAnalysisProvider;
export function listAnalysisProviders(p?: AnalysisProcess): (AnalysisProviderDef & { available: boolean })[];
```

`resolveAnalysisProvider` tira `AnalysisProviderUnavailableError` si ningún provider
del proceso está configurado — el caller decide el fallback, el registry no inventa.

## Gates (obligatorios, en disco)

- [ ] `npx tsc --noEmit` → EXIT 0
- [ ] `npx vitest run tests/analysisProviders.test.ts` → verde
- [ ] `npx vitest run` → suite completa sin regresiones
- [ ] `npm run build` → verde

## Límites

- NO push, NO PR. Commit conventional en rama `pe-01-analysis-providers`, sin atribución IA.
- NO modificar `streamRecorderService.ts` (la tarjeta lo prohíbe salvo hook explícito).
- NO crear tablas: `transmission_segments` es de PE-06.
- `tenant_id` no aplica acá: el registry es config de plataforma (env), no per-tenant.
