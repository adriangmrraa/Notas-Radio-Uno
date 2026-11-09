# Design: live-creator-platform — PeriodistApp, plataforma de canales en vivo

Contrato técnico del cambio. Deriva de `proposal.md` + 21 specs en `specs/`, verificado contra el código real en `src/server/`, `src/client/`, `remotion/`, `Dockerfile`, `docs/DEPLOYMENT_EASYPANEL.md`.

Subdocs:
- `design/schema.md` — DDL Drizzle completo (tablas nuevas/alteradas, columnas, índices, FKs, orden de migraciones).
- `design/flows.md` — Flujos secuenciales críticos (scheduler→transmisión, pipeline vivo, aprobación→Zernio, impersonación, billing).

## Technical Approach

Monolito modular Express+TS existente, dividido en **2 procesos por rol** (`PROCESS_ROLE=api|engine`, misma imagen Docker, distinto CMD): `api` = HTTP+Socket.IO stateless; `engine` = scheduler + jobs_queue workers + stream recorder + frame sampler + purgas + dunning. Todo el media pesado (crudos, clips, frames) vive en el volumen del `engine`; `api` nunca toca archivos grandes (proxy/redirect a engine para media). Un tercer proceso `face` (Python FastAPI + InsightFace, stateless) sirve detección/embeddings por HTTP interno. Esto satisface B-1 (ingesta en VPS propio) sin prematuramente extraer microservicios: la cola es Postgres `jobs_queue` (D-6), la frontera de extracción ya está dibujada para cuando >10–20 streams simultáneos.

**Reloj de la transmisión**: `transmissions.startedAt` es el ancla wall-clock absoluta. Todos los artefactos temporales (`recording_segments`, `person_appearances`, `transmission_segments`, ventanas de clip, utterances de AssemblyAI acumuladas por offset de chunk) se expresan en `ms` relativos a ese instante — es lo que permite alinear video+rostros+voz sin timestamps del stream.

## Architecture Decisions

| # | Decisión | Alternativas | Rationale |
|---|----------|--------------|-----------|
| D1 | `PROCESS_ROLE=api\|engine` en la misma imagen; engine corre scheduler/recorder/workers | Microservicios ya; todo en api | Aísla CPU/bandwidth de ingesta del request-path (B-1) con cero infra nueva; la división scheduler-fuera-de-api además evita doble dispatch si api escala |
| D2 | Recorder: `yt-dlp -g` resuelve UNA vez → `ffmpeg -i <hls> -c copy -f segment -segment_time 60 -strftime 1` → supervisor re-resuelve al caer | Pipe yt-dlp\|ffmpeg; segment_time 300 | `-c copy` cero re-encode; strftime da ancla wall-clock por archivo; 60 s minimiza lag de rostros/clips y pérdida ante corte; supervisor maneja expiración HLS de YT |
| D3 | Audio tap actual SIN cambios, en paralelo al recorder sobre la misma liveUrl | Extraer audio del crudo | El path AssemblyAI ya funciona; alinear por `startedAt` compartido es suficiente; extraer audio post-segmento agregaría lag y acoplaría fallos |
| D4 | InsightFace = servicio Python FastAPI separado (container EasyPanel `face`), stateless: `POST /enroll` (foto→embedding512), `POST /detect` (frame→faces+bbox+embedding); matching en Node vía pgvector | Embeber ONNX en Node; VLM por frame | Python es el runtime natural de InsightFace; stateless = escalable; embeddings en DB permiten enrolled-only por tenant sin compartir índice |
| D5 | Reframe 9:16 por crop ffmpeg con centro = bbox ponderado del speaker dominante por tramo; split en speaker-change; fallback crop centrado | Crop dinámico per-frame con expr; remux 16:9+blur | Determinístico, una sola pasada de re-encode (crop→scale→subs→overlay); el blur-background queda como variante posterior |
| D6 | Overlay de marca: Remotion renderiza WebM transparente (composición nueva `LiveClipOverlay`: logo, lower-third con nombre, progreso) → `ffmpeg overlay` en la misma pasada | drawtext/drawbox en ffmpeg; overlay PNG estático | Mantiene identidad visual de la casa (fuentes/templates ya registrados); transparent-webm evita chroma y respeta branding real |
| D7 | `jobs_queue` Postgres con `FOR UPDATE SKIP LOCKED`, workers in-process en engine, backoff 2^n, dead-letter | BullMQ+Redis ya | D-6 de la propuesta; Neon soporta SKIP LOCKED; Redis queda como add-on opcional para el trigger de escala |
| D8 | JWT porta `activeTenantId` + `role` de la membresía; `requireAuth` re-verifica `user_tenants` por request | Rol solo en token; tenant por body | Revocación efectiva en el próximo request (spec multi-tenant-auth); nunca scope por body |
| D9 | Cuota: UPDATE condicional atómico (`INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING`) + `quota_operations.operation_id` único para idempotencia | Select-then-update; Redis lock | Una sola query decide la reserva — sin carrera entre despachos concurrentes; operation_id resuelve retries de webhook/job |
| D10 | Zernio: profile por tenant `externalId=tenantId` (lazy), connect = authUrl + welcome-screen white-label; publicación con media upload directo a Zernio | Passthrough de URLs firmadas | Spec + exploración verificada; upload binario evita exponer media privada (si el spike S1 muestra que no hay upload → URL firmada vía proxy api) |
| D11 | `users.tenant_id` pasa a NULLABLE y queda deprecado (no se borra); membresías en `user_tenants` | Drop column; dual-write permanente | Spec exige resolver el NOT NULL; conservar la columna permite rollback y lectura legacy durante la migración |
| D12 | Dominios nuevos usan `varchar` + union consts (convención clips/publications actual); solo se altera `JobExecutionStatus` +`skipped_quota` | pgEnum por todo | El repo mezcla ambos; pgEnum ALTER es irreversible en prod — varchar evita churn salvo donde el enum ya existe |
| D13 | Media privada se sirve vía `engine` (`GET /internal/media/*` con token firmado) proxied por `api` (`GET /api/assets/:id/media`) | Volumen compartido; S3 ya | EasyPanel no comparte volúmenes entre servicios; A-1 mantiene filesystem MVP — el proxy mantiene auth y prepara el swap a S3 detrás del mismo endpoint |

## Data Flow

Ver `design/flows.md` para el detalle paso a paso. Resumen:

    YouTube/HLS ──yt-dlp -g──► resolved URL ──► ffmpeg -c copy -f segment (engine)
                                                      │  recording_segments (wall-clock)
                      ┌── audio tap (yt-dlp→mp3 120s)─┤
                      ▼                               ▼
              AssemblyAI utterances           frame sampler (1fps, seg completado)
              (offset relativo)                       │  face service → embeddings
                      │                               ▼
                      └────── fusión wall-clock ──► person_appearances
                                │            (speaker↔persona, confidence)
                                ▼
                    topic/moment detection ──► transmission_segments + mark
                                │
                                ▼ jobs_queue(render_clip)
              clipCutter: ffmpeg cut [startMs,endMs] → crop 9:16 (bbox) →
              ASS subs → overlay webm Remotion → asset(clip) ready→pending_review
                                │ aprobación (review/auto según editorial_profile+plan)
                                ▼ publish_jobs → zernioService → social post

## File Changes

### Nuevos servicios / módulos (`src/server/`)

| File | Action | Description |
|------|--------|-------------|
| `services/streamRecorderService.ts` | Create | Supervisor ffmpeg: resolve (yt-dlp -g), spawn `-c copy -f segment`, reanudación, registro de `recording_segments`, heartbeat, stop |
| `services/transmissionService.ts` | Create | CRUD/FSM de `transmissions` (scheduled→waiting→live→processing→done/error/canceled), VOD upload, eventos Socket.IO, reconciliación de `live` huérfanas al boot |
| `services/frameSamplerService.ts` | Create | ffmpeg `-vf fps=1` sobre segmentos completados → POST al face service → match pgvector → `person_appearances` |
| `services/faceService.ts` | Create | Cliente HTTP del container InsightFace (enroll/detect); enroll de person_photos; health-check/degradación |
| `services/attributionService.ts` | Create | Fusión speaker↔rostro por wall-clock; mapa speakerLabel→personId por transmisión; correcciones manuales forward+backward |
| `services/clipCutterService.ts` | Create | Cut por ventana sobre segmentos (concat), crop 9:16 con bbox, ASS subs, overlay Remotion webm, versionado de re-cortes |
| `services/jobsQueueService.ts` | Create | Enqueue/claim (SKIP LOCKED)/ack/retry/dead de `jobs_queue`; registry de handlers (render_clip, poststream_analysis, purge, publish_job, dunning_cycle, dossier) |
| `services/quotaService.ts` | Create | consume/release/grant con `operation_id`; período YYYY-MM en `tenant.timezone` (Intl); límites efectivos plan+créditos |
| `services/subscriptionMachine.ts` | Create | Función pura `transition(status, event, ctx)` con aristas validadas + `subscriptionLifecycleService` que la aplica + billing_events |
| `services/billingEventsService.ts` | Create | Append-only + dedup por `externalId` |
| `services/featureFlagService.ts` | Create | `resolveFeature(tenantId,key)`: override vigente→plan→default; caché con invalidación; `requireFeature` middleware |
| `services/dunningService.ts` | Create | Worker: reintentos de cobro, emails, grace→suspended |
| `services/adminService.ts` | Create | Acciones admin (plan/trial/grant/suspend/flags), impersonación 30 min, métricas plataforma (`platformMetricsService` puro: MRR/churn/trial) |
| `services/inviteService.ts` | Create | Invite→token email→accept→`user_tenants`; revoke/resend; maxTeamMembers |
| `services/zernioService.ts` | Create | Profile ensure (`externalId=tenantId`), connect authUrl + welcome-screen, publish, media upload, parseo de webhooks |
| `services/publishRouterService.ts` | Create | Resuelve provider por `social_connections.provider` (zernio\|meta_legacy\|twitter_legacy\|webhook\|drive) → encola publish_jobs |
| `services/assetService.ts` | Create | CRUD `assets` + bandeja unificada + transiciones de ciclo editorial |
| `services/editorialProfileService.ts` | Create | Perfil efectivo (programa→tenant→default), versionado append-only |
| `services/promptBuilderService.ts` | Create | ÚNICO choke-point: todo prompt de generación pasa por acá con el perfil efectivo + personas + programa |
| `services/imageModelRegistry.ts` | Create | Resolución de modelo por tenant/plan/caso + fallback chain + metering |
| `services/onboardingService.ts` | Create | Progreso del wizard en `tenants.config.onboarding`, `onboarding_completed` |
| `services/aiCostMeter.ts` | Create | `recordAiCost(tenantId,transmissionId,provider,kind,units)` → `ai_cost_records` |
| `services/auditService.ts` | Create | Helper único `audit({actor,tenantId,action,ip,ua,metadata})` best-effort; middleware `forbidden_attempt` |
| `services/mediaSigner.ts` | Create | Tokens firmados de corta vida para `/internal/media` |
| `middleware/auth.ts` | Modify | `AuthPayload` +`activeTenantId`+`isPlatformAdmin`+`impersonatedBy?`; `requireAuth` verifica membresía; `requirePlatformAdmin`; `requireRole` sobre rol de membresía; guard anti-destructive en impersonación |
| `face/` (raíz, nuevo) | Create | Servicio Python FastAPI: `main.py` (POST /enroll, /detect, /health), `Dockerfile.face` (insightface+onnxruntime CPU) |

### Servicios / rutas existentes modificados

| File | Action | Description |
|------|--------|-------------|
| `services/jobSchedulerService.ts` | Modify | Comparación día/hora/dedup en `job.timezone` vía `Intl.DateTimeFormat`; pre-dispatch `quotaService.consume`; crea `transmission`+`job_execution.transmissionId`; skipped_quota; mueve a engine |
| `services/pipelineService.ts` | Modify | Vincula corrida a `transmissionId`; escribe `transmission_segments`; moment detection encola render_clip; prompts vía promptBuilder; metering aiCostMeter; utterances con offset wall-clock |
| `services/transcriptionService.ts` | Modify | Emite utterances con `wallMs` (chunk offset acumulado); persiste en `transmission_segments`/ventanas |
| `services/usageTracker.ts` | Modify | `checkUsageLimits` → delega en quotaService (o depreca); track* escribe también ai_cost_records |
| `services/clipService.ts` | Modify | Clips sintéticos pasan a producir `assets` (source=synthetic); reusa overlay/branding |
| `services/publishService.ts` | Modify | Se convierte en provider `meta_legacy|webhook|drive|twitter_legacy` detrás de publishRouter (sin cambios de comportamiento) |
| `services/databaseService.ts` | Modify | `getSetting/setSetting/getSettingsByPrefix/deleteSetting` exigen `tenantId`; nuevo `getGlobalSetting` explícito para claves de plataforma |
| `services/authService.ts` | Modify | register→tenant+`user_tenants` owner; login devuelve membresías + JWT con activeTenantId; switch-tenant; invite-accept crea membresía |
| `services/notificationService.ts` | Modify | Eventos transmission-scoped (`transmission:*`) para la sala |
| `routes/auth.ts` | Modify | `POST /switch-tenant`, login multi-tenant, `/me` con tenants[] |
| `routes/jobs.ts` | Modify | POST/PUT aceptan+validan `timezone` (IANA) y `programId` |
| `routes/billing.ts` | Modify | `express.raw()` en `/webhook/stripe` ANTES de `express.json()` (montar router raw primero); MP: verificación `x-signature` si hay secret + re-fetch obligatorio; ambos → subscriptionMachine |
| `routes/settings.ts` | Modify | Todas las lecturas/escrituras con `req.auth.tenantId` |
| `routes/review.ts` | Modify | Opera sobre `assets`; approve → publishRouter; batch; edición IA vía promptBuilder |
| `routes/clips.ts`, `routes/conductors.ts`, `routes/guests.ts` | Modify | Lectura delega a assets/persons (capa de compat) o deprecación con redirect |
| `routes/capture.ts`, `routes/pipeline.ts` | Modify | Start manual crea `transmission` + quota check |
| `routes/connections.ts` | Modify | + `/zernio/:platform/connect`, listado unificado social_connections |
| `src/server/index.ts` | Modify | `PROCESS_ROLE` guard: api no inicia scheduler/workers; registra rutas nuevas; webhook raw antes de json |
| `src/server/engine.ts` | Create | Entry del proceso engine: init scheduler, jobs workers, recorder supervisor, purge, dunning; `/internal/*` (media, health) |
| `src/client/pages/*` | Create | LiveRoomPage, PeoplePage, TransmissionsPage(agenda), TeamPage, AdminConsole pages, OnboardingWizard, AssetsTrayPage |
| `src/client/*` | Modify | Switcher de tenant, banner impersonación, `useFeature`, paywall modal |
| `remotion/src/compositions/LiveClipOverlay.tsx` | Create | Overlay transparente: logo, lower-third (nombre+rol), watermark |
| `Dockerfile` | Modify | Sin cambios de deps (ffmpeg+yt-dlp ya); mismo artefacto corre api/engine según CMD |
| `Dockerfile.face` | Create | python:3.11-slim + insightface + onnxruntime + fastapi + uvicorn |

## Interfaces / Contracts

```ts
// JWT payload (nuevo)
{ userId, activeTenantId, email, role: 'owner'|'editor'|'viewer',
  isPlatformAdmin: boolean, impersonatedBy?: string, imp?: boolean }

// quotaService
consume(tenantId, operationId, metric='transmission', n=1)
  → { allowed: boolean, count, effectiveLimit, period, skipped?: true }
release(operationId) → void           // reversa por fallo < MIN_CAPTURE_MS
grant(tenantId, n, adminId) → credit  // +N transmisiones del ciclo

// jobs_queue payload tipado por `type`
type JobType = 'render_clip'|'poststream_analysis'|'purge_recording'
             |'publish_job'|'dunning_cycle'|'dossier'|'vod_ingest'

// zernioService
ensureProfile(tenantId) → { profileId }
getConnectUrl(tenantId, platform, redirectUrl) → { authUrl }
publish(connectionId, {text, mediaAssetPath, platforms}) → { postId }
// webhook entrante: POST /api/webhooks/zernio {type, externalId, data}

// face service (HTTP interno :8000)
POST /enroll {image} → {faceCount, embedding? : float[512]}
POST /detect {image} → {faces: [{bbox:[x,y,w,h], embedding: float[512]}]}
// match: SELECT person_id FROM face_embeddings
//   WHERE tenant_id=$1 ORDER BY embedding <=> $2 LIMIT 1  (cosine, umbral ~0.5)

// promptBuilderService — único punto de prompts de generación
build({tenantId, programId?, kind:'nota'|'copy'|'moments'|'titulo'|'edit',
       context:{segmentText, persons, program}}) → {system, user, profileVersion}
```

## Migration / Rollout

Orden de migraciones (ver `design/schema.md` para el DDL):

1. `0004` — `CREATE EXTENSION IF NOT EXISTS vector` (+ verificación pgvector en Neon; ver riesgo).
2. `0005` — T1: persons family, transmissions family, editorial_profiles(+versions), +`scheduled_jobs.program_id`, +`job_executions.transmission_id`, enum +`skipped_quota`.
3. `0006` — T2: user_tenants, tenant_quotas, quota_operations, billing_events, tenant_features, jobs_queue, ai_cost_records, admin_impersonations; +columnas plans/subscriptions/tenants/users.
4. `0007` — T3: assets, asset_persons, social_connections, publish_jobs, image_models, +`guest_dossiers.person_id`.
5. `0008` — Backfills: `user_tenants`←users; persons←conductors+guests (+photos, person_program, person_transmission con fecha); assets←clips+publications (source=synthetic/footage, mapa de estados); tenant_quotas semilla ←usage_records.
6. `0009` — `users.tenant_id` → nullable (deprecado); settings: sin migración de datos — las filas del system-tenant pasan a ser leídas SOLO vía `getGlobalSetting` (decisión: no adivinar el tenant real de datos fugados; audit en apply).

Feature flags: todo surface nuevo detrás de `tenant_features` (`live_video`, `face_attribution`, `zernio_publishing`, `auto_publish`, `image_models_multi`, `admin_console`). Rollback = flag off; el path de audio actual sigue intacto.

## Risks & Mitigations

| Riesgo | Mitigación |
|--------|------------|
| Webhook MP sin firma (supuesto #1) | `x-signature`+`x-request-id` si `MP_WEBHOOK_SECRET` set; SIEMPRE re-fetch `preApproval.get/payment.get` antes de mutar (nunca mutar por payload) |
| `timezone` no expuesta en API (supuesto #2) | POST/PUT jobs aceptan+validan IANA; scheduler evalúa en `job.timezone` |
| `users.tenantId` NOT NULL (supuesto #3) | Backfill user_tenants → columna nullable deprecada (D11) |
| pgvector en Neon (supuesto #4) | Verificar `CREATE EXTENSION vector` en S1; fallback: `person_embeddings.embedding` como `numeric[]`/jsonb + cosine en app (≈50 persons × 1fps — viable) o container pgvector |
| Spike Zernio gate S1 (supuesto #5) | Validar connect embebido + post video 9:16 IG/TikTok + media upload ANTES de construir publish_jobs; fallback = convivencia legacy sola; flag |
| Clips sintéticos coexisten (supuesto #6) | `assets.source=synthetic\|footage` distingue; bandeja única los muestra juntos |
| SKIP LOCKED sobre Neon serverless | Pool ya es `@neondatabase/serverless`; transacciones cortas por claim; verificar en staging |
| Doble scheduler si api escala | `PROCESS_ROLE` — solo engine corre loops; MAX_CONCURRENT en config |
| YT bloquea/expira HLS | Supervisor re-resuelve con yt-dlp -g; VPS propio (B-1); fallback VOD |
| InsightFace CPU lento | 1fps sobre segmento completado (offline-ish); degradación enrolled-off; flag |
| Purga con render pendiente | Purga verifica jobs_queue/render refs antes de borrar; segmentos marcados `purged` |
| Storage volumen finito | Retention por plan + purga diaria + alerta de uso de disco |

## Deployment (EasyPanel)

| Servicio | Rol | Puerto | Público | Volumen |
|----------|-----|--------|---------|---------|
| `api` | Express+Socket.IO (`PROCESS_ROLE=api`) | 3001 | api.* | `output/uploads` |
| `engine` | scheduler+workers+recorder+faces sampler (`PROCESS_ROLE=engine`) | 3100 interno | No | `/data/media` (crudos+assets) |
| `face` | InsightFace FastAPI | 8000 interno | No | modelos (imagen) |
| `frontend` | Nginx SPA | 80 | app.* | — |
| `postgres` | add-on (o Neon) | 5432 | No | — |
| `redis` | OPCIONAL — no se usa en MVP | 6379 | No | — |

Env vars nuevas: `PROCESS_ROLE`, `STORAGE_ROOT` (engine), `FACE_SERVICE_URL`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `ZERNIO_BASE_URL`, `MP_WEBHOOK_SECRET`, `ENGINE_INTERNAL_TOKEN`, `MAX_CONCURRENT_RECORDINGS`, `RECORDER_SEGMENT_SECONDS`, `MEDIA_BASE_URL`, `S3_*` (post-MVP). Actualizar `docs/DEPLOYMENT_EASYPANEL.md` (habla de Prisma — el ORM real es Drizzle, `npm run db:migrate`).

## Testing Strategy

Repo con **cero tests** — tests mínimos solo en paths nuevos críticos (Vitest):

| Layer | What | Approach |
|-------|------|----------|
| Unit | subscriptionMachine (aristas), quotaService (idempotencia/TZ/carrera), featureFlag precedencia, scheduler TZ check, editorial merge | Funciones puras + db de test |
| Integration | webhook Stripe raw-body firma, MP re-fetch, switch-tenant, invite accept, impersonación expiry | supertest + fixtures |
| E2E manual | piloto: transmisión programada dispara en TZ → crudo → ≥5 clips → approve → Zernio | checklist go-live (spec go-live-ops) |

## Open Questions

- [ ] pgvector disponible en el tier actual de Neon (verificar S1; fallback documentado).
- [ ] Zernio: confirmar endpoint de media upload binario y límites de tamaño para video (spike S1).
- [ ] `person_transmission` conserva `scheduledDate` de guests migrados (no hay transmission real aún) — columna nullable aceptada.
- [ ] maxDurationMinutes: stop suave = cortar captura + aviso + procesar lo grabado (definido así).
- [ ] Fotos: se mantiene `bytea` en DB (patrón actual conductors/guests) — sin mover a storage en v1.
