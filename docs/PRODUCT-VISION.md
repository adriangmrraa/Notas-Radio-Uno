# PeriodistApp — Visión de Producto y Backlog de Construcción

> **Documento maestro.** Describe la visión completa del producto, el modelo de negocio,
> la experiencia de usuario objetivo y el backlog de construcción estimado para
> **1–2 meses de trabajo**. Está escrito para que un arquitecto pueda diseñar la
> solución técnica y un scrum master pueda volcar el backlog a Jira tal cual.
>
> Estado: v1.0 — 2026-11-08
> Proyecto base: PeriodistApp (repo `notas-radio-uno`, workspace `gurnard`)

---

## 1. La visión en un párrafo

**PeriodistApp es la plataforma que un canal de streaming, un medio o un creador en vivo
contrata para que, mientras transmite, la IA esté mirando y escuchando el programa y
produciendo en tiempo real todo el contenido derivado: clips verticales cortados del
video crudo, flyers con la identidad del canal, notas periodísticas, citas y posts para
cada red social — con las voces y los rostros de las personas correctamente
identificados, la línea editorial del canal aplicada, y publicación automática o con
aprobación humana a través de Zernio.**

El cliente configura su canal una sola vez (programas, conductores con fotos y redes,
invitados, línea editorial, branding, redes sociales conectadas) y después solo
enciende la transmisión — o la deja programada — y el sistema hace el resto.

**Posicionamiento**: "la sala de contenidos con IA para canales que transmiten en vivo".
Referentes del mercado objetivo: Luzu TV, Olga, Blender, medios digitales, radios
con stream, canales de Twitch/Kick/YouTube Live con producción diaria.

---

## 2. El problema y la oportunidad

Los canales que transmiten en vivo todos los días tienen un cuello de botella
operativo: **del vivo al contenido publicado hay horas de trabajo humano**.
Hoy necesitan un editor que mire el stream, corte clips, un diseñador que haga
placas, un redactor que escriba notas, y un CM que publique en cada red.

- Los clips pierden viralidad: salen horas después, cuando el momento ya pasó.
- Los equipos chicos (1–3 personas) no pueden sostener ese ritmo.
- Las herramientas actuales resuelven partes (clipping, o transcription, o scheduling)
  pero ninguna entrega la **fábrica completa con contexto editorial**: quién habla,
  cómo se llama, cómo se ve, qué dice la línea editorial del canal.

**La oportunidad**: ser la primera plataforma que combina ingesta del vivo en video,
contexto editorial estructurado (personas/rostros/línea), generación multi-formato
y publicación multi-red en un solo pipeline con revisión humana opcional.

---

## 3. Modelo de negocio

### 3.1 Qué se vende

**Suscripción mensual medida en cantidad de transmisiones procesadas**, no en horas
ni en publicaciones. Es la métrica que el cliente entiende: "mi canal transmite
N programas por mes".

- Una **transmisión** = una sesión de procesamiento de un stream en vivo (o un
  video/stream ya emitido cargado para procesar), desde que el pipeline inicia
  hasta que finaliza o se detiene.
- Cada plan incluye **X transmisiones por mes**. Si el cliente se queda corto,
  puede comprar transmisiones extra (add-on) o subir de plan.
- Dentro de una transmisión, **todo lo generado está incluido**: clips, flyers,
  notas, variantes. Sin sorpresas de costo por asset.

### 3.2 Planes sugeridos (a validar con early adopters)

| Plan | Precio sugerido | Transmisiones/mes | Dirigido a |
|------|----------------|-------------------|------------|
| **Creator** | USD 29–49 | 8 | Creador individual, 2 streams/semana |
| **Media** | USD 99–149 | 30 | Medio o canal con 1 programa diario |
| **Network** | USD 299–499 | 120 | Canal tipo Luzu con grilla completa, varios programas/día |
| **Enterprise** | A convenir | Ilimitado | Grupos de medios, multi-canal |

Límites secundarios por plan (gating tipo Dentalogic, por uso no por features):

| Límite | Creator | Media | Network | Enterprise |
|--------|---------|-------|---------|------------|
| Transmisiones/mes | 8 | 30 | 120 | ∞ |
| Duración máx. por transmisión | 3 h | 6 h | 12 h | ∞ |
| Clips por transmisión | 10 | 25 | 50 | ∞ |
| Personas en biblioteca | 10 | 50 | 200 | ∞ |
| Programas activos | 2 | 10 | 50 | ∞ |
| Transmisiones programadas simultáneas | 2 | 10 | 30 | ∞ |
| Usuarios del equipo | 1 | 5 | 15 | ∞ |
| Canales sociales conectados (Zernio) | 3 | 10 | 30 | ∞ |
| Retención del video crudo | 7 días | 30 días | 90 días | custom |
| Auto-publicación sin aprobación | no | sí | sí | sí |
| Marcas (tenants) por cuenta | 1 | 1 | 3 | ∞ |

### 3.3 Reglas comerciales

- **Trial**: 7 días o 2 transmisiones gratis (lo que ocurra primero), sin tarjeta.
- **Add-on de transmisiones**: paquetes de +5/+15 transmisiones que expiran con el ciclo.
- **Pago**: MercadoPago (ARS, mercado objetivo inicial) + Stripe (USD, internacional).
- **Uso extra soft-cap**: al llegar al límite se avisa y se ofrece upgrade/add-on;
  no se corta una transmisión en curso nunca (una transmisión activa siempre termina).
- **Facturación por uso de IA**: el costo de modelos lo absorbe la plataforma en v1
  (margen calculado por plan); BYOK (el cliente pone sus API keys) queda como opción
  Enterprise — patrón ya validado en Dentalogic.

### 3.4 Estrategia early adopters

Objetivo de salida: **3–5 canales reales transmitiendo con la plataforma**.
Ofrecer plan Media gratis 3 meses a cambio de feedback semanal + permiso para usar
su caso como referencia comercial.

---

## 4. Los usuarios

### 4.1 Perfiles de cliente

1. **Canal de streaming** (Luzu TV, Olga, canal de Twitch/Kick con grilla):
   varios programas por día, cada uno con conductores e invitados distintos.
   Necesita: programación de transmisiones, biblioteca grande de personas,
   clips rápidos, volumen alto.
2. **Medio de comunicación** (radio con stream, portal, noticiero):
   1–3 transmisiones/día, necesita notas periodísticas + flyers con su marca
   además de clips.
3. **Creador individual**: 2–3 streams/semana, quiere clips para TikTok/Reels/Shorts
   y auto-publicación sin tocar nada.

### 4.2 Roles dentro del tenant (cuenta del cliente)

| Rol | Puede |
|-----|-------|
| **Owner** | Todo: facturación, conexiones sociales, línea editorial, equipo, borrar |
| **Editor** | Operar: programas, personas, agenda, bandeja de aprobación, publicar |
| **Viewer** | Solo ver: dashboard, clips, contenido, analytics básico |

Gestión de equipo por **invitación por email** (link con token, aceptación crea
la cuenta), misma mecánica que `admin/users/invite` de Dentalogic.

### 4.3 Super admin (nosotros, operadores de la plataforma)

Panel interno separado del producto cliente — benchmark Dentalogic
(`F2-17 super-admin-dashboard`, `F2-18 super-admin-endpoints`):

- Lista de tenants: estado, plan, uso del ciclo, transmisiones consumidas.
- Detalle de tenant: usuarios, programas, actividad reciente, costos de IA estimados.
- Acciones: cambiar plan, extender trial, otorgar transmisiones extra, suspender,
  impersonar (modo soporte, auditado), feature flags por tenant.
- Métricas globales: MRR, tenants activos, transmisiones procesadas, tasa de
  aprobación de assets, costo de IA por tenant.

---

## 5. La experiencia de producto (módulos)

Estructura de navegación objetivo de la app autenticada:

```
/ (dashboard)          → "Ahora" + próximas transmisiones + actividad
/agenda                → transmisiones programadas y calendario
/programas             → CRUD programas + sus transmisiones
/personas              → biblioteca: conductores, invitados, rostros
/linea-editorial       → tono, estilo, reglas de contenido
/en-vivo/[id]          → sala de control de una transmisión en curso
/clips                 → todos los clips generados
/contenido             → notas, flyers, posts (biblioteca de assets)
/aprobacion            → bandeja de revisión (el copiloto editorial)
/conexiones            → Zernio: cuentas sociales conectadas
/equipo                → usuarios, roles, invitaciones
/facturacion           → plan, uso, pagos
/configuracion         → marca, integraciones, preferencias
/admin (super admin)   → solo operadores de la plataforma
```

### 5.1 Onboarding (crítico para early adopters)

Wizard de 4 pasos post-registro:
1. **Tu canal/medio**: nombre, logo, tipo (streaming / medio / creador), rubro.
2. **Tu primer programa**: nombre, plataforma (URL YouTube/Twitch/Kick/radio/web),
   día(s) y horario habitual → crea la primera transmisión programada.
3. **Las personas**: cargar conductor(es) con nombre, rol, fotos, redes sociales.
4. **Conectar redes**: botón "Conectar con Zernio" → flujo embebido, elige cuentas.
Al finalizar: pantalla "todo listo — tu próxima transmisión es {fecha}".

### 5.2 Dashboard — "Ahora"

- Card EN VIVO si hay transmisión activa: tiempo al aire, clips generados hasta
  el momento, alertas, link a la sala en vivo.
- Próximas transmisiones programadas (con countdown).
- Assets pendientes de aprobación (badge con contador → bandeja).
- Uso del ciclo: "usaste 6 de 30 transmisiones", barra de progreso.
- Actividad reciente: últimos clips publicados, notas, errores.

### 5.3 Programas y Agenda

- **Programa** = show recurrente: nombre, descripción, plataforma(s) con sus URLs,
  conductores asignados (de la biblioteca de personas), línea editorial propia
  (o hereda la del tenant), rubro.
- **Transmisión programada**: programa + fecha/hora (o recurrencia semanal:
  "lunes a viernes 10:00"), duración estimada, auto-start on/off.
- El **scheduler** inicia la captura automáticamente a la hora programada
  (con reintentos si el stream todavía no está al aire — ventana de espera
  configurable, default 30 min).
- Vista calendario semanal/mensual + lista.

### 5.4 Personas (la biblioteca de contexto humano)

El módulo clave para que el sistema "sepa quién es quién":

- **Persona** = conductor, invitado recurrente o figura del canal:
  - Nombre, rol (conductor / columnista / invitado / producción), bio corta.
  - **Fotos múltiples** (mínimo 1, recomendado 3+ ángulos) → se extraen
    embeddings faciales para reconocimiento en el video.
  - **Muestras de voz** (opcional, v2): clips de audio para voice-print
    si la diarización sola no alcanza.
  - **Redes sociales**: Twitter/X, Instagram, TikTok, YouTube, LinkedIn —
    se usan para menciones/etiquetas automáticas al publicar y para
    enriquecer dossiers.
  - **Notas/contexto libre**: apodos, temas que trata, qué no mencionar,
    relaciones ("es el que siempre discute de fútbol").
  - Programas en los que participa (relación muchos-a-muchos).
- **Invitados puntuales**: personas asociadas a una transmisión concreta
  (fecha), con dossier automático (ya existe: bio, actividad reciente,
  controversias, preguntas sugeridas — se mantiene y mejora).

### 5.5 Línea editorial y marca

Configuración por tenant con override por programa:

- **Tono**: formal / informal / humor / duro / fan. Ejemplos de titulares
  "como los nuestros" (few-shot para el modelo).
- **Reglas**: qué sí y qué no ("nunca titular con apellidos de políticos",
  "siempre poner el nombre del programa", "evitar temas X").
- **Rubro**: streaming-entretenimiento / noticias / deportes / política —
  cambia las plantillas de nota y los prompts de detección de momentos.
- **Marca** (ya existe): logo, tipografía, templates de flyer, colores.
- **Formatos activos**: qué generar por transmisión (clips sí/no, notas sí/no,
  flyers, quote-cards, hilo) y para qué redes.

### 5.6 Sala "En vivo"

Pantalla de monitoreo de una transmisión en curso:

- Timeline en tiempo real: transcripción con speaker labels ya resueltos a
  personas reales ("Martín:", no "Speaker A"), momentos detectados marcados,
  alertas de keywords.
- Clips generándose: cards que van apareciendo a medida que se detectan
  momentos → se cortan → se renderizan.
- Panel de personas detectadas: rostros reconocidos con confianza;
  corrección manual ("esto no es Martín, es el invitado") que realimenta
  la sesión.
- Acciones: "generar clip ahora" (mark manual), "generar nota de este bloque",
  pausar/finalizar transmisión.

### 5.7 Clips

- Biblioteca de todos los clips, filtrable por programa/persona/fecha/estado.
- Cada clip: video 9:16 (o el formato elegido), subtítulos, momento/motivo de
  detección, persona(s) que aparece(n), sugerencia de copy + hashtags por red,
  estados: `procesando → listo → en revisión → aprobado → publicado / rechazado`.
- Re-corte manual simple: elegir inicio/fin sobre el segmento crudo y re-render.

### 5.8 Contenido (notas, flyers, posts)

- **Notas periodísticas**: artículo completo con titular, bajada, cuerpo,
  citas atribuidas a la persona correcta (nombre + foto), por rubro.
- **Flyers**: imagen con branding del tenant (sistema actual de templates
  + nuevos modelos de imagen para fondos/ilustraciones).
- **Quote-cards**: cita + foto del que la dijo + branding.
- **Variantes multi-red**: del mismo contenido, copy específico para
  X/Twitter, Instagram, LinkedIn, TikTok, YouTube community, newsletter.
- Estados iguales que clips: procesando → listo → revisión → aprobado →
  publicado/rechazado.

### 5.9 Bandeja de aprobación (copiloto editorial — ya existe, se eleva)

- Cola unificada de TODOS los assets pendientes (clips + notas + flyers + posts).
- Edición con IA en lenguaje natural ("hacelo más corto", "más agresivo el
  titular", "regenerá el flyer con otro fondo").
- Aprobación individual o en batch.
- Toggle por tenant: **aprobación obligatoria** (default) o **auto-publicación**
  (los assets se publican apenas quedan listos; la bandeja queda como registro).

### 5.10 Conexiones (Zernio)

- "Conectar redes" abre el **flujo embebido de Zernio** (URL/iframe/SDK según
  su producto actual): el cliente autoriza sus cuentas una vez y quedan
  vinculadas a su tenant.
- PeriodistApp **nunca ve credenciales sociales**: Zernio es la capa de
  publicación. Esto elimina el mantenimiento de apps de Meta/Twitter/TikTok
  propias — decisión estratégica del usuario, ya validada en otros proyectos.
- Por cada cuenta conectada: a qué programa(s) y formato(s) aplica.
- Estado de cada publicación (pendiente/publicada/error) con reintento.

### 5.11 Facturación y equipo

- Plan actual, transmisiones consumidas del ciclo con fecha de renovación,
  historial de pagos, compra de add-ons, upgrade/downgrade con prorrateo.
- Equipo: usuarios, roles, invitaciones pendientes.

---

## 6. Flujo end-to-end (narrativa del sistema)

```
ANTES (contexto que el cliente carga una vez):
  Canal → Programas → Personas (rostros, voces, redes, notas)
        → Línea editorial → Marca → Conexiones Zernio → Transmisiones programadas

DURANTE (transmisión en vivo — automático o programado):
  1. Scheduler inicia captura del stream (video + audio) y graba el crudo
  2. Transcripción en tiempo real con diarización
  3. Resolución de identidad: speaker labels → personas (voz + rostros
     detectados en frames → matching con biblioteca)
  4. Modelo de análisis en vivo (el mejor multimodal del mercado):
     detecta momentos clipables, cambios de tema, citas, alertas
  5. Fábrica de contenido por cada momento/bloque:
     - corta el segmento del video crudo
     - re-encuadra a 9:16 (crop inteligente sobre rostros), subtitula,
       aplica branding → clip listo
     - redacta nota con línea editorial + cita atribuida + flyer
     - genera variantes de copy por red
  6. Según config del tenant: → bandeja de aprobación  |  auto-publicación

DESPUÉS:
  7. Aprobado → publica vía Zernio a las redes conectadas (etiquetando a las
     personas si su config lo permite)
  8. Analytics de entrega + uso contra la cuota del plan
  9. El crudo se retiene según plan y luego se purga
```

---

## 7. Arquitectura objetivo (alto nivel)

Se **mantiene el stack actual** (no hay reescritura): Express + TypeScript,
React SPA, PostgreSQL/Drizzle, Socket.IO, Remotion. Se agrega un subsistema de
video y se endurece la capa SaaS al nivel Dentalogic.

```
┌─────────────────────────────────────────────────────────────────┐
│                        PeriodistApp                             │
│                                                                 │
│  ┌──────────┐   ┌───────────────────────────────────────────┐   │
│  │ React SPA│──►│              API Express                   │   │
│  │  (Vite)  │◄──│  auth · tenants · programs · people ·      │   │
│  └──────────┘   │  schedule · review · billing · admin       │   │
│        ▲        └───────┬───────────────┬─────────────────┘    │
│        │ Socket.IO      │               │                       │
│        │           ┌────▼─────┐    ┌────▼──────┐               │
│        │           │Scheduler │    │ Ingesta    │               │
│        │           │  (cron)  │───►│ video vivo │──► crudo      │
│        │           └──────────┘    │ yt-dlp/ffmpeg (storage)   │
│        │                           └────┬───────┘             │
│        │                                │                      │
│        │   ┌────────────────────────────▼──────────────────┐   │
│        │   │        MOTOR DE ANÁLISIS EN VIVO               │   │
│        │   │  transcripción+diarización │ identidad (voz+   │   │
│        │   │  rostro) │ momentos │ citas │ alertas          │   │
│        │   └────────────────────────────┬──────────────────┘   │
│        │                                │                      │
│        │   ┌────────────────────────────▼──────────────────┐   │
│        └───┤        FÁBRICA DE CONTENIDO                   │   │
│            │  clip-cutter (ffmpeg) │ Remotion render │      │   │
│            │  texto (LLM) │ imágenes (multi-modelo) │       │   │
│            │  variantes por red                           │   │
│            └────────────────────────────┬──────────────────┘   │
│                                         │                      │
│            ┌────────────────────────────▼──────────────────┐   │
│            │   BANDEJA → APROBACIÓN → ZERNIO (publicación) │   │
│            └───────────────────────────────────────────────┘   │
│                                                                 │
│  PostgreSQL (Neon/Drizzle) · Object storage p/crudos y assets · │
│  Cola de jobs (BullMQ/Redis o tabla Postgres según escala)      │
└─────────────────────────────────────────────────────────────────┘
```

### 7.1 Decisiones de arquitectura clave

- **Ingesta de video**: extender la captura actual de yt-dlp/ffmpeg de audio-only
  a video (HLS). El crudo se graba segmentado a object storage (S3-compatible o
  filesystem en VPS para MVP). Tradeoff documentado en exploración: captura
  propia vs servicio de video (Livepeer/Mux) — se recomienda captura propia en
  v1 por costo y porque ya existe la base yt-dlp.
- **Cola de trabajos**: el pipeline ya es largo y ahora incluye render de video.
  Tabla `jobs` en Postgres para MVP; BullMQ+Redis cuando haya varios workers.
- **Modelo de análisis en vivo**: capa de abstracción de proveedores (ya existe
  el concepto `ai_provider` en `custom_agents`). Default = el mejor multimodal
  de video del mercado al momento de implementar (candidato: Gemini serie
  2.5/3 Pro por comprensión de video+largo contexto — confirmar en fase de
  diseño). Imágenes: multi-modelo seleccionable por tenant (Gemini, xAI/Grok,
  y lo que dicte la calidad).
- **Identidad de personas**: v1 = diarización de voz + confirmación por rostro
  en frames (comparación de embeddings faciales contra la biblioteca).
  Voice-prints dedicados quedan v2.
- **Datos nuevos principales** (Drizzle):
  `people` (rostros/fotos/embeddings/redes/notas), `person_program`,
  `transmissions` (programada/en-vivo/procesada/error + stream_url + crudo_ref),
  `transmission_segments`, `assets` (unifica clips/notas/flyers/posts con
  estado editorial), `social_connections` (ref a cuentas Zernio),
  `publish_jobs`, `usage_cycles` (transmisiones por ciclo),
  `editorial_profiles`, `team_invites`, `admin_users`, `audit_logs`.
- **Seguridad al nivel Dentalogic**: `tenant_id` en toda query, credenciales
  externas cifradas AES-256-GCM, rate limiting, headers de seguridad,
  audit log de acciones admin, nunca secretos en frontend.
- **Video en Render**: la limitación actual de yt-dlp en datacenters para
  YouTube aplica también al video — el deploy de producción de ingesta
  probablemente requiera VPS propio (o rotación de proxies) — riesgo R-1.

---

## 8. Sobre qué se construye (base actual)

Ya implementado y funcionando (verificado en código, no solo en specs):

- Multi-tenant real: auth JWT + verificación email, `req.auth.tenantId`,
  roles owner/editor/viewer básicos, suscripciones Stripe+MercadoPago.
- Pipeline: captura de audio de streams → transcripción (AssemblyAI
  diarización / Whisper) → segmentación por temas → insights + citas →
  generación de nota + flyer + quote-cards + variantes 1→5.
- Clips verticales con Remotion (QuoteClip, NewsClip), hoy sobre contenido
  generado, no sobre el video crudo.
- Bandeja de revisión con edición por IA, batch, branding por tenant
  (logo en DB, 6 tipografías, 5 templates).
- Programas, conductores (con fotos), invitados + dossier automático,
  alertas en vivo por keyword+IA, páginas públicas `/p/{slug}` + RSS.
- **Scheduling recurrente real**: `scheduledJobs` (streamUrl, daysOfWeek,
  startTime, durationMinutes), `jobExecutions`, loop de 60s con detección
  de live vía yt-dlp (YT/Twitch/Kick/Facebook/directo) + reintentos.
- **Billing real**: `plans`, `subscriptions`, `invoices`, `usage_records`;
  checkout+webhook de Stripe y preapproval+webhook de MercadoPago.
- Credenciales externas cifradas AES-256-GCM (idéntico al vault Dentalogic).

**Deuda técnica detectada en exploración** (alimenta el backlog de
implementación): `checkUsageLimits` existe pero nunca se invoca (billing sin
enforcement); `express.json()` global rompe el raw body del webhook de
Stripe (probablemente inválido en producción); el scheduler compara hora
local del server contra `job.startTime` ignorando `job.timezone`; `setSetting`
puede escribir settings sin `tenant_id`; tabla `teamInvitations` huérfana
(SPEC-08 sin rutas); restos de Prisma para limpiar (el ORM real es Drizzle);
cero tests y cero lint/CI.

Gap principal hacia la visión: **video (no solo audio), rostros, entidad
Canal + agenda elevada sobre el scheduler existente, enforcement de billing
por transmisiones, Zernio, super admin, y la capa de UX/robustez para
early adopters.**

---

## 9. Benchmark Dentalogic — qué adoptamos

Del proyecto `dentalogic-saas` (Next.js + Supabase + Mastra) tomamos
**patrones**, no código (stack distinto — PeriodistApp queda en Express/SPA):

| De Dentalogic | Adaptación en PeriodistApp |
|---------------|----------------------------|
| Soberanía `tenant_id` + auditoría | Misma regla + middleware que la hace cumplir + `audit_logs` |
| Super admin (dashboard + endpoints) | Panel `/admin` con tenants, planes, uso, impersonación auditada |
| Invitaciones de equipo | `team_invites` + flujo email-token-aceptación |
| Gating por uso (no por features) | Cuotas por plan sobre transmisiones/clips/personas |
| Suscripciones + dunning + trial | Ciclo completo: trial → activa → past_due → suspendida |
| Credentials vault cifrado | AES-256-GCM para cualquier credencial externa del tenant |
| Feature flags por tenant | `tenant_features` para rollout gradual a early adopters |
| BYOK Enterprise | Opcional: tenant trae sus API keys de IA |

---

## 10. Backlog de construcción (listo para Jira)

**Estimación total: ~8 semanas, 1 equipo (1–2 devs + agentes IA).**
Formato: `PROJ-XXX título [estimación]` — puntos en escala 1/2/3/5/8.
DoR: ticket con criterios de aceptación. DoD: `tsc` + `vite build` verdes,
migración aplicada, feature flaggeada si es nueva superficie.

### ÉPICA A — Fundación SaaS y Super Admin (benchmark Dentalogic)

*Objetivo: la plataforma es administrable, segura y vendible.*

- **PA-01** Schema Drizzle: `user_tenants`, `tenant_features`, `audit_logs`, `jobs_queue` y flag `users.is_platform_admin` [3]
  - AC: migraciones generadas; `tenant_features` con default por plan.
- **PA-02** Invitaciones de equipo: endpoints invite/accept/revoke + email con token [3]
  - AC: invitar editor → link → crea cuenta activa en el tenant.
- **PA-03** Módulo Equipo (UI): lista de usuarios, cambiar rol, reenviar/revocar invitación [3]
- **PA-04** Middleware de autorización por rol (owner>editor>viewer) aplicado a todas las rutas [3]
  - AC: viewer no puede mutar (403 verificado en rutas clave).
- **PA-05** Audit log: registrar acciones sensibles (login, publish, admin, billing) [2]
- **PA-06** Super admin: flag `is_platform_admin` + guard + layout `/admin` [3]
- **PA-07** Super admin: lista tenants (plan, uso, estado, creado) + búsqueda [3]
- **PA-08** Super admin: detalle tenant (usuarios, uso, actividad, costo IA estimado) [5]
- **PA-09** Super admin: acciones — cambiar plan, extender trial, +transmisiones, suspender [3]
- **PA-10** Super admin: impersonación auditada (banner "viendo como", expira 30 min) [3]
- **PA-11** Feature flags: `tenant_features` + override desde admin + hook cliente `useFeature` [2]
- **PA-12** Hardening: rate limit auth+API, headers seguridad, CORS estricto, audit de credenciales cifradas [3]

### ÉPICA B — Billing por transmisiones

*Objetivo: el modelo de negocio funciona end-to-end.*

- **PB-01** Schema: `tenant_quotas` + `quota_operations` idempotentes por período/TZ y campos de plan (transmisiones, duración máx, clips, personas, retención crudo) [3]
- **PB-02** Metering: consumir 1 transmisión al iniciar pipeline; liberar si falla antes de N min [3]
  - AC: una transmisión activa NUNCA se corta por cuota.
- **PB-03** Plans seed (Creator/Media/Network/Enterprise) + admin de planes [2]
- **PB-04** Checkout MercadoPago + Stripe: alta, cambio de plan con prorrateo, cancelación [5]
- **PB-05** Add-on transmisiones (+5/+15, expiran con ciclo) [3]
- **PB-06** Paywall UX: bloqueo suave + modal upgrade/add-on + banners de uso (>80%) [3]
- **PB-07** Ciclo de vida suscripción: trial 7d/2 transmisiones → activa → past_due (dunning 3 intentos + emails) → suspendida [5]
- **PB-08** Página Facturación: plan, medidor de uso, historial, compra add-ons [3]
- **PB-09** Emails transaccionales: trial por vencer, pago ok/fallido, suspensión [2]

### ÉPICA C — Contexto del canal (Personas + Editorial + Agenda)

*Objetivo: el cliente alimenta el sistema y el sistema "sabe" quién es quién.*

- **PC-01** Schema: `persons`, `person_photos`, `face_embeddings`, `person_program` y `editorial_profiles` [3]
- **PC-02** Migración conductores+invitados→persons (la biblioteca unificada conserva fotos y vínculos) [2]
- **PC-03** Módulo Personas (UI): CRUD con multi-foto, redes, notas, programas asociados [5]
- **PC-04** Pipeline de rostros: al subir foto → detectar cara → generar embedding → guardar [5]
  - AC: foto sin cara rechazada con mensaje claro.
- **PC-05** Línea editorial (UI): tono, reglas, ejemplos, rubro, formatos activos — tenant + override por programa [3]
- **PC-06** Línea editorial en prompts: inyectar perfil en generación de notas/copies/momentos [3]
- **PC-07** Schema transmisiones: `transmissions` + `scheduled_transmissions` (recurrencia RRULE) + vínculo a programa [3]
- **PC-08** Agenda (UI): crear/editar transmisión programada (fecha o semanal), auto-start, calendario [5]
- **PC-09** Dossier de invitados vinculado a transmisión programada (mejora del existente) [2]
- **PC-10** Onboarding wizard 4 pasos (canal→programa→personas→Zernio) con estado `onboarding_completed` [5]

### ÉPICA D — Ingesta de video en vivo y Scheduling

*Objetivo: del stream al crudo grabado, automático.*

- **PD-01** Captura de video: extender captura yt-dlp/ffmpeg de audio-only a HLS video+audio [5]
- **PD-02** Grabación segmentada del crudo a storage (S3/filesystem) con `crudo_ref` en `transmissions` [5]
- **PD-03** Scheduler: worker que dispara transmisiones programadas (ventana de espera, reintentos) [5]
  - AC: stream que arranca 10 min tarde se captura igual.
- **PD-04** Estados de transmisión + eventos Socket.IO (scheduled→waiting→live→processing→done/error) [3]
- **PD-05** Sala "En vivo" (UI): timeline transcripción con personas resueltas, momentos, clips generándose, mark manual [8]
- **PD-06** Retención del crudo por plan + job de purga [2]
- **PD-07** Soporte de fuentes: YouTube Live, Twitch, Kick, HLS genérico, upload de video (fallback) [5]
  - Nota: YouTube en datacenter bloqueado (ver R-1) — el fallback de upload habilita early adopters igual.

### ÉPICA E — Motor de análisis en vivo

*Objetivo: el "mejor modelo del mercado" mirando el vivo.*

- **PE-01** Capa de proveedores de análisis (interface + config por proceso: análisis/transcripción/imagen) [3]
- **PE-02** Integración del modelo multimodal top (video+transcripción → momentos, temas, citas) [8]
- **PE-03** Identidad de personas: diarización → matching rostro en frames contra embeddings de `persons` [8]
  - AC: speaker label resuelto a persona con confianza; corrección manual persiste en la sesión.
- **PE-04** Detección de momentos clipables en tiempo real (score + razón + ventana sugerida) [5]
- **PE-05** Detección de citas atribuidas a persona (nombre+foto) [3]
- **PE-06** Segmentos: `transmission_segments` (tema, resumen, speakers, ventana temporal) [3]
- **PE-07** Alertas en vivo: reutilizar servicio actual sobre la transcripción nueva [2]

### ÉPICA F — Fábrica de contenido desde el crudo

*Objetivo: clips del video real + todo lo demás.*

- **PF-01** Clip-cutter: cortar ventana del crudo con ffmpeg (precisión de frames, sin re-encode completo) [5]
- **PF-02** Re-encuadre 9:16 inteligente: crop centrado en rostro activo (o layout split si 2 personas) [8]
- **PF-03** Subtítulos quemados con estilo del tenant + progreso; branding (logo, lower-third con nombre de persona) [5]
- **PF-04** Cola de render de clips (jobs) + estados por clip + reintento [3]
- **PF-05** Re-corte manual: selector inicio/fin sobre segmento → re-render [3]
- **PF-06** Notas por rubro con citas atribuidas (plantillas por rubro editorial) [3]
- **PF-07** Flyers/quote-cards con foto real de la persona detectada [3]
- **PF-08** Imágenes multi-modelo: provider seleccionable por tenant + fallback [3]
- **PF-09** Variantes por red: copy+hashtags+menciones con handles de `persons.socials` [3]
- **PF-10** Modelo `assets` unificado (clip/nota/flyer/post) con estados editoriales — refactor de `clips`/`publications` actuales [5]

### ÉPICA G — Bandeja, publicación y Zernio

*Objetivo: control editorial + publicación real multi-red.*

- **PG-01** Bandeja unificada sobre `assets` (filtros por tipo/programa/transmisión) [3]
- **PG-02** Edición por IA sobre assets (texto y regeneración de imagen/clip) [3]
- **PG-03** Config auto-publicación por tenant/programa (respeta plan) [2]
- **PG-04** Integración Zernio: flujo embebido de conexión de cuentas → `social_connections` [5]
  - AC: conectar Instagram del cliente sin que PeriodistApp vea credenciales.
- **PG-05** `publish_jobs`: aprobar → encolar por red/cuenta → Zernio API → estados + reintento [5]
- **PG-06** Menciones/etiquetas con redes de `people` al publicar [2]
- **PG-07** Migración gradual: Meta/Twitter directo queda como canal legacy opcional [2]

### ÉPICA H — UX/UI nivel "la elegida por los canales"

- **PH-01** Design system: tokens (colores/tipografía/espaciado), dark pro, densidad newsroom [5]
- **PH-02** Landing pública nueva (propuesta comercial, planes, demo) [5]
- **PH-03** Rediseño sidebar/topbar + navegación por módulos nuevos [3]
- **PH-04** Dashboard "Ahora" (en vivo, próximas, pendientes, uso) [5]
- **PH-05** Estados vacíos/loading/error consistentes en todos los módulos [3]
- **PH-06** Emails con branding de plataforma [2]
- **PH-07** Responsive aceptable en tablet (la sala en vivo se usa en producción) [3]

### ÉPICA I — Robustez, observabilidad y lanzamiento

- **PI-01** Cola de jobs (tabla Postgres MVP) con reintentos + dead-letter + panel de jobs en admin [5]
- **PI-02** Logging estructurado + request-id + trazabilidad por transmisión [3]
- **PI-03** Métricas de costo de IA por tenant/transmisión (alimenta super admin) [3]
- **PI-04** Manejo de fallos de ingesta (stream caído, cortes) con reanudación de crudo [5]
- **PI-05** Backup/retención de assets + política de borrado de crudos [2]
- **PI-06** Checklist go-live: seeds de planes, datos demo, health checks, runbook de incidentes [3]
- **PI-07** Piloto controlado: 1 canal real transmitiendo 1 semana, métricas de éxito [5]

### Plan de sprints (2 semanas c/u)

| Sprint | Contenido | Salida |
|--------|-----------|--------|
| **S1** (sem 1–2) | PA-01→PA-05, PB-01→PB-03, PC-01, PC-02, PD-01, PD-02 | Base: equipo+audit+schema billing; captura de video funcionando en dev |
| **S2** (sem 3–4) | PA-06→PA-12, PB-04→PB-09, PC-03→PC-08, PD-03, PD-04 | SaaS completo: admin, billing, agenda, personas — demo interno |
| **S3** (sem 5–6) | PD-05→PD-07, PE-01→PE-07, PF-01→PF-05 | El vivo funciona: sala en vivo, identidad, clips del crudo |
| **S4** (sem 7–8) | PF-06→PF-10, PG-01→PG-07, PH-01→PH-07, PI-01→PI-07 | Publicación Zernio, UX elevada, piloto y go-live |

**Nota honesta de alcance**: 8 semanas es agresivo para la visión completa. Si hay
que recortar, el orden de sacrificio es: (1) re-encuadre inteligente → crop
centrado simple; (2) voice-prints → ya está diferido; (3) super admin completo →
versión mínima (lista tenants + acciones básicas); (4) sala en vivo avanzada →
dashboard simple de progreso. Lo que NO se recorta para early adopters:
video del crudo → clips, personas+rostros, Zernio, billing por transmisiones,
aprobación/auto-publish.

---

## 11. Definición de "listo para early adopters"

Checklist de go-live (todo verificable):

- [ ] Un canal se registra, hace onboarding y programa una transmisión sin ayuda
- [ ] La transmisión programada arranca sola, graba el crudo y produce ≥5 clips
- [ ] Los speakers salen con nombre real (≥90% de atribución en la piloto)
- [ ] Un clip se aprueba y se publica en Instagram/TikTok del canal vía Zernio
- [ ] La cuota de transmisiones descuenta correctamente y el paywall funciona
- [ ] Un pago real por MercadoPago activa el plan
- [ ] Super admin: veo el tenant, su uso, puedo impersonar para soporte
- [ ] Cero queries sin `tenant_id` (revisión + lint de sovereignty)
- [ ] Transmisión caída se reanuda sin perder el crudo ya grabado
- [ ] Documentación de onboarding para el cliente (guía corta)

---

## 12. Riesgos y decisiones abiertas

| # | Riesgo/Decisión | Impacto | Mitigación/estado |
|---|-----------------|---------|-------------------|
| R-1 | YouTube bloquea IPs de datacenter (ya documentado) | Ingesta de YT en producción | **DECIDIDO**: YouTube garantizado desde T1 — VPS propio/proxies + fallback upload entra al scope de ingesta |
| R-2 | Costo del modelo de video top en transmisiones largas | Margen del plan | Metering de costo por transmisión (PI-03) + límites de duración por plan |
| R-3 | Precisión de rostros con pocas fotos | Atribución errónea | Pedir 3+ fotos en onboarding; corrección manual realimenta |
| R-4 | Zernio: alcance de su API/flujo embebido | Publicación | Spike en S1: validar embedded connect + post de video 9:16 en IG/TikTok |
| R-5 | Render de clips a escala (ffmpeg+Remotion pesado) | Lentitud | Cola de jobs + workers; prioridad a clips sobre assets secundarios |
| D-1 | Modelo de análisis en vivo definitivo | Calidad/costo | Capa de proveedores (PE-01) permite cambiar sin reescribir; confirmar top multimodal en diseño |
| D-2 | Storage de crudos: S3 vs disco VPS | Costo ops | MVP filesystem en VPS; S3 si Network entra early |
| D-3 | ¿Multi-marca (varios tenants por usuario) desde el inicio? | Alcance | **DECIDIDO**: desde v1 — `user_tenants` + tenant activo en sesión + switcher en UI; impacta auth y guards |

---

## 13. Fuera de alcance v1 (post-launch)

- Voice-prints dedicados por persona (solo si rostro+diarización no alcanza)
- App mobile
- Analytics de performance del contenido publicado (engagement desde Zernio si su API lo permite)
- Editor de video avanzado (multi-clip, música)
- White-label / multi-marca por usuario
- API pública para desarrolladores
- Detección de momentos con feedback del chat en vivo (Twitch chat como señal)

---

*Documento generado en la sesión de planificación del cambio `live-creator-platform`.
La exploración técnica detallada (comparativas, estado real del código) vive en
Engram bajo `sdd/live-creator-platform/exploration`.*
