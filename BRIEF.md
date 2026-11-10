# BRIEF — PF-05 Re-corte manual: selector inicio/fin → re-render vía cola

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-05, 3 pts)
**Base**: `6052ef4` (master tip: cut + reframe + subtitles + cola)
**Branch**: `pf-05-manual-recut`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-05-manual-recut`

## Contexto

El usuario quiere re-cortar un clip existente: elegir nuevo inicio/fin sobre la línea de
tiempo grabada y re-renderizar. La UI del live-room YA devuelve `segments`
(recording_segments) por transmisión (`liveRoomService.ts:354,428`) — el selector se alimenta
de eso; NO hay que crear endpoint de coverage.

Este slice = servicio de re-corte + endpoints en `routes/clips.ts`. El re-corte crea un
**clip derivado nuevo** (el original no se destruye mientras se regenera) vía la cola
`kind='cut'` — el worker ya corta con `cutRawWindow` (PF-01).

Contratos existentes (verificados):
- `clips.ts` routes: `req.auth!.tenantId`, patrón try/catch con 404/500, service fns de
  `clipService` (getClipById, updateClipStatus, deleteClip).
- `clipRenderQueueService.enqueue({tenantId, clipId?, kind, payload, maxAttempts?})` → job;
  `listByClip(clipId, tenantId)`, `getById(jobId, tenantId)`, `retry(jobId, tenantId)`.
- Worker 'cut': payload `{transmissionId, startMs, endMs}` → `cutRawWindow` → crea clip
  nuevo (metadata.window) y rellena `job.clip_id` al terminar.
- `clipCutterService` valida cobertura real con recording_segments — el re-corte debe
  validar ANTES de encolar (feedback inmediato al usuario): re-implementar el chequeo de
  cobertura consultando `recording_segments` (join `stream_recordings` por
  transmissionId+tenantId; `end_ms NULL` = segmento abierto vigente).
- `DEFAULT_MAX_WINDOW_MS` vive en clipCutterService (~120s) — reusar la constante o un
  `maxWindowMs` inyectable con el mismo default.

## Alcance

### 1) `clipRecutService.ts` — Store pattern

`RecutStore` + `createDrizzleRecutStore`:
- `getClip(clipId, tenantId)` → id, transmissionId, status, metadata
- `listCoverage(tenantId, transmissionId)` → `[{startMs, endMs|null}]` de
  recording_segments ordenados (endMs null → tratar como `now` para coverage; el crudo
  sigue grabando)
- `patchClipMetadata(clipId, tenantId, metadata)` — merge jsonb (SQL `||` o read-merge)

`recutClip({tenantId, clipId, startMs, endMs})`:
1. Clip tenant-scoped → 404/`clip_not_found`. Requiere `transmissionId` → `no_transmission`.
2. Validaciones (mismas reglas del cutter): `endMs > startMs`, finitos, duración ≤
   `maxWindowMs` (default = DEFAULT_MAX_WINDOW_MS del cutter, exportada o duplicada con
   comentario), `startMs >= 0`.
3. Cobertura: `[startMs,endMs]` debe estar CONTENIDA en la unión de intervalos de
   `listCoverage` (sin huecos) → `window_out_of_coverage` si falla.
4. `enqueue({tenantId, kind:'cut', payload:{transmissionId, startMs, endMs, recutOf:
   clipId}})` → job.
5. `patchClipMetadata(clipId, tenantId, {recutJobId: job.id})` — el original queda
   linkeado al job; el nuevo clip sale con `metadata.window` (lo escribe el cutter).
6. Return `{job}`.

Errores tipados: `clip_not_found | no_transmission | invalid_window |
window_out_of_coverage | clip_rendering` (opcional: rechazar si hay job pending/running
de kind 'cut' para este clip — check con listByClip si es barato; si complica, omitir y
documentar).

Deps inyectables: `{store, enqueue, now, maxWindowMs}` con defaults reales
(`clipRenderQueueService.enqueue`).

### 2) Rutas — `src/server/routes/clips.ts` (MODIFICAR — superficie API del slice)

Mismo patrón `req.auth!.tenantId` + try/catch:
- `POST /api/clips/:id/recut` body `{startMs: number, endMs: number}` →
  `recutClip({tenantId, clipId: id, startMs, endMs})` → `202 {jobId, status: 'pending'}`;
  400 si body inválido (no números finitos); 404 si clip; 409 si `window_out_of_coverage`
  o `clip_rendering`; 422 si `invalid_window`.
- `GET /api/clips/:id/jobs` → `listByClip(id, tenantId)` → `200 {jobs}` (incluye el recut
  job y su `clip_id` destino cuando termina).
- `GET /api/render-jobs/:jobId` → `getById(jobId, tenantId)` → `200 {job}` / 404 (para
  polling del estado del render desde la UI).
- (Opcional si trivial) `POST /api/render-jobs/:jobId/retry` → `retry(jobId, tenantId)`
  → 200 {job} / 404 / 409 si no está en error/cancelled.

### 3) Tests deterministas

`tests/helpers/memoryRecutStore.ts` + `tests/clipRecut.test.ts`:
- recut ok → enqueue con payload exacto {transmissionId,startMs,endMs,recutOf} + metadata
  recutJobId en el clip origen
- invalid_window (end≤start, no finitos, > maxWindowMs)
- window_out_of_coverage: hueco entre segmentos, fuera de rango; segmento abierto
  (endMs null) cuenta como cubierto hasta `now` inyectado
- clip_not_found / no_transmission / tenant isolation
- rutas: 202+jobId, 400 body inválido, 404, 409 coverage, 422 invalid; GET jobs; GET
  render-jobs/:id 200/404 — seguir el patrón de tests de rutas existente (ver
  tests/transmissionsVodUpload.test.ts o liveRoomApi.test.ts para el harness de app)

## NO TOCAR

- `clipCutterService.ts` (la validación de coverage se re-implementa liviana; NO refactor)
- `clipRenderWorker.ts`, `clipReframeService.ts`, `clipSubtitleService.ts`
- `clipService.ts` (las rutas nuevas usan el servicio nuevo, no las fns viejas)
- Schemas — cero migraciones
- No hacer UI client-side: el selector ya tiene datos (`liveRoom` devuelve segments)

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx tsc --noEmit          # EXIT 0
npx vitest run            # 547 base + nuevos
npm run build             # verde — sin schema changes
```

## Reporte

`DONE: PF-05 → <SHA>` + archivos + gates + decisiones (códigos HTTP elegidos, política
anti-duplicado si la implementaste). `BLOCKED: <razón>` si aplica.
