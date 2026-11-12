# ÉPICA I — Robustez, observabilidad y lanzamiento

Checklist de la tarjeta `t_1da234af`. Cada ítem se marca `[x]` sólo con commits +
evidencia real de gates (EXIT codes, `Test Files N passed`, salida del verificador
PGlite). Fuente del texto/puntaje: la tarjeta del kanban.

## Checklist

- [x] PI-01 Cola de jobs (tabla Postgres MVP) con reintentos + dead-letter + panel de jobs en admin [5]

  **Commits (branch `periodistapp/t_1da234af-periodistapp-epica-i-robustez-observabilidad-y-lanzamiento`):**
  - `5bea3b4` `feat(jobs): add job_queue table with retries and dead-letter`
    — schema `job_queue` + migración `0020_narrow_invaders` + `jobQueueService` +
    `jobQueueWorker` + rutas tenant `/api/job-queue`.
  - `4fe80eb` `feat(admin): add jobs panel with filters and dead-letter requeue`
    — endpoints admin (`/api/admin/jobs`, `POST /jobs/:id/requeue`), auditoría
    `admin.job_requeued`, panel React `/admin/jobs`.
  - `5116ba3` `test(jobs): add deterministic job queue and admin jobs tests`
    — `memoryJobQueueStore` + 23 tests deterministas (fix `previousStatus` en audit).

  **Evidencia de gates (todos con EXIT real, ejecutados sobre el HEAD `5116ba3`):**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 51 passed (51)`, `Tests 962 passed (962)`
  - `npm run build` → **EXIT 0** — `No schema changes, nothing to migrate`
  - `node scripts/verify-migration-pglite.mjs` → **EXIT 0** —
    `tabla PI-01: job_queue (15 columnas, FK tenant cascade, índices tenant+status, claim (status,run_at) y tenant+created_at, migración 0020 idempotente)`
  - `git diff --check` → **EXIT 0**

- [x] PI-02 Logging estructurado + request-id + trazabilidad por transmisión [3]

  **Commits (branch `periodistapp/t_1da234af-periodistapp-epica-i-robustez-observabilidad-y-lanzamiento`):**
  - `0fe3761` `feat(logging): add structured logger and request-id context`
    — `src/server/lib/logger.ts` (JSON por evento en producción, línea legible
    fuera, redacción de claves sensibles + URLs Postgres con credenciales,
    `log.child`, `LOG_LEVEL`) y `src/server/lib/requestContext.ts`
    (AsyncLocalStorage).
  - `7b962ac` `feat(logging): add request-id middleware and wire it into the server`
    — `src/server/middleware/requestId.ts` montado antes de `optionalAuth`:
    adopta `X-Request-Id` seguro, si no genera uuid v4, lo devuelve en la
    respuesta y emite finish-log (method/path/status/durationMs/tenantId).
    `optionalAuth` empuja `tenantId` al contexto.
  - `cd864cc` `feat(logging): migrate transmission, recorder and job queue logs to the structured logger`
    — 43 call-sites: núcleo `index.ts` (14), `streamRecorderService` (8, con
    `log.child({tenantId,transmissionId,recordingId})`), `transmissionSchedulerService`
    (15), `jobQueueWorker` (4), rutas `jobQueue`/`admin` (2). Quedan 306
    `console.*` en `src/server` para migración incremental posterior.
  - `92c1bfc` `test(logging): add deterministic logger and request-id tests`
    — `tests/logging.test.ts`: 14 tests (los 12 casos del brief + Error
    serializado + request-id largo inválido).
  - `34dc843` `test(logging): update segmentFinalizedHook spy for structured output`
    — ajusta el spy de `liveAnalysisRunner.test.ts` a la emisión de una
    línea por evento del logger.

  **Evidencia de gates (todos con EXIT real, ejecutados sobre el HEAD `34dc843`):**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 52 passed (52)`, `Tests 976 passed (976)`
  - `npm run build` → **EXIT 0** — `No schema changes, nothing to migrate`
  - `git diff --check` → **EXIT 0**
- [x] PI-03 Métricas de costo de IA por tenant/transmisión (alimenta super admin) [3]

  **Commits (branch `pi-03-cost-metrics`):**
  - `ae3fdfc` `feat(usage): ai_usage_events ledger schema, migration and usage service`
    — tabla `ai_usage_events` (FK tenant cascade, FK transmission set-null,
    índices tenant+created_at y transmission), migración `0021_pi03_ai_usage_events`,
    y `aiUsageService`: pricing `AI_MODEL_PRICING_USD_PER_1M` versionado en
    código, `normalizeTokenUsage` (SDK v6 / OpenAI REST / Gemini REST),
    `withAiUsageRecording` best-effort (nunca rompe la llamada IA) y
    `summarize` con agregación pura de referencia.
  - `1a037ce` `feat(usage): instrument AI gateways with usage recording`
    — `aiSdkService` (generate/stream/fallback, usage del SDK v6),
    `aiService` legacy axios (DeepSeek + Gemini), `scraperService`
    (SDK directo) y `analysisEngineService.callAnalysisProvider`
    (gemini / openai-vision) — éxito con tokens+costo o `success=false`.
  - `8a4ff99` `feat(usage): propagate usageContext through AI call sites`
    — `usageContext { tenantId, transmissionId?, feature }` opcional en
    todos los callers: noteFactory, pipeline, review, assets, generate,
    dossier, network-variants, newsService, insights, content-multiplier,
    topics, agent-execution.
  - `de1945f` `feat(usage): expose ai-usage summary endpoints for tenant and admin`
    — `GET /api/ai-usage/summary` (tenant-scoped por `req.auth.tenantId`)
    y `GET /api/admin/ai-usage` (cross-tenant read-only bajo
    `requirePlatformAdmin`, filtros tenantId/from/to/feature/top).
  - `629f801` `feat(admin): add AI costs panel to the super-admin dashboard`
    — `/admin/costs`: filtros rango/tenant/feature, cards de totales,
    tablas por tenant, top transmisiones por costo, por feature y provider.
  - `290e76c` `test(usage): deterministic coverage for the ai_usage ledger`
    — `memoryAiUsageStore` + 26 tests deterministas (pricing,
    normalización, resiliencia del registro, agregación/aislamiento,
    contratos de endpoints y gateway con SDK mockeado).

  **Evidencia de gates (todos con EXIT real, ejecutados sobre el HEAD `290e76c`):**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 53 passed (53)`, `Tests 1002 passed (1002)`
  - `npm run build` → **EXIT 0** — `No schema changes, nothing to migrate`
  - `git diff --check` → **EXIT 0**

  **Paths de IA declarados fuera del ledger** (sin tenant en contexto o
  billing no-token): `transcriptionService` (Whisper/AssemblyAI — por
  minuto de audio) y `imageEdit` (sin auth ⇒ sin tenantId — ver el
  contrato de `AiUsageContext.tenantId` NOT NULL).
- [x] PI-04 Manejo de fallos de ingesta (stream caído, cortes) con reanudación de crudo [5]

  **Commits (branch `pi-04-ingest-recovery`):**
  - `fce8442` `feat(recorder): stall watchdog, honest error terminal and same-row capture resume (PI-04)`
    — watchdog `stallTimeoutMs` (default 30 s): sin crecimiento del segmento
    abierto NI output en stderr por N ms mata ffmpeg (SIGTERM → SIGKILL →
    salida forzada si ni así reporta muerte) y alimenta el retry existente;
    latch por intento y handlers filtrados por identidad de proceso (un
    zombie del intento anterior jamás cuenta como salida del nuevo).
    Reintentos agotados → `stream_recordings.status='error'`, último
    segmento abierto cerrado, transmisión a `error` sólo por FSM, log
    estructurado y notificación `ingest_recording_failed` al tenant (mismo
    fanout que PE-07, best-effort). `opts.resume` reabre la MISMA fila
    (la UNIQUE de `transmission_id` lo fuerza y conserva la ancla
    `started_at` original): los segmentos previos se seed-ean (el watcher
    no los re-inserta), el archivo en disco no comiteado se recupera con
    su ancla strftime, `sequence` continúa y el corte queda como hueco
    entre `end_ms` y el próximo `start_ms`. `resumeRecording` filtra por
    tenant+transmisión y devuelve la fila — referencia errada falla antes
    de spawnear.
  - `0ea03bb` `feat(scheduler): boot sweep for orphaned ingest recordings with resume window (PI-04)`
    — `reconcileOrphanedRuns` deriva corridas `live` con recording
    `'recording'`/`'interrupted'` a `recoverOrphanedRecording`: segmentos
    abiertos cierran al mtime real del archivo menos `started_at` (colapsan
    a `start_ms` si el stat falla), la grabación queda `interrupted` +
    `ended_at`. `resumeWindowMinutes` (default 30) con
    `decideOrphanRecovery`: dos cortes terminales independientes — ventana
    live vencida o outage anclado al último byte real que excede la
    ventana — sin loops infinitos; reanudable → MISMA grabación vía
    `startRecording({resume})` + `ingest_resumed`, terminal → `error` por
    FSM con razón + `ingest_interrupted`. `SchedulerStore` gana
    `listSegments`/`setSegmentEndMs` (idempotente `WHERE end_ms IS NULL`)/
    `updateRecording`; deps inyectables `fileMtimeMs`, `storagePath`,
    `notifyFn`.

  **Evidencia de gates (todos con EXIT real, ejecutados sobre el HEAD `0ea03bb`):**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 53 passed (53)`, `Tests 1018 passed (1018)`
  - `npm run build` → **EXIT 0** — `No schema changes, nothing to migrate`
  - `git diff --check` → **EXIT 0**

  **Cobertura determinista nueva:** 6 tests del recorder (stall → kill →
  retry mismo recordingId, stderr como progreso, stall con reintentos
  agotados → error + segmento cerrado + notify, salida forzada sin close,
  resume misma fila/ancla/segmentos intactos + archivo no comiteado
  recuperado, resume con referencia inexistente) y 10 del scheduler
  (sweep reanuda dentro de ventana, outage largo → terminal con razón,
  ventana live vencida → terminal, stat fallido → colapso a `start_ms`,
  `interrupted` previo idempotente, `decideOrphanRecovery` puro).
- [ ] PI-05 Backup/retención de assets + política de borrado de crudos [2]
- [ ] PI-06 Checklist go-live: seeds de planes, datos demo, health checks, runbook de incidentes [3]
- [ ] PI-07 Piloto controlado: 1 canal real transmitiendo 1 semana, métricas de éxito [5]
