import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { createCanvas, loadImage, registerFont } from "canvas";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();

// Inicializar base de datos SQLite para credenciales encriptadas
initDatabase();

import axios from "axios";
import { exec } from "child_process";
import http from "http";
import { Server } from "socket.io";
import { scrapeElComercialArticle } from "./scripts/scraper_service.js";
import { processImage } from "./service/imageService.js";
import {
  postTweetViejoBoton,
  postTweetNuevoBoton,
} from "./service/twitter_service.js"; // Ajusta la ruta si es necesario
import { generateNewsCopy, TONE_PROMPTS, STRUCTURE_PROMPTS } from "./scripts/cohere_Service.js";
import { AutoPipeline } from "./service/pipelineService.js";
import { initDatabase } from "./service/databaseService.js";
import {
  exchangeToken,
  discoverAssets,
  getConnectionStatus,
  disconnectMeta,
  checkPermissions,
} from "./service/metaAuthService.js";
import { publishToAllMeta } from "./service/metaPublishService.js";

// Configuración para obtener el directorio actual en ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Definir la ruta al archivo de transcripción de forma global
const transcription_file = path.join(
  __dirname,
  "output",
  "transcripciones.json",
);

// Variables para controlar el proceso de captura
let pythonProcess = null; // Para almacenar la referencia al proceso de Python
let isCapturing = false; // Para indicar si se está capturando o no

// Limpiar la carpeta de output (¡con precaución!)
const outputDir = path.join(__dirname, "output");
fs.readdir(outputDir, (err, files) => {
  if (err) {
    console.error("Error al leer el directorio de output:", err);
    return;
  }

  for (const file of files) {
    const filePath = path.join(outputDir, file);
    // Verificar si es un archivo .mp3
    if (path.extname(file) === ".mp3") {
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error("Error al eliminar el archivo:", filePath, err);
        } else {
          console.log("Archivo eliminado:", filePath);
        }
      });
    }
  }
});

// Eliminar el archivo de transcripciones si existe
if (fs.existsSync(transcription_file)) {
  fs.unlinkSync(transcription_file);
  console.log("Archivo de transcripciones eliminado.");
}

// Crear el archivo de transcripciones
const initial_data = { transcriptions: [] };
fs.writeFileSync(
  transcription_file,
  JSON.stringify(initial_data, null, 4),
  "utf-8",
);
console.log("Archivo JSON de transcripciones inicializado.");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const upload = multer({ dest: "uploads/" });
const port = 3000;

app.use(express.json());
app.use(express.static("public"));
app.use("/output", express.static(path.join(__dirname, "output")));

// Función para guardar la transcripción en el archivo JSON y emitir un evento
function save_transcription_to_json(file_path, transcription_text) {
  const timestamp = new Date().toISOString();
  const audio_filename = path.basename(file_path);

  // Verificar si el archivo existe antes de intentar leerlo
  if (!fs.existsSync(transcription_file)) {
    // Si el archivo no existe, creamos la estructura inicial
    const initial_data = { transcriptions: [] };
    fs.writeFileSync(
      transcription_file,
      JSON.stringify(initial_data, null, 4),
      "utf-8",
    );
    console.log("Archivo JSON de transcripciones inicializado.");
  }

  // Leer el archivo JSON existente
  const data = JSON.parse(fs.readFileSync(transcription_file, "utf-8"));

  // Agregar la nueva transcripción
  const newTranscription = {
    timestamp: timestamp,
    audioFile: audio_filename,
    text: transcription_text,
  };
  data.transcriptions.push(newTranscription);

  // Guardar el archivo JSON actualizado
  fs.writeFileSync(transcription_file, JSON.stringify(data, null, 4), "utf-8");
  console.log("Transcripciones guardadas:", data);

  // Emitir el evento a todos los clientes WebSocket conectados
  io.emit("receive-transcription-update", newTranscription); // Emitir la nueva transcripción
  console.log(
    "Emitiendo nueva transcripción a los clientes:",
    newTranscription,
  );
}

// Endpoint para obtener las transcripciones en formato JSON
app.get("/get-transcriptions", (req, res) => {
  try {
    const transcriptionData = fs.readFileSync(transcription_file, "utf-8");
    res.json(JSON.parse(transcriptionData)); // Enviar como respuesta en formato JSON
  } catch (error) {
    console.error("Error al leer el archivo de transcripciones:", error);
    // En caso de error, enviar una respuesta con un array vacío para evitar problemas en el cliente
    res.status(500).json({ transcriptions: [] });
  }
});

// Definir los permisos necesarios y las credenciales de Google
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const FOLDER_ID = process.env.GOOGLE_FOLDER_ID;
const WEBHOOK_URL_NUEVO_BOTON =
  "https://n8n-n8n.yn8wow.easypanel.host/webhook/6ac52d95-c9a2-465b-937e-86da54d2decb";
const WEBHOOK_URL_VIEJO_BOTON =
  "https://hook.us1.make.com/jw99tn8s32wkw7qhmwsujz2e5mbrmdtf";
const WEBHOOK_URL_TERCER_BOTON =
  "https://hook.us2.make.com/d8i414m0je6x8pt6hw5rm1t15au359ru";
const BEBAS_KAI_FONT_PATH =
  "C:\\Users\\adria\\AppData\\Local\\Microsoft\\Windows\\Fonts\\BebasKai.ttf";
const LOGO_PATH = path.join(__dirname, "logo.png");

// Autorizar la API de Google
async function authorize() {
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  const private_key = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT(client_email, null, private_key, SCOPES);
  return auth;
}

// Subir archivo a Google Drive
async function uploadFile(auth, filePath) {
  const drive = google.drive({ version: "v3", auth });

  // Metadatos del archivo a subir
  const fileMetadata = {
    name: path.basename(filePath),
    parents: [FOLDER_ID],
  };

  const media = {
    mimeType: "image/png",
    body: fs.createReadStream(filePath),
  };

  try {
    // Subir el archivo
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id, webContentLink",
    });

    console.log("Archivo subido con éxito");
    return response.data.webContentLink;
  } catch (error) {
    console.error("Error al subir el archivo:", error.message);
    throw error;
  }
}

// Endpoint para procesar la imagen y subirla a Google Drive
app.post("/generate", upload.single("image"), async (req, res) => {
  const { title, description } = req.body;
  const imagePath = req.file.path;

  try {
    // Procesar la imagen
    const finalImagePath = await processImage(imagePath, title);

    // Autorizar y subir a Google Drive
    const auth = await authorize();
    const imageDriveUrl = await uploadFile(auth, finalImagePath);

    // Responder con la URL local para visualización
    res.json({
      imageUrl: `/output/${path.basename(finalImagePath)}`, // URL local para visualización en frontend
      title,
      description,
      finalImagePath, // Ruta completa para la subida a Google Drive
    });
  } catch (error) {
    console.error("Error al procesar la imagen:", error);
    res.status(500).send("Error al procesar la imagen");
  }
});

// Enviar los datos al webhook
async function sendToWebhook(webhookUrl, note) {
  try {
    console.log("Enviando datos al webhook...");
    await axios.post(webhookUrl, {
      title: note.title,
      datePublished: new Date().toISOString(),
      content: note.content,
      imageUrl: note.imageUrl,
      linkUrl: note.linkUrl,
      imageDriveUrl: note.imageDriveUrl,
    });
    console.log("Webhook enviado con éxito para la noticia:", note.title);
  } catch (error) {
    console.error("Error enviando datos al webhook:", error);
  }
}

// Endpoint para enviar el webhook (Viejo botón)
app.post("/sendWebhook", async (req, res) => {
  const { title, description, imageUrl, finalImagePath } = req.body;

  if (!finalImagePath) {
    console.error("Error: finalImagePath is missing in the request.");
    return res.status(400).json({ error: "finalImagePath is required." });
  }

  try {
    const auth = await authorize();
    const imageDriveUrl = await uploadFile(auth, finalImagePath);

    console.log("Imagen subida a Google Drive con éxito. URL: ", imageDriveUrl);

    const note = {
      title,
      datePublished: new Date().toISOString(),
      content: description,
      imageUrl,
      linkUrl: imageDriveUrl,
      imageDriveUrl,
    };

    await sendToWebhook(WEBHOOK_URL_VIEJO_BOTON, note);

    // Publicar en Twitter
    try {
      await postTweetViejoBoton(title, imageDriveUrl);
    } catch (twitterError) {
      console.error(
        "Error al publicar en Twitter (Viejo Botón):",
        twitterError,
      );
    }

    // Publicar directamente via Meta API si está conectado
    let metaResults = null;
    try {
      const metaStatus = getConnectionStatus();
      if (metaStatus.connected) {
        metaResults = await publishToAllMeta({
          title,
          content: description,
          imageUrl: imageDriveUrl,
          imagePath: finalImagePath,
        });
        console.log("[Meta] Publicación directa completada:", metaResults);
      }
    } catch (metaError) {
      console.error("Error publicando en Meta (Viejo Botón):", metaError.message);
    }

    res.json({
      success: true,
      message: "Webhook enviado con éxito.",
      metaResults,
    });
  } catch (error) {
    console.error("Error al enviar el webhook:", error);
    res.status(500).send("Error al enviar el webhook.");
  }
});

// Endpoint para generar la placa a partir de la URL del comercial
app.post("/generate-from-url", async (req, res) => {
  const { url } = req.body;

  try {
    const articleData = await scrapeElComercialArticle(url);

    const imageResponse = await axios.get(articleData.imageUrl, {
      responseType: "arraybuffer",
    });
    const buffer = Buffer.from(imageResponse.data, "binary");
    const imagePath = path.join(__dirname, "output", `temp_${uuidv4()}.jpg`);
    fs.writeFileSync(imagePath, buffer);

    const finalImagePath = await processImage(imagePath, articleData.title);
    const imageUrl = `/output/${path.basename(finalImagePath)}`;

    res.json({
      imageUrl: imageUrl,
      title: articleData.title,
      content: articleData.content,
      finalImagePath,
    });
  } catch (error) {
    console.error("Error al generar la placa:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para enviar el webhook del nuevo botón
app.post("/sendWebhookNuevoBoton", async (req, res) => {
  const { title, content, imageUrl, finalImagePath } = req.body;

  try {
    const auth = await authorize();
    const imageDriveUrl = await uploadFile(auth, finalImagePath);

    console.log("Imagen subida a Google Drive con éxito. URL: ", imageDriveUrl);

    const webhookData = {
      title,
      datePublished: new Date().toISOString(),
      content: content,
      imageUrl: imageDriveUrl,
      linkUrl: imageDriveUrl,
      imageDriveUrl,
    };

    await sendToWebhook(WEBHOOK_URL_NUEVO_BOTON, webhookData);

    // Publicar en Twitter
    try {
      await postTweetNuevoBoton(title, imageDriveUrl);
    } catch (twitterError) {
      console.error(
        "Error al publicar en Twitter (Nuevo Botón):",
        twitterError,
      );
    }

    // Publicar directamente via Meta API si está conectado
    let metaResults = null;
    try {
      const metaStatus = getConnectionStatus();
      if (metaStatus.connected) {
        metaResults = await publishToAllMeta({
          title,
          content,
          imageUrl: imageDriveUrl,
          imagePath: finalImagePath,
        });
        console.log("[Meta] Publicación directa completada:", metaResults);
      }
    } catch (metaError) {
      console.error("Error publicando en Meta (Nuevo Botón):", metaError.message);
    }

    res.json({
      success: true,
      message: "Webhook enviado con éxito (Nuevo Botón)",
      metaResults,
    });
  } catch (error) {
    console.error("Error al enviar el webhook (Nuevo Botón):", error);
    res.status(500).send("Error al enviar el webhook (Nuevo Botón)");
  }
});

// Endpoint para iniciar la captura de audio
app.post("/start-capture", (req, res) => {
  console.log("Solicitando iniciar captura de audio...");

  if (isCapturing) {
    return res
      .status(400)
      .json({ success: false, message: "La captura ya está en curso." });
  }

  // Iniciar el proceso de Python
  pythonProcess = exec(
    "python scripts/audio_capture.py",
    (error, stdout, stderr) => {
      if (error) {
        console.error("Error al iniciar captura:", error.message);
        isCapturing = false; // Resetear el estado en caso de error
        pythonProcess = null; // Asegurarse de que pythonProcess sea null en caso de error
        return io.emit("capture-error", {
          message: "Error en audio_capture.py: " + error.message,
        }); // Enviar el error al cliente
      }
      console.log("Captura iniciada:", stdout);
      // La captura finalizó (ya sea normalmente o por un error)
      isCapturing = false;
      pythonProcess = null; // Asegurarse de que pythonProcess sea null al finalizar
    },
  );

  isCapturing = true; // Marcar que la captura está en curso
  res.json({ success: true, message: "Captura iniciada." });
});

// Endpoint para detener la captura de audio sin reiniciar
app.post("/stop-capture", (req, res) => {
  console.log("Deteniendo captura...");

  if (!isCapturing) {
    return res
      .status(400)
      .json({ success: false, message: "La captura no está en curso." });
  }

  if (pythonProcess) {
    pythonProcess.kill("SIGINT"); // Envía una señal de interrupción para detener el proceso

    // Eliminar el listener 'close' anterior (si existe) para evitar conflictos
    pythonProcess.removeAllListeners("close");

    pythonProcess.on("close", (code) => {
      console.log(`Proceso de captura finalizado con código: ${code}`);
      isCapturing = false;
      pythonProcess = null; // Limpiar la referencia al proceso

      if (code === 0) {
        res.json({ success: true, message: "Captura detenida correctamente." });
      } else {
        res
          .status(500)
          .json({ success: false, message: "Error al detener la captura." });
      }
    });

    pythonProcess.on("error", (err) => {
      console.error("Error en el proceso hijo:", err);
      res
        .status(500)
        .json({ success: false, message: "Error al detener la captura." });
      isCapturing = false;
      pythonProcess = null;
    });
  } else {
    console.log("No hay proceso de captura en ejecución.");
    res.status(400).json({
      success: false,
      message: "No hay proceso de captura en ejecución.",
    });
  }
});

app.post("/generateNewsCopy", async (req, res) => {
  const { context, transcription } = req.body;

  try {
    const generatedCopy = await generateNewsCopy(context, transcription);
    res.setHeader("Content-Type", "application/json"); // Establecer el encabezado Content-Type
    res.json({ generatedCopy });
  } catch (error) {
    console.error("Error al generar la nota:", error);
    res.setHeader("Content-Type", "application/json"); // Establecer el encabezado Content-Type incluso en caso de error
    res
      .status(500)
      .json({ error: "Error al generar la nota: " + error.message });
  }
});

// ===========================================
// META (FACEBOOK + INSTAGRAM) - OAuth & Publishing
// ===========================================

// Configuración Meta para frontend (solo IDs públicos, sin secrets)
app.get("/meta/config", (req, res) => {
  res.json({
    appId: process.env.META_APP_ID || "",
    configId: process.env.META_CONFIG_ID || "",
  });
});

// Estado de conexión Meta
app.get("/meta/status", (req, res) => {
  try {
    const status = getConnectionStatus();
    res.json(status);
  } catch (error) {
    console.error("Error obteniendo estado de Meta:", error);
    res.status(500).json({ connected: false, error: error.message });
  }
});

// Conectar Meta: recibe code o access_token del popup de FB.login()
app.post("/meta/connect", async (req, res) => {
  const { code, accessToken, redirectUri } = req.body;

  if (!code && !accessToken) {
    return res.status(400).json({ error: "Se requiere code o accessToken del popup de Meta" });
  }

  try {
    // 1. Intercambiar por long-lived token
    const { longLivedToken, expiresIn } = await exchangeToken({
      code,
      accessToken,
      redirectUri,
    });

    // 2. Verificar permisos
    const permissions = await checkPermissions(longLivedToken);

    // 3. Descubrir assets (Pages, IG accounts)
    const assets = await discoverAssets(longLivedToken);

    // 4. Respuesta sanitizada (sin tokens - igual que Platform ROI)
    res.json({
      success: true,
      connected: true,
      expiresIn,
      permissions,
      assets,
    });
  } catch (error) {
    console.error("Error conectando Meta:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data?.error?.message || error.message,
    });
  }
});

// Desconectar Meta
app.post("/meta/disconnect", (req, res) => {
  try {
    const result = disconnectMeta();
    res.json(result);
  } catch (error) {
    console.error("Error desconectando Meta:", error);
    res.status(500).json({ error: error.message });
  }
});

// Publicar directamente via Meta API (alternativa a webhooks)
app.post("/meta/publish", async (req, res) => {
  const { title, content, imageUrl, imagePath } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Se requiere al menos un título" });
  }

  try {
    const results = await publishToAllMeta({ title, content, imageUrl, imagePath });
    res.json({
      success: true,
      results,
    });
  } catch (error) {
    console.error("Error publicando en Meta:", error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// PIPELINE AUTÓNOMO
// ===========================================

let pipeline = null;

// Iniciar pipeline autónomo
app.post("/pipeline/start", async (req, res) => {
  const { url, tone, structure, imageModel, segmentDuration, publishInterval, autoPublish } = req.body;

  if (!url) {
    return res.status(400).json({ error: "Se requiere una URL de transmisión." });
  }

  try {
    if (pipeline && pipeline.running) {
      return res.status(400).json({ error: "El pipeline ya está en ejecución. Detenelo primero." });
    }

    pipeline = new AutoPipeline(io);
    await pipeline.start({
      url,
      tone: tone || "formal",
      structure: structure || "completa",
      imageModel: imageModel || "gemini",
      segmentDuration: segmentDuration || 120,
      publishInterval: publishInterval || 5,
      autoPublish: autoPublish !== false,
    });

    res.json({
      success: true,
      message: "Pipeline autónomo iniciado.",
      config: pipeline.config,
    });
  } catch (error) {
    console.error("Error iniciando pipeline:", error);
    res.status(500).json({ error: error.message });
  }
});

// Detener pipeline
app.post("/pipeline/stop", (req, res) => {
  if (!pipeline || !pipeline.running) {
    return res.status(400).json({ error: "No hay pipeline en ejecución." });
  }

  pipeline.stop();
  res.json({
    success: true,
    message: "Pipeline detenido.",
    stats: {
      totalPublished: pipeline.publishedNotes.length,
    },
  });
});

// Estado del pipeline
app.get("/pipeline/status", (req, res) => {
  if (!pipeline) {
    return res.json({
      running: false,
      currentStep: "idle",
      bufferSize: 0,
      totalPublished: 0,
    });
  }
  res.json(pipeline.getStatus());
});

// Configuración disponible (tonos y estructuras)
app.get("/pipeline/options", (req, res) => {
  res.json({
    tones: Object.keys(TONE_PROMPTS).map(key => ({
      value: key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      description: TONE_PROMPTS[key],
    })),
    structures: Object.keys(STRUCTURE_PROMPTS).map(key => ({
      value: key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      description: STRUCTURE_PROMPTS[key],
    })),
  });
});

// Iniciar el servidor HTTP y WebSocket en el puerto 3000
httpServer.listen(3000, () => {
  console.log("Servidor WebSocket y HTTP corriendo en http://localhost:3000");
});
