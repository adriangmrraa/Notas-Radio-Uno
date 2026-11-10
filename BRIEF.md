# BRIEF — PF-02 Re-encuadre 9:16 inteligente (crop por rostro activo / split 2 personas)

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-02, 8 pts)
**Base**: `64996bb` (master tip: PF-01 cutter + PF-04 cola de render)
**Branch**: `pf-02-reframe`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-02-reframe`

## Contexto

PF-01 produce el clip crudo 16:9 (`clips.videoPath` → MP4 en `output/`). PF-04 tiene la
cola `clip_render_jobs` + worker con dispatch por `kind`. Este slice agrega el re-encuadre
vertical inteligente: detectar rostros en frames del clip y cropear 9:16 centrado en el
rostro activo — o layout split (dos mitades verticales) si hay 2 personas.

Contratos existentes (verificados):
- `getFaceDetector()` → `detect(Buffer)` → `{faces: [{bbox: [x,y,w,h], embedding}]}` —
  `src/server/services/faceDetectionService.ts`. Lazy, descarga modelos ONNX.
- `FakeFaceDetector` ya existe en tests (`tests/personIdentity.test.ts` lo usa).
- `clipCutterService`: convención `outputDir` (default `<repo>/output`), ffmpeg runner
  inyectable `createFfmpegRunner`, `msToSec`, patrones de args — reutilizar estilo.
- `clipRenderWorker.dispatch`: `if (job.kind !== 'cut') → markFailed(unknown kind)`. Hay
  que extender el dispatch con 'reframe' (deps inyectables como `cutRawWindow`).
- `clips` schema: `videoPath`, `status` ('generating'|'pending_review'|'error'|...),
  `metadata` jsonb, `duration`. PF-01 guarda `metadata.window` + `metadata.sourceSegments`.
- `clip_render_jobs.payload` para 'reframe': `{ clipId }` (el tenant va en la fila).

## Alcance

### 1) `clipReframeService.ts` — Store pattern (obligatorio)

`ReframeStore` (load/update clip tenant-scoped) + `createDrizzleReframeStore` + memory store.
Función principal `reframeClip({tenantId, clipId})`:

1. Load clip (tenant-scoped, 404 si no). Requiere `videoPath` no-null → si no, error
   `missing_source_video`.
2. Probar dimensiones del video fuente (ffprobe inyectable o dims en deps — NO hardcodear).
3. Samplear M frames uniformes sobre `clip.duration` (default ~8-10 samples, constante
   `SAMPLE_COUNT`): ffmpeg extrae frame a temp jpg → `detector.detect(buf)` por frame.
   Frames sin caras no aportan centro pero cuentan como sample.
4. Timeline de centros: por frame, rostro dominante = mayor área de bbox → centerX
   fracción (0-1). Colectar `{t, centerX, faceCount}`.
5. **Decisión de layout** (función pura testeable `decideLayout(samples)`):
   - `single` (default): un rostro dominante → crop width `ih*9/16`, x = clamp(
     mediana(centerX)*iw − cropW/2, 0, iw−cropW ), y=0, alto completo.
   - `split`: 2 clusters de rostros estables — criterio: ≥2 posiciones x distintas con
     ≥30% de frames con cara cada una y separación > 25% del ancho. Dos crops
     horizontales (izq/der) centrados en cada cluster → apilados verticalmente.
   - `center` (fallback): 0 caras detectadas → crop centrado estándar.
6. Render ffmpeg:
   - single/center: `crop=cropW:ih:x:0,scale=1080:1920` + `-c:a copy`
   - split: filter_complex `[0:v]crop=w1:ih:x1:0,scale=1080:960[t];[0:v]crop=w2:ih:x2:0,scale=1080:960[b];[t][b]vstack` + `-c:a copy`
   - Una sola invocación ffmpeg, temps limpios en `finally`.
7. Output: `output/<clipId>_916.mp4`. Update clip: `videoPath` → archivo nuevo,
   `metadata.sourceVideoPath` = path anterior, `metadata.reframe` =
   `{layout, samples: n, facesDetected: n, centerX}`; status → 'pending_review'
   (o 'generating' al empezar + 'error' si falla — mismos estados que PF-01).

Deps inyectables: `{store, detector, ffmpegRunner, frameExtractor, probe, tempDir, outputDir,
sampleCount, now}` con defaults reales. `detector` default = `getFaceDetector()` LAZY
(no resolver en import — solo cuando reframeClip corre).

### 2) Wiring en `clipRenderWorker.ts` (MODIFICAR — es el punto de extensión)

- Agregar dep inyectable `reframeClip` (default → `clipReframeService.reframeClip`).
- Dispatch: `kind === 'reframe'` → `reframeClip({tenantId: job.tenantId, clipId:
  job.payload.clipId})` → `markDone(jobId)` (el clip ya existe — clip_id ya viene en la
  fila si el enqueue lo puso; payload.clipId es la fuente de verdad).
- Mantener contrato: error → `markFailed` con backoff, eventos socket igual que 'cut'.

### 3) Helper de encolado

`clipRenderQueueService` ya tiene `enqueue` genérico — NO modificarlo. Documentar en el
servicio de reframe (o en BRIEF de API futura) que encolar reframe =
`enqueue({tenantId, clipId, kind:'reframe', payload:{clipId}})`.

### 4) Tests deterministas

`tests/helpers/memoryReframeStore.ts` + `tests/clipReframe.test.ts` con FakeFaceDetector +
ffmpeg runner fake que captura args:
- `decideLayout`: single (1 cluster), split (2 clusters estables), center (0 caras),
  single si el 2do rostro es minoritario (<30% frames)
- crop args single: `crop=<ih*9/16>:<ih>:<x>:0` con x clampeado a bordes (rostro en borde
  izquierdo → x=0; borde derecho → x=iw-cropW)
- split: filter_complex con vstack + 2 scales 1080x960
- reframeClip completo: clip→'generating'→'pending_review', videoPath nuevo,
  metadata.sourceVideoPath + metadata.reframe.layout
- ffmpeg failure → status 'error' + last metadata
- missing videoPath → error tipado, sin tocar ffmpeg
- tenant isolation (clip de otro tenant → 404)
- worker dispatch: kind 'reframe' llama reframeClip con el clipId del payload

## NO TOCAR

- `clipCutterService.ts`, `clipRenderQueueService.ts` (consume, no modifica)
- `faceDetectionService.ts`, `personIdentityService.ts` (solo consume `detect`)
- `clipService.ts`, `streamRecorderService.ts`, schemas existentes
- NO persistir `metadata.reframe` en columna nueva — va en el jsonb `metadata`
- NO animación de crop (crop x fijo por clip en v1 — panning dinámico es post-v1)

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx tsc --noEmit          # EXIT 0
npx vitest run            # todos verdes (488 base + nuevos)
npm run build             # verde — NO debe haber schema changes
```

## Reporte

`DONE: PF-02 → <SHA>` + archivos + gates + decisiones (umbrales de split, sample count,
manejo de clips sin caras). Si bloqueado: `BLOCKED: <razón>`.
