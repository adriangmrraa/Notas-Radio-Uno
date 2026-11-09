# Tasks: live-creator-platform — PeriodistApp, plataforma de canales en vivo

Breakdown de implementacion derivado de `design.md` + `design/schema.md` + `design/flows.md` + 23 specs + `docs/PRODUCT-VISION.md`. El orden de producto es PA, PB, PC, PD, PE, PF, PG, PH, PI; estas fases solo expresan dependencias tecnicas y adelantan habilitadores sin superficie de otra epica.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~8.000–12.000 (62 tareas, ~60 archivos nuevos/modificados + migraciones + servicio Python) |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 quick-wins → PR2 schema+foundations → PR3 T1 core → PR4 T2 SaaS → PR5 T3 publish → PR6 client+ops |
| Delivery strategy | ask-on-risk (default; no recibida del orquestador) |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Quick wins prod (T-01…T-05) | PR 1 | base main; diffs aislados, mergeable ya |
| 2 | Schema 0004→0009 + servicios fundacionales (T-08…T-19) | PR 2 | base PR1; migraciones + cola/cuota/audit/flags/meter |
| 3 | T1 core diferencial (T-20…T-36) | PR 3 | base PR2; engine+recorder+faces+clips+editorial+scheduler wiring |
| 4 | T2 SaaS hardening (T-37…T-44) | PR 4 | base PR3; auth multi-tenant, invites, billing machine, admin |
| 5 | T3 publicación (T-45…T-52) | PR 5 | base PR4; assets+Zernio+review+onboarding+compat |
| 6 | Cliente + ops (T-53…T-62) | PR 6 | base PR5; páginas, deploy, go-live |

## Spike Gates (bloqueantes)

- **GATE-1 (T-06) pgvector en Neon**: `CREATE EXTENSION vector` + insert/query `vector(512)` con `<=>` en la DB real. Si falla → fallback design: `face_embeddings.embedding` como `numeric[]`/jsonb + cosine en app. Bloquea T-08, T-23, T-24, T-25.
- **GATE-2 (T-07) Zernio**: verificar connect embebido (`welcome=true` + welcome-screen), media upload binario, y post de video 9:16 real en IG/TikTok con cuenta de prueba. Si no hay upload → mediaSigner URL vía api (D10 fallback). Si connect no sirve → convivencia legacy sola + flag off. Bloquea T-46, T-47, T-48.

## Batches paralelizables

| Batch | Tareas | Nota |
|-------|--------|------|
| B-A quick wins | T-01, T-02, T-03, T-04, T-05 | 100% paralelo, diffs no se pisan |
| B-B spikes | T-06, T-07 | paralelo con B-A |
| B-C migraciones | T-08→T-09→T-10→T-11→T-12→T-13 | estrictamente secuencial |
| B-D fundación | T-14…T-19 | paralelo post T-10 |
| B-E T1 tracks | engine T-20→T-21→T-22 ‖ faces T-23→T-24→T-25→T-26 ‖ editorial T-28→T-29 ‖ render T-31→T-32 ‖ sueltas T-27, T-30 | post B-D |
| B-F wiring T1 | T-33, T-34, T-35, T-36 | post B-E |
| B-G T2 SaaS | T-37→T-38 ‖ T-39→T-40→T-41 ‖ T-42, T-43, T-44 | post T-12/T-15/T-18 |
| B-H T3 | T-45→T-46→T-47→T-48→T-49 ‖ T-50, T-51, T-52 | post GATE-2 |
| B-I cliente | T-53…T-60 | paralelo por módulo tras su API |
| B-J ops | T-61→T-62 | cierre |

---

## Fase 0 — Quick wins prod + gates (specs: `bug-fixes`, `scheduler-fix`)

- [x] **T-01 · Fix webhook Stripe: raw body antes de express.json()** — `bug-fixes` · S · deps: — · épicas: PB-04
  Files: `src/server/routes/billing.ts`, `src/server/index.ts`
  Pasos: montar router webhook con `express.raw()` en `/api/billing/webhook/stripe` antes del `express.json()` global; `constructEvent(rawBody, sig)`; firma inválida → 400 sin mutar.
  ✔ `tsc` verde + `stripe listen`/`stripe trigger invoice.paid` procesa; firma alterada → 400.

- [x] **T-02 · Endurecer webhook MercadoPago** — `bug-fixes` · S · deps: — · épicas: PB-04
  Files: `src/server/routes/billing.ts`
  Pasos: verificar `x-signature`/`x-request-id` si `MP_WEBHOOK_SECRET` set; SIEMPRE re-fetch `preApproval.get`/`payment.get` antes de mutar suscripción.
  ✔ `tsc` verde + POST forjado sin re-fetch válido no muta estado.

- [x] **T-03 · tenantId obligatorio en setSetting/getSetting** — `bug-fixes` · M · deps: — · épicas: deuda §8 / PA-12
  Files: `src/server/services/databaseService.ts`, `src/server/routes/settings.ts`, `src/server/services/publishService.ts` (+demás llamadores)
  Pasos: `getSetting/setSetting/getSettingsByPrefix/deleteSetting` exigen `tenantId`; nuevo `getGlobalSetting` explícito para claves de plataforma; migrar todos los llamadores a `req.auth.tenantId`.
  ✔ `tsc` strict falla si falta tenantId; guardar `webhook_pipeline` en 2 tenants → filas separadas.

- [x] **T-04 · Eliminar restos de Prisma** — `bug-fixes` · S · deps: — · épicas: deuda §8
  Files: `prisma.config.ts`, `prisma-temp-sqlite.prisma`, refs en docs de setup
  Pasos: borrar archivos; `rg -i prisma` en docs activos → actualizar a Drizzle.
  ✔ `tsc`/`vite build` verdes; `rg prisma` raíz sin hits en código/setup.

- [x] **T-05 · Scheduler: disparo en job.timezone** — `scheduler-fix` (parcial: cuota en T-33) · M · deps: — · épicas: PD-03
  Files: `src/server/services/jobSchedulerService.ts`, `src/server/routes/jobs.ts`
  Pasos: comparar día/`startTime`/dedup vía `Intl.DateTimeFormat(job.timezone)` (dedup por jobLocalDate de `lastRunAt`); POST/PUT aceptan+validan `timezone` IANA y `programId`.
  ✔ `tsc` + job 10:00 `America/Argentina/Buenos_Aires` con server UTC dispara 13:00 UTC y no a las 10:00 UTC; sin doble dispatch.

- [x] **T-06 · GATE-1 — Spike pgvector en Neon** — `face-attribution` (riesgo) · S · deps: — · épicas: PE-03
  Pasos: `CREATE EXTENSION vector` en Neon real; insert `vector(512)` + query `ORDER BY embedding <=> $1 LIMIT 1`; documentar resultado y decisión (pgvector | fallback numeric[]/jsonb).
  ✔ Resultado escrito en `sdd/live-creator-platform/design/` nota o Engram; GATE-1 = pass/fail con evidencia.

- [ ] **T-07 · GATE-2 — Spike Zernio connect + video** — `zernio-publishing` · M · deps: — · épicas: PG-04, PG-05
  Pasos: cuenta sandbox; connect embebido con `externalId=tenantId` + welcome-screen; post video 9:16 en IG/TikTok de prueba; probar media upload binario vs URL; verificar webhook de estados.
  ✔ Matriz pass/fail documentada (connect/upload/webhook/video 9:16); decisión D10 confirmada o fallback activado.

## Fase 1 — Schema y migraciones (specs: `people-directory`, `stream-recording`, `editorial-profiles`, `usage-quota`, `assets-unified`, `multi-tenant-auth`)

Convención: una migración drizzle por paso, en `drizzle/`; scripts de data en `temp-migrations/`.

- [x] **T-08 · Migración 0004 — extensión vector** — `face-attribution` · S · deps: T-06 (GATE-1 pass) · épicas: PC-01
  Files: `drizzle/0004_*.sql`
  Pasos: `CREATE EXTENSION IF NOT EXISTS vector`; verificar en Neon staging.
  ✔ Migración corre limpia; `SELECT '[1,2]'::vector` funciona.

- [x] **T-09 · Schema + migración 0005 — T1 core** — `people-directory`, `stream-recording`, `editorial-profiles` · L · deps: T-08 · épicas: PC-01, PC-07
  Files: `src/server/db/schema/*`, `drizzle/0005_*.sql`
  Pasos: `persons`, `person_photos`, `face_embeddings` (+hnsw cosine vía SQL), `person_program`, `person_transmission`, `transmissions`, `stream_recordings`, `recording_segments`, `transmission_segments`, `person_appearances`, `editorial_profiles`, `editorial_profile_versions`; alter `scheduled_jobs.program_id`, `job_executions.transmission_id`, enum +`skipped_quota`, `programs.editorial_overrides`.
  ✔ `drizzle-kit generate` sin diff pendiente; migración aplica en staging; `tsc` verde.

- [x] **T-10 · Schema + migración 0006 — T2 SaaS** — `usage-quota`, `subscription-lifecycle`, `feature-flags`, `multi-tenant-auth`, `super-admin` · L · deps: T-09 · épicas: PA-01, PB-01, PI-01
  Files: `src/server/db/schema/*`, `drizzle/0006_*.sql`
  Pasos: `user_tenants`, `tenant_quotas`, `quota_operations`, `billing_events`, `tenant_features`, `jobs_queue`, `ai_cost_records`, `admin_impersonations`; alter `users.is_platform_admin`, `tenants` (onboarding/suspensión), `plans` (límites), `subscriptions` (grace/dunning/frozen/cancel_reason/provider_ref).
  ✔ Igual T-09.

- [x] **T-11 · Schema + migración 0007 — T3 publicación** — `assets-unified`, `zernio-publishing`, `image-model-registry` · M · deps: T-10 · épicas: PF-10, PG-04
  Files: `src/server/db/schema/*`, `drizzle/0007_*.sql`
  Pasos: `assets`, `asset_persons`, `social_connections`, `publish_jobs`, `image_models`; alter `guest_dossiers.person_id`.
  ✔ Igual T-09; unique `(tenant_id,provider,platform,external_account_id)` presente.

- [x] **T-12 · Backfills 0008** — `people-directory`, `assets-unified`, `multi-tenant-auth` · L · deps: T-11 · épicas: PC-02, PF-10
  Files: `temp-migrations/*`, `drizzle/0008_*.sql`
  Pasos: `user_tenants`←users; `persons`/`person_photos`/`person_program`/`person_transmission`←conductors+guests; `guest_dossiers.person_id`; `assets`←clips+publications (`legacy_ref`); `tenant_quotas`←usage_records; `social_connections`←business_assets(+twitter_legacy).
  ✔ Conteos: users=user_tenants, conductors+guests=persons, clips+publications=assets; queries por tenant devuelven datos en staging.

- [x] **T-13 · Migración 0009 — users.tenant_id nullable** — `multi-tenant-auth` · S · deps: T-12 · épicas: PA-01
  Files: `src/server/db/schema/*`, `drizzle/0009_*.sql`
  Pasos: `ALTER TABLE users ALTER COLUMN tenant_id DROP NOT NULL`; marcar columna deprecada en schema/comentarios.
  ✔ Migración aplica; user nuevo sin tenant_id inserta OK.

## Fase 2 — Servicios fundacionales (post T-10; batch B-D paralelo)

- [x] **T-14 · jobsQueueService + worker loop** — `feature-flags`(no) → `go-live-ops`/`audit-log` contexto · spec: ninguna directa (D7) · L · deps: T-10 · épicas: PI-01
  Files: `src/server/services/jobsQueueService.ts`
  Pasos: enqueue (con `dedup_key`), claim `FOR UPDATE SKIP LOCKED`, ack, retry backoff 2^n, dead-letter; registry de handlers tipado por `JobType`.
  ✔ `tsc` + job dummy encolado→claimed→done en DB (verificación SQL manual).

- [x] **T-15 · quotaService** — `usage-quota` · M · deps: T-10 · épicas: PB-02
  Files: `src/server/services/quotaService.ts`
  Pasos: `consume` (INSERT quota_operations ON CONFLICT + UPDATE condicional con RETURNING), `release`, `grant`; período YYYY-MM en `tenant.timezone` vía Intl; límites plan+`extra_transmissions`.
  ✔ `tsc` + consume concurrente (2 calls mismo operation_id) descuenta 1 vez; sin cuota → `allowed:false`.

- [x] **T-16 · auditService + middleware forbidden_attempt** — `audit-log` · S · deps: — · épicas: PA-05
  Files: `src/server/services/auditService.ts`
  Pasos: helper `audit({actor,tenantId,action,ip,ua,metadata})` best-effort (nunca tira request, nunca guarda secretos); middleware emite `forbidden_attempt` en 403 de rol.
  ✔ `tsc` + acción sensible genera fila en `audit_log` sin secretos.

- [x] **T-17 · featureFlagService + requireFeature** — `feature-flags` · S · deps: T-10 · épicas: PA-11
  Files: `src/server/services/featureFlagService.ts`
  Pasos: `resolveFeature(tenantId,key)`: override vigente (`expires_at`)→plan `features`→default; caché con invalidación; middleware `requireFeature(key)` → 402/403.
  ✔ `tsc` + override tenant gana sobre plan; expirado cae a plan.

- [x] **T-18 · aiCostMeter** — `audit-log`(contexto PI-03) · S · deps: T-10 · épicas: PI-03
  Files: `src/server/services/aiCostMeter.ts`
  Pasos: `recordAiCost(tenantId,transmissionId,provider,kind,units,unit,cost)` → `ai_cost_records`.
  ✔ `tsc` + registro visible en query por tenant/transmission.

- [x] **T-19 · mediaSigner + /internal/media** — `assets-unified`, `go-live-ops` (D13) · M · deps: — · épicas: PI-05
  Files: `src/server/services/mediaSigner.ts`, rutas `/internal/media/*` (engine), proxy `GET /api/assets/:id/media` (api)
  Pasos: tokens firmados corta vida; engine sirve archivo si token válido; api proxied/redirect con auth.
  ✔ `tsc` + GET con token sirve media, sin token/expirado → 401/403.

## Fase 3 — T1 core diferencial (batch B-E/B-F)

- [ ] **T-20 · PROCESS_ROLE split + engine.ts** — `go-live-ops` · M · deps: T-14 · épicas: PI-01, PD-04
  Files: `src/server/index.ts`, `src/server/engine.ts`
  Pasos: `PROCESS_ROLE=api|engine` guard (api no inicia loops); engine init scheduler+workers+recorder+purge+dunning+`/internal/*`; reconciliación de `transmissions` live/waiting huérfanas al boot.
  ✔ `tsc` + `PROCESS_ROLE=api` arranca sin scheduler (log); engine arranca workers y reconcilia.

- [ ] **T-21 · transmissionService (FSM + eventos)** — `stream-recording`, `live-room` · L · deps: T-09 · épicas: PD-04
  Files: `src/server/services/transmissionService.ts`, `src/server/services/notificationService.ts` (eventos `transmission:*`)
  Pasos: CRUD + FSM scheduled→waiting→live→processing→done/error/canceled; `startedAt` ancla; heartbeat; socket emits por transición.
  ✔ `tsc` + transición manual emite `transmission:live` por Socket.IO observable en cliente test.

- [ ] **T-22 · streamRecorderService (supervisor ffmpeg)** — `stream-recording` · L · deps: T-20, T-21 · épicas: PD-01, PD-02, PI-04
  Files: `src/server/services/streamRecorderService.ts`
  Pasos: liveDetect ventana 15×2min → `yt-dlp -g` una vez → `ffmpeg -c copy -f segment -segment_time 60 -strftime 1` en `/data/media/{tenant}/{tx}/`; al caer stream re-resuelve; registra `stream_recordings`+`recording_segments` (startMs por strftime−startedAt); heartbeat; stop limpio; maxDurationMinutes → stop suave.
  ✔ `tsc` + grabación real de stream de prueba produce segmentos MP4 + filas `recording_segments` con ms coherentes.

- [ ] **T-23 · Servicio face (Python FastAPI)** — `face-attribution` · M · deps: T-06 (GATE-1) · épicas: PC-04, PE-03
  Files: `face/main.py`, `Dockerfile.face`
  Pasos: `POST /enroll` (foto→faceCount+embedding512), `POST /detect` (frame→faces[bbox,embedding]), `GET /health`; insightface+onnxruntime CPU, modelo `buffalo_l`.
  ✔ `docker build` + curl /enroll con foto devuelve embedding de 512 floats.

- [ ] **T-24 · faceService (cliente) + enrolamiento de fotos** — `face-attribution`, `people-directory` · M · deps: T-23, T-09 · épicas: PC-04
  Files: `src/server/services/faceService.ts`
  Pasos: HTTP client con timeout/retry + health/degradación (enrolled-off); pipeline al subir `person_photos`: detect→1 cara→insert `face_embeddings`; estados `pending/enrolled/no_face/multi_face/error`; `enrollment_status` derivado en persons.
  ✔ `tsc` + subir foto real → embedding en DB y `persons.enrollment_status='ready'` (con ≥1 enrolled); face caído → degradación sin romper request.

- [ ] **T-25 · frameSamplerService → person_appearances(face)** — `face-attribution` · M · deps: T-22, T-24 · épicas: PE-03
  Files: `src/server/services/frameSamplerService.ts`
  Pasos: watcher de segmento completado → `ffmpeg -vf fps=1` → POST /detect por frame → match `face_embeddings WHERE tenant_id ORDER BY embedding<=> LIMIT 1` (umbral ~0.5) → `person_appearances(source='face', personId?, bbox, startMs/endMs)`.
  ✔ `tsc` + segmento con cara enrolada genera appearances con personId y bbox; desconocida → personId null.

- [ ] **T-26 · attributionService (fusión speaker↔rostro)** — `face-attribution`, `live-room` · L · deps: T-25 · épicas: PE-03, PE-05
  Files: `src/server/services/attributionService.ts`
  Pasos: fusión wall-clock speaker_label × appearances en ventana → persona dominante → `person_appearances(source='fusion', confidence)`; mapa speakerLabel→personId por transmisión; corrección manual `POST /live/:tx/correct` aplica forward+backward sobre emitidas (source='manual'); ambiguo → baja confianza, nunca inventa.
  ✔ `tsc` + corrección manual re-etiqueta timeline y persiste appearances 'manual'.

- [ ] **T-27 · Módulo Personas (rutas + servicio)** — `people-directory` · M · deps: T-09, T-24 · épicas: PC-03, PC-09
  Files: `src/server/routes/people.ts` (+ servicio inline o `personService.ts`)
  Pasos: CRUD persons (role/socials/notes/bio/consent_at), fotos multi (dispara T-24), person_program/person_transmission (invitado por fecha), soft-delete, listado por programa.
  ✔ `tsc` + CRUD completo vía API con tenant A no ve persons de tenant B.

- [ ] **T-28 · editorialProfileService** — `editorial-profiles` · M · deps: T-09 · épicas: PC-05
  Files: `src/server/services/editorialProfileService.ts`
  Pasos: perfil efectivo programa(`editorial_overrides`)→tenant→default; update crea `editorial_profile_versions` append-only (snapshot+version+1).
  ✔ `tsc` + override programa gana; editar perfil → versión N+1 con snapshot.

- [ ] **T-29 · promptBuilderService (choke point)** — `editorial-profiles` · M · deps: T-28 · épicas: PC-06
  Files: `src/server/services/promptBuilderService.ts`
  Pasos: `build({tenantId,programId,kind,context})` → {system,user,profileVersion}; refactor de TODO prompt de generación (nota/copy/moments/titulo/edit) para pasar por acá.
  ✔ `tsc` + generación de nota incluye tono/reglas del perfil efectivo (verificar prompt en log).

- [ ] **T-30 · Pipeline wall-clock + moment→enqueue render_clip** — `live-room`, `stream-recording`, `face-attribution` · L · deps: T-14, T-18, T-29, T-21 · épicas: PE-02, PE-04, PE-06, PE-07
  Files: `src/server/services/pipelineService.ts`, `src/server/services/transcriptionService.ts`
  Pasos: utterances con `wallMs` (offset de chunk acumulado) anclado a `startedAt`; topics/moments → `transmission_segments` con speakers jsonb; moment detection → `jobs_queue.enqueue('render_clip')` respetando `maxClipsPerTransmission`; prompts vía T-29; metering vía T-18; vincula corrida a `transmissionId`.
  ✔ `tsc` + segmento de prueba genera `transmission_segments` con wallMs coherentes con `recording_segments`.

- [ ] **T-31 · Remotion LiveClipOverlay (webm transparente)** — `clip-extraction` · M · deps: — · épicas: PF-03
  Files: `remotion/src/compositions/LiveClipOverlay.tsx` (+ registro)
  Pasos: composición alpha: logo tenant, lower-third nombre+rol persona, progreso/watermark; render script → `overlay.webm`.
  ✔ `npx remotion render` produce webm con alpha; visual OK en frame extraído.

- [ ] **T-32 · clipCutterService (cut→crop→subs→overlay)** — `clip-extraction` · L · deps: T-22, T-25, T-31, T-11 · épicas: PF-01, PF-02, PF-05
  Files: `src/server/services/clipCutterService.ts`
  Pasos: resolver segmentos que cubren [startMs,endMs] → concat/cut `-ss/-t`; crop 9:16 centro=bbox ponderado del speaker dominante por tramo (split en speaker-change, fallback centrado); ASS subs de utterances ventana (nombres resueltos, fuente tenant); una pasada ffmpeg crop→scale 1080x1920→subs→overlay webm → `assets(type='clip',source='footage')` + thumb + `asset_persons`; versionado de re-cortes.
  ✔ `tsc` + render_clip job produce MP4 1080x1920 con subs y overlay; asset en `ready`.

- [ ] **T-33 · Scheduler: cuota pre-dispatch + transmission** — `scheduler-fix`, `usage-quota` · M · deps: T-05, T-15, T-21 · épicas: PD-03, PB-02
  Files: `src/server/services/jobSchedulerService.ts`
  Pasos: `quotaService.consume(opId=schedjob:{jobId}:{jobLocalDate})`; sin cuota → `job_executions(status='skipped_quota')` + notificación paywall + audit; con cuota → `transmissionService.create(status='waiting', operationId)` + `job_executions.transmission_id`; release si captura < MIN_CAPTURE_MS.
  ✔ `tsc` + tenant sin cuota → skipped_quota sin captura; retry mismo opId no duplica consumo.

- [ ] **T-34 · Rutas transmissions + live room API** — `live-room`, `stream-recording`, `scheduler-fix` · M · deps: T-21, T-26, T-15 · épicas: PD-05, PD-07
  Files: `src/server/routes/transmissions.ts`, `src/server/routes/live.ts`, `src/server/routes/capture.ts`, `src/server/routes/pipeline.ts`
  Pasos: `GET /api/transmissions` (agenda/historial), `GET /live/:tx/timeline` (segments+speakers+appearances), `POST /live/:tx/mark` (ventana → enqueue render_clip), `POST /live/:tx/correct`; start manual crea transmission + consume cuota.
  ✔ `tsc` + mark manual encola render_clip; timeline devuelve speakers resueltos.

- [ ] **T-35 · Fallback VOD upload** — `stream-recording` · M · deps: T-21, T-14 · épicas: PD-07
  Files: `src/server/services/transmissionService.ts` (vod_ingest), `routes/transmissions.ts`
  Pasos: upload de video → `transmission(source='vod_upload')` → job `vod_ingest` lo segmenta en `recording_segments` (startedAt=inicio archivo) → mismo pipeline.
  ✔ `tsc` + upload MP4 produce segmentos y entra a pipeline normal.

- [ ] **T-36 · Purga de crudos por retención de plan** — `stream-recording`, `go-live-ops` · M · deps: T-14, T-22 · épicas: PD-06, PI-05
  Files: `src/server/services/jobsQueueService.ts` (handler `purge_recording`), scheduler diario en engine
  Pasos: purga diaria por `plan.retention_days`; verifica refs en jobs_queue/render pendientes antes de borrar; marca `recording_segments.status='purged'`; alerta uso de disco.
  ✔ `tsc` + segmento viejo con render pendiente NO se borra; sin refs → archivo fuera + status purged.

## Fase 4 — T2 SaaS hardening (batch B-G)

- [ ] **T-37 · Auth multi-tenant (JWT activeTenantId + membresías)** — `multi-tenant-auth`, `super-admin`, `audit-log` · L · deps: T-12, T-16 · épicas: PA-04, B-2
  Files: `src/server/middleware/auth.ts`, `src/server/services/authService.ts`, `src/server/routes/auth.ts`
  Pasos: JWT {userId,activeTenantId,role membresía,isPlatformAdmin,imp?}; `requireAuth` re-verifica `user_tenants` por request (revocación efectiva); `requireRole` sobre rol membresía; `requirePlatformAdmin`; `POST /switch-tenant` (JWT nuevo + last_used_at); login devuelve tenants[]; register→tenant+user_tenants owner; guard anti-destructive si `imp`.
  ✔ `tsc` + suspender membresía → próximo request 403 sin esperar expiración JWT.

- [ ] **T-38 · Invites: inviteService + /api/team** — `team-invites` · M · deps: T-37 · épicas: PA-02, PA-03
  Files: `src/server/services/inviteService.ts`, `src/server/routes/team.ts`
  Pasos: invite→email token→accept (crea/une user + `user_tenants`); revoke/resend; unicidad pending; enforcement `maxTeamMembers` del plan.
  ✔ `tsc` + flujo invite→accept end-to-end crea membresía con rol correcto.

- [ ] **T-39 · subscriptionMachine + billingEventsService** — `subscription-lifecycle` · M · deps: T-10 · épicas: PB-07
  Files: `src/server/services/subscriptionMachine.ts`, `src/server/services/billingEventsService.ts`
  Pasos: función pura `transition(status,event,ctx)` con aristas validadas (trial→active→payment_failed→past_due/grace→canceled/suspended); wrapper que aplica + persiste; billing_events append-only + dedup por `external_id` UNIQUE.
  ✔ `tsc` + transición inválida rechazada; mismo external_id → dedup sin doble efecto.

- [ ] **T-40 · Billing routes → máquina + add-ons** — `subscription-lifecycle`, `bug-fixes` · L · deps: T-01, T-02, T-39, T-15 · épicas: PB-04, PB-05
  Files: `src/server/routes/billing.ts`
  Pasos: webhooks Stripe/MP → dedup `billing_events` → `subscriptionMachine.transition`; checkout alta/cambio plan (prorrateo)/cancel (soft, cancel_reason); add-on +5/+15 → `quotaService.grant` (expira con ciclo); trial eligibility 7d/2tx.
  ✔ `tsc` + `invoice.payment_failed` real → past_due + billing_event + enqueue dunning.

- [ ] **T-41 · dunningService** — `subscription-lifecycle` · M · deps: T-40, T-14 · épicas: PB-07, PB-09
  Files: `src/server/services/dunningService.ts`
  Pasos: job `dunning_cycle` diario: reintento cobro provider + email intento N/max; `grace_ends_at` vencido → suspended (paywall, datos intactos); emails trial por vencer/pago ok/fallido.
  ✔ `tsc` + past_due con grace vencido → suspended visible; emails encolados/enviados.

- [ ] **T-42 · adminService + impersonación + métricas + /api/admin** — `super-admin`, `audit-log` · L · deps: T-37, T-16, T-18 · épicas: PA-06…PA-10
  Files: `src/server/services/adminService.ts` (+`platformMetricsService` puro), `src/server/routes/admin.ts`
  Pasos: lista/búsqueda tenants (plan,uso,estado), detalle (users,uso,actividad,costo IA), acciones plan/trial/+tx/suspender→billing_event `admin_grant`; impersonación F4 (30min, guard anti-destructive, audit c/metadata.impersonatedBy); panel jobs_queue.
  ✔ `tsc` + impersonar emite JWT imp:true; `/billing` con imp → 403; audit registra inicio/fin.

- [ ] **T-43 · usageTracker → delegación quotaService** — `usage-quota` · S · deps: T-15, T-18 · épicas: PB-02, PI-03
  Files: `src/server/services/usageTracker.ts`
  Pasos: `checkUsageLimits` delega en quotaService (o depreca); track* escribe también `ai_cost_records`.
  ✔ `tsc` + llamadores de checkUsageLimits reciben veredicto de cuota real.

- [ ] **T-44 · Plans seed + paywall/usage endpoints + enforcement duración** — `usage-quota`, `subscription-lifecycle` · M · deps: T-10, T-15 · épicas: PB-03, PB-06
  Files: seed `plans`, `src/server/routes/billing.ts` (usage status), enforcement en recorder (T-22 hook maxDurationMinutes)
  Pasos: seed Creator/Media/Network/Enterprise con límites; `GET /api/billing/usage` (count/limit/period/extra); banners >80%; stop suave al llegar maxDuration.
  ✔ `tsc` + endpoint devuelve período TZ tenant correcto; maxDuration detiene captura y procesa lo grabado.

## Fase 5 — T3 publicación y experiencia (batch B-H; post GATE-2 para Zernio)

- [ ] **T-45 · assetService + /api/assets (bandeja unificada)** — `assets-unified`, `review-and-autopublish` · L · deps: T-11, T-12 · épicas: PF-10, PG-01
  Files: `src/server/services/assetService.ts`, `src/server/routes/assets.ts`
  Pasos: CRUD assets + FSM generating→ready→pending_review→approved/rejected→published/failed; filtros tipo/programa/transmission; `asset_persons`; `delivery_status` rollup; `edit_history` append.
  ✔ `tsc` + bandeja lista clips legacy (backfill) junto a nuevos; filtro por tenant estricto.

- [ ] **T-46 · zernioService** — `zernio-publishing` · L · deps: T-07 (GATE-2) · épicas: PG-04
  Files: `src/server/services/zernioService.ts`
  Pasos: `ensureProfile(externalId=tenantId)` lazy; `getConnectUrl` (authUrl + welcome-screen); `publish` con media upload (o mediaSigner URL si spike falló); parseo de webhook payloads.
  ✔ `tsc` + connect devuelve authUrl; publish de prueba → external_post_id (sandbox).

- [ ] **T-47 · publishRouter + social_connections + publish_jobs** — `zernio-publishing`, `review-and-autopublish` · L · deps: T-45, T-46, T-14 · épicas: PG-05, PG-06, PG-07
  Files: `src/server/services/publishRouterService.ts`, `src/server/routes/connections.ts`, handler `publish_job`, `src/server/services/publishService.ts` (legacy providers)
  Pasos: `/api/connections/zernio/:platform/connect`; listado unificado `social_connections` (enforcement `maxConnectedPlatforms`); aprobar→publish_jobs `dedup_key=asset:conn`→enqueue; worker rutea por provider (zernio|meta_legacy|twitter_legacy|webhook|drive); menciones con `persons.socials`.
  ✔ `tsc` + approve asset con 2 conexiones → 2 publish_jobs queued; Meta legacy sigue publicando igual.

- [ ] **T-48 · Webhook Zernio entrante** — `zernio-publishing` · M · deps: T-47 · épicas: PG-05
  Files: `src/server/routes/webhooks.ts` (o billing-style router), `zernioService` parser
  Pasos: `POST /api/webhooks/zernio` verifica `ZERNIO_WEBHOOK_SECRET`, dedup por event id; post.published/failed→publish_job status+external_post_id; account.connected/disconnected→upsert `social_connections`; rollup→`asset.delivery_status`→'published' cuando todas resuelven.
  ✔ `tsc` + evento duplicado no re-procesa; rollup marca asset published.

- [ ] **T-49 · Rutas review → assets + auto-publicación** — `review-and-autopublish`, `assets-unified`, `editorial-profiles` · M · deps: T-45, T-47, T-29, T-28 · épicas: PG-02, PG-03
  Files: `src/server/routes/review.ts`
  Pasos: opera sobre `assets` (batch approve/reject); approve→publishRouter; política `approval_policy='auto'` (perfil efectivo + plan lo permite) publica sin click; edición IA vía promptBuilder (`kind='edit'`).
  ✔ `tsc` + auto-policy publica sin aprobación manual; edición IA registra en edit_history.

- [ ] **T-50 · imageModelRegistry** — `image-model-registry` · M · deps: T-11, T-17 · épicas: PF-07, PF-08
  Files: `src/server/services/imageModelRegistry.ts`, `src/server/services/imageService.ts` (integración)
  Pasos: seed `image_models` (gemini-flash-image, gpt-image, ideogram, flux, recraft) con capabilities/plan_gating; resolución tenant default→plan→fallback chain; metering vía T-18.
  ✔ `tsc` + tenant plan bajo cae a fallback habilitado; costo registrado.

- [ ] **T-51 · onboardingService + /api/onboarding** — `onboarding-wizard` · M · deps: T-37, T-28, T-46(soft) · épicas: PC-10
  Files: `src/server/services/onboardingService.ts`, `src/server/routes/onboarding.ts`
  Pasos: progreso 4 pasos (canal→programa→personas→conexión Zernio) en `tenants.config.onboarding`; final → `onboarding_completed=true`; resumible.
  ✔ `tsc` + wizard completo marca flag; reanuda en paso pendiente.

- [ ] **T-52 · Capa de compat: clips/conductors/guests → assets/persons** — `assets-unified`, `people-directory` · M · deps: T-45, T-27 · épicas: PF-10, PC-03
  Files: `src/server/routes/clips.ts`, `src/server/routes/conductors.ts`, `src/server/routes/guests.ts`, `src/server/services/clipService.ts`
  Pasos: lecturas delegan a assets/persons (legacy_ref); escritura de clips sintéticos → `assets(source='synthetic')`; headers de deprecación; tablas legacy READ-ONLY.
  ✔ `tsc` + UI vieja sigue listando contenido post-backfill sin tocar tablas legacy para escritura.

## Fase 6 — Cliente React (batch B-I; cada página tras su API)

- [ ] **T-53 · Client shell: switcher tenant + banner imp + useFeature + paywall** — `multi-tenant-auth`, `feature-flags`, `super-admin`, `usage-quota` · M · deps: T-37, T-17, T-44 · épicas: PA-11, PB-06
  Files: `src/client/*` (auth store, hooks `useFeature`, componentes shell)
  Pasos: switcher de tenant (llama switch-tenant, re-login sockets); banner "viendo como {tenant}" si imp; hook `useFeature`; modal paywall + banners uso.
  ✔ `vite build` + switch cambia tenant visible; feature off oculta superficie.

- [ ] **T-54 · PeoplePage** — `people-directory`, `face-attribution` · M · deps: T-27, T-24, T-53 · épicas: PC-03
  Files: `src/client/pages/PeoplePage.tsx` (+componentes)
  Pasos: CRUD con multi-foto, estado de enrolamiento (pending/no_face/ready), redes, notas, programas; consentimiento explícito.
  ✔ `vite build` + flujo alta persona con 3 fotos muestra estados de enrollment reales.

- [ ] **T-55 · TransmissionsPage + LiveRoomPage** — `live-room`, `stream-recording` · L · deps: T-34, T-53 · épicas: PC-08, PD-05, PH-07
  Files: `src/client/pages/TransmissionsPage.tsx`, `LiveRoomPage.tsx`
  Pasos: agenda (crear/editar job+timezone, calendario); sala en vivo: timeline transcripción con speakers resueltos, momentos, clips generándose, botón mark, corrección speaker→persona; usable en tablet.
  ✔ `vite build` + durante tx real se ven segmentos/clips llegando por socket sin reload.

- [ ] **T-56 · AssetsTrayPage + review UI** — `assets-unified`, `review-and-autopublish` · M · deps: T-45, T-49, T-53 · épicas: PG-01, PG-02
  Files: `src/client/pages/AssetsTrayPage.tsx` (+componentes review)
  Pasos: bandeja filtros tipo/programa/tx; preview clip 9:16; approve/reject batch; edición IA; estados de publicación por conexión.
  ✔ `vite build` + approve desde UI dispara publish_jobs visibles en estado.

- [ ] **T-57 · TeamPage + AdminConsole** — `team-invites`, `super-admin` · M · deps: T-38, T-42, T-53 · épicas: PA-03, PA-06…PA-10
  Files: `src/client/pages/TeamPage.tsx`, `src/client/pages/admin/*`
  Pasos: equipo (lista, rol, reenviar/revocar); consola `/admin`: tenants lista/detalle, acciones plan/trial/+tx/suspender, impersonar, panel jobs, métricas plataforma.
  ✔ `vite build` + impersonación desde consola entra con banner y expira.

- [ ] **T-58 · OnboardingWizard + Connections UI** — `onboarding-wizard`, `zernio-publishing` · M · deps: T-51, T-47, T-53 · épicas: PC-10, PG-04
  Files: `src/client/pages/OnboardingWizard.tsx`, `src/client/pages/ConnectionsPage.tsx`
  Pasos: wizard 4 pasos con progreso resumible; connect embebido Zernio por plataforma; listado social_connections con estado.
  ✔ `vite build` + onboarding nuevo llega a `onboarding_completed` sin ayuda.

- [ ] **T-59 · Dashboard "Ahora" + navegación + estados** — `live-room`(superficie), `go-live-ops` · M · deps: T-34, T-44, T-53 · épicas: PH-03, PH-04, PH-05
  Files: `src/client/*` (DashboardPage, sidebar/topbar, componentes Empty/Loading/Error)
  Pasos: "Ahora" (en vivo, próximas, pendientes aprobación, medidor uso); nav por módulos nuevos; estados vacíos/loading/error consistentes.
  ✔ `vite build` + dashboard refleja tx live en tiempo real.

- [ ] **T-60 · UX elevation: tokens, landing, emails, tablet** — ninguna spec directa (PH) · L · deps: T-53 · épicas: PH-01, PH-02, PH-06, PH-07
  Files: `src/client/*` (tokens/tailwind), `public/landing`, templates de email server
  Pasos: design tokens dark pro densidad newsroom; landing pública (propuesta+planes+demo); emails transaccionales con branding; responsive tablet en sala/bandeja.
  ✔ `vite build` + landing pública reachable; email render con branding en sandbox.

## Fase 7 — Deploy y go-live (batch B-J)

- [ ] **T-61 · Deploy EasyPanel: api/engine/face/frontend** — `go-live-ops` · M · deps: T-20, T-23, T-19 · épicas: PI-04, PI-05
  Files: `Dockerfile`, `Dockerfile.face`, `docs/DEPLOYMENT_EASYPANEL.md`, env docs
  Pasos: mismo artefacto api/engine según CMD (`PROCESS_ROLE`); servicio `face` interno :8000; volumen `/data/media` solo en engine; env nuevas (`ZERNIO_*`, `MP_WEBHOOK_SECRET`, `FACE_SERVICE_URL`, `MAX_CONCURRENT_RECORDINGS`); health checks.
  ✔ Deploy staging: api público responde, engine procesa jobs, face /health OK; api escala sin doble scheduler.

- [ ] **T-62 · Checklist go-live + piloto** — `go-live-ops` · M · deps: T-61, T-44 · épicas: PI-06, PI-07
  Files: `docs/` runbook, seeds, scripts de health
  Pasos: seeds planes+features default; datos demo; health endpoints api/engine/face; runbook de incidentes (stream caído, quota agotada, webhook falla); piloto 1 canal real 1 semana con métricas (clips/tx, atribución ≥90%, cuota exacta).
  ✔ Checklist ejecutado en staging; piloto corre con criterios de aceptación del proposal.

---

## Mapeo épica → tareas (trazabilidad PRODUCT-VISION)

| Épica | Items | Tareas |
|-------|-------|--------|
| PA fundación+admin | PA-01…PA-12 | T-03, T-10, T-13, T-16, T-17, T-37, T-38, T-42, T-53, T-57, T-64 (+PA-12: T-01/T-02/T-03/T-64) |
| PB billing | PB-01…PB-09 | T-01, T-02, T-05, T-10, T-15, T-33, T-39, T-40, T-41, T-43, T-44, T-53, T-65 |
| PC contexto canal | PC-01…PC-10 | T-08, T-09, T-12, T-23, T-24, T-27, T-28, T-29, T-34, T-51, T-52, T-54, T-55, T-58, T-66 |
| PD ingesta+sched | PD-01…PD-07 | T-05, T-20, T-21, T-22, T-33, T-34, T-35, T-36, T-55 |
| PE motor análisis | PE-01…PE-07 | T-06, T-23, T-25, T-26, T-30, T-63 |
| PF fábrica contenido | PF-01…PF-10 | T-11, T-12, T-31, T-32, T-45, T-50, T-52, T-67 |
| PG bandeja+Zernio | PG-01…PG-07 | T-07, T-11, T-45, T-46, T-47, T-48, T-49, T-56, T-58 |
| PH UX | PH-01…PH-07 | T-55, T-59, T-60 (spec `platform-ux`) |
| PI robustez | PI-01…PI-07 | T-10, T-14, T-18, T-19, T-20, T-36, T-42, T-61, T-62, T-68 |

## Verificación global del cambio (al cierre)

- [ ] `tsc --noEmit` (client+server) y `vite build` verdes
- [ ] Cero queries nuevas sin `tenant_id` (grep de handlers nuevos)
- [ ] Criterios de aceptación del proposal verificados en staging/piloto
- [ ] Flags `tenant_features` pueden apagar cada superficie nueva (rollback)

## Tareas agregadas por auditoria (cobertura de tickets sin implementacion explicita)

- [ ] **T-63 - analysisProviderRegistry y contratos de analisis** - `analysis-provider-registry` - M - deps: T-18, T-21 - epicas: PE-01
  Files: `src/server/services/analysisProviderRegistry.ts`, adaptadores de transcripcion/analisis/imagen, configuracion validada.
  Pasos: definir interfaz tipada por capacidad (`transcription`, `video_analysis`, `image_generation`), seleccion por tenant/proceso con allowlist y fallback explicito; instrumentar costo/latencia/error por proveedor; migrar el pipeline para consumir el registry antes de integrar el modelo multimodal.
  Verification: test unitario de seleccion/fallback + `tsc`; un proveedor caido produce fallback o error clasificado, nunca cambia proveedor silenciosamente.

- [ ] **T-64 - Hardening HTTP y secretos de tenant** - `security-hardening` - M - deps: T-03, T-16, T-37 - epicas: PA-12
  Files: middleware HTTP, bootstrap Express, rutas auth/API y almacenamiento de configuraciones sensibles.
  Pasos: rate limit diferenciado auth/API, headers de seguridad, CORS por allowlist de entorno, cifrado en reposo/rotacion para credenciales de integraciones; probar que logs/audit redaccion secretos.
  Verification: tests de integracion: exceso auth devuelve 429, origin no permitido bloqueado, secreto persistido no queda en claro ni en audit/log.

- [ ] **T-65 - Facturacion: pagina y contrato de emails** - `billing-experience` - M - deps: T-40, T-41, T-44, T-53 - epicas: PB-08, PB-09
  Files: `src/client/pages/BillingPage.tsx`, templates/notificaciones de billing y rutas de uso/historial.
  Pasos: mostrar plan, uso/renovacion en TZ tenant, historial de eventos/pagos y compra de add-ons; centralizar emails trial/pago/dunning con idempotency key y branding.
  Verification: `vite build` + prueba de UI muestra 25/30, renovacion e historial; reintento de evento no envia email duplicado.

- [ ] **T-66 - EditorialProfilePage** - `editorial-profiles` - M - deps: T-28, T-29, T-53 - epicas: PC-05
  Files: `src/client/pages/EditorialProfilePage.tsx` y componentes de configuracion.
  Pasos: editar tono, reglas, ejemplos, rubro, formatos y politica de aprobacion; soportar override parcial por programa y mostrar version aplicada.
  Verification: `vite build` + override de programa persiste y el preview de prompt identifica la version efectiva.

- [ ] **T-67 - Fabrica de notas, flyers y variantes** - `content-factory` - L - deps: T-29, T-45, T-50, T-63 - epicas: PF-06, PF-07, PF-09
  Files: servicios de generacion de nota/flyer/copy, handlers de jobs y enlaces a `assets`.
  Pasos: generar notas por rubro con citas atribuidas, flyer/quote-card con foto de persona cuando exista y variantes por red con hashtags/menciones; cada salida crea asset idempotente con version editorial y costo medido.
  Verification: prueba de job con segmento atribuido crea nota, flyer y variantes; no atribuye una foto/cita si la confianza no supera el umbral.

- [ ] **T-68 - Observabilidad de request y transmision** - `go-live-ops` - M - deps: T-14, T-20, T-21 - epicas: PI-02
  Files: bootstrap HTTP, logger estructurado y servicios de pipeline/recorder/jobs.
  Pasos: propagar `requestId`, `tenantId`, `transmissionId` y `jobId` en logs JSON; establecer niveles/redaccion de secretos, metricas de error/latencia y consultas de correlacion para la consola admin.
  Verification: prueba de request crea un `requestId` trazable hasta su job/transmision; logs no exponen token, body ni secreto.
