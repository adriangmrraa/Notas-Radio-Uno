# Estado del Kanban — PeriodistApp (para auditoría)

Generado para que Codex audite consistencia kanban ↔ SDD. Las tarjetas son tarjetas madre con checklist de tickets (PA-01…PI-07) encadenadas A→I.

## t_bd7d81d3 — PeriodistApp — ÉPICA A: Fundación SaaS y Super Admin  [status=running, prio=10]

**Objetivo**: la plataforma es administrable, segura y vendible (benchmark Dentalogic).

**Repo**: `periodistapp` — C:/Users/Asus/Documents/estabilizacion/periodistapp (stack Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Cómo se ejecuta**: tomá el próximo `- [ ]`, implementalo delegando a Orca (skill `orca-delegate`) o inline con tus tools si el runtime de Orca está caído (avisá). Verificá EN DISCO: migración Drizzle real, `npx tsc --noEmit` EXIT 0 + `npm run build` verde, tests si los hay. Marcá `[x]` con SHA + evidencia. Commit conventional con paths explícitos, sin atribución de IA. `tenant_id` en toda query. NO merge a main ni deploy sin autorización.

**Checklist**:
- [ ] PA-01 Schema Drizzle: `team_invites`, `admin_users`, `audit_logs`, `tenant_features` [3] — AC: migraciones generadas; `tenant_features` con default por plan.
- [ ] PA-02 Invitaciones de equipo: endpoints invite/accept/revoke + email con token [3] — AC: invitar editor → link → crea cuenta activa en el tenant.
- [ ] PA-03 Módulo Equipo (UI): lista de usuarios, cambiar rol, reenviar/revocar invitación [3]
- [ ] PA-04 Middleware de autorización por rol (owner>editor>viewer) en todas las rutas [3] — AC: viewer no puede mutar (403 en rutas clave).
- [ ] PA-05 Audit log: acciones sensibles (login, publish, admin, billing) [2]
- [ ] PA-06 Super admin: flag `is_platform_admin` + guard + layout `/admin` [3]
- [ ] PA-07 Super admin: lista tenants (plan, uso, estado, creado) + búsqueda [3]
- [ ] PA-08 Super admin: detalle tenant (usuarios, uso, actividad, costo IA estimado) [5]
- [ ] PA-09 Super admin: acciones — cambiar plan, extender trial, +transmisiones, suspender [3]
- [ ] PA-10 Super admin: impersonación auditada (banner "viendo como", expira 30 min) [3]
- [ ] PA-11 Feature flags: `tenant_features` + override desde admin + hook cliente `useFeature` [2]
- [ ] PA-12 Hardening: rate limit auth+API, headers seguridad, CORS estricto, audit credenciales cifradas [3]

> **COMENTARIO**: **DECISIONES SDD (proposal.md de Devin — aplicar):**
- D-7: mantener stack actual (Express+TS / React SPA / Drizzle / Remotion). NO reescribir a Next/Supabase.
- D-6: cola de jobs en **tabla Postgres** (no BullMQ/Redis en MVP).
- Rol super_admin en `users.is_platform_admin` (o `admin_users`).
- **FIX** incluido en esta tanda: `setSetting` debe exigir `tenantId` (hoy hay fuga de tenant — escribe settings sin tenant_id).
- Middleware de roles aplicado a TODAS las rutas (owner>editor>viewer + is_platform_admin).
> **COMENTARIO**: **DECISIÓN B-2 RESUELTA (Adrián): multi-tenant por usuario desde v1.** Una cuenta conecta muchos canales (tenants), gated por plan: `marcas por cuenta` Creator/Media=1, Network=3, Enterprise=∞. Auth = `users`↔`tenants` N-M + tenant activo por sesión + switch de tenant en UI. PA-04/PA-06 y el schema de auth deben contemplarlo desde el inicio (no post-v1).
> **COMENTARIO**: GUARDIAN (00:05): el delegado Devin de `gurnard` había cerrado su turno preguntando "¿arrancamos apply o revisás artefactos?". Respondido por Orca (`terminal send`, prompt enviado y confirmado con el TUI en `Thinking`, no en draft): **apply aprobado, delivery chained PRs (6 work units)**, una unidad por vuelta con sus gates y commit convencional en la rama `gurnard`, sin push ni merge. Decisiones ya fijas (D-7, D-6, is_platform_admin, YouTube T1, multi-tenant por usuario) se respetan; el fix `setSetting(tenantId)` entra en esta tanda.

Próximo paso: cuando Devin termine una unidad, verificar en disco (`git -C C:/Users/Asus/orca/workspaces/periodistapp/gurnard log/status`) y marcar el ítem. No re-lanzar otro agente sobre este worktree.

## t_26b1e2b6 — PeriodistApp — ÉPICA B: Billing por transmisiones  [status=todo, prio=9]

**Objetivo**: el modelo de negocio (suscripción por transmisiones) funciona end-to-end.

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (migración real, `npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. `tenant_id` en toda query. NO merge/deploy sin autorización.

**Checklist**:
- [ ] PB-01 Schema: `usage_cycles` (transmisiones/ciclo) + campos de plan (transmisiones, duración máx, clips, personas, retención crudo) [3]
- [ ] PB-02 Metering: consumir 1 transmisión al iniciar pipeline; liberar si falla antes de N min [3] — AC: una transmisión activa NUNCA se corta por cuota.
- [ ] PB-03 Plans seed (Creator/Media/Network/Enterprise) + admin de planes [2]
- [ ] PB-04 Checkout MercadoPago + Stripe: alta, cambio de plan con prorrateo, cancelación [5]
- [ ] PB-05 Add-on transmisiones (+5/+15, expiran con ciclo) [3]
- [ ] PB-06 Paywall UX: bloqueo suave + modal upgrade/add-on + banners de uso (>80%) [3]
- [ ] PB-07 Ciclo de vida suscripción: trial 7d/2 transmisiones → activa → past_due (dunning 3 intentos + emails) → suspendida [5]
- [ ] PB-08 Página Facturación: plan, medidor de uso, historial, compra add-ons [3]
- [ ] PB-09 Emails transaccionales: trial por vencer, pago ok/fallido, suspensión [2]

> **COMENTARIO**: **DECISIONES SDD (aplicar):**
- D-5: cuota estilo Dentalogic = `tenant_quotas` (período YYYY-MM en TZ del tenant) + `quota_operations` con `operation_id` idempotente. `transmissions_count` como métrica primaria + `maxDurationMinutes` anti-abuso.
- Enforcement real de `checkUsageLimits` ANTES de disparar pipeline/jobs (hoy nunca se llama).
- Máquina de estados suscripción: trial→active→payment_failed→past_due/grace→canceled + `billing_events` append-only + dunning + trial-eligibility (7d/2 transmisiones).
- **FIX**: webhook Stripe debe leer el **raw body ANTES de `express.json()`** (hoy la firma está rota en prod). Verificar con `stripe listen`.
- Transmisión activa NUNCA se corta por cuota.

## t_5f47871c — PeriodistApp — ÉPICA C: Contexto del canal (Personas + Editorial + Agenda)  [status=todo, prio=8]

**Objetivo**: el cliente alimenta el sistema con contexto (personas/rostros/editorial/agenda) y el sistema "sabe quién es quién".

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (migración real, `npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. `tenant_id` en toda query. NO merge/deploy sin autorización.

**Checklist**:
- [ ] PC-01 Schema: `people` (fotos, embedding_ref, rol, redes JSON, notas), `person_program`, `editorial_profiles` [3]
- [ ] PC-02 Migración conductores→people (conductores actuales pasan a la biblioteca) [2]
- [ ] PC-03 Módulo Personas (UI): CRUD con multi-foto, redes, notas, programas asociados [5]
- [ ] PC-04 Pipeline de rostros: subir foto → detectar cara → embedding → guardar [5] — AC: foto sin cara rechazada con mensaje claro.
- [ ] PC-05 Línea editorial (UI): tono, reglas, ejemplos, rubro, formatos activos — tenant + override por programa [3]
- [ ] PC-06 Línea editorial en prompts: inyectar perfil en generación de notas/copies/momentos [3]
- [ ] PC-07 Schema transmisiones: `transmissions` + `scheduled_transmissions` (recurrencia RRULE) + vínculo a programa [3]
- [ ] PC-08 Agenda (UI): crear/editar transmisión programada (fecha o semanal), auto-start, calendario [5]
- [ ] PC-09 Dossier de invitados vinculado a transmisión programada (mejora del existente) [2]
- [ ] PC-10 Onboarding wizard 4 pasos (canal→programa→personas→Zernio) con estado `onboarding_completed` [5]

> **COMENTARIO**: **DECISIONES SDD (aplicar):**
- D-3: rostros = **InsightFace self-hosted (SCRFD+ArcFace)** + embeddings en **pgvector** (Neon). Enrolled-only (solo personas que el tenant registra) + consentimiento. Foto sin cara rechazada con mensaje claro.
- Tablas: `people`→`persons` + `person_photos` + `face_embeddings` (pgvector) + `person_appearances` (cruce speaker↔cara por wall-clock).
- Conductors+guests se unifican en `persons`.
- Depende de la decisión B-2 (multi-tenant) para el modelo de auth.

## t_69132867 — PeriodistApp — ÉPICA D: Ingesta de video en vivo y Scheduling  [status=todo, prio=7]

**Objetivo**: del stream en vivo al crudo grabado, automático (video, no solo audio).

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (migración real, `npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. `tenant_id` en toda query. NO merge/deploy sin autorización.

**Checklist**:
- [ ] PD-01 Captura de video: extender captura yt-dlp/ffmpeg de audio-only a HLS video+audio [5]
- [ ] PD-02 Grabación segmentada del crudo a storage (S3/filesystem) con `crudo_ref` en `transmissions` [5]
- [ ] PD-03 Scheduler: worker que dispara transmisiones programadas (ventana de espera, reintentos) [5] — AC: stream que arranca 10 min tarde se captura igual.
- [ ] PD-04 Estados de transmisión + eventos Socket.IO (scheduled→waiting→live→processing→done/error) [3]
- [ ] PD-05 Sala "En vivo" (UI): timeline transcripción con personas resueltas, momentos, clips generándose, mark manual [8]
- [ ] PD-06 Retención del crudo por plan + job de purga [2]
- [ ] PD-07 Soporte de fuentes: YouTube Live, Twitch, Kick, HLS genérico, upload de video (fallback) [5] — Nota: YouTube en datacenter bloqueado (R-1); el upload habilita early adopters.

> **COMENTARIO**: **DECISIONES SDD (aplicar):**
- D-1: ingesta = yt-dlp resuelve URL + `ffmpeg -c copy -f segment` → MP4 segmentados a storage (self-hosted). NO Livepeer/Mux/CF Stream.
- Timeline anclado a wall-clock de la ejecución. `transmissions` + `stream_recordings`/`recording_segments` con `crudo_ref`.
- **FIX** incluido: scheduler compara en `job.timezone`, no en TZ del server (hoy roto).
- R-1: YouTube bloquea IPs de datacenter → posicionar sobre streams propios (HLS/RTMP/upload) + YT best-effort. Ver decisión B-1.
> **COMENTARIO**: **DECISIÓN B-1 RESUELTA (Adrián): YouTube FULL desde v1.** PD-01/PD-02/PD-07 requieren ingesta completa de YouTube Live desde el día 1 → VPS propio + rotación de proxies para evitar el bloqueo de IPs de datacenter (R-1). NO "best-effort": es requisito de v1. Ajustar infra de ingesta en consecuencia.

## t_d2f3cad5 — PeriodistApp — ÉPICA E: Motor de análisis en vivo  [status=todo, prio=6]

**Objetivo**: el "mejor modelo del mercado" mirando el vivo (transcripción + identidad + momentos).

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (migración real, `npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. `tenant_id` en toda query. NO merge/deploy sin autorización.

**Checklist**:
- [ ] PE-01 Capa de proveedores de análisis (interface + config por proceso: análisis/transcripción/imagen) [3]
- [ ] PE-02 Integración del modelo multimodal top (video+transcripción → momentos, temas, citas) [8]
- [ ] PE-03 Identidad de personas: diarización → matching rostro en frames contra embeddings de `people` [8] — AC: speaker label resuelto a persona con confianza; corrección manual persiste.
- [ ] PE-04 Detección de momentos clipables en tiempo real (score + razón + ventana sugerida) [5]
- [ ] PE-05 Detección de citas atribuidas a persona (nombre+foto) [3]
- [ ] PE-06 Segmentos: `transmission_segments` (tema, resumen, speakers, ventana temporal) [3]
- [ ] PE-07 Alertas en vivo: reutilizar servicio actual sobre la transcripción nueva [2]

> **COMENTARIO**: **DECISIONES SDD (aplicar):**
- D-2: análisis visual = **Gemini 3.x sampled por segmentos** + **AssemblyAI diarización** como timeline primario. NO Gemini Live API (≤1FPS conversacional, no motor de análisis). NO reemplazar AssemblyAI (Gemini no diariza).
- Identidad = diarización → matching de rostro en frames contra embeddings de `persons` → persona con confianza + corrección manual.
- `analysisProviderRegistry` (PE-01) permite cambiar de modelo sin reescribir.

## t_682756fa — PeriodistApp — ÉPICA F: Fábrica de contenido desde el crudo  [status=todo, prio=5]

**Objetivo**: clips del video crudo real + notas + flyers + variantes, todo desde el vivo.

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (migración real, `npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. `tenant_id` en toda query. NO merge/deploy sin autorización.

**Checklist**:
- [ ] PF-01 Clip-cutter: cortar ventana del crudo con ffmpeg (precisión de frames, sin re-encode completo) [5]
- [ ] PF-02 Re-encuadre 9:16 inteligente: crop centrado en rostro activo (o layout split si 2 personas) [8]
- [ ] PF-03 Subtítulos quemados con estilo del tenant + progreso; branding (logo, lower-third con nombre de persona) [5]
- [ ] PF-04 Cola de render de clips (jobs) + estados por clip + reintento [3]
- [ ] PF-05 Re-corte manual: selector inicio/fin sobre segmento → re-render [3]
- [ ] PF-06 Notas por rubro con citas atribuidas (plantillas por rubro editorial) [3]
- [ ] PF-07 Flyers/quote-cards con foto real de la persona detectada [3]
- [ ] PF-08 Imágenes multi-modelo: provider seleccionable por tenant + fallback [3]
- [ ] PF-09 Variantes por red: copy+hashtags+menciones con handles de `people.social` [3]
- [ ] PF-10 Modelo `assets` unificado (clip/nota/flyer/post) con estados editoriales — refactor de `clips`/`publications` actuales [5]

> **COMENTARIO**: **DECISIONES SDD (aplicar):**
- D-1: clips = cortar ventana del crudo real (`ffmpeg -ss/-t`) + crop 9:16 + subtítulos + overlay Remotion (logo, lower-third con nombre). **NUNCA clips sintéticos** — siempre del video crudo real.
- `assets` unificado (clip/nota/flyer/post) con estados editoriales; refactor de `clips`/`publications` actuales.
- Imágenes multi-modelo: `image_models` registry (Gemini, GPT Image, Ideogram, FLUX, Recraft) + default por tenant + gating por plan.

## t_ddc69173 — PeriodistApp — ÉPICA G: Bandeja, publicación y Zernio  [status=todo, prio=4]

**Objetivo**: control editorial + publicación real multi-red vía Zernio.

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (migración real, `npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. `tenant_id` en toda query. NO merge/deploy sin autorización. Nunca expongas credenciales sociales (Zernio es la capa de publicación).

**Checklist**:
- [ ] PG-01 Bandeja unificada sobre `assets` (filtros por tipo/programa/transmisión) [3]
- [ ] PG-02 Edición por IA sobre assets (texto y regeneración de imagen/clip) [3]
- [ ] PG-03 Config auto-publicación por tenant/programa (respeta plan) [2]
- [ ] PG-04 Integración Zernio: flujo embebido de conexión de cuentas → `social_connections` [5] — AC: conectar Instagram del cliente sin que PeriodistApp vea credenciales.
- [ ] PG-05 `publish_jobs`: aprobar → encolar por red/cuenta → Zernio API → estados + reintento [5]
- [ ] PG-06 Menciones/etiquetas con redes de `people` al publicar [2]
- [ ] PG-07 Migración gradual: Meta/Twitter directo queda como canal legacy opcional [2]

> **COMENTARIO**: **DECISIONES SDD (aplicar):**
- D-4: Zernio en **CONVIVENCIA** con publishService (no reemplazo). Zernio default para plataformas nuevas (16 redes: TikTok/IG/YouTube/LinkedIn/Threads/Bluesky); Meta directo legacy se mantiene para portfolios/businessAssets existentes.
- Connect embebido white-label (`welcome=true` + welcome-screen) con `externalId=tenantId`.
- `social_connections` + `publish_jobs` (aprobar→encolar→Zernio→estados+reintento) + menciones con handles de `persons.socials`.
- Nunca ver credenciales sociales.

## t_c8c1ae2e — PeriodistApp — ÉPICA H: UX/UI nivel "la elegida"  [status=todo, prio=3]

**Objetivo**: UX/UI nivel "la elegida por los canales".

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (`npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. NO merge/deploy sin autorización.

**Checklist**:
- [ ] PH-01 Design system: tokens (colores/tipografía/espaciado), dark pro, densidad newsroom [5]
- [ ] PH-02 Landing pública nueva (propuesta comercial, planes, demo) [5]
- [ ] PH-03 Rediseño sidebar/topbar + navegación por módulos nuevos [3]
- [ ] PH-04 Dashboard "Ahora" (en vivo, próximas, pendientes, uso) [5]
- [ ] PH-05 Estados vacíos/loading/error consistentes en todos los módulos [3]
- [ ] PH-06 Emails con branding de plataforma [2]
- [ ] PH-07 Responsive aceptable en tablet (la sala en vivo se usa en producción) [3]

> **COMENTARIO**: **CONTEXTO SDD:** la modernización del stack AI (shadcn/ui + Vercel AI SDK) **YA está hecha** (`sdd/ai-stack-modernization/tasks.md` todo `[x]`: componentes shadcn, aiSdkService, adapters). PH-01/PH-03 parten de esa base. Pipeline visualization = **Opción C híbrida** (React Flow para editor + shadcn `PipelineView`/`StepIndicator`/`StatusBadge`/`AIDisplay` para ejecución).

## t_1da234af — PeriodistApp — ÉPICA I: Robustez, observabilidad y lanzamiento  [status=todo, prio=2]

**Objetivo**: robustez, observabilidad y lanzamiento controlado.

**Repo**: `periodistapp` (Express+TS / React SPA / Drizzle+Postgres). Orca repo id `71068705-2254-4a40-a006-9da341a009a4`.

**Ejecución**: tomá el próximo `- [ ]`, delegá a Orca (`orca-delegate`) o inline si Orca caído. Verificá en disco (migración real, `npx tsc --noEmit` EXIT 0, `npm run build` verde). Marcá `[x]` con SHA + evidencia. Commit conventional, paths explícitos, sin atribución IA. `tenant_id` en toda query. NO merge/deploy sin autorización.

**Checklist**:
- [ ] PI-01 Cola de jobs (tabla Postgres MVP) con reintentos + dead-letter + panel de jobs en admin [5]
- [ ] PI-02 Logging estructurado + request-id + trazabilidad por transmisión [3]
- [ ] PI-03 Métricas de costo de IA por tenant/transmisión (alimenta super admin) [3]
- [ ] PI-04 Manejo de fallos de ingesta (stream caído, cortes) con reanudación de crudo [5]
- [ ] PI-05 Backup/retención de assets + política de borrado de crudos [2]
- [ ] PI-06 Checklist go-live: seeds de planes, datos demo, health checks, runbook de incidentes [3]
- [ ] PI-07 Piloto controlado: 1 canal real transmitiendo 1 semana, métricas de éxito [5]

> **COMENTARIO**: **DECISIONES SDD (aplicar):**
- D-6: cola de jobs = tabla Postgres MVP (reintentos + dead-letter) → extraer a workers cuando >10-20 streams simultáneos.
- PI-01 incluye panel de jobs en admin. Logging estructurado + request-id + trazabilidad por transmisión. Métricas de costo IA por tenant/transmisión.

## t_03f8938d — PeriodistApp — DECISIÓN B-1: Ingesta de YouTube en producción  [status=done, prio=10]

**Pregunta bloqueante del SDD** (proposal.md de Devin) — requiere decisión de Adrián antes de construir la ingesta.

**B-1 — Ingesta de YouTube en producción**: ¿aceptamos el posicionamiento *"streams propios del tenant (HLS/RTMP/upload) + YouTube best-effort"* para early adopters, o invertimos en VPS/proxies dedicados desde T1?

- Afecta: PD-07 (fuentes), PD-01/02 (ingesta), R-1 (YouTube bloquea datacenter), y el mensaje comercial.
- Impacto: define infra (VPS propio vs render/upload fallback) y qué se le promete al early adopter.


## t_15496e8c — PeriodistApp — DECISIÓN B-2: Multi-tenant por usuario  [status=done, prio=10]

**Pregunta bloqueante del SDD** (proposal.md de Devin) — requiere decisión de Adrián.

**B-2 — Multi-tenant por usuario**: ¿un user puede pertenecer a varios tenants desde ya (multi-marca Network), o se confirma post-v1?

- Afecta: modelo de auth (PA-04/PA-06), el switch de tenant, y el modelo de datos.
- Impacto: si es multi-tenant desde ya, cambia `users`↔`tenants` (relación N-M + tenant activo por sesión). Si es post-v1, un user ↔ un tenant (más simple).

