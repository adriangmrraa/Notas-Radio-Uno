# PE-07 — Alertas en vivo: reusar `alertService` sobre la transcripción nueva

KANBAN_TASK_ID: t_d2f3cad5
Slice de: ÉPICA E — Motor de análisis en vivo
Ejecutor: devin-swe-2-max (sesión de orquestación en worktree master)
Base: 6f77d61 (master tip — incluye PE-01 y PE-06 mergeados)

## Objetivo

`alertService.detectAlerts(text, keywords, speakerContext, editorialBlock)` ya
existe y detecta keywords + momentos semánticos (Gemini) en un fragmento de
transcripción. El pipeline VIEJO (`pipelineService.detectAndEmitAlerts`) lo usa
sobre su propia transcripción. **PE-07 = exponer ese mismo camino para la
transcripción NUEVA** (los `transcript_segments` que el motor de ÉPICA E va a
poblar), en un servicio dedicado que PE-02 pueda llamar por cada utterance/chunk.

## Contrato heredado (no reinventar)

- `detectAlerts` devuelve `LiveAlert[]` (type/severity/title/excerpt/context/
  speaker/matchedKeyword/timestamp).
- El pipeline viejo por alerta: `notify({tenantId, type: alert_<type>, ...})`
  (persiste `notifications` + emite `notification`) **y** emite
  `live_alert` al room `tenant:{id}` (el hook `useLiveAlerts` /
  `LiveAlertFeed` del cliente ya escuchan ese evento — mismo nombre y payload).
- Keywords por tenant: setting `alert_keywords` (JSON array) vía
  `getSetting('alert_keywords', tenantId)`.
- Línea editorial (PC-06): `resolveEditorialPromptBlock(tenantId, programId)`.

## Alcance

- `src/server/services/liveAlertsService.ts` — patrón Store del repo:
  `LiveAlertsStore` interface + impl drizzle + `createLiveAlertsService`.
  - `checkTranscriptAlerts({tenantId, transmissionId?, text})` → `LiveAlert[]`.
  - Por cada alerta: notificación persistida + `live_alert` emitido a
    `tenant:{id}` (emit inyectable para tests; wiring de io como
    `initNotificationService`).
  - Filtra keywords/editorial SIEMPRE por tenant; `transmissionId` sólo metadato
    + lookup de `program_id` para contexto editorial.
- `tests/helpers/memoryLiveAlertsStore.ts` + `tests/liveAlerts.test.ts`:
  keyword alert dispara, notify+emit llamados, texto vacío/sin match → nada,
  aislamiento por tenant.
- NO tocar `pipelineService` (el viejo sigue igual), ni `alertService.ts`,
  ni `streamRecorderService.ts`.

## Gates

`npx tsc --noEmit` EXIT 0 · `npx vitest run` verde · `npm run build` verde.
Commit conventional en `pe-07-live-alerts`.
