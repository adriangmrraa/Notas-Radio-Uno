# Guía de Variables de Entorno — PeriodistApp

Dónde conseguir cada valor para el archivo `.env` de producción.

---

## Resumen rápido de variables

```env
# Base de datos
DATABASE_URL=

# Redis
REDIS_URL=

# Auth
JWT_SECRET=
ENCRYPTION_KEY=
FRONTEND_URL=

# AI
GEMINI_API_KEY=
DEEPSEEK_API_KEY=

# Twitter/X
TWITTER_APP_KEY=
TWITTER_APP_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# Meta (Facebook/Instagram)
META_APP_ID=
META_APP_SECRET=
META_CONFIG_ID=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=

# MercadoPago
MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_PUBLIC_KEY=
MERCADOPAGO_WEBHOOK_SECRET=

# Google Drive
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_FOLDER_ID=

# Google Custom Search
GOOGLE_SEARCH_API_KEY=
GOOGLE_SEARCH_CX=

# Email
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# App
PLATFORM_NAME=
NODE_ENV=production
PORT=3001
```

---

## 1. NEON DATABASE (PostgreSQL)

**Variable:** `DATABASE_URL`

### Dónde registrarse
👉 https://console.neon.tech/signup

Podés registrarte con email, GitHub o Google. **Plan gratuito incluido**, sin tarjeta de crédito.

### Cómo obtener la connection string

1. Entrás a https://console.neon.tech
2. Si es la primera vez, el onboarding te lleva directo a crear un proyecto
3. Poné un nombre al proyecto (ej: `periodistapp`) y elegí región (la más cercana a tu VPS)
4. Una vez creado el proyecto, hacé clic en el botón **"Connect"** (arriba a la derecha del dashboard del proyecto)
5. Se abre un modal → seleccionás:
   - **Branch**: `main`
   - **Database**: `neondb`
   - **Role**: el que creaste (por defecto es el nombre del proyecto)
6. Copiás la connection string completa

### Formato del valor

```
postgresql://[usuario]:[contraseña]@[host].neon.tech/[dbname]?sslmode=require&channel_binding=require
```

Ejemplo real:
```
postgresql://periodistapp_owner:abc123xyz@ep-cool-smoke-a5b2c3.us-east-2.aws.neon.tech/neondb?sslmode=require
```

> **Ojo**: El panel te ofrece dos opciones: conexión directa y conexión **pooled** (con `-pooler` en el hostname). Para producción con muchas conexiones simultáneas, usá la **pooled**. Para migraciones de Prisma (`prisma migrate deploy`), usá la **directa** sin pooler.

---

## 2. GEMINI (Google AI)

**Variable:** `GEMINI_API_KEY`

### Dónde obtenerla
👉 https://aistudio.google.com/app/apikey

Necesitás una cuenta de Google. No necesita tarjeta para el plan gratuito.

### Pasos

1. Entrás a https://aistudio.google.com
2. Si es la primera vez, aceptás los términos de servicio → Google te crea automáticamente un proyecto de Cloud y una API key
3. Vas al menú izquierdo → **"Get API key"** (o directo a https://aistudio.google.com/app/apikey)
4. Hacés clic en **"Create API key"**
5. Elegís un proyecto de Google Cloud (si no tenés, te crea uno nuevo)
6. Copiás la key generada — se ve así: `AIzaSyXXXXXXXXXXXXXXXXXXXXXX`

### Modelo a usar en el código

El proyecto usa `gemini-2.0-flash` (rápido y barato). También existe `gemini-2.0-flash-exp` (experimental, sin costo extra en el tier gratuito).

Límites gratuitos (2025): 15 req/min, 1 millón tokens/min, 1500 req/día — más que suficiente para desarrollo.

---

## 3. META (Facebook / Instagram)

**Variables:** `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`

### Dónde registrarse como desarrollador
👉 https://developers.facebook.com/

Necesitás una cuenta de Facebook personal. La primera vez te pide que te registres como developer (gratis).

### Cómo crear una app y obtener APP_ID y APP_SECRET

1. Entrás a https://developers.facebook.com/apps/
2. Clic en **"Create App"**
3. En el wizard:
   - **Use case**: seleccioná "Authenticate and request data from users with Facebook Login" (para login/permisos de publicación)
   - **Business portfolio**: podés saltearte la conexión con un negocio por ahora
4. Una vez creada la app, quedás en el **App Dashboard**
5. **APP_ID**: está visible en la parte superior del dashboard, abajo del nombre de la app
6. **APP_SECRET**: vas a **Settings → Basic** → buscás "App secret" → hacés clic en **"Show"** (te pide contraseña de Facebook)

### Qué es META_CONFIG_ID (Facebook Login Configuration)

El `META_CONFIG_ID` es el ID de una **configuración de Facebook Login** — no de la app en sí. Es un objeto que define permisos, OAuth redirect URIs, etc.

Para obtenerlo:
1. En el dashboard de tu app, en el menú izquierdo buscás **"Products"** → **"Facebook Login"** → **"Settings"** (o "Add Product" si no está)
2. Configurás los permisos y URLs de redirect
3. Vas a **Facebook Login → Configurations** (en algunas versiones del panel se llama "Login configurations")
4. Cada configuración tiene un ID numérico — ese es el `META_CONFIG_ID`

> Si no encontrás "Configurations" en el panel, buscá en https://developers.facebook.com/docs/facebook-login/web — el `config_id` se genera cuando creás una configuración de login para el botón de Facebook Login en web.

---

## 4. TWITTER / X

**Variables:** `TWITTER_APP_KEY`, `TWITTER_APP_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET`

### Dónde registrarse
👉 https://developer.x.com/

Necesitás cuenta de X (Twitter). Tenés que aplicar para acceso de desarrollador — el plan **Free** es suficiente para publicar tweets.

### Diferencia entre las credenciales

Hay **dos sistemas de autenticación** y es importante entender cuál es cuál:

| Credencial | Sistema | Para qué sirve |
|---|---|---|
| `TWITTER_APP_KEY` (API Key) | OAuth 1.0a | Identificar tu app |
| `TWITTER_APP_SECRET` (API Secret) | OAuth 1.0a | Clave secreta de la app |
| `TWITTER_ACCESS_TOKEN` | OAuth 1.0a | Identificar la cuenta de usuario |
| `TWITTER_ACCESS_SECRET` | OAuth 1.0a | Clave del token de usuario |
| `CLIENT_ID` | OAuth 2.0 | Para flujos OAuth 2.0 modernos |
| `CLIENT_SECRET` | OAuth 2.0 | Para flujos OAuth 2.0 modernos |

**PeriodistApp usa OAuth 1.0a** (las 4 variables con `APP_KEY`, `APP_SECRET`, etc.) para publicar tweets directamente desde la cuenta del medio. OAuth 2.0 se usaría para que usuarios externos autoricen tu app.

### Cómo obtener las credenciales

1. Vas a https://developer.x.com/en/portal/dashboard
2. Hacés clic en **"+ Add App"** o seleccionás tu app existente
3. Dentro de la app, vas a la pestaña **"Keys and tokens"**
4. Encontrás:
   - **API Key and Secret** → son `TWITTER_APP_KEY` y `TWITTER_APP_SECRET`
   - Hacés clic en **"Generate"** (si no los generaste antes) o **"Regenerate"**
5. Para los tokens de acceso de tu propia cuenta:
   - Bajás en la misma página a la sección **"Access Token and Secret"**
   - Hacés clic en **"Generate"**
   - Te da `TWITTER_ACCESS_TOKEN` y `TWITTER_ACCESS_SECRET`

> **Importante**: guardá todo en el momento que lo generás. X no te los muestra de nuevo. Si los perdés, tenés que regenerarlos (lo que invalida los anteriores).

---

## 5. STRIPE

**Variables:** `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`

### Dónde registrarse
👉 https://dashboard.stripe.com/register

### Cómo obtener las API keys

1. Entrás a https://dashboard.stripe.com
2. En el menú izquierdo vas a **Developers → API keys**
3. Encontrás dos keys:
   - **Publishable key** (`pk_live_...`): va en el frontend, es pública → `STRIPE_PUBLISHABLE_KEY`
   - **Secret key** (`sk_live_...`): solo en el backend, nunca en el cliente → `STRIPE_SECRET_KEY`
4. En modo test, las keys empiezan con `pk_test_...` y `sk_test_...` — usá esas para desarrollo

### Cómo obtener el STRIPE_WEBHOOK_SECRET

1. Vas a **Developers → Webhooks** en el dashboard de Stripe
2. Clic en **"Add endpoint"** (o "Create an event destination")
3. En la URL del endpoint poné:
   ```
   https://periodistapp.onrender.com/api/billing/webhook/stripe
   ```
   (o la URL de tu dominio de producción)
4. En "Events to send" seleccionás al menos:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
5. Guardás el endpoint
6. En el detalle del webhook creado, aparece **"Signing secret"** → hacés clic en **"Reveal"**
7. Copiás el valor que empieza con `whsec_...`

> Para testing local podés usar **Stripe CLI**: `stripe listen --forward-to localhost:3001/api/billing/webhook/stripe` — te da un webhook secret temporal.

---

## 6. MERCADOPAGO

**Variables:** `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_PUBLIC_KEY`, `MERCADOPAGO_WEBHOOK_SECRET`

### Dónde registrarse como developer
👉 https://www.mercadopago.com.ar/developers/es

Necesitás cuenta de MercadoPago. Si ya tenés una cuenta de usuario, la misma sirve para el portal de developers.

### Cómo obtener las credenciales

1. Entrás a https://www.mercadopago.com.ar/developers/panel/app
2. Creás una nueva aplicación (o seleccionás una existente)
3. En la app, vas a **"Credenciales"**
4. Encontrás dos entornos:
   - **Credenciales de prueba** (sandbox): para desarrollo
   - **Credenciales de producción**: para cobros reales

Las credenciales son:
- **Access Token** (`APP_USR-...`): va solo en el backend → `MERCADOPAGO_ACCESS_TOKEN`
- **Public Key** (`APP_USR-...`): puede ir en el frontend → `MERCADOPAGO_PUBLIC_KEY`

### Configurar webhooks

1. En la misma app de developers, buscás la sección **"Notificaciones"** o **"Webhooks"**
2. Agregás la URL:
   ```
   https://tu-dominio.com/api/billing/webhook/mercadopago
   ```
3. Seleccionás los eventos: `payment`, `subscription_authorized_payment`, `subscription_preapproval`
4. El **webhook secret** (para validar la firma) lo encontrás en la misma sección de notificaciones — puede ser un campo llamado "Secret" o lo generás desde allí

> Documentación oficial: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks

---

## 7. GOOGLE SERVICES

### 7a. Google Drive (Service Account)

**Variables:** `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_FOLDER_ID`

Estas credenciales vienen de una **cuenta de servicio** (service account) — no de tu cuenta personal. Permite que el servidor acceda a Drive sin intervención humana.

#### Crear la cuenta de servicio

1. Entrás a https://console.cloud.google.com/
2. Seleccionás o creás un proyecto (el mismo proyecto donde habilitaste Gemini sirve)
3. Vas al menú: **IAM y administración → Cuentas de servicio** (o directo a https://console.cloud.google.com/iam-admin/serviceaccounts)
4. Clic en **"Crear cuenta de servicio"**
5. Poné un nombre (ej: `periodistapp-drive`) y una descripción
6. Clic en **"Crear y continuar"**
7. En el paso de roles, asignás **"Editor"** o para menor privilegio: **"Roles de Drive"** (no existe un rol específico de Drive aquí — podés saltar este paso y dar acceso desde Drive directamente)
8. Clic en **"Listo"**

#### Descargar la clave JSON (donde están CLIENT_EMAIL y PRIVATE_KEY)

1. En la lista de cuentas de servicio, hacés clic en la que creaste
2. Vas a la pestaña **"Claves"**
3. Clic en **"Agregar clave" → "Crear clave nueva"**
4. Seleccionás formato **JSON** → **"Crear"**
5. Se descarga un archivo JSON que contiene:
   ```json
   {
     "client_email": "periodistapp-drive@tu-proyecto.iam.gserviceaccount.com",
     "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n",
     ...
   }
   ```
6. `client_email` → `GOOGLE_CLIENT_EMAIL`
7. `private_key` → `GOOGLE_PRIVATE_KEY`

> **Ojo con la private key**: cuando la pegás en el `.env`, la clave tiene `\n` literales. En algunos entornos tenés que ponerla entre comillas:
> ```
> GOOGLE_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
> ```

#### Habilitar la API de Google Drive

1. Vas a https://console.cloud.google.com/apis/library/drive.googleapis.com
2. Clic en **"Habilitar"**

#### Compartir la carpeta de Drive con la cuenta de servicio

1. Abrís Google Drive en tu cuenta personal → navegás a la carpeta que va a usar la app
2. Clic derecho → **"Compartir"** → pegás el `client_email` de la cuenta de servicio
3. Le das permisos de **Editor**
4. La URL de la carpeta tiene el formato: `https://drive.google.com/drive/folders/1BxXXXXXXXXXXXXXX`
5. El ID de la carpeta es la parte después de `/folders/` → eso es `GOOGLE_FOLDER_ID`

---

### 7b. Google Custom Search

**Variables:** `GOOGLE_SEARCH_API_KEY`, `GOOGLE_SEARCH_CX`

#### Crear el motor de búsqueda (CX / Search Engine ID)

1. Entrás a https://programmablesearchengine.google.com/controlpanel/all
2. Clic en **"Add"** o **"Nuevo motor de búsqueda"**
3. Configurás:
   - **Sites to search**: podés poner `*.com` para buscar en toda la web, o sitios específicos
   - **Language**: Español
   - **Name**: `PeriodistApp Search`
4. Una vez creado, vas a **"Overview"** del motor
5. En la sección **"Basic"** encontrás el **"Search engine ID"** — ese es `GOOGLE_SEARCH_CX` (formato: `017xxxxxxxxxxxxxxx:xxxxxxxx`)

#### Obtener el API Key para Custom Search

1. Vas a https://console.cloud.google.com/apis/library/customsearch.googleapis.com
2. Clic en **"Habilitar"**
3. Después vas a https://console.cloud.google.com/apis/credentials
4. Clic en **"Crear credenciales" → "Clave de API"**
5. Se genera la key → la copiás → esa es `GOOGLE_SEARCH_API_KEY`
6. Recomendado: hacés clic en **"Restringir clave"** → la limitás a la API de Custom Search

> Límite gratuito: 100 búsquedas/día. Para más, activás facturación en Google Cloud (USD 5 por cada 1000 búsquedas adicionales).

---

## 8. SMTP (Email)

**Variables:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

Tres opciones ordenadas por facilidad:

---

### Opción A — Resend (RECOMENDADA para producción)

👉 https://resend.com

La opción más simple para apps modernas. API REST + compatibilidad SMTP. **Plan gratuito: 3000 emails/mes, 100/día.**

1. Registrarte en https://resend.com/signup
2. Verificar tu dominio (vas a **Domains → Add Domain** → agregás los registros DNS que te indica)
3. Crear una API key: **API Keys → Create API Key** → guardás la key (solo se muestra una vez)
4. La API key de Resend también funciona como contraseña SMTP:

```env
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxxxxxxxx    # tu API key de Resend
SMTP_FROM=noreply@tu-dominio.com
```

---

### Opción B — Gmail SMTP (para desarrollo o uso personal)

⚠️ No recomendada para producción (límite de 500 emails/día, Google puede bloquear la cuenta).

1. Activás **verificación en 2 pasos** en tu cuenta Google (es requisito)
2. Vas a https://myaccount.google.com/apppasswords
3. En "Selecciona la app": **Otro (nombre personalizado)** → escribís "PeriodistApp"
4. Hacés clic en **"Generar"** → te da una contraseña de 16 caracteres (ej: `xxxx xxxx xxxx xxxx`)
5. Esa es tu `SMTP_PASS` (sin espacios: `xxxxxxxxxxxxxxxx`)

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=tu-cuenta@gmail.com
SMTP_PASS=xxxxxxxxxxxxxxxx        # App Password (sin espacios)
SMTP_FROM=tu-cuenta@gmail.com
```

---

### Opción C — Brevo (ex-Sendinblue)

👉 https://app.brevo.com

**Plan gratuito: 300 emails/día sin límite mensual.** Buena entregabilidad.

1. Registrarte en https://app.brevo.com/account/register
2. Ir a **Account → SMTP & API**
3. En la sección **SMTP**, encontrás:
   - **SMTP Server**: `smtp-relay.brevo.com`
   - **Port**: `587` o `465`
   - **Login**: tu email de Brevo
   - **Password / SMTP Key**: hacés clic en **"Generate a new SMTP key"**

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=tu-email@ejemplo.com
SMTP_PASS=xsmtpsib-xxxxxxxxxxxx   # SMTP key de Brevo
SMTP_FROM=noreply@tu-dominio.com
```

---

## 9. Variables de generación local (no externas)

Estas no vienen de ningún servicio — las generás vos:

### JWT_SECRET y ENCRYPTION_KEY

Correr en la terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Ejecutarlo **dos veces** y usar cada valor para una variable distinta.

```env
JWT_SECRET=a1b2c3d4e5f6...       # 64 caracteres hex
ENCRYPTION_KEY=f6e5d4c3b2a1...   # otro valor diferente, 64 caracteres hex
```

### FRONTEND_URL

```env
FRONTEND_URL=https://app.tu-dominio.com
```

---

## 10. Checklist de variables por entorno

| Variable | Gratis | Tarjeta requerida |
|---|---|---|
| `DATABASE_URL` (Neon) | Si | No |
| `GEMINI_API_KEY` | Si (cuota diaria) | No |
| `TWITTER_APP_KEY/SECRET` | Si (plan free) | No |
| `META_APP_ID/SECRET` | Si | No |
| `STRIPE_*` | Si (modo test) | Solo para live |
| `MERCADOPAGO_*` | Si (sandbox) | Solo para live |
| `GOOGLE_CLIENT_EMAIL` (Drive) | Si | No (si no supera cuotas) |
| `GOOGLE_SEARCH_API_KEY` | 100 req/día gratis | Para más volumen |
| `SMTP_*` (Resend) | 3000/mes gratis | No |

---

*Última actualización: Abril 2025*
