# BRIEF — PF-03 Subtítulos quemados + progreso + branding (logo, lower-third persona)

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-03, 5 pts)
**Base**: `75e6f99` (master tip: PF-01 cutter + PF-02 reframe + PF-04 cola)
**Branch**: `pf-03-subtitles-branding`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-03-subtitles-branding`

## Contexto

El clip ya pasa por `cut` (16:9 crudo) y `reframe` (9:16). Este slice agrega la pasada de
**subtítulos quemados con estilo del tenant + barra de progreso + logo + lower-third con el
nombre de la persona que habla** — se aplica sobre el `videoPath` actual del clip
(post-reframe si existe, post-cut si no). Dispatch como `kind='subtitles'` en la cola.

Contratos existentes (verificados):
- `transcript_segments` (schema/live.ts): `transmissionId`, `startMs`, `endMs`,
  `speakerLabel`, `personId`, `text` — tiempos absolutos vs `transmissions.started_at`.
- `clips.metadata.window` = `{startMs, endMs}` absolutos vs started_at (PF-01 lo escribe);
  `clips.transmissionId` también lo escribe PF-01. Las cues = transcript_segments que se
  solapen con la ventana, tiempo relativo = `seg.startMs − window.startMs`.
- `brandingService.loadTenantBranding(tenantId)` → `{logoBuffer, platformName,
  fontFamily, templateId}` — REUSAR como dep inyectable (no re-implementar la query).
- `fontService`: `FONT_REGISTRY: Record<FontFamilyId,{filename,family}>` + `getFontFamily()`
  — resuelve familia+archivo real en disco (fonts/ dir). ASS usa `FontName` + `fontsdir`.
- `persons.name` para el lower-third; `transcript_segments.personId` (PE-03 lo resuelve).
- Worker dispatch: agregar `kind === 'subtitles'` igual que 'reframe' (dep `burnSubtitles`
  inyectable, default → servicio nuevo). Payload: `{clipId}`.
- `clipReframeService` muestra el patrón: probe dims, ffmpegRunner inyectable, temps en
  `finally`, estados `generating → pending_review | error`, metadata en jsonb.

## Alcance

### 1) `clipSubtitleService.ts` — Store pattern

`SubtitleStore` + `createDrizzleSubtitleStore`:
- `getClip(clipId, tenantId)` — con transmissionId, videoPath, metadata.window, duration
- `listUtterances(tenantId, transmissionId, startMs, endMs)` — transcript_segments con
  overlap, orden por startMs, incluir speakerLabel + personId
- `getPersonNames(tenantId, personIds[])` → Map personId→name
- `updateClip(clipId, tenantId, patch)` — videoPath/status/metadata

### 2) Generación ASS (pura, testeable — el corazón del slice)

`buildAssFile({utterances, windowStartMs, style, personNames})` → string ASS:
- `[V4+ Styles]` con `FontName`/`Fontsize`/`PrimaryColour`/`OutlineColour`/`Outline`/
  `Shadow`/`Alignment=2` (bottom-center) según `style` derivado del branding
- Cues `Dialogue: 0,start,end,Default,,0,0,0,,{text}` con tiempos `h:mm:ss.cc`
  RELATIVOS al clip (clamp a [0, duration], descartar cues fuera)
- Wrap de líneas largas (~42 chars) con `\N`
- Escapar `{`,`}` y `\` en texto
- **Lower-third**: por cambio de speaker con `personId` resuelto (o speakerLabel si no hay
  person), evento `Dialogue` extra con estilo `LowerThird` (Alignment=7 top-left o 1
  bottom-left sobre la zona de subs, `\pos`, fondo `\bord`+`3a` alpha) mostrando
  `NOMBRE PERSONA` los primeros ~3.5s de su turno — función pura `lowerThirdEvents()`.

`resolveSubtitleStyle(branding, dims)` → `{fontName, fontSize, primary, outline, boxAlpha}`
(pura): fontFamily→FONT_REGISTRY.family; colores por `templateId` (mapear los templates
existentes de templateService a paletas: dark_gradient→blanco/sombra oscura, etc. — leer
`templateService.ts` para los colores reales de cada template y reusarlos).

### 3) Render ffmpeg — `burnSubtitles({tenantId, clipId})`

1. Load clip tenant-scoped; videoPath requerido (`missing_source_video`), window requerida
   (`missing_window` si metadata.window no existe — clip viejo sin metadata → error tipado).
2. Probe dims (dep `probe` como reframe).
3. Escribir ASS a tempDir; logoBuffer→png temp si hay logo.
4. filter graph (UNA invocación):
   - `subtitles=<ass>:fontsdir=<fonts dir>` (escapar `:` y `\` en path Windows → forward
     slashes + escape `:` con `\:`)
   - logo: `[1:v]scale=w:-1[lg];[0:v][lg]overlay=W-w-margin:margin` (margin ~3% ancho,
     logo ancho ~12-15% del video)
   - progreso: `drawbox=x=0:y=0:w='t/dur*iw':h=<barH>:color=<accent>@0.9:t=fill` — barra
     fina arriba que avanza con t (función `buildProgressFilter(dur, dims, accent)`)
   - orden: subtitles → overlay logo → drawbox progreso; `-c:a copy`
5. Output `output/<clipId>_sub.mp4` → update videoPath, `metadata.sourceVideoPath`,
   `metadata.subtitles={cues, styled, logo:bool, progressBar:bool}`; status flow igual
   que reframe.
6. Temps (ass, logo png) en `finally`.

Deps inyectables: `{store, ffmpegRunner, probe, loadBranding, tempDir, outputDir, fontsDir,
now}` — `loadBranding` default = `loadTenantBranding`.

### 4) Worker dispatch `kind='subtitles'`

`clipRenderWorker.ts`: dep `burnSubtitles` (default → clipSubtitleService), dispatch igual
que reframe: payload.clipId → `burnSubtitles({tenantId, clipId})` → markDone{clipId}.

### 5) Tests deterministas

`tests/helpers/memorySubtitleStore.ts` + `tests/clipSubtitles.test.ts`:
- `buildAssFile`: cue shift relativo a window, clamp bordes, escape, wrap, estilo por
  templateId, lower-third por speaker con personName (y sin person → speakerLabel)
- `resolveSubtitleStyle`: fontFamily→family del registry, paleta por template
- `buildProgressFilter`: expresión `t/dur*iw`, color accent del template
- ffmpeg args: subtitles filter con path escapado, overlay logo solo si logoBuffer,
  `-c:a copy`
- clip completo: 'generating'→'pending_review', metadata.subtitles; ffmpeg fail → 'error'
- missing videoPath / missing window → errores tipados sin tocar ffmpeg
- sin utterances → render igual (clip sin subs, metadata.subtitles.cues=0) NO error
- tenant isolation
- worker dispatch kind 'subtitles'

## NO TOCAR

- `clipCutterService.ts`, `clipReframeService.ts`, `clipRenderQueueService.ts`
- `brandingService.ts`, `fontService.ts`, `templateService.ts` (solo consumir)
- Schemas — cero migraciones; todo en `metadata` jsonb
- No inventar colores: mapear desde los templates REALES de templateService

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx tsc --noEmit          # EXIT 0
npx vitest run            # 511 base + nuevos
npm run build             # verde — sin schema changes
```

## Reporte

`DONE: PF-03 → <SHA>` + archivos + gates + decisiones (formato ASS vs SRT, paletas por
template, posición lower-third, tamaño barra progreso). `BLOCKED: <razón>` si aplica.
