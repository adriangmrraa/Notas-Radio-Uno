# PeriodistApp - Documentacion de Arquitectura

> Plataforma agnóstica de automatización periodística con IA
>
> Version: 1.0 | Ultima actualizacion: Marzo 2026

---

## Tabla de Contenidos

1. [Vision General de la Plataforma](#1-vision-general-de-la-plataforma)
2. [Arquitectura Tecnica](#2-arquitectura-tecnica)
3. [El Pipeline Autonomo](#3-el-pipeline-autonomo)
4. [Base de Datos](#4-base-de-datos)
5. [Eventos Socket.IO](#5-eventos-socketio)
6. [API REST - Endpoints Completos](#6-api-rest---endpoints-completos)
7. [Frontend - Que se ve en cada seccion](#7-frontend---que-se-ve-en-cada-seccion)
8. [Conexion Meta - Flujo Completo](#8-conexion-meta---flujo-completo-del-popup-con-fb-sdk)
9. [Variables de Entorno](#9-variables-de-entorno---guia-completa)
10. [Rate Limiting](#10-rate-limiting)
11. [Deteccion de Duplicados](#11-deteccion-de-duplicados)
12. [Como Ejecutar el Proyecto](#12-como-ejecutar-el-proyecto)
13. [Encriptacion](#13-encriptacion)
14. [Changelog - Fixes y mejoras aplicados](#14-changelog---fixes-y-mejoras-aplicados)

---

## 1. Vision General de la Plataforma

PeriodistApp automatiza el ciclo completo de produccion periodistica para cualquier emisora o medio. Desde la captura de audio en vivo de una transmision radial hasta la publicacion de notas con placas visuales en multiples plataformas, todo el proceso es autonomo y esta potenciado por inteligencia artificial. La plataforma es agnóstica: el nombre del medio se configura mediante la variable de entorno `PLATFORM_NAME` (default: "Radio Uno Formosa") y se usa en los system prompts de IA y en las placas generadas.

### El ciclo completo

```
 AUDIO EN VIVO          TRANSCRIPCION         ANALISIS IA
 (YouTube/Radio)  --->  (Whisper/Python)  --->  (DeepSeek/Gemini)
       |                      |                      |
       v                      v                      v
  Captura continua     Texto en tiempo      Segmentacion por temas
  sin cortes           real                 con confirmacion 2 fases
                                                     |
                                                     v
 PUBLICACION           PLACA VISUAL          NOTA PERIODISTICA
 (Multi-plataforma) <--- (1080x1080)  <---  (4 tonos x 4 estructuras)
       |                      ^                      ^
       v                      |                      |
  Twitter, Facebook,    Imagen de articulo    Investigacion web
  Instagram, Webhooks,  o generada por IA     automatica (Gemini
  Google Drive          o placeholder         Grounded Search)
```

### Los 10 pasos del pipeline

| # | Paso | Descripcion |
|---|------|-------------|
| 1 | **Captura de audio** | Se conecta a un stream de YouTube o radio en vivo usando `yt-dlp` + `ffmpeg`. Graba chunks de audio de duracion configurable (default 120s). |
| 2 | **Transcripcion** | Cada chunk se transcribe con OpenAI Whisper (modelo local via Python). La transcripcion se ejecuta en paralelo con la captura del siguiente chunk. |
| 3 | **Analisis de temas** | Cada 3 chunks, la IA (DeepSeek o Gemini) analiza la transcripcion acumulada y detecta segmentos tematicos. Identifica que temas estan "en curso" y cuales "completados". |
| 4 | **Confirmacion en 2 fases** | Para evitar falsos positivos (ej: un conductor que hace una tangente y vuelve al tema), se usa un sistema de confirmacion. Un tema debe ser detectado como "completado" en dos analisis consecutivos para confirmarse. |
| 5 | **Extraccion de insights** | De cada tema confirmado, la IA extrae personas mencionadas, datos clave, cifras, y genera queries de busqueda para investigacion web. |
| 6 | **Investigacion web** | Usando Gemini Grounded Search (primario), Google Custom Search o DuckDuckGo (fallbacks), se buscan articulos relacionados para enriquecer la nota con contexto y fuentes. |
| 7 | **Generacion de nota** | Se genera una nota periodistica completa usando IA. El usuario puede elegir entre 4 tonos (formal, informal, urgente, editorial) y 4 estructuras (completa, breve, bullet points, tweet). |
| 8 | **Creacion de placa/flyer** | Se genera una imagen de 1080x1080 pixeles con un overlay de texto (titulo) sobre una imagen de fondo. El fondo puede venir de un articulo scrapeado, generado por IA (Nano Banana 2 o Grok), o un placeholder con gradiente. |
| 9 | **Publicacion multi-plataforma** | La nota se publica en todas las plataformas configuradas: Google Drive (sube imagen), Webhooks (Make/N8N), Twitter (API directa), Facebook Pages e Instagram (Meta API). |
| 10 | **Deduplicacion y rate limiting** | Antes de publicar, se verifica que el tema no sea duplicado (comparando con publicaciones de las ultimas 24 horas y la sesion actual). Todas las APIs externas tienen rate limiting con token bucket. |

---

## 2. Arquitectura Tecnica

### Stack tecnologico

| Capa | Tecnologia | Version / Detalle |
|------|-----------|-------------------|
| **Runtime** | Node.js + TypeScript | ESM modules (`"type": "module"`) |
| **Backend** | Express.js | Puerto 3001. Sirve API REST + archivos estaticos en produccion. |
| **Frontend** | React 19 + Vite + TypeScript | Puerto 5173 en desarrollo. Vite hace proxy automatico de `/api/*` y `/socket.io` al backend. |
| **Base de datos** | SQLite (better-sqlite3) | WAL mode habilitado. Archivo: `data/credentials.db` |
| **Comunicacion real-time** | Socket.IO | Bidireccional. El backend emite eventos de progreso del pipeline. |
| **IA - Texto** | DeepSeek (primario) + Gemini 2.5 Flash (fallback) | Analisis de temas, generacion de notas, extraccion de insights. |
| **IA - Imagenes** | Nano Banana 2 (gemini-3.1-flash-image-preview) + xAI Grok | Generacion de fondos para placas cuando no hay imagen de articulo. Soporta image+prompt: envía fotos de referencia (personas, logos, eventos) junto con el prompt para generar imágenes contextualizadas. |
| **IA - Busqueda** | Gemini Grounded Search | Investigacion web con fuentes verificables. |
| **Audio** | ffmpeg + yt-dlp + Whisper | Captura de streams, conversion a formato compatible, transcripcion speech-to-text. |
| **Imagenes** | @napi-rs/canvas (overlay de texto, logo) + Sharp (resize) | Procesamiento de imagenes: resize, overlay de texto, composicion de placas. |
| **Canvas** | @napi-rs/canvas | Generacion de placas: overlay de texto, gradiente, logo. Drop-in replacement de node-canvas sin compilacion nativa. |

### Estructura de carpetas

```
periodistapp/
├── src/
│   ├── server/
│   │   ├── index.ts                    # Entry point: Express + Socket.IO + middlewares
│   │   ├── routes/                     # 6 modulos de rutas REST
│   │   │   ├── pipeline.ts             # /api/pipeline/* (start, stop, status, options)
│   │   │   ├── meta.ts                 # /api/meta/* (config, status, connect, disconnect, publish)
│   │   │   ├── generate.ts             # /api/generate, /api/generate-from-url, /api/sendWebhook*
│   │   │   ├── capture.ts              # /api/start-capture, /api/stop-capture
│   │   │   ├── history.ts              # /api/history/* (publications, transcriptions CRUD)
│   │   │   └── settings.ts             # /api/settings/* (webhooks GET/POST)
│   │   ├── services/                   # 16 servicios de logica de negocio
│   │   │   ├── pipelineService.ts      # Clase AutoPipeline - pipeline autonomo (~1100 lineas)
│   │   │   ├── databaseService.ts      # SQLite CRUD + inicializacion + encriptacion
│   │   │   ├── aiService.ts            # Wrapper para DeepSeek + Gemini (chatCompletion, extractJSON)
│   │   │   ├── newsService.ts          # Generacion de notas periodisticas (tonos + estructuras)
│   │   │   ├── topicService.ts         # Segmentacion de temas con sistema de 2 fases
│   │   │   ├── insightService.ts       # Extraccion de insights (personas, datos, queries)
│   │   │   ├── searchService.ts        # Investigacion web (Gemini Grounded, Google CSE, DDG)
│   │   │   ├── imageService.ts         # Procesamiento de placas (Sharp: resize, overlay, composicion)
│   │   │   ├── transcriptionService.ts # Captura audio (yt-dlp + ffmpeg) + Whisper
│   │   │   ├── metaAuthService.ts      # OAuth Meta: exchange tokens, discover assets
│   │   │   ├── metaPublishService.ts   # Publicacion en Facebook Pages + Instagram
│   │   │   ├── twitterService.ts       # Publicacion en Twitter (OAuth 1.0a)
│   │   │   ├── scraperService.ts       # Scraping de articulos web (extraccion titulo/imagen/contenido)
│   │   │   ├── rateLimiter.ts          # Token bucket rate limiting para todas las APIs
│   │   │   ├── deduplicationService.ts # Deteccion de duplicados (sesion + DB)
│   │   │   └── encryptionService.ts    # AES-256-GCM para credenciales
│   │   └── data/                       # Directorio auto-creado para la base de datos SQLite
│   ├── client/
│   │   ├── main.tsx                    # Entry point React
│   │   ├── App.tsx                     # Componente principal (SPA, todo inline)
│   │   ├── App.css                     # Estilos dark theme (#0b0d17)
│   │   ├── hooks/
│   │   │   └── useSocket.ts            # Hook custom para Socket.IO
│   │   └── types/
│   │       └── index.ts                # Tipos de UI
│   └── shared/
│       └── types.ts                    # Tipos compartidos entre server y client
├── public/
│   └── logo.png                        # Logo de la plataforma configurada (PLATFORM_NAME)
├── output/                             # Imagenes generadas (auto-creado)
├── uploads/                            # Archivos subidos temporalmente (multer)
├── fonts/                              # BebasKai.ttf (tipografia opcional para placas)
├── scripts/
│   └── audio_capture.py                # Script Python para captura manual de audio
├── .env                                # Variables de entorno (no versionado)
├── package.json                        # Dependencias y scripts npm
├── tsconfig.json                       # Configuracion TypeScript
└── vite.config.ts                      # Configuracion Vite (proxy, build)
```

### Diagrama de dependencias entre servicios

```
pipelineService.ts (orquestador principal)
  ├── transcriptionService.ts    (captura + transcripcion)
  ├── topicService.ts            (segmentacion de temas)
  │     └── aiService.ts         (chatCompletion)
  ├── deduplicationService.ts    (verificacion de duplicados)
  │     └── databaseService.ts   (consulta publicaciones recientes)
  ├── insightService.ts          (extraccion de datos)
  │     └── aiService.ts
  ├── searchService.ts           (investigacion web)
  │     ├── aiService.ts         (Gemini Grounded Search)
  │     └── rateLimiter.ts
  ├── newsService.ts             (generacion de nota)
  │     └── aiService.ts
  ├── imageService.ts            (creacion de placa)
  ├── scraperService.ts          (scraping de articulos)
  ├── twitterService.ts          (publicacion Twitter)
  ├── metaPublishService.ts      (publicacion FB/IG)
  ├── databaseService.ts         (persistencia)
  │     └── encryptionService.ts (encriptacion de tokens)
  └── rateLimiter.ts             (rate limiting global)
```

---

## 3. El Pipeline Autonomo

### Clase `AutoPipeline` (`pipelineService.ts`)

La clase `AutoPipeline` es el corazon de PeriodistApp. Con aproximadamente 1100 lineas de codigo, orquesta todo el ciclo de produccion periodistica de forma autonoma.

### Estado interno

```typescript
class AutoPipeline {
  private io: Server;                          // Socket.IO para eventos real-time
  public running: boolean;                     // Si el pipeline esta activo
  public config: PipelineConfig;               // Configuracion actual
  private fullTranscription: string;           // Transcripcion completa acumulada
  private chunks: TranscriptionChunk[];        // Chunks individuales con timestamps
  private publishedTopics: string[];           // Temas ya publicados (anti-duplicados en sesion)
  public publishedNotes: PublishedNote[];      // Notas publicadas con sus datos
  private pendingConfirmation: string[];       // Temas esperando confirmacion (fase 2)
  private chunksPerAnalysis: number;           // Cada cuantos chunks analizar (default: 3)
  private chunksSinceLastAnalysis: number;     // Contador de chunks desde ultimo analisis
  private currentStep: string;                 // Paso actual del pipeline
  private captureTimeout: ReturnType<typeof setTimeout> | null;
  private publishingInProgress: boolean;       // Flag para no bloquear captura
}
```

### Configuracion (`PipelineConfig`)

```typescript
interface PipelineConfig {
  url: string;              // URL del stream de audio (YouTube, radio)
  tone: string;             // Tono de la nota: "formal" | "informal" | "urgente" | "editorial"
  structure: string;        // Estructura: "completa" | "breve" | "bullet" | "tweet"
  imageModel: string;       // Modelo de imagen: "gemini" | "grok"
  segmentDuration: number;  // Duracion de cada chunk en segundos (default: 120)
  autoPublish: boolean;     // Si publica automaticamente o espera confirmacion
}
```

### Flujo principal detallado

```
start(config)
  |
  v
continuousCaptureLoop()
  |
  |  [LOOP mientras running === true]
  |
  +--> captureAudioSegment(url, segmentDuration)
  |      |
  |      +--> yt-dlp descarga el stream en tiempo real
  |      +--> ffmpeg convierte a formato compatible con Whisper
  |      +--> Retorna { filePath } con la ruta del archivo .mp3
  |
  +--> [En paralelo] Resuelve transcripcion pendiente del chunk anterior
  |      |
  |      +--> Si hay resultado: onChunkTranscribed()
  |
  +--> transcribeAudio(filePath)  [NO AWAIT - se resuelve en el proximo ciclo]
  |      |
  |      +--> Whisper (Python) procesa el audio
  |      +--> Retorna texto transcrito
  |      +--> Elimina archivo temporal .mp3
  |
  +--> [Siguiente iteracion del loop]

onChunkTranscribed(result, chunkNumber)
  |
  +--> Acumula texto en fullTranscription
  +--> Guarda chunk en array chunks[]
  +--> Persiste en DB (createTranscription)
  +--> Emite evento "transcription" via Socket.IO
  +--> Incrementa chunksSinceLastAnalysis
  |
  +--> Si chunksSinceLastAnalysis >= 3 Y no hay publishing en progreso:
         |
         +--> analyzeAndPublish(latestChunk)  [BACKGROUND - no bloquea captura]

analyzeAndPublish(latestChunk)
  |
  +--> publishingInProgress = true
  |
  +--> analyzeTopicSegments(fullTranscription, latestChunk, publishedTopics, pendingConfirmation)
  |      |
  |      +--> IA analiza los ultimos 8000 caracteres de transcripcion
  |      +--> Retorna lista de segmentos con: topic, summary, status, newsworthy, confidence
  |
  +--> Sistema de confirmacion en 2 fases (ver seccion siguiente)
  |
  +--> Para cada tema CONFIRMADO y NEWSWORTHY:
         |
         +--> processTopicSegment(segment)
                |
                +--> isDuplicateTopic() -- chequeo contra DB (24h)
                +--> isTopicInSession() -- chequeo contra sesion actual
                |
                +--> Si es duplicado: emite "detail" y salta al siguiente
                |
                +--> extractInsights(segment)
                |      +--> Personas mencionadas, datos clave, queries de busqueda
                |
                +--> searchAndEnrich(queries)
                |      +--> Gemini Grounded Search (primario)
                |      +--> Google Custom Search (fallback)
                |      +--> DuckDuckGo (fallback final)
                |      +--> Retorna articulos relevantes con titulo, snippet, URL
                |
                +--> generateNewsCopy(context, transcription)
                |      +--> Genera nota periodistica con tono y estructura configurados
                |
                +--> generateTitle(content)
                |      +--> Genera titulo optimizado para la nota
                |
                +--> generateFlyer(title, imageSource)
                |      +--> Estrategia 1: Imagen de articulo scrapeado
                |      +--> Estrategia 2: IA genera imagen (Nano Banana 2 o Grok)
                |      +--> Estrategia 3: Placeholder con gradiente
                |      +--> processImage(): overlay de texto sobre fondo 1080x1080
                |
                +--> publish(note)
                       +--> Google Drive (sube imagen, obtiene URL publica)
                       +--> Webhook (Make.com / N8N)
                       +--> Twitter (descarga imagen, sube, publica tweet)
                       +--> Meta API (Facebook Pages + Instagram)
                       +--> Persiste en DB (createPublication)
                       +--> Emite eventos Socket.IO
```

### Captura continua sin cortes

La arquitectura de captura esta disenada para no perder ni un segundo de audio. Mientras se transcribe un chunk, el siguiente ya se esta grabando:

```
Tiempo -->

Chunk 1: [========GRAB========][=====TRANSCRIBE=====]
Chunk 2:                       [========GRAB========][=====TRANSCRIBE=====]
Chunk 3:                                             [========GRAB========][=====TRANSCRIBE=====]
Chunk 4:                                                                  [========GRAB========]...
```

**Implementacion tecnica:**

1. El loop principal (`continuousCaptureLoop`) captura audio con `await captureAudioSegment()`
2. Lanza la transcripcion sin `await` (queda como `pendingTranscription`)
3. En la siguiente iteracion, resuelve la transcripcion pendiente mientras graba el nuevo chunk
4. Cuando el pipeline se detiene, resuelve la ultima transcripcion pendiente

```typescript
// Pseudocodigo simplificado del loop
while (this.running) {
  // Grabar chunk actual (BLOCKING)
  const { filePath } = await captureAudioSegment(url, duration);

  // Resolver transcripcion del chunk ANTERIOR (si existe)
  if (pendingTranscription) {
    const prevResult = await pendingTranscription;
    this.onChunkTranscribed(prevResult);
  }

  // Lanzar transcripcion del chunk actual (NON-BLOCKING)
  pendingTranscription = transcribeAudio(filePath);
}
```

### Captura verdaderamente paralela (fire-and-forget)

El análisis y publicación se ejecutan con fire-and-forget: `analyzeAndPublish()` se lanza sin `await`, de modo que la captura NUNCA se detiene. Si durante el análisis y publicación llegan nuevos chunks, al terminar el procesamiento se re-analiza automáticamente con los chunks acumulados.

```
Chunk 1: [====GRAB====][===TRANSCRIBE===]
Chunk 2:              [====GRAB====][===TRANSCRIBE===]
Chunk 3:                            [====GRAB====][===TRANSCRIBE===]
                                         ↑ Análisis en background (fire-and-forget)
Chunk 4:                                          [====GRAB====][===TRANSCRIBE===]
Chunk 5:                                                        [====GRAB====]...
                                                                 ↑ Re-análisis con chunks 4-5 nuevos
```

### Contexto acumulado entre análisis

Cada ronda de análisis acumula contexto de las anteriores:
- `previousAnalysisContext`: resumen de temas ya publicados
- `lastAnalyzedChunkIndex`: sabe qué chunks son nuevos vs ya procesados
- Cuando termina de publicar, verifica si hay `>= chunksPerAnalysis` nuevos y re-analiza

### Operación 24/7

El pipeline está diseñado para operar 24 horas sin intervención:

- **Exponential backoff**: si la captura falla, espera 5s, 10s, 20s... hasta 60s max. Nunca se rinde.
- **Limpieza de memoria**: la transcripción se recorta a los últimos ~50,000 caracteres (~30 min) para evitar consumo desmedido de RAM.
- **Estadísticas periódicas**: cada 10 chunks emite horas capturadas, chunks procesados, notas publicadas.
- **Limpieza de archivos temporales**: cada 20 chunks elimina archivos temp, ai_bg, resized, ref_person mayores a 1 hora.
- **Auto-reconexión**: si el stream se cae, reintenta con backoff. Tras 10+ fallos consecutivos emite warning pero sigue intentando.

### Sistema de confirmacion en 2 fases

Este sistema es crucial para evitar falsos positivos en radio en vivo, donde los conductores frecuentemente hacen tangentes breves y vuelven al tema principal.

#### Problema sin confirmacion

```
Conductor: "Hablando de la nueva obra en la ruta 11..."
Conductor: "Ah, les mando un saludo a los de Clorinda"    <-- Tangente breve
Conductor: "...como deciamos, la obra en la ruta 11..."   <-- Retomo

Sin confirmacion: se hubiera publicado "Saludos a Clorinda" como nota
```

#### Solucion con 2 fases

```
ANALISIS #1 (chunks 1-3):
  Temas detectados:
  - "Obra en ruta 11" -> status: ongoing (siguen hablando)
  - "Inflacion de alimentos" -> status: completed, newsworthy: true
  Accion:
  - "Inflacion de alimentos" se agrega a pendingConfirmation[]

ANALISIS #2 (chunks 4-6):
  La IA recibe: "Temas pendientes de confirmacion: Inflacion de alimentos"
  La IA verifica: "Efectivamente no volvieron a hablar de inflacion"
  Resultado:
  - "Inflacion de alimentos" -> CONFIRMADO -> se publica
  - Si hubieran vuelto a hablar -> se DESCARTA de pendingConfirmation
```

#### Criterios para `COMPLETED`

La IA considera un tema como completado cuando:

- El tema tuvo **desarrollo sustancial** (minimo 2-3 minutos de discusion con datos concretos)
- Los conductores **pasaron a hablar de algo completamente diferente** por varios minutos
- **No hubo indicios** de que vayan a retomarlo (no dijeron "despues volvemos a esto", etc.)
- El tema tiene **datos concretos publicables** (no fue solo opinologia o charla casual)
- Se detectaron **frases de cierre** como "bueno, pasemos a otra cosa", "y eso es lo que hay", "veremos como sigue"

**No se considera completado** cuando:

- Solo hubo una interrupcion breve (saludos, lectura de mensajes de WhatsApp, chistes)
- Estan en pausa comercial o musical
- El conductor dijo explicitamente que va a volver al tema

#### Criterios para `NEWSWORTHY`

La IA evalua si un tema es noticioso segun:

**SI es noticioso:**
- Contiene **informacion verificable**: cifras concretas, declaraciones oficiales, decisiones gubernamentales
- Tiene **relevancia publica**: afecta a ciudadanos, es de interes general para la audiencia
- Incluye **hechos concretos**: inauguraciones, anuncios, medidas, eventos
- Tiene **fuentes identificables**: funcionarios, instituciones, personas publicas

**NO es noticioso:**
- Opiniones personales sin sustento factico
- Rumores o especulaciones sin confirmar
- Charla casual entre conductores
- Anecdotas personales
- Humor, chistes, saludos a oyentes
- Lectura de mensajes del WhatsApp

#### Nivel de confianza (`confidence`)

- **high**: tema con datos concretos, fuentes claras, desarrollo extenso
- **medium**: tema con algunos datos pero puede necesitar mas contexto
- **low**: tema mencionado brevemente o sin datos verificables suficientes

### Generacion de flyer (3 estrategias con fallback)

El sistema intenta generar la mejor imagen posible para la placa, con fallbacks automaticos:

```
Estrategia 1: Imagen de articulo web
  |
  +--> searchAndEnrich() encuentra articulos relacionados
  +--> scraperService.scrapeArticle() extrae la imagen del articulo
  +--> Si la imagen existe y es valida: USAR ESTA
  |
  v (si falla)
Estrategia 2: Imagen generada por IA
  |
  +--> Si imageModel === "gemini":
  |      +--> Nano Banana 2 (gemini-3.1-flash-image-preview) genera imagen
  |      +--> Soporta image+prompt (ver seccion siguiente)
  |      +--> Emite evento flyer_bg { source: "gemini_imagen" }
  |
  +--> Si imageModel === "grok":
  |      +--> xAI Grok genera imagen (solo texto, sin referencia visual)
  |      +--> Emite evento flyer_bg { source: "grok_image" }
  |
  v (si falla)
Estrategia 3: Placeholder con gradiente
  |
  +--> Genera imagen con gradiente usando colores de la plataforma configurada (PLATFORM_NAME)
  +--> Emite evento flyer_bg { source: "placeholder" }
```

### Generación de imágenes con referencia visual (image+prompt)

El sistema busca automáticamente imágenes de referencia relevantes antes de generar el fondo:

1. **Personas mencionadas**: Si la noticia habla de un político, celebridad o figura pública, busca su foto
2. **Temas/eventos**: Busca imágenes del evento, lugar, empresa, logo, etc.
3. **Máximo 3 referencias**: Se descargan como archivos temporales

Luego envía las imágenes + un prompt contextual a **Nano Banana 2** (`gemini-3.1-flash-image-preview`):
- Si hay foto de persona → "Usá la foto adjunta para capturar el rostro y ubicalo en el contexto de la noticia"
- Si hay logo/evento → "Incorporá visualmente la referencia en la composición"
- Si no hay referencia → genera solo con texto

```typescript
// Ejemplo de llamada multimodal a Gemini
const parts = [
  { inlineData: { mimeType: "image/jpeg", data: base64Photo } },  // foto de referencia
  { text: "Fotografía periodística de [persona] en conferencia..." }  // prompt
];

// generationConfig con responseModalities: ["IMAGE", "TEXT"]
```

Fallback: si Gemini falla, intenta con xAI Grok (solo texto, sin imagen de referencia).

Una vez obtenida la imagen de fondo, `processImage()` (imageService.ts) la procesa:

1. Redimensiona a 1080x1080 pixeles
2. Aplica overlay oscuro semitransparente para legibilidad
3. Superpone el titulo con tipografia grande (BebasKai si disponible, sans-serif fallback)
4. Agrega logo de la plataforma configurada (PLATFORM_NAME) en esquina
5. Guarda en `output/` como PNG

### Publicacion multi-plataforma

Cuando una nota esta lista, se publica en todas las plataformas configuradas, en este orden:

#### 1. Google Drive

```typescript
// Autenticacion con Service Account
const auth = new google.auth.JWT(clientEmail, undefined, privateKey, SCOPES);
// Sube la imagen a la carpeta configurada
const response = await drive.files.create({ requestBody: metadata, media });
// Obtiene URL publica (webContentLink)
const publicUrl = response.data.webContentLink;
```

La URL de Drive es necesaria para Instagram (que no acepta upload directo de imagenes).

#### 2. Webhook (Make.com / N8N)

```typescript
await axios.post(webhookUrl, {
  title,
  datePublished: new Date().toISOString(),
  content,
  imageUrl,
  linkUrl: imageDriveUrl,
  imageDriveUrl
});
```

#### 3. Twitter

```typescript
// 1. Descarga la imagen localmente
// 2. Sube la imagen a Twitter (media/upload)
const mediaId = await twitterClient.v1.uploadMedia(imagePath);
// 3. Publica el tweet con la imagen
await twitterClient.v2.tweet({ text: titulo + "\n\n" + contenido, media: { media_ids: [mediaId] } });
```

#### 4. Meta API (Facebook + Instagram)

```typescript
// Facebook: publicacion directa con foto
await axios.post(`https://graph.facebook.com/v22.0/${pageId}/photos`, {
  url: imageDriveUrl,  // URL publica de la imagen
  caption: titulo + "\n\n" + contenido,
  access_token: pageToken
});

// Instagram: flujo de 2 pasos
// Paso 1: crear media container
const { id: containerId } = await axios.post(
  `https://graph.facebook.com/v22.0/${igAccountId}/media`,
  { image_url: imageDriveUrl, caption: texto, access_token: token }
);

// Paso 2: publicar container (requiere polling hasta status FINISHED)
await axios.post(
  `https://graph.facebook.com/v22.0/${igAccountId}/media_publish`,
  { creation_id: containerId, access_token: token }
);
```

---

## 4. Base de Datos

PeriodistApp usa SQLite con better-sqlite3 y WAL mode habilitado para mejor performance de escritura concurrente. La base de datos se crea automaticamente en `data/credentials.db`.

### Tabla: `credentials`

Almacena tokens y credenciales sensibles encriptados con AES-256-GCM.

```sql
CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,      -- Identificador unico. Ej: "META_PAGE_TOKEN_123456789"
  value TEXT NOT NULL,             -- Valor encriptado en formato iv:authTag:ciphertext (hex)
  category TEXT DEFAULT 'meta',   -- Categoria: "meta", "twitter", "google", etc.
  is_valid INTEGER DEFAULT 1,     -- 1 = activo, 0 = revocado/expirado
  created_at TEXT,                 -- Timestamp ISO 8601
  updated_at TEXT                  -- Timestamp ISO 8601
);
```

**Ejemplo de un registro:**

| name | value | category |
|------|-------|----------|
| `META_USER_TOKEN` | `a1b2c3...:d4e5f6...:789abc...` | meta |
| `META_PAGE_TOKEN_12345` | `f0e1d2...:c3b4a5...:678901...` | meta |

**Nota:** Los valores en la columna `value` estan encriptados. El formato es `iv:authTag:ciphertext`, donde los tres componentes estan en hexadecimal separados por `:`.

### Tabla: `business_assets`

Almacena las Facebook Pages y cuentas de Instagram descubiertas durante el flujo OAuth.

```sql
CREATE TABLE IF NOT EXISTS business_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_type TEXT NOT NULL,        -- "facebook_page" | "instagram_account"
  external_id TEXT NOT NULL UNIQUE, -- ID de la pagina/cuenta en Meta (ej: "123456789")
  name TEXT,                       -- Nombre visible (ej: "Radio Uno Formosa")
  metadata TEXT,                   -- JSON con datos adicionales
  is_active INTEGER DEFAULT 1,     -- 1 = activa, 0 = desactivada
  created_at TEXT,                 -- Timestamp ISO 8601
  updated_at TEXT                  -- Timestamp ISO 8601
);
```

**Campos del `metadata` JSON:**

Para `facebook_page`:
```json
{
  "access_token_name": "META_PAGE_TOKEN_123456789",
  "category": "Media/News Company"
}
```

Para `instagram_account`:
```json
{
  "username": "radiounoformosa",
  "profile_picture_url": "https://...",
  "page_id": "123456789",
  "page_token_name": "META_PAGE_TOKEN_123456789"
}
```

### Tabla: `publications`

Registro de todas las notas publicadas (tanto del pipeline como manuales).

```sql
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,              -- Titulo de la nota
  content TEXT,                     -- Contenido/cuerpo de la nota
  image_path TEXT,                  -- Ruta local de la imagen (output/xxx.png)
  image_url TEXT,                   -- URL publica (Google Drive webContentLink)
  source TEXT DEFAULT 'manual',    -- Origen: "pipeline" | "manual" | "url"
  publish_results TEXT,            -- JSON con resultados por plataforma
  created_at TEXT                  -- Timestamp ISO 8601
);
```

**Ejemplo de `publish_results` JSON:**

```json
{
  "facebook": [
    { "pageId": "123456", "pageName": "Radio Uno", "postId": "123456_789012", "success": true }
  ],
  "instagram": [
    { "accountId": "654321", "username": "radiounoformosa", "mediaId": "17890...", "success": true }
  ]
}
```

### Tabla: `transcriptions`

Registro de todas las transcripciones (del pipeline y capturas manuales).

```sql
CREATE TABLE IF NOT EXISTS transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,              -- Texto transcrito
  audio_file TEXT,                 -- Nombre del archivo de audio (si aplica)
  source TEXT DEFAULT 'manual',   -- Origen: "pipeline" | "manual"
  duration_seconds INTEGER,       -- Duracion del audio en segundos
  created_at TEXT                 -- Timestamp ISO 8601
);
```

### Tabla: `settings`

Configuraciones persistentes de la aplicacion (webhooks, preferencias).

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,            -- Clave unica (ej: "webhook_pipeline")
  value TEXT NOT NULL,             -- Valor de la configuracion
  updated_at TEXT                  -- Timestamp ISO 8601
);
```

**Claves conocidas:**

| Key | Descripcion |
|-----|-------------|
| `webhook_pipeline` | URL del webhook para el pipeline autonomo |
| `webhook_nuevo_boton` | URL del webhook para el boton "Nuevo" |
| `webhook_viejo_boton` | URL del webhook para el boton "Viejo" |
| `webhook_tercer_boton` | URL del webhook para el tercer boton |

---

## 5. Eventos Socket.IO

El backend emite eventos en tiempo real para que el frontend muestre el progreso del pipeline y actualizaciones del historial.

### Evento principal: `pipeline-update`

Todos los eventos del pipeline se envian envueltos en un wrapper `pipeline-update`:

```typescript
io.emit("pipeline-update", {
  event: "tipo_de_evento",         // Nombre del sub-evento
  timestamp: "2024-01-15T10:30:00Z", // Timestamp ISO 8601
  ...datos_adicionales              // Datos especificos del evento
});
```

### Tabla completa de eventos del pipeline

| Evento (`event`) | Datos adicionales | Cuando se emite |
|-------------------|-------------------|-----------------|
| `started` | `url`, `sourceType`, `tone`, `structure`, `mode` | El pipeline fue iniciado exitosamente. `mode` siempre es `"continuous-smart"`. |
| `step` | `step`, `message` | Cambio de paso principal. `step` puede ser: `"capturing"`, `"analyzing"`, `"searching"`, `"generating"`, `"creating_flyer"`, `"publishing"`. |
| `detail` | `step`, `sub`, `message`, `icon` | Sub-paso dentro de un paso principal. Ej: `sub: "recording"`, `sub: "transcribing"`, `sub: "transcription_done"`. `icon` indica el icono a mostrar (ej: `"mic"`, `"brain"`, `"check"`, `"warning"`, `"satellite"`, `"clock"`). |
| `transcription` | `step` (`"transcribed"`), `text`, `timestamp`, `bufferSize`, `totalMinutes` | Un chunk fue transcrito exitosamente. `bufferSize` es la cantidad total de chunks acumulados. `totalMinutes` son los minutos totales de audio procesado. |
| `note` | `step` (`"note"`), `title`, `content` | Una nota periodistica fue generada exitosamente. |
| `flyer` | `step` (`"flyer"`), `path`, `previewUrl` | Una placa/flyer fue creada. `path` es la ruta local, `previewUrl` es la URL relativa para preview (`/output/xxx.png`). |
| `flyer_bg` | `source` | Indica el origen del fondo de la placa. Valores posibles: `"web"` (imagen de articulo), `"ai_generating"` (IA en proceso), `"gemini_imagen"` (Gemini genero), `"grok_image"` (Grok genero), `"placeholder"` (gradiente fallback). |
| `published` | `step` (`"published"`), `title`, `topic`, `totalPublished` | Una nota fue publicada en todas las plataformas. `totalPublished` es el conteo acumulado de notas publicadas en la sesion. |
| `publish_warnings` | `warnings: string[]` | Errores parciales de publicacion. Ej: Twitter fallo pero Facebook publico correctamente. Cada warning es un mensaje descriptivo del error. |
| `error` | `step`, `message` | Error en algun paso del pipeline. No detiene la ejecucion; el pipeline reintenta. |
| `stopped` | `totalPublished`, `totalMinutes`, `publishedTopics` | Pipeline detenido (por usuario o error irrecuperable). Incluye estadisticas finales de la sesion. |

### Eventos directos (sin wrapper `pipeline-update`)

Estos eventos se emiten directamente con `io.emit()`, sin el wrapper:

| Evento | Datos | Cuando se emite |
|--------|-------|-----------------|
| `history-new-publication` | Objeto `Publication` completo (id, title, content, image_path, image_url, source, publish_results, created_at) | Nueva publicacion guardada en la base de datos. Se emite tanto desde el pipeline como desde publicaciones manuales. |
| `history-new-transcription` | Objeto `Transcription` completo (id, text, audio_file, source, duration_seconds, created_at) | Nueva transcripcion guardada en la base de datos. |
| `history-delete-publication` | `{ id: number }` | Una publicacion fue eliminada desde el historial. |
| `history-delete-transcription` | `{ id: number }` | Una transcripcion fue eliminada desde el historial. |
| `receive-transcription-update` | Objeto con `{ timestamp, audioFile, text }` | Transcripcion recibida desde captura manual de audio. |
| `capture-error` | `{ message: string }` | Error en la captura manual de audio (script Python fallo). |

### Ejemplo de secuencia de eventos tipica

```
1. pipeline-update { event: "started", url: "https://youtube.com/...", ... }
2. pipeline-update { event: "step", step: "capturing", message: "Capturando audio..." }
3. pipeline-update { event: "detail", step: "capturing", sub: "connecting", message: "Conectando al stream..." }
4. pipeline-update { event: "detail", step: "capturing", sub: "recording", message: "Chunk #1: grabando 120s..." }
5. pipeline-update { event: "detail", step: "capturing", sub: "audio_captured", message: "Chunk #1 capturado (120s)" }
6. pipeline-update { event: "detail", step: "capturing", sub: "transcribing", message: "Transcribiendo chunk #1..." }
7. pipeline-update { event: "detail", step: "capturing", sub: "recording", message: "Chunk #2: grabando 120s..." }
8. pipeline-update { event: "detail", step: "capturing", sub: "waiting_prev", message: "Esperando transcripcion #1..." }
9. pipeline-update { event: "transcription", text: "Buenos dias, hoy vamos a hablar de...", bufferSize: 1, totalMinutes: 2 }
10. [... mas chunks ...]
11. pipeline-update { event: "step", step: "analyzing", message: "Analizando temas..." }
12. pipeline-update { event: "detail", step: "analyzing", sub: "topic_found", message: "Tema detectado: Inflacion..." }
13. pipeline-update { event: "step", step: "searching", message: "Investigando en la web..." }
14. pipeline-update { event: "step", step: "generating", message: "Generando nota periodistica..." }
15. pipeline-update { event: "note", title: "La inflacion...", content: "Segun datos oficiales..." }
16. pipeline-update { event: "step", step: "creating_flyer", message: "Creando placa visual..." }
17. pipeline-update { event: "flyer_bg", source: "web" }
18. pipeline-update { event: "flyer", path: "output/flyer_abc123.png", previewUrl: "/output/flyer_abc123.png" }
19. pipeline-update { event: "step", step: "publishing", message: "Publicando en plataformas..." }
20. pipeline-update { event: "published", title: "La inflacion...", topic: "Inflacion", totalPublished: 1 }
21. history-new-publication { id: 1, title: "La inflacion...", ... }
```

---

## 6. API REST - Endpoints Completos

Todos los endpoints estan prefijados con `/api/` (excepto uno legacy). El backend escucha en el puerto 3001.

### Pipeline (`/api/pipeline/*`)

Registrados en `src/server/routes/pipeline.ts`.

---

#### `POST /api/pipeline/start`

Inicia el pipeline autonomo de captura y publicacion.

**Request Body:**
```json
{
  "url": "https://www.youtube.com/watch?v=XXXX",
  "tone": "formal",
  "structure": "completa",
  "imageModel": "gemini",
  "segmentDuration": 120,
  "autoPublish": true
}
```

| Campo | Tipo | Obligatorio | Default | Descripcion |
|-------|------|-------------|---------|-------------|
| `url` | string | **SI** | - | URL del stream de audio (YouTube, radio) |
| `tone` | string | No | `"formal"` | Tono de la nota: `"formal"`, `"informal"`, `"urgente"`, `"editorial"` |
| `structure` | string | No | `"completa"` | Estructura: `"completa"`, `"breve"`, `"bullet"`, `"tweet"` |
| `imageModel` | string | No | `"gemini"` | Modelo para generacion de imagenes: `"gemini"`, `"grok"` |
| `segmentDuration` | number | No | `120` | Duracion de cada chunk de audio en segundos |
| `autoPublish` | boolean | No | `true` | Si publica automaticamente o espera confirmacion |

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "message": "Pipeline autonomo iniciado.",
  "config": {
    "url": "https://...",
    "tone": "formal",
    "structure": "completa",
    "imageModel": "gemini",
    "segmentDuration": 120,
    "autoPublish": true
  }
}
```

**Errores:**
- `400`: No se proporciono URL, o el pipeline ya esta en ejecucion.
- `500`: Error interno al iniciar el pipeline.

---

#### `POST /api/pipeline/stop`

Detiene el pipeline en ejecucion.

**Request Body:** Vacio.

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "message": "Pipeline detenido.",
  "stats": {
    "totalPublished": 5
  }
}
```

**Errores:**
- `400`: No hay pipeline en ejecucion.

---

#### `GET /api/pipeline/status`

Retorna el estado actual del pipeline.

**Respuesta (200):**
```json
{
  "running": true,
  "currentStep": "capturing",
  "chunksTranscribed": 12,
  "totalMinutes": 24,
  "transcriptionLength": 15420,
  "publishedTopics": ["Inflacion de alimentos", "Obra ruta 11"],
  "totalPublished": 2,
  "publishedNotes": [
    {
      "title": "La inflacion...",
      "content": "Segun datos...",
      "imageUrl": "/output/flyer_abc123.png",
      "topic": "Inflacion de alimentos",
      "publishedAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

Si no hay pipeline activo, retorna estado `idle` con todos los campos en 0/vacio.

---

#### `GET /api/pipeline/options`

Retorna las opciones disponibles de tonos y estructuras para la configuracion del pipeline.

**Respuesta (200):**
```json
{
  "tones": [
    { "value": "formal", "label": "Formal", "description": "Tono profesional..." },
    { "value": "informal", "label": "Informal", "description": "Tono coloquial..." },
    { "value": "urgente", "label": "Urgente", "description": "Tono de ultimo momento..." },
    { "value": "editorial", "label": "Editorial", "description": "Tono de opinion..." }
  ],
  "structures": [
    { "value": "completa", "label": "Completa", "description": "Nota completa con..." },
    { "value": "breve", "label": "Breve", "description": "Nota corta..." },
    { "value": "bullet", "label": "Bullet", "description": "Puntos clave..." },
    { "value": "tweet", "label": "Tweet", "description": "Formato tweet..." }
  ]
}
```

---

### Meta (`/api/meta/*`)

Registrados en `src/server/routes/meta.ts`.

---

#### `GET /api/meta/config`

Retorna los IDs publicos de la app de Meta (sin secretos) para el frontend.

**Respuesta (200):**
```json
{
  "appId": "123456789012345",
  "configId": "987654321"
}
```

---

#### `GET /api/meta/status`

Retorna el estado de conexion con Meta.

**Respuesta (200):**
```json
{
  "connected": true,
  "assets": [
    {
      "id": 1,
      "asset_type": "facebook_page",
      "external_id": "123456789",
      "name": "Radio Uno Formosa",
      "metadata": { "category": "Media" },
      "is_active": 1
    },
    {
      "id": 2,
      "asset_type": "instagram_account",
      "external_id": "654321",
      "name": "radiounoformosa",
      "metadata": { "username": "radiounoformosa", "profile_picture_url": "https://..." },
      "is_active": 1
    }
  ],
  "tokenExpiresAt": "2024-03-15T10:00:00Z",
  "daysUntilExpiry": 45
}
```

---

#### `POST /api/meta/connect`

Recibe el token o codigo del popup de Facebook y completa el flujo OAuth.

**Request Body:**
```json
{
  "accessToken": "EAAGm0PX4ZCpsBA...",
  "code": null,
  "redirectUri": null
}
```

| Campo | Tipo | Descripcion |
|-------|------|-------------|
| `accessToken` | string | Short-lived token del popup de FB (via FB.login) |
| `code` | string | Codigo de autorizacion (alternativa al token) |
| `redirectUri` | string | URI de redireccion (solo si se usa `code`) |

Se requiere al menos `accessToken` o `code`.

**Respuesta exitosa (200):**
```json
{
  "success": true,
  "connected": true,
  "expiresIn": 5184000,
  "permissions": ["pages_manage_posts", "pages_read_engagement", "instagram_basic", "instagram_content_publish"],
  "assets": [
    { "asset_type": "facebook_page", "name": "Radio Uno Formosa", "external_id": "123456" },
    { "asset_type": "instagram_account", "name": "radiounoformosa", "external_id": "654321" }
  ]
}
```

**Nota:** La respuesta NUNCA incluye tokens. Los tokens se guardan encriptados en la DB.

---

#### `POST /api/meta/disconnect`

Desconecta Meta: elimina todas las credenciales y desactiva los assets.

**Request Body:** Vacio.

**Respuesta (200):**
```json
{
  "success": true,
  "message": "Desconectado de Meta exitosamente."
}
```

---

#### `POST /api/meta/publish`

Publica directamente en todas las plataformas Meta conectadas (Facebook Pages + Instagram).

**Request Body:**
```json
{
  "title": "Titulo de la nota",
  "content": "Contenido completo de la nota...",
  "imageUrl": "https://drive.google.com/...",
  "imagePath": "output/flyer_abc123.png"
}
```

| Campo | Tipo | Obligatorio | Descripcion |
|-------|------|-------------|-------------|
| `title` | string | **SI** | Titulo de la publicacion |
| `content` | string | No | Contenido/cuerpo |
| `imageUrl` | string | No | URL publica de la imagen (para IG) |
| `imagePath` | string | No | Ruta local de la imagen (para FB) |

**Respuesta (200):**
```json
{
  "success": true,
  "results": {
    "facebook": [{ "pageId": "123", "postId": "123_456", "success": true }],
    "instagram": [{ "accountId": "654", "mediaId": "178...", "success": true }]
  }
}
```

---

### Generacion y Webhooks (`/api/generate*`, `/api/sendWebhook*`)

Registrados en `src/server/routes/generate.ts`.

---

#### `POST /api/generate`

Sube una imagen + titulo, genera una placa visual y la sube a Google Drive.

**Request:** Multipart form-data.

| Campo | Tipo | Obligatorio | Descripcion |
|-------|------|-------------|-------------|
| `image` | File | **SI** | Archivo de imagen (JPG, PNG) |
| `title` | string | **SI** | Titulo para overlay en la placa |
| `description` | string | No | Descripcion adicional |

**Respuesta (200):**
```json
{
  "imageUrl": "/output/processed_abc123.png",
  "title": "Titulo de la nota",
  "description": "Descripcion...",
  "finalImagePath": "output/processed_abc123.png"
}
```

---

#### `POST /api/generate-from-url`

Scrapea un articulo web, extrae titulo e imagen, y genera una placa.

**Request Body:**
```json
{
  "url": "https://www.elcomercial.com.ar/articulo/..."
}
```

**Respuesta (200):**
```json
{
  "imageUrl": "/output/processed_abc123.png",
  "title": "Titulo extraido del articulo",
  "content": "Contenido extraido del articulo...",
  "finalImagePath": "output/processed_abc123.png"
}
```

---

#### `POST /api/sendWebhook`

"Boton Viejo": sube imagen a Drive, envia webhook, publica en Meta, guarda en DB.

**Request Body:**
```json
{
  "title": "Titulo de la nota",
  "description": "Contenido de la nota",
  "imageUrl": "/output/processed_abc123.png",
  "finalImagePath": "output/processed_abc123.png"
}
```

| Campo | Tipo | Obligatorio | Descripcion |
|-------|------|-------------|-------------|
| `title` | string | **SI** | Titulo |
| `finalImagePath` | string | **SI** | Ruta local de la imagen procesada |
| `description` | string | No | Contenido |
| `imageUrl` | string | No | URL relativa de preview |

**Respuesta (200):**
```json
{
  "success": true,
  "message": "Webhook enviado con exito.",
  "metaResults": { "facebook": [...], "instagram": [...] },
  "publication": { "id": 1, "title": "...", ... }
}
```

---

#### `POST /api/sendWebhookNuevoBoton`

"Boton Nuevo": similar al anterior pero usa el webhook "nuevo" y source `"url"`.

**Request Body:**
```json
{
  "title": "Titulo de la nota",
  "content": "Contenido generado...",
  "imageUrl": "/output/processed_abc123.png",
  "finalImagePath": "output/processed_abc123.png"
}
```

**Respuesta (200):**
```json
{
  "success": true,
  "message": "Webhook enviado con exito (Nuevo Boton)",
  "metaResults": { ... },
  "publication": { ... }
}
```

---

#### `POST /api/generateNewsCopy`

Genera una nota periodistica a partir de contexto y/o transcripcion usando IA.

**Request Body:**
```json
{
  "context": "Articulo scrapeado o datos de contexto...",
  "transcription": "Transcripcion del audio..."
}
```

Se requiere al menos uno de los dos campos.

**Respuesta (200):**
```json
{
  "generatedCopy": "Texto de la nota periodistica generada por IA..."
}
```

---

### Captura de Audio (`/api/start-capture`, `/api/stop-capture`)

Registrados en `src/server/routes/capture.ts`.

---

#### `POST /api/start-capture`

Inicia captura manual de audio ejecutando el script Python `scripts/audio_capture.py`.

**Request Body:** Vacio.

**Respuesta (200):**
```json
{
  "success": true,
  "message": "Captura iniciada."
}
```

**Errores:**
- `400`: La captura ya esta en curso.

**Nota:** La captura manual es independiente del pipeline autonomo. Usa un script Python separado y emite eventos `receive-transcription-update` y `capture-error` directamente via Socket.IO.

---

#### `POST /api/stop-capture`

Detiene la captura manual de audio. En Windows usa `taskkill`, en Linux/Mac usa `SIGTERM`.

**Request Body:** Vacio.

**Respuesta (200):**
```json
{
  "success": true,
  "message": "Captura detenida correctamente."
}
```

**Errores:**
- `400`: No hay captura en curso / no hay proceso de captura en ejecucion.
- `500`: Error al detener la captura.

---

### Historial (`/api/history/*`)

Registrados en `src/server/routes/history.ts`.

---

#### `GET /api/history/publications`

Lista publicaciones con paginacion.

**Query Parameters:**

| Parametro | Tipo | Default | Descripcion |
|-----------|------|---------|-------------|
| `limit` | number | 50 | Cantidad de resultados por pagina |
| `offset` | number | 0 | Desplazamiento para paginacion |

**Respuesta (200):**
```json
{
  "publications": [
    {
      "id": 1,
      "title": "Titulo de la nota",
      "content": "Contenido...",
      "image_path": "output/flyer_abc.png",
      "image_url": "https://drive.google.com/...",
      "source": "pipeline",
      "publish_results": "{ ... }",
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 42
}
```

---

#### `DELETE /api/history/publications/:id`

Elimina una publicacion del historial.

**Respuesta (200):**
```json
{ "success": true }
```

**Errores:**
- `404`: Publicacion no encontrada.

**Efecto colateral:** Emite `history-delete-publication { id }` via Socket.IO.

---

#### `GET /api/history/transcriptions`

Lista transcripciones con paginacion. Mismos query parameters que publicaciones.

**Respuesta (200):**
```json
{
  "transcriptions": [
    {
      "id": 1,
      "text": "Buenos dias, hoy vamos a hablar...",
      "audio_file": "chunk_001.mp3",
      "source": "pipeline",
      "duration_seconds": 120,
      "created_at": "2024-01-15T10:28:00Z"
    }
  ],
  "total": 156
}
```

---

#### `DELETE /api/history/transcriptions/:id`

Elimina una transcripcion del historial.

**Respuesta (200):**
```json
{ "success": true }
```

**Errores:**
- `404`: Transcripcion no encontrada.

**Efecto colateral:** Emite `history-delete-transcription { id }` via Socket.IO.

---

### Settings (`/api/settings/*`)

Registrados en `src/server/routes/settings.ts`.

---

#### `GET /api/settings/webhooks`

Retorna las URLs de webhooks configuradas. Prioridad: DB > `.env` > vacio.

**Respuesta (200):**
```json
{
  "webhook_pipeline": "https://hook.us1.make.com/...",
  "webhook_nuevo_boton": "https://hook.us1.make.com/...",
  "webhook_viejo_boton": "",
  "webhook_tercer_boton": ""
}
```

---

#### `POST /api/settings/webhooks`

Guarda las URLs de webhooks en la base de datos. Solo se actualizan los campos enviados.

**Request Body:**
```json
{
  "webhook_pipeline": "https://hook.us1.make.com/nuevo",
  "webhook_nuevo_boton": "https://...",
  "webhook_viejo_boton": "https://...",
  "webhook_tercer_boton": "https://..."
}
```

Todos los campos son opcionales. Solo se actualizan los que se envian.

**Respuesta (200):**
```json
{
  "success": true,
  "message": "Webhooks actualizados correctamente."
}
```

---

### Endpoint Legacy

#### `GET /api/get-transcriptions`

Lee y retorna el contenido del archivo JSON de transcripciones (`output/transcripciones.json`). Este es un endpoint legacy de la version anterior de la aplicacion.

**Respuesta (200):**
```json
{
  "transcriptions": [
    {
      "timestamp": "2024-01-15T10:28:00Z",
      "audioFile": "chunk_001.mp3",
      "text": "Texto transcrito..."
    }
  ]
}
```

**Nota:** Este endpoint lee del archivo JSON local, no de la base de datos SQLite. Los endpoints modernos son `/api/history/transcriptions`.

---

## 7. Frontend - Que se ve en cada seccion

### Layout General

La aplicacion es una **Single-Page Application (SPA)** con dark theme. Todo el componente principal vive en `src/client/App.tsx`.

- **Fondo:** `#0b0d17` (azul muy oscuro, casi negro)
- **Ancho maximo:** 900px centrado horizontalmente
- **Tipografia:** Sistema (sans-serif)
- **Comunicacion:** Socket.IO para actualizaciones en tiempo real

### Top Bar (sticky)

Barra superior fija que siempre se muestra al tope de la pagina:

```
┌─────────────────────────────────────────────────────────┐
│  [Logo]  {PLATFORM_NAME}                [DeepSeek] [Gemini] │
│                                         (badges IA)        │
└─────────────────────────────────────────────────────────┘
```

- **Izquierda:** Logo de la plataforma (`public/logo.png`) + nombre configurado via `PLATFORM_NAME`
- **Derecha:** Badges de los proveedores de IA disponibles (DeepSeek, Gemini). Se muestran como etiquetas con los colores de cada servicio.

### Seccion 1: Pipeline Autonomo (Hero)

La seccion principal y mas prominente de la aplicacion. Ocupa la mayor parte de la pantalla.

#### Formulario de configuracion

```
┌─────────────────────────────────────────────────────────┐
│  URL del stream                                         │
│  [https://www.youtube.com/watch?v=...              ]    │
│                                                         │
│  Tono          Estructura       Modelo de Imagen        │
│  [Formal ▼]    [Completa ▼]    [Gemini ▼]             │
│                                                         │
│  Duracion del segmento (segundos)   Auto-publicar       │
│  [120]                              [✓]                 │
│                                                         │
│  [▶ Iniciar Pipeline]  o  [■ Detener Pipeline]         │
└─────────────────────────────────────────────────────────┘
```

- **URL:** Campo de texto para la URL del stream (YouTube, radio)
- **Tono:** Dropdown con opciones: Formal, Informal, Urgente, Editorial
- **Estructura:** Dropdown con opciones: Completa, Breve, Bullet, Tweet
- **Modelo de Imagen:** Dropdown con opciones: Gemini (Google Imagen), Grok (xAI)
- **Duracion:** Input numerico en segundos (default 120)
- **Auto-publicar:** Checkbox (default activado)
- **Botones:** "Iniciar Pipeline" (verde) cuando esta detenido, "Detener Pipeline" (rojo) cuando esta en ejecucion

#### Indicador de estado

```
● Pipeline en ejecucion - Capturando audio...     (circulo verde pulsante)
● Pipeline detenido                                (circulo rojo)
● Analizando temas...                             (circulo amarillo)
```

Un circulo de color con animacion de pulso que cambia segun el estado actual del pipeline.

#### Step Progress

Barra visual con 6 pasos, donde el paso activo se resalta:

```
  📡          🔍          🔎          📝          🎨          📤
Captura → Analisis → Busqueda → Nota → Placa → Publicar
  [===]      [ ]        [ ]       [ ]    [ ]      [ ]
```

Cada icono se ilumina cuando el pipeline entra en ese paso. Los pasos completados quedan con check verde.

#### Activity Feed

Tarjetas de actividad que aparecen en tiempo real conforme el pipeline progresa:

```
┌─ Captura ──────────────────────────────────────────────┐
│  📡 Conectando al stream: youtube.com/watch?v=...      │
│  🎙 Chunk #1: grabando 120s de audio...                │
│  ✓ Chunk #1 capturado (120s)                           │
│  🧠 Transcribiendo chunk #1 con Whisper...             │
│  ✓ Chunk #1 transcrito: "Buenos dias, hoy vamos..."    │
│  🎙 Chunk #2: grabando 120s de audio...                │
└────────────────────────────────────────────────────────┘

┌─ Procesamiento: Inflacion de alimentos ───────────────┐
│  🔍 Tema detectado: Inflacion de alimentos             │
│  🔎 Buscando articulos relacionados...                 │
│  📝 Generando nota periodistica...                     │
│  🎨 Creando placa visual...                            │
│  📤 Publicando en Twitter, Facebook, Instagram...      │
│  ✓ Publicacion completada                              │
└────────────────────────────────────────────────────────┘
```

Se crean dos tipos de tarjetas:
- **Tarjeta "Captura":** Persistente mientras el pipeline graba. Acumula todos los sub-pasos de captura y transcripcion.
- **Tarjeta "Procesamiento":** Se crea por cada tema confirmado. Muestra los pasos de analisis, busqueda, generacion, creacion de placa y publicacion.

#### Notas publicadas

Galeria de notas generadas en la sesion actual:

```
┌──────────────────────┐  ┌──────────────────────┐
│  [Imagen de placa]   │  │  [Imagen de placa]   │
│                      │  │                      │
│  Titulo de la nota   │  │  Otro titulo         │
│  Contenido preview...│  │  Contenido preview...│
│  10:30 AM            │  │  10:45 AM            │
└──────────────────────┘  └──────────────────────┘
```

#### Transcripcion en vivo

Area de texto colapsable que muestra la transcripcion completa acumulada de la sesion:

```
▼ Transcripcion en vivo (24 minutos, 12 chunks)
┌────────────────────────────────────────────────────────┐
│ Buenos dias, estamos en Radio Uno Formosa. Hoy vamos   │
│ a hablar de varios temas. Empezamos con la situacion   │
│ de la inflacion en los alimentos, segun los ultimos    │
│ datos del INDEC...                                     │
│ [texto continuo de toda la transcripcion]               │
└────────────────────────────────────────────────────────┘
```

#### Log detallado

Seccion colapsable con el historial completo de todos los sub-pasos y mensajes del pipeline:

```
▼ Log detallado
10:28:00 [capturing] Conectando al stream
10:28:02 [capturing] Chunk #1: grabando 120s
10:30:02 [capturing] Chunk #1 capturado
10:30:03 [capturing] Transcribiendo chunk #1
...
```

### Seccion 2: Conexion Meta

```
┌─────────────────────────────────────────────────────────┐
│  Meta Business                                          │
│                                                         │
│  Estado: ● Conectado                                    │
│                                                         │
│  Facebook Pages:                                        │
│    ✓ Radio Uno Formosa (ID: 123456789)                 │
│                                                         │
│  Instagram:                                             │
│    ✓ @radiounoformosa (ID: 654321)                     │
│                                                         │
│  Token expira en: 45 dias                              │
│                                                         │
│  [Desconectar]                                         │
└─────────────────────────────────────────────────────────┘
```

- **Indicador de estado:** Verde "Conectado" o rojo "Desconectado"
- **Lista de assets:** Facebook Pages e Instagram accounts vinculadas
- **Warning de token:** Muestra alerta cuando quedan menos de 10 dias para la expiracion del token
- **Boton "Conectar con Meta":** Solo visible cuando esta desconectado. Abre popup del FB SDK.
- **Boton "Desconectar":** Solo visible cuando esta conectado. Elimina credenciales.

### Seccion 3: Configuracion de Webhooks (colapsable)

```
▼ Configuracion de Webhooks
┌─────────────────────────────────────────────────────────┐
│  Webhook Pipeline:                                      │
│  [https://hook.us1.make.com/...                    ]    │
│                                                         │
│  Webhook Nuevo Boton:                                   │
│  [https://...                                      ]    │
│                                                         │
│  Webhook Viejo Boton:                                   │
│  [https://...                                      ]    │
│                                                         │
│  Webhook Tercer Boton:                                  │
│  [https://...                                      ]    │
│                                                         │
│  [Guardar] ✓ Guardado                                  │
└─────────────────────────────────────────────────────────┘
```

Los webhooks se guardan en la base de datos y tienen prioridad sobre las variables de entorno.

### Seccion 4: Herramientas Manuales (colapsable)

#### Crear Placa Manual

```
▼ Crear Placa Manual
┌─────────────────────────────────────────────────────────┐
│  Subir imagen: [Seleccionar archivo]                    │
│  Titulo: [                                         ]    │
│  [Generar Placa]                                       │
│                                                         │
│  Preview:                                               │
│  ┌─────────────────┐                                   │
│  │ [Placa generada] │                                   │
│  └─────────────────┘                                   │
│  [Enviar Webhook Viejo]  [Enviar Webhook Nuevo]        │
└─────────────────────────────────────────────────────────┘
```

#### Generar desde URL

```
▼ Generar desde URL
┌─────────────────────────────────────────────────────────┐
│  URL del articulo:                                      │
│  [https://www.elcomercial.com.ar/...               ]    │
│  [Generar]                                             │
│                                                         │
│  Preview:                                               │
│  Titulo: "Titulo extraido del articulo"                │
│  ┌─────────────────┐                                   │
│  │ [Placa generada] │                                   │
│  └─────────────────┘                                   │
│  Contenido: "Texto extraido..."                        │
│  [Generar Nota IA]  [Publicar]                         │
└─────────────────────────────────────────────────────────┘
```

#### Captura de Audio

```
▼ Captura de Audio Manual
┌─────────────────────────────────────────────────────────┐
│  [▶ Iniciar Captura]  o  [■ Detener Captura]           │
│                                                         │
│  Transcripcion:                                         │
│  ┌────────────────────────────────────────────────┐     │
│  │ Texto transcrito del audio capturado...         │     │
│  └────────────────────────────────────────────────┘     │
│  [Generar Nota IA]                                     │
└─────────────────────────────────────────────────────────┘
```

### Seccion 5: Historial (tabs)

```
┌─────────────────────────────────────────────────────────┐
│  [Publicaciones]  [Transcripciones]                     │
│                                                         │
│  ┌──────────────────────┐  ┌──────────────────────┐    │
│  │  [Imagen]             │  │  [Imagen]             │    │
│  │  Titulo de la nota    │  │  Otro titulo          │    │
│  │  Pipeline | 10:30     │  │  Manual | 11:15       │    │
│  │  [🗑 Eliminar]        │  │  [🗑 Eliminar]        │    │
│  └──────────────────────┘  └──────────────────────┘    │
│                                                         │
│  [Cargar mas]                                          │
└─────────────────────────────────────────────────────────┘
```

- **Tab Publicaciones:** Galeria con cards mostrando imagen, titulo, origen (pipeline/manual/url), timestamp, y boton eliminar.
- **Tab Transcripciones:** Lista de transcripciones con texto (truncado), origen, duracion, timestamp, y boton eliminar.
- **Paginacion:** Boton "Cargar mas" que usa offset para cargar paginas adicionales.
- **Actualizacion real-time:** Via Socket.IO, las nuevas publicaciones y transcripciones aparecen automaticamente.

---

## 8. Conexion Meta - Flujo Completo del Popup con FB SDK

### Prerrequisitos

Antes de usar la integracion con Meta, el usuario debe:

1. **Crear una Meta App** en [developers.facebook.com](https://developers.facebook.com)
2. **Obtener APP_ID y APP_SECRET** de la app creada
3. **Configurar el producto "Facebook Login"** en la app con los dominios permitidos
4. **Solicitar permisos** de revision (para produccion; en modo desarrollo funcionan con administradores de la app)
5. **Agregar las variables** `META_APP_ID` y `META_APP_SECRET` al `.env`

### Flujo del popup paso a paso

#### Paso 1: Usuario hace clic en "Conectar con Meta"

El frontend detecta que Meta no esta conectado y muestra el boton.

#### Paso 2: Frontend pide configuracion

```javascript
// Frontend hace GET /api/meta/config
const { appId, configId } = await fetch("/api/meta/config").then(r => r.json());
```

#### Paso 3: Carga dinamica del Facebook JS SDK

```javascript
// Se carga el SDK de Facebook desde CDN
const script = document.createElement("script");
script.src = "https://connect.facebook.net/es_LA/sdk.js";
script.onload = () => {
  // Paso 4: Inicializacion
  FB.init({
    appId: appId,
    cookie: true,
    xfbml: false,
    version: "v22.0"
  });
};
document.body.appendChild(script);
```

#### Paso 4: Inicializacion del SDK

`FB.init()` configura el SDK con el App ID y la version de la Graph API a usar.

#### Paso 5: Login con permisos

```javascript
FB.login((response) => {
  if (response.authResponse) {
    const { accessToken } = response.authResponse;
    // Paso 7: enviar token al backend
    connectToBackend(accessToken);
  }
}, {
  scope: "pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish",
  config_id: configId || undefined  // Opcional: Facebook Login Configuration
});
```

#### Paso 6: Popup de Meta

Se abre una ventana emergente de Meta donde el usuario:
- Inicia sesion (si no lo estaba)
- Ve la lista de permisos solicitados
- Selecciona las paginas a las que dar acceso
- Hace clic en "Continuar" para aceptar

#### Paso 7: Frontend envia token al backend

```javascript
const result = await fetch("/api/meta/connect", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ accessToken })
});
```

#### Paso 8: Backend intercambia tokens

```
Short-lived token (1-2 horas)
  |
  +--> GET https://graph.facebook.com/v22.0/oauth/access_token
  |      ?grant_type=fb_exchange_token
  |      &client_id={APP_ID}
  |      &client_secret={APP_SECRET}
  |      &fb_exchange_token={SHORT_LIVED_TOKEN}
  |
  v
Long-lived token (60 dias)
```

#### Paso 9: Backend verifica permisos

```
GET https://graph.facebook.com/v22.0/me/permissions
  ?access_token={LONG_LIVED_TOKEN}
```

Verifica que el usuario haya concedido todos los permisos necesarios.

#### Paso 10: Backend descubre assets

```
GET https://graph.facebook.com/v22.0/me/accounts
  ?fields=id,name,access_token,category,instagram_business_account{id,username,profile_picture_url}
  &access_token={LONG_LIVED_TOKEN}
```

Retorna todas las Facebook Pages del usuario y las cuentas de Instagram Business vinculadas.

#### Paso 11: Backend guarda todo encriptado

Para cada Page descubierta:
```typescript
// Guardar token de la pagina encriptado
saveCredential(`META_PAGE_TOKEN_${pageId}`, encrypt(pageAccessToken), "meta");

// Guardar asset en business_assets
saveBusinessAsset({
  asset_type: "facebook_page",
  external_id: pageId,
  name: pageName,
  metadata: { access_token_name: `META_PAGE_TOKEN_${pageId}`, category }
});
```

Para cada cuenta de Instagram:
```typescript
saveBusinessAsset({
  asset_type: "instagram_account",
  external_id: igAccountId,
  name: igUsername,
  metadata: { username, profile_picture_url, page_id: parentPageId, page_token_name }
});
```

#### Paso 12: Backend responde al frontend

```json
{
  "success": true,
  "connected": true,
  "expiresIn": 5184000,
  "permissions": ["pages_manage_posts", "pages_read_engagement", "instagram_basic", "instagram_content_publish"],
  "assets": [...]
}
```

**Importante:** La respuesta NUNCA incluye tokens. Los tokens solo existen encriptados en la DB.

#### Paso 13: Frontend actualiza la UI

El frontend recibe la lista de assets y actualiza la interfaz mostrando las paginas e IG accounts conectadas.

### Renovacion de tokens

- Los long-lived tokens de Meta duran **60 dias**
- El backend calcula `daysUntilExpiry` en `GET /api/meta/status`
- El frontend muestra un **warning visual** cuando quedan menos de 10 dias
- Para renovar, el usuario debe repetir el flujo de conexion (clic en "Conectar con Meta")
- No hay renovacion automatica (requiere interaccion del usuario)

### Desconexion

`POST /api/meta/disconnect` ejecuta:

1. Elimina todas las credenciales de categoria "meta" de la tabla `credentials`
2. Desactiva todos los assets en `business_assets` (is_active = 0)
3. Retorna confirmacion

### Permisos necesarios y su uso

| Permiso | Por que se necesita |
|---------|---------------------|
| `pages_manage_posts` | Publicar fotos y posts en las Facebook Pages del usuario |
| `pages_read_engagement` | Leer informacion basica de las paginas (nombre, ID, categoria) |
| `instagram_basic` | Acceder a las cuentas de Instagram Business vinculadas a las Pages |
| `instagram_content_publish` | Publicar fotos y contenido en las cuentas de Instagram |

### Publicacion en Instagram - Flujo de 2 pasos

Instagram no acepta upload directo de imagenes como Facebook. El flujo requiere una URL publica de la imagen:

```
1. Subir imagen a Google Drive → obtener URL publica
   |
2. POST /v22.0/{ig_account_id}/media
   { image_url: URL_PUBLICA, caption: texto }
   → Retorna { id: container_id }
   |
3. (Polling) GET /v22.0/{container_id}?fields=status_code
   → Esperar hasta status_code === "FINISHED"
   |
4. POST /v22.0/{ig_account_id}/media_publish
   { creation_id: container_id }
   → Retorna { id: media_id }
```

**Por que se necesita Google Drive:** Instagram requiere que la imagen este disponible en una URL publica accesible desde sus servidores. Google Drive provee esta URL a traves de `webContentLink` con permisos de lectura publica.

---

## 9. Variables de Entorno - Guia Completa

Todas las variables se configuran en el archivo `.env` en la raiz del proyecto.

### Tabla completa

| Variable | Obligatoria | Servicio que la usa | Descripcion | Ejemplo |
|----------|:-----------:|---------------------|-------------|---------|
| `ENCRYPTION_KEY` | **SI** | `encryptionService.ts` | Clave para encriptacion AES-256-GCM. Se hashea con SHA-256 para obtener 32 bytes. Generar con: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | `a1b2c3d4e5f6...` (64 caracteres hex) |
| `DEEPSEEK_API_KEY` | **SI** (o GEMINI) | `aiService.ts` | API key de DeepSeek ([deepseek.com](https://deepseek.com)). Proveedor primario de IA para analisis de texto. | `sk-...` |
| `GEMINI_API_KEY` | **SI** (o DEEPSEEK) | `aiService.ts`, `searchService.ts`, `pipelineService.ts` | API key de Google AI Studio ([aistudio.google.com](https://aistudio.google.com)). Se usa como fallback de texto, para Gemini Grounded Search, y para generacion de imagenes con Nano Banana 2 (gemini-3.1-flash-image-preview). | `AIza...` |
| `XAI_API_KEY` | No | `pipelineService.ts` | API key de xAI ([console.x.ai](https://console.x.ai)). Para generar imagenes con Grok como alternativa a Nano Banana 2. | `xai-...` |
| `TWITTER_APP_KEY` | No | `twitterService.ts` | App Key del Twitter/X Developer Portal. Necesaria para publicar en Twitter. | Alfanumerico |
| `TWITTER_APP_SECRET` | No | `twitterService.ts` | App Secret de Twitter/X. | Alfanumerico |
| `TWITTER_ACCESS_TOKEN` | No | `twitterService.ts` | Access Token de OAuth 1.0a (cuenta especifica). | Alfanumerico |
| `TWITTER_ACCESS_SECRET` | No | `twitterService.ts` | Access Token Secret de OAuth 1.0a. | Alfanumerico |
| `GOOGLE_CLIENT_EMAIL` | No | `generate.ts`, `pipelineService.ts` | Email del Service Account de Google Cloud para acceso a Drive. | `xxx@project.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | No | `generate.ts`, `pipelineService.ts` | Private key del Service Account. Incluir comillas y usar `\n` para saltos de linea. | `"-----BEGIN PRIVATE KEY-----\nMIIE..."` |
| `GOOGLE_FOLDER_ID` | No | `generate.ts`, `pipelineService.ts` | ID de la carpeta de Google Drive donde subir las imagenes. Obtenerlo de la URL de la carpeta. | `14czRVH40sk...` |
| `GOOGLE_SEARCH_API_KEY` | No | `searchService.ts` | API key para Google Custom Search (fallback de busqueda web). | `AIza...` |
| `GOOGLE_SEARCH_CX` | No | `searchService.ts` | Custom Search Engine ID. Crear en [programmablesearchengine.google.com](https://programmablesearchengine.google.com). | `017...` |
| `META_APP_ID` | No | `meta.ts`, `metaAuthService.ts` | App ID de Meta Developers ([developers.facebook.com](https://developers.facebook.com)). Necesario para el flujo OAuth. | `123456789012345` |
| `META_APP_SECRET` | No | `metaAuthService.ts` | App Secret de Meta Developers. Nunca exponer en frontend. | `abc123def456...` |
| `META_CONFIG_ID` | No | `meta.ts` | Config ID de Facebook Login for Business (opcional, para Login Configuration). | `123456789` |
| `WEBHOOK_URL_PIPELINE` | No | `pipelineService.ts`, `settings.ts` | URL del webhook para el pipeline autonomo (Make.com / N8N). | `https://hook.us1.make.com/...` |
| `WEBHOOK_URL_NUEVO_BOTON` | No | `settings.ts`, `generate.ts` | URL del webhook para el boton "Nuevo" de la interfaz manual. | `https://hook.us1.make.com/...` |
| `WEBHOOK_URL_VIEJO_BOTON` | No | `settings.ts`, `generate.ts` | URL del webhook para el boton "Viejo" de la interfaz manual. | `https://hook.us1.make.com/...` |
| `WEBHOOK_URL_TERCER_BOTON` | No | `settings.ts` | URL del webhook para el tercer boton. | `https://hook.us1.make.com/...` |
| `PLATFORM_NAME` | No | `imageService`, `newsService` | Nombre de la plataforma. Se muestra en las placas y se usa en los system prompts de IA. | `Radio Uno Formosa` |
| `TOOLS_DIR` | No | `transcriptionService` | Directorio donde están ffmpeg, yt-dlp. Default: `~/tools/` | `C:\Users\Asus\tools` |

### Notas importantes

- **`COHERE_API_KEY`**: Esta variable es **legacy** y **ya no se usa**. Fue reemplazada por DeepSeek/Gemini. Puede ser eliminada del `.env` si existe.

- **Webhooks desde el frontend**: Las URLs de webhooks tambien se pueden configurar desde la seccion "Configuracion de Webhooks" del frontend. Los valores guardados desde el frontend se persisten en la tabla `settings` de la base de datos y **tienen prioridad** sobre los valores del `.env`. El orden de prioridad es: DB > `.env` > vacio.

- **Minimo para funcionar**: Para una configuracion minima funcional se necesitan `ENCRYPTION_KEY` y al menos una API key de IA (`DEEPSEEK_API_KEY` o `GEMINI_API_KEY`). El resto de servicios (Twitter, Meta, Drive, etc.) son opcionales y se habilitan individualmente al configurar sus credenciales.

### Archivo `.env` de ejemplo

```env
# === OBLIGATORIAS ===
ENCRYPTION_KEY=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2

# === IA (al menos una) ===
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# === Imagenes IA (opcional) ===
XAI_API_KEY=xai-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# === Twitter (opcional) ===
TWITTER_APP_KEY=xxxxx
TWITTER_APP_SECRET=xxxxx
TWITTER_ACCESS_TOKEN=xxxxx
TWITTER_ACCESS_SECRET=xxxxx

# === Google Drive (opcional) ===
GOOGLE_CLIENT_EMAIL=periodistapp@proyecto.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIB..."
GOOGLE_FOLDER_ID=14czRVH40skXXXXXXXXXXXXXXXXXXX

# === Google Custom Search (opcional, fallback) ===
GOOGLE_SEARCH_API_KEY=AIzaSyXXXXXXXXX
GOOGLE_SEARCH_CX=017XXXXXXXXXX

# === Meta / Facebook / Instagram (opcional) ===
META_APP_ID=123456789012345
META_APP_SECRET=abc123def456ghi789
META_CONFIG_ID=987654321

# === Plataforma ===
PLATFORM_NAME=Radio Uno Formosa
TOOLS_DIR=C:\Users\Asus\tools

# === Webhooks (opcional, tambien configurables desde el frontend) ===
WEBHOOK_URL_PIPELINE=https://hook.us1.make.com/xxxxx
WEBHOOK_URL_NUEVO_BOTON=https://hook.us1.make.com/xxxxx
WEBHOOK_URL_VIEJO_BOTON=https://hook.us1.make.com/xxxxx
WEBHOOK_URL_TERCER_BOTON=https://hook.us1.make.com/xxxxx
```

---

## 10. Rate Limiting

PeriodistApp implementa rate limiting con el patron **Token Bucket** para todas las APIs externas. Esto evita exceder los limites de las APIs y recibir errores 429 (Too Many Requests).

### Implementacion (`rateLimiter.ts`)

La clase `RateLimiter` funciona asi:

1. Cada servicio tiene un "bucket" con una capacidad maxima de tokens (`maxTokens`)
2. Cada request consume 1 token del bucket
3. Los tokens se recargan automaticamente a una tasa fija (`refillRate` tokens cada `refillIntervalMs` milisegundos)
4. Si no hay tokens disponibles, la request espera (queue) hasta que se recargue uno
5. El metodo `tryAcquire()` permite intentar sin esperar (retorna `false` si no hay tokens)

```typescript
// Uso tipico en un servicio:
await limiters.deepseek.acquire();  // Espera si no hay tokens
const response = await callDeepSeekAPI(prompt);

// Uso sin bloqueo:
if (limiters.twitter.tryAcquire()) {
  await postTweet(content);
} else {
  console.log("Rate limit alcanzado, reintentando despues...");
}
```

### Tabla de limiters configurados

| Servicio | `maxTokens` | `refillRate` | `refillIntervalMs` | Tasa efectiva | Donde se aplica |
|----------|:-----------:|:------------:|:-------------------:|:-------------:|-----------------|
| `deepseek` | 10 | 1 | 6000 ms (6s) | ~10 req/min | `aiService.ts` - todas las llamadas a DeepSeek |
| `gemini` | 15 | 1 | 4000 ms (4s) | ~15 req/min | `aiService.ts` - llamadas a Gemini, `searchService.ts` - Gemini Grounded Search |
| `metaApi` | 5 | 1 | 12000 ms (12s) | ~5 req/min | `metaAuthService.ts` - operaciones OAuth, `metaPublishService.ts` - publicaciones |
| `twitter` | 3 | 1 | 60000 ms (60s) | ~3 req/min | `twitterService.ts` - publicacion de tweets |
| `googleDrive` | 10 | 1 | 6000 ms (6s) | ~10 req/min | `pipelineService.ts` - subida de imagenes a Drive |
| `imageGen` | 3 | 1 | 20000 ms (20s) | ~3 req/min | `pipelineService.ts` - generacion con Nano Banana 2 y Grok |
| `webSearch` | 10 | 1 | 6000 ms (6s) | ~10 req/min | `searchService.ts` - Google Custom Search y DuckDuckGo |

### Comportamiento del token bucket

```
Ejemplo: limiter de Twitter (maxTokens: 3, refill: 1 cada 60s)

t=0s:   [■ ■ ■]  3 tokens disponibles
t=0s:   Tweet #1 → consume 1 token → [■ ■ _]
t=0s:   Tweet #2 → consume 1 token → [■ _ _]
t=0s:   Tweet #3 → consume 1 token → [_ _ _]
t=0s:   Tweet #4 → SIN TOKENS → entra en cola, espera...
t=60s:  Se recarga 1 token → [■ _ _] → Tweet #4 se ejecuta → [_ _ _]
t=120s: Se recarga 1 token → [■ _ _]
```

El bucket arranca lleno (`maxTokens`), lo que permite una "rafaga" inicial. Despues se estabiliza en la tasa de refill.

---

## 11. Deteccion de Duplicados

El sistema de deduplicacion opera en dos niveles para evitar publicar la misma noticia dos veces.

### Nivel 1: Sesion (in-memory)

Array `publishedTopics[]` en la instancia de `AutoPipeline`:

```typescript
// En pipelineService.ts
private publishedTopics: string[];  // Se reinicia cuando el pipeline se detiene

// Antes de publicar un tema:
if (isTopicInSession(topic, this.publishedTopics)) {
  this.emit("detail", { message: "Tema ya publicado en esta sesion. Saltando." });
  return;  // No publicar
}
```

### Nivel 2: Base de datos (persistente)

Compara contra publicaciones de las ultimas 24 horas en la tabla `publications`:

```typescript
// En deduplicationService.ts
const result = isDuplicateTopic(topic, summary, hoursBack=24, threshold=0.5);
if (result.isDuplicate) {
  // No publicar - ya existe una publicacion similar
}
```

### Algoritmo de comparacion

#### 1. Normalizacion

```typescript
function normalize(s: string): string {
  return s
    .toLowerCase()                          // Minusculas
    .normalize("NFD")                       // Descomponer acentos
    .replace(/[\u0300-\u036f]/g, "")       // Remover marcas diacriticas
    .replace(/[^a-z0-9\s]/g, "")           // Solo alfanumericos y espacios
    .trim();
}
// "Inflacion de Alimentos" → "inflacion de alimentos"
// "Ruta N° 11" → "ruta n 11"
```

#### 2. Extraccion de palabras significativas

Solo se consideran palabras de mas de 3 caracteres:

```typescript
function significantWords(text: string): string[] {
  return normalize(text).split(/\s+/).filter(w => w.length > 3);
}
// "La inflacion de alimentos sube" → ["inflacion", "alimentos", "sube"]
```

#### 3. Calculo de overlap

```typescript
function wordOverlap(wordsA: string[], wordsB: string[]): number {
  const setB = new Set(wordsB);
  const overlap = wordsA.filter(w => setB.has(w)).length;
  return overlap / Math.min(wordsA.length, wordsB.length);
}
// wordsA: ["inflacion", "alimentos", "sube"]
// wordsB: ["inflacion", "alimentos", "precios"]
// overlap: 2 / min(3, 3) = 0.67 → DUPLICADO (>= 0.5)
```

#### 4. Comparaciones realizadas

Para cada publicacion reciente de la DB:

1. **Titulo vs titulo:** `wordOverlap(topicWords, pubTitleWords)` con peso 1.0
2. **Contenido combinado vs contenido:** `wordOverlap(combinedWords, pubContentWords)` con peso 0.8
3. **Substring directo:** Si el tema normalizado contiene al titulo normalizado (o viceversa), y ambos tienen mas de 5 caracteres, es duplicado con similitud 1.0

Se toma la similitud mas alta de las tres comparaciones.

#### 5. Umbral

- **Threshold por defecto:** `0.50` (50% de overlap en palabras)
- Si la similitud >= 0.50: es duplicado
- Si la similitud < 0.50: no es duplicado

### Verificacion en sesion (`isTopicInSession`)

Complementa la verificacion contra la DB. Usa las mismas funciones de normalizacion y overlap:

1. Comparacion exacta (normalizada)
2. Substring (normalizado)
3. Word overlap >= 0.50

### Cuando se detecta un duplicado

El pipeline emite un evento `detail` informando que el tema fue saltado:

```typescript
this.emit("detail", {
  step: "analyzing",
  sub: "duplicate",
  message: `Tema "${topic}" ya fue publicado (similitud: ${similarity}). Saltando.`,
  icon: "warning"
});
```

---

## 12. Como Ejecutar el Proyecto

### Requisitos del sistema

#### Dependencias de sistema

| Herramienta | Proposito | Instalacion (Windows) |
|-------------|-----------|----------------------|
| **Node.js** (>= 18) | Runtime del backend y build del frontend | `winget install OpenJS.NodeJS.LTS` |
| **Python** (>= 3.10) | Ejecutar Whisper para transcripcion | `winget install Python.Python.3.12` |
| **ffmpeg** | Procesamiento y conversion de audio | `winget install Gyan.FFmpeg` |
| **yt-dlp** | Descarga de streams de YouTube/radio | `winget install yt-dlp.yt-dlp` |
| **Whisper** | Transcripcion speech-to-text | `pip install openai-whisper` |

**Notas de auto-detección:**
- `py` (Python launcher) es auto-detectado en Windows cuando `python` no está en PATH
- `ffmpeg` y `yt-dlp` son auto-detectados desde el directorio `~/tools/` (configurable con `TOOLS_DIR`)
- En la primera ejecución, Whisper descarga el modelo (~139MB). Esto es normal y tarda aproximadamente 30 segundos.

#### Verificar instalacion

```bash
node --version       # >= 18.x
python --version     # >= 3.10 (o `py --version` en Windows)
ffmpeg -version      # cualquier version reciente (puede estar en ~/tools/)
yt-dlp --version     # cualquier version reciente (puede estar en ~/tools/)
whisper --help       # debe estar en PATH
```

### Instalacion

```bash
# Clonar el repositorio
git clone <url-del-repo>
cd periodistapp

# Instalar dependencias de Node
npm install

# Crear archivo de configuracion
cp .env.example .env
# Editar .env con tus API keys (ver seccion 9)

# Generar ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copiar el resultado al .env
```

### Desarrollo

```bash
# Iniciar backend + frontend en paralelo
npm run dev
```

Esto ejecuta:
- **Backend** (Express + Socket.IO) en `http://localhost:3001`
- **Frontend** (Vite dev server) en `http://localhost:5173`

Vite esta configurado para hacer **proxy automatico** de las rutas `/api/*` y `/socket.io` al backend en puerto 3001, asi que solo necesitas abrir `http://localhost:5173` en el navegador.

### Produccion

```bash
# 1. Compilar el frontend
npm run build:client

# 2. Iniciar el servidor
npm start
# El servidor sirve el frontend compilado desde dist/client/
# Abrir http://localhost:3001
```

En produccion, Express sirve:
- Los archivos estaticos del build de Vite desde `dist/client/`
- Los assets publicos desde `public/`
- Las imagenes generadas desde `output/`

### Estructura de directorios auto-creados

Al ejecutar por primera vez, el servidor crea automaticamente:

```
output/              # Imagenes generadas (placas/flyers)
uploads/             # Archivos subidos temporalmente
data/                # Base de datos SQLite
  └── credentials.db # Base de datos principal
```

### Limpieza automatica al iniciar

Al arrancar, el servidor:
1. Elimina todos los archivos `.mp3` del directorio `output/` (restos de capturas anteriores)
2. Reinicia el archivo `output/transcripciones.json`

---

## 13. Encriptacion

PeriodistApp usa **AES-256-GCM** para encriptar todas las credenciales sensibles (tokens de Meta, etc.) antes de guardarlas en la base de datos SQLite.

### Algoritmo: AES-256-GCM

- **AES-256:** Advanced Encryption Standard con clave de 256 bits
- **GCM:** Galois/Counter Mode - proporciona tanto confidencialidad como autenticacion (AEAD)
- **Ventaja sobre CBC:** GCM incluye autenticacion integrada (AuthTag), lo que detecta cualquier manipulacion del ciphertext

### Derivacion de clave

```typescript
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;     // 16 bytes = 128 bits
const AUTH_TAG_LENGTH = 16; // 16 bytes = 128 bits

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY no configurada en .env");
  // SHA-256 del string del .env → siempre produce 32 bytes (256 bits)
  return crypto.createHash("sha256").update(key).digest();
}
```

La clave del `.env` puede ser cualquier string, pero se recomienda usar 64 caracteres hexadecimales (32 bytes). Independientemente del largo del input, SHA-256 siempre produce una clave de 32 bytes, que es exactamente lo que necesita AES-256.

### Proceso de encriptacion

```typescript
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();                    // 32 bytes (SHA-256 de ENCRYPTION_KEY)
  const iv = crypto.randomBytes(IV_LENGTH);          // 16 bytes aleatorios unicos
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex"); // 16 bytes de autenticacion

  // Formato: iv:authTag:ciphertext (todo en hexadecimal)
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}
```

**Cada encriptacion genera un IV unico aleatorio**, lo que significa que encriptar el mismo texto dos veces produce resultados diferentes. Esto es fundamental para la seguridad.

### Proceso de desencriptacion

```typescript
export function decrypt(encryptedValue: string): string {
  const key = getEncryptionKey();
  const parts = encryptedValue.split(":");      // [iv, authTag, ciphertext]

  if (parts.length !== 3) throw new Error("Formato invalido");

  const iv = Buffer.from(parts[0], "hex");       // Recuperar IV
  const authTag = Buffer.from(parts[1], "hex");   // Recuperar AuthTag
  const encrypted = parts[2];                      // Ciphertext en hex

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);                    // Verificar autenticidad

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");             // Si authTag no coincide, lanza error

  return decrypted;
}
```

### Formato de almacenamiento

```
iv:authTag:ciphertext
│    │        │
│    │        └── Datos encriptados (hex, largo variable)
│    └── Tag de autenticacion (32 caracteres hex = 16 bytes)
└── Vector de inicializacion (32 caracteres hex = 16 bytes)
```

**Ejemplo real:**
```
a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:f0e1d2c3b4a59687f0e1d2c3b4a59687:7890abcdef1234567890abcdef
```

### Seguridad importante

- **Si se pierde la `ENCRYPTION_KEY`, TODAS las credenciales almacenadas son irrecuperables.** No hay forma de desencriptar sin la clave original.
- **Nunca versionar** el archivo `.env` con la `ENCRYPTION_KEY`.
- **Hacer backup** de la `ENCRYPTION_KEY` en un lugar seguro (gestor de passwords, etc.).
- **Si se cambia la `ENCRYPTION_KEY`**, todas las credenciales existentes se vuelven ilegibles. Se deben reconectar todos los servicios (Meta, etc.).
- El **AuthTag** protege contra manipulacion: si alguien modifica el ciphertext en la DB, la desencriptacion falla con error en lugar de producir datos corruptos.

---

## 14. Changelog - Fixes y mejoras aplicados

### Problemas encontrados en testing y sus soluciones

| Problema | Causa raíz | Solución |
|----------|-----------|----------|
| `python` no reconocido en Windows | Windows usa `py` como launcher, no `python` | Auto-detección: prueba `py --version`, fallback a `python` |
| ffmpeg/yt-dlp no encontrados | No estaban en el PATH del sistema | Auto-búsqueda en `~/tools/` antes de buscar en PATH |
| Whisper no encontraba ffmpeg | Whisper usa ffmpeg internamente via subprocess | Se inyecta `TOOLS_DIR` en el PATH del subproceso de Python |
| yt-dlp error "No JS runtime" | yt-dlp 2026 necesita un JS runtime para YouTube | Se agrega `--js-runtimes node` al comando de yt-dlp |
| yt-dlp error "bestaudio not available" | Formato `bestaudio` no disponible sin JS runtime completo | Cambio a `-f "ba/b"` (best audio con fallback) + descarga directa sin pipe |
| Imágenes generadas no encontradas (ENOENT) | Rutas de output relativas a `src/server/` en vez de la raíz del proyecto | Todas las rutas ahora usan `PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..")` |
| Base de datos creada en `src/server/data/` | Misma causa que lo anterior | `DB_PATH` ahora usa `PROJECT_ROOT/data/` |
| Gemini 2.0 Flash deprecado | Google deprecó el modelo | Actualizado a `gemini-2.5-flash` |
| Pipeline se detenía durante análisis | `analyzeAndPublish()` bloqueaba el loop de captura | Cambiado a fire-and-forget con `.catch()`, re-análisis automático al terminar |
| Componentes React huérfanos | 9 archivos en `components/` no se usaban (todo estaba inline en App.tsx) | Eliminados los 9 archivos huérfanos |
| `publish_warnings` no se manejaba en UI | Faltaba el case en el switch de eventos | Agregado handler que muestra warnings en activity cards |
| Meta OAuth usaba ruta inexistente | `window.open('/api/meta/auth')` no existía como endpoint | Implementado flujo completo con FB SDK: FB.init() + FB.login() popup |
| Double response en stop-capture | Tanto `close` como `error` events podían enviar respuesta | Flag `responseSent` para evitar enviar dos respuestas |
| Prompts hardcodeados para Formosa | System prompts mencionaban "Radio Uno Formosa" exclusivamente | Todos los prompts usan `PLATFORM_NAME` env var, agnósticos |
| Modelo de imágenes desactualizado | Usaba `imagen-4.0-generate-001` (no existe) y luego `gemini-2.0-flash-exp` | Actualizado a `gemini-3.1-flash-image-preview` (Nano Banana 2) |
| Solo buscaba fotos de personas | `searchPersonImage` limitado a rostros | Renombrado a `searchReferenceImage`: busca personas, logos, eventos, lugares |
| Sin rate limiting | APIs podían recibir spam de requests | Token bucket por servicio: DeepSeek (10/min), Gemini (15/min), Meta (5/min), Twitter (3/min), etc. |
| Sin detección de duplicados | Mismo tema podía publicarse dos veces | Verificación doble: sesión (in-memory) + DB (últimas 24h) con word overlap >= 50% |
| Sin graceful shutdown | Procesos quedaban colgados al cerrar | Handler SIGTERM/SIGINT que detiene pipeline, mata procesos y cierra servidor |
| package.json incompleto | Faltaban dependencias (axios, canvas, sharp, cheerio, etc.) | Agregadas todas las dependencias reales del proyecto |
| Twitter crasheaba sin credenciales | Se creaba el client aunque no hubiera API keys | Guard: solo crea client si las 4 credenciales existen |
| canvas nativo no compilaba en Windows | El paquete `canvas` requiere compilación C++ | Reemplazado por `@napi-rs/canvas` (precompilado, sin dependencias nativas) |

---

## Apendice: Glosario

| Termino | Significado |
|---------|-------------|
| **Placa / Flyer** | Imagen de 1080x1080 px con titulo superpuesto, usada para publicar en redes sociales |
| **Chunk** | Segmento de audio capturado (default 120 segundos) |
| **Pipeline** | El proceso completo autonomo: captura -> transcripcion -> analisis -> publicacion |
| **Topic Segment** | Un tema noticioso identificado por la IA en la transcripcion |
| **Overlay** | Capa de texto superpuesta sobre la imagen de fondo de la placa |
| **Token Bucket** | Algoritmo de rate limiting basado en tokens que se consumen y recargan |
| **WAL Mode** | Write-Ahead Logging - modo de SQLite que mejora concurrencia de escritura |
| **AEAD** | Authenticated Encryption with Associated Data - encriptacion que verifica integridad |
| **Long-lived token** | Token de Meta con duracion de 60 dias (vs. short-lived de 1-2 horas) |
| **Grounded Search** | Busqueda web de Gemini que incluye fuentes verificables en la respuesta |
