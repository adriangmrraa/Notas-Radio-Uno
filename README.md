# PeriodistApp

Plataforma de automatizacion de contenido para radios, medios periodisticos y creadores de contenido informativo. Transforma transmisiones en vivo, videos de YouTube y audio en notas periodisticas, flyers visuales y publicaciones en redes sociales — todo automatizado.

Un aporte a la comunidad de periodismo y a los medios.

## Que hace

- **Pipeline de audio inteligente**: Captura audio de streams en vivo (YouTube, Twitch, Kick, Facebook Live, radio) y lo segmenta por temas usando IA
- **Transcripcion automatica**: Convierte audio a texto usando Whisper (OpenAI)
- **Generacion de contenido**: Crea notas periodisticas, titulos y copys con IA (Gemini, DeepSeek, XAI)
- **Flyers/Placas automaticas**: Genera imagenes 1080x1080 con titulo, logo del medio, tipografia y template configurables
- **Publicacion automatica**: Publica en Facebook, Instagram y Twitter
- **Scraping de noticias**: Extrae contenido de URLs y genera placas automaticamente
- **Multi-tenant**: Cada organizacion configura su propia marca, programas y conductores
- **Branding configurable**: Logo propio, 6 tipografias, 5 templates de flyer, nombre del medio
- **Gestion de programas**: CRUD de programas con URLs de plataformas (YouTube, Facebook, Kick, Twitch, radio, web)
- **Conductores**: Gestion de conductores por programa con multiples fotos (preparado para flyers de citas textuales)
- **Deduplicacion**: Evita notas duplicadas por similitud semantica

## Pipeline Autonomo

1. **Captura de Audio** - yt-dlp / ffmpeg conecta al stream en vivo
2. **Transcripcion** - Whisper convierte audio a texto
3. **Analisis de Temas** - IA segmenta y detecta temas completados (confirmacion 2 fases)
4. **Extraccion de Insights** - Personas, datos clave, queries de busqueda
5. **Investigacion Web** - Gemini Grounded Search + Google CSE
6. **Generacion de Nota** - Articulo con multiples tonos y estructuras
7. **Generacion de Titulo** - Titular periodistico optimizado
8. **Creacion de Placa** - Flyer 1080x1080 con branding del tenant (logo, fuente, template)
9. **Publicacion Multi-plataforma** - Facebook, Instagram, Twitter, Drive, Webhooks
10. **Deduplicacion** - Evita notas duplicadas por similitud semantica

## Stack tecnologico

| Capa | Tecnologia |
|------|-----------|
| Frontend | React 19, React Router v7, TailwindCSS, shadcn/ui |
| Backend | Express.js, TypeScript, Socket.IO |
| Base de datos | PostgreSQL (Neon serverless) |
| ORM | Drizzle ORM |
| Imagenes | @napi-rs/canvas, Sharp |
| IA | Gemini, DeepSeek, XAI (Grok), OpenAI Whisper |
| Audio | ffmpeg, yt-dlp |
| Publicacion | Meta API, Twitter API, Google Drive, Webhooks |

## Requisitos

### Obligatorios

- **Node.js** 20+
- **PostgreSQL** — [Neon](https://neon.tech) (recomendado, gratis) o instancia local
- **ffmpeg** — procesamiento de audio
- **yt-dlp** — descarga de audio de YouTube/streams

### Claves API (minimo una de IA)

- **GEMINI_API_KEY** — Google Gemini (recomendado, se usa para transcripcion, insights, scraping)
- **OPENAI_API_KEY** — OpenAI Whisper (transcripcion alternativa)

### Opcionales

- **DEEPSEEK_API_KEY** — DeepSeek (generacion de texto alternativa)
- **XAI_API_KEY** — Grok (generacion de imagenes IA)
- **META_APP_ID / META_APP_SECRET** — publicacion en Facebook/Instagram
- **TWITTER_APP_KEY / TWITTER_APP_SECRET** — publicacion en Twitter
- **GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY** — backup de imagenes en Google Drive
- **GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX** — busqueda de imagenes de referencia
- **STRIPE_SECRET_KEY / MP_ACCESS_TOKEN** — facturacion (Stripe / MercadoPago)

## Instalacion local

### 1. Clonar e instalar dependencias

```bash
git clone <url-del-repo>
cd periodistapp
npm install
```

### 2. Instalar herramientas de audio

**Windows (PowerShell):**
```powershell
# Si tenes winget:
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg

# Si no, descargar manualmente:
# yt-dlp: https://github.com/yt-dlp/yt-dlp/releases (yt-dlp.exe)
# ffmpeg: https://www.gyan.dev/ffmpeg/builds/ (ffmpeg-release-essentials.zip)
# Poner ambos .exe en una carpeta (ej: C:\Users\TU_USUARIO\tools\)

# Agregar al PATH de la sesion actual:
$env:Path += ";C:\Users\TU_USUARIO\tools"

# Para hacerlo permanente (requiere reiniciar terminal):
[System.Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\Users\TU_USUARIO\tools", "User")
```

**macOS:**
```bash
brew install yt-dlp ffmpeg
```

**Linux:**
```bash
sudo apt install ffmpeg
pip install yt-dlp
```

Verificar instalacion:
```bash
yt-dlp --version
ffmpeg -version
```

### 3. Configurar variables de entorno

```bash
cp .env.example .env
```

Editar `.env` con tus valores. Ver seccion "Variables de entorno" abajo.

### 4. Configurar base de datos

Crear una base de datos en [Neon](https://neon.tech) (gratis) y copiar la connection string en `DATABASE_URL`.

```bash
npx drizzle-kit push
```

Esto crea todas las tablas automaticamente. Si pide confirmacion interactiva, responder que las tablas son nuevas (no renombradas).

### 5. Registrar usuario y obtener tenant ID

```bash
npm run dev
```

Abrir `http://localhost:5173/register` y crear tu cuenta.

Obtener tu `tenant_id` para el pipeline:
```bash
node -e "require('dotenv').config(); const {Pool,neonConfig}=require('@neondatabase/serverless'); const ws=require('ws'); neonConfig.webSocketConstructor=ws; const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query('SELECT id,name FROM tenants').then(r=>{console.log(r.rows);p.end()})"
```

Agregar el UUID a `.env`:
```env
SYSTEM_TENANT_ID=tu-tenant-id-aqui
```

Reiniciar el server.

### 6. Iniciar en desarrollo

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## Variables de entorno

```env
# === OBLIGATORIAS ===
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
SYSTEM_TENANT_ID=uuid-de-tu-tenant
JWT_SECRET=un-secreto-seguro-para-jwt

# === IA (minimo una) ===
GEMINI_API_KEY=tu-clave-de-gemini
OPENAI_API_KEY=tu-clave-de-openai

# === OPCIONALES ===

# Nombre por defecto del medio (configurable por tenant en Settings > Marca)
PLATFORM_NAME=Mi Radio

# Otros proveedores de IA
DEEPSEEK_API_KEY=
XAI_API_KEY=

# Meta (Facebook/Instagram)
META_APP_ID=
META_APP_SECRET=
META_CONFIG_ID=

# Twitter
TWITTER_APP_KEY=
TWITTER_APP_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# Google Drive (backup de imagenes)
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_FOLDER_ID=

# Google Custom Search (imagenes de referencia)
GOOGLE_SEARCH_API_KEY=
GOOGLE_SEARCH_CX=

# Facturacion
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
MP_ACCESS_TOKEN=

# Email (verificacion de cuenta)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_FROM=PeriodistApp <noreply@tudominio.com>

# Encriptacion de credenciales almacenadas
ENCRYPTION_KEY=

# Server
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

## Deploy en produccion

### Render

```bash
npm run build
npm start
```

Consideraciones en Render:
- **Disco efimero**: Los logos y fotos de conductores se almacenan en PostgreSQL (bytea), no en disco. No se pierden entre deploys.
- **yt-dlp**: No disponible en Render. El pipeline usa APIs proxy (Piped/Invidious) como alternativa para YouTube.
- **ffmpeg**: Disponible en Render por defecto.
- **Variables de entorno**: Configurar todas en el dashboard de Render.

### VPS propio

Misma instalacion que local. Ventaja: podes instalar yt-dlp y ffmpeg nativamente para maxima compatibilidad con YouTube y streams de radio.

## Estructura del proyecto

```
periodistapp/
├── src/
│   ├── client/                   # Frontend React
│   │   ├── components/           # UI (Sidebar, etc.)
│   │   ├── pages/                # Dashboard, Settings, Programs, etc.
│   │   └── main.tsx              # Router
│   ├── server/                   # Backend Express
│   │   ├── db/schema/            # Drizzle (tenants, programs, conductors, etc.)
│   │   ├── middleware/           # Auth JWT
│   │   ├── routes/               # API endpoints
│   │   │   ├── branding.ts       # Config de marca (logo, fuente, template)
│   │   │   ├── programs.ts       # CRUD programas + URLs
│   │   │   ├── conductors.ts     # CRUD conductores + fotos
│   │   │   ├── pipeline.ts       # Control del pipeline
│   │   │   ├── generate.ts       # Generacion manual de placas
│   │   │   └── ...
│   │   └── services/             # Logica de negocio
│   │       ├── pipelineService.ts    # Orquestador del pipeline
│   │       ├── brandingService.ts    # Carga branding con cache
│   │       ├── imageService.ts       # Generacion de flyers canvas
│   │       ├── templateService.ts    # 5 templates de flyer
│   │       ├── fontService.ts        # 6 tipografias registradas
│   │       └── ...
│   └── shared/
│       └── types.ts              # Tipos compartidos client/server
├── fonts/                        # Tipografias TTF (BebasKai, Oswald, Roboto, Montserrat, Lato, Playfair)
├── output/                       # Imagenes generadas (temporal, no persistido)
├── drizzle/                      # Migraciones SQL
└── .env                          # Variables de entorno (no incluido en git)
```

## Comandos utiles

| Comando | Descripcion |
|---------|------------|
| `npm run dev` | Inicia frontend + backend en desarrollo |
| `npm run build` | Build de produccion (client + server) |
| `npm start` | Inicia el server de produccion |
| `npx drizzle-kit push` | Aplica esquema a la base de datos |
| `npx drizzle-kit studio` | UI visual para explorar la base de datos |
| `npx drizzle-kit generate` | Genera archivos de migracion SQL |

## Licencia

Copyright (c) 2026 Fusa Labs. Todos los derechos reservados.

Este software se distribuye bajo una **licencia de uso restringido**:

**Uso permitido:**
- Uso personal gratuito en tu propia computadora
- Uso en un VPS privado para uso personal o de tu organizacion
- Uso interno dentro de una empresa u organizacion sin fines de redistribucion

**Uso NO permitido:**
- Comercializar, vender o revender este software o servicios basados en el
- Ofrecer este software como servicio (SaaS) a terceros
- Redistribuir el codigo fuente, modificado o sin modificar
- Crear productos derivados con fines comerciales

Solo Fusa Labs esta autorizada a ofrecer PeriodistApp como servicio de suscripcion (SaaS).

Para consultas sobre licencias comerciales: contacto@fusalabs.com

---

Desarrollado por [Fusa Labs](https://github.com/adriangmrraa)
