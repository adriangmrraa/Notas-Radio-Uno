import { captureAudioSegment, transcribeAudio, detectSourceType } from "./transcriptionService.js";
import { extractInsights } from "./insightService.js";
import { searchAndEnrich } from "./searchService.js";
import { generateNewsCopy, generateTitle } from "../scripts/cohere_Service.js";
import { processImage } from "./imageService.js";
import { postTweetNuevoBoton } from "./twitter_service.js";
import { publishToAllMeta } from "./metaPublishService.js";
import { isMetaConnected, createPublication, createTranscription } from "./databaseService.js";
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
      imageModel: "gemini", // "gemini" o "grok"
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
   * Emite eventos granulares para cada sub-paso.
   */
  async captureLoop() {
    let cycleNumber = 0;

    while (this.running) {
      try {
        cycleNumber++;

        // ─── PASO 1A: Capturar audio ───
        this.currentStep = "capturing";
        this.emit("step", { step: "capturing", message: "Capturando audio..." });
        this.emit("detail", {
          step: "capturing",
          sub: "connecting",
          message: `Conectando al stream: ${this.config.url.slice(0, 60)}...`,
          icon: "satellite",
        });

        const sourceType = detectSourceType(this.config.url);
        this.emit("detail", {
          step: "capturing",
          sub: "source_detected",
          message: `Tipo de fuente detectada: ${sourceType === "youtube" ? "YouTube Live" : sourceType === "radio" ? "Radio stream" : "Stream genérico"}`,
          icon: "check",
        });

        this.emit("detail", {
          step: "capturing",
          sub: "recording",
          message: `Grabando ${this.config.segmentDuration} segundos de audio con FFmpeg...`,
          icon: "mic",
        });

        const { filePath } = await captureAudioSegment(
          this.config.url,
          this.config.segmentDuration,
        );

        if (!this.running) break;

        this.emit("detail", {
          step: "capturing",
          sub: "audio_captured",
          message: `Audio capturado correctamente (${this.config.segmentDuration}s)`,
          icon: "check",
        });

        // ─── PASO 1B: Transcribir ───
        this.emit("detail", {
          step: "capturing",
          sub: "transcribing",
          message: "Cargando modelo Whisper y transcribiendo audio...",
          icon: "brain",
        });

        const text = await transcribeAudio(filePath);

        // Limpiar archivo de audio
        try { fs.unlinkSync(filePath); } catch (_) {}

        if (!this.running) break;

        const result = { text, filePath, sourceType, timestamp: new Date().toISOString() };

        // Agregar al buffer
        this.transcriptionBuffer.push(result);

        // Persistir transcripción en DB
        const dbTranscription = createTranscription({
          text: result.text,
          source: "pipeline",
          durationSeconds: this.config.segmentDuration,
        });
        this.io.emit("history-new-transcription", dbTranscription);

        this.emit("detail", {
          step: "capturing",
          sub: "transcription_done",
          message: `Transcripción completada: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
          icon: "check",
        });

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
        const remaining = segmentsNeeded - this.transcriptionBuffer.length;

        if (this.transcriptionBuffer.length >= segmentsNeeded) {
          this.emit("detail", {
            step: "capturing",
            sub: "buffer_ready",
            message: `Buffer completo (${this.transcriptionBuffer.length} segmentos). Iniciando procesamiento...`,
            icon: "rocket",
          });
          await this.processAndPublish();
        } else {
          this.emit("detail", {
            step: "capturing",
            sub: "buffer_waiting",
            message: `Buffer: ${this.transcriptionBuffer.length}/${segmentsNeeded} segmentos. Faltan ${remaining} para procesar.`,
            icon: "clock",
          });
        }
      } catch (error) {
        this.emit("error", {
          step: this.currentStep,
          message: error.message,
        });

        this.emit("detail", {
          step: this.currentStep,
          sub: "retry",
          message: `Error: ${error.message}. Reintentando en 10 segundos...`,
          icon: "warning",
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
   * Emite eventos detallados para cada sub-operación.
   */
  async processAndPublish() {
    const segmentCount = this.transcriptionBuffer.length;
    const fullTranscription = this.transcriptionBuffer
      .map((t) => t.text)
      .join(" ");

    // Limpiar buffer
    this.transcriptionBuffer = [];

    try {
      // ─── PASO 2: Extraer insights con IA ───
      this.currentStep = "analyzing";
      this.emit("step", {
        step: "analyzing",
        message: "Analizando transcripción con IA...",
      });

      this.emit("detail", {
        step: "analyzing",
        sub: "preparing",
        message: `Preparando ${segmentCount} segmentos (${fullTranscription.length} caracteres) para análisis...`,
        icon: "document",
      });

      this.emit("detail", {
        step: "analyzing",
        sub: "calling_ai",
        message: "Enviando a Cohere AI para extracción de insights (temas, personas, datos clave)...",
        icon: "brain",
      });

      const insights = await extractInsights(fullTranscription);

      this.emit("detail", {
        step: "analyzing",
        sub: "topics_found",
        message: `Temas detectados: ${insights.topics.length > 0 ? insights.topics.join(", ") : "ninguno específico"}`,
        icon: "tag",
      });

      if (insights.people.length > 0) {
        this.emit("detail", {
          step: "analyzing",
          sub: "people_found",
          message: `Personas mencionadas: ${insights.people.join(", ")}`,
          icon: "people",
        });
      }

      if (insights.keyFacts.length > 0) {
        this.emit("detail", {
          step: "analyzing",
          sub: "facts_found",
          message: `Datos clave: ${insights.keyFacts.slice(0, 2).join(" | ")}`,
          icon: "lightbulb",
        });
      }

      this.emit("detail", {
        step: "analyzing",
        sub: "summary",
        message: `Resumen: ${insights.summary.slice(0, 150)}${insights.summary.length > 150 ? "..." : ""}`,
        icon: "check",
      });

      this.emit("insights", { step: "insights_extracted", insights });

      // ─── PASO 3: Búsqueda web ───
      this.currentStep = "searching";
      this.emit("step", {
        step: "searching",
        message: "Investigando en internet...",
      });

      let webResults = [];
      if (insights.searchQueries.length > 0) {
        for (let i = 0; i < Math.min(insights.searchQueries.length, 3); i++) {
          const query = insights.searchQueries[i];
          this.emit("detail", {
            step: "searching",
            sub: "query",
            message: `Buscando: "${query}"`,
            icon: "search",
            index: i + 1,
            total: Math.min(insights.searchQueries.length, 3),
          });
        }

        webResults = await searchAndEnrich(insights.searchQueries);

        if (webResults.length > 0) {
          for (const result of webResults.slice(0, 3)) {
            this.emit("detail", {
              step: "searching",
              sub: "result_found",
              message: `Encontrado: "${result.scrapedTitle || result.title}"`,
              icon: "link",
              url: result.url,
            });
          }

          this.emit("detail", {
            step: "searching",
            sub: "scraping",
            message: `Scrapeando contenido de ${webResults.length} artículos para enriquecer la nota...`,
            icon: "download",
          });
        } else {
          this.emit("detail", {
            step: "searching",
            sub: "no_results",
            message: "No se encontraron resultados relevantes. Se continuará con la transcripción.",
            icon: "info",
          });
        }

        this.emit("search", {
          step: "search_complete",
          resultsCount: webResults.length,
        });
      } else {
        this.emit("detail", {
          step: "searching",
          sub: "skip",
          message: "No se generaron queries de búsqueda. Saltando investigación web.",
          icon: "info",
        });
      }

      // Preparar contexto web
      const webContext = webResults
        .map((r) => `Fuente: ${r.title}\n${r.content || r.snippet}`)
        .join("\n\n---\n\n");

      // ─── PASO 4: Generar nota periodística ───
      this.currentStep = "generating";
      this.emit("step", {
        step: "generating",
        message: "Redactando nota periodística...",
      });

      this.emit("detail", {
        step: "generating",
        sub: "preparing_prompt",
        message: `Preparando prompt con tono "${this.config.tone}" y estructura "${this.config.structure}"...`,
        icon: "edit",
      });

      if (webContext) {
        this.emit("detail", {
          step: "generating",
          sub: "enriching",
          message: `Incluyendo información de ${webResults.length} fuentes web como contexto...`,
          icon: "merge",
        });
      }

      this.emit("detail", {
        step: "generating",
        sub: "calling_ai",
        message: "Generando texto de la nota con Cohere AI...",
        icon: "brain",
      });

      const newsText = await generateNewsCopy({
        transcription: fullTranscription,
        tone: this.config.tone,
        structure: this.config.structure,
        webContext,
        insights: `Resumen: ${insights.summary}\nDatos clave: ${insights.keyFacts.join(", ")}`,
      });

      this.emit("detail", {
        step: "generating",
        sub: "note_ready",
        message: `Nota generada (${newsText.length} caracteres). Generando título...`,
        icon: "check",
      });

      this.emit("detail", {
        step: "generating",
        sub: "generating_title",
        message: "Generando título periodístico impactante con IA...",
        icon: "brain",
      });

      const title = await generateTitle(fullTranscription, insights.summary);

      this.emit("detail", {
        step: "generating",
        sub: "title_ready",
        message: `Título: "${title}"`,
        icon: "check",
      });

      this.emit("note", {
        step: "note_generated",
        title,
        content: newsText,
      });

      // ─── PASO 5: Generar flyer ───
      this.currentStep = "creating_flyer";
      this.emit("step", {
        step: "creating_flyer",
        message: "Creando placa informativa...",
      });

      this.emit("detail", {
        step: "creating_flyer",
        sub: "strategy",
        message: "Buscando imagen de fondo: primero artículos web, luego IA, fallback placeholder...",
        icon: "image",
      });

      const flyerPath = await this.generateFlyer(title, webResults, insights);

      this.emit("detail", {
        step: "creating_flyer",
        sub: "overlay",
        message: "Aplicando overlay: resize 1080x1080, gradiente, título, logo Radio Uno...",
        icon: "layers",
      });

      this.emit("flyer", {
        step: "flyer_created",
        path: flyerPath,
        previewUrl: `/output/${path.basename(flyerPath)}`,
      });

      this.emit("detail", {
        step: "creating_flyer",
        sub: "done",
        message: "Placa informativa lista para publicar",
        icon: "check",
      });

      // ─── PASO 6: Publicar ───
      if (this.config.autoPublish) {
        this.currentStep = "publishing";
        this.emit("step", {
          step: "publishing",
          message: "Publicando en redes sociales...",
        });

        this.emit("detail", {
          step: "publishing",
          sub: "google_drive",
          message: "Subiendo imagen a Google Drive...",
          icon: "upload",
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
        message: `Ciclo completado. Próxima captura en ${this.config.segmentDuration}s...`,
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
   *
   * Estrategia para la imagen de FONDO (en orden de prioridad):
   *   1. Imagen encontrada en artículos web scrapeados
   *   2. Imagen generada por IA basada en los insights (si hay API key de imagen)
   *   3. Placeholder con gradiente de colores de Radio Uno
   *
   * El overlay (sombra + texto + logo) SIEMPRE lo aplica processImage()
   * con código, garantizando consistencia visual entre todas las placas.
   */
  async generateFlyer(title, webResults, insights) {
    let imagePath = null;

    // Estrategia 1: Buscar imagen de artículos web scrapeados
    for (const result of webResults) {
      if (result.scrapedImage && result.scrapedImage.startsWith("http")) {
        try {
          const response = await axios.get(result.scrapedImage, {
            responseType: "arraybuffer",
            timeout: 10000,
          });
          imagePath = path.join(outputDir, `temp_${uuidv4()}.jpg`);
          fs.writeFileSync(imagePath, Buffer.from(response.data, "binary"));
          this.emit("flyer_bg", { source: "web", url: result.scrapedImage });
          break;
        } catch (_) {
          // Continuar con siguiente imagen
        }
      }
    }

    // Estrategia 2: Generar fondo con IA (si no se encontró imagen web)
    if (!imagePath) {
      imagePath = await this.generateAIBackground(title, insights, webResults);
    }

    // Estrategia 3: Placeholder si todo lo anterior falló
    if (!imagePath) {
      imagePath = await this.createPlaceholderImage();
      this.emit("flyer_bg", { source: "placeholder" });
    }

    // processImage() aplica SIEMPRE el mismo overlay:
    // - Resize a 1080x1080
    // - Gradiente oscuro de abajo hacia arriba
    // - Caja negra semitransparente con el título (Bebas Kai 70px)
    // - "Radio Uno Formosa" centrado (Bebas Kai 30px)
    // - Logo 150px en esquina superior derecha
    const finalPath = await processImage(imagePath, title);

    // Limpiar imagen temporal de fondo
    try { fs.unlinkSync(imagePath); } catch (_) {}

    return finalPath;
  }

  /**
   * Genera una imagen de fondo usando IA.
   * Usa el modelo seleccionado por el usuario: "gemini" (Google Imagen) o "grok" (xAI).
   * Retorna la ruta al archivo generado, o null si no hay API configurada.
   */
  async generateAIBackground(title, insights, webResults) {
    const prompt = this.buildImagePrompt(title, insights, webResults);
    const selectedModel = this.config.imageModel || "gemini";

    this.emit("flyer_bg", {
      source: "ai_generating",
      model: selectedModel,
      prompt: prompt.slice(0, 150),
    });

    // Intentar con el modelo seleccionado primero, fallback al otro
    const strategies = selectedModel === "gemini"
      ? [() => this.generateWithGemini(prompt), () => this.generateWithGrok(prompt)]
      : [() => this.generateWithGrok(prompt), () => this.generateWithGemini(prompt)];

    for (const strategy of strategies) {
      const result = await strategy();
      if (result) return result;
    }

    return null;
  }

  /**
   * Genera imagen de fondo con Google Imagen 4 (Gemini API).
   * Env: GEMINI_API_KEY
   */
  async generateWithGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    try {
      const response = await axios.post(
        "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict",
        {
          instances: [{ prompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: "1:1",
          },
        },
        {
          headers: {
            "x-goog-api-key": apiKey,
            "Content-Type": "application/json",
          },
          timeout: 60000,
        },
      );

      const prediction = response.data.predictions?.[0];
      if (!prediction?.bytesBase64Encoded) {
        console.error("[Pipeline] Gemini Imagen: respuesta sin imagen");
        return null;
      }

      const imagePath = path.join(outputDir, `ai_bg_gemini_${uuidv4()}.png`);
      fs.writeFileSync(imagePath, Buffer.from(prediction.bytesBase64Encoded, "base64"));
      this.emit("flyer_bg", { source: "gemini_imagen" });
      return imagePath;
    } catch (error) {
      console.error("[Pipeline] Error generando fondo con Gemini Imagen:", error.message);
      return null;
    }
  }

  /**
   * Genera imagen de fondo con xAI Grok Image.
   * Env: XAI_API_KEY
   * Modelos: grok-2-image, grok-imagine-image
   */
  async generateWithGrok(prompt) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return null;

    try {
      const response = await axios.post(
        "https://api.x.ai/v1/images/generations",
        {
          model: "grok-2-image",
          prompt,
          n: 1,
          response_format: "b64_json",
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 60000,
        },
      );

      const imageData = response.data.data?.[0];
      if (!imageData?.b64_json) {
        console.error("[Pipeline] Grok Image: respuesta sin imagen");
        return null;
      }

      const imagePath = path.join(outputDir, `ai_bg_grok_${uuidv4()}.jpg`);
      fs.writeFileSync(imagePath, Buffer.from(imageData.b64_json, "base64"));
      this.emit("flyer_bg", {
        source: "grok_image",
        revisedPrompt: imageData.revised_prompt || "",
      });
      return imagePath;
    } catch (error) {
      console.error("[Pipeline] Error generando fondo con Grok Image:", error.message);
      return null;
    }
  }

  /**
   * Construye un prompt estratégico para la imagen de fondo basándose en:
   * - Título de la nota
   * - Insights extraídos (personas, temas, datos clave)
   * - Información del research web
   *
   * Reglas:
   * - Si se menciona una personalidad/político → debe aparecer esa persona
   * - Si la noticia es sobre un evento dramático → la imagen lo refleja
   * - Si se habla de un país/lugar → la imagen referencia ese lugar + tema
   * - NUNCA debe incluir texto, logos ni marcas de agua (eso lo pone processImage)
   */
  buildImagePrompt(title, insights, webResults) {
    const parts = [];

    // Base: fotografía periodística
    parts.push("Fotografía periodística profesional de alta calidad, estilo editorial de agencia de noticias.");

    // Personas mencionadas: si hay políticos, figuras públicas, que aparezcan
    if (insights?.people?.length > 0) {
      const people = insights.people.slice(0, 3).join(", ");
      parts.push(`La imagen debe mostrar o representar a: ${people}.`);
    }

    // Temas: mapear temas a elementos visuales concretos
    if (insights?.topics?.length > 0) {
      const topicVisuals = insights.topics.map((topic) => {
        const t = topic.toLowerCase();
        // Mapeo de temas a elementos visuales para que el prompt sea más concreto
        if (t.includes("bomb") || t.includes("explos") || t.includes("atentado")) {
          return "explosión, humo, escena de emergencia";
        }
        if (t.includes("eleccio") || t.includes("voto") || t.includes("democra")) {
          return "urna de votación, acto electoral, multitud política";
        }
        if (t.includes("economía") || t.includes("dólar") || t.includes("inflación")) {
          return "gráficos financieros, billetes, bolsa de valores";
        }
        if (t.includes("deport") || t.includes("fútbol") || t.includes("mundial")) {
          return "estadio de fútbol, jugadores en acción";
        }
        if (t.includes("salud") || t.includes("hospital") || t.includes("pandemia")) {
          return "hospital, personal médico, equipamiento sanitario";
        }
        if (t.includes("educación") || t.includes("escuela") || t.includes("universidad")) {
          return "aula, estudiantes, campus universitario";
        }
        if (t.includes("seguridad") || t.includes("polic") || t.includes("crimen")) {
          return "patrulla policial, cinta de seguridad, escena policial";
        }
        if (t.includes("clima") || t.includes("inundac") || t.includes("tormenta")) {
          return "tormenta, inundación, fenómeno climático extremo";
        }
        if (t.includes("tecnolog") || t.includes("inteligencia artificial") || t.includes("digital")) {
          return "tecnología futurista, pantallas digitales, innovación";
        }
        return topic; // Usar el tema tal cual si no hay mapeo
      });
      parts.push(`Elementos visuales principales: ${topicVisuals.join(", ")}.`);
    }

    // Datos clave: enriquecer el contexto visual
    if (insights?.keyFacts?.length > 0) {
      const contextFact = insights.keyFacts[0];
      parts.push(`Contexto de la noticia: ${contextFact}.`);
    }

    // Información de búsqueda web: extraer ubicaciones geográficas
    if (webResults?.length > 0) {
      const contextSnippets = webResults
        .slice(0, 2)
        .map((r) => r.snippet || r.scrapedTitle || "")
        .filter(Boolean)
        .join(" ");
      if (contextSnippets) {
        parts.push(`Información adicional para contexto visual: ${contextSnippets.slice(0, 200)}.`);
      }
    }

    // Detección de países/regiones para referencia visual geográfica
    const titleLower = title.toLowerCase();
    const geoMappings = {
      "estados unidos": "Washington DC, bandera estadounidense, Capitolio",
      "eeuu": "Washington DC, bandera estadounidense, Casa Blanca",
      "argentina": "Buenos Aires, Casa Rosada, bandera argentina",
      "formosa": "ciudad de Formosa, paisaje del litoral argentino",
      "brasil": "Brasilia, paisaje brasileño, bandera de Brasil",
      "china": "Beijing, arquitectura china, bandera de China",
      "rusia": "Moscú, Kremlin, paisaje ruso",
      "europa": "Bruselas, Parlamento Europeo, bandera de la UE",
      "ucrania": "Kiev, paisaje ucraniano",
      "israel": "Jerusalén, paisaje de Medio Oriente",
      "venezuela": "Caracas, paisaje venezolano",
    };

    for (const [geo, visual] of Object.entries(geoMappings)) {
      if (titleLower.includes(geo) || insights?.summary?.toLowerCase().includes(geo)) {
        parts.push(`Referencia geográfica: la imagen debe evocar ${visual}.`);
        break;
      }
    }

    // Tema principal de la noticia
    parts.push(`Tema de la noticia: "${title}".`);

    // Restricciones técnicas (SIEMPRE)
    parts.push(
      "IMPORTANTE: La imagen NO debe contener texto, letras, palabras, logos, ni marcas de agua. " +
      "Debe ser una imagen limpia que funcione como fondo para una placa informativa de noticias. " +
      "Formato cuadrado 1:1. Colores que permitan superponer texto blanco con buena legibilidad."
    );

    return parts.join(" ");
  }

  /**
   * Crea una imagen placeholder cuando no hay imagen web ni IA disponible.
   * Usa un gradiente con los colores de la marca Radio Uno.
   */
  async createPlaceholderImage() {
    const { createCanvas } = await import("canvas");
    const canvas = createCanvas(1080, 1080);
    const ctx = canvas.getContext("2d");

    // Fondo con gradiente azul oscuro (colores de Radio Uno)
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
      this.emit("detail", {
        step: "publishing",
        sub: "google_drive_done",
        message: "Imagen subida a Google Drive correctamente",
        icon: "check",
      });
    } catch (error) {
      errors.push(`Google Drive: ${error.message}`);
      this.emit("detail", {
        step: "publishing",
        sub: "google_drive_error",
        message: `Error subiendo a Google Drive: ${error.message}`,
        icon: "warning",
      });
    }

    // 2. Publicar vía webhook (Make/N8N)
    this.emit("detail", {
      step: "publishing",
      sub: "webhook",
      message: "Enviando a webhook (Make.com/N8N)...",
      icon: "send",
    });
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
      this.emit("detail", {
        step: "publishing",
        sub: "webhook_done",
        message: "Webhook enviado correctamente",
        icon: "check",
      });
    } catch (error) {
      errors.push(`Webhook: ${error.message}`);
    }

    // 3. Publicar en Twitter
    this.emit("detail", {
      step: "publishing",
      sub: "twitter",
      message: "Publicando en Twitter...",
      icon: "send",
    });
    try {
      if (imageDriveUrl) {
        await postTweetNuevoBoton(title, imageDriveUrl);
        this.emit("detail", {
          step: "publishing",
          sub: "twitter_done",
          message: "Publicado en Twitter correctamente",
          icon: "check",
        });
      }
    } catch (error) {
      errors.push(`Twitter: ${error.message}`);
      this.emit("detail", {
        step: "publishing",
        sub: "twitter_error",
        message: `Error en Twitter: ${error.message}`,
        icon: "warning",
      });
    }

    // 4. Publicar directamente via Meta API si está conectado
    try {
      if (isMetaConnected()) {
        this.emit("detail", {
          step: "publishing",
          sub: "meta",
          message: "Publicando en Facebook e Instagram (Meta API directa)...",
          icon: "send",
        });
        const metaResults = await publishToAllMeta({
          title,
          content,
          imageUrl: imageDriveUrl,
          imagePath: flyerPath,
        });
        if (metaResults.errors.length > 0) {
          metaResults.errors.forEach((e) => {
            errors.push(`Meta ${e.platform} (${e.pageName || e.accountName}): ${e.error}`);
          });
        }
        const fbCount = metaResults.facebook.length;
        const igCount = metaResults.instagram.length;
        if (fbCount > 0 || igCount > 0) {
          this.emit("detail", {
            step: "publishing",
            sub: "meta_done",
            message: `Publicado en Meta: ${fbCount} Facebook Page(s), ${igCount} Instagram`,
            icon: "check",
          });
        }
      }
    } catch (error) {
      errors.push(`Meta API: ${error.message}`);
    }

    // Persistir publicación en DB
    const dbPublication = createPublication({
      title,
      content,
      imagePath: flyerPath,
      imageUrl: imageDriveUrl || null,
      source: "pipeline",
      publishResults: { errors },
    });
    this.io.emit("history-new-publication", dbPublication);

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
