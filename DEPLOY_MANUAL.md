# Despliegue Manual en VPS con PM2 + Nginx

Guía paso a paso para desplegar PeriodistApp en un VPS (Ubuntu/Debian) con **PM2** y **Nginx**.

> **Stack real (Épica J)**: Node 20 + Express + Socket.IO, **Drizzle ORM** sobre **Neon Postgres** (driver `@neondatabase/serverless`), React 19 + Vite. No hay Prisma, ni SQLite, ni Whisper/Python: la transcripción usa API (Whisper API / AssemblyAI) y los clips usan **ffmpeg** puro.

---

## Requisitos del VPS

**Sistema**: Ubuntu 22.04/24.04, Debian 11/12 (SSH + sudo)

**Recursos mínimos**:
- 2 GB RAM (4 GB recomendado por ffmpeg/IA)
- 2 vCPUs
- 20 GB SSD
- Puertos 80 y 443 abiertos

**Servicios externos requeridos**:
- **Neon Postgres** (https://neon.tech — el driver es serverless/WebSocket al proxy de Neon; **no habla con un Postgres local pelado**, ver Paso 2)
- Al menos un proveedor de IA (Gemini recomendado; también DeepSeek/xAI)

---

## Paso 1: Dependencias del Sistema

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# ffmpeg + yt-dlp (media pipeline — NO hace falta Python/Whisper)
sudo apt install -y ffmpeg curl
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp

# Nginx + PM2 + git
sudo apt install -y nginx git
sudo npm install -g pm2
```

Verificar:

```bash
node --version    # v20.x
ffmpeg -version
yt-dlp --version
```

---

## Paso 2: Base de Datos — Neon (REQUERIDA)

El driver `src/server/db/index.ts` usa `@neondatabase/serverless`: se conecta por **WebSocket al proxy de Neon**, no por TCP a un Postgres local. Un Postgres local del VPS **no funciona** salvo que corras el proxy de Neon (`neon-proxy`) — camino no documentado acá.

1. Crear proyecto en https://console.neon.tech → copiar el connection string **pooled**:
   ```
   postgresql://USER:PASSWORD@ep-xxx-xxx.sa-east-1.aws.neon.tech/DBNAME?sslmode=require
   ```
2. Eso va en `DATABASE_URL` del `.env`.

Las **migraciones Drizzle corren solas al boot** (`runMigrations` en `src/server/db/migrate.ts` aplica `./drizzle/*.sql` con journal idempotente). No hay paso manual de migración en el deploy. Si necesitás aplicarlas a mano: `npm run db:migrate`.

---

## Paso 3: Clonar y Configurar

```bash
cd /home/tu-usuario
git clone https://github.com/adriangmrraa/Notas-Radio-Uno.git periodistapp
cd periodistapp
cp .env.example .env
nano .env
```

Mínimo obligatorio en `.env`:

- `DATABASE_URL` — el DSN de Neon del Paso 2
- `JWT_SECRET` y `ENCRYPTION_KEY` — `openssl rand -hex 32` cada uno (**JWT_SECRET es obligatorio en producción: sin él el server no arranca**)
- `FRONTEND_URL=https://tudominio.com`
- `NODE_ENV=production`, `PORT=3001`
- Al menos una API key de IA (`GEMINI_API_KEY` recomendado)

Opcionales según features: Zernio (social), Stripe/MercadoPago, SMTP, Meta, Twitter, Google, AssemblyAI, `INGEST_PROXY_URLS`, retención/backup (secciones 18-22 del `.env.example`).

---

## Paso 4: Instalar y Construir

```bash
npm ci          # el postinstall instala remotion/ solo si el dir existe
npm run build   # build:client + build:server + drizzle-kit generate
```

> No hay `prisma generate` ni `migrate deploy`: el ORM es Drizzle y las migraciones se aplican en el boot del proceso.

---

## Paso 5: PM2 — UNA sola instancia (fork)

El repo ya trae `ecosystem.config.js` correcto. **Nunca** `instances: 'max'` ni `exec_mode: 'cluster'`: el proceso guarda en memoria las sesiones Socket.IO, los schedulers (transmissions, jobQueue, retención, backup) y el estado de capturas — con N instancias cada tick corre N veces y los clientes WS conectan a un proceso que no emite.

```bash
mkdir -p logs output uploads data
pm2 start ecosystem.config.js --env production
pm2 startup   # seguir las instrucciones que imprime
pm2 save
pm2 status
pm2 logs periodistapp-api
```

Para separar cómputo de API a futuro existe `PROCESS_ROLE=api|worker|all` (default `all`) — ver sección 22 del `.env.example` para su limitación actual (eventos socket de workers no llegan a clientes sin adapter).

---

## Paso 6: Nginx como Proxy Inverso (mismo host)

El repo trae `nginx.conf` para este escenario (nginx + PM2 en el mismo host → upstream `127.0.0.1:3001`).

```bash
sudo cp nginx.conf /etc/nginx/sites-available/periodistapp
sudo nano /etc/nginx/sites-available/periodistapp
# ajustar: server_name (tu dominio) y root → /home/tu-usuario/periodistapp/dist/client
sudo ln -s /etc/nginx/sites-available/periodistapp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

La config ya incluye: SPA fallback, cache de assets, `/api/` y `/socket.io/` con upgrade headers y timeouts.

> En deploy de **dos contenedores** (EasyPanel/Compose) NO se usa este archivo: el frontend usa `nginx/default.conf.template` con upstream parametrizable `API_UPSTREAM` (ver `docs/DEPLOYMENT_EASYPANEL.md`).

---

## Paso 7: SSL con Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tudominio.com -d www.tudominio.com
sudo certbot renew --dry-run
```

---

## Paso 8: Verificación

```bash
# Health check real (DB + migraciones + disco)
curl http://localhost:3001/api/health
curl https://tudominio.com/api/health

pm2 status
sudo systemctl status nginx
```

Frontend: abrir `https://tudominio.com`.

---

## Troubleshooting

### `JWT_SECRET es obligatorio cuando NODE_ENV=production`
Falta la env. Generarla (`openssl rand -hex 32`), ponerla en `.env`, `pm2 restart`.

### Error de conexión DB
`DATABASE_URL` debe ser el DSN de Neon con `?sslmode=require`. No usar `localhost` — el driver no habla TCP directo.

### Socket.IO no conecta
Nginx debe proxear `/socket.io/` con headers Upgrade (ya incluido en `nginx.conf`). Y verificar **una sola** instancia PM2 (`pm2 status` → 1 app, fork mode).

### Operaciones largas con timeout (transcripción, IA)
Subir `proxy_read_timeout` en el bloque `/api/` de nginx (default 60s; para cargas pesadas 300s).

### Remotion render
`clipService` (Remotion) es **opt-in local**: necesita `npm install` en `remotion/` + Chromium. En el VPS/PM2 los clips salen por el path ffmpeg (`clip_render_jobs` kinds cut/reframe/subtitles).

---

## Actualización

```bash
cd /home/tu-usuario/periodistapp
git pull origin master
npm ci
npm run build
pm2 restart periodistapp-api   # las migraciones Drizzle corren solas al boot
```

## Backup de la base de datos

Neon hace backups automáticos (point-in-time restore según plan). Para dump manual:

```bash
pg_dump "postgresql://USER:PASS@ep-xxx.neon.tech/DB?sslmode=require" -Fc > backup_$(date +%Y%m%d).dump
```

Además `BACKUP_SYNC_ENABLED` (sección 21 del `.env.example`) espeja los assets derivados de `output/` hacia `data/backup`.
