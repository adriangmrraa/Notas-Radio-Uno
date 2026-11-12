# PI-04 — Manejo de fallos de ingesta con reanudación de crudo

Tarjeta Hermes: `t_1da234af` (ÉPICA I). Este brief es la fuente de verdad del slice.
Trabajás en el branch `pi-04-ingest-recovery` sobre `origin/master` @ `dc57725`
(ya incluye PI-01 job queue, PI-02 structured logger, PI-03 ai usage ledger).

## Objetivo

Que un stream caído, un corte de red o un restart del servidor NO pierdan el crudo
grabado ni dejen transmisiones/grabaciones en estado zombie. [5 pts]

## Lo que YA existe (verificado en código — no re-implementar)

- `src/server/services/streamRecorderService.ts` (~880 líneas): ffmpeg
  `-c copy -f segment` a MP4 en RawStorage del tenant. **Retry parcial de PI-04**:
  si ffmpeg SALE con error, re-resuelve la URL y reintenta hasta `maxRetries`
  (default 3) con backoff exponencial dentro de la MISMA `stream_recording` —
  `sequence` sigue, los segmentos escritos no se pierden, los huecos quedan en
  offsets (`shouldRetryFfmpeg`, `defaultBackoffMs`, línea ~714).
- `transmissionSchedulerService.reconcileOrphanedRuns` (~línea 834-990): sweep de
  runs stale en startup. `transmissionMeteringService` libera ops stale (~404).
- `src/server/lib/transmissionStateMachine.ts`: FSM — todo cambio de
  `transmissions.status` pasa por `transitionRun`/transitionTransmission.
- Schema: `src/server/db/schema/recordings.ts` — `stream_recordings.status`
  varchar default `'recording'`; `recording_segments` con `start_ms`/`end_ms`
  (end_ms NULL = segmento abierto).
- Logger estructurado `src/server/lib/logger.ts` (PI-02). Job queue `job_queue`
  (PI-01) disponible si necesitás reintentos diferidos.
- Deps inyectables en todos los servicios — los tests corren sin red/ffmpeg/DB.
  Patrón de tests: `tests/helpers/memoryJobQueueStore.ts`, `memoryAiUsageStore.ts`.

## Lo que falta (el slice)

1. **Stall detection (corte donde ffmpeg NO sale)**: el retry actual sólo dispara
   cuando el proceso termina. Un corte de red upstream deja ffmpeg colgado sin
   escribir. Agregá un watchdog: si el segmento abierto no crece (mtime/size) o no
   hay output en N segundos → matar el proceso y contarlo como intento fallido
   → entra al mismo retry path. Configurable (`stallTimeoutMs`), testeable con el
   fake spawn.
2. **Reintentos agotados**: cuando `maxRetries` se agota, definí y ejecutá la
   transición honesta: `stream_recordings.status` → estado terminal real
   (p.ej. `'interrupted'`/`'failed'` — mirá los valores que ya usa el código),
   fijar `end_ms` del último segmento abierto, transición de la transmisión vía
   FSM (NO update directo), y evento/log estructurado. Evaluar alerta live
   (PE-07 `live-alerts` ya existe — wirear si el contrato lo permite).
3. **Sweep de ingesta en boot**: extendé `reconcileOrphanedRuns` (o un sweeper
   nuevo invocado en startup) para `stream_recordings` en `'recording'` cuyo
   proceso ya no existe: cerrar segmentos abiertos (`end_ms`), marcar la
   grabación interrupted, y si la transmisión sigue en ventana live →
   **reanudar el crudo**: nueva `stream_recording` (o misma con intento nuevo,
   decidilo y documentalo) continuando la captura sin perder lo ya escrito.
4. **Cortes largos**: si la reanudación automática excede una ventana
   configurable → estado terminal + razón, sin loops infinitos.
5. **Tests deterministas**: stall→kill→retry, retry agotado→transición,
   sweep boot con segmentos abiertos, reanudación preserva segmentos previos.
   Mirá los tests existentes del recorder para el fake spawn/store.
6. **Docs**: marcá `[x] PI-04` en `docs/EPICA-I.md` con SHAs + evidencia de gates.

## Gates obligatorios (EXIT real, citar en el reporte)

- `npx tsc --noEmit` → EXIT 0
- `npx vitest run` → EXIT 0 con línea `Test Files N passed` / `Tests N passed`
- `npm run build` → EXIT 0
- `git diff --check` → EXIT 0

## Reglas

- `npm install` primero si falta `node_modules`.
- Commits conventional por unidad (`feat(recorder):`, `fix(recorder):`,
  `test(recorder):`, `docs(epica-i):`), paths explícitos, SIN atribución IA,
  nunca `git add -A` ni `.`.
- **Nunca push, nunca merge a master, nunca deploy ni migración contra DB real.**
- `tenant_id` en TODA query. Logger estructurado, nunca `console.*` nuevo.
- Corré todo autónomo: no esperes aprobación humana en ningún paso.
- Reporte final: unidades con SHA, evidencia de gates, decisiones de diseño
  (reanudación misma vs nueva recording), archivos tocados, lo NO verificado
  declarado.
