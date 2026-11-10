# PF-01 — Clip-cutter: cortar ventana del crudo con ffmpeg

KANBAN_TASK_ID: t_682756fa
Slice de: ÉPICA F — Fábrica de contenido desde el crudo
Ejecutor: devin-swe-2-max (agente delegado en worktree Orca)
Base: f1b5899 (master tip — ÉPICA E completa)

## Objetivo

`cutRawWindow({tenantId, transmissionId, startMs, endMs})` → corta la ventana
del **video crudo real** (decisión D-1: NUNCA clips sintéticos) y registra el
clip en `clips`. La ventana es en la convención de offsets relativos a
`transmissions.started_at` (misma que `transcript_segments`/momentos).

El punto no trivial: **la ventana puede cubrir varios `recording_segments`**
— hay que resolver por cada tramo qué segmento lo contiene, extraer cada
parte con `-ss` relativo al archivo y concatenarlas en UN MP4.

## Contratos heredados (NO reimplementar)

| Pieza | Dónde | Uso |
|---|---|---|
| `recording_segments` + `stream_recordings` | `recordings.ts` | `sequence, startMs, endMs(nullable si aún graba), fileRef, status`. fileRef relativo a `stream_recordings.storage_prefix` → key RawStorage `${storagePrefix}/${fileRef}` (mismo que PE-02/03). |
| `clips` | `clips.ts` | `title, hookText(notNull!), videoPath, duration(s), status, transmissionId, metadata jsonb`. `createClip`/`updateClipVideoPath` existen en `clipService.ts` — reusarlos como store/wrapper si encajan (status final sugerido: `'pending_review'` como ya hace `updateClipVideoPath`). |
| `getRawStorage()` | `rawStorageService.ts` | `publicPath(ref)` → ruta local del MP4 fuente. Salida del clip: misma convención que el pipeline actual (`output/` del proyecto — ver `clipService.generateClipVideo`) O un prefix RawStorage `clips/` — elegir lo más consistente con cómo se sirven los clips hoy (`videoPath` es path de archivo local). |
| ffmpeg | `findBinary('ffmpeg')` + `src/server/lib/binaries.ts` | Precisión de frames SIN re-encode completo: `-ss <rel> -t <dur>` por tramo con re-encode corto por tramo (accuracy) o `-c copy` si el tramo arranca en keyframe — elegir y justificar en código; concat via demuxer (`-f concat -safe 0`) o un solo input si la ventana cae en UN segmento (camino rápido obligatorio). |
| `transmission_moments` | `live.ts` | consumidor natural del cutter (moment clipable → clip) — pero el cutter NO escribe moments; acepta window explícita. |

## Arquitectura pedida (patrón del repo)

`src/server/services/clipCutterService.ts`:

- `ClipCutterStore` + `createDrizzleClipCutterStore` + `createClipCutterService(store, deps)`.
- Store (TODA query `tenant_id`): `getTransmission`, `listRecordingsWithSegments(tenantId, transmissionId)` (recordings + segments 'active' ordenados por startMs/sequence), `createClipRow`, `setClipResult(tenantId, clipId, {videoPath, duration, status, metadata})`.
- Deps inyectables: `runFfmpeg(args)`/exec, `storage` (RawStorage), `tempDir`/`outputDir`.
- `cutRawWindow(input)` → valida ventana (endMs > startMs, duración máx. configurable ~120s default, dentro del rango grabado) → resuelve tramos por segmento → por cada tramo `-ss (tramo.start - segment.startMs)` → concat → MP4 único → `clips` row con `transmissionId`, `duration`, `videoPath`, `metadata: {window:{startMs,endMs}, sourceSegments:[refs]}` → `{clipId, videoPath, durationSec, segmentsUsed}`.
- Errores: ventana fuera de rango / sin segmentos que la cubran / ffmpeg falla → error tipado con razón; nada queda a medias (clip row en estado 'error' o sin crear — elegir y documentar).
- Temp files siempre se limpian (finally).

## Tests (`tests/clipCutter.test.ts` + `tests/helpers/memoryClipCutterStore.ts`)

Deterministas (ffmpeg stubbed — capturar args y producir "archivo" falso):
- ventana dentro de UN segmento → 1 tramo, args ffmpeg correctos (`-ss` relativo al archivo), clip registrado
- ventana que cruza 2 segmentos → 2 tramos + concat, offsets relativos correctos por tramo
- ventana fuera de rango → error, no crea clip
- ffmpeg que falla → error controlado
- aislamiento por tenant en queries del store

## Constraints

- `tenant_id` en TODA query. NUNCA clip sintético — siempre del crudo real.
- NO tocar: `clipService.ts` (reusar de afuera), `streamRecorderService.ts`, `analysisEngineService.ts`, `liveAnalysisRunner.ts`, schemas.
- No crop 9:16 ni subtítulos acá — PF-02/03 vienen después sobre este MP4.

## Gates

`npx tsc --noEmit` EXIT 0 · `npx vitest run` verde · `npm run build` verde.
`npm ci --ignore-scripts` primero si no hay node_modules.
Commit conventional en `pf-01-clip-cutter`, paths explícitos, sin atribución IA. NO push, NO PR.
