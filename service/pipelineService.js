import { captureAndTranscribe, detectSourceType } from "./transcriptionService.js";
import { extractInsights } from "./insightService.js";
import { searchAndEnrich } from "./searchService.js";
import { generateNewsCopy, generateTitle } from "../scripts/cohere_Service.js";
import { processImage } from "./imageService.js";
import { postTweetNuevoBoton } from "./twitter_service.js";
import { google } from "googleapis";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { v4 as uuidv4 } from "uuid";
import * as dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputDir = path.join(__dirname, "..", "output");

// Webhooks
const WEBHOOK_URL_PIPELINE =
  process.env.WEBHOOK_URL_PIPELINE ||
  "https://n8n-n8n.yn8wow.easypanel.host/webhook/6ac52d95-c9a2-465b-937e-86da54d2decb";

/**
 * Clase principal del pipeline autónomo.
 * Conecta todos los servicios en un flujo continuo:
 * URL → Captura → Transcripción → Insights → Búsqueda → Nota → Flyer → Publicación
 */
class AutoPipeline {
  constructor(io) {
    this.io = io; // Socket.IO para emitir progreso
    this.running = false;
    this.config = {
      url: "",
      tone: "formal",
      structure: "completa",
      segmentDuration: 120, // segundos por segmento de audio
      publishInterval: 5, // cada cuántos minutos publicar (acumulando transcripciones)
      autoPublish: true,
    };
    this.transcriptionBuffer = [];
    this.publishedNotes = [];
    this.currentStep = "idle";
    this.captureTimeout = null;
  }

  /**
   * Emitir evento de progreso a todos los clientes conectados.
   */
  emit(event, data) {
    this.io.emit("pipeline-update", {
      event,
      timestamp: new Date().toISOString(),
      ...data,
    });
    console.log(`[Pipeline] ${event}:`, JSON.stringify(data).slice(0, 200));
  }

  /**
   * Iniciar el pipeline autónomo.
   */
  async start(config) {
    if (this.running) {
      throw new Error("El pipeline ya está en ejecución.");
    }

    this.config = { ...this.config, ...config };
    this.running = true;
    this.transcriptionBuffer = [];
    this.currentStep = "starting";

    const sourceType = detectSourceType(this.config.url);
    this.emit("started", {
      url: this.config.url,
      sourceType,
      tone: this.config.tone,
      structure: this.config.structure,
    });

    // Iniciar el ciclo de captura
    this.captureLoop();
  }

  /**
   * Loop principal de captura y procesamiento.
   */
  async captureLoop() {
    while (this.running) {
      try {
        // PASO 1: Capturar y transcribir
        this.currentStep = "capturing";
        this.emit("step", { step: "capturing", message: "Capturando audio..." });

        const result = await captureAndTranscribe(
          this.config.url,
          this.config.segmentDuration,
        );

        if (!this.running) break;

        // Agregar al buffer
        this.transcriptionBuffer.push(result);
        this.emit("transcription", {
          step: "transcribed",
          text: result.text,
          timestamp: result.timestamp,
          bufferSize: this.transcriptionBuffer.length,
        });

        // Verificar si es momento de procesar y publicar
        const segmentsNeeded = Math.ceil(
          (this.config.publishInterval * 60) / this.config.segmentDuration,
        );

        if (this.transcriptionBuffer.length >= segmentsNeeded) {
          await this.processAndPublish();
        }
      } catch (error) {
        this.emit("error", {
          step: this.currentStep,
          message: error.message,
        });

        // Esperar antes de reintentar
        if (this.running) {
          await this.sleep(10000);
        }
      }
    }
  }

  /**
   * Procesar transcripciones acumuladas y publicar.
   */
  async processAndPublish() {
    const fullTranscription = this.transcriptionBuffer
      .map((t) => t.text)
      .join(" ");

    // Limpiar buffer
    this.transcriptionBuffer = [];

    try {
      // PASO 2: Extraer insights
      this.currentStep = "analyzing";
      this.emit("step", {
        step: "analyzing",
        message: "Extrayendo insights de la transcripción...",
      });

      const insights = await extractInsights(fullTranscription);
      this.emit("insights", {
        step: "insights_extracted",
        insights,
      });

      // PASO 3: Buscar en internet
      this.currentStep = "searching";
      this.emit("step", {
        step: "searching",
        message: "Buscando información complementaria...",
      });

      let webResults = [];
      if (insights.searchQueries.length > 0) {
        webResults = await searchAndEnrich(insights.searchQueries);
        this.emit("search", {
          step: "search_complete",
          resultsCount: webResults.length,
        });
      }

      // Preparar contexto web
      const webContext = webResults
        .map((r) => `Fuente: ${r.title}\n${r.content || r.snippet}`)
        .join("\n\n---\n\n");

      // PASO 4: Generar nota periodística
      this.currentStep = "generating";
      this.emit("step", {
        step: "generating",
        message: `Generando nota (tono: ${this.config.tone}, estructura: ${this.config.structure})...`,
      });

      const newsText = await generateNewsCopy({
        transcription: fullTranscription,
        tone: this.config.tone,
        structure: this.config.structure,
        webContext,
        insights: `Resumen: ${insights.summary}\nDatos clave: ${insights.keyFacts.join(", ")}`,
      });

      // Generar título
      const title = await generateTitle(fullTranscription, insights.summary);

      this.emit("note", {
        step: "note_generated",
        title,
        content: newsText,
      });

      // PASO 5: Generar flyer
      this.currentStep = "creating_flyer";
      this.emit("step", {
        step: "creating_flyer",
        message: "Generando placa informativa...",
      });

      const flyerPath = await this.generateFlyer(title, webResults);
      this.emit("flyer", {
        step: "flyer_created",
        path: flyerPath,
      });

      // PASO 6: Publicar
      if (this.config.autoPublish) {
        this.currentStep = "publishing";
        this.emit("step", {
          step: "publishing",
          message: "Publicando en redes sociales...",
        });

        await this.publish(title, newsText, flyerPath);

        this.publishedNotes.push({
          title,
          content: newsText,
          flyerPath,
          timestamp: new Date().toISOString(),
        });

        this.emit("published", {
          step: "published",
          title,
          totalPublished: this.publishedNotes.length,
        });
      }

      this.currentStep = "waiting";
      this.emit("step", {
        step: "waiting",
        message: "Esperando próximo ciclo de captura...",
      });
    } catch (error) {
      this.emit("error", {
        step: this.currentStep,
        message: error.message,
      });
    }
  }

  /**
   * Generar un flyer/placa informativa.
   * Si hay imagen de búsqueda web la usa, si no genera una placa con fondo sólido.
   */
  async generateFlyer(title, webResults) {
    // Buscar una imagen disponible de los resultados web
    let imagePath = null;

    for (const result of webResults) {
      if (result.scrapedImage && result.scrapedImage.startsWith("http")) {
        try {
          const response = await axios.get(result.scrapedImage, {
            responseType: "arraybuffer",
            timeout: 10000,
          });
          imagePath = path.join(outputDir, `temp_${uuidv4()}.jpg`);
          fs.writeFileSync(imagePath, Buffer.from(response.data, "binary"));
          break;
        } catch (_) {
          // Continuar buscando otra imagen
        }
      }
    }

    // Si no hay imagen, crear una imagen placeholder con fondo de color
    if (!imagePath) {
      imagePath = await this.createPlaceholderImage();
    }

    // Usar el servicio existente de procesamiento de imagen
    const finalPath = await processImage(imagePath, title);

    // Limpiar imagen temporal
    try {
      fs.unlinkSync(imagePath);
    } catch (_) {}

    return finalPath;
  }

  /**
   * Crea una imagen placeholder cuando no hay imagen disponible.
   */
  async createPlaceholderImage() {
    // Importar canvas dinámicamente
    const { createCanvas } = await import("canvas");
    const canvas = createCanvas(1080, 1080);
    const ctx = canvas.getContext("2d");

    // Fondo con gradiente azul/rojo (colores de Radio Uno)
    const gradient = ctx.createLinearGradient(0, 0, 1080, 1080);
    gradient.addColorStop(0, "#1a1a2e");
    gradient.addColorStop(0.5, "#16213e");
    gradient.addColorStop(1, "#0f3460");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1080, 1080);

    const placeholderPath = path.join(outputDir, `placeholder_${uuidv4()}.jpg`);
    const buffer = canvas.toBuffer("image/jpeg");
    fs.writeFileSync(placeholderPath, buffer);
    return placeholderPath;
  }

  /**
   * Publicar en todas las plataformas.
   */
  async publish(title, content, flyerPath) {
    const errors = [];

    // 1. Subir imagen a Google Drive
    let imageDriveUrl = "";
    try {
      const auth = await this.authorizeGoogleDrive();
      imageDriveUrl = await this.uploadToGoogleDrive(auth, flyerPath);
    } catch (error) {
      errors.push(`Google Drive: ${error.message}`);
    }

    // 2. Publicar vía webhook (Facebook + Instagram vía Make/N8N)
    try {
      await axios.post(WEBHOOK_URL_PIPELINE, {
        title,
        datePublished: new Date().toISOString(),
        content,
        imageUrl: imageDriveUrl,
        linkUrl: imageDriveUrl,
        imageDriveUrl,
        source: "pipeline-autonomo",
      });
    } catch (error) {
      errors.push(`Webhook: ${error.message}`);
    }

    // 3. Publicar en Twitter
    try {
      if (imageDriveUrl) {
        await postTweetNuevoBoton(title, imageDriveUrl);
      }
    } catch (error) {
      errors.push(`Twitter: ${error.message}`);
    }

    if (errors.length > 0) {
      console.error("[Pipeline] Errores de publicación:", errors);
      this.emit("publish_warnings", { warnings: errors });
    }
  }

  async authorizeGoogleDrive() {
    const client_email = process.env.GOOGLE_CLIENT_EMAIL;
    const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!client_email || !private_key) {
      throw new Error("Credenciales de Google Drive no configuradas");
    }
    const auth = new google.auth.JWT(
      client_email,
      null,
      private_key,
      ["https://www.googleapis.com/auth/drive.file"],
    );
    return auth;
  }

  async uploadToGoogleDrive(auth, filePath) {
    const drive = google.drive({ version: "v3", auth });
    const folderId = process.env.GOOGLE_FOLDER_ID;

    const response = await drive.files.create({
      resource: {
        name: path.basename(filePath),
        parents: folderId ? [folderId] : [],
      },
      media: {
        mimeType: "image/jpeg",
        body: fs.createReadStream(filePath),
      },
      fields: "id, webContentLink",
    });

    return response.data.webContentLink;
  }

  /**
   * Detener el pipeline.
   */
  stop() {
    this.running = false;
    this.currentStep = "stopped";
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
    }
    this.emit("stopped", {
      totalPublished: this.publishedNotes.length,
    });
  }

  /**
   * Obtener el estado actual del pipeline.
   */
  getStatus() {
    return {
      running: this.running,
      currentStep: this.currentStep,
      config: this.config,
      bufferSize: this.transcriptionBuffer.length,
      totalPublished: this.publishedNotes.length,
      publishedNotes: this.publishedNotes.slice(-10), // Últimas 10
    };
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.captureTimeout = setTimeout(resolve, ms);
    });
  }
}

export { AutoPipeline };
