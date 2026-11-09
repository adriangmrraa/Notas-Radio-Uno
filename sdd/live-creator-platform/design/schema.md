# Schema — DDL Drizzle completo (live-creator-platform)

Convenciones del repo: `uuid` PK `defaultRandom()`, `tenantId` NOT NULL FK→tenants cascade en toda tabla de dominio, `timestamp(withTimezone:true)`, `jsonb` para payloads flexibles, status como `varchar` + union consts (salvo enums existentes). Índice por `tenantId` + el campo de filtro dominante en cada tabla.

Orden de migraciones: `0004_extensions` → `0005_core_t1` → `0006_saas_t2` → `0007_publish_t3` → `0008_backfill` (data) → `0009_users_tenant_nullable`.

## 0004 — Extensión

```sql
CREATE EXTENSION IF NOT EXISTS vector;  -- pgvector (Neon o imagen pgvector-enabled)
```

## 0005 — T1 core

### persons
| col | type | notes |
|-----|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants cascade NN | idx `persons_tenant_id_idx` |
| name | varchar(255) NN | |
| role | varchar(50) | 'conductor'\|'columnista'\|'invitado'\|'produccion' |
| bio | text | |
| socials | jsonb default {} | `{x,instagram,tiktok,youtube,linkedin}` handles |
| notes | text | contexto libre |
| enrollment_status | varchar(20) default 'none' | 'none'\|'partial'\|'ready' (derivado de embeddings válidos) |
| consent_at | timestamp tz | enrolamiento biométrico consentido |
| is_active | bool default true | soft-delete |
| created_at / updated_at | timestamp tz NN | |

### person_photos
| col | type | notes |
|-----|------|-------|
| id | uuid PK | |
| person_id | uuid FK→persons cascade NN | idx |
| photo_data | bytea NN | patrón existente (fotos chicas en DB) |
| mime_type | varchar(20) NN | |
| is_primary | bool default false | |
| enrollment_status | varchar(20) default 'pending' | 'pending'\|'enrolled'\|'no_face'\|'multi_face'\|'error' |
| rejection_reason | text | |
| created_at | timestamp tz NN | |

### face_embeddings  (spec: "person_embeddings")
| col | type | notes |
|-----|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK→tenants cascade NN | idx — NUNCA se matchea cross-tenant |
| person_id | uuid FK→persons cascade NN | |
| photo_id | uuid FK→person_photos cascade | |
| embedding | vector(512) NN | `vector` de drizzle-orm/pg-core; idx `USING hnsw (embedding vector_cosine_ops)` vía SQL en migración |
| model | varchar(50) default 'buffalo_l' | versión del extractor |
| created_at | timestamp tz NN | |

### person_program (M2M)
PK compuesta `(person_id, program_id)`; ambos FK cascade.

### person_transmission (invitado puntual)
| id uuid PK | person_id FK→persons cascade NN | transmission_id uuid FK→transmissions set null (NULL = aún no creada) | program_id uuid FK→programs set null | scheduled_date date (fecha del invitado cuando no hay transmission) | role varchar default 'guest' | created_at |
Índice `(tenant_id?)` no aplica (vía person). Unique parcial `(person_id, transmission_id)` donde transmission_id not null — enforced en service.

### transmissions
| col | type | notes |
|-----|------|-------|
| id | uuid PK | |
| tenant_id | uuid FK NN | idx `transmissions_tenant_status_idx` (tenant_id,status), `(tenant_id,created_at)` |
| program_id | uuid FK→programs set null | |
| scheduled_job_id | uuid FK→scheduled_jobs set null | |
| source | varchar(20) NN | 'live_capture'\|'vod_upload'\|'manual' |
| status | varchar(20) NN default 'scheduled' | scheduled\|waiting\|live\|processing\|done\|error\|canceled |
| stream_url | text | canal/URL programada |
| resolved_stream_url | text | HLS resuelta (yt-dlp -g) |
| crudo_ref | text | prefijo storage del crudo |
| duration_minutes | int | planeado (del job) |
| started_at | timestamp tz | ancla wall-clock |
| ended_at | timestamp tz | |
| waiting_since | timestamp tz | |
| last_heartbeat_at | timestamp tz | del recorder |
| error_message | text | |
| operation_id | varchar(120) | quota op que la reservó (release si falla) |
| created_at / updated_at | timestamp tz | |

### stream_recordings
| id uuid PK | transmission_id uuid FK→transmissions cascade NN UNIQUE (1 grabación/transmisión; reanudación = nuevos segmentos) | storage_prefix text NN | status varchar(20) 'recording'\|'completed'\|'error' | total_bytes bigint default 0 | started_at / ended_at |

### recording_segments
| id uuid PK | recording_id FK→stream_recordings cascade NN | sequence int NN | start_ms bigint NN | end_ms bigint (null = escribiendo) | file_ref text NN | bytes bigint | status varchar(20) default 'active' ('active'\|'corrupt'\|'purged') | created_at |
UNIQUE `(recording_id, sequence)`; idx `(recording_id, start_ms)` para lookup de ventana de clip.

### transmission_segments
| id uuid PK | transmission_id FK cascade NN | tenant_id FK NN | kind varchar(20) ('topic'\|'moment'\|'mark') | title/summary text | start_ms / end_ms bigint | speakers jsonb `[{label,personId?,name?,confidence}]` | score numeric (momentos) | payload jsonb | created_at |
idx `(transmission_id, start_ms)`, `(tenant_id, created_at)`.

### person_appearances
| id uuid PK | transmission_id FK cascade NN (idx) | tenant_id FK NN | person_id FK→persons set null (null = desconocido) | speaker_label varchar(10) | source varchar(10) 'face'\|'fusion'\|'manual' | start_ms / end_ms bigint NN | confidence numeric(4,3) | bbox jsonb `[x,y,w,h]` (último rostro conocido, p/ crop) | created_at |
idx `(tenant_id, person_id)` para "todo donde aparece Laura".

### editorial_profiles
| id uuid PK | tenant_id FK NN UNIQUE (1 por tenant) | tone varchar(30) | tone_examples jsonb `[]` | rules jsonb `{}` (léxico, prohibidas, encuadre) | rubro varchar(50) | audience text | active_formats jsonb `{}` | approval_policy varchar(10) default 'review' ('review'\|'auto') | default_image_model varchar(50) | version int default 1 | updated_by FK→users set null | created_at/updated_at |

### editorial_profile_versions (append-only)
| id uuid PK | profile_id FK cascade NN | version int NN | snapshot jsonb NN | updated_by FK | created_at | UNIQUE(profile_id,version) |

### Alteraciones T1
- `scheduled_jobs` + `program_id uuid FK→programs set null` (job ligado a programa hereda editorial/pipelineConfig).
- `job_executions` + `transmission_id uuid FK→transmissions set null`; enum `JobExecutionStatus` + `'skipped_quota'`.
- `programs` + `editorial_overrides jsonb default {}`.

## 0006 — T2 SaaS

### user_tenants
PK `(user_id, tenant_id)` | role userRoleEnum NN default 'viewer' | status varchar(20) default 'active' ('active'\|'suspended') | last_used_at timestamp tz | created_at | idx `(tenant_id)`.

### tenant_quotas
PK `(tenant_id, period)` donde `period varchar(7)` = 'YYYY-MM' en TZ del tenant | transmissions_count int default 0 | pipeline_hours numeric(10,2) default 0 | extra_transmissions int default 0 (créditos admin/add-ons del ciclo) | storage_mb numeric(10,2) default 0 | updated_at.

### quota_operations
| id uuid PK | operation_id varchar(120) NN UNIQUE (idx) | tenant_id FK NN | period varchar(7) | kind varchar(10) 'consume'\|'release'\|'grant' | metric varchar(30) default 'transmission' | delta numeric(10,2) | resulting_count numeric(10,2) | metadata jsonb | created_at | idx `(tenant_id, period)`.

### billing_events
| id uuid PK | tenant_id FK | subscription_id FK→subscriptions set null | type varchar(40) NN | provider varchar(20) | external_id varchar(255) UNIQUE (dedup webhooks) | payload jsonb | created_at | idx `(tenant_id, created_at)` | APPEND-ONLY (sin update/delete por convención + revocar permisos futuro).

### tenant_features
PK `(tenant_id, key)` | value jsonb NN (bool o config) | expires_at timestamp tz | set_by FK→users | created_at/updated_at.

### jobs_queue
| id uuid PK | type varchar(40) NN | payload jsonb NN | status varchar(10) default 'pending' ('pending'\|'running'\|'done'\|'failed'\|'dead') | attempts int default 0 | max_attempts int default 3 | run_at timestamp tz default now | locked_by varchar(60) | locked_at timestamp tz | last_error text | tenant_id FK set null | dedup_key varchar(120) UNIQUE (idempotencia de enqueue, p.ej. publish_job por asset+conexión) | created_at/updated_at |
idx `(status, run_at)` para claim `FOR UPDATE SKIP LOCKED`; `(tenant_id, status)` para panel.

### ai_cost_records
| id uuid PK | tenant_id FK NN | transmission_id FK set null | provider varchar(30) | kind varchar(30) ('video_analysis'\|'transcription'\|'image'\|'text'\|'face') | units numeric(14,4) | unit varchar(20) ('tokens'\|'minutes'\|'images'\|'frames') | cost_estimate_usd numeric(10,5) | created_at | idx `(tenant_id, created_at)`, `(transmission_id)`.

### admin_impersonations
| id uuid PK | admin_user_id FK→users NN | tenant_id FK NN | started_at NN default now | expires_at NN (now+30min) | ended_at | created_at | idx `(admin_user_id)`, `(tenant_id)`.

### Alteraciones T2
- `users` + `is_platform_admin bool default false`; `tenant_id` pasa NULLABLE en 0009 (tras backfill).
- `tenants` + `onboarding_completed bool default false`, `suspended_at timestamp tz`, `suspension_reason text` (`is_active` ya existe).
- `plans` + `max_transmissions_per_month int`, `max_duration_minutes int`, `max_clips_per_transmission int`, `max_persons int`, `retention_days int`. `features` jsonb pasa a leerse como capa "plan" de flags.
- `subscriptions` + `grace_ends_at timestamp tz`, `dunning_attempts int default 0`, `last_dunning_at`, `frozen_price numeric(10,2)`, `frozen_currency varchar(3)`, `cancel_reason text`, `provider_ref jsonb` (snapshot del alta).
- `refresh_tokens` — sin cambio (`tenant_id` ya existe = sesión activa).
- `team_invitations` — sin cambio estructural; enforcement de unicidad pending en service.
- `audit_log` — sin cambio estructural; convención `action` namespaced + `impersonatedBy` en metadata.

## 0007 — T3 publicación

### assets
| col | type | notes |
|-----|------|-------|
| id | uuid PK | |
| tenant_id | FK NN | idx `(tenant_id,status)`, `(tenant_id,type)`, `(transmission_id)` |
| type | varchar(15) NN | 'clip'\|'nota'\|'flyer'\|'quote_card'\|'post' |
| status | varchar(20) NN default 'generating' | generating→ready→pending_review→approved\|rejected→published\|failed |
| source | varchar(10) default 'footage' | 'footage'\|'synthetic' (legacy Remotion) |
| title / content | varchar(255)/text | |
| media_refs | jsonb `{}` | {videoPath,imagePath,thumbnailPath,audioPath,subtitlesPath} |
| transmission_id | FK→transmissions set null | |
| program_id | FK→programs set null | |
| source_window | jsonb | {startMs,endMs} ventana del crudo (clips) |
| quotes | jsonb | citas/personas citadas |
| content_variants | jsonb | variantes por red |
| edit_history | jsonb `[]` | append (last-write-wins visible) |
| profile_version | int | versión editorial aplicada |
| delivery_status | jsonb `{}` | {connectionId: 'published'\|'failed'...} rollup de publish_jobs |
| published_at | timestamp tz | |
| legacy_ref | jsonb | {table:'clips'\|'publications', id} trazabilidad migración |
| created_at / updated_at | | |

### asset_persons
PK `(asset_id, person_id, role)` | role varchar(10) 'speaker'\|'mentioned'\|'cited'.

### social_connections
| id uuid PK | tenant_id FK NN | provider varchar(15) 'zernio'\|'meta_legacy'\|'twitter_legacy'\|'webhook'\|'drive' | platform varchar(30) | external_account_id varchar(255) (zernioAccountId o legacy id) | portfolio_id FK→social_portfolios set null (legacy) | display_name varchar(255) | metadata jsonb | is_active bool default true | connected_at / disconnected_at | created_at |
UNIQUE `(tenant_id, provider, platform, external_account_id)`; enforcement `maxConnectedPlatforms` al conectar.

### publish_jobs
| id uuid PK | tenant_id FK NN | asset_id FK→assets cascade NN | social_connection_id FK→social_connections NN | payload jsonb {copy, variant, mediaRefs, mentions[]} | status varchar(10) default 'queued' ('queued'\|'sending'\|'published'\|'failed') | attempts int default 0 | external_post_id varchar(255) | last_error text | dedup_key varchar(160) UNIQUE (asset+connection) | published_at | created_at/updated_at | idx `(status)`, `(asset_id)`.

### image_models
| id uuid PK | key varchar(50) UNIQUE ('gemini-flash-image','gpt-image','ideogram','flux','recraft') | provider varchar(30) | display_name varchar(100) | capabilities jsonb (`['text','flyer','photoreal','vector']`) | cost_per_image numeric(10,5) | is_enabled bool | plan_gating jsonb (`['media','network']` o minPlan) | sort_order int | created_at |

### Alteraciones T3
- `guest_dossiers` + `person_id uuid FK→persons set null` (dossier enlazado a person tras migración).
- `clips` / `publications` → READ-ONLY tras backfill (deprecadas; drop en release posterior).
- `conductors`/`conductor_photos`/`guests`/`guest_photos` → READ-ONLY tras backfill.
- `usage_records` → READ-ONLY (histórico; el metering nuevo escribe en `tenant_quotas`).

## 0008 — Backfill (data migrations, scripts en `temp-migrations/`)

1. `user_tenants` ← `users`: cada user → membresía (su tenantId, su role, active).
2. `persons` ← `conductors` + `guests`: role preservado ('conductor'/'invitado'), `person_photos` ← fotos bytea, `person_program` ← programId, `person_transmission` ← (programId, scheduledDate) para guests futuros. `guest_dossiers.person_id` ← nuevo personId.
3. `assets` ← `clips` (type='clip', source='synthetic', media_refs←video/audio/subtitles, status map: generating→generating, pending_review→pending_review…) + `publications` (type='nota', source='synthetic', status directo). `legacy_ref` preserva el id origen.
4. `tenant_quotas` ← `usage_records` del período vigente (publications/hours como contadores históricos; transmissions arranca en 0 — no hay dato previo).
5. `social_connections` ← `business_assets` Meta (provider='meta_legacy', external_account_id=external_id) + flag `twitter_legacy` si hay credencial global activa.

## 0009 — Post-backfill

```sql
ALTER TABLE users ALTER COLUMN tenant_id DROP NOT NULL;
-- users.role / users.status quedan legacy; rol efectivo = user_tenants.role del tenant activo
```

## Diagrama de relaciones (nuevas)

    tenants ─┬─ user_tenants ─ users ─ admin_impersonations
             ├─ persons ─┬─ person_photos ─ face_embeddings
             │          ├─ person_program ─ programs
             │          └─ person_transmission ─ transmissions
             ├─ transmissions ─┬─ stream_recordings ─ recording_segments
             │                 ├─ transmission_segments
             │                 └─ person_appearances ─ persons
             ├─ editorial_profiles ─ editorial_profile_versions
             ├─ tenant_quotas ─ quota_operations
             ├─ subscriptions ─ billing_events (append-only)
             ├─ tenant_features
             ├─ assets ─┬─ asset_persons ─ persons
             │          └─ publish_jobs ─ social_connections
             ├─ social_connections (→ social_portfolios legacy)
             ├─ jobs_queue
             ├─ ai_cost_records
             └─ image_models (catálogo global, sin tenant)
