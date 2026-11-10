# PE-02 — Motor de análisis en vivo (video + transcripción → momentos, temas, citas)

KANBAN_TASK_ID: t_d2f3cad5
Slice de: ÉPICA E — Motor de análisis en vivo
Ejecutor: devin-swe-2-max (agente delegado en worktree Orca)
Base: 0c11fea (master tip — incluye PE-01 registry, PE-06 transmission_segments, PE-07 liveAlertsService)

## Objetivo

Crear el servicio que conecta la ingesta (ÉPICA D) con el análisis (ÉPICA E):
dado un segmento de grabación MP4 ya persistido por `streamRecorderService`,
el motor **extrae audio → transcribe (diarizado) → escribe `transcript_segments`
→ analiza el texto acumulado con el modelo multimodal → escribe
`transmission_segments` (temas) y `transmission_moments` (momentos clipables)
→ dispara `liveAlertsService.checkTranscriptAlerts`**.

Este slice implementa el **camino por segmento** (`processRecordingSegment`):
el loop/orquestador que itera segmentos en vivo puede quedar como método
expuesto, pero NO hace falta un worker/scheduler real todavía.

## Contratos heredados (NO reimplementar)

| Pieza | Dónde | Uso |
|---|---|---|
| `transcribeAudio(filePath)` | `src/server/services/transcriptionService.ts` | Retorna `DiarizedTranscription { text, utterances: {speaker,text,start,end}[], provider }`. Ya usa el registry PE-01 (AssemblyAI→Whisper). Utterance.start/end son ms relativos AL ARCHIVO — sumale `recordingSegment.startMs` para offset vs `transmissions.started_at`. |
| `recordingSegments` | `src/server/db/schema/recordings.ts` | `sequence, startMs, endMs (nullable mientras graba), fileRef, status`. Leélos; NO los escribas. |
| `transcript_segments` | `src/server/db/schema/live.ts` | Escribir: tenant_id, transmission_id, start/end_ms, speaker_label, person_id=NULL, text, confidence. |
| `transmission_segments` | `live.ts` + `transmissionSegmentsService` (PE-06) | Escribir via `transmissionSegmentsService.recordSegment({tenantId, transmissionId, startMs, endMs, topic, summary, speakers, confidence})`. |
| `transmission_moments` | `live.ts` | kind='detected' con title/reason/score/startMs/endMs, clip_id=NULL. La Sala "En vivo" los lee sola. |
| `liveAlertsService.checkTranscriptAlerts` | `liveAlertsService.ts` (PE-07) | Llamarlo fire-and-forget por cada chunk de texto nuevo con `{tenantId, transmissionId, text}`. |
| `resolveAnalysisProvider('analysis')` | `src/server/lib/analysisProviders.ts` (PE-01) | Devuelve config del modelo de análisis (gemini por defecto). Usalo para el analyzer; NO hardcodees provider. |
| `getRawStorage()` | `rawStorageService.ts` | Lee el MP4 desde `fileRef` (RawStorage sanea paths). |
| ffmpeg | `src/server/lib/binaries.ts` (`findBinary`) | Extraer audio del MP4 (`-vn -acodec libmp3lame` o pcm) a archivo temp. |

## Arquitectura pedida (patrón del repo)

`src/server/services/analysisEngineService.ts`:

- `AnalysisEngineStore` interface + `createDrizzleAnalysisEngineStore(executor)` + `createAnalysisEngineService(store, deps)`.
- Store: `getTransmission(tenantId, transmissionId)`, `listRecordingSegments(tenantId, recordingId)`, `insertTranscriptSegments(tenantId, rows[])`, `insertMoment(tenantId, {...})`. Toda query con `tenant_id`.
- Deps inyectables (defaults a las impl reales): `transcribe(filePath)`, `analyze(input: {transcript, prevContext?}) → AnalysisResult`, `extractAudio(fileRef) → filePath`, `alerts(tenantId, transmissionId, text)`.
- `AnalysisResult` shape (lo devuelve el modelo): `{ segments: [{startMs,endMs,topic,summary,speakers,confidence}], moments: [{startMs,endMs,title,reason,score}], quotes: [{startMs,endMs,text,speakerLabel}] }`. Las quotes van a `transmission_moments` con `reason='quote'` y `title` = texto de la cita (PE-05 las enriquece después — acá basta persistirlas).
- Métodos:
  - `processRecordingSegment({tenantId, transmissionId, recordingId, sequence})` → extrae audio del `fileRef`, transcribe, inserta utterances en `transcript_segments` (offsets absolutos), analiza el texto nuevo (+ contexto previo opcional), escribe segments/moments/quotes, dispara alerts. Devuelve resumen `{utterancesInserted, segmentsWritten, momentsWritten, quotesWritten}`.
  - `processTransmission({tenantId, transmissionId})` → itera `streamRecordings`+`recordingSegments` 'active' de esa transmisión llamando al método anterior (para procesado post-hoc/testing).
- El analyzer real: llamada al provider resuelto por `analysisProviders('analysis')` (gemini flash, JSON mode, prompt en español rioplatense como `alertService`). Definilo como `analyzeTranscriptWindow(text)` exportado — los tests lo stubbean.
- Manejo de errores: un segmento que falla se loguea y se saltea; nunca corta el loop.

## Tests (`tests/analysisEngine.test.ts` + `tests/helpers/memoryAnalysisEngineStore.ts`)

Deterministas, sin API ni DB:
- utterances → transcript_segments con offsets absolutos correctos (startMs del segmento + offset del utterance)
- topics → transmission_segments via service real (o store spy)
- moments/quotes insertados con kind='detected' y campos correctos
- alerts llamado con el texto nuevo y tenant correcto
- segmento sin utterances → no inserta nada
- aislamiento por tenant en todas las queries del store
- error en un segmento no corta `processTransmission`

## Constraints

- `tenant_id` en TODA query. Offsets siempre relativos a `transmissions.started_at`.
- NO tocar: `streamRecorderService.ts`, `pipelineService.ts`, `alertService.ts`, `transcriptionService.ts`, `transmissionSocketService.ts`, esquemas existentes (solo nuevas tablas si hicieran falta — no debería).
- NO crear worker/scheduler/socket nuevo — el servicio es el contrato; el orquestador en vivo viene después.
- No hardcodear modelo/provider: siempre via `analysisProviders`.

## Gates

`npx tsc --noEmit` EXIT 0 · `npx vitest run` verde (sin regresiones) · `npm run build` verde.
`npm ci --ignore-scripts` primero si no hay node_modules.
Commit conventional en `pe-02-multimodal-engine` (ej: `feat(analysis): multimodal analysis engine (PE-02)`), paths explícitos, sin atribución IA. NO push, NO PR — el orquestador mergea tras QA.
