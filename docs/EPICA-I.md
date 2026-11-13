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
- [x] PI-05 Backup/retención de assets + política de borrado de crudos [2]

  **Commits (branch `pi-05-asset-backup`):**
  - `094ee34` `feat(backup): incremental mirror of derived assets with tenant manifest (PI-05)`
    — `assetBackupService.ts` espeja los archivos derivados (`clips.video_path`,
    `clips.subtitles_path`, `clips.metadata.source_video_path`,
    `publications.image_path`, `publications.quote_flyer_paths[]` — todos bajo
    `<repo>/output`) hacia un `BackupStorage` adapter (filesystem
    `BACKUP_ROOT`, default `<repo>/data/backup`, reemplazable por S3/R2 sin
    tocar consumidores — mismo patrón que `RawStorage`). Manifest en tabla
    `asset_backup_entries` (migración 0022 idempotente): UNIQUE
    `(tenant_id, source_path)` = contrato de idempotencia — la misma fuente
    resuelve a la MISMA fila vía upsert. Test de cambio estilo rsync:
    `bytes` + `source_mtime_ms` (se copia sólo si la fuente cambió de
    tamaño o mtime; `checksum` sha256 queda como campo opcional de
    integridad — decisión documentada: checksum por archivo duplicaría la
    lectura de disco en cada sync sobre GBs de renders, mtime+size cubre el
    caso del re-render que vuelve a escribir el path). Tenant-scoped en
    CADA lectura/escritura (regla dura), `dryRun` análogo a
    `purgeExpiredRecordings` (no toca storage ni DB), errores por archivo
    acumulados en `errors[]` sin abortar el job. Kind `'backup.sync'` en
    `JOB_QUEUE_KINDS` + `createBackupSyncHandler` en el worker (misma
    factory DI que `createRetentionPurgeHandler`); fase D del scheduler de
    transmisiones con catch-up en primer tick + guarda doble
    (ticks/intervalo por `BACKUP_SYNC_ENABLED` +
    `BACKUP_SYNC_INTERVAL_MINUTES`, default 1440 min). Endpoints admin:
    `POST /api/admin/backup/sync` (`{tenantId?, dryRun?}` validado con Zod,
    `mutationLimiter`, audit `admin.backup_synced`) y
    `GET /api/admin/backup/status?tenantId=` (último run, cobertura por
    tenant, conteos de entradas y bytes) — ambos bajo el guard global
    `requirePlatformAdmin`. Env documentado en `.env.example` §21.
    Verificador PGlite extendido: tabla, 11 columnas, UNIQUE, FK cascade,
    índices, defaults, upsert y cascade funcional — 0022 se re-aplica como
    gate de idempotencia.
  - `6b5eab8` `test(backup): deterministic coverage for asset sync, manifest and scheduler`
    — `tests/helpers/memoryBackupStore.ts` (fake del manifest store +
    `MemoryBackupStorage` con `failOn` inyectable) +
    `tests/assetBackupService.test.ts` (24 tests).

  **Auditoría del rawRetentionService existente (NO reimplementado):**
  - Job queue: `retention.purge` registrado como seed global en
    `jobQueueWorker.ts` vía `createRetentionPurgeHandler` (DI) →
    `purgeExpiredRecordings(now, {tenantId: job.tenantId, dryRun: false})`.
    La fase C del scheduler además corre la purga global una vez por día
    con catch-up en el primer tick.
  - Endpoint con dry-run: existe pero NO está en `routes/admin.ts` — el
    brief lo describía como admin y en realidad vive tenant-scoped en
    `routes/transmissions.ts`: `GET /api/transmissions/retention` +
    `POST /api/transmissions/retention/purge` (`{dryRun}`). **Gap real:**
    sin visibilidad platform-admin de la retención ni panel de cobertura;
    los nuevos `/api/admin/backup/*` cubren ese rol sólo para assets
    derivados — un `GET /admin/retention/status` queda como trabajo
    futuro.
  - Comportamiento auditado: `plans.raw_retention_days` NULL/0/negativo =
    retención ilimitada (no purga); candidatos = grabación completada +
    transmisión terminada + `ended_at + retention_days < now` estricto +
    ≥1 segmento no purgado; renders de clips pendientes protegen el
    crudo; `RawStorage.deletePrefix` borra archivos y deja metadata;
    purga idempotente y por tenant; `dryRun` sin mutaciones; `errors[]`
    por fallo individual.

  **Evidencia de gates (todos con EXIT real, ejecutados sobre el HEAD `6b5eab8`):**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 54 passed (54)`, `Tests 1042 passed (1042)`
  - `npm run build` → **EXIT 0** — `No schema changes, nothing to migrate` (58 tablas, `asset_backup_entries` incluida)
  - `git diff --check` → **EXIT 0**
  - `node scripts/verify-migration-pglite.mjs` → **EXIT 0** — `re-applied 0022_fantastic_sentinel.sql (idempotente)` + checks PI-05 (columnas, UNIQUE, FK cascade, índices, defaults, upsert, cascade funcional)

  **Cobertura determinista nueva (24 tests):** primer sync copia todo y
  puebla el manifest; segundo sync es no-op (sin writes al storage ni al
  store); archivo nuevo/modificado (mtime o size distinto) se re-copia;
  dry-run no escribe nada; tenant A no ve ni toca fuentes/manifest del
  tenant B; fallo de `put` en un archivo va a `errors[]` + `status='error'`
  sin abortar los demás; fuente faltante → `status='missing'` con la
  entrada preservada; upsert sobre la UNIQUE; `getBackupStatus` agrega
  cobertura/bytes/último run por tenant; `FileSystemBackupStorage` real
  round-trip + confinamiento al root (rechaza paths `..`); handler
  `backup.sync` del worker invoca el sync tenant-scoped con `dryRun:false`;
  scheduler: catch-up en primer tick, respeta intervalo, error aislado no
  corta las fases siguientes, `stopTransmissionScheduler` resetea el
  estado.
- [ ] PI-06 Checklist go-live: seeds de planes, datos demo, health checks, runbook de incidentes [3]
- [ ] PI-07 Piloto controlado: 1 canal real transmitiendo 1 semana, métricas de éxito [5]
