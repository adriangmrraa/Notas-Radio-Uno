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

## 🛠️ Paso 1: Generar Migraciones de Prisma (Local)

**Si ya tenés `prisma/migrations/`** podés saltar este paso.  
**Si no**, ejecutá localmente (requiere PostgreSQL instalado o Docker):

### Opción A – Con PostgreSQL local
```bash
# 1. Asegurate de que PostgreSQL esté corriendo
sudo service postgresql start  # o equivalente

# 2. Crear una base de datos temporal
createdb periodistapp_temp

# 3. Generar migraciones
DATABASE_URL="postgresql://postgres@localhost/periodistapp_temp" npx prisma migrate dev --name init

# 4. Verificar que se creó `prisma/migrations/`
ls -la prisma/migrations/
```

### Opción B – Con Docker (si no tenés PostgreSQL)
```bash
# 1. Levantar PostgreSQL temporal
docker run --name pg_temp -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16

# 2. Generar migraciones
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/postgres" npx prisma migrate dev --name init

# 3. Detener y eliminar el contenedor después
docker stop pg_temp && docker rm pg_temp
```

### Opción C – Usar las migraciones ya generadas
**Ya incluí una migración inicial** (`prisma/migrations/20250330000000_init/`).  
Podés usarla directamente, pero **verificá que el SQL sea compatible** con tu versión de PostgreSQL.

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
[Prisma] Aplicando migración: 20250330000000_init
Seeding database...
Seed completed.
[Server] Escuchando en puerto 3001
[Prisma] Conectado a PostgreSQL
```

Si hay errores de migración, verificar que `prisma/migrations/` existe en el repo.

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
| **Migraciones no aplican** | Verificar que `prisma/migrations/` existe en el repo. Si no, generar localmente (Paso 1). |
| **API no conecta a PostgreSQL** | Revisar `DATABASE_URL` (usar hostname interno `periodistapp_postgres`). |
| **Frontend no carga** | Verificar `VITE_API_BASE_URL` en build args del frontend. |
| **WebSockets no funcionan** | El API ya incluye Socket.IO; asegurarse de que el frontend use `wss://api.tudominio.com`. |
| **Script Python (audio) falla** | El Dockerfile del API instala Whisper, ffmpeg y yt‑dlp. Si falta alguna dependencia, agregarla al Dockerfile. |

---

## 🔄 Actualizaciones Futuras

1. **Push al repo** → EasyPanel detecta cambios y redepliega automáticamente.
2. **Cambiar variables** → Actualizar en EasyPanel → redeploy.
3. **Nuevas migraciones** → Agregar archivos a `prisma/migrations/` y commit → redeploy del API las aplicará.

---

## 📦 Archivos de Deploy Incluidos

- `Dockerfile` – Backend (Express + Prisma + Python/Whisper)
- `Dockerfile.frontend` – Frontend (React + Nginx)
- `nginx.conf` – Configuración Nginx para SPA
- `.dockerignore` – Excluye archivos innecesarios
- `prisma/migrations/20250330000000_init/` – Migración inicial (todas las tablas)
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