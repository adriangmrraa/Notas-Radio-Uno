# 🚀 Despliegue Manual en VPS con PM2 + Nginx

Guía paso a paso para desplegar PeriodistApp en tu VPS (Ubuntu/Debian) con **PM2** y **Nginx**, obteniendo una **URL pública lista para producción**.

## 📋 Pre‑requisitos del VPS

**Sistema**: Ubuntu 22.04/24.04, Debian 11/12 (con acceso SSH y sudo)

**Recursos mínimos**:
- 2 GB RAM
- 2 vCPUs
- 20 GB SSD
- Puerto 80 y 443 abiertos

---

## 🛠️ Paso 1: Instalar Dependencias del Sistema

Conéctate por SSH y ejecuta:

```bash
# Actualizar sistema
sudo apt update && sudo apt upgrade -y

# Node.js 20.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL 16
sudo apt install -y postgresql postgresql-contrib

# Redis (opcional pero recomendado)
sudo apt install -y redis-server

# Herramientas multimedia (ffmpeg, python, whisper, yt‑dlp)
sudo apt install -y ffmpeg python3 python3-pip python3-venv curl

# Whisper (transcripción de audio)
python3 -m venv /opt/whisper-venv
/opt/whisper-venv/bin/pip install openai-whisper

# yt‑dlp (descarga de videos/audio)
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp

# Nginx (proxy inverso)
sudo apt install -y nginx

# PM2 (gestor de procesos)
sudo npm install -g pm2

# Cliente Git
sudo apt install -y git
```

**Verificar instalaciones**:
```bash
node --version          # v20.x
npm --version           # 10.x
python3 --version       # 3.10+
ffmpeg -version         # instalado
yt-dlp --version        # instalado
pg_isready              # PostgreSQL corriendo
```

---

## 🗂️ Paso 2: Configurar Base de Datos PostgreSQL

```bash
# Acceder a PostgreSQL
sudo -u postgres psql

# Dentro de psql, ejecutar:
CREATE DATABASE periodistapp;
CREATE USER periodist WITH PASSWORD 'TU_CONTRASENA_SEGURA';
GRANT ALL PRIVILEGES ON DATABASE periodistapp TO periodist;
\q

# Verificar conexión
psql -h localhost -U periodist -d periodistapp -W
```

> **Guarda la contraseña**, la necesitarás para `DATABASE_URL`.

---

## 🐙 Paso 3: Clonar y Preparar el Proyecto

```bash
# Ir al directorio donde quieras instalar (ej: /home/tu-usuario)
cd /home/tu-usuario

# Clonar repositorio
git clone https://github.com/adriangmrraa/Notas-Radio-Uno.git periodistapp
cd periodistapp

# Copiar plantilla de variables
cp .env.example .env

# EDITAR .env con tus valores reales
nano .env  # o vim, o usar cat
```

**Asegúrate de que en `.env`**:
- `DATABASE_URL` apunte a tu PostgreSQL local
- `JWT_SECRET` y `ENCRYPTION_KEY` sean secretos seguros (generar con `openssl rand -hex 32`)
- `FRONTEND_URL` sea tu dominio público (ej: `https://app.tudominio.com`)
- Configurar al menos un proveedor de IA (DeepSeek, Gemini, etc.)
- Configurar otras APIs según necesites (Twitter, Google, etc.)

---

## 📦 Paso 4: Instalar Dependencias y Construir

```bash
# Instalar dependencias de Node
npm ci

# Generar cliente de Prisma
npx prisma generate

# Construir frontend (React)
npm run build:client

# Construir backend (TypeScript → JavaScript)
npm run build:server
```

> **Nota**: La construcción del frontend usa `VITE_API_BASE_URL` del `.env`. Si no está definida, se usará `http://localhost:3001`.

---

## 🗄️ Paso 5: Ejecutar Migraciones y Seed

```bash
# Aplicar migraciones de Prisma a la base de datos
npx prisma migrate deploy

# Poblar datos iniciales (opcional)
npx prisma db seed

# Verificar que las tablas se crearon
npx prisma studio  # opcional, interface web en http://localhost:5555
```

---

## ⚙️ Paso 6: Configurar PM2 para el Backend

```bash
# Crear configuración de PM2
pm2 init simple  # crea ecosystem.config.js

# Editar la configuración (o crear manualmente)
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'periodistapp-api',
    script: 'dist/server/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=4096'
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_file: 'logs/combined.log',
    time: true
  }]
};
EOF

# Crear directorio de logs
mkdir -p logs

# Iniciar aplicación con PM2
pm2 start ecosystem.config.js

# Configurar PM2 para iniciar con el sistema
pm2 startup
# Sigue las instrucciones que aparecen (copiar y pegar el comando)

# Guardar la configuración actual
pm2 save

# Ver estado
pm2 status
pm2 logs periodistapp-api  # ver logs en tiempo real
```

---

## 🌐 Paso 7: Configurar Nginx como Proxy Inverso

**Objetivo**: Una sola URL pública (`https://tudominio.com`) que sirva:
- Frontend React en `/`
- Backend API en `/api/*`

```bash
# Crear configuración de Nginx
sudo nano /etc/nginx/sites-available/periodistapp
```

**Pega esta configuración** (reemplaza `tudominio.com` por tu dominio real):

```nginx
server {
    listen 80;
    server_name tudominio.com www.tudominio.com;

    # Redirección HTTP → HTTPS (si vas a usar SSL)
    # return 301 https://$server_name$request_uri;

    # Frontend (React build)
    location / {
        root /home/tu-usuario/periodistapp/dist/client;
        try_files $uri $uri/ /index.html;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Backend API proxy
    location /api/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts ajustados para operaciones largas (transcripción, IA)
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }

    # Socket.IO WebSocket support
    location /socket.io/ {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Archivos estáticos (uploads, output)
    location /uploads/ {
        alias /home/tu-usuario/periodistapp/uploads/;
        expires 7d;
        add_header Cache-Control "public";
    }

    location /output/ {
        alias /home/tu-usuario/periodistapp/output/;
        expires 7d;
        add_header Cache-Control "public";
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript
               application/x-javascript application/xml application/json
               application/javascript;
}
```

**Activar el sitio**:
```bash
# Enlazar configuración
sudo ln -s /etc/nginx/sites-available/periodistapp /etc/nginx/sites-enabled/

# Eliminar configuración por defecto (si existe)
sudo rm /etc/nginx/sites-enabled/default

# Probar configuración
sudo nginx -t

# Recargar Nginx
sudo systemctl reload nginx
```

---

## 🔒 Paso 8: SSL con Let's Encrypt (HTTPS)

**Opcional pero altamente recomendado** para producción:

```bash
# Instalar Certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtener certificado SSL
sudo certbot --nginx -d tudominio.com -d www.tudominio.com

# El certificado se renovará automáticamente
# Verificar renovación automática
sudo certbot renew --dry-run
```

> **Nota**: Certbot modificará automáticamente tu configuración de Nginx para redirigir HTTP → HTTPS.

---

## 📁 Paso 9: Directorios y Permisos

```bash
# Crear directorios para archivos subidos/generados
mkdir -p uploads output

# Permisos (ajustar según tu usuario)
sudo chown -R tu-usuario:tu-usuario uploads output
sudo chmod 755 uploads output

# Permisos para logs
sudo chown -R tu-usuario:tu-usuario logs
```

**Variables de entorno relacionadas** en `.env`:
```
# Directorio donde están las herramientas
TOOLS_DIR=/usr/local/bin

# Directorios de archivos (relativos a la raíz del proyecto)
# Se acceden como /uploads/ y /output/ vía Nginx
```

---

## ✅ Paso 10: Verificar que Todo Funcione

```bash
# 1. Verificar que PM2 está corriendo
pm2 status

# 2. Verificar que Nginx está activo
sudo systemctl status nginx

# 3. Verificar que PostgreSQL está activo
sudo systemctl status postgresql

# 4. Probar API localmente
curl http://localhost:3001/api/health
# Debería responder: {"status":"ok","timestamp":"..."}

# 5. Probar desde afuera (reemplaza con tu dominio)
curl https://tudominio.com/api/health
```

**Probar frontend**: Abrir `https://tudominio.com` en el navegador.

---

## 🚨 Solución de Problemas Comunes

### 1. **Error de conexión a PostgreSQL**
```bash
# Verificar que PostgreSQL acepta conexiones locales
sudo nano /etc/postgresql/16/main/pg_hba.conf
# Asegurar que existe línea:
# host    all             all             127.0.0.1/32            md5

sudo systemctl restart postgresql
```

### 2. **PM2 no mantiene procesos después de reiniciar**
```bash
# Reconfigurar startup
pm2 unstartup
pm2 startup
# Seguir instrucciones
pm2 save
```

### 3. **Frontend no carga o muestra errores**
```bash
# Reconstruir frontend
npm run build:client

# Verificar que dist/client/ tenga index.html y assets
ls -la dist/client/

# Ver logs de Nginx
sudo tail -f /var/log/nginx/error.log
```

### 4. **Error "ENOENT: no such file or directory" para whisper/ffmpeg**
```bash
# Verificar instalación
which ffmpeg
which yt-dlp
ls -la /opt/whisper-venv/bin/whisper

# Agregar al PATH en .env o en el script de PM2
export PATH="/opt/whisper-venv/bin:$PATH"
```

### 5. **Timeout en operaciones largas (transcripción, IA)**
Aumentar timeouts en Nginx (ya incluidos en la configuración) y en el backend.

---

## 🔄 Mantenimiento y Actualizaciones

### **Actualizar código**:
```bash
cd /home/tu-usuario/periodistapp
git pull origin master
npm ci
npm run build:client
npm run build:server
npx prisma migrate deploy
pm2 restart periodistapp-api
```

### **Backup de base de datos**:
```bash
# Backup manual
pg_dump -h localhost -U periodist -d periodistapp > backup_$(date +%Y%m%d).sql

# Restaurar
psql -h localhost -U periodist -d periodistapp < backup.sql
```

### **Monitoreo**:
```bash
# Ver uso de recursos
pm2 monit

# Logs en tiempo real
pm2 logs periodistapp-api

# Métricas del sistema
htop
```

---

## 📞 Soporte

**Archivos clave**:
- `.env` – Variables de entorno (¡NO compartir!)
- `ecosystem.config.js` – Configuración PM2
- `/etc/nginx/sites-available/periodistapp` – Configuración Nginx
- `logs/` – Logs de la aplicación

**Comandos útiles**:
```bash
# Reiniciar todo
pm2 restart all && sudo systemctl reload nginx

# Ver estado de todos los servicios
sudo systemctl status nginx postgresql redis

# Espacio en disco
df -h

# Uso de memoria
free -h
```

---

## 🎉 ¡Listo!

Tu PeriodistApp ahora está disponible públicamente en `https://tudominio.com`.

**Credenciales por defecto** (si usaste el seed):
- Email: `admin@periodistapp.com`
- Contraseña: `admin123` (¡cambiar inmediatamente!)

**Acciones recomendadas**:
1. Cambiar contraseña de administrador
2. Configurar APIs reales (Twitter, Google, etc.)
3. Probar pipeline completo (captura → transcripción → artículo → publicación)
4. Configurar backup automático de la base de datos

**Para desarrollo remoto**: Puedes usar **Open Code via SSH** para editar archivos directamente en el VPS desde tu editor favorito.