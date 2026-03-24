# SPEC 06: Despliegue en VPS con EasyPanel (Prisma ORM)

> Dockerizar cada servicio, configurar red interna, SSL, y desplegar en EasyPanel. Prisma Migrate en producción.

---

## Contexto

La plataforma usa Prisma ORM para gestionar el schema y las migraciones de PostgreSQL. El deploy debe ejecutar `prisma migrate deploy` al iniciar el servicio API para aplicar migraciones pendientes automáticamente.

---

## 1. Arquitectura de Red

```
                INTERNET
                   │
                   ▼
        ┌──────────────────┐
        │   EasyPanel Proxy │  (Traefik/Nginx — SSL automático)
        │   *.periodistapp  │
        └────────┬─────────┘
                 │
    ┌────────────┼────────────────────────┐
    │            │       Red Interna      │
    │            ▼                        │
    │  ┌─────────────────┐               │
    │  │    frontend      │  :3000        │
    │  │  (Nginx + SPA)   │               │
    │  └────────┬────────┘               │
    │           │ /api/* → proxy          │
    │           ▼                         │
    │  ┌─────────────────┐               │
    │  │      api         │  :3001        │
    │  │ (Express+Prisma) │               │
    │  └────────┬────────┘               │
    │           │                         │
    │    ┌──────┼──────┐                  │
    │    ▼             ▼                  │
    │ ┌──────┐   ┌──────────┐            │
    │ │ PG   │   │  Redis   │            │
    │ │:5432 │   │  :6379   │            │
    │ └──────┘   └──────────┘            │
    └─────────────────────────────────────┘
```

---

## 2. API Dockerfile (con Prisma)

### `services/api/Dockerfile`

```dockerfile
# ============================
# STAGE 1: Build
# ============================
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY prisma/ prisma/
COPY tsconfig.json ./

# Instalar todas las deps (incluyendo devDeps para build)
RUN npm ci

# Generar Prisma Client
RUN npx prisma generate

# Copiar y compilar código fuente
COPY src/ src/
COPY shared/ shared/
RUN npm run build:server

# ============================
# STAGE 2: Runtime
# ============================
FROM node:20-slim

# Dependencias del sistema (ffmpeg, python/whisper, yt-dlp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip python3-venv curl ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/whisper-venv \
    && /opt/whisper-venv/bin/pip install --no-cache-dir openai-whisper

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

ENV PATH="/opt/whisper-venv/bin:$PATH"

WORKDIR /app

# Solo dependencias de producción
COPY package*.json ./
COPY prisma/ prisma/
RUN npm ci --omit=dev

# Generar Prisma Client en runtime image
RUN npx prisma generate

# Copiar build
COPY --from=builder /app/dist/ dist/

# Copiar assets
COPY public/ public/
COPY fonts/ fonts/

RUN mkdir -p output uploads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:3001/api/health || exit 1

# IMPORTANTE: Ejecutar migraciones de Prisma antes de iniciar
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/index.js"]
```

**Punto clave**: El `CMD` ejecuta `prisma migrate deploy` antes de iniciar Node.js. Esto:
- Aplica migraciones SQL pendientes automáticamente
- Es idempotente (si no hay migraciones nuevas, no hace nada)
- Es seguro para producción (solo aplica, nunca genera ni modifica)

---

## 3. Frontend Dockerfile (sin cambios Prisma-related)

Se mantiene idéntico a la spec original — el frontend no interactúa con Prisma.

---

## 4. Docker Compose con Prisma

### `docker-compose.yml`

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: periodistapp
      POSTGRES_USER: periodistapp
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-periodistapp_dev}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U periodistapp"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    restart: unless-stopped
    ports:
      - "3001:3001"
    env_file:
      - .env
    environment:
      DATABASE_URL: postgresql://periodistapp:${POSTGRES_PASSWORD:-periodistapp_dev}@postgres:5432/periodistapp
      REDIS_URL: redis://redis:6379
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - output_data:/app/output
      - uploads_data:/app/uploads

  frontend:
    build:
      context: .
      dockerfile: services/frontend/Dockerfile
    restart: unless-stopped
    ports:
      - "3000:3000"
    depends_on:
      - api

volumes:
  postgres_data:
  redis_data:
  output_data:
  uploads_data:
```

> **Nota**: Ya no hay `init.sql` para inicializar la DB. Prisma Migrate se encarga de todo via el `CMD` del Dockerfile del API.

---

## 5. Workflow de Desarrollo con Prisma

```bash
# 1. Levantar solo PostgreSQL y Redis
docker compose up postgres redis -d

# 2. Configurar DATABASE_URL en .env
# DATABASE_URL="postgresql://periodistapp:periodistapp_dev@localhost:5432/periodistapp"

# 3. Crear primera migración
npx prisma migrate dev --name init

# 4. Seed de planes
npx prisma db seed

# 5. Desarrollo normal
npm run dev

# 6. Al cambiar schema.prisma:
npx prisma migrate dev --name descripcion_del_cambio

# 7. Inspeccionar datos
npx prisma studio
```

---

## 6. Workflow de Producción (EasyPanel)

### Al hacer deploy:

1. Push code a Git (con `prisma/migrations/` incluido)
2. EasyPanel rebuilds la imagen Docker del API
3. El `CMD` del Dockerfile ejecuta:
   - `npx prisma migrate deploy` → aplica migraciones pendientes
   - `node dist/server/index.js` → inicia el servidor
4. Primera vez: ejecutar seed manualmente:
   ```bash
   docker exec -it periodistapp-api npx prisma db seed
   ```

### Rollback de migración:

Prisma no soporta rollback automático. Para revertir:
1. Crear nueva migración que deshaga los cambios
2. O restaurar backup de DB + deploy de versión anterior

---

## 7. Variables de Entorno (con Prisma)

```env
# === DATABASE (Prisma) ===
DATABASE_URL="postgresql://periodistapp:PASSWORD@postgres:5432/periodistapp?schema=public"

# === REDIS ===
REDIS_URL=redis://redis:6379

# === AUTH ===
JWT_SECRET=GENERAR-STRING-RANDOM-64-CHARS
ENCRYPTION_KEY=GENERAR-HEX-64-CHARS

# === EMAIL ===
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=noreply@periodistapp.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx
FRONTEND_URL=https://app.periodistapp.com

# === PAYMENTS ===
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# === AI ===
DEEPSEEK_API_KEY=sk-...
GEMINI_API_KEY=AIzaSy...

# === CORS ===
CORS_ORIGINS=https://app.periodistapp.com

# === NODE ===
NODE_ENV=production
PORT=3001
```

---

## 8. Scripts de Deploy y Backup

### `scripts/deploy.sh`

```bash
#!/bin/bash
set -e
echo "=== PeriodistApp Deploy ==="
git pull origin main
docker compose -f docker-compose.prod.yml build api
docker compose -f docker-compose.prod.yml up -d api
# Prisma migrate deploy se ejecuta automáticamente en el CMD del container
echo "=== Deploy completado ==="
```

### `scripts/backup-db.sh`

```bash
#!/bin/bash
BACKUP_DIR="/opt/backups/periodistapp"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR
docker exec periodistapp-postgres pg_dump -U periodistapp -Fc periodistapp > \
    "$BACKUP_DIR/periodistapp_${DATE}.dump"
find $BACKUP_DIR -name "*.dump" -mtime +30 -delete
echo "[Backup] periodistapp_${DATE}.dump"
```

---

## 9. Nginx Config (sin cambios)

Se mantiene idéntico — Nginx no conoce Prisma.

---

## 10. Archivos importantes para Git

```gitignore
# .gitignore
node_modules/
dist/
output/
uploads/
.env

# Prisma - INCLUIR migraciones, EXCLUIR cliente generado
# prisma/migrations/ → SÍ commitear (son el historial de schema)
# node_modules/.prisma/ → NO (se regenera con prisma generate)
```

> **IMPORTANTE**: El directorio `prisma/migrations/` DEBE estar en Git. Es el equivalente a los archivos de Alembic — representan el historial versionado del schema.

---

## 11. Testing Checklist

- [ ] `docker compose up` levanta todos los servicios
- [ ] Prisma migrate deploy se ejecuta en startup del container API
- [ ] Las tablas se crean correctamente en PostgreSQL
- [ ] `npx prisma db seed` crea los planes
- [ ] API health check responde después del migrate
- [ ] Frontend proxy funciona para /api/* y /socket.io/
- [ ] SSL funciona en dominio configurado
- [ ] Backup de DB funciona y se puede restaurar
- [ ] `prisma/migrations/` está commiteado en Git
- [ ] Prisma Client se genera en build del Docker (no depende de node_modules del host)
