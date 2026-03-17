# Documentación Técnica del Proyecto "PeriodistApp v6.0"

## 📋 Tabla de Contenidos

1. [Descripción General](#descripción-general)
2. [Arquitectura del Sistema](#arquitectura-del-sistema)
3. [Estructura de Archivos](#estructura-de-archivos)
4. [Frontend](#frontend)
5. [Backend](#backend)
6. [API Endpoints](#api-endpoints)
7. [Servicios y Lógica de Negocio](#servicios-y-lógica-de-negocio)
8. [WebSockets (Socket.IO)](#websockets-socketio)
9. [Integraciones Externas](#integraciones-externas)
10. [Configuración y Variables de Entorno](#configuración-y-variables-de-entorno)
11. [Flujos de Trabajo Principales](#flujos-de-trabajo-principales)
12. [Requerimientos y Dependencias](#requerimientos-y-dependencias)

---

## 📝 Descripción General

**PeriodistApp v6.0** es una aplicación web integral diseñada para **Radio Uno Formosa** que automatiza la creación de contenido periodístico. La aplicación combina múltiples tecnologías para:

- 🎨 **Generación de placas**: Crear imágenes con título y branding a partir de imágenes o URLs de noticias
- 🎙️ **Captura y transcripción de audio**: Grabar transmisiones de radio y convertirlas a texto en tiempo real
- 📰 **Generación de noticias**: Crear notas periodísticas a partir de transcripciones usando IA
- 📱 **Publicación automática**: Enviar contenido a múltiples plataformas (Facebook, Instagram, Twitter) mediante webhooks

---

## 🏗️ Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────────────────┐
│                      CLIENTE (Frontend)                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   public/index.html                      │    │
│  │                   public/app.js                          │    │
│  │                   public/styles.css                       │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SERVIDOR (Backend)                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   server.js                             │    │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐    │    │
│  │  │ Express.js  │ │ Socket.IO   │ │ Multer          │    │    │
│  │  └─────────────┘ └─────────────┘ └─────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│    SERVICIOS      │ │   SCRIPTS PYTHON  │ │    APIS EXTERNAS  │
│  ┌─────────────┐  │ │  ┌─────────────┐  │ │  ┌─────────────┐ │
│  │imageService │  │ │  │audio_capture│  │ │  │ Google Drive│ │
│  │twitterSvc   │  │ │  │.py          │  │ │  │ Twitter     │ │
│  └─────────────┘  │ │  └─────────────┘  │ │  │ Cohere AI   │ │
│                   │ │                   │ │  │ Make/N8N    │ │
└───────────────────┘ └───────────────────┘ └────────────────┘
```

---

## 📁 Estructura de Archivos

```
appv6.0/
├── public/                      # Frontend estático
│   ├── index.html             # Página principal
│   ├── app.js                  # Lógica del cliente
│   ├── styles.css              # Estilos CSS
│   └── logo.png                # Logo de Radio Uno
│
├── scripts/                    # Scripts de servidor y utilidades
│   ├── audio_capture.py        # Captura y transcripción de audio (Whisper)
│   ├── cohere_Service.js       # Generación de texto con IA (Cohere)
│   └── scraper_service.js      # Web scraping de artículos
│
├── service/                    # Servicios del backend
│   ├── imageService.js         # Procesamiento y generación de placas
│   └── twitter_service.js      # Integración con Twitter API
│
├── uploads/                    # Archivos subidos temporalmente
├── output/                    # Archivos generados (audio, imágenes, transcripciones)
├── whisper_env/               # Entorno virtual Python (PyTorch/Whisper)
├── server.js                  # Servidor principal (Express + Socket.IO)
└── .gitignore                 # Archivos ignorados por Git
```

---

## 💻 Frontend

### [`public/index.html`](public/index.html:1-82)

**Página principal** que contiene:

#### Secciones Principales:

1. **Formulario de Generación de Placas desde Imagen**

   - `imageInput`: Selector de archivo de imagen
   - `titleInput`: Campo de título
   - `descriptionInput`: Área de texto para descripción
   - Botón "Generar post"
   - Área de resultado con imagen, enlace de descarga y botón de webhook

2. **Formulario de Generación de Placas desde URL**

   - `urlInput`: Campo para URL de noticia
   - Botón "Crear Nota"
   - Área de resultado similar

3. **Captura y Transcripción de Audio**
   - Botón "Iniciar Captura" (`startCaptureBtn`)
   - Botón "Detener Captura" (`stopCaptureBtn`)
   - Área de texto de transcripción (`transcriptionArea`) - solo lectura
   - Botón "Generar Noticia" (oculto inicialmente)
   - Contenedor para contexto y generación de copy

#### Bibliotecas Cargadas:

- Socket.IO (cliente WebSocket)
- `app.js` (lógica personalizada)

---

### [`public/app.js`](public/app.js:1-323)

**Lógica del cliente** que maneja todas las interacciones:

#### Funcionalidades Principales:

##### 1. Generación de Placas desde Imagen (`imageForm`)

```javascript
// Endpoint: POST /generate
// Envía: FormData con image, title, description
// Recibe: imageUrl, finalImagePath
```

##### 2. Webhook para Imagen (`sendWebhookBtn`)

```javascript
// Endpoint: POST /sendWebhook
// Envía: { title, description, imageUrl, finalImagePath }
// Acción: Publica en Facebook/Instagram + Twitter
```

##### 3. Generación de Placas desde URL (`urlForm`)

```javascript
// Endpoint: POST /generate-from-url
// Envía: { url }
// Recibe: imageUrl, title, content, finalImagePath
```

##### 4. Webhook para URL (`sendWebhookBtnNuevoBoton`)

```javascript
// Endpoint: POST /sendWebhookNuevoBoton
// Envía: { title, content, imageUrl, finalImagePath }
// Acción: Publica en Facebook/Instagram + Twitter
```

##### 5. Captura de Audio

```javascript
// Iniciar: POST /start-capture
// Detener: POST /stop-capture
// Obtener transcripciones: GET /get-transcriptions
```

##### 6. Generación de Notas Periodísticas

```javascript
// Endpoint: POST /generateNewsCopy
// Envía: { context, transcription }
// Recibe: { generatedCopy }
```

#### Socket.IO (WebSocket)

```javascript
// Escucha: 'receive-transcription-update'
// Recibe: { timestamp, text } - Actualización en tiempo real
```

---

### [`public/styles.css`](public/styles.css:1-57)

**Estilos CSS** con:

- Contenedor principal centrado (max-width: 600px)
- Formularios con diseño flex-column
- Botones con estilo verde (#4CAF50)
- Imágenes responsive (max-width: 100%)
- Sombras y bordes redondeados para tarjeta de contenido

---

## ⚙️ Backend

### [`server.js`](server.js:1-451)

**Servidor principal** construido con Express.js y Socket.IO.

#### Configuración Principal:

```javascript
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const port = 3000;
```

#### Middlewares:

- `express.json()` - Parseo de JSON
- `express.static("public")` - Archivos estáticos
- `/output` - Servidor estático para archivos generados
- `multer` - Manejo de uploads (dest: `uploads/`)

---

## 🔌 API Endpoints

### Endpoints de Generación de Placas

| Método | Endpoint             | Descripción                       | Input                                  | Output                                             |
| ------ | -------------------- | --------------------------------- | -------------------------------------- | -------------------------------------------------- |
| `POST` | `/generate`          | Genera placa desde imagen         | `FormData` (image, title, description) | `{ imageUrl, title, description, finalImagePath }` |
| `POST` | `/generate-from-url` | Genera placa desde URL de noticia | `{ url }`                              | `{ imageUrl, title, content, finalImagePath }`     |

### Endpoints de Webhooks

| Método | Endpoint                 | Descripción                  | Input                                              | Output                 |
| ------ | ------------------------ | ---------------------------- | -------------------------------------------------- | ---------------------- |
| `POST` | `/sendWebhook`           | Envía webhook viejo (imagen) | `{ title, description, imageUrl, finalImagePath }` | `{ success, message }` |
| `POST` | `/sendWebhookNuevoBoton` | Envía webhook nuevo (URL)    | `{ title, content, imageUrl, finalImagePath }`     | `{ success, message }` |

### Endpoints de Captura de Audio

| Método | Endpoint              | Descripción                       | Input | Output                      |
| ------ | --------------------- | --------------------------------- | ----- | --------------------------- |
| `POST` | `/start-capture`      | Inicia captura de audio           | -     | `{ success, message }`      |
| `POST` | `/stop-capture`       | Detiene captura de audio          | -     | `{ success, message }`      |
| `GET`  | `/get-transcriptions` | Obtiene todas las transcripciones | -     | `{ transcriptions: [...] }` |

### Endpoints de Generación de Texto

| Método | Endpoint            | Descripción              | Input                        | Output              |
| ------ | ------------------- | ------------------------ | ---------------------------- | ------------------- |
| `POST` | `/generateNewsCopy` | Genera nota periodística | `{ context, transcription }` | `{ generatedCopy }` |

---

## 🧩 Servicios y Lógica de Negocio

### [`service/imageService.js`](service/imageService.js:1-91)

**Procesamiento de imágenes** para crear placas profesionales.

#### Función Principal: `processImage(imagePath, title)`

**Flujo de procesamiento:**

```
1. Redimensionar imagen a 1080x1080 (cuadrado)
2. Crear canvas con dimensiones 1080x1080
3. Aplicar gradiente semi-transparente en la parte inferior
4. Registrar fuente "Bebas Kai" (Windows)
5. Renderizar título:
   - Dividir texto en palabras
   - Calcular líneas según ancho máximo (1080px)
   - Crear fondo oscuro para el texto
   - Centrar y dibujar el título
6. Agregar texto "Radio Uno Formosa" centrado
7. Superponer logo en esquina superior derecha
8. Guardar imagen final como JPEG
9. Eliminar imagen temporal redimensionada
```

**Retorna:** `finalImagePath` - Ruta del archivo de imagen procesada

---

### [`service/twitter_service.js`](service/twitter_service.js:1-114)

**Integración con Twitter API v2** para publicación de tweets.

#### Funciones Exportadas:

| Función                                | Descripción                              |
| -------------------------------------- | ---------------------------------------- |
| `postTweetViejoBoton(title, imageUrl)` | Publica tweet desde formulario de imagen |
| `postTweetNuevoBoton(title, imageUrl)` | Publica tweet desde formulario de URL    |

#### Flujo de Publicación:

```
1. Leer log de tweets publicados (evita duplicados)
2. Descargar imagen desde URL a archivo temporal
3. Subir imagen a Twitter Media Upload
4. Publicar tweet con:
   - Texto: título + enlace Facebook
   - Media: imagen subida
5. Guardar tweet en log de prevención de duplicados
6. Eliminar imagen temporal
```

#### Credenciales de Twitter (Hardcoded - ⚠️ seguridad):

```javascript
appKey: "o2vQ6F56fHa9bmhjYHXenrPda";
appSecret: "f5M0Iwi1AWynKmVJKR3oN926za21hAIDbvo91pGrB1sAG5lQVE";
accessToken: "296285362-GvWx8MMvjaSDbPVvK6EXt6FuuZPzVOtk2WfVnyxt";
accessSecret: "Qxl3rgQWkDh5CwmwK81WfKRiAl6BbthfJ6X4sNn7AYWTd";
```

#### Logs de Twitter:

- `tweets_log_viejo.json` - Tweets del formulario de imagen
- `tweets_log_nuevo.json` - Tweets del formulario de URL

---

### [`scripts/cohere_Service.js`](scripts/cohere_Service.js:1-28)

**Generación de texto con IA** usando Cohere API.

#### Función Principal: `generateNewsCopy(context, transcription)`

```javascript
const response = await cohere.generate({
  prompt: `A partir de la siguiente transcripción: ${transcription} 
           y del contexto: ${context}, 
           genera una nota periodística concisa y atractiva.`,
  model: "command-nightly",
  max_tokens: 500,
  temperature: 0.5,
});
```

**Parámetros:**

- `context`: Contexto adicional de la noticia
- `transcription`: Texto transcrito del audio
- `model`: "command-nightly" (modelo de Cohere)
- `max_tokens`: 500 (largo máximo de respuesta)
- `temperature`: 0.5 (balance entre creatividad y consistencia)

---

### [`scripts/scraper_service.js`](scripts/scraper_service.js:1-31)

**Web scraping** de artículos del diario El Comercial.

#### Función Principal: `scrapeElComercialArticle(url)`

```javascript
// Extrae del HTML:
// - title: h1[itemprop="headline"]
// - content: div.main-text > p (todos los párrafos)
// - imageUrl: figure img (primera imagen)
// - datePublished: meta[itemprop="datePublished"]
```

**Retorna:**

```javascript
{
  title: string,
  content: string,
  imageUrl: string,
  datePublished: string
}
```

---

### [`scripts/audio_capture.py`](scripts/audio_capture.py:1-128)

**Captura y transcripción de audio** usando OpenAI Whisper.

#### Componentes Principales:

##### Configuración:

```python
stream_url = "https://streamingraddios.online/proxy/radiouno?mp=/stream"
fragment_duration = 120  # 2 minutos por fragmento
model = whisper.load_model("base")  # Modelo Whisper "base"
```

##### Funciones:

| Función                                       | Descripción                              |
| --------------------------------------------- | ---------------------------------------- |
| `initialize_json_file()`                      | Crea/reinicia archivo de transcripciones |
| `transcribe_audio(file_path)`                 | Transcribe archivo MP3 a texto           |
| `save_transcription_to_json(file_path, text)` | Guarda transcripción con timestamp       |
| `capture_audio()`                             | Bucle principal de captura               |
| `signal_handler(sig, frame)`                  | Manejo de Ctrl+C                         |

##### Flujo de Captura:

```
1. Generar nombre de archivo con timestamp
2. Ejecutar ffmpeg para capturar 2 minutos de audio
3. Guardar archivo MP3 en /output
4. Ejecutar transcripción en hilo separado (no bloqueante)
5. Repetir hasta recibir señal de parada
```

##### Formato de Salida JSON:

```json
{
  "transcriptions": [
    {
      "timestamp": "2024-01-15T10:30:00",
      "audioFile": "audio_20240115_103000.mp3",
      "text": "Texto transcrito aquí..."
    }
  ]
}
```

---

## 🔄 WebSockets (Socket.IO)

### Eventos del Servidor (`server.js`)

| Evento                         | Descripción                    | Payload                          |
| ------------------------------ | ------------------------------ | -------------------------------- |
| `receive-transcription-update` | Nueva transcripción disponible | `{ timestamp, audioFile, text }` |
| `capture-error`                | Error en captura de audio      | `{ message }`                    |

### Eventos del Cliente (`public/app.js`)

| Evento                                      | Descripción                     |
| ------------------------------------------- | ------------------------------- |
| `io()`                                      | Conexión al servidor WebSocket  |
| `socket.on('receive-transcription-update')` | Escuchar nuevas transcripciones |

---

## 🔗 Integraciones Externas

### Google Drive API

**Uso:** Almacenamiento de imágenes generadas

**Credenciales:** Archivo JSON `spheric-backup-295500-8db588732c5f.json`

**Configuración:**

```javascript
SCOPES = ["https://www.googleapis.com/auth/drive.file"];
FOLDER_ID = "14czRVH40skE-hnv9G4nF1p0iEOm-g0nK";
```

**Flujo:**

1. Subir imagen a Google Drive
2. Obtener URL pública (`webContentLink`)
3. Usar URL en webhooks y Twitter

### Webhooks (Make/N8N)

| Webhook                   | URL                                                                                  | Uso                                    |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| `WEBHOOK_URL_VIEJO_BOTON` | `https://hook.us1.make.com/jw99tn8s32wkw7qhmwsujz2e5mbrmdtf`                         | Publicación desde formulario de imagen |
| `WEBHOOK_URL_NUEVO_BOTON` | `https://n8n-n8n.yn8wow.easypanel.host/webhook/6ac52d95-c9a2-465b-937e-86da54d2decb` | Publicación desde formulario de URL    |

**Payload enviado:**

```javascript
{
  title: string,
  datePublished: ISO8601,
  content: string,
  imageUrl: string,
  linkUrl: string,
  imageDriveUrl: string
}
```

---

## ⚙️ Configuración y Variables de Entorno

### Archivos de Configuración:

| Archivo                                   | Propósito                                             |
| ----------------------------------------- | ----------------------------------------------------- |
| `.gitignore`                              | Excluye: node_modules/, .env, /output                 |
| `spheric-backup-295500-8db588732c5f.json` | Credenciales Google Drive                             |
| `.env`                                    | Variables de entorno (no mostrado, pero referenciado) |

### Variables de Entorno Requeridas:

```bash
COHERE_API_KEY=xxx          # Clave API de Cohere
TWITTER_API_KEY=xxx         # (Hardcoded actualmente)
TWITTER_API_SECRET=xxx      # (Hardcoded actualmente)
# ... otras variables según uso de dotenv
```

### Rutas de Fuentes y Recursos:

| Recurso             | Ruta                                                                |
| ------------------- | ------------------------------------------------------------------- |
| Fuente "Bebas Kai"  | `C:\Users\adria\AppData\Local\Microsoft\Windows\Fonts\BebasKai.ttf` |
| Logo                | `./public/logo.png`                                                 |
| Credenciales GDrive | `./spheric-backup-295500-8db588732c5f.json`                         |

---

## 🔀 Flujos de Trabajo Principales

### Flujo 1: Generar Placa desde Imagen

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Usuario  │────▶│ Frontend │────▶│  /generate│────▶│  Server  │
│          │     │          │     │  (POST)   │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                                      │
                                                      ▼
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Usuario  │◀─────│ Frontend │◀─────│ imageSvc │◀─────┤ GDrive   │
│          │     │          │     │ process  │     │ API      │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                                      │
                                                      ▼
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Usuario  │────▶│  /send   │────▶│ Twitter  │────▶│ Make/    │
│          │     │  webhook │     │  API     │     │ N8N      │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### Flujo 2: Capturar y Transcribir Audio

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Usuario  │────▶│ /start   │────▶│ audio_    │
│          │     │ capture  │     │ capture   │
└──────────┘     └──────────┘     │ .py      │
                                   └────┬─────┘
                                        │
                                        │ ffmpeg + Whisper
                                        ▼
                                   ┌──────────┐
                                   │ output/  │
                                   │ transc-  │
                                   │ riptions │
                                   │ .json    │
                                   └────┬─────┘
                                        │
                                        │ Socket.IO
                                        ▼
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Usuario  │◀─────│ Frontend │◀────│ receive- │
│          │     │          │     │ transc-   │
└──────────┘     └──────────┘     │ iption   │
                                   └──────────┘
```

### Flujo 3: Generar Nota desde Transcripción

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Usuario  │────▶│ Context  │────▶│ /generate│────▶│  Cohere  │
│          │     │ + Trans  │     │  NewsCopy│     │   API    │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                                      │
                                                      ▼
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Usuario  │◀─────│ Frontend │◀────│ response │
│          │     │          │     │          │
└──────────┘     └──────────┘     └──────────┘
```

---

## 📦 Requerimientos y Dependencias

### Dependencias Node.js (`package.json` no visible, inferido):

```javascript
// Principales dependencias:
express; // Servidor web
multer; // Manejo de uploads
canvas; // Procesamiento de imágenes
sharp; // Manipulación de imágenes
uuid; // Generación de IDs únicos
googleapis; // Google APIs
axios; // HTTP client
socket.io; // WebSockets
socket.io - client; // Cliente WebSocket
twitter - api - v2; // Twitter API v2
cohere - ai; // Cohere AI
cheerio; // Web scraping
dotenv; // Variables de entorno
```

### Dependencias Python (`audio_capture.py`):

```python
whisper           # OpenAI Whisper (reconocimiento de voz)
ffmpeg            # Captura de audio ( externo)
```

### Software Requerido:

| Software | Versión | Uso                |
| -------- | ------- | ------------------ |
| Node.js  | 18+     | Entorno JavaScript |
| Python   | 3.8+    | Entorno Whisper    |
| FFmpeg   | Latest  | Captura de audio   |
| Windows  | 10/11   | Sistema operativo  |

---

## 🚨 Notas de Seguridad

⚠️ **Advertencias de seguridad identificadas:**

1. **Credenciales hardcoded** en [`twitter_service.js`](service/twitter_service.js:11-14)

   - Las claves de API están visibles en el código fuente
   - **Solución:** Mover a variables de entorno

2. **Rutas absolutas de Windows** en [`imageService.js`](service/imageService.js:42) y [`server.js`](server.js:149)

   - No portable a otros sistemas operativos
   - **Solución:** Usar rutas relativas o configurables

3. **Credenciales Google Drive** en archivo JSON
   - Acceso a Google Drive con cuenta de servicio
   - Verificar que el archivo no esté en repositorio público

---

## 📊 Resumen de Archivos Clave

| Archivo                                                    | Líneas | Propósito                                |
| ---------------------------------------------------------- | ------ | ---------------------------------------- |
| [`server.js`](server.js)                                   | 451    | Servidor principal, endpoints, WebSocket |
| [`public/app.js`](public/app.js)                           | 323    | Lógica del cliente, fetch API            |
| [`service/imageService.js`](service/imageService.js)       | 91     | Procesamiento de imágenes                |
| [`service/twitter_service.js`](service/twitter_service.js) | 114    | Integración Twitter                      |
| [`scripts/audio_capture.py`](scripts/audio_capture.py)     | 128    | Whisper + FFmpeg                         |
| [`scripts/cohere_Service.js`](scripts/cohere_Service.js)   | 28     | Generación IA                            |
| [`scripts/scraper_service.js`](scripts/scraper_service.js) | 31     | Web scraping                             |
| [`public/index.html`](public/index.html)                   | 82     | Interfaz de usuario                      |
| [`public/styles.css`](public/styles.css)                   | 57     | Estilos                                  |

---

_Documentación generada automáticamente para PeriodistApp v6.0_
_Fecha: 2026-02-09_
