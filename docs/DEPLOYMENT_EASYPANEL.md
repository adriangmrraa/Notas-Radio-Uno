# PeriodistApp — Guía de Despliegue en EasyPanel

> Guía paso a paso para desplegar PeriodistApp en un VPS con EasyPanel, siguiendo los mismos patrones de ClinicForge y Platform AI Solutions.

---

## Arquitectura de Servicios

```
┌────────────────────────────────────────────────────────────────────┐
│                        EasyPanel (VPS)                             │
│                                                                    │
│  ┌──────────────────┐     ┌──────────────────┐                    │
│  │    frontend       │     │       api         │                   │
│  │  (Nginx + React)  │────►│  (Express+Prisma) │                   │
│  │  Puerto 80        │     │  Puerto 3001      │                   │
│  │  DOMINIO PÚBLICO  │     │  DOMINIO PÚBLICO  │                   │
│  └──────────────────┘     └────────┬─────────┘                    │
│                                    │                               │
│                         ┌──────────┼──────────┐                    │
│                         ▼                     ▼                    │
│                  ┌────────────┐        ┌────────────┐             │
│                  │  postgres   │        │   redis    │             │
│                  │  (Add-on)   │        │  (Add-on)  │             │
│                  │  Puerto 5432│        │ Puerto 6379│             │
│                  └────────────┘        └────────────┘             │
└────────────────────────────────────────────────────────────────────┘

Servicios públicos (con dominio HTTPS):
  - frontend  → https://app.periodistapp.com
  - api       → https://api.periodistapp.com

Servicios internos (sin dominio público):
  - postgres  → periodistapp_postgres:5432
  - redis     → periodistapp_redis:6379
```

### Diferencia con ClinicForge / Platform AI Solutions

| Aspecto | ClinicForge / Platform AI | PeriodistApp |
|---------|--------------------------|--------------|
| Backend | Python FastAPI + BFF Node.js | **Express.js directo** (no necesita BFF) |
| ORM | SQLAlchemy + Alembic | **Prisma ORM + Prisma Migrate** |
| Frontend proxy | Nginx proxea a BFF, BFF proxea a orchestrator | **Nginx proxea directo al API** |
| Servicios | 5-8 microservicios | **2 servicios app + 2 add-ons** |
| Migraciones | `alembic upgrade head` en start.sh | **`npx prisma migrate deploy`** en CMD |
| Runtime env | envsubst para Vite vars | **Build-time args para Vite vars** |

---

## Pre-requisitos

1. VPS con EasyPanel instalado (Ubuntu 22.04+ recomendado, 4GB+ RAM)
2. Dominio apuntando al VPS (`app.periodistapp.com`, `api.periodistapp.com`)
3. Repositorio Git (GitHub) con el código de PeriodistApp
4. Cuentas de Stripe (pagos), Gmail/SMTP (emails)

---

## Paso 1: Crear Proyecto en EasyPanel

1. Ir a EasyPanel Dashboard → **"New Project"**
2. Nombre: `periodistapp`
3. Esto crea el proyecto y su red interna Docker

---

## Paso 2: Crear Add-ons (PostgreSQL + Redis)

### 2.1 PostgreSQL

1. Dentro del proyecto → **"New Service"** → **"Database"** → **"PostgreSQL"**
2. Configuración:
   - **Service Name**: `postgres`
   - **Image**: `postgres:16-alpine`
   - **Database**: `periodistapp`
   - **Username**: `periodistapp`
   - **Password**: (generar uno seguro, guardarlo)
3. Anotar el DSN resultante:
   ```
   postgresql://periodistapp:PASSWORD@periodistapp_postgres:5432/periodistapp
   ```

> **Importante**: En EasyPanel, el hostname interno del servicio es `{proyecto}_{servicio}`. Para PeriodistApp: `periodistapp_postgres`.

### 2.2 Redis

1. **"New Service"** → **"Database"** → **"Redis"**
2. Configuración:
   - **Service Name**: `redis`
   - **Image**: `redis:7-alpine`
   - **Password**: (generar uno seguro)
3. Anotar la URL:
   ```
   redis://default:PASSWORD@periodistapp_redis:6379
   ```

---

## Paso 3: Preparar el Repositorio

### 3.1 Estructura de archivos necesaria

```
periodistapp/
├── Dockerfile                    # Para el servicio API
├── Dockerfile.frontend           # Para el servicio Frontend
├── nginx.conf                    # Config de Nginx para el frontend
├── prisma/
│   ├── schema.prisma             # Schema de Prisma (fuente de verdad)
│   ├── migrations/               # Migraciones versionadas (auto-generadas)
│   └── seed.ts                   # Seed de planes iniciales
├── src/
│   ├── server/                   # Backend Express
│   └── client/                   # Frontend React
├── public/                       # Assets estáticos
├── fonts/                        # Tipografías
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .dockerignore
```

### 3.2 `.dockerignore`

```dockerignore
node_modules
dist
output
uploads
.env
.env.*
*.md
.git
.gitignore
```

### 3.3 `Dockerfile` (Servicio API)

```dockerfile
# ============================================
# STAGE 1: Build TypeScript + Generate Prisma
# ============================================
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma/ prisma/
COPY tsconfig.json ./

RUN npm ci

# Generar Prisma Client (tipos TypeScript)
RUN npx prisma generate

COPY src/ src/

RUN npm run build:server

# ============================================
# STAGE 2: Runtime
# ============================================
FROM node:20-slim

# Dependencias del sistema: ffmpeg, python/whisper, yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Whisper en venv aislado
RUN python3 -m venv /opt/whisper-venv \
    && /opt/whisper-venv/bin/pip install --no-cache-dir openai-whisper

# yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

ENV PATH="/opt/whisper-venv/bin:$PATH"

WORKDIR /app

# Solo producción
COPY package*.json ./
COPY prisma/ prisma/
RUN npm ci --omit=dev

# Regenerar Prisma Client en imagen runtime
RUN npx prisma generate

# Copiar build compilado
COPY --from=builder /app/dist/ dist/

# Assets
COPY public/ public/
COPY fonts/ fonts/

RUN mkdir -p output uploads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:3001/api/health || exit 1

# Prisma migrate deploy + start server
# (mismo patrón que alembic upgrade head en start.sh de ClinicForge)
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed || true && node dist/server/index.js"]
```

> **Nota sobre el CMD**: `npx prisma db seed || true` ejecuta el seed la primera vez y no falla si ya se ejecutó (los seeds usan `skipDuplicates: true`). Esto es equivalente al `start.sh` de ClinicForge que detecta si la DB es nueva.

### 3.4 `Dockerfile.frontend` (Servicio Frontend)

```dockerfile
# ============================================
# STAGE 1: Build React con Vite
# ============================================
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/client/ src/client/
COPY src/shared/ src/shared/
COPY public/ public/
COPY vite.config.ts ./
COPY tsconfig.json ./
COPY index.html ./

# Variables de build (se inyectan como build args en EasyPanel)
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build:client

# ============================================
# STAGE 2: Nginx
# ============================================
FROM nginx:1.27-alpine

COPY --from=builder /app/dist/client /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
```

### 3.5 `nginx.conf`

```nginx
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript
               application/x-javascript application/xml application/json
               application/javascript;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache de assets estáticos (1 año)
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Proxy al API
    location /api/ {
        # En EasyPanel, el API tiene su propio dominio público.
        # Si se quiere proxear internamente en lugar de llamar al dominio:
        # proxy_pass http://periodistapp_api:3001;
        #
        # Pero el patrón de Platform AI es que el frontend llama
        # directamente al dominio público del API (VITE_API_BASE_URL).
        # Así que este bloque es opcional y se deja comentado.
        return 404;
    }

    # Proxy Socket.IO (si el frontend llama al mismo dominio)
    # location /socket.io/ {
    #     proxy_pass http://periodistapp_api:3001;
    #     proxy_http_version 1.1;
    #     proxy_set_header Upgrade $http_upgrade;
    #     proxy_set_header Connection "upgrade";
    #     proxy_set_header Host $host;
    #     proxy_read_timeout 86400s;
    # }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    error_page 500 502 503 504 /50x.html;
}
```

> **Patrón de Platform AI Solutions**: El frontend NO proxea al API a través de Nginx. En su lugar, el frontend hace requests directamente al dominio público del API (`https://api.periodistapp.com`). Esto es más simple y escalable. Las variables de Vite configuran la URL del API en build time.

---

## Paso 4: Crear Servicio API en EasyPanel

1. **"New Service"** → **"App"**
2. Configuración:

| Campo | Valor |
|-------|-------|
| **Service Name** | `api` |
| **Source** | GitHub → tu repo |
| **Branch** | `master` (o `main`) |
| **Dockerfile Path** | `Dockerfile` |
| **Port** | `3001` |
| **Domain** | `api.periodistapp.com` |
| **HTTPS** | Enabled (Let's Encrypt automático) |
| **Zero Downtime** | `true` |

### 4.1 Variables de Entorno del API

Ir a la pestaña **"Environment"** del servicio `api` y agregar:

```env
# === DATABASE (Prisma) ===
DATABASE_URL=postgresql://periodistapp:TU_PASSWORD@periodistapp_postgres:5432/periodistapp

# === REDIS ===
REDIS_URL=redis://default:TU_PASSWORD@periodistapp_redis:6379

# === AUTH ===
JWT_SECRET=GENERAR_CON_openssl_rand_-hex_32
ENCRYPTION_KEY=GENERAR_CON_openssl_rand_-hex_32

# === EMAIL (SMTP) ===
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=noreply@periodistapp.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx
SMTP_FROM=noreply@periodistapp.com
FRONTEND_URL=https://app.periodistapp.com

# === PAYMENTS ===
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# === AI (defaults para tenants sin API keys propias) ===
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=AIzaSy...
XAI_API_KEY=xai-...

# === CORS ===
CORS_ORIGINS=https://app.periodistapp.com

# === APP ===
NODE_ENV=production
PORT=3001
```

> **Patrón idéntico a Platform AI**: Cada variable se configura en EasyPanel en la sección Environment del servicio. Los secretos nunca se commitean al repo.

### 4.2 Health Check del API

EasyPanel usa el `HEALTHCHECK` del Dockerfile automáticamente. Verificar que responde:

```
GET https://api.periodistapp.com/api/health
→ { "status": "ok", "timestamp": "..." }
```

---

## Paso 5: Crear Servicio Frontend en EasyPanel

1. **"New Service"** → **"App"**
2. Configuración:

| Campo | Valor |
|-------|-------|
| **Service Name** | `frontend` |
| **Source** | GitHub → tu repo |
| **Branch** | `master` |
| **Dockerfile Path** | `Dockerfile.frontend` |
| **Port** | `80` |
| **Domain** | `app.periodistapp.com` |
| **HTTPS** | Enabled |
| **Zero Downtime** | `true` |

### 5.1 Build Args del Frontend

En EasyPanel, sección **"Build"** → **"Build Arguments"**:

```
VITE_API_BASE_URL=https://api.periodistapp.com
```

> **Esto es equivalente a Platform AI Solutions**, donde `VITE_API_BASE_URL` apunta al dominio del orchestrator. En PeriodistApp, apunta al dominio del API.

### 5.2 Variables de Entorno del Frontend

El frontend es estático (Nginx), no necesita variables de runtime. Todo se inyecta en build time via `ARG`.

Si necesitás runtime env injection como ClinicForge (para cambiar la URL sin rebuild), usar el patrón `envsubst`:

```dockerfile
# Agregar al Dockerfile.frontend, Stage 2:
RUN echo 'window.__RUNTIME_CONFIG__={API_URL:"$VITE_API_BASE_URL"};' \
    > /usr/share/nginx/html/runtime-config.js.template

RUN echo '#!/bin/sh' > /entrypoint.sh && \
    echo 'envsubst < /usr/share/nginx/html/runtime-config.js.template > /usr/share/nginx/html/runtime-config.js' >> /entrypoint.sh && \
    echo 'exec nginx -g "daemon off;"' >> /entrypoint.sh && \
    chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

---

## Paso 6: Configurar DNS

En tu proveedor de DNS (Cloudflare, Namecheap, etc.):

```
Tipo    Nombre    Valor           TTL
A       app       <IP_DEL_VPS>    300
A       api       <IP_DEL_VPS>    300
```

EasyPanel genera los certificados SSL automáticamente con Let's Encrypt una vez que el DNS apunte correctamente.

---

## Paso 7: Deploy Inicial

### 7.1 Orden de deploy

1. **PostgreSQL** (add-on, ya creado)
2. **Redis** (add-on, ya creado)
3. **API** (primero, porque ejecuta migraciones)
4. **Frontend** (último, depende de que el API esté vivo)

> **Mismo orden que ClinicForge**: infraestructura primero, luego backend, luego frontend.

### 7.2 Primer deploy del API

1. En EasyPanel, ir al servicio `api` → **"Deploy"**
2. EasyPanel clona el repo, construye la imagen Docker
3. El `CMD` ejecuta:
   - `npx prisma migrate deploy` → crea todas las tablas
   - `npx prisma db seed` → inserta los planes (trial, starter, professional, enterprise)
   - `node dist/server/index.js` → inicia Express

4. Verificar en los logs de EasyPanel:
   ```
   [Prisma] Aplicando migración: 20260323_init
   Seeding database...
   Seed completed.
   [Server] Escuchando en puerto 3001
   [Prisma] Conectado a PostgreSQL
   ```

### 7.3 Deploy del Frontend

1. Ir al servicio `frontend` → **"Deploy"**
2. Verificar que build args (`VITE_API_BASE_URL`) están configurados
3. EasyPanel construye y sirve el SPA

4. Verificar en el navegador:
   ```
   https://app.periodistapp.com → Landing page
   ```

---

## Paso 8: Configurar Stripe Webhooks

1. En [Stripe Dashboard](https://dashboard.stripe.com/webhooks) → **"Add endpoint"**
2. URL: `https://api.periodistapp.com/api/billing/webhook/stripe`
3. Eventos a escuchar:
   - `checkout.session.completed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
4. Copiar el **Webhook Signing Secret** (`whsec_...`)
5. Actualizar la variable `STRIPE_WEBHOOK_SECRET` en EasyPanel → redeploy

---

## Paso 9: Verificación Post-Deploy

### Checklist

```bash
# 1. Health check del API
curl https://api.periodistapp.com/api/health
# → {"status":"ok","timestamp":"..."}

# 2. Verificar que Prisma migró correctamente
# (desde la terminal del container en EasyPanel)
npx prisma migrate status
# → Database schema is up to date!

# 3. Verificar planes creados
curl https://api.periodistapp.com/api/billing/plans
# → {"plans":[{"name":"starter",...},{"name":"professional",...},{"name":"enterprise",...}]}

# 4. Verificar frontend carga
curl -I https://app.periodistapp.com
# → HTTP/2 200

# 5. Verificar registro funciona
curl -X POST https://api.periodistapp.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"Test1234","fullName":"Test","organizationName":"Test Org"}'
# → {"message":"Cuenta creada. Revisa tu email..."}

# 6. Verificar WebSocket
# Abrir https://app.periodistapp.com en el navegador, login, verificar que Socket.IO conecta
```

---

## Paso 10: Backups

### Backup automático de PostgreSQL

Crear un cron job en el VPS (fuera de EasyPanel):

```bash
# /opt/scripts/backup-periodistapp.sh
#!/bin/bash
BACKUP_DIR="/opt/backups/periodistapp"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

mkdir -p $BACKUP_DIR

# Dump de la base de datos
docker exec $(docker ps -qf "name=periodistapp.*postgres") \
    pg_dump -U periodistapp -Fc periodistapp \
    > "$BACKUP_DIR/periodistapp_${DATE}.dump"

# Limpiar backups viejos
find $BACKUP_DIR -name "*.dump" -mtime +$RETENTION_DAYS -delete

echo "[$(date)] Backup: periodistapp_${DATE}.dump ($(du -h $BACKUP_DIR/periodistapp_${DATE}.dump | cut -f1))"
```

```bash
# Agregar al crontab del VPS
crontab -e
# Ejecutar cada día a las 3 AM
0 3 * * * /opt/scripts/backup-periodistapp.sh >> /var/log/periodistapp-backup.log 2>&1
```

### Restaurar backup

```bash
docker exec -i $(docker ps -qf "name=periodistapp.*postgres") \
    pg_restore -U periodistapp -d periodistapp --clean --if-exists < backup_file.dump
```

---

## Troubleshooting

### Problema: API no inicia

```bash
# Ver logs en EasyPanel → servicio api → Logs
# O desde el VPS:
docker logs $(docker ps -qf "name=periodistapp.*api") --tail 50
```

Causas comunes:
- `DATABASE_URL` mal configurada → verificar hostname (`periodistapp_postgres`, no `postgres`)
- Prisma migrate falla → verificar que el schema.prisma está incluido en la imagen Docker
- Puerto ocupado → verificar que no hay otro servicio en 3001

### Problema: Frontend no carga

- Verificar que `VITE_API_BASE_URL` está como **Build Argument** (no Environment Variable)
- Verificar que el dominio DNS apunta al VPS
- Verificar que el certificado SSL se generó (puede tardar 1-2 minutos)

### Problema: CORS errors

- Verificar que `CORS_ORIGINS` en el API incluye el dominio exacto del frontend
- Debe ser `https://app.periodistapp.com` (sin trailing slash)

### Problema: Socket.IO no conecta

- Verificar que el frontend usa la URL correcta del API para Socket.IO
- En producción, Socket.IO debe conectar a `https://api.periodistapp.com`
- Verificar que EasyPanel no tiene timeout para WebSocket (por defecto sí lo soporta)

### Problema: Prisma migrate falla

```bash
# Entrar al container del API
docker exec -it $(docker ps -qf "name=periodistapp.*api") sh

# Ver estado de migraciones
npx prisma migrate status

# Forzar deploy (si hay problemas)
npx prisma migrate deploy

# Reset completo (DESTRUCTIVO - solo si es necesario)
npx prisma migrate reset --force
```

---

## Resumen de Servicios en EasyPanel

| Servicio | Tipo | Dockerfile | Puerto | Dominio | Público |
|----------|------|------------|--------|---------|---------|
| `postgres` | Database Add-on | postgres:16-alpine | 5432 | — | No |
| `redis` | Database Add-on | redis:7-alpine | 6379 | — | No |
| `api` | App (Git) | `Dockerfile` | 3001 | api.periodistapp.com | Sí |
| `frontend` | App (Git) | `Dockerfile.frontend` | 80 | app.periodistapp.com | Sí |

### Networking Interno

| Desde | Hacia | Hostname | Puerto |
|-------|-------|----------|--------|
| API | PostgreSQL | `periodistapp_postgres` | 5432 |
| API | Redis | `periodistapp_redis` | 6379 |
| Frontend (browser) | API | `https://api.periodistapp.com` | 443 |
| Stripe Webhook | API | `https://api.periodistapp.com/api/billing/webhook/stripe` | 443 |

---

## Actualizaciones Futuras

Cada push a `master` en GitHub puede triggerear un redeploy automático en EasyPanel:

1. EasyPanel detecta el push (webhook de GitHub)
2. Reconstruye la imagen Docker
3. El nuevo container ejecuta `npx prisma migrate deploy` (aplica migraciones nuevas)
4. El seed no duplica datos (`skipDuplicates: true`)
5. Express inicia con el código actualizado
6. Zero downtime: EasyPanel hace rolling update (container viejo sigue respondiendo hasta que el nuevo está healthy)

Para cambios de schema:
1. Modificar `prisma/schema.prisma` localmente
2. `npx prisma migrate dev --name descripcion_del_cambio`
3. Commitear `prisma/migrations/` al repo
4. Push → deploy automático → migración se aplica en producción
