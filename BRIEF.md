# PE-04 — Detección de momentos clipables en tiempo real (score + razón + ventana)

KANBAN_TASK_ID: t_d2f3cad5
Slice de: ÉPICA E — Motor de análisis en vivo
Ejecutor: devin-swe-2-max (agente delegado en worktree Orca)
Base: ba557ae (master tip — incluye PE-01/02/03/05/06/07)

## Objetivo

**Wiring en vivo**: cuando un segmento de grabación CIERRA en
`streamRecorderService`, correr `analysisEngineService.processRecordingSegment`
sobre ese segmento y notificar a la Sala "En vivo" que hay momentos nuevos
(score + razón + ventana ya los produce el analyzer de PE-02).

⚠️ Este slice **SÍ toca `streamRecorderService.ts`** — está autorizado por el
handoff de ÉPICA D siempre que sea UN HOOK EXPLÍCITO declarado acá: es exactamente
eso (ver "Hook" abajo). Nada más se modifica de ese archivo.

## Contratos heredados (NO reimplementar)

| Pieza | Dónde | Uso |
|---|---|---|
| `analysisEngineService.processRecordingSegment` | `analysisEngineService.ts` (PE-02) | `{tenantId, transmissionId, recordingId, sequence}` → escribe transcript_segments, transmission_segments, transmission_moments, quotes y dispara alertas. Devuelve `{utterancesInserted, segmentsWritten, momentsWritten, quotesWritten}`. |
| Punto de cierre del segmento | `streamRecorderService.ts` `pollSegments()` (~línea 38) | Cuando aparece un `seg-XXXXX.mp4` nuevo, el anterior cierra: `prevPending.closed = true`. También en `finalizeRecording` el último pending cierra. Esos son los DOS puntos de hook. |
| Socket rooms | `transmissionService.ts` | rooms `transmission:{id}` y `tenant:{id}`; `serializeTransmission(row)` y el patrón `ioRef` (`initTransmissionService`) ya exportados. El cliente (`useTransmissionEvents`/`LiveRoomPage`) **refetchea la sala entera** en `transmission:status`/`transmission:updated` — emitir `transmission:updated` alcanza para que momentos/segmentos nuevos aparezcan solos. |
| `streamRecordings`/`recordingSegments` | `recordings.ts` | el hook recibe recordingId+sequence; el engine resuelve el resto. |

## Arquitectura pedida

1. **Hook explícito en `streamRecorderService.ts`** (único cambio al archivo):
   - Exportar `setSegmentFinalizedHook(fn | null)` + tipo `SegmentFinalizedInfo {tenantId, transmissionId, recordingId, sequence}`.
   - Llamarlo fire-and-forget (`.catch` logueado, NUNCA await que rompa el recorder) en los dos puntos de cierre: `prevPending.closed = true` en pollSegments y el cierre del último pending en finalize/stop path.
   - Default null → comportamiento idéntico a hoy (los ~22 tests existentes del recorder no deben romperse).
2. **`src/server/services/liveAnalysisRunner.ts`**:
   - `initLiveAnalysisRunner(io)` (patrón ioRef como `initNotificationService`) + `setSegmentFinalizedHook(handleSegmentFinalized)` en `index.ts` junto a los otros init.
   - `handleSegmentFinalized(info)` → `await engine.processRecordingSegment(info)` → si `momentsWritten`/`quotesWritten`/`segmentsWritten` > 0: emitir `transmission:updated` al room `tenant:{id}` con `serializeTransmission` de la fila fresca **y** `transmission:moments` a `transmission:{id}` + `tenant:{id}` con `{transmissionId, summary}` (evento nuevo, semántico — el cliente de hoy no lo escucha pero queda el contrato para UI futura/sin refetch completo).
   - Runner con store propio (`RunnerStore.getTransmission` → fila completa) o reutilizar el del engine; deps inyectables (`engine`, `io`/emit, `store`).
   - Error del engine → log `[live-analysis]`, NUNCA propaga.
3. Tests (`tests/liveAnalysisRunner.test.ts` + `tests/helpers/memoryRunnerStore.ts` si aplica):
   - segmento cerrado → engine llamado con los 4 ids correctos → emits a ambos rooms
   - engine que devuelve todo en 0 → no emite
   - engine que rechaza → no propaga, no emite
   - hook en recorder: con hook seteado, un fake de segmento cerrado lo invoca (sin romper tests existentes)

## Constraints

- `tenant_id` en TODA query. El hook no debe bloquear el loop de grabación (siempre fire-and-forget).
- NO tocar: `analysisEngineService.ts`, `personIdentityService.ts`, `transmissionService.ts`, `transmissionSocketService.ts`, `pipelineService.ts`, schemas, ni código cliente (el refetch por `transmission:updated` ya existe).
- No crear workers/schedulers — el trigger es el cierre de segmento, punto.

## Gates

`npx tsc --noEmit` EXIT 0 · `npx vitest run` verde · `npm run build` verde.
`npm ci --ignore-scripts` primero si no hay node_modules.
Commit conventional en `pe-04-live-moments`, paths explícitos, sin atribución IA. NO push, NO PR.
