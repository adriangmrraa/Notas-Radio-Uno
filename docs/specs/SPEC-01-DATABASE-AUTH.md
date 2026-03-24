# SPEC 01: Prisma ORM + PostgreSQL + Sistema de Autenticación

> Fundación del SaaS: Prisma como ORM con migraciones automáticas, PostgreSQL, registro, login, verificación de email, JWT, middleware de auth y seguridad base.

---

## Contexto

PeriodistApp actualmente usa SQLite (`better-sqlite3`) con un singleton en `databaseService.ts` que expone funciones síncronas. No tiene autenticación. Esta spec migra la persistencia a PostgreSQL **usando Prisma ORM** como capa de acceso a datos, y agrega un sistema completo de autenticación.

### Por qué Prisma

Prisma es el ORM estándar de producción para Node.js + TypeScript. Es el equivalente a SQLAlchemy + Alembic en Python:

| Responsabilidad | Python (ClinicForge) | Node.js (PeriodistApp) |
|---|---|---|
| ORM / Query Builder | SQLAlchemy | **Prisma Client** |
| Migraciones | Alembic | **Prisma Migrate** |
| Schema Definition | Models Python | **schema.prisma** (DSL declarativo) |
| Type Safety | Manual / Pydantic | **Auto-generado desde schema** |
| Seeding | Scripts SQL | **prisma/seed.ts** |
| CLI | `alembic upgrade head` | **`npx prisma migrate deploy`** |

**Beneficios para PeriodistApp como empresa/producto SaaS:**
- **Type-safe queries**: Cada query se valida en compile-time. Si el schema cambia, TypeScript rompe donde hay inconsistencias.
- **Migraciones versionadas**: Cada cambio de schema genera un archivo de migración reproducible (`prisma/migrations/`), rastreable en Git.
- **Prisma Studio**: UI web para inspeccionar datos en desarrollo (`npx prisma studio`).
- **Auto-generated types**: No se escriben interfaces de DB manualmente — Prisma las genera desde el schema.
- **Introspection**: Puede leer una DB existente y generar el schema (`prisma db pull`).

### Estado Actual (lo que existe)

**Tablas SQLite actuales** (en `databaseService.ts`):
- `credentials` — API keys encriptadas (AES-256-GCM)
- `business_assets` — Facebook Pages e Instagram accounts
- `publications` — Notas generadas/publicadas
- `transcriptions` — Segmentos transcritos
- `settings` — Key-value config
- `custom_agents` — Agentes IA del pipeline
- `pipeline_configs` — Configuración de nodos del pipeline

**Funciones de DB existentes** (todas síncronas con `better-sqlite3`):
```
initDatabase(), getDb()
getSetting(), setSetting(), getSettingsByPrefix(), deleteSetting()
setCredential(), getCredential(), invalidateCredential(), deleteCredentialsByCategory(), getCredentialNames()
upsertAsset(), getAssetsByType(), getAllActiveAssets(), deactivateAllAssets(), isMetaConnected()
createPublication(), getPublicationById(), getAllPublications(), deletePublication(), countPublications()
createTranscription(), getTranscriptionById(), getAllTranscriptions(), deleteTranscription(), countTranscriptions()
createAgent(), getAgent(), getAllAgents(), updateAgent(), deleteAgent()
getActivePipelineConfig(), savePipelineConfig(), resetPipelineConfig()
```

---

## 1. Dependencias

```bash
# Remover
npm uninstall better-sqlite3 @types/better-sqlite3

# Agregar — ORM y Database
npm install prisma --save-dev          # CLI de Prisma (dev dependency)
npm install @prisma/client             # Prisma Client (runtime)

# Agregar — Auth y Seguridad
npm install bcryptjs                    # Password hashing (puro JS, sin native deps)
npm install jsonwebtoken                # JWT tokens
npm install cookie-parser               # Leer cookies HttpOnly
npm install nodemailer                  # Envío de emails SMTP
npm install express-rate-limit          # Rate limiting HTTP
npm install ioredis                     # Redis client
npm install zod                         # Validación de schemas
npm install slugify                     # Generar slugs desde nombres

# Tipos
npm install -D @types/bcryptjs @types/jsonwebtoken @types/cookie-parser @types/nodemailer
```

---

## 2. Inicializar Prisma

```bash
# Crear estructura de Prisma
npx prisma init

# Esto genera:
# prisma/
#   schema.prisma    ← Definición de modelos
# .env               ← DATABASE_URL (ya existe, se agrega la variable)
```

---

## 3. Schema Prisma Completo

### `prisma/schema.prisma`

```prisma
// =============================================
// CONFIGURACIÓN
// =============================================
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// =============================================
// TENANT — Cada organización/medio/canal
// =============================================
model Tenant {
  id           String   @id @default(uuid()) @db.Uuid
  name         String   @db.VarChar(255)
  slug         String   @unique @db.VarChar(100)
  ownerId      String?  @map("owner_id") @db.Uuid
  platformName String?  @map("platform_name") @db.VarChar(255)
  logoUrl      String?  @map("logo_url")
  timezone     String   @default("America/Argentina/Buenos_Aires") @db.VarChar(50)
  config       Json     @default("{}")
  isActive     Boolean  @default(true) @map("is_active")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz

  // Relaciones
  owner             User?              @relation("TenantOwner", fields: [ownerId], references: [id], onDelete: SetNull)
  users             User[]             @relation("TenantUsers")
  credentials       Credential[]
  businessAssets    BusinessAsset[]
  publications      Publication[]
  transcriptions    Transcription[]
  settings          Setting[]
  customAgents      CustomAgent[]
  pipelineConfigs   PipelineConfig[]
  subscription      Subscription?
  usageRecords      UsageRecord[]
  invoices          Invoice[]
  scheduledJobs     ScheduledJob[]
  jobExecutions     JobExecution[]
  dailyMetrics      DailyMetric[]
  teamInvitations   TeamInvitation[]
  auditLogs         AuditLog[]
  refreshTokens     RefreshToken[]

  @@map("tenants")
}

// =============================================
// USER — Personas que acceden a la plataforma
// =============================================
model User {
  id                          String    @id @default(uuid()) @db.Uuid
  email                       String    @unique @db.VarChar(255)
  passwordHash                String    @map("password_hash") @db.VarChar(255)
  fullName                    String    @map("full_name") @db.VarChar(255)
  avatarUrl                   String?   @map("avatar_url")
  tenantId                    String    @map("tenant_id") @db.Uuid
  role                        UserRole  @default(owner)
  status                      UserStatus @default(pending)
  isVerified                  Boolean   @default(false) @map("is_verified")
  verificationToken           String?   @map("verification_token") @db.Uuid
  verificationTokenExpiresAt  DateTime? @map("verification_token_expires_at") @db.Timestamptz
  resetPasswordToken          String?   @map("reset_password_token") @db.Uuid
  resetPasswordExpiresAt      DateTime? @map("reset_password_expires_at") @db.Timestamptz
  lastLoginAt                 DateTime? @map("last_login_at") @db.Timestamptz
  createdAt                   DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt                   DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  // Relaciones
  tenant          Tenant           @relation("TenantUsers", fields: [tenantId], references: [id], onDelete: Cascade)
  ownedTenants    Tenant[]         @relation("TenantOwner")
  refreshTokens   RefreshToken[]
  auditLogs       AuditLog[]
  scheduledJobs   ScheduledJob[]   @relation("JobCreator")
  invitationsSent TeamInvitation[] @relation("InvitedBy")

  @@index([email])
  @@index([tenantId])
  @@index([verificationToken])
  @@index([resetPasswordToken])
  @@map("users")
}

enum UserRole {
  owner
  editor
  viewer
}

enum UserStatus {
  pending
  active
  suspended
}

// =============================================
// CREDENTIAL — API keys encriptadas, por tenant
// =============================================
model Credential {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  name      String   @db.VarChar(100)
  value     String                                    // Encriptado AES-256-GCM
  category  String   @db.VarChar(50)                  // "meta", "twitter", "google", "webhook", "ai"
  isValid   Boolean  @default(true) @map("is_valid")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, name])
  @@index([tenantId])
  @@index([tenantId, category])
  @@map("credentials")
}

// =============================================
// BUSINESS_ASSET — Facebook Pages, Instagram accounts
// =============================================
model BusinessAsset {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @map("tenant_id") @db.Uuid
  assetType  String   @map("asset_type") @db.VarChar(50)
  externalId String   @map("external_id") @db.VarChar(255)
  name       String?  @db.VarChar(255)
  metadata   Json     @default("{}")
  isActive   Boolean  @default(true) @map("is_active")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt  DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, externalId])
  @@index([tenantId])
  @@index([tenantId, assetType])
  @@map("business_assets")
}

// =============================================
// PUBLICATION — Notas generadas
// =============================================
model Publication {
  id             String          @id @default(uuid()) @db.Uuid
  tenantId       String          @map("tenant_id") @db.Uuid
  title          String?
  content        String?
  imagePath      String?         @map("image_path")
  imageUrl       String?         @map("image_url")
  source         PublicationSource @default(manual)
  publishResults Json            @default("{}") @map("publish_results")
  createdAt      DateTime        @default(now()) @map("created_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([tenantId, createdAt(sort: Desc)])
  @@map("publications")
}

enum PublicationSource {
  pipeline
  manual
  scheduled
}

// =============================================
// TRANSCRIPTION
// =============================================
model Transcription {
  id              String            @id @default(uuid()) @db.Uuid
  tenantId        String            @map("tenant_id") @db.Uuid
  text            String
  audioFile       String?           @map("audio_file")
  source          PublicationSource @default(manual)
  durationSeconds Int?              @map("duration_seconds")
  createdAt       DateTime          @default(now()) @map("created_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([tenantId, createdAt(sort: Desc)])
  @@map("transcriptions")
}

// =============================================
// SETTING — Config key-value por tenant
// =============================================
model Setting {
  tenantId  String   @map("tenant_id") @db.Uuid
  key       String   @db.VarChar(100)
  value     String?
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@id([tenantId, key])
  @@map("settings")
}

// =============================================
// CUSTOM_AGENT — Agentes IA del pipeline
// =============================================
model CustomAgent {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @map("tenant_id") @db.Uuid
  name        String   @db.VarChar(255)
  description String?
  systemPrompt String  @map("system_prompt")
  position    Int      @default(0)
  afterStep   String?  @map("after_step") @db.VarChar(50)
  isEnabled   Boolean  @default(true) @map("is_enabled")
  aiProvider  String   @default("auto") @map("ai_provider") @db.VarChar(50)
  temperature Float    @default(0.7)
  maxTokens   Int      @default(2000) @map("max_tokens")
  tools       Json     @default("[]")
  templateId  String?  @map("template_id") @db.VarChar(100)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@map("custom_agents")
}

// =============================================
// PIPELINE_CONFIG
// =============================================
model PipelineConfig {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  name      String   @default("default") @db.VarChar(255)
  nodeOrder Json     @default("[]") @map("node_order")
  isActive  Boolean  @default(true) @map("is_active")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@map("pipeline_configs")
}

// =============================================
// PLAN — Planes de suscripción
// =============================================
model Plan {
  id                       String   @id @default(uuid()) @db.Uuid
  name                     String   @unique @db.VarChar(50)
  displayName              String   @map("display_name") @db.VarChar(100)
  description              String?
  priceUsd                 Decimal  @default(0) @map("price_usd") @db.Decimal(10, 2)
  priceUsdYearly           Decimal? @map("price_usd_yearly") @db.Decimal(10, 2)
  priceArs                 Decimal? @map("price_ars") @db.Decimal(10, 2)
  priceArsYearly           Decimal? @map("price_ars_yearly") @db.Decimal(10, 2)
  stripePriceIdMonthly     String?  @map("stripe_price_id_monthly") @db.VarChar(255)
  stripePriceIdYearly      String?  @map("stripe_price_id_yearly") @db.VarChar(255)
  mpPlanIdMonthly          String?  @map("mp_plan_id_monthly") @db.VarChar(255)
  mpPlanIdYearly           String?  @map("mp_plan_id_yearly") @db.VarChar(255)
  maxPipelineHoursPerMonth Int?     @map("max_pipeline_hours_per_month")
  maxPublicationsPerMonth  Int?     @map("max_publications_per_month")
  maxScheduledJobs         Int?     @map("max_scheduled_jobs")
  maxCustomAgents          Int?     @map("max_custom_agents")
  maxTeamMembers           Int      @default(1) @map("max_team_members")
  maxConnectedPlatforms    Int?     @map("max_connected_platforms")
  maxStorageGb             Int      @default(5) @map("max_storage_gb")
  features                 Json     @default("{}")
  isActive                 Boolean  @default(true) @map("is_active")
  sortOrder                Int      @default(0) @map("sort_order")
  createdAt                DateTime @default(now()) @map("created_at") @db.Timestamptz

  subscriptions Subscription[]

  @@map("plans")
}

// =============================================
// SUBSCRIPTION — Una por tenant, obligatoria
// =============================================
model Subscription {
  id                     String             @id @default(uuid()) @db.Uuid
  tenantId               String             @unique @map("tenant_id") @db.Uuid
  planId                 String             @map("plan_id") @db.Uuid
  status                 SubscriptionStatus @default(trialing)
  trialEndsAt            DateTime?          @map("trial_ends_at") @db.Timestamptz
  currentPeriodStart     DateTime?          @map("current_period_start") @db.Timestamptz
  currentPeriodEnd       DateTime?          @map("current_period_end") @db.Timestamptz
  billingPeriod          String?            @default("monthly") @map("billing_period") @db.VarChar(20)
  paymentProvider        String?            @map("payment_provider") @db.VarChar(20)
  externalSubscriptionId String?            @map("external_subscription_id") @db.VarChar(255)
  externalCustomerId     String?            @map("external_customer_id") @db.VarChar(255)
  cancelAtPeriodEnd      Boolean            @default(false) @map("cancel_at_period_end")
  canceledAt             DateTime?          @map("canceled_at") @db.Timestamptz
  createdAt              DateTime           @default(now()) @map("created_at") @db.Timestamptz
  updatedAt              DateTime           @updatedAt @map("updated_at") @db.Timestamptz

  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  plan     Plan      @relation(fields: [planId], references: [id])
  invoices Invoice[]

  @@index([status])
  @@index([externalSubscriptionId])
  @@map("subscriptions")
}

enum SubscriptionStatus {
  trialing
  active
  past_due
  canceled
  suspended
  expired
}

// =============================================
// USAGE_RECORD — Tracking mensual de uso
// =============================================
model UsageRecord {
  id                  String   @id @default(uuid()) @db.Uuid
  tenantId            String   @map("tenant_id") @db.Uuid
  periodStart         DateTime @map("period_start") @db.Date
  pipelineHoursUsed   Decimal  @default(0) @map("pipeline_hours_used") @db.Decimal(10, 2)
  publicationsCount   Int      @default(0) @map("publications_count")
  transcriptionMinutes Decimal @default(0) @map("transcription_minutes") @db.Decimal(10, 2)
  aiTokensUsed        BigInt   @default(0) @map("ai_tokens_used")
  storageUsedMb       Decimal  @default(0) @map("storage_used_mb") @db.Decimal(10, 2)
  updatedAt           DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, periodStart])
  @@map("usage_records")
}

// =============================================
// INVOICE — Historial de pagos
// =============================================
model Invoice {
  id                 String        @id @default(uuid()) @db.Uuid
  tenantId           String        @map("tenant_id") @db.Uuid
  subscriptionId     String?       @map("subscription_id") @db.Uuid
  planName           String?       @map("plan_name") @db.VarChar(100)
  amount             Decimal       @db.Decimal(10, 2)
  currency           String        @default("USD") @db.VarChar(3)
  status             InvoiceStatus @default(pending)
  paymentProvider    String?       @map("payment_provider") @db.VarChar(20)
  externalInvoiceId  String?       @map("external_invoice_id") @db.VarChar(255)
  externalPaymentId  String?       @map("external_payment_id") @db.VarChar(255)
  billingPeriodStart DateTime?     @map("billing_period_start") @db.Timestamptz
  billingPeriodEnd   DateTime?     @map("billing_period_end") @db.Timestamptz
  paidAt             DateTime?     @map("paid_at") @db.Timestamptz
  createdAt          DateTime      @default(now()) @map("created_at") @db.Timestamptz

  tenant       Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  subscription Subscription? @relation(fields: [subscriptionId], references: [id])

  @@index([tenantId, createdAt(sort: Desc)])
  @@map("invoices")
}

enum InvoiceStatus {
  pending
  paid
  failed
  refunded
}

// =============================================
// SCHEDULED_JOB — Programaciones de procesamiento
// =============================================
model ScheduledJob {
  id              String       @id @default(uuid()) @db.Uuid
  tenantId        String       @map("tenant_id") @db.Uuid
  createdById     String       @map("created_by") @db.Uuid
  name            String       @db.VarChar(255)
  description     String?
  streamUrl       String       @map("stream_url")
  scheduleType    ScheduleType @map("schedule_type")
  daysOfWeek      Int[]        @default([]) @map("days_of_week")
  startTime       String       @map("start_time") @db.VarChar(5)   // "HH:MM"
  durationMinutes Int          @map("duration_minutes")
  timezone        String       @default("America/Argentina/Buenos_Aires") @db.VarChar(50)
  scheduledDate   DateTime?    @map("scheduled_date") @db.Date
  pipelineConfig  Json         @default("{}") @map("pipeline_config")
  isActive        Boolean      @default(true) @map("is_active")
  lastRunAt       DateTime?    @map("last_run_at") @db.Timestamptz
  lastRunStatus   String?      @map("last_run_status") @db.VarChar(20)
  nextRunAt       DateTime?    @map("next_run_at") @db.Timestamptz
  notifyOnComplete Boolean     @default(true) @map("notify_on_complete")
  notifyOnError    Boolean     @default(true) @map("notify_on_error")
  notificationEmail String?    @map("notification_email") @db.VarChar(255)
  createdAt       DateTime     @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime     @updatedAt @map("updated_at") @db.Timestamptz

  tenant     Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  createdBy  User            @relation("JobCreator", fields: [createdById], references: [id])
  executions JobExecution[]

  @@index([tenantId])
  @@index([nextRunAt, isActive])
  @@map("scheduled_jobs")
}

enum ScheduleType {
  recurring
  one_time
}

// =============================================
// JOB_EXECUTION — Historial de ejecuciones
// =============================================
model JobExecution {
  id                    String           @id @default(uuid()) @db.Uuid
  jobId                 String           @map("job_id") @db.Uuid
  tenantId              String           @map("tenant_id") @db.Uuid
  status                JobExecutionStatus @default(pending)
  scheduledFor          DateTime         @map("scheduled_for") @db.Timestamptz
  startedAt             DateTime?        @map("started_at") @db.Timestamptz
  finishedAt            DateTime?        @map("finished_at") @db.Timestamptz
  publicationsGenerated Int              @default(0) @map("publications_generated")
  transcriptionMinutes  Decimal          @default(0) @map("transcription_minutes") @db.Decimal(10, 2)
  topicsDetected        Int              @default(0) @map("topics_detected")
  errorMessage          String?          @map("error_message")
  errorCount            Int              @default(0) @map("error_count")
  executionLog          Json             @default("[]") @map("execution_log")
  createdAt             DateTime         @default(now()) @map("created_at") @db.Timestamptz

  job    ScheduledJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  tenant Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([jobId])
  @@index([tenantId, createdAt(sort: Desc)])
  @@map("job_executions")
}

enum JobExecutionStatus {
  pending
  running
  completed
  failed
  canceled
  timeout
}

// =============================================
// DAILY_METRIC — Métricas diarias para analytics
// =============================================
model DailyMetric {
  id                     String   @id @default(uuid()) @db.Uuid
  tenantId               String   @map("tenant_id") @db.Uuid
  metricDate             DateTime @map("metric_date") @db.Date
  pipelineRuns           Int      @default(0) @map("pipeline_runs")
  pipelineMinutes        Decimal  @default(0) @map("pipeline_minutes") @db.Decimal(10, 2)
  scheduledRuns          Int      @default(0) @map("scheduled_runs")
  scheduledMinutes       Decimal  @default(0) @map("scheduled_minutes") @db.Decimal(10, 2)
  publicationsGenerated  Int      @default(0) @map("publications_generated")
  publicationsAuto       Int      @default(0) @map("publications_auto")
  publicationsManual     Int      @default(0) @map("publications_manual")
  publicationsScheduled  Int      @default(0) @map("publications_scheduled")
  transcriptionChunks    Int      @default(0) @map("transcription_chunks")
  transcriptionMinutes   Decimal  @default(0) @map("transcription_minutes") @db.Decimal(10, 2)
  topicsDetected         Int      @default(0) @map("topics_detected")
  aiTokensUsed           BigInt   @default(0) @map("ai_tokens_used")
  agentsExecuted         Int      @default(0) @map("agents_executed")
  twitterPosts           Int      @default(0) @map("twitter_posts")
  facebookPosts          Int      @default(0) @map("facebook_posts")
  instagramPosts         Int      @default(0) @map("instagram_posts")
  webhookCalls           Int      @default(0) @map("webhook_calls")
  pipelineErrors         Int      @default(0) @map("pipeline_errors")
  publishErrors          Int      @default(0) @map("publish_errors")
  createdAt              DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, metricDate])
  @@index([tenantId, metricDate(sort: Desc)])
  @@map("daily_metrics")
}

// =============================================
// TEAM_INVITATION — Invitaciones a miembros
// =============================================
model TeamInvitation {
  id         String           @id @default(uuid()) @db.Uuid
  tenantId   String           @map("tenant_id") @db.Uuid
  invitedById String          @map("invited_by") @db.Uuid
  email      String           @db.VarChar(255)
  role       UserRole         @default(editor)
  token      String           @default(uuid()) @db.Uuid
  status     InvitationStatus @default(pending)
  expiresAt  DateTime         @map("expires_at") @db.Timestamptz
  acceptedAt DateTime?        @map("accepted_at") @db.Timestamptz
  createdAt  DateTime         @default(now()) @map("created_at") @db.Timestamptz

  tenant    Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  invitedBy User   @relation("InvitedBy", fields: [invitedById], references: [id])

  @@index([token])
  @@index([tenantId])
  @@map("team_invitations")
}

enum InvitationStatus {
  pending
  accepted
  expired
  revoked
}

// =============================================
// REFRESH_TOKEN — Para invalidación de sesiones
// =============================================
model RefreshToken {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  tenantId  String   @map("tenant_id") @db.Uuid
  tokenHash String   @map("token_hash") @db.VarChar(255)
  expiresAt DateTime @map("expires_at") @db.Timestamptz
  isRevoked Boolean  @default(false) @map("is_revoked")
  userAgent String?  @map("user_agent")
  ipAddress String?  @map("ip_address") @db.VarChar(45)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([tokenHash])
  @@map("refresh_tokens")
}

// =============================================
// AUDIT_LOG — Acciones de seguridad
// =============================================
model AuditLog {
  id        String   @id @default(uuid()) @db.Uuid
  tenantId  String?  @map("tenant_id") @db.Uuid
  userId    String?  @map("user_id") @db.Uuid
  action    String   @db.VarChar(100)
  ipAddress String?  @map("ip_address") @db.VarChar(45)
  userAgent String?  @map("user_agent")
  metadata  Json     @default("{}")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz

  tenant Tenant? @relation(fields: [tenantId], references: [id], onDelete: SetNull)
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([tenantId])
  @@index([createdAt(sort: Desc)])
  @@map("audit_log")
}
```

---

## 4. Prisma Client Singleton

### `src/server/lib/prisma.ts`

```typescript
import { PrismaClient } from '@prisma/client';

// Singleton pattern — evita múltiples instancias en hot-reload (desarrollo)
const globalForPrisma = globalThis as unknown as {
    prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
    log: process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = prisma;
}

// Graceful shutdown
export async function disconnectPrisma(): Promise<void> {
    await prisma.$disconnect();
}
```

---

## 5. Workflow de Migraciones

### Desarrollo

```bash
# Crear migración después de cambiar schema.prisma
npx prisma migrate dev --name init
npx prisma migrate dev --name add_billing_tables
npx prisma migrate dev --name add_scheduled_jobs

# Regenerar el cliente TypeScript (automático con migrate dev)
npx prisma generate

# Abrir Prisma Studio para inspeccionar datos
npx prisma studio

# Reset completo (DESTRUCTIVO — solo en desarrollo)
npx prisma migrate reset
```

### Producción

```bash
# Aplicar migraciones pendientes (NO destructivo)
npx prisma migrate deploy

# Esto se ejecuta en el Dockerfile o en el entrypoint del servicio
```

### Estructura generada

```
prisma/
├── schema.prisma                    # Schema completo (fuente de verdad)
├── migrations/
│   ├── 20260323_init/
│   │   └── migration.sql            # SQL generado automáticamente
│   ├── 20260324_add_billing/
│   │   └── migration.sql
│   └── migration_lock.toml          # Lock del provider
└── seed.ts                          # Seed de datos iniciales
```

---

## 6. Seed de Datos Iniciales

### `prisma/seed.ts`

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Seeding database...');

    // Crear planes
    await prisma.plan.createMany({
        data: [
            {
                name: 'trial',
                displayName: 'Trial Gratuito',
                description: 'Prueba la plataforma por 7 días',
                priceUsd: 0,
                maxPipelineHoursPerMonth: 5,
                maxPublicationsPerMonth: 20,
                maxScheduledJobs: 1,
                maxCustomAgents: 2,
                maxTeamMembers: 1,
                maxConnectedPlatforms: 2,
                maxStorageGb: 2,
                features: {
                    webhook_integration: false,
                    custom_branding: false,
                    api_access: false,
                    priority_transcription: false,
                    advanced_analytics: false,
                    image_ai_generation: true,
                    multi_provider_ai: false,
                    scheduled_processing: false,
                },
                sortOrder: 0,
            },
            {
                name: 'starter',
                displayName: 'Starter',
                description: 'Para creadores y programas individuales',
                priceUsd: 29,
                priceUsdYearly: 290,
                maxPipelineHoursPerMonth: 30,
                maxPublicationsPerMonth: 100,
                maxScheduledJobs: 3,
                maxCustomAgents: 5,
                maxTeamMembers: 2,
                maxConnectedPlatforms: 4,
                maxStorageGb: 10,
                features: {
                    webhook_integration: true,
                    custom_branding: false,
                    api_access: false,
                    priority_transcription: false,
                    advanced_analytics: false,
                    image_ai_generation: true,
                    multi_provider_ai: false,
                    scheduled_processing: true,
                },
                sortOrder: 1,
            },
            {
                name: 'professional',
                displayName: 'Profesional',
                description: 'Para medios de comunicación y equipos',
                priceUsd: 79,
                priceUsdYearly: 790,
                maxPipelineHoursPerMonth: 120,
                maxPublicationsPerMonth: 500,
                maxScheduledJobs: 10,
                maxCustomAgents: 20,
                maxTeamMembers: 5,
                maxConnectedPlatforms: 8,
                maxStorageGb: 50,
                features: {
                    webhook_integration: true,
                    custom_branding: true,
                    api_access: true,
                    priority_transcription: true,
                    advanced_analytics: true,
                    image_ai_generation: true,
                    multi_provider_ai: true,
                    scheduled_processing: true,
                },
                sortOrder: 2,
            },
            {
                name: 'enterprise',
                displayName: 'Enterprise',
                description: 'Para grandes medios y redes de canales',
                priceUsd: 199,
                priceUsdYearly: 1990,
                maxTeamMembers: 20,
                maxStorageGb: 200,
                features: {
                    webhook_integration: true,
                    custom_branding: true,
                    api_access: true,
                    priority_transcription: true,
                    advanced_analytics: true,
                    image_ai_generation: true,
                    multi_provider_ai: true,
                    scheduled_processing: true,
                },
                sortOrder: 3,
            },
        ],
        skipDuplicates: true,
    });

    console.log('Seed completed.');
}

main()
    .catch((e) => {
        console.error('Seed error:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
```

### Configurar seed en `package.json`

```json
{
  "prisma": {
    "seed": "tsx prisma/seed.ts"
  }
}
```

### Ejecutar seed

```bash
npx prisma db seed
```

---

## 7. Auth Service con Prisma

### `src/server/services/authService.ts`

```typescript
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail } from './emailService.js';
import slugify from 'slugify';
import { UserRole, UserStatus } from '@prisma/client';

const BCRYPT_ROUNDS = 12;
const JWT_SECRET = process.env.JWT_SECRET!;
const JWT_EXPIRES_IN = '7d';
const VERIFICATION_TOKEN_TTL_HOURS = 48;
const RESET_TOKEN_TTL_HOURS = 1;

// =============================================
// REGISTRO
// =============================================
export async function register(input: {
    email: string;
    password: string;
    fullName: string;
    organizationName: string;
}) {
    const { email, password, fullName, organizationName } = input;
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Verificar email único
    const existing = await prisma.user.findUnique({
        where: { email: normalizedEmail },
    });
    if (existing) {
        throw new AppError('Este email ya está registrado', 409);
    }

    // 2. Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // 3. Generar slug único
    let slug = slugify(organizationName, { lower: true, strict: true });
    const slugExists = await prisma.tenant.findUnique({ where: { slug } });
    if (slugExists) {
        slug = `${slug}-${Date.now().toString(36)}`;
    }

    // 4. Generar verification token
    const verificationToken = crypto.randomUUID();
    const tokenExpires = new Date(
        Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000
    );

    // 5. Transacción: crear tenant + user + subscription trial
    const result = await prisma.$transaction(async (tx) => {
        // Crear tenant
        const tenant = await tx.tenant.create({
            data: {
                name: organizationName,
                slug,
                platformName: organizationName,
            },
        });

        // Crear user
        const user = await tx.user.create({
            data: {
                email: normalizedEmail,
                passwordHash,
                fullName,
                tenantId: tenant.id,
                role: UserRole.owner,
                status: UserStatus.pending,
                verificationToken,
                verificationTokenExpiresAt: tokenExpires,
            },
        });

        // Setear owner_id en tenant
        await tx.tenant.update({
            where: { id: tenant.id },
            data: { ownerId: user.id },
        });

        // Crear subscription trial
        const trialPlan = await tx.plan.findUnique({ where: { name: 'trial' } });
        if (trialPlan) {
            await tx.subscription.create({
                data: {
                    tenantId: tenant.id,
                    planId: trialPlan.id,
                    status: 'trialing',
                    trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
            });
        }

        return { userId: user.id, tenantId: tenant.id, verificationToken };
    });

    // 6. Email de verificación (no-blocking)
    sendVerificationEmail(normalizedEmail, fullName, result.verificationToken).catch(console.error);

    // 7. Audit log
    await prisma.auditLog.create({
        data: {
            tenantId: result.tenantId,
            userId: result.userId,
            action: 'register',
            metadata: { email: normalizedEmail },
        },
    });

    return { message: 'Cuenta creada. Revisa tu email para verificar tu cuenta.' };
}

// =============================================
// VERIFICACIÓN DE EMAIL
// =============================================
export async function verifyEmail(token: string) {
    const user = await prisma.user.findFirst({
        where: { verificationToken: token, isVerified: false },
    });

    if (!user) throw new AppError('Token de verificación inválido o ya utilizado', 400);

    if (user.verificationTokenExpiresAt && new Date() > user.verificationTokenExpiresAt) {
        throw new AppError('Token de verificación expirado. Solicita uno nuevo.', 400);
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            isVerified: true,
            status: UserStatus.active,
            verificationToken: null,
            verificationTokenExpiresAt: null,
        },
    });

    sendWelcomeEmail(user.email, user.fullName).catch(console.error);

    await prisma.auditLog.create({
        data: { tenantId: user.tenantId, userId: user.id, action: 'email_verified' },
    });

    return { message: 'Email verificado exitosamente. Ya puedes iniciar sesión.' };
}

// =============================================
// LOGIN
// =============================================
export async function login(
    input: { email: string; password: string },
    ipAddress?: string,
    userAgent?: string
) {
    const normalizedEmail = input.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: {
            tenant: {
                select: {
                    id: true, name: true, slug: true,
                    platformName: true, logoUrl: true, timezone: true,
                },
            },
        },
    });

    if (!user) throw new AppError('Credenciales inválidas', 401);

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
        await prisma.auditLog.create({
            data: {
                tenantId: user.tenantId, userId: user.id,
                action: 'login_failed', ipAddress,
                metadata: { reason: 'invalid_password' },
            },
        });
        throw new AppError('Credenciales inválidas', 401);
    }

    if (user.status === UserStatus.suspended) {
        throw new AppError('Tu cuenta está suspendida. Contacta soporte.', 403);
    }

    if (!user.isVerified) {
        throw new AppError(
            'Debes verificar tu email antes de iniciar sesión.',
            403, 'EMAIL_NOT_VERIFIED'
        );
    }

    const payload = {
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
        role: user.role,
    };

    const accessToken = jwt.sign(payload, JWT_SECRET, {
        expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256',
    });

    await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
    });

    await prisma.auditLog.create({
        data: {
            tenantId: user.tenantId, userId: user.id,
            action: 'login_success', ipAddress, userAgent,
        },
    });

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            role: user.role, status: user.status, isVerified: user.isVerified,
        },
        tenant: user.tenant,
        accessToken,
    };
}

// =============================================
// GET ME
// =============================================
export async function getMe(userId: string) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            tenant: true,
        },
    });
    if (!user) throw new AppError('Usuario no encontrado', 404);

    const subscription = await prisma.subscription.findUnique({
        where: { tenantId: user.tenantId },
        include: { plan: true },
    });

    // Calcular trial days remaining
    let trialDaysRemaining: number | null = null;
    if (subscription?.status === 'trialing' && subscription.trialEndsAt) {
        const msRemaining = subscription.trialEndsAt.getTime() - Date.now();
        trialDaysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));

        if (trialDaysRemaining === 0) {
            await prisma.subscription.update({
                where: { id: subscription.id },
                data: { status: 'expired' },
            });
        }
    }

    return {
        user: {
            id: user.id, email: user.email, fullName: user.fullName,
            avatarUrl: user.avatarUrl, role: user.role, status: user.status,
            isVerified: user.isVerified, lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
        },
        tenant: {
            id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug,
            platformName: user.tenant.platformName, logoUrl: user.tenant.logoUrl,
            timezone: user.tenant.timezone, config: user.tenant.config,
        },
        subscription: subscription ? {
            id: subscription.id,
            status: subscription.status,
            planName: subscription.plan.name,
            planDisplayName: subscription.plan.displayName,
            priceUsd: Number(subscription.plan.priceUsd),
            billingPeriod: subscription.billingPeriod,
            trialEndsAt: subscription.trialEndsAt,
            trialDaysRemaining,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            limits: {
                maxPipelineHoursPerMonth: subscription.plan.maxPipelineHoursPerMonth,
                maxPublicationsPerMonth: subscription.plan.maxPublicationsPerMonth,
                maxScheduledJobs: subscription.plan.maxScheduledJobs,
                maxCustomAgents: subscription.plan.maxCustomAgents,
                maxTeamMembers: subscription.plan.maxTeamMembers,
                maxConnectedPlatforms: subscription.plan.maxConnectedPlatforms,
                maxStorageGb: subscription.plan.maxStorageGb,
            },
            features: subscription.plan.features as Record<string, boolean>,
        } : null,
    };
}

// =============================================
// FORGOT PASSWORD
// =============================================
export async function forgotPassword(email: string) {
    const genericResponse = {
        message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña.',
    };

    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
    });
    if (!user) return genericResponse;

    const resetToken = crypto.randomUUID();
    const tokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 60 * 60 * 1000);

    await prisma.user.update({
        where: { id: user.id },
        data: { resetPasswordToken: resetToken, resetPasswordExpiresAt: tokenExpires },
    });

    sendPasswordResetEmail(user.email, user.fullName, resetToken).catch(console.error);

    return genericResponse;
}

// =============================================
// RESET PASSWORD
// =============================================
export async function resetPassword(token: string, newPassword: string) {
    const user = await prisma.user.findFirst({
        where: { resetPasswordToken: token },
    });

    if (!user) throw new AppError('Token inválido o ya utilizado', 400);

    if (user.resetPasswordExpiresAt && new Date() > user.resetPasswordExpiresAt) {
        throw new AppError('Token expirado. Solicita uno nuevo.', 400);
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await prisma.$transaction([
        prisma.user.update({
            where: { id: user.id },
            data: {
                passwordHash,
                resetPasswordToken: null,
                resetPasswordExpiresAt: null,
            },
        }),
        prisma.refreshToken.updateMany({
            where: { userId: user.id },
            data: { isRevoked: true },
        }),
        prisma.auditLog.create({
            data: { tenantId: user.tenantId, userId: user.id, action: 'password_reset' },
        }),
    ]);

    return { message: 'Contraseña actualizada exitosamente.' };
}

// =============================================
// RESEND VERIFICATION
// =============================================
export async function resendVerification(email: string) {
    const genericResponse = {
        message: 'Si el email existe y no está verificado, recibirás un nuevo enlace.',
    };

    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
    });

    if (!user || user.isVerified) return genericResponse;

    const verificationToken = crypto.randomUUID();
    const tokenExpires = new Date(
        Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000
    );

    await prisma.user.update({
        where: { id: user.id },
        data: { verificationToken, verificationTokenExpiresAt: tokenExpires },
    });

    sendVerificationEmail(user.email, user.fullName, verificationToken).catch(console.error);

    return genericResponse;
}

// =============================================
// UPDATE PROFILE
// =============================================
export async function updateProfile(
    userId: string,
    data: { fullName?: string; avatarUrl?: string; currentPassword?: string; newPassword?: string }
) {
    const updateData: Record<string, any> = {};

    if (data.fullName) updateData.fullName = data.fullName;
    if (data.avatarUrl !== undefined) updateData.avatarUrl = data.avatarUrl;

    if (data.newPassword) {
        if (!data.currentPassword) throw new AppError('Debes proporcionar tu contraseña actual', 400);

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new AppError('Usuario no encontrado', 404);

        const valid = await bcrypt.compare(data.currentPassword, user.passwordHash);
        if (!valid) throw new AppError('Contraseña actual incorrecta', 400);

        updateData.passwordHash = await bcrypt.hash(data.newPassword, BCRYPT_ROUNDS);
    }

    if (Object.keys(updateData).length === 0) {
        throw new AppError('No hay cambios para actualizar', 400);
    }

    await prisma.user.update({ where: { id: userId }, data: updateData });

    return { message: 'Perfil actualizado.' };
}

// =============================================
// CLASE DE ERROR CUSTOM
// =============================================
export class AppError extends Error {
    constructor(message: string, public statusCode: number = 400, public code?: string) {
        super(message);
        this.name = 'AppError';
    }
}
```

---

## 8. Refactor de databaseService.ts → Prisma

El archivo `databaseService.ts` actual con ~600 líneas de funciones síncronas se reemplaza por llamadas directas a `prisma` en cada servicio. **Ya no se necesita un archivo centralizado de DB** — Prisma Client se importa donde se necesite.

### Ejemplo de migración de funciones existentes

```typescript
// ======== ANTES (SQLite, síncrono, sin tenant) ========
import { getDb } from './databaseService.js';

export function getAllPublications(limit = 50, offset = 0) {
    const db = getDb();
    const items = db.prepare(
        'SELECT * FROM publications ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) as count FROM publications').get();
    return { items, total: total.count };
}

// ======== DESPUÉS (Prisma, async, con tenant) ========
import { prisma } from '../lib/prisma.js';

export async function getAllPublications(tenantId: string, limit = 50, offset = 0) {
    const [items, total] = await prisma.$transaction([
        prisma.publication.findMany({
            where: { tenantId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
        }),
        prisma.publication.count({ where: { tenantId } }),
    ]);

    return { items, total };
}
```

### Tabla completa de migración

| Función Actual | Prisma Equivalente |
|---|---|
| `getSetting(key)` | `prisma.setting.findUnique({ where: { tenantId_key: { tenantId, key } } })` |
| `setSetting(key, val)` | `prisma.setting.upsert({ where: { tenantId_key: { tenantId, key } }, update: { value }, create: { tenantId, key, value } })` |
| `setCredential(name, val, cat)` | `prisma.credential.upsert({ where: { tenantId_name: { tenantId, name } }, ... })` |
| `getCredential(name)` | `prisma.credential.findUnique({ where: { tenantId_name: { tenantId, name } } })` |
| `upsertAsset(...)` | `prisma.businessAsset.upsert({ where: { tenantId_externalId: { tenantId, externalId } }, ... })` |
| `getAllActiveAssets()` | `prisma.businessAsset.findMany({ where: { tenantId, isActive: true } })` |
| `isMetaConnected()` | `const count = await prisma.credential.count({ where: { tenantId, name: 'meta_user_access_token', isValid: true } })` |
| `createPublication(input)` | `prisma.publication.create({ data: { tenantId, ...input } })` |
| `getAllPublications(l, o)` | `prisma.publication.findMany({ where: { tenantId }, take: l, skip: o, orderBy: { createdAt: 'desc' } })` |
| `deletePublication(id)` | `prisma.publication.delete({ where: { id, tenantId } })` |
| `createTranscription(input)` | `prisma.transcription.create({ data: { tenantId, ...input } })` |
| `createAgent(agent)` | `prisma.customAgent.create({ data: { tenantId, ...agent } })` |
| `getAllAgents()` | `prisma.customAgent.findMany({ where: { tenantId }, orderBy: [{ afterStep: 'asc' }, { position: 'asc' }] })` |
| `updateAgent(id, data)` | `prisma.customAgent.update({ where: { id }, data })` |
| `deleteAgent(id)` | `prisma.customAgent.delete({ where: { id } })` |
| `getActivePipelineConfig()` | `prisma.pipelineConfig.findFirst({ where: { tenantId, isActive: true } })` |
| `savePipelineConfig(cfg)` | `prisma.pipelineConfig.upsert({ where: { ... }, ... })` |
| `resetPipelineConfig()` | `prisma.pipelineConfig.deleteMany({ where: { tenantId } })` |

---

## 9. Middleware (sin cambios respecto a la spec anterior)

Los middlewares de auth, security, error handler y rate limiting se mantienen idénticos porque no dependen del ORM. Ver sección 5 de la spec original para:

- `src/server/middleware/auth.ts` — requireAuth, requireRole
- `src/server/middleware/security.ts` — Security headers
- `src/server/middleware/errorHandler.ts` — Error handler centralizado
- `src/server/middleware/rateLimiter.ts` — Rate limiting

---

## 10. Email Service (sin cambios)

El `emailService.ts` se mantiene idéntico — no depende del ORM. Ver sección 6 de la spec original.

---

## 11. Cambios en `src/server/index.ts`

```typescript
// CAMBIO CLAVE: Ya no se llama a initDatabase()
// Prisma se conecta automáticamente en la primera query (lazy connection)

import { prisma, disconnectPrisma } from './lib/prisma.js';

// Verificar conexión al inicio
async function startup() {
    try {
        await prisma.$connect();
        console.log('[Prisma] Conectado a PostgreSQL');
    } catch (error) {
        console.error('[Prisma] Error de conexión:', error);
        process.exit(1);
    }
}

startup();

// Graceful shutdown
async function gracefulShutdown() {
    console.log('\n[Server] Cerrando servidor...');
    await disconnectPrisma();
    httpServer.close(() => {
        console.log('[Server] Servidor cerrado.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
}
```

---

## 12. Variables de Entorno

```env
# === DATABASE (Prisma) ===
DATABASE_URL="postgresql://periodistapp:password@localhost:5432/periodistapp?schema=public"

# === AUTH ===
JWT_SECRET=cambia-esto-a-un-string-de-al-menos-32-caracteres-random

# === EMAIL ===
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=noreply@periodistapp.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx
FRONTEND_URL=http://localhost:5173

# === REDIS ===
REDIS_URL=redis://localhost:6379

# === CORS ===
CORS_ORIGINS=http://localhost:5173,http://localhost:3000

# === EXISTENTES (se mantienen) ===
ENCRYPTION_KEY=...
DEEPSEEK_API_KEY=...
GEMINI_API_KEY=...
```

---

## 13. Scripts en package.json

```json
{
  "scripts": {
    "dev:server": "tsx watch src/server/index.ts",
    "dev:client": "vite",
    "dev": "concurrently \"npm:dev:server\" \"npm:dev:client\"",
    "build:client": "vite build",
    "build:server": "tsc",
    "start": "node dist/server/index.js",

    "db:migrate": "prisma migrate dev",
    "db:migrate:deploy": "prisma migrate deploy",
    "db:generate": "prisma generate",
    "db:seed": "prisma db seed",
    "db:studio": "prisma studio",
    "db:reset": "prisma migrate reset",

    "postinstall": "prisma generate"
  },
  "prisma": {
    "seed": "tsx prisma/seed.ts"
  }
}
```

---

## 14. Archivos que se eliminan vs crean

### Se eliminan:
| Archivo | Razón |
|---------|-------|
| `src/server/services/databaseService.ts` | Reemplazado por Prisma Client directo |
| `src/server/data/credentials.db` | Migrado a PostgreSQL |
| `db/init.sql` | Reemplazado por `prisma/schema.prisma` + migraciones |

### Se crean:
| Archivo | Propósito |
|---------|-----------|
| `prisma/schema.prisma` | Schema completo (fuente de verdad del modelo de datos) |
| `prisma/seed.ts` | Seed de planes iniciales |
| `prisma/migrations/` | Directorio auto-generado con migraciones SQL |
| `src/server/lib/prisma.ts` | Prisma Client singleton |
| `src/server/services/authService.ts` | Auth con Prisma |
| `src/server/services/emailService.ts` | Envío de emails |
| `src/server/routes/auth.ts` | Endpoints de auth |
| `src/server/middleware/auth.ts` | requireAuth, requireRole |
| `src/server/middleware/security.ts` | Security headers |
| `src/server/middleware/errorHandler.ts` | Error handler |
| `src/server/middleware/rateLimiter.ts` | Rate limiting |

---

## 15. Orden de Implementación

1. `npm uninstall better-sqlite3 @types/better-sqlite3`
2. `npm install prisma --save-dev && npm install @prisma/client`
3. `npx prisma init` → genera `prisma/schema.prisma`
4. Escribir el schema completo en `schema.prisma`
5. `npx prisma migrate dev --name init` → genera primera migración + cliente
6. Crear `src/server/lib/prisma.ts` (singleton)
7. Crear `prisma/seed.ts` → `npx prisma db seed`
8. Instalar dependencias de auth (bcryptjs, jsonwebtoken, etc.)
9. Crear middlewares
10. Crear `authService.ts` y `emailService.ts`
11. Crear `routes/auth.ts`
12. Refactorear `index.ts`
13. Migrar cada ruta existente para usar `prisma` en lugar de `databaseService`
14. Migrar cada servicio para recibir `tenantId`
15. Verificar que todo compile y funcione

---

## 16. Testing Checklist

- [ ] `npx prisma migrate dev` genera migración sin errores
- [ ] `npx prisma db seed` crea los 4 planes
- [ ] `npx prisma studio` muestra las tablas correctamente
- [ ] Registro crea tenant + user + subscription trial via Prisma
- [ ] Email de verificación tiene link funcional
- [ ] Verificar email activa la cuenta
- [ ] Login devuelve JWT + setea cookie
- [ ] Login falla con email no verificado (403)
- [ ] `GET /me` devuelve user + tenant + subscription (con trialDaysRemaining)
- [ ] Forgot/Reset password funciona end-to-end
- [ ] Rate limiting bloquea después de 10 intentos
- [ ] Security headers presentes en todas las respuestas
- [ ] Todas las queries usan `where: { tenantId }` (aislamiento)
- [ ] TypeScript compila sin errores con tipos auto-generados de Prisma
- [ ] Pipeline sigue funcionando con Prisma en lugar de SQLite
