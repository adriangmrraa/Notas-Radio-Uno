# PeriodistApp — Guía de Despliegue en EasyPanel

> Guía para desplegar PeriodistApp en un VPS con EasyPanel: **2 servicios** (frontend nginx + api Node) contra **Neon Postgres externo**.
>
> **Stack real (Épica J)**: Drizzle ORM + `@neondatabase/serverless` (WebSocket a Neon). No hay Prisma ni Postgres add-on local: la DB vive en Neon. Los clips salen por ffmpeg (`clip_render_jobs`), no hay Chromium en los contenedores (render Remotion = opt-in local).

---

## Arquitectura de Servicios

```
┌────────────────────────────────────────────────────────────────┐
│                        EasyPanel (VPS)                          │
│                                                                 │
│  ┌──────────────────┐      ┌──────────────────┐                │
│  │    frontend       │─────►│       api         │               │
│  │  (Nginx + React)  │ /api │  (Express+Socket) │               │
│  │  Puerto 80        │      │  Puerto 3001      │               │
│  │  DOMINIO PÚBLICO  │      │  DOMINIO PÚBLICO  │               │
│  └──────────────────┘      └────────┬──────────┘                │
│                                     │ WebSocket Neon             │
└─────────────────────────────────────┼───────────────────────────┘
                                       ▼
                              ┌────────────────┐
                              │  Neon Postgres  │  (externo)
                              │  serverless     │
                              └────────────────┘
```

Dos dominios posibles:
- `app.tudominio.com` → frontend (nginx)
- `api.tudominio.com` → api

O un solo dominio: el frontend proxea `/api/` y `/socket.io/` al servicio `api` por la red interna de EasyPanel vía `API_UPSTREAM` (recomendado — mismo origen, sin CORS ni doble dominio).

---

## Paso 1: Crear proyecto y servicio API

1. EasyPanel → **New Project** → `periodistapp`
2. **New Service → App**:
   - Source: GitHub → repo → branch `master`
   - **Dockerfile Path**: `Dockerfile`
   - Port: `3001`
   - Domain: `api.tudominio.com` (o interno si usás un solo dominio)
   - HTTPS: enabled si tiene dominio propio

### Variables de entorno del API (Environment)

```env
NODE_ENV=production
PORT=3001

# Neon (REQUERIDA — el driver es WebSocket, no habla con Postgres local)
DATABASE_URL=postgresql://USER:PASS@ep-xxx.sa-east-1.aws.neon.tech/DB?sslmode=require

# Auth — JWT_SECRET es OBLIGATORIO: sin él el proceso no arranca
JWT_SECRET=<openssl rand -hex 32>
ENCRYPTION_KEY=<openssl rand -hex 32>

# Público del frontend (CORS) y de la API (callbacks OAuth)
FRONTEND_URL=https://app.tudominio.com
API_PUBLIC_URL=https://api.tudominio.com
ALLOWED_ORIGINS=https://app.tudominio.com

# IA — al menos una
GEMINI_API_KEY=...
DEEPSEEK_API_KEY=...
XAI_API_KEY=...

# Opcionales por feature (ver .env.example):
# ASSEMBLYAI_API_KEY, ZERNIO_API_KEY, STRIPE_*, MP_ACCESS_TOKEN,
# SMTP_*, META_*, TWITTER_*, GOOGLE_*, INGEST_PROXY_URLS,
# RETENTION_PURGE_*, BACKUP_*, PUBLISH_WORKER_*,
# PROCESS_ROLE=all, MAX_CONCURRENT_TRANSMISSIONS, *_MAX_IN_FLIGHT
```

> **Migraciones**: automáticas al boot (`runMigrations` aplica `drizzle/*.sql`). El primer deploy crea todo el schema; no hay `migrate deploy` manual.

### Volúmenes del API (persistencia)

El servidor escribe en filesystem local: `data/raw` (crudos de stream), `output/` (renders), `uploads/`, `data/backup`. Sin volúmenes estos archivos son **efímeros** (se pierden en cada redeploy).

Mapear en EasyPanel → service `api` → **Mounts**:

| Mount Type | Container Path | Host Path |
|------------|----------------|-----------|
| Volume     | `/app/data`    | `periodistapp_data` |
| Volume     | `/app/output`  | `periodistapp_output` |
| Volume     | `/app/uploads` | `periodistapp_uploads` |

---

## Paso 2: Servicio Frontend (nginx)

**New Service → App**:
- Source: mismo repo → branch `master`
- **Dockerfile Path**: `Dockerfile.frontend`
- Port: `80`
- Domain: `app.tudominio.com` (HTTPS enabled)

### Variables

| Variable | Valor | Dónde |
|----------|-------|-------|
| `API_UPSTREAM` | `http://api:3001` | Environment (runtime — envsubst del template nginx) |
| `VITE_API_BASE_URL` | vacío o `https://api.tudominio.com` | **Build Argument** (build time) |

- Con un solo dominio (frontend proxea `/api/`): `API_UPSTREAM=http://api:3001` y `VITE_API_BASE_URL` vacío (el cliente llama mismo-origen).
- Con dos dominios: `VITE_API_BASE_URL=https://api.tudominio.com` como build arg; el bloque `/api/` de nginx queda como respaldo.

El template `nginx/default.conf.template` ya proxea `/api/` y `/socket.io/` con headers de upgrade y usa `resolver 127.0.0.11` para resolver el nombre del servicio dentro de la red de EasyPanel.

---

## Paso 3: Orden de deploy y verificación

1. **api** primero (corre migraciones al boot)
2. **frontend** después

```bash
# Health real (DB + migraciones + disco)
curl https://api.tudominio.com/api/health
# o vía frontend si proxea:
curl https://app.tudominio.com/api/health

# Frontend
curl -I https://app.tudominio.com
```

Checklist:
- [ ] `/api/health` responde 200 (o 503 `degraded` con causa clara si falta env)
- [ ] Registro/login funciona
- [ ] Socket.IO conecta (panel live en el navegador)
- [ ] `pm2`/proceso único: EasyPanel corre 1 réplica del api (escalar >1 rompe Socket.IO/schedulers igual que PM2 cluster — mantener replicas=1)

---

## Troubleshooting

| Síntoma | Causa probable |
|---------|----------------|
| API no arranca | `DATABASE_URL` no es Neon (o `JWT_SECRET` faltante — ver logs) |
| `JWT_SECRET es obligatorio` en logs | Falta la env en el servicio api |
| `/api/` 502 desde frontend | `API_UPSTREAM` mal seteado o el servicio api no se llama `api` |
| Socket.IO desconecta | Falta header Upgrade — revisar que el template se aplicó (`/etc/nginx/conf.d/default.conf` dentro del container) |
| Archivos desaparecen tras redeploy | Volúmenes de `data/output/uploads` no mapeados |
| Remotion render falla | Esperado: no hay Chromium en el contenedor (opt-in local) |

---

## Actualizaciones

Push a `master` → EasyPanel rebuildea → `npm ci` + build + boot con migraciones idempotentes. Los volúmenes persisten los assets entre deploys.
