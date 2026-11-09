# Proposal: live-creator-platform — PeriodistApp, plataforma de canales en vivo

## Resumen ejecutivo

PeriodistApp hoy procesa **solo audio** de streams y produce contenido derivado con revisión humana. Este cambio la convierte en la plataforma completa de la visión: graba el **crudo de video** en vivo, identifica **personas por rostro+voz**, genera **clips reales 9:16** del stream (no sintéticos), aplica **línea editorial** del canal y **publica vía Zernio**. En paralelo endurece la capa SaaS al nivel Dentalogic (super-admin, invitaciones, cuota por transmisiones TZ-aware e idempotente, máquina de estados de suscripción, feature flags, billing_events, audit) y corrige 3 bugs activos (webhook Stripe, timezone del scheduler, fuga de tenant en settings). Se organiza en 3 tandas: T1 core diferencial → T2 SaaS hardening → T3 publicación y experiencia.

## Problema / oportunidad y alineación con la visión

El cuello de botella del cliente es operativo: del vivo al contenido publicado hay horas de trabajo humano (editor, diseñador, redactor, CM). Las herramientas actuales resuelven partes aisladas; ninguna entrega la fábrica completa con contexto editorial (quién habla, cómo se ve, qué dice la línea del canal).

El gap medido contra PRODUCT-VISION.md: **sin video** (solo audio), **sin rostros** (fotos solo como referencia de generación), scheduler existente pero con bug de TZ y sin chequeo de cuota, billing sin enforcement (`checkUsageLimits` nunca se llama), sin super-admin, `teamInvitations` huérfana, sin Zernio. Este cambio cierra exactamente ese gap: monetización por transmisiones, módulos de la navegación objetivo, checklist de go-live de early adopters.

## Alcance

### IN — organizado en 3 tandas

**T1 — Core diferencial (épicas PC, PD, PE, PF-01…PF-05, PH-04 parcial)**
- Captura de video en vivo: yt-dlp resuelve URL → `ffmpeg -c copy -f segment` → MP4 segmentados a storage; timeline anclado a wall-clock de la ejecución.
- `transmissions` + `stream_recordings`/`recording_segments` con `crudo_ref`, estados scheduled→waiting→live→processing→done/error + eventos Socket.IO.
- Clip-cutter real: `ffmpeg -ss/-t` sobre el crudo + crop 9:16 + subtítulos + overlay Remotion (logo, lower-third con nombre de persona).
- Módulo **Personas**: unificar conductors+guests → `persons` (fotos múltiples, rol, bio, redes, notas) + `face_embeddings` (pgvector) + pipeline InsightFace (SCRFD+ArcFace self-hosted) → `person_appearances`; cruce speaker↔cara por wall-clock → atribución de nombre con corrección manual.
- `editorial_profiles` por tenant con override por programa (tono, reglas jsonb, rubro, formatos activos, política de aprobación) inyectado en UN choke-point de prompts.
- Sala "En vivo" v1: timeline con speakers resueltos, momentos, clips generándose, mark manual.
- FIX scheduler timezone (comparar en `job.timezone`, no TZ del server).
- Retención del crudo por plan + job de purga. Fallback upload de VOD post-stream.

**T2 — SaaS hardening estilo Dentalogic (épicas PA, PB, PI-01…PI-03)**
- Super-admin: flag `is_platform_admin`, guard, `/api/admin/*` + consola `/admin` (tenants, uso, costo IA, impersonación auditada 30 min, acciones plan/trial/+transmisiones/suspender).
- Invites reales sobre `teamInvitations` (tabla existe, cero rutas): invite→email-token→accept crea cuenta; módulo Equipo.
- **Cuota Dentalogic-style**: `tenant_quotas` período YYYY-MM en timezone del tenant + `quota_operations` con `operation_id` idempotente; `transmissions_count` como métrica primaria + `maxDurationMinutes` anti-abuso; enforcement real de `checkUsageLimits` ANTES de disparar pipeline/jobs.
- Máquina de estados de suscripción (trial→active→payment_failed→past_due/grace→canceled, aristas validadas) + `billing_events` append-only + dunning + trial-eligibility (7d/2 transmisiones).
- `tenant_features` feature flags (override tenant > plan > default) + hook `useFeature`.
- Audit log de acciones sensibles + middleware de roles aplicado a todas las rutas.
- **FIX webhook Stripe**: raw body antes de `express.json()` → firma válida.
- **FIX tenant leak en `setSetting`**: `tenantId` obligatorio.
- Cola de jobs en Postgres (reintentos + dead-letter) + logging estructurado request-id + métricas de costo IA por tenant.

**T3 — Publicación y experiencia (épicas PF-06…PF-10, PG, PC-10, PH, PI-04…PI-07)**
- `zernioService` en **convivencia** con `publishService`: Zernio default para plataformas nuevas (16 redes: TikTok/IG/YouTube/LinkedIn/Threads/Bluesky), Meta directo se mantiene para portfolios/businessAssets existentes; connect embebido white-label (`welcome=true` + welcome-screen) con `externalId=tenantId`.
- `social_connections` + `publish_jobs` (aprobar→encolar→Zernio→estados+reintento) + menciones con handles de `persons.socials`.
- Imágenes multi-modelo: `image_models` registry (Gemini, GPT Image, Ideogram, FLUX, Recraft) + default por tenant + gating por plan.
- Onboarding wizard 4 pasos (canal→programa→personas→Zernio) con `onboarding_completed`.
- `assets` unificado (clip/nota/flyer/post) con estados editoriales — refactor de `clips`/`publications`.
- Bandeja unificada sobre assets + edición por IA + auto-publicación por tenant/plan.
- UX: dashboard "Ahora", navegación por módulos, estados vacíos/loading/error, landing, responsive tablet.
- Robustez: reanudación de crudo ante cortes, backup/purga, checklist go-live, piloto 1 canal real.

### OUT (post-v1, explícito)
- Voice-prints dedicados (v2 — rostro+diarización primero).
- BYOK Enterprise (patrón validado, queda detrás de flag).
- Multi-marca: un user en varios tenants (salvo decisión contraria — ver preguntas).
- Analytics de engagement del contenido publicado, app mobile, editor de video avanzado, API pública, señal de chat en vivo.
- Managed video (Livepeer/Mux) — no aplica a captura de streams de terceros.
- RLS en Neon (enforcement app-level documentado).

## Decisiones clave (con alternativa descartada)

| # | Decisión | Alternativa descartada y por qué |
|---|----------|----------------------------------|
| D-1 | **ffmpeg `-c copy -f segment`** self-hosted sobre resolución yt-dlp única; clips = cut+crop+Remotion sobre footage real; fallback descarga de VOD | Livepeer/Mux/CF Stream: diseñados para RTMP push del stream PROPIO, no capturan streams de terceros; costo/min vendor. VOD-only como primario: mata real-time |
| D-2 | **Gemini 3.x** análisis visual sampled por segmentos + **AssemblyAI** diarización como timeline primario | Gemini Live API (conversacional, ≤1FPS, no motor de análisis); reemplazar AssemblyAI (Gemini no diariza); análisis full-video sincrónico (costo/latencia) |
| D-3 | **InsightFace self-hosted** (SCRFD+ArcFace, o Python microservice) + embeddings en **pgvector** (Neon) → enrolled-only + consentimiento | VLM directo "quién es" (costo/frame, identidad no determinística, sin bbox, caras salen de infra — queda como fallback de desconocidos); AWS Rekognition (streaming ya no disponible a nuevos clientes, egress US) |
| D-4 | **Zernio en convivencia**: default para plataformas nuevas; Meta directo legacy para portfolios existentes | Reemplazo total: rompe socialPortfolios/businessAssets funcionando y migra riesgo innecesario; quedarse solo con directo: mantiene OAuth propio por plataforma y credenciales env-globales de Twitter |
| D-5 | **Cuota Dentalogic-style**: `tenant_quotas` período YYYY-MM en TZ del tenant + `operation_id` idempotente; transmisión activa NUNCA se corta | `usage_records` actual: sin idempotencia en retries de webhooks/jobs, sin TZ del tenant (doble-descuento posible); gating por features en vez de por uso |
| D-6 | Cola de jobs en **tabla Postgres** para MVP | BullMQ+Redis desde el día 1: infra extra prematura; se extrae a workers cuando >10-20 streams simultáneos |
| D-7 | Stack actual se mantiene (Express+TS, React SPA, Drizzle, Remotion) | Reescritura a Next/Supabase estilo Dentalogic: descartado — se portan patrones, no código |

## Capabilities (contrato con sdd-spec)

### New
- `video-ingest-recording`: captura/segmentación/retención del crudo + fallback VOD
- `real-clips`: clip-cutter del crudo + crop 9:16 + subtítulos + branding
- `people-faces`: biblioteca persons + embeddings + person_appearances + atribución
- `editorial-profiles`: línea editorial tenant/programa + inyección en prompts
- `live-room`: sala en vivo con timeline, momentos, mark manual
- `platform-admin`: super-admin, impersonación, métricas plataforma
- `team-invites`: invitación email-token-aceptación
- `usage-quota`: tenant_quotas TZ + idempotente + enforcement
- `subscription-lifecycle`: máquina de estados + billing_events + dunning
- `feature-flags`: tenant_features con precedencia
- `zernio-publishing`: connect embebido + social_connections + publish_jobs
- `image-model-registry`: multi-modelo de imágenes por tenant/plan
- `onboarding-wizard`: alta guiada de canal
- `unified-assets`: modelo assets + bandeja unificada

### Modified
- `scheduling`: fix TZ + chequeo de cuota pre-dispatch + vínculo a transmissions
- `billing`: fix webhook Stripe + checkout/cambio de plan/add-ons
- `settings`: tenantId obligatorio en setSetting
- `auth`: rol super_admin + middleware de roles en todas las rutas

## Impacto en datos (Drizzle)

**Tablas nuevas**: `persons`, `person_photos`, `face_embeddings` (pgvector), `person_appearances`, `transmissions`, `transmission_segments`, `stream_recordings`, `recording_segments`, `editorial_profiles`, `assets`, `social_connections`, `publish_jobs`, `tenant_quotas`, `quota_operations`, `billing_events`, `tenant_features`, `admin_users` (o flag en users), `audit_logs`, `image_models`, `jobs_queue`.
**Modificadas**: `plans` (maxTransmissionsPerMonth, maxDurationMinutes, maxClips, maxPersons, retentionDays), `subscriptions` (campos de máquina de estados), `scheduledJobs`→vínculo transmission/program + TZ fix, `conductors`/`guests`→migración a `persons`, `clips`/`publications`→`assets`, `settings` (tenantId requerido), `users` (is_platform_admin).

## Impacto en servicios/rutas (`src/server/`)

**Nuevos**: `streamRecorderService`, `clipCutterService`, `faceService` (InsightFace), `analysisProviderRegistry`, `quotaService`, `subscriptionMachine`, `featureFlagService`, `billingEventsService`, `adminService`, `platformMetricsService`, `inviteService`, `zernioService`, `onboardingService`, jobs worker.
**Modificados**: `jobSchedulerService` (TZ, quota check, transmission lifecycle), `pipelineService` (metering + video path), `publishService` (routing convivencia), `imageService` (registry), `authService` (roles), `transcriptionService`, `usageTracker`.
**Rutas nuevas**: `/api/admin/*`, `/api/people`, `/api/transmissions`, `/api/live`, `/api/team`, `/api/onboarding`, `/api/connections/zernio`, `/api/assets`. **Modificadas**: `jobs`, `billing` (raw body), `settings`, `review`, `clips`, `connections`.

## Riesgos y mitigación

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| R-1 YouTube bloquea IPs de datacenter (audio ya lo sufre; video sube el riesgo) | Alta | Posicionar producto sobre streams PROPIOS del tenant (HLS/RTMP directo) + YT best-effort; VPS propio/proxies; fallback upload de VOD habilita early adopters igual |
| R-2 Costo del modelo multimodal en transmisiones largas | Media | Análisis sampled (no frame-by-frame), metering de costo por transmisión (PI-03), maxDurationMinutes por plan, capa de proveedores permite bajar a Flash |
| R-3 Biometría: rostros = dato sensible + atribución errónea con pocas fotos | Media | Enrolled-only (solo personas que el tenant registra), consentimiento en UX, retención acotada, 3+ fotos en onboarding, corrección manual realimenta sesión |
| R-4 Zernio cobra por cuenta conectada + alcance real de su API | Media | Passthrough vía `maxConnectedPlatforms` del plan; **spike en S1**: validar connect embebido + post de video 9:16 en IG/TikTok antes de construir encima |
| R-5 Escala: scheduler+ffmpeg in-process cap ~5 concurrent | Media | Cola Postgres MVP; extracción a workers antes de 10-20 streams; MAX_CONCURRENT ya parametrizado |
| Webhook Stripe roto en prod (raw body) | Alta | FIX en T2 temprano; verificar con `stripe listen` en staging |
| Cero tests en el repo | Cierta | Tests mínimos en paths nuevos críticos (quota, state machine, webhook); no bloquear por cobertura legacy |
| Retención de crudos = costo storage | Media | Retención por plan + purga automática; filesystem MVP → S3/R2 si escala |

## Criterios de aceptación del cambio completo

- [ ] Un canal se registra, completa onboarding y programa una transmisión sin ayuda
- [ ] La transmisión programada arranca sola (en su timezone), graba crudo de video y produce ≥5 clips reales 9:16
- [ ] Speakers resueltos a nombre real con ≥90% de atribución en piloto (rostro+diarización+corrección)
- [ ] Clip aprobado se publica en IG/TikTok del canal vía Zernio sin que PeriodistApp vea credenciales
- [ ] Cuota por transmisiones descuenta 1 vez (idempotente en retries), en el período TZ del tenant; transmisión activa nunca se corta; paywall funciona
- [ ] Pago real MercadoPago activa plan; webhook Stripe verifica firma con raw body
- [ ] Super-admin: lista tenants, ve uso, impersona auditado, ajusta flags/cuota
- [ ] Jobs programados disparan en `job.timezone` (fix verificado); `setSetting` siempre con tenantId
- [ ] Transmisión caída se reanuda sin perder crudo grabado
- [ ] `tsc` + `vite build` verdes; cero queries nuevas sin `tenant_id`

## Mapeo a épicas (trazabilidad Jira)

| Tanda | Épicas PRODUCT-VISION |
|-------|------------------------|
| T1 | PC-01…PC-06 (personas+rostros+editorial), PC-07…PC-09 (transmissions/agenda), PD-01…PD-07 (ingesta+scheduler+sala), PE-01…PE-07 (motor análisis+identidad), PF-01…PF-05 (clips del crudo) |
| T2 | PA-01…PA-12 (fundación+super-admin), PB-01…PB-09 (billing por transmisiones), PI-01…PI-03 (cola jobs, logging, costos IA) |
| T3 | PC-10 (onboarding), PF-06…PF-10 (assets+multi-modelo+variantes), PG-01…PG-07 (bandeja+Zernio), PH-01…PH-07 (UX), PI-04…PI-07 (robustez+go-live+piloto) |

## Rollback plan

- Todo surface nuevo detrás de `tenant_features`: desactivar flag → comportamiento anterior.
- Video path es **aditivo**: pipeline de audio actual sigue funcionando si falla ingesta de video.
- Convivencia Zernio: publishService legacy queda intacto; desactivar Zernio = volver a Meta/Twitter directo.
- Migraciones Drizzle reversibles; tablas nuevas no alteran flujo existente salvo enforcement (flaggeable).
- Fixes (Stripe TZ/settings) son correcciones aisladas con diff mínimo.

## Dependencias

- Cuenta Zernio + docs verificados (API keys, pricing por cuenta).
- InsightFace self-hosted: VPS/container con CPU (GPU opcional).
- pgvector habilitado en Neon.
- Decisiones B-1/B-2 (abajo) antes de iniciar T1.

## Preguntas abiertas

**Bloqueantes (requieren decisión del usuario):**
- **B-1 — Ingesta YouTube en producción**: ¿aceptamos el posicionamiento "streams propios del tenant (HLS/RTMP/upload) + YouTube best-effort" para early adopters, o invertimos en VPS/proxies dedicados desde T1? Define infra y mensaje comercial.
- **B-2 — Multi-tenant por usuario**: ¿un user puede pertenecer a varios tenants desde ya (multi-marca Network) o se confirma post-v1? Cambia el modelo de auth/switch.

**Asumibles (default propuesto, confirmar en design):**
- A-1 Storage de crudos: filesystem en VPS para MVP → S3/R2 cuando entre plan Network. (D-2 visión)
- A-2 Modelo de análisis: Gemini Flash para sampling en vivo, Pro para post-stream; ajustable por provider registry. (D-1 visión)
- A-3 InsightFace: container en el mismo VPS de ingesta; separar si crece carga.
- A-4 Zernio: costo por cuenta absorbido vía límite `maxConnectedPlatforms` del plan (sin passthrough de precio en v1).
- A-5 BYOK Enterprise: diferido post-launch (flag ya previsto).
