# PeriodistApp

Plataforma SaaS de generacion automatizada de contenido periodistico a partir de transmisiones en vivo. Captura audio de streams (YouTube, Twitch, Kick, Facebook Live), transcribe, detecta temas, investiga en la web, genera articulos y los publica automaticamente en multiples plataformas.

## Stack

- **Backend**: Node.js + TypeScript + Express + Socket.IO + Prisma ORM + PostgreSQL
- **Frontend**: React 19 + Vite + React Router v7 + XYFlow (pipeline editor)
- **IA**: DeepSeek (LLM principal), Google Gemini (fallback + Grounded Search), Grok (imagenes)
- **Media**: yt-dlp (captura), Whisper (transcripcion), Sharp + @napi-rs/canvas (graficos)
- **Publicacion**: Twitter API, Meta API (Facebook/Instagram), Google Drive, Webhooks

## Pipeline Autonomo (10 pasos)

1. **Captura de Audio** - yt-dlp conecta al stream en vivo
2. **Transcripcion** - Whisper convierte audio a texto
3. **Analisis de Temas** - IA segmenta y detecta temas completados (confirmacion 2 fases)
4. **Extraccion de Insights** - Personas, datos clave, queries de busqueda
5. **Investigacion Web** - Gemini Grounded Search + Google CSE
6. **Generacion de Nota** - Articulo con 4 tonos x 4 estructuras
7. **Generacion de Titulo** - Titular periodistico optimizado
8. **Creacion de Placa** - Flyer 1080x1080 con overlay
9. **Publicacion Multi-plataforma** - Twitter, Facebook, Instagram, Drive, Webhooks
10. **Deduplicacion** - Evita notas duplicadas por similitud semantica

## Setup

```bash
# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus API keys

# Inicializar base de datos
npx prisma migrate dev
npx prisma db seed

# Desarrollo
npm run dev

# Produccion
npm run build:client
npm start
```

## Variables de Entorno

```env
# Base de datos
DATABASE_URL=postgresql://user:pass@localhost:5432/periodistapp

# Auth
JWT_SECRET=tu-secret-seguro
FRONTEND_URL=http://localhost:5173

# IA (al menos 1 requerido)
DEEPSEEK_API_KEY=
GEMINI_API_KEY=
XAI_API_KEY=

# Seguridad
ENCRYPTION_KEY=

# Twitter
TWITTER_APP_KEY=
TWITTER_APP_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# Meta (Facebook/Instagram)
META_APP_ID=
META_APP_SECRET=
META_CONFIG_ID=

# Google (Drive + Search)
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_FOLDER_ID=
GOOGLE_SEARCH_API_KEY=
GOOGLE_SEARCH_CX=

# Email (SMTP)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@periodistapp.com
```

## Estructura del Proyecto

```
src/
  server/
    index.ts              # Entry point Express + Socket.IO
    lib/
      prisma.ts           # Prisma Client singleton
    middleware/
      auth.ts             # JWT auth + role guard
    routes/
      auth.ts             # Registro, login, verificacion
      pipeline.ts         # Control del pipeline
      agents.ts           # CRUD agentes custom
      meta.ts             # OAuth Meta
      history.ts          # Publicaciones y transcripciones
      settings.ts         # Configuracion
      generate.ts         # Generacion manual
    services/
      authService.ts      # Registro, login, JWT, password reset
      emailService.ts     # Envio de emails SMTP
      pipelineService.ts  # AutoPipeline (orquestador)
      aiService.ts        # LLM wrapper (DeepSeek/Gemini)
      newsService.ts      # Generacion de articulos
      searchService.ts    # Investigacion web
      imageService.ts     # Procesamiento de imagenes
      ...
  client/
    App.tsx               # React SPA principal
    editor/               # Pipeline Visual Editor (XYFlow)
    hooks/                # useSocket, usePipelineState
  shared/
    types.ts              # Tipos compartidos
prisma/
  schema.prisma           # Schema de base de datos
  seed.ts                 # Datos iniciales (planes)
```

## Licencia

Ver [LICENSE](LICENSE).

**Uso personal**: Libre para uso personal y educativo.
**Uso comercial**: Requiere licencia comercial otorgada por **FusaLabs**. Contacto: contacto@fusalabs.com

---

Desarrollado por [FusaLabs](https://github.com/adriangmrraa)
