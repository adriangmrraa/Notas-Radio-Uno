<p align="center">
  <img src="public/banner.png" alt="PeriodistApp Banner" width="100%">
</p>

<h1 align="center">PeriodistApp</h1>

<p align="center">
  <strong>AI Newsroom — La sala de redaccion inteligente para medios, radios y programas en vivo</strong>
</p>

<p align="center">
  <a href="https://notas-radio-uno.onrender.com">Demo en vivo</a> ·
  <a href="#instalacion-local">Instalar en local</a> ·
  <a href="#como-funciona">Como funciona</a> ·
  <a href="#licencia">Licencia</a>
</p>

---

**PeriodistApp** transforma transmisiones en vivo, videos de YouTube y streams de radio en contenido periodistico listo para publicar — notas, flyers, clips verticales, hilos de Twitter y mas. Todo automatizado con inteligencia artificial, con revision humana antes de publicar.

Un aporte a la comunidad de periodismo y a los medios, por [Fusa Labs](https://github.com/adriangmrraa).

> **Autor**: Hector Adrian Arganaraz Gamarra · **Organizacion**: [Fusa Labs](https://github.com/adriangmrraa)

---

## Dos formas de usar PeriodistApp

| Opcion | Descripcion |
|--------|------------|
| **SaaS** | Usa la plataforma en [notas-radio-uno.onrender.com](https://notas-radio-uno.onrender.com) — solo necesitas crear tu cuenta |
| **Self-hosted** | Clona este repo y correlo en tu propia computadora o VPS — gratis, solo pagas las API keys que uses |

---

## Que hace

### Pipeline inteligente (el corazon de PeriodistApp)
- **Captura de audio** — Conecta a streams en vivo (YouTube, Twitch, Kick, Facebook Live, radio) o sube audio manualmente
- **Transcripcion con diarizacion** — Convierte audio a texto. Con AssemblyAI identifica QUIEN habla (Speaker A, B, C)
- **Segmentacion por temas** — La IA detecta cuando cambia el tema de conversacion y separa automaticamente
- **Investigacion web** — Busca informacion complementaria en la web para enriquecer cada nota
- **Generacion de contenido** — Crea articulos periodisticos con titulo, cuerpo y copy para redes
- **Flyers automaticos** — Genera imagenes 1080x1080 con el titulo, logo de tu medio, tipografia y template elegidos
- **Quote flyers** — Detecta citas textuales de los conductores y genera flyers con la foto + cita + nombre
- **Clips verticales** — Detecta momentos virales y genera videos 9:16 con Remotion (subtitulos animados, branding)
- **Multiplicacion 1→5** — De cada nota genera: hilo de Twitter, carrusel Instagram, post LinkedIn, descripcion YouTube, blurb newsletter

### Copiloto editorial (revision humana)
- **Nada se publica automaticamente** (por defecto) — todo va a una bandeja de revision
- **Editar con IA** — Deci "hacelo mas corto" o "cambia el tono" y la IA modifica la nota
- **Editar imagen** — Cambia template, tipografia o regenera el flyer desde la bandeja
- **Aprobar y publicar** — Vos decidis que se publica, cuando y donde
- **Batch** — Aprueba o rechaza multiples items de una vez

### Alertas en vivo
- **Deteccion de breaking news** — La IA monitorea la transcripcion en tiempo real
- **Keywords configurables** — Alerta cuando se menciona "renuncia", "inflacion", tu marca, etc.
- **Push notifications** — Toasts en tiempo real via Socket.IO, color-coded por severidad

### Gestion de programas y equipo
- **Programas** — CRUD de programas con URLs de todas las plataformas (YouTube, Facebook, Kick, Twitch, radio, web)
- **Conductores** — Nombre, rol, bio, multiples fotos (se usan en los quote flyers)
- **Invitados** — Programados por fecha y hora, con fotos
- **Dossier automatico** — 24h antes de un invitado, la IA genera un brief: bio, actividad reciente, controversias, preguntas sugeridas

### Branding multi-tenant
- **Logo propio** — Subi el logo de tu medio (se guarda en la base de datos, no en disco)
- **6 tipografias** — Bebas Kai, Oswald, Roboto Condensed, Montserrat, Lato, Playfair Display
- **5 templates de flyer** — Gradiente oscuro, barra solida, minimal, split, vineta
- **Nombre del medio** — Configurable por tenant

### Paginas publicas
- **Landing del programa** — URL publica `/p/{slug}` con info, equipo, contenido reciente
- **RSS feed** — Compatible con Spotify, Apple Podcasts y cualquier lector RSS
- **SEO** — Meta tags Open Graph y Twitter Cards para compartir en redes

---

## Como funciona

```
Audio del stream
       |
       v
  [Captura con yt-dlp/ffmpeg]
       |
       v
  [Transcripcion]  ──────────────> AssemblyAI (diarizacion)
       |                           o Whisper (fallback)
       v
  [Segmentacion por temas]  ────> Gemini detecta cambios de tema
       |
       v
  [Insights + Citas]  ─────────> Conductores/invitados como contexto
       |                          Atribucion de citas con confianza
       v
  [Generacion de contenido]
       |
       ├──> Articulo periodistico
       ├──> Flyer 1080x1080 (con branding del tenant)
       ├──> Quote flyers (foto + cita del conductor)
       ├──> Clip vertical Remotion (9:16, subtitulos animados)
       └──> 5 variantes (Twitter, IG, LinkedIn, YouTube, Newsletter)
       |
       v
  [Bandeja de revision]  ──────> El humano aprueba, edita o rechaza
       |
       v
  [Publicacion]  ──────────────> Facebook, Instagram, Twitter, Webhooks
```

---

## Stack tecnologico

| Capa | Tecnologia |
|------|-----------|
| Frontend | React 19, React Router v7, TailwindCSS, shadcn/ui, Radix UI |
| Backend | Express.js, TypeScript, Socket.IO (tiempo real) |
| Base de datos | PostgreSQL (Neon serverless), Drizzle ORM |
| IA - Texto | Google Gemini (principal), DeepSeek (alternativo) |
| IA - Transcripcion | AssemblyAI (diarizacion), OpenAI Whisper (fallback) |
| IA - Imagenes | Gemini, XAI Grok |
| Video | Remotion + Hyperframes (clips verticales premium) |
| Imagenes | @napi-rs/canvas, Sharp |
| Audio | ffmpeg, yt-dlp |
| Publicacion | Meta API, Twitter API, Google Drive, Webhooks |
| Facturacion | Stripe, MercadoPago |

---

## Instalacion local

### Requisitos previos

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **ffmpeg** — procesamiento de audio
- **yt-dlp** — descarga de audio de YouTube y streams

### Paso 1: Clonar e instalar

```bash
git clone https://github.com/adriangmrraa/Notas-Radio-Uno.git
cd Notas-Radio-Uno
npm install
```

> `npm install` tambien instala las dependencias de Remotion automaticamente (subdirectorio `remotion/`).

### Paso 2: Instalar ffmpeg y yt-dlp

**Windows (PowerShell):**
```powershell
# Opcion A: Si tenes winget
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg

# Opcion B: Descarga manual
# yt-dlp: https://github.com/yt-dlp/yt-dlp/releases → descargar yt-dlp.exe
# ffmpeg: https://www.gyan.dev/ffmpeg/builds/ → ffmpeg-release-essentials.zip
# Poner ambos .exe en una carpeta, ej: C:\Users\TU_USUARIO\tools\

# Agregar al PATH (en la terminal actual):
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

**Verificar:**
```bash
yt-dlp --version    # Deberia mostrar la version
ffmpeg -version      # Deberia mostrar la version
```

### Paso 3: Configurar variables de entorno

```bash
cp .env.example .env
```

Editar `.env` con tus API keys. Las **obligatorias** son:

```env
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
JWT_SECRET=un-secreto-seguro
GEMINI_API_KEY=tu-clave-de-gemini
```

Ver la seccion [Variables de entorno](#variables-de-entorno) para la lista completa.

### Paso 4: Crear la base de datos

Crear una base de datos gratuita en [Neon](https://neon.tech), copiar la connection string en `DATABASE_URL`, y ejecutar:

```bash
npx drizzle-kit push
```

> Si pide confirmacion interactiva, responder que las tablas son **nuevas** (no renombradas).

### Paso 5: Crear tu cuenta y obtener el tenant ID

```bash
npm run dev
```

Abrir `http://localhost:5173/register` y crear tu cuenta. Despues, obtener tu tenant ID:

```bash
node -e "require('dotenv').config(); const {Pool,neonConfig}=require('@neondatabase/serverless'); const ws=require('ws'); neonConfig.webSocketConstructor=ws; const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query('SELECT id,name FROM tenants').then(r=>{console.log(r.rows);p.end()})"
```

Agregar el UUID al `.env`:

```env
SYSTEM_TENANT_ID=tu-tenant-id-aqui
```

### Paso 6: Iniciar

```bash
npm run dev
```

- Frontend: **http://localhost:5173**
- Backend: **http://localhost:3001**

---

## Deploy en Render (produccion)

La instancia de produccion esta en: **https://notas-radio-uno.onrender.com**

### Limitaciones en Render

| Funcionalidad | Local | Render |
|--------------|-------|--------|
| YouTube (yt-dlp) | ✅ Funciona perfecto | ❌ YouTube bloquea IPs de datacenters |
| Streams de radio | ✅ | ✅ |
| Transcripcion | ✅ AssemblyAI + Whisper | ✅ |
| Generacion de contenido | ✅ | ✅ |
| Clips Remotion | ✅ | ⚠️ Requiere Chromium (build mas pesado) |
| Almacenamiento | ✅ | ✅ Todo en PostgreSQL (bytea) |

> **Recomendacion**: Para trabajar con YouTube, usa PeriodistApp en **local** o en un **VPS propio** donde yt-dlp funciona sin restricciones.

### Comandos de produccion

```bash
npm run build
npm start
```

---

## Variables de entorno

```env
# ═══════════════════════════════════════════════
# OBLIGATORIAS
# ═══════════════════════════════════════════════
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
SYSTEM_TENANT_ID=uuid-de-tu-tenant
JWT_SECRET=un-secreto-seguro-para-jwt

# ═══════════════════════════════════════════════
# IA (minimo GEMINI requerido)
# ═══════════════════════════════════════════════
GEMINI_API_KEY=                # Google Gemini — IA principal
OPENAI_API_KEY=                # OpenAI Whisper — transcripcion alternativa
ASSEMBLYAI_API_KEY=            # AssemblyAI — diarizacion de speakers (recomendado)
DEEPSEEK_API_KEY=              # DeepSeek — generacion de texto alternativa
XAI_API_KEY=                   # Grok — generacion de imagenes IA

# ═══════════════════════════════════════════════
# PUBLICACION (opcionales — configura los que uses)
# ═══════════════════════════════════════════════

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

# Google Custom Search (imagenes de referencia para flyers)
GOOGLE_SEARCH_API_KEY=
GOOGLE_SEARCH_CX=

# ═══════════════════════════════════════════════
# FACTURACION (solo para modo SaaS)
# ═══════════════════════════════════════════════
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
MP_ACCESS_TOKEN=

# ═══════════════════════════════════════════════
# EMAIL (verificacion de cuenta)
# ═══════════════════════════════════════════════
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_FROM=PeriodistApp <noreply@tudominio.com>

# ═══════════════════════════════════════════════
# CONFIGURACION DEL SERVIDOR
# ═══════════════════════════════════════════════
PLATFORM_NAME=Mi Radio           # Nombre por defecto (configurable por tenant en Settings > Marca)
ENCRYPTION_KEY=                  # Para encriptar credenciales almacenadas
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
```

---

## Estructura del proyecto

```
periodistapp/
├── src/
│   ├── client/                       # Frontend React
│   │   ├── components/               # UI components
│   │   │   ├── alerts/               # Alertas en vivo (toast, feed, keywords)
│   │   │   ├── pipeline/             # Visualizacion del pipeline
│   │   │   ├── ui/                   # Primitivos shadcn/ui (Button, Dialog, etc.)
│   │   │   └── Sidebar.tsx           # Navegacion principal
│   │   ├── pages/                    # Paginas de la app
│   │   │   ├── Dashboard.tsx         # Panel principal + alertas en vivo
│   │   │   ├── ReviewPage.tsx        # Bandeja de revision (copiloto editorial)
│   │   │   ├── ProgramsPage.tsx      # Programas, conductores, invitados, dossiers
│   │   │   ├── ClipsPage.tsx         # Clips verticales generados
│   │   │   ├── SettingsPage.tsx      # Configuracion (marca, webhooks, alertas, API keys)
│   │   │   └── ...
│   │   ├── hooks/                    # useApi, useSocket, usePipelineState, useLiveAlerts
│   │   └── main.tsx                  # Router
│   │
│   ├── server/                       # Backend Express
│   │   ├── db/schema/                # Esquemas Drizzle ORM
│   │   │   ├── tenants.ts            # Tenants + branding (logo bytea, font, template)
│   │   │   ├── programs.ts           # Programas + URLs de plataformas
│   │   │   ├── conductors.ts         # Conductores + fotos (bytea)
│   │   │   ├── guests.ts             # Invitados + fotos (bytea)
│   │   │   ├── dossiers.ts           # Dossiers de invitados (IA)
│   │   │   ├── clips.ts              # Clips verticales
│   │   │   ├── publications.ts       # Publicaciones + status + quotes + variants
│   │   │   └── ...
│   │   ├── routes/                   # Endpoints API
│   │   │   ├── pipeline.ts           # Control del pipeline
│   │   │   ├── review.ts             # Revision editorial + AI edit
│   │   │   ├── branding.ts           # Config de marca (logo, fuente, template)
│   │   │   ├── programs.ts           # CRUD programas
│   │   │   ├── conductors.ts         # CRUD conductores + fotos
│   │   │   ├── guests.ts             # CRUD invitados + fotos + dossiers
│   │   │   ├── clips.ts              # CRUD clips
│   │   │   ├── alerts.ts             # Keywords de alerta
│   │   │   ├── public.ts             # API publica (sin auth)
│   │   │   ├── publicPages.ts        # Paginas HTML publicas (/p/:slug)
│   │   │   └── ...
│   │   └── services/                 # Logica de negocio
│   │       ├── pipelineService.ts    # Orquestador del pipeline completo
│   │       ├── transcriptionService.ts # AssemblyAI + Whisper
│   │       ├── insightService.ts     # Extraccion de insights + quotes con IA
│   │       ├── imageService.ts       # Generacion de flyers + quote flyers
│   │       ├── templateService.ts    # 5 templates de flyer
│   │       ├── clipService.ts        # Generacion de clips (Remotion)
│   │       ├── alertService.ts       # Deteccion de alertas (keyword + IA)
│   │       ├── dossierService.ts     # Dossier automatico de invitados
│   │       ├── contentMultiplierService.ts # 1→5 formatos
│   │       ├── publishService.ts     # Publicacion multi-canal
│   │       ├── brandingService.ts    # Cache de branding por tenant
│   │       └── ...
│   │
│   └── shared/
│       └── types.ts                  # Tipos compartidos client/server
│
├── remotion/                         # Remotion (clips verticales premium)
│   ├── src/
│   │   ├── components/               # AnimatedText, Background, Scene, etc.
│   │   └── compositions/            # QuoteClip, NewsClip
│   └── package.json
│
├── fonts/                            # 6 tipografias TTF bundled
├── output/                           # Imagenes/videos generados (temporal)
├── drizzle/                          # Migraciones SQL
├── public/                           # Assets estaticos
└── .env.example                      # Template de variables de entorno
```

---

## Comandos

| Comando | Que hace |
|---------|---------|
| `npm run dev` | Inicia frontend + backend en desarrollo |
| `npm run build` | Build de produccion (client + server) |
| `npm start` | Inicia server de produccion |
| `npx drizzle-kit push` | Aplica esquema a la base de datos |
| `npx drizzle-kit studio` | UI visual para explorar la base de datos |
| `npm run remotion:studio` | Abre Remotion Studio (preview de clips) |

---

## API keys: donde conseguirlas

| Servicio | URL | Costo | Para que se usa |
|----------|-----|-------|----------------|
| **Gemini** | [aistudio.google.com](https://aistudio.google.com) | Gratis (con limites) | IA principal: insights, notas, scraping, alertas, dossiers |
| **AssemblyAI** | [assemblyai.com](https://www.assemblyai.com) | $0.37/hr | Transcripcion con diarizacion (quien habla) |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) | ~$0.006/min | Whisper (transcripcion alternativa) |
| **Neon** | [neon.tech](https://neon.tech) | Gratis (512MB) | Base de datos PostgreSQL |
| **Meta** | [developers.facebook.com](https://developers.facebook.com) | Gratis | Publicacion en Facebook/Instagram |
| **Twitter** | [developer.twitter.com](https://developer.twitter.com) | Gratis (basico) | Publicacion en Twitter/X |

---

## Contribuir

PeriodistApp es un proyecto de [Fusa Labs](https://github.com/adriangmrraa). Si queres contribuir:

1. Fork del repositorio
2. Crea una branch (`git checkout -b feature/mi-feature`)
3. Commit con conventional commits (`feat:`, `fix:`, `docs:`)
4. Push y abri un Pull Request

---

## Licencia

Copyright (c) 2026 **Hector Adrian Arganaraz Gamarra** / **Fusa Labs**. Todos los derechos reservados.

Este software se distribuye bajo una **licencia de uso restringido**:

**Uso permitido:**
- Uso personal gratuito en tu propia computadora
- Uso en un VPS privado para uso personal o de tu organizacion
- Uso interno dentro de una empresa u organizacion sin fines de redistribucion
- Clonar, estudiar y modificar el codigo para uso propio

**Uso NO permitido:**
- Comercializar, vender o revender este software o servicios basados en el
- Ofrecer este software como servicio (SaaS) a terceros
- Redistribuir el codigo fuente con fines comerciales

Solo **Fusa Labs** esta autorizada a ofrecer PeriodistApp como servicio de suscripcion (SaaS).

Para consultas sobre licencias comerciales: contacto@fusalabs.com

---

<p align="center">
  Desarrollado con ❤️ por <a href="https://github.com/adriangmrraa">Hector Adrian Arganaraz Gamarra</a> · <a href="https://github.com/adriangmrraa">Fusa Labs</a>
</p>
