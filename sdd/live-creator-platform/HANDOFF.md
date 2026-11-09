# HANDOFF — live-creator-platform (PeriodistApp)

> Estado del cambio al 2026-11-09. Documento para retomar la implementación
> desde una terminal nueva con contexto limpio. Leer esto PRIMERO.

## 1. Qué es este cambio

Evolución de PeriodistApp a la plataforma de canales/creadores en vivo:
suscripción por cantidad de transmisiones, video crudo del stream → clips
reales 9:16, personas con rostros (InsightFace), línea editorial, publicación
vía Zernio, SaaS hardening benchmark Dentalogic.

- Visión de negocio + backlog Jira: `docs/PRODUCT-VISION.md`
- Propuesta: `sdd/live-creator-platform/proposal.md`
- Specs (21): `sdd/live-creator-platform/specs/<capacidad>/spec.md`
- Diseño (contrato técnico): `sdd/live-creator-platform/design.md`,
  `design/schema.md`, `design/flows.md`
- Tareas (62, DAG): `sdd/live-creator-platform/tasks.md` — el checklist `[x]`
  es la fuente de verdad del avance
- Memoria Engram: proyecto `notas-radio-uno`, topic_keys `sdd/live-creator-platform/*`
  (exploration 5855, proposal 5856, specs 5859, design 5865, tasks 5866,
  decisions 5857, apply-progress)

## 2. Estado: 4 de 6 work units commiteadas

Rama `gurnard`. **Nunca pushear, nunca mergear a main, nunca tocar producción.**

| WU | Tasks | Commit | Contenido |
|----|-------|--------|-----------|
| 1 | T-01…T-05 | `ee548cb` (+`7f685f8` docs) | fix webhooks Stripe(raw body)+MP(firma+refetch), settings con tenantId obligatorio + `getGlobalSetting`, prisma leftovers fuera, scheduler TZ + API acepta timezone/programId |
| 2 | T-06,T-08…T-19 | `a6cbce8`,`acc8404` | migraciones 0005-0009 (persons, transmissions, user_tenants, quotas, billing_events, jobs_queue, assets, social_connections, publish_jobs, image_models, backfills, users.tenant_id nullable) + jobsQueueService, quotaService, auditService, featureFlagService, aiCostMeter, mediaSigner |
| 3 | T-20…T-36 | `890912e`,`c4db548` | PROCESS_ROLE api\|engine + engine.ts, transmissionService (FSM+wall-clock), streamRecorderService (yt-dlp→ffmpeg -c copy segment), people module, editorialProfileService, promptBuilderService (choke-point), pipeline wall-clock + render_clip queue, scheduler quota pre-dispatch, rutas transmissions/live, VOD upload, face/ Python FastAPI + Dockerfile.face, faceService, frameSamplerService, attributionService (fusión speaker↔rostro), Remotion LiveClipOverlay alpha, clipCutterService (crop 9:16 + ASS subs + overlay), recordingPurgeService |
| 4 | T-37…T-44 | `8b62083` | JWT multi-tenant (activeTenantId + alias tenantId compat, re-verificación membresía por request, imp claims), requirePlatformAdmin, switch-tenant, invites /api/team, subscriptionMachine + billing_events dedup, billing→máquina + add-ons, dunningService, /api/admin completo + impersonación 30min, usageTracker→quotaService, plans seed 0011 + /billing/usage + maxDuration recorder |

**Pendiente**: WU5 = T-45…T-52 (assets unificados, Zernio, publish router,
webhook Zernio, review/auto-publish, image model registry, onboarding,
capa compat legacy) y WU6 = T-53…T-62 (cliente React completo + deploy
EasyPanel + go-live/piloto). Después: `sdd-verify` + `sdd-archive`.

## 3. Cómo retomar

Para cada work unit restante lanzar un subagente `sdd-apply` con:
ruta del repo, WU a implementar (tasks.md Fase correspondiente), contratos
(specs + design), lo que ya existe (leer firmas reales), gates y reglas de
entrega de §5. Plantilla usada hasta ahora: ver prompts WU3a/WU4 en Engram.

**WU5 (T-45…T-52)** — notas clave:
- T-46 Zernio depende de GATE-2 (T-07): **spike NO ejecutado** (sin credenciales
  ZERNIO_*). Si siguen sin estar → implementar detrás de flag `zernio_publishing`
  con fallback mediaSigner URL para media (D10 fallback documentado).
- `zernio_publishing` está OFF en todos los planes del seed 0011 — el rollout
  va por `tenant_features`/admin.
- T-52 resuelve las rutas legacy con errores baseline (ver §4).
- assets/publish_jobs ya tienen tenant_id y FSM definida en schema.

**WU6 (T-53…T-62)** — cliente React + ops:
- T-53 shell: switcher tenant + banner imp + useFeature + paywall (el backend
  ya devuelve `imp:true` y bloquea destructive server-side — falta la UI).
- T-61: mismo artefacto api/engine por `PROCESS_ROLE`; servicio `face` :8000
  interno; volumen `/data/media` solo en engine; env nuevas listadas en tasks.
- T-62 go-live: seeds, datos demo, health checks, runbook, piloto 1 canal.

## 4. Gates y baseline (CRÍTICO)

- **NO hay tests, lint ni CI**. Gates por unidad:
  `npx tsc -p tsconfig.server.json` → **0 errores NUEVOS en archivos tocados**
  (baseline ~84 errores PRE-EXISTENTES en routes/{guests,conductors,programs,
  public,publicPages,clips} + imageService — mismatch `@types/express@5`
  `req.params: string|string[]`; T-52 los resuelve vía capa compat) +
  `npm run build:client` verde.
- Workaround aplicado en archivos nuevos: `String(req.params.x)`.
- Drizzle: callback `db.transaction` a veces necesita anotación de tipo.

## 5. Reglas de entrega (delivery acordada con el usuario)

1. Una unidad por vuelta → gates → **UN commit conventional** en `gurnard`
   (feat:/fix:/docs:). Hasta 2 si docs aparte.
2. **SIN Co-Authored-By ni atribución de IA** en commits.
3. **NO push, NO merge a main, NO tocar producción.**
4. **Repo multi-agente**: otros agentes (Codex) commitean en paralelo —
   stagear SOLO archivos propios, nunca incluir cambios ajenos
   (hoy hay untracked ajenos: AUDIT-BRIEF.md, PERIODISTAPP-KANBAN.md,
   remotion/package-lock.json). Antes de cada WU: `git status`.
5. Suposición vs código → gana el código + documentar desvío.
6. Verificaciones con DB/stripe/MP/SMTP/streams reales → "pendiente manual
   staging", no bloquean el commit.
7. Marcar `[x]` en tasks.md e incluir en commit.

## 6. Decisiones y desvíos acumulados (para no re-decidir)

- **B-1**: YouTube garantizado desde T1 (VPS/proxies + upload fallback).
- **B-2**: multi-tenant por usuario desde v1 — IMPLEMENTADO (user_tenants).
- **GATE-1 falló** (sin DATABASE_URL real): embeddings = **jsonb**, cosine en
  app. Revisar `design/gate1-pgvector.md` al migrar a pgvector en staging.
- **JWT compat**: payload lleva `activeTenantId` + `tenantId` alias (los ~145
  `req.auth.tenantId` legacy no se migran; código nuevo usa activeTenantId
  `string|null` con null-check fail-closed).
- **`/billing/usage`** mantiene shape flat legacy + campos quota encima.
- **Clips sintéticos** (QuoteClip/NewsClip) coexisten: `assets.source='synthetic'`
  vs `'footage'` (reales). Legacy clips/publications → READ-ONLY tras T-52.
- Assets nuevos entran a bandeja como `pending_review` (no `ready`).
- render_clip payload: `{transmissionId, transmissionSegmentId, startMs,
  endMs, hookText}`; fileRefs relativos a `MEDIA_ROOT`.
- Face service: enrolled-only + `persons.consent_at` (nunca identificar sin
  consentimiento). Remotion: pin `@remotion/google-fonts` exacto + `safeFont()`.

## 7. Pendiente manual en staging (checklist al deployar)

- [ ] Correr migraciones 0004-0011 contra DB real + backfills 0008 +
      validar conteos (users=user_tenants, conductors+guests=persons)
- [ ] `CREATE EXTENSION vector` en Neon → decidir pgvector vs jsonb definitivo
- [ ] Env vars: `DATABASE_URL` real, `STRIPE_WEBHOOK_SECRET`,
      `MP_WEBHOOK_SECRET`, `SMTP_*`, `ZERNIO_*`, `FACE_SERVICE_URL`,
      `MEDIA_ROOT`, `API_INTERNAL_URL`+`INTERNAL_API_SECRET`, `ENGINE_PORT`,
      `MAX_CONCURRENT_RECORDINGS`, `ADDON_PLUS*_*`
- [ ] IMPORTANTE: aplicar `0011_plans_seed` ANTES del primer registro
      (register() busca plan `trial` por name)
- [ ] GATE-2 spike Zernio: connect embebido + upload video 9:16 IG/TikTok
- [ ] `docker build -f Dockerfile.face` + `/enroll` con foto real
- [ ] Stream de prueba end-to-end: segmentos MP4 + recording_segments ms +
      render_clip → asset published
- [ ] Webhooks reales Stripe/MP; retry cobro; emails SMTP
- [ ] Deuda fuera de scope (no tocada): credentials/businessAssets/
      publications/transcriptions/customAgents/pipelineConfigs con tenantId
      opcional → fallback silencioso a system tenant (misma clase que T-03,
      merece WU propia)

## 8. Gotchas del repo

- Alias `@`: tsconfig→`src/*` vs vite→`src/client` (init lo documentó).
- `*.py` en .gitignore → se agregó `!face/**/*.py`.
- `PROCESS_ROLE=api|engine|combined`: api sin loops; engine necesita
  `API_INTERNAL_URL`+`INTERNAL_API_SECRET` para relay socket → api.
- La migración `0010` agregó `transmissions.pipeline_config` (fuera del orden
  original 0004-0009 del design — numeración real manda).
- Remotion sub-package usa React 18 (distinto del client React 19).
