# 🚀 Guía de Despliegue Rápido – PeriodistApp en EasyPanel (VPS)

**Estado del proyecto**: ✅ **Listo para producción** (con migraciones generadas)

## 📋 Pre‑requisitos

1. **VPS con EasyPanel** (Ubuntu 22.04+, 2GB+ RAM recomendado)
2. **Dominios** apuntando al VPS:
   - `app.tudominio.com` → frontend
   - `api.tudominio.com` → backend API
3. **Repositorio Git** (GitHub) con el código de PeriodistApp
4. **API keys** de producción listas (DeepSeek, Gemini, Twitter, Google, etc.)

---

## 🛠️ Paso 1: Migraciones de Drizzle (Local)

**Si ya tenés `drizzle/` con archivos `*.sql`** podés saltar este paso.
PeriodistApp usa **Drizzle ORM** — el schema vive en `src/server/db/schema/` y las
migraciones SQL versionadas en `drizzle/` (sin client codegen: no hay paso `generate` de cliente).

**Si no**, generá las migraciones localmente (solo necesita el schema, no una DB viva):

```bash
# 1. Generar migraciones SQL a partir del schema Drizzle
npm run db:generate        # = npx drizzle-kit generate → escribe drizzle/NNNN_*.sql

# 2. Verificar que se crearon los archivos
ls -la drizzle/

# 3. (Opcional) Aplicarlas a mano contra una DB
DATABASE_URL="postgresql://postgres@localhost/periodistapp_temp" npm run db:migrate   # = npx drizzle-kit migrate
```

> **Nota**: en producción NO hace falta correr `db:migrate` — el servidor aplica
> las migraciones automáticamente al arrancar (`runMigrations()` en `src/server/index.ts`).

---

## 🗂️ Paso 2: Commit y Push

```bash
git add .
git commit -m "feat: archivos de deploy y migraciones iniciales"
git push origin master
```

---

## 🖥️ Paso 3: Crear Proyecto en EasyPanel

1. Ir a **EasyPanel Dashboard** → **"New Project"**
2. Nombre: `periodistapp`
3. Esto crea la red interna Docker

---

## 🗃️ Paso 4: Add‑ons (PostgreSQL + Redis)

### 4.1 PostgreSQL
1. Dentro del proyecto → **"New Service"** → **"Database"** → **"PostgreSQL"**
2. Configuración:
   - **Service Name**: `postgres`
   - **Image**: `postgres:16-alpine`
   - **Database**: `periodistapp`
   - **Username**: `periodistapp`
   - **Password**: (generar uno seguro, guardarlo)

**Anotar el DSN interno**:
```
postgresql://periodistapp:PASSWORD@periodistapp_postgres:5432/periodistapp
```

### 4.2 Redis (opcional, pero recomendado)
1. **"New Service"** → **"Database"** → **"Redis"**
2. Configuración:
   - **Service Name**: `redis`
   - **Image**: `redis:7-alpine`
   - **Password**: (generar seguro)

**URL interna**: `redis://default:PASSWORD@periodistapp_redis:6379`

---

## 🐳 Paso 5: Servicio API (Backend)

1. **"New Service"** → **"App"**
2. Configuración:

| Campo | Valor |
|-------|-------|
| **Service Name** | `api` |
| **Source** | GitHub → tu repo |
| **Branch** | `master` |
| **Dockerfile Path** | `Dockerfile` |
| **Port** | `3001` |
| **Domain** | `api.tudominio.com` |
| **HTTPS** | ✅ Enabled |
| **Zero Downtime** | ✅ `true` |

### 5.1 Variables de Entorno del API (pestaña Environment)

```env
# === DATABASE ===
DATABASE_URL=postgresql://periodistapp:PASSWORD@periodistapp_postgres:5432/periodistapp

# === REDIS ===
REDIS_URL=redis://default:PASSWORD@periodistapp_redis:6379

# === AUTH ===
JWT_SECRET=generar_con_openssl_rand_-hex_32
ENCRYPTION_KEY=generar_con_openssl_rand_-hex_32
FRONTEND_URL=https://app.tudominio.com

# === AI Providers (mínimo uno) ===
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=AIzaSy...
XAI_API_KEY=xai-...

# === Twitter ===
TWITTER_APP_KEY=
TWITTER_APP_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# === Google Drive ===
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_FOLDER_ID=

# === Meta (Facebook/Instagram) ===
META_APP_ID=
META_APP_SECRET=
META_CONFIG_ID=

# === Stripe (pagos) ===
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# === Email (SMTP) ===
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=noreply@tudominio.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx
SMTP_FROM=noreply@tudominio.com

# === Otros ===
PLATFORM_NAME=Radio Uno Formosa
NODE_ENV=production
PORT=3001
```

> **Nota**: Todas las variables del `.env.example` deben estar configuradas.

### 5.2 Health Check
El API expone `/api/health` → EasyPanel lo usa automáticamente.

---

## 🌐 Paso 6: Servicio Frontend (React)

1. **"New Service"** → **"App"**
2. Configuración:

| Campo | Valor |
|-------|-------|
| **Service Name** | `frontend` |
| **Source** | GitHub → tu repo |
| **Branch** | `master` |
| **Dockerfile Path** | `Dockerfile.frontend` |
| **Port** | `80` |
| **Domain** | `app.tudominio.com` |
| **HTTPS** | ✅ Enabled |
| **Zero Downtime** | ✅ `true` |

### 6.1 Build Arguments (pestaña Build)
```
VITE_API_BASE_URL=https://api.tudominio.com
```

**No necesita variables de entorno** (todo se inyecta en build time).

---

## 🌍 Paso 7: Configurar DNS

En tu proveedor DNS (Cloudflare, Namecheap, etc.):

```
A   app   <IP_DEL_VPS>   300
A   api   <IP_DEL_VPS>   300
```

EasyPanel generará certificados SSL automáticamente una vez que el DNS apunte.

---

## 🚀 Paso 8: Orden de Deploy

**IMPORTANTE**: Seguir este orden exacto:

1. **PostgreSQL** (add‑on) → deploy
2. **Redis** (add‑on) → deploy
3. **API** → deploy (ejecuta migraciones automáticamente)
4. **Frontend** → deploy (último)

### 8.1 Verificar primer deploy del API
En los logs de EasyPanel del servicio `api` buscar:

```
[DB] Connected to database.
[DB] Running migrations...
[DB] Migrations complete.
[Server] Servidor corriendo en http://localhost:3001
```

Si hay errores de migración, verificar que `drizzle/` existe en el repo con los `*.sql` generados.

### 8.2 Verificar frontend
Abrir `https://app.tudominio.com` → debe cargar la landing page.

---

## 🧪 Paso 9: Verificación Post‑Deploy

```bash
# Health check
curl https://api.tudominio.com/api/health
# → {"status":"ok","timestamp":"..."}

# Verificar planes creados
curl https://api.tudominio.com/api/billing/plans
# → {"plans":[{"name":"starter",...}]}

# Verificar registro
curl -X POST https://api.tudominio.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"Test1234","fullName":"Test","organizationName":"Test Org"}'
# → {"message":"Cuenta creada. Revisa tu email..."}
```

---

## ⚠️ Problemas Comunes y Soluciones

| Problema | Solución |
|----------|----------|
| **Migraciones no aplican** | Verificar que `drizzle/` existe en el repo con los `*.sql`. Si no, generar localmente (Paso 1). |
| **API no conecta a PostgreSQL** | Revisar `DATABASE_URL` (usar hostname interno `periodistapp_postgres`). |
| **Frontend no carga** | Verificar `VITE_API_BASE_URL` en build args del frontend. |
| **WebSockets no funcionan** | El API ya incluye Socket.IO; asegurarse de que el frontend use `wss://api.tudominio.com`. |
| **Script Python (audio) falla** | El Dockerfile del API instala Whisper, ffmpeg y yt‑dlp. Si falta alguna dependencia, agregarla al Dockerfile. |

---

## 🔄 Actualizaciones Futuras

1. **Push al repo** → EasyPanel detecta cambios y redepliega automáticamente.
2. **Cambiar variables** → Actualizar en EasyPanel → redeploy.
3. **Nuevas migraciones** → `npm run db:generate` tras tocar `src/server/db/schema/`, commitear `drizzle/` → redeploy del API las aplica al arrancar.

---

## 📦 Archivos de Deploy Incluidos

- `Dockerfile` – Backend (Express + Drizzle + Python/Whisper)
- `Dockerfile.frontend` – Frontend (React + Nginx)
- `nginx.conf` – Configuración Nginx para SPA
- `.dockerignore` – Excluye archivos innecesarios
- `drizzle/` – Migraciones SQL versionadas (se aplican solas al boot del API)
- `src/server/index.ts` – Endpoint `/api/health` agregado

---

## 🆘 Soporte

Si algo falla:
1. Revisar logs en EasyPanel (pestaña **Logs** de cada servicio)
2. Verificar que todas las variables de entorno estén configuradas
3. Asegurarse de que los dominios apunten correctamente al VPS
4. Contactar con soporte de EasyPanel si el problema es de infraestructura

---

**¡Listo!** PeriodistApp debería estar funcionando en tu VPS.  
Cualquier duda, consultá la documentación técnica en `docs/` o abrí un issue en el repo.

**✨ ¡Éxito con tu plataforma de automatización periodística!**