# PeriodistApp SaaS Evolution — Spec Completa

> De herramienta single-user a plataforma multi-tenant para medios de comunicación, streamers y programas en vivo.

---

## Visión General

PeriodistApp actualmente funciona como una instancia única sin autenticación. La evolución la convierte en una plataforma SaaS donde:

- Usuarios (canales de streaming, noticieros, programas en vivo) se registran y verifican su email
- Cada usuario tiene su propio espacio aislado (multi-tenancy)
- Suscripción obligatoria para operar (trial gratuito limitado → pago)
- Procesamiento programado: el usuario agenda franjas horarias para procesar su transmisión
- Despliegue en VPS con EasyPanel (cada servicio = carpeta independiente con su puerto)

**Stack**: Se mantiene Node.js + Express + React. Se migra de SQLite a PostgreSQL con **Prisma ORM** (schema declarativo, migraciones versionadas, tipos auto-generados, equivalente a SQLAlchemy+Alembic en Python). No se migra el framework.

---

## Arquitectura de Servicios (EasyPanel)

```
┌─────────────────────────────────────────────────────────┐
│                     VPS (EasyPanel)                     │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   frontend    │  │     api      │  │   scheduler   │  │
│  │  (React SPA)  │  │  (Express)   │  │  (Node cron)  │  │
│  │  Puerto 3000  │  │  Puerto 3001 │  │  Puerto 3002  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │          │
│         │    ┌────────────┴────────────┐     │          │
│         └───►│       PostgreSQL        │◄────┘          │
│              │       Puerto 5432       │                │
│              └────────────┬────────────┘                │
│                           │                             │
│              ┌────────────┴────────────┐                │
│              │         Redis           │                │
│              │       Puerto 6379       │                │
│              └─────────────────────────┘                │
│                                                         │
│  ┌──────────────┐                                       │
│  │    mailer     │  (opcional: servicio dedicado        │
│  │  Puerto 3003  │   o integrado en api)                │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

### Servicios

| Servicio | Carpeta | Puerto | Responsabilidad |
|----------|---------|--------|-----------------|
| **frontend** | `/frontend` | 3000 | React SPA (landing pública + app autenticada) |
| **api** | `/api` | 3001 | Express REST API + Socket.IO (toda la lógica de negocio) |
| **scheduler** | `/scheduler` | 3002 | Procesamiento programado de transmisiones (cron jobs) |
| **postgres** | — | 5432 | Base de datos principal (EasyPanel service) |
| **redis** | — | 6379 | Rate limiting, sesiones, cache, cola de jobs |

> **Nota**: El `scheduler` puede empezar integrado dentro de `api` y separarse cuando la carga lo justifique. La spec lo diseña separado para que la arquitectura escale.

---

# ETAPA 1: Base de Datos Multi-Tenant + Auth

**Objetivo**: Migrar de SQLite a PostgreSQL, implementar registro/login/verificación de email, y aislar datos por tenant.

## 1.1 Migración de Base de Datos

### De SQLite a PostgreSQL

El SQLite actual tiene 7 tablas. PostgreSQL las mantiene y agrega las de auth/billing.

### Schema Nuevo (PostgreSQL)

```sql
-- =============================================
-- TENANTS (cada usuario/organización es un tenant)
-- =============================================
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,              -- "Radio Uno Formosa", "Canal 9 Noticias"
    slug VARCHAR(100) UNIQUE NOT NULL,       -- "radio-uno-formosa" (para URLs)
    owner_id UUID,                           -- FK a users (se setea post-registro)
    platform_name VARCHAR(255),              -- nombre que aparece en placas/prompts
    logo_url TEXT,                            -- logo custom del tenant
    timezone VARCHAR(50) DEFAULT 'America/Argentina/Buenos_Aires',
    config JSONB DEFAULT '{}',               -- configuración general del tenant
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- USERS (personas que acceden a la plataforma)
-- =============================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    avatar_url TEXT,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'owner'
        CHECK (role IN ('owner', 'editor', 'viewer')),
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'suspended')),
    is_verified BOOLEAN DEFAULT FALSE,
    verification_token UUID,
    verification_token_expires_at TIMESTAMPTZ,
    reset_password_token UUID,
    reset_password_expires_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tenants ADD CONSTRAINT fk_tenants_owner
    FOREIGN KEY (owner_id) REFERENCES users(id);

-- =============================================
-- CREDENTIALS (API keys encriptadas, por tenant)
-- =============================================
CREATE TABLE credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,              -- "twitter_api_key", "meta_access_token"
    value TEXT NOT NULL,                     -- encriptado AES-256-GCM
    category VARCHAR(50) NOT NULL,           -- "meta", "twitter", "google", "webhook", "ai"
    is_valid BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

-- =============================================
-- PUBLICATIONS (notas generadas, por tenant)
-- =============================================
CREATE TABLE publications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    title TEXT,
    content TEXT,
    image_path TEXT,
    image_url TEXT,
    source VARCHAR(20) DEFAULT 'manual',     -- "pipeline", "manual"
    publish_results JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TRANSCRIPTIONS (segmentos transcritos, por tenant)
-- =============================================
CREATE TABLE transcriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    audio_file TEXT,
    source VARCHAR(20) DEFAULT 'manual',
    duration_seconds INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- SETTINGS (config key-value, por tenant)
-- =============================================
CREATE TABLE settings (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key VARCHAR(100) NOT NULL,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, key)
);

-- =============================================
-- BUSINESS_ASSETS (Meta pages/IG accounts, por tenant)
-- =============================================
CREATE TABLE business_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    asset_type VARCHAR(50) NOT NULL,
    external_id VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, external_id)
);

-- =============================================
-- CUSTOM_AGENTS (agentes IA del pipeline, por tenant)
-- =============================================
CREATE TABLE custom_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    system_prompt TEXT,
    position INTEGER DEFAULT 0,
    after_step VARCHAR(50),
    is_enabled BOOLEAN DEFAULT TRUE,
    ai_provider VARCHAR(50) DEFAULT 'deepseek',
    temperature REAL DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 2000,
    tools JSONB DEFAULT '[]',
    template_id VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- PIPELINE_CONFIGS (configuración de pipeline, por tenant)
-- =============================================
CREATE TABLE pipeline_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) DEFAULT 'default',
    node_order JSONB NOT NULL DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- INDEXES
-- =============================================
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_verification ON users(verification_token);
CREATE INDEX idx_credentials_tenant ON credentials(tenant_id);
CREATE INDEX idx_publications_tenant ON publications(tenant_id);
CREATE INDEX idx_publications_created ON publications(tenant_id, created_at DESC);
CREATE INDEX idx_transcriptions_tenant ON transcriptions(tenant_id);
CREATE INDEX idx_business_assets_tenant ON business_assets(tenant_id);
CREATE INDEX idx_custom_agents_tenant ON custom_agents(tenant_id);
CREATE INDEX idx_pipeline_configs_tenant ON pipeline_configs(tenant_id);
```

## 1.2 Sistema de Autenticación

### Registro

```
POST /api/auth/register
Body: { email, password, full_name, organization_name }

Flujo:
1. Validar email único
2. Hash password (bcrypt, 12 rounds)
3. Crear tenant con organization_name como name, generar slug
4. Crear user con status='pending', is_verified=false
5. Generar verification_token (UUID) con expiración 48h
6. Crear suscripción trial (7 días)
7. Enviar email de verificación
8. Responder: { message: "Revisa tu email para verificar tu cuenta" }
```

### Verificación de Email

```
POST /api/auth/verify-email
Body: { token }

Flujo:
1. Buscar user por verification_token
2. Verificar que no expiró
3. Setear is_verified=true, status='active'
4. Limpiar verification_token
5. Enviar email de bienvenida
6. Responder: { message: "Email verificado", redirect: "/login" }
```

### Login

```
POST /api/auth/login
Body: { email, password }

Flujo:
1. Buscar user por email
2. Verificar password (bcrypt.compare)
3. Verificar status !== 'suspended'
4. Si !is_verified → responder con error "Verifica tu email primero"
5. Generar JWT (payload: { userId, tenantId, role, email })
6. Setear cookie HttpOnly + responder con token
7. Actualizar last_login_at
```

### JWT

```typescript
// Payload
interface JWTPayload {
    userId: string;       // UUID
    tenantId: string;     // UUID
    email: string;
    role: 'owner' | 'editor' | 'viewer';
    iat: number;
    exp: number;          // 7 días
}

// Configuración
const JWT_CONFIG = {
    secret: process.env.JWT_SECRET,  // mínimo 32 chars
    expiresIn: '7d',
    algorithm: 'HS256'
};
```

### Endpoints de Auth

```
POST   /api/auth/register           → Registro + tenant + trial
POST   /api/auth/verify-email       → Verificar token de email
POST   /api/auth/login              → Login + JWT
POST   /api/auth/logout             → Invalidar cookie
GET    /api/auth/me                 → User actual + tenant + suscripción
POST   /api/auth/forgot-password    → Enviar email de reset
POST   /api/auth/reset-password     → Cambiar password con token
PUT    /api/auth/profile            → Actualizar nombre, avatar
POST   /api/auth/resend-verification → Reenviar email de verificación
```

### Middleware de Autenticación

```typescript
// authMiddleware.ts
async function requireAuth(req, res, next) {
    const token = req.cookies.access_token
        || req.headers.authorization?.replace('Bearer ', '');

    if (!token) return res.status(401).json({ error: 'No autenticado' });

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;       // { userId, tenantId, role, email }
        req.tenantId = payload.tenantId;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}
```

### Middleware de Tenant Isolation

```typescript
// tenantMiddleware.ts
// REGLA DE ORO: Toda query incluye WHERE tenant_id = $tenantId

function injectTenantId(req, res, next) {
    // tenantId ya viene del JWT (seteado por requireAuth)
    if (!req.tenantId) {
        return res.status(403).json({ error: 'Tenant no identificado' });
    }
    next();
}
```

## 1.3 Email Service

```typescript
// Configuración via .env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=noreply@periodistapp.com
SMTP_PASS=app-specific-password
FRONTEND_URL=https://app.periodistapp.com

// Emails que envía:
1. Verificación de cuenta (link con token)
2. Bienvenida post-verificación
3. Reset de password
4. Alerta de suscripción por vencer (3 días antes)
5. Suscripción expirada
```

### Templates de Email

Diseño dark mode (coherente con la UI actual), responsive HTML.

```typescript
interface EmailTemplate {
    subject: string;
    html: string;      // HTML template con variables {{name}}, {{link}}
}

const templates = {
    verification: { subject: 'Verifica tu cuenta en PeriodistApp', ... },
    welcome: { subject: 'Bienvenido a PeriodistApp', ... },
    passwordReset: { subject: 'Resetea tu contraseña', ... },
    subscriptionWarning: { subject: 'Tu suscripción vence pronto', ... },
    subscriptionExpired: { subject: 'Tu suscripción ha expirado', ... },
};
```

## 1.4 Seguridad

### Headers (Express middleware)

```typescript
app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});
```

### Rate Limiting (Redis-backed)

```typescript
// Por IP para auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,    // 15 minutos
    max: 10,                      // 10 intentos login
    message: 'Demasiados intentos. Intenta en 15 minutos.'
});

// Por tenant para API general
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,          // 1 minuto
    max: 120,                     // 120 requests/min por tenant
    keyGenerator: (req) => req.tenantId
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/', apiLimiter);
```

### CORS

```typescript
app.use(cors({
    origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
```

### Cookie Security

```typescript
res.cookie('access_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,   // 7 días
    path: '/'
});
```

---

# ETAPA 2: Sistema de Suscripciones

**Objetivo**: Suscripción obligatoria para usar la plataforma. Sin suscripción activa → error 402.

## 2.1 Schema de Billing

```sql
-- =============================================
-- PLANS (planes de suscripción)
-- =============================================
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) UNIQUE NOT NULL,        -- "starter", "professional", "enterprise"
    display_name VARCHAR(100) NOT NULL,      -- "Starter", "Profesional", "Enterprise"
    price_usd DECIMAL(10,2) NOT NULL,
    price_ars DECIMAL(10,2),                 -- precio en pesos (opcional)
    billing_period VARCHAR(20) DEFAULT 'monthly',  -- "monthly", "yearly"

    -- Límites del plan
    max_pipeline_hours_per_month INTEGER,    -- horas de pipeline/mes (null = ilimitado)
    max_publications_per_month INTEGER,      -- publicaciones/mes
    max_scheduled_jobs INTEGER,              -- trabajos programados simultáneos
    max_custom_agents INTEGER,               -- agentes custom
    max_team_members INTEGER DEFAULT 1,      -- usuarios por tenant
    max_connected_platforms INTEGER,          -- plataformas sociales conectadas

    -- Features (flags)
    features JSONB DEFAULT '{}',
    -- Ejemplo: {
    --   "priority_transcription": false,
    --   "custom_branding": false,
    --   "api_access": false,
    --   "webhook_integration": true,
    --   "advanced_analytics": false,
    --   "image_ai_generation": true,
    --   "multi_provider_ai": false
    -- }

    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- SUBSCRIPTIONS (suscripción activa por tenant)
-- =============================================
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES plans(id),
    status VARCHAR(20) NOT NULL DEFAULT 'trialing'
        CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired')),

    -- Trial
    trial_ends_at TIMESTAMPTZ,

    -- Periodo actual
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,

    -- Pago externo (Stripe o MercadoPago)
    payment_provider VARCHAR(20),            -- "stripe", "mercadopago", "manual"
    external_subscription_id VARCHAR(255),
    external_customer_id VARCHAR(255),

    -- Cancelación
    cancel_at_period_end BOOLEAN DEFAULT FALSE,
    canceled_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- USAGE_RECORDS (tracking de uso mensual por tenant)
-- =============================================
CREATE TABLE usage_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,              -- primer día del mes

    pipeline_hours_used DECIMAL(10,2) DEFAULT 0,
    publications_count INTEGER DEFAULT 0,
    transcription_minutes DECIMAL(10,2) DEFAULT 0,
    ai_tokens_used BIGINT DEFAULT 0,

    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, period_start)
);

-- =============================================
-- INVOICES (historial de pagos)
-- =============================================
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
    payment_provider VARCHAR(20),
    external_invoice_id VARCHAR(255),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);
CREATE INDEX idx_usage_records_tenant ON usage_records(tenant_id, period_start);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);
```

## 2.2 Planes Iniciales

```typescript
const PLANS = [
    {
        name: 'trial',
        display_name: 'Trial Gratuito',
        price_usd: 0,
        max_pipeline_hours_per_month: 5,
        max_publications_per_month: 20,
        max_scheduled_jobs: 1,
        max_custom_agents: 2,
        max_team_members: 1,
        max_connected_platforms: 2,
        features: {
            priority_transcription: false,
            custom_branding: false,
            api_access: false,
            webhook_integration: false,
            advanced_analytics: false,
            image_ai_generation: true,
            multi_provider_ai: false
        }
    },
    {
        name: 'starter',
        display_name: 'Starter',
        price_usd: 29,
        max_pipeline_hours_per_month: 30,
        max_publications_per_month: 100,
        max_scheduled_jobs: 3,
        max_custom_agents: 5,
        max_team_members: 2,
        max_connected_platforms: 4,
        features: {
            priority_transcription: false,
            custom_branding: false,
            api_access: false,
            webhook_integration: true,
            advanced_analytics: false,
            image_ai_generation: true,
            multi_provider_ai: false
        }
    },
    {
        name: 'professional',
        display_name: 'Profesional',
        price_usd: 79,
        max_pipeline_hours_per_month: 120,
        max_publications_per_month: 500,
        max_scheduled_jobs: 10,
        max_custom_agents: 20,
        max_team_members: 5,
        max_connected_platforms: 8,
        features: {
            priority_transcription: true,
            custom_branding: true,
            api_access: true,
            webhook_integration: true,
            advanced_analytics: true,
            image_ai_generation: true,
            multi_provider_ai: true
        }
    },
    {
        name: 'enterprise',
        display_name: 'Enterprise',
        price_usd: 199,
        max_pipeline_hours_per_month: null,   // ilimitado
        max_publications_per_month: null,
        max_scheduled_jobs: null,
        max_custom_agents: null,
        max_team_members: 20,
        max_connected_platforms: null,
        features: {
            priority_transcription: true,
            custom_branding: true,
            api_access: true,
            webhook_integration: true,
            advanced_analytics: true,
            image_ai_generation: true,
            multi_provider_ai: true
        }
    }
];
```

## 2.3 Subscription Guard Middleware

```typescript
// subscriptionGuard.ts
// Se ejecuta DESPUÉS de requireAuth, ANTES de las rutas protegidas

async function requireActiveSubscription(req, res, next) {
    const { tenantId } = req;

    // Rutas exentas (deben funcionar sin suscripción)
    const exemptPaths = [
        '/api/auth/',
        '/api/billing/',
        '/api/health'
    ];
    if (exemptPaths.some(p => req.path.startsWith(p))) return next();

    const subscription = await db.query(
        `SELECT s.*, p.name as plan_name, p.max_pipeline_hours_per_month,
                p.max_publications_per_month, p.max_scheduled_jobs,
                p.features
         FROM subscriptions s
         JOIN plans p ON s.plan_id = p.id
         WHERE s.tenant_id = $1`,
        [tenantId]
    );

    if (!subscription) {
        return res.status(402).json({
            error: 'subscription_required',
            message: 'Se requiere una suscripción activa para usar la plataforma.',
            redirect: '/billing'
        });
    }

    const sub = subscription;

    // Verificar estado
    if (sub.status === 'trialing') {
        if (new Date() > new Date(sub.trial_ends_at)) {
            // Trial expirado → actualizar status
            await db.query(
                `UPDATE subscriptions SET status = 'expired' WHERE id = $1`,
                [sub.id]
            );
            return res.status(402).json({
                error: 'trial_expired',
                message: 'Tu periodo de prueba ha finalizado. Elige un plan para continuar.',
                redirect: '/billing'
            });
        }
    }

    if (['canceled', 'suspended', 'expired'].includes(sub.status)) {
        return res.status(402).json({
            error: 'subscription_inactive',
            message: 'Tu suscripción no está activa. Renueva para continuar.',
            status: sub.status,
            redirect: '/billing'
        });
    }

    // Adjuntar info de suscripción al request
    req.subscription = sub;
    next();
}
```

## 2.4 Endpoints de Billing

```
GET    /api/billing/plans              → Listar planes (público)
GET    /api/billing/my-subscription    → Suscripción actual del tenant
GET    /api/billing/usage              → Uso del mes actual vs límites
GET    /api/billing/invoices           → Historial de facturas
POST   /api/billing/checkout           → Crear sesión de pago (Stripe/MP)
POST   /api/billing/change-plan        → Cambiar de plan
POST   /api/billing/cancel             → Cancelar suscripción
POST   /api/billing/webhook/stripe     → Webhook de Stripe
POST   /api/billing/webhook/mercadopago → Webhook de MercadoPago
```

## 2.5 Integración de Pagos

### Stripe (Internacional)

```typescript
// POST /api/billing/checkout
// Body: { planId, billingPeriod: 'monthly' | 'yearly' }

async function createCheckoutSession(req, res) {
    const { planId, billingPeriod } = req.body;
    const plan = await getPlan(planId);

    const session = await stripe.checkout.sessions.create({
        customer_email: req.user.email,
        mode: 'subscription',
        line_items: [{
            price: plan.stripe_price_id,
            quantity: 1
        }],
        success_url: `${FRONTEND_URL}/billing?success=true`,
        cancel_url: `${FRONTEND_URL}/billing?canceled=true`,
        metadata: {
            tenantId: req.tenantId,
            planName: plan.name
        }
    });

    res.json({ checkout_url: session.url, session_id: session.id });
}
```

### Webhook de Stripe

```typescript
// POST /api/billing/webhook/stripe
// Events:
// - checkout.session.completed → activar suscripción
// - invoice.paid → renovación exitosa
// - invoice.payment_failed → status = 'past_due'
// - customer.subscription.deleted → status = 'canceled'
```

### MercadoPago (Argentina/LATAM)

```typescript
// Preapproval (suscripción recurrente)
// Similar a Stripe pero con la API de MercadoPago
```

---

# ETAPA 3: Multi-Tenancy en el Pipeline Existente

**Objetivo**: Que toda la funcionalidad actual funcione aislada por tenant, sin romper nada.

## 3.1 Refactor del Pipeline

### Estado Actual
El `AutoPipeline` es una clase singleton. Solo puede correr un pipeline a la vez.

### Estado Objetivo
Un `PipelineManager` que gestiona múltiples instancias de `AutoPipeline`, una por tenant activo.

```typescript
// pipelineManager.ts

class PipelineManager {
    private pipelines: Map<string, AutoPipeline> = new Map();

    async startPipeline(tenantId: string, config: PipelineConfig): Promise<void> {
        if (this.pipelines.has(tenantId)) {
            throw new Error('Pipeline ya está corriendo para este tenant');
        }

        // Verificar suscripción y límites
        await this.checkUsageLimits(tenantId);

        // Cargar credenciales del tenant
        const credentials = await loadTenantCredentials(tenantId);

        // Crear instancia aislada
        const pipeline = new AutoPipeline(tenantId, credentials, config);
        this.pipelines.set(tenantId, pipeline);

        await pipeline.start();
    }

    stopPipeline(tenantId: string): void {
        const pipeline = this.pipelines.get(tenantId);
        if (pipeline) {
            pipeline.stop();
            this.pipelines.delete(tenantId);
        }
    }

    getStatus(tenantId: string): PipelineStatus | null {
        return this.pipelines.get(tenantId)?.getStatus() ?? null;
    }

    private async checkUsageLimits(tenantId: string): Promise<void> {
        const usage = await getMonthlyUsage(tenantId);
        const plan = await getTenantPlan(tenantId);

        if (plan.max_pipeline_hours_per_month !== null &&
            usage.pipeline_hours_used >= plan.max_pipeline_hours_per_month) {
            throw new Error('Has alcanzado el límite de horas de pipeline de tu plan');
        }
    }
}
```

## 3.2 Refactor de Rutas

Todas las rutas existentes se wrappean con `requireAuth` + `requireActiveSubscription`.

```typescript
// ANTES (sin auth):
router.post('/api/pipeline/start', pipelineController.start);

// DESPUÉS (con auth + tenant isolation):
router.post('/api/pipeline/start',
    requireAuth,
    requireActiveSubscription,
    pipelineController.start  // ahora usa req.tenantId internamente
);
```

### Cambios en cada grupo de rutas

| Ruta | Cambio |
|------|--------|
| `/api/pipeline/*` | Agregar tenantId, PipelineManager en lugar de singleton |
| `/api/meta/*` | Credenciales y assets por tenant |
| `/api/generate*` | Imágenes almacenadas en carpeta del tenant |
| `/api/sendWebhook*` | Webhooks configurados por tenant |
| `/api/history/*` | WHERE tenant_id = $tenantId |
| `/api/settings/*` | WHERE tenant_id = $tenantId |
| `/api/agents/*` | WHERE tenant_id = $tenantId |
| `/api/pipeline-config/*` | WHERE tenant_id = $tenantId |

## 3.3 Socket.IO con Tenant Isolation

```typescript
// ANTES: todos los clientes reciben todos los eventos
io.emit('pipeline-update', data);

// DESPUÉS: eventos por room (un room por tenant)
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token
        || socket.handshake.headers.cookie?.access_token;

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        socket.data.tenantId = payload.tenantId;
        socket.data.userId = payload.userId;
        socket.join(`tenant:${payload.tenantId}`);
        next();
    } catch (err) {
        next(new Error('Authentication required'));
    }
});

// En el pipeline, emitir solo al tenant:
io.to(`tenant:${tenantId}`).emit('pipeline-update', data);
```

## 3.4 Almacenamiento de Archivos por Tenant

```
output/
├── {tenant-id-1}/
│   ├── images/
│   ├── audio/
│   └── transcriptions/
├── {tenant-id-2}/
│   ├── images/
│   ├── audio/
│   └── transcriptions/
```

---

# ETAPA 4: Procesamiento Programado (Scheduled Jobs)

**Objetivo**: El usuario configura franjas horarias para que su transmisión se procese automáticamente.

## 4.1 Schema

```sql
-- =============================================
-- SCHEDULED_JOBS (programaciones de procesamiento)
-- =============================================
CREATE TABLE scheduled_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Qué procesar
    name VARCHAR(255) NOT NULL,              -- "Noticiero de la mañana"
    stream_url TEXT NOT NULL,                -- URL de la transmisión

    -- Cuándo procesar
    schedule_type VARCHAR(20) NOT NULL
        CHECK (schedule_type IN ('recurring', 'one_time')),

    -- Para recurring: días y horario
    days_of_week INTEGER[] DEFAULT '{}',     -- [1,2,3,4,5] = lun-vie (ISO)
    start_time TIME NOT NULL,                -- '08:00:00'
    duration_minutes INTEGER NOT NULL,       -- 120 = 2 horas
    timezone VARCHAR(50) DEFAULT 'America/Argentina/Buenos_Aires',

    -- Para one_time
    scheduled_date DATE,                     -- fecha específica

    -- Configuración del pipeline
    pipeline_config JSONB DEFAULT '{}',
    -- {
    --   "tone": "formal",
    --   "structure": "complete",
    --   "ai_provider": "deepseek",
    --   "image_model": "nano-banana",
    --   "auto_publish": true,
    --   "platforms": ["twitter", "facebook", "instagram"],
    --   "chunksPerAnalysis": 3
    -- }

    -- Estado
    is_active BOOLEAN DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- JOB_EXECUTIONS (historial de ejecuciones)
-- =============================================
CREATE TABLE job_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'canceled')),

    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,

    -- Resultados
    publications_generated INTEGER DEFAULT 0,
    transcription_minutes DECIMAL(10,2) DEFAULT 0,
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_scheduled_jobs_tenant ON scheduled_jobs(tenant_id);
CREATE INDEX idx_scheduled_jobs_next_run ON scheduled_jobs(next_run_at, is_active);
CREATE INDEX idx_job_executions_job ON job_executions(job_id);
CREATE INDEX idx_job_executions_tenant ON job_executions(tenant_id);
```

## 4.2 Scheduler Service

```typescript
// scheduler/index.ts
// Este servicio corre como proceso independiente (puerto 3002)
// Consulta la DB cada minuto buscando jobs que deben ejecutarse

class SchedulerService {
    private runningJobs: Map<string, AbortController> = new Map();

    async start() {
        // Tick cada 60 segundos
        setInterval(() => this.tick(), 60_000);
        console.log('Scheduler service started');
    }

    private async tick() {
        const now = new Date();

        // Buscar jobs que deben ejecutarse ahora
        const dueJobs = await db.query(`
            SELECT sj.*, t.name as tenant_name
            FROM scheduled_jobs sj
            JOIN tenants t ON sj.tenant_id = t.id
            JOIN subscriptions sub ON sub.tenant_id = t.id
            WHERE sj.is_active = TRUE
              AND sj.next_run_at <= $1
              AND sub.status IN ('active', 'trialing')
              AND NOT EXISTS (
                  SELECT 1 FROM job_executions je
                  WHERE je.job_id = sj.id AND je.status = 'running'
              )
        `, [now]);

        for (const job of dueJobs) {
            this.executeJob(job);
        }
    }

    private async executeJob(job: ScheduledJob) {
        const execution = await createJobExecution(job.id, job.tenant_id);
        const abort = new AbortController();
        this.runningJobs.set(execution.id, abort);

        try {
            // Cargar credenciales del tenant
            const credentials = await loadTenantCredentials(job.tenant_id);

            // Crear pipeline temporal
            const pipeline = new AutoPipeline(job.tenant_id, credentials, {
                streamUrl: job.stream_url,
                duration: job.duration_minutes * 60,
                ...job.pipeline_config,
                signal: abort.signal
            });

            await updateJobExecution(execution.id, { status: 'running', started_at: new Date() });

            // Ejecutar pipeline con timeout
            await Promise.race([
                pipeline.start(),
                this.timeout(job.duration_minutes * 60 * 1000 + 5 * 60 * 1000) // +5 min margen
            ]);

            pipeline.stop();

            await updateJobExecution(execution.id, {
                status: 'completed',
                finished_at: new Date(),
                publications_generated: pipeline.getPublishedCount(),
                transcription_minutes: pipeline.getTranscriptionMinutes()
            });

        } catch (error) {
            await updateJobExecution(execution.id, {
                status: 'failed',
                finished_at: new Date(),
                error_message: error.message
            });
        } finally {
            this.runningJobs.delete(execution.id);
            // Calcular próxima ejecución
            await calculateNextRun(job);
        }
    }

    private timeout(ms: number): Promise<never> {
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Job timeout')), ms)
        );
    }
}
```

## 4.3 Cálculo de Próxima Ejecución

```typescript
function calculateNextRun(job: ScheduledJob): Date | null {
    if (job.schedule_type === 'one_time') {
        return null; // no hay próxima
    }

    const now = new Date();
    const tz = job.timezone;

    // Buscar el próximo día de la semana que esté en days_of_week
    for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
        const candidate = addDays(now, daysAhead);
        const dayOfWeek = getISODay(candidate); // 1=lun, 7=dom

        if (job.days_of_week.includes(dayOfWeek)) {
            const runTime = setTimeInTz(candidate, job.start_time, tz);

            if (runTime > now) {
                return runTime;
            }
        }
    }

    return null;
}
```

## 4.4 Endpoints de Scheduling

```
GET    /api/schedule                   → Listar jobs del tenant
GET    /api/schedule/:id               → Detalle de un job
POST   /api/schedule                   → Crear job programado
PUT    /api/schedule/:id               → Actualizar job
DELETE /api/schedule/:id               → Eliminar job
PATCH  /api/schedule/:id/toggle        → Activar/desactivar job
GET    /api/schedule/:id/executions    → Historial de ejecuciones
POST   /api/schedule/:id/run-now       → Ejecutar inmediatamente
```

### Ejemplo de creación

```typescript
// POST /api/schedule
// Body:
{
    "name": "Noticiero Central",
    "stream_url": "https://www.youtube.com/watch?v=LIVE_ID",
    "schedule_type": "recurring",
    "days_of_week": [1, 2, 3, 4, 5],    // lunes a viernes
    "start_time": "20:00",               // 8 PM
    "duration_minutes": 120,              // 2 horas
    "timezone": "America/Argentina/Buenos_Aires",
    "pipeline_config": {
        "tone": "formal",
        "structure": "complete",
        "ai_provider": "deepseek",
        "auto_publish": true,
        "platforms": ["twitter", "facebook"]
    }
}
```

---

# ETAPA 5: Frontend — Landing Pública + App Autenticada

**Objetivo**: Separar rutas públicas (landing, pricing, login) de la app autenticada.

## 5.1 Estructura de Rutas

```typescript
// React Router

// RUTAS PÚBLICAS (sin auth)
/                          → Landing page
/pricing                   → Planes y precios
/login                     → Login
/register                  → Registro
/verify-email?token=xxx    → Verificación de email
/forgot-password           → Solicitar reset
/reset-password?token=xxx  → Reset de password

// RUTAS PROTEGIDAS (requieren auth + suscripción activa)
/dashboard                 → Dashboard principal (pipeline actual)
/schedule                  → Gestión de trabajos programados
/history                   → Historial de publicaciones/transcripciones
/settings                  → Configuración (credentials, webhooks)
/settings/team             → Gestión de equipo (plan Professional+)
/settings/integrations     → Meta, Twitter, Google Drive
/pipeline-editor           → Editor visual de pipeline
/billing                   → Suscripción y facturación
/profile                   → Perfil del usuario
```

## 5.2 AuthContext (React)

```typescript
// context/AuthContext.tsx

interface AuthState {
    user: User | null;
    tenant: Tenant | null;
    subscription: Subscription | null;
    isAuthenticated: boolean;
    isLoading: boolean;
}

const AuthProvider: React.FC = ({ children }) => {
    const [state, setState] = useState<AuthState>({
        user: null, tenant: null, subscription: null,
        isAuthenticated: false, isLoading: true
    });

    useEffect(() => {
        // Al montar, verificar sesión
        checkSession();
    }, []);

    async function checkSession() {
        try {
            const res = await fetch('/api/auth/me', { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setState({
                    user: data.user,
                    tenant: data.tenant,
                    subscription: data.subscription,
                    isAuthenticated: true,
                    isLoading: false
                });
            } else {
                setState(prev => ({ ...prev, isLoading: false }));
            }
        } catch {
            setState(prev => ({ ...prev, isLoading: false }));
        }
    }

    // ...login, logout, etc.
};
```

## 5.3 ProtectedRoute

```typescript
function ProtectedRoute({ children }) {
    const { isAuthenticated, isLoading, subscription } = useAuth();

    if (isLoading) return <LoadingScreen />;
    if (!isAuthenticated) return <Navigate to="/login" />;

    // Verificar suscripción
    if (subscription?.status === 'expired' || subscription?.status === 'canceled') {
        return <Navigate to="/billing" />;
    }

    return children;
}
```

## 5.4 Landing Page

Secciones:
1. **Hero**: "Automatiza tu medio de comunicación con IA" + CTA registro
2. **Problema/Solución**: "Tu programa se transmite en vivo, pero el contenido se pierde"
3. **Cómo funciona**: 3 pasos (Conecta tu stream → IA procesa → Publica automáticamente)
4. **Features**: Pipeline autónomo, publicación multi-plataforma, agentes custom, programación
5. **Para quién**: Streamers, noticieros, radios online, podcasts en vivo
6. **Pricing**: Cards de planes con toggle mensual/anual
7. **FAQ**
8. **Footer**: Links legales, contacto

---

# ETAPA 6: Despliegue en EasyPanel (VPS)

## 6.1 Estructura de Carpetas para EasyPanel

```
periodistapp-saas/
├── api/                     → Servicio "api" en EasyPanel
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── server/          (código actual migrado)
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   ├── subscription.ts
│   │   │   └── rateLimiter.ts
│   │   └── ...
│   └── .env
│
├── frontend/                → Servicio "frontend" en EasyPanel
│   ├── Dockerfile
│   ├── package.json
│   ├── nginx.conf           (sirve SPA + proxy a api)
│   ├── src/
│   │   ├── client/          (código actual + landing + auth pages)
│   │   └── ...
│   └── .env
│
├── scheduler/               → Servicio "scheduler" en EasyPanel
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── index.ts         (scheduler loop)
│   │   └── ...
│   └── .env
│
├── db/                      → Config para PostgreSQL service en EasyPanel
│   └── init.sql             (schema inicial)
│
└── docker-compose.yml       (para desarrollo local)
```

## 6.2 Dockerfiles

### API Service

```dockerfile
FROM node:20-slim

# Instalar dependencias del sistema (ffmpeg, yt-dlp, python/whisper)
RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    && pip3 install openai-whisper \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build

EXPOSE 3001
CMD ["node", "dist/server/index.js"]
```

### Frontend Service

```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:client

FROM nginx:alpine
COPY --from=builder /app/dist/client /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
```

### Scheduler Service

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    && pip3 install openai-whisper \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN npm run build

EXPOSE 3002
CMD ["node", "dist/scheduler/index.js"]
```

## 6.3 Variables de Entorno Compartidas

```env
# === DATABASE ===
DATABASE_URL=postgresql://periodistapp:password@postgres:5432/periodistapp

# === REDIS ===
REDIS_URL=redis://redis:6379

# === AUTH ===
JWT_SECRET=min-32-chars-random-secret-here
ENCRYPTION_KEY=64-hex-chars-for-aes-256

# === EMAIL ===
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=noreply@periodistapp.com
SMTP_PASS=app-specific-password
FRONTEND_URL=https://app.periodistapp.com

# === PAYMENTS ===
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
MP_ACCESS_TOKEN=...

# === AI (defaults, overrideable per tenant) ===
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=AIzaSy...

# === CORS ===
CORS_ORIGINS=https://app.periodistapp.com,https://periodistapp.com
```

## 6.4 Nginx Config (Frontend)

```nginx
server {
    listen 3000;
    root /usr/share/nginx/html;
    index index.html;

    # SPA: todas las rutas caen al index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API al backend
    location /api/ {
        proxy_pass http://api:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Proxy Socket.IO
    location /socket.io/ {
        proxy_pass http://api:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

## 6.5 EasyPanel — Configuración de Servicios

En EasyPanel, cada carpeta se configura como un servicio independiente:

| Servicio | Source | Puerto Interno | Puerto Expuesto | Dominio |
|----------|--------|----------------|-----------------|---------|
| frontend | `/frontend` | 3000 | 443 (HTTPS) | app.periodistapp.com |
| api | `/api` | 3001 | — (interno) | — |
| scheduler | `/scheduler` | 3002 | — (interno) | — |
| postgres | EasyPanel template | 5432 | — (interno) | — |
| redis | EasyPanel template | 6379 | — (interno) | — |

> Solo el frontend se expone públicamente. El API se accede via proxy nginx.

---

# ETAPA 7: Tracking de Uso y Analytics

## 7.1 Usage Tracking

```typescript
// Incrementar uso después de cada acción facturable

// En pipelineService (después de cada chunk transcrito)
async function trackTranscriptionUsage(tenantId: string, minutes: number) {
    const periodStart = startOfMonth(new Date());
    await db.query(`
        INSERT INTO usage_records (tenant_id, period_start, transcription_minutes)
        VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, period_start)
        DO UPDATE SET
            transcription_minutes = usage_records.transcription_minutes + $3,
            updated_at = NOW()
    `, [tenantId, periodStart, minutes]);
}

// En pipelineService (cuando se publica una nota)
async function trackPublicationUsage(tenantId: string) {
    const periodStart = startOfMonth(new Date());
    await db.query(`
        INSERT INTO usage_records (tenant_id, period_start, publications_count)
        VALUES ($1, $2, 1)
        ON CONFLICT (tenant_id, period_start)
        DO UPDATE SET
            publications_count = usage_records.publications_count + 1,
            updated_at = NOW()
    `, [tenantId, periodStart]);
}
```

## 7.2 Endpoint de Usage

```typescript
// GET /api/billing/usage
// Respuesta:
{
    "period": "2026-03",
    "usage": {
        "pipeline_hours_used": 12.5,
        "publications_count": 47,
        "transcription_minutes": 750.3,
        "ai_tokens_used": 1240000
    },
    "limits": {
        "max_pipeline_hours_per_month": 30,
        "max_publications_per_month": 100,
        "max_scheduled_jobs": 3
    },
    "percentages": {
        "pipeline_hours": 41.7,
        "publications": 47.0
    }
}
```

---

# ETAPA 8: Team Management (Plan Professional+)

## 8.1 Roles

| Rol | Permisos |
|-----|----------|
| **owner** | Todo: config, billing, team, pipeline, publicación |
| **editor** | Pipeline, publicación, historial, schedule. NO billing ni team |
| **viewer** | Solo lectura: historial, status del pipeline |

## 8.2 Endpoints de Team

```
GET    /api/team                    → Listar miembros del tenant
POST   /api/team/invite             → Invitar miembro (envía email)
PUT    /api/team/:userId/role       → Cambiar rol
DELETE /api/team/:userId            → Remover miembro
```

## 8.3 Invitación

```typescript
// POST /api/team/invite
// Body: { email, role: 'editor' | 'viewer' }

// Flujo:
// 1. Verificar que el plan permite más team members
// 2. Crear user con status='pending', tenant_id del owner
// 3. Generar invite_token
// 4. Enviar email con link: /accept-invite?token=xxx
// 5. Al aceptar: user se setea activo, elige password
```

---

# Plan de Implementación por Prioridad

## Fase 1 — Fundación (2-3 semanas)
1. Migrar de SQLite a PostgreSQL
2. Implementar auth (registro, login, verificación email)
3. Middleware de autenticación en todas las rutas
4. Email service (verificación + welcome)
5. Landing page básica

## Fase 2 — Multi-Tenancy (1-2 semanas)
1. Aislar datos por tenant_id en todas las queries
2. Refactorear AutoPipeline a PipelineManager
3. Socket.IO rooms por tenant
4. Storage de archivos por tenant

## Fase 3 — Suscripciones (1-2 semanas)
1. Schema de billing (plans, subscriptions, usage)
2. Subscription guard middleware
3. Integración Stripe
4. Página de pricing y checkout
5. Webhooks de pago

## Fase 4 — Scheduled Jobs (1-2 semanas)
1. Schema de scheduled_jobs + job_executions
2. Scheduler service
3. UI de programación de trabajos
4. Tracking de uso (horas, publicaciones)

## Fase 5 — Producción (1 semana)
1. Dockerfiles para cada servicio
2. Configuración EasyPanel
3. Dominio + SSL
4. Monitoreo y logging

## Fase 6 — Extras (ongoing)
1. Team management
2. MercadoPago
3. Analytics dashboard
4. API pública (para plan Enterprise)

---

# Consideraciones de Seguridad (Checklist)

- [x] Passwords hasheados con bcrypt (12 rounds)
- [x] JWT con expiración (7 días)
- [x] Cookies HttpOnly + Secure + SameSite
- [x] Rate limiting por IP (auth) y por tenant (API)
- [x] CORS restrictivo (solo dominios permitidos)
- [x] Security headers (HSTS, X-Frame-Options, CSP, nosniff)
- [x] Credenciales encriptadas (AES-256-GCM, ya existente)
- [x] Tenant isolation en toda query (WHERE tenant_id)
- [x] Email verification obligatorio
- [x] Tokens de reset one-time con expiración
- [x] Subscription guard (402 si no paga)
- [x] Usage limits enforcement
- [x] No email enumeration (respuesta genérica en forgot-password)
- [x] Input validation (express-validator o zod)
- [x] Socket.IO autenticado (no conexiones anónimas)

---

# Compatibilidad con Funcionalidad Actual

| Feature Actual | Impacto | Estrategia |
|----------------|---------|------------|
| Pipeline autónomo | Se convierte en por-tenant | PipelineManager wrappea AutoPipeline |
| Pipeline editor (React Flow) | Sin cambios funcionales | Agrega tenant_id a custom_agents y pipeline_configs |
| Meta OAuth | Sin cambios en flujo | Credenciales aisladas por tenant |
| Twitter publishing | Sin cambios | Credenciales por tenant |
| Webhooks | Sin cambios | URLs configuradas por tenant |
| Manual capture/transcribe | Sin cambios | Aislado por tenant |
| Image generation | Sin cambios | Archivos en carpeta del tenant |
| Socket.IO realtime | Rooms por tenant | Solo ve eventos de su tenant |
| Rate limiter de APIs | Se mantiene | Ahora también por tenant |
| Deduplication service | Se mantiene | Filtrado por tenant |

> **Principio clave**: Nada se rompe. El core funcional (pipeline, agentes, publicación) se mantiene idéntico. Solo se agrega la capa de autenticación, aislamiento y facturación alrededor.
