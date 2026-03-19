import { captureAudioSegment, transcribeAudio, detectSourceType } from "./transcriptionService.js";
import { extractInsights } from "./insightService.js";
import { searchAndEnrich } from "./searchService.js";
import { generateNewsCopy, generateTitle } from "./newsService.js";
import { processImage } from "./imageService.js";
import { postTweetNuevoBoton } from "./twitterService.js";
import { publishToAllMeta } from "./metaPublishService.js";
import { isMetaConnected, createPublication, createTranscription, getSetting } from "./databaseService.js";
import { analyzeTopicSegments, extractSegmentText } from "./topicService.js";
import { isDuplicateTopic, isTopicInSession } from "./deduplicationService.js";
import { limiters } from "./rateLimiter.js";
import { google } from "googleapis";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { v4 as uuidv4 } from "uuid";

import type { Server } from "socket.io";
import type {
  PipelineConfig,
  PipelineStatus,
  PublishedNote,
  TranscriptionChunk,
  TopicSegment,
  TopicAnalysisResult,
  Insights,
  SearchResult,
  MetaPublishResults,
} from "../../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const outputDir = path.join(PROJECT_ROOT, "output");

// Webhooks: configurable via DB settings, then .env, then empty
function getWebhookPipelineUrl(): string {
  return getSetting("webhook_pipeline") || process.env.WEBHOOK_URL_PIPELINE || "";
}

/**
 * Clase principal del pipeline autónomo.
 *
 * Arquitectura de captura continua sin cortes:
 *   - Mientras un chunk se transcribe, el siguiente ya se está grabando (paralelo)
 *   - No se pierde ni un segundo de audio
 *   - La transcripción completa se acumula cronológicamente
 *
 * Segmentación inteligente por temas:
 *   - Cada N chunks, IA analiza la transcripción acumulada
 *   - Detecta temas/segmentos distintos
 *   - Publica solo cuando un tema CONCLUYÓ (pasaron a otro asunto)
 *   - Decide cuántas notas/placas hacer por cada tema
 *   - No usa intervalos fijos; es 100% basado en contenido
 */
class AutoPipeline {
  private io: Server;
  public running: boolean;
  public config: PipelineConfig;
  private fullTranscription: string;
  private chunks: TranscriptionChunk[];
  private publishedTopics: string[];
  public publishedNotes: PublishedNote[];
  private pendingConfirmation: string[];
  private chunksPerAnalysis: number;
  private chunksSinceLastAnalysis: number;
  private currentStep: string;
  private captureTimeout: ReturnType<typeof setTimeout> | null;
  private publishingInProgress: boolean;
  private previousAnalysisContext: string;
  private lastAnalyzedChunkIndex: number;

  constructor(io: Server) {
    this.io = io;
    this.running = false;
    this.config = {
      url: "",
      tone: "formal",
      structure: "completa",
      imageModel: "gemini",
      segmentDuration: 120,
      autoPublish: true,
    };

    // Complete accumulated transcription (entire broadcast)
    this.fullTranscription = "";
    // Individual chunks with timestamps
    this.chunks = [];
    // Already-published topics (to avoid repeats)
    this.publishedTopics = [];
    this.publishedNotes = [];
    // Topics pending confirmation (detected as "completed" but unconfirmed)
    this.pendingConfirmation = [];
    // How many chunks between each topic analysis
    this.chunksPerAnalysis = 3;
    this.chunksSinceLastAnalysis = 0;
    // State
    this.currentStep = "idle";
    this.captureTimeout = null;
    // Publishing in progress flag (to not block capture)
    this.publishingInProgress = false;
    // Context from previous analyses for smarter decisions
    this.previousAnalysisContext = "";
    // Track which chunk index was last analyzed
    this.lastAnalyzedChunkIndex = 0;
  }

  private emit(event: string, data: Record<string, unknown>): void {
    this.io.emit("pipeline-update", {
      event,
      timestamp: new Date().toISOString(),
      ...data,
    });
    console.log(`[Pipeline] ${event}:`, JSON.stringify(data).slice(0, 200));
  }

  async start(config: Partial<PipelineConfig>): Promise<void> {
    if (this.running) {
      throw new Error("El pipeline ya está en ejecución.");
    }

    this.config = { ...this.config, ...config };
    this.running = true;
    this.fullTranscription = "";
    this.chunks = [];
    this.publishedTopics = [];
    this.pendingConfirmation = [];
    this.chunksSinceLastAnalysis = 0;
    this.currentStep = "starting";

    const sourceType = detectSourceType(this.config.url);
    this.emit("started", {
      url: this.config.url,
      sourceType,
      tone: this.config.tone,
      structure: this.config.structure,
      mode: "continuous-smart",
    });

    this.emit("detail", {
      step: "capturing",
      sub: "mode",
      message: "Modo inteligente: captura continua sin cortes + segmentación por temas con IA",
      icon: "brain",
    });

    // Start continuous capture with overlap
    this.continuousCaptureLoop();
  }

  /**
   * Loop de captura continua CON OVERLAP.
   *
   * Arquitectura:
   *   Chunk 1: [=======GRAB=======][===TRANSCRIBE===]
   *   Chunk 2:                     [=======GRAB=======][===TRANSCRIBE===]
   *   Chunk 3:                                         [=======GRAB=======]...
   *
   * Mientras se transcribe el chunk N, el chunk N+1 ya se está grabando.
   * No se pierde ni un segundo de audio.
   */
  private async continuousCaptureLoop(): Promise<void> {
    let chunkNumber = 0;
    let pendingTranscription: Promise<TranscriptionChunk | null> | null = null;

    while (this.running) {
      try {
        chunkNumber++;

        // --- CAPTURE AUDIO ---
        this.currentStep = "capturing";
        if (chunkNumber === 1) {
          this.emit("step", { step: "capturing", message: "Capturando audio..." });
          this.emit("detail", {
            step: "capturing", sub: "connecting",
            message: `Conectando al stream: ${this.config.url.slice(0, 60)}...`,
            icon: "satellite",
          });
        }

        this.emit("detail", {
          step: "capturing", sub: "recording",
          message: `Chunk #${chunkNumber}: grabando ${this.config.segmentDuration}s de audio...`,
          icon: "mic",
        });

        // Capture audio for this chunk
        const { filePath } = await captureAudioSegment(
          this.config.url,
          this.config.segmentDuration,
        );
        if (!this.running) break;

        this.emit("detail", {
          step: "capturing", sub: "audio_captured",
          message: `Chunk #${chunkNumber} capturado (${this.config.segmentDuration}s)`,
          icon: "check",
        });

        // --- RESOLVE PREVIOUS TRANSCRIPTION (if any) ---
        if (pendingTranscription) {
          this.emit("detail", {
            step: "capturing", sub: "waiting_prev",
            message: `Esperando transcripción del chunk #${chunkNumber - 1}...`,
            icon: "clock",
          });

          const prevResult = await pendingTranscription;
          if (prevResult && this.running) {
            this.onChunkTranscribed(prevResult, chunkNumber - 1);
          }
        }

        // --- TRANSCRIBE IN BACKGROUND ---
        // Launch transcription (NO await, resolved in next cycle)
        this.emit("detail", {
          step: "capturing", sub: "transcribing",
          message: `Transcribiendo chunk #${chunkNumber} con Whisper (en paralelo con próxima captura)...`,
          icon: "brain",
        });

        const currentFilePath = filePath;
        const currentChunkNumber = chunkNumber;
        pendingTranscription = transcribeAudio(currentFilePath).then((text): TranscriptionChunk => {
          try { fs.unlinkSync(currentFilePath); } catch (_) { /* ignore */ }
          return { text, timestamp: new Date().toISOString(), chunkNumber: currentChunkNumber };
        }).catch((error: Error): null => {
          this.emit("detail", {
            step: "capturing", sub: "transcribe_error",
            message: `Error transcribiendo chunk #${currentChunkNumber}: ${error.message}`,
            icon: "warning",
          });
          try { fs.unlinkSync(currentFilePath); } catch (_) { /* ignore */ }
          return null;
        });

      } catch (error) {
        const err = error as Error;
        this.emit("error", { step: "capturing", message: err.message });
        this.emit("detail", {
          step: "capturing", sub: "retry",
          message: `Error en captura: ${err.message}. Reintentando en 5s...`,
          icon: "warning",
        });
        if (this.running) await this.sleep(5000);
      }
    }

    // Resolve last pending transcription
    if (pendingTranscription) {
      const lastResult = await pendingTranscription;
      if (lastResult) this.onChunkTranscribed(lastResult, chunkNumber);
    }
  }

  /**
   * Callback cuando un chunk se transcribe exitosamente.
   * Acumula la transcripción y decide si analizar temas.
   */
  private onChunkTranscribed(result: TranscriptionChunk, chunkNumber: number): void {
    // Accumulate full transcription
    this.fullTranscription += (this.fullTranscription ? " " : "") + result.text;
    this.chunks.push(result);

    // Persist in DB
    const dbTranscription = createTranscription({
      text: result.text,
      source: "pipeline",
      durationSeconds: this.config.segmentDuration,
    });
    this.io.emit("history-new-transcription", dbTranscription);

    this.emit("detail", {
      step: "capturing", sub: "transcription_done",
      message: `Chunk #${chunkNumber} transcrito: "${result.text.slice(0, 80)}${result.text.length > 80 ? "..." : ""}"`,
      icon: "check",
    });

    this.emit("transcription", {
      step: "transcribed",
      text: result.text,
      timestamp: result.timestamp,
      bufferSize: this.chunks.length,
      totalMinutes: Math.round((this.chunks.length * this.config.segmentDuration) / 60),
    });

    // Increment counter and check if it's time to analyze topics
    this.chunksSinceLastAnalysis++;

    if (this.chunksSinceLastAnalysis >= this.chunksPerAnalysis && !this.publishingInProgress) {
      this.chunksSinceLastAnalysis = 0;
      // Launch analysis in background (fire-and-forget, NEVER blocks capture)
      this.analyzeAndPublish().catch((err: Error) => {
        console.error("[Pipeline] Error no capturado en analyzeAndPublish:", err.message);
        this.publishingInProgress = false;
      });
    }
  }

  /**
   * Analiza temas con IA y publica si hay temas completados.
   * Se ejecuta en background, NUNCA bloquea la captura.
   * Cuando termina, verifica si llegaron chunks nuevos y re-analiza.
   */
  private async analyzeAndPublish(): Promise<void> {
    if (this.publishingInProgress) return;

    try {
      // --- TOPIC ANALYSIS ---
      this.currentStep = "analyzing";
      const analysisStartChunkIndex = this.chunks.length;
      const latestChunk = this.chunks[this.chunks.length - 1]?.text || "";

      this.emit("step", { step: "analyzing", message: "Analizando estructura temática..." });

      const totalMinutes = Math.round((this.chunks.length * this.config.segmentDuration) / 60);
      const newChunksSince = analysisStartChunkIndex - this.lastAnalyzedChunkIndex;
      this.emit("detail", {
        step: "analyzing", sub: "topic_analysis",
        message: `Analizando ${totalMinutes} min de transcripción (${newChunksSince} chunks nuevos, ${this.fullTranscription.length} caracteres)...`,
        icon: "brain",
      });

      const analysis: TopicAnalysisResult = await analyzeTopicSegments(
        this.fullTranscription,
        latestChunk,
        this.publishedTopics,
        this.pendingConfirmation,
      );

      this.lastAnalyzedChunkIndex = analysisStartChunkIndex;

      // Report detected segments
      for (const seg of analysis.segments) {
        const statusIcon = seg.status === "completed" ? "check" : "clock";
        const newsworthyText = seg.newsworthy ? " [noticioso]" : " [no noticioso]";
        const confidenceText = seg.confidence ? ` (confianza: ${seg.confidence})` : "";
        this.emit("detail", {
          step: "analyzing", sub: "segment",
          message: `Tema: "${seg.topic}" - ${seg.status === "completed" ? "COMPLETADO" : "en curso"}${newsworthyText}${confidenceText}`,
          icon: statusIcon,
        });
      }

      // Report retaken topics (avoided false positives)
      if (analysis.retakenTopics && analysis.retakenTopics.length > 0) {
        for (const topic of analysis.retakenTopics) {
          this.emit("detail", {
            step: "analyzing", sub: "retaken",
            message: `Tema "${topic}" retomado por los hablantes - era solo un desvío temporal, no se publica`,
            icon: "info",
          });
        }
      }

      // Report topics pending confirmation
      if (analysis.newPendingConfirmation && analysis.newPendingConfirmation.length > 0) {
        for (const topic of analysis.newPendingConfirmation) {
          this.emit("detail", {
            step: "analyzing", sub: "pending",
            message: `Tema "${topic}" posiblemente completado - esperando confirmación en el próximo análisis`,
            icon: "clock",
          });
        }
      }

      // Update pending confirmation list
      this.pendingConfirmation = analysis.newPendingConfirmation || [];

      if (analysis.ongoingTopic) {
        this.emit("detail", {
          step: "analyzing", sub: "ongoing",
          message: `Tema en curso: "${analysis.ongoingTopic}" - seguimos escuchando...`,
          icon: "clock",
        });
      }

      this.emit("detail", {
        step: "analyzing", sub: "recommendation",
        message: `Decisión: ${analysis.recommendation === "publish" ? "PUBLICAR" : "ESPERAR"} - ${analysis.reason}`,
        icon: analysis.recommendation === "publish" ? "rocket" : "clock",
      });

      // --- PUBLISH IF THERE ARE CONFIRMED TOPICS ---
      if (analysis.recommendation === "publish" && analysis.completedSegments.length > 0) {
        this.publishingInProgress = true;

        this.emit("detail", {
          step: "analyzing", sub: "publishing_start",
          message: `${analysis.completedSegments.length} tema(s) completado(s) detectado(s). Generando notas...`,
          icon: "rocket",
        });

        for (const segment of analysis.completedSegments) {
          if (!this.running) break;
          try {
            await this.processTopicSegment(segment);
            this.publishedTopics.push(segment.topic);
          } catch (error) {
            const err = error as Error;
            this.emit("error", {
              step: "generating",
              message: `Error procesando tema "${segment.topic}": ${err.message}`,
            });
          }
        }

        this.publishingInProgress = false;
      }

      // Save analysis context for next round
      const publishedSummary = analysis.completedSegments.map((s: TopicSegment) => s.topic).join(", ");
      if (publishedSummary) {
        this.previousAnalysisContext += `\nTemas publicados: ${publishedSummary}.`;
      }

      // Return to capture state
      this.currentStep = "capturing";
      const updatedMinutes = Math.round((this.chunks.length * this.config.segmentDuration) / 60);
      this.emit("step", {
        step: "capturing",
        message: `Escuchando... (${updatedMinutes} min capturados, ${this.publishedNotes.length} notas publicadas)`,
      });

      // Check if new chunks arrived while we were analyzing/publishing - re-trigger
      const newChunksWhileProcessing = this.chunks.length - analysisStartChunkIndex;
      if (newChunksWhileProcessing >= this.chunksPerAnalysis && this.running) {
        this.emit("detail", {
          step: "capturing", sub: "reanalysis",
          message: `${newChunksWhileProcessing} chunks nuevos llegaron durante el procesamiento. Re-analizando...`,
          icon: "brain",
        });
        this.chunksSinceLastAnalysis = 0;
        // Re-trigger analysis (recursive but async, won't stack)
        await this.analyzeAndPublish();
      }

    } catch (error) {
      this.publishingInProgress = false;
      const err = error as Error;
      this.emit("error", { step: "analyzing", message: err.message });
      this.currentStep = "capturing";
    }
  }

  /**
   * Procesa un segmento temático completado: genera nota + placa + publica.
   */
  private async processTopicSegment(segment: TopicSegment): Promise<void> {
    // --- DUPLICATE DETECTION ---
    // Check against current session
    if (isTopicInSession(segment.topic, this.publishedTopics)) {
      this.emit("detail", {
        step: "analyzing", sub: "duplicate_session",
        message: `Tema "${segment.topic}" ya publicado en esta sesión. Saltando.`,
        icon: "info",
      });
      return;
    }

    // Check against DB (publications from last 24 hours)
    const dupCheck = isDuplicateTopic(segment.topic, segment.summary);
    if (dupCheck.isDuplicate) {
      const matchedAt = dupCheck.matchedPublication?.created_at;
      const hoursAgo = matchedAt
        ? Math.round((Date.now() - new Date(matchedAt).getTime()) / 3600000)
        : 0;
      this.emit("detail", {
        step: "analyzing", sub: "duplicate_db",
        message: `Tema duplicado: "${segment.topic}" ya publicado como "${dupCheck.matchedPublication?.title}" hace ${hoursAgo}h (similitud: ${Math.round(dupCheck.similarity * 100)}%). Saltando.`,
        icon: "info",
      });
      this.publishedTopics.push(segment.topic);
      return;
    }

    const segmentText = extractSegmentText(this.fullTranscription, segment);
    const transcriptionForNote = segmentText || segment.summary;

    // --- INSIGHTS ---
    this.emit("detail", {
      step: "analyzing", sub: "segment_insights",
      message: `Extrayendo insights del tema: "${segment.topic}"...`,
      icon: "brain",
    });

    const insights: Insights = await extractInsights(transcriptionForNote);

    // --- WEB SEARCH ---
    this.currentStep = "searching";
    this.emit("step", { step: "searching", message: `Investigando: "${segment.topic}"` });

    let webResults: SearchResult[] = [];
    if (insights.searchQueries.length > 0) {
      const hasGemini = !!process.env.GEMINI_API_KEY;
      this.emit("detail", {
        step: "searching", sub: "strategy",
        message: hasGemini
          ? "Usando Gemini con Google Search grounding (IA + búsqueda web integrada)"
          : "Usando búsqueda tradicional + scraping de artículos",
        icon: "brain",
      });
      for (const query of insights.searchQueries.slice(0, 3)) {
        this.emit("detail", {
          step: "searching", sub: "query",
          message: `Buscando: "${query}"`,
          icon: "search",
        });
      }
      webResults = await searchAndEnrich(insights.searchQueries);
      this.emit("detail", {
        step: "searching", sub: "results",
        message: `${webResults.length} fuentes encontradas y analizadas`,
        icon: webResults.length > 0 ? "check" : "info",
      });
    }

    const webContext = webResults
      .map((r) => `Fuente: ${r.title}\n${r.content || r.snippet}`)
      .join("\n\n---\n\n");

    // --- GENERATE NOTE ---
    this.currentStep = "generating";
    this.emit("step", { step: "generating", message: `Redactando nota: "${segment.topic}"` });

    this.emit("detail", {
      step: "generating", sub: "calling_ai",
      message: `Generando nota con tono "${this.config.tone}" y estructura "${this.config.structure}"...`,
      icon: "brain",
    });

    const newsText = await generateNewsCopy({
      transcription: transcriptionForNote,
      tone: this.config.tone,
      structure: this.config.structure,
      webContext,
      insights: `Resumen: ${insights.summary}\nDatos clave: ${insights.keyFacts.join(", ")}`,
    });

    this.emit("detail", {
      step: "generating", sub: "generating_title",
      message: "Generando título periodístico...",
      icon: "brain",
    });

    const title = await generateTitle(transcriptionForNote, insights.summary);

    this.emit("detail", {
      step: "generating", sub: "title_ready",
      message: `Título: "${title}"`,
      icon: "check",
    });

    this.emit("note", { step: "note_generated", title, content: newsText });

    // --- GENERATE FLYER ---
    this.currentStep = "creating_flyer";
    this.emit("step", { step: "creating_flyer", message: `Creando placa: "${title}"` });

    this.emit("detail", {
      step: "creating_flyer", sub: "strategy",
      message: "Buscando imagen de fondo...",
      icon: "image",
    });

    const flyerPath = await this.generateFlyer(title, webResults, insights);

    this.emit("detail", {
      step: "creating_flyer", sub: "overlay",
      message: "Aplicando overlay: resize 1080x1080, gradiente, título, logo...",
      icon: "layers",
    });

    this.emit("flyer", {
      step: "flyer_created",
      path: flyerPath,
      previewUrl: `/output/${path.basename(flyerPath)}`,
    });

    // --- PUBLISH ---
    if (this.config.autoPublish) {
      this.currentStep = "publishing";
      this.emit("step", { step: "publishing", message: `Publicando: "${title}"` });

      this.emit("detail", {
        step: "publishing", sub: "google_drive",
        message: "Subiendo imagen a Google Drive...",
        icon: "upload",
      });

      await this.publish(title, newsText, flyerPath);

      this.publishedNotes.push({
        title,
        content: newsText,
        flyerPath,
        topic: segment.topic,
        timestamp: new Date().toISOString(),
      });

      this.emit("published", {
        step: "published",
        title,
        topic: segment.topic,
        totalPublished: this.publishedNotes.length,
      });
    }
  }

  /**
   * Generar un flyer/placa informativa.
   *
   * Estrategia para la imagen de FONDO (en orden de prioridad):
   *   1. Imagen encontrada en artículos web scrapeados
   *   2. Imagen generada por IA basada en los insights
   *   3. Placeholder con gradiente de colores de Radio Uno
   *
   * El overlay (sombra + texto + logo) SIEMPRE lo aplica processImage()
   */
  private async generateFlyer(title: string, webResults: SearchResult[], insights: Insights): Promise<string> {
    let imagePath: string | null = null;

    // Strategy 1: Find image from scraped web articles
    for (const result of webResults) {
      if (result.scrapedImage && result.scrapedImage.startsWith("http")) {
        try {
          const response = await axios.get(result.scrapedImage, {
            responseType: "arraybuffer",
            timeout: 10000,
          });
          imagePath = path.join(outputDir, `temp_${uuidv4()}.jpg`);
          fs.writeFileSync(imagePath, Buffer.from(response.data as ArrayBuffer));
          this.emit("flyer_bg", { source: "web", url: result.scrapedImage });
          break;
        } catch (_) {
          // Continue with next image
        }
      }
    }

    // Strategy 2: Generate background with AI (if no web image found)
    if (!imagePath) {
      imagePath = await this.generateAIBackground(title, insights, webResults);
    }

    // Strategy 3: Placeholder if everything else failed
    if (!imagePath) {
      imagePath = await this.createPlaceholderImage();
      this.emit("flyer_bg", { source: "placeholder" });
    }

    // processImage() ALWAYS applies the same overlay:
    // - Resize to 1080x1080
    // - Dark gradient from bottom to top
    // - Semi-transparent black box with title (Bebas Kai 70px)
    // - "Radio Uno Formosa" centered (Bebas Kai 30px)
    // - Logo 150px in top-right corner
    const finalPath = await processImage(imagePath, title);

    // Clean up temp background image
    try { fs.unlinkSync(imagePath); } catch (_) { /* ignore */ }

    return finalPath;
  }

  /**
   * Genera una imagen de fondo usando IA.
   * Usa el modelo seleccionado por el usuario: "gemini" (Google Imagen) o "grok" (xAI).
   * Retorna la ruta al archivo generado, o null si no hay API configurada.
   */
  private async generateAIBackground(title: string, insights: Insights, webResults: SearchResult[]): Promise<string | null> {
    const prompt = this.buildImagePrompt(title, insights, webResults);
    const selectedModel = this.config.imageModel || "gemini";

    this.emit("flyer_bg", {
      source: "ai_generating",
      model: selectedModel,
      prompt: prompt.slice(0, 150),
    });

    // Try selected model first, fallback to the other
    const strategies: Array<() => Promise<string | null>> = selectedModel === "gemini"
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
   */
  private async generateWithGemini(prompt: string): Promise<string | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    try {
      await limiters.imageGen.acquire();

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

      const prediction = response.data.predictions?.[0] as { bytesBase64Encoded?: string } | undefined;
      if (!prediction?.bytesBase64Encoded) {
        console.error("[Pipeline] Gemini Imagen: respuesta sin imagen");
        return null;
      }

      const imagePath = path.join(outputDir, `ai_bg_gemini_${uuidv4()}.png`);
      fs.writeFileSync(imagePath, Buffer.from(prediction.bytesBase64Encoded, "base64"));
      this.emit("flyer_bg", { source: "gemini_imagen" });
      return imagePath;
    } catch (error) {
      const err = error as Error;
      console.error("[Pipeline] Error generando fondo con Gemini Imagen:", err.message);
      return null;
    }
  }

  /**
   * Genera imagen de fondo con xAI Grok Image.
   */
  private async generateWithGrok(prompt: string): Promise<string | null> {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) return null;

    try {
      await limiters.imageGen.acquire();

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

      const imageData = response.data.data?.[0] as { b64_json?: string; revised_prompt?: string } | undefined;
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
      const err = error as Error;
      console.error("[Pipeline] Error generando fondo con Grok Image:", err.message);
      return null;
    }
  }

  /**
   * Construye un prompt estratégico para la imagen de fondo basándose en:
   * - Título de la nota
   * - Insights extraídos (personas, temas, datos clave)
   * - Información del research web
   */
  private buildImagePrompt(title: string, insights: Insights, webResults: SearchResult[]): string {
    const parts: string[] = [];

    // Base: journalistic photography
    parts.push("Fotografía periodística profesional de alta calidad, estilo editorial de agencia de noticias.");

    // People mentioned: if there are politicians, public figures, they should appear
    if (insights?.people?.length > 0) {
      const people = insights.people.slice(0, 3).join(", ");
      parts.push(`La imagen debe mostrar o representar a: ${people}.`);
    }

    // Topics: map topics to concrete visual elements
    if (insights?.topics?.length > 0) {
      const topicVisuals = insights.topics.map((topic) => {
        const t = topic.toLowerCase();
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
        return topic;
      });
      parts.push(`Elementos visuales principales: ${topicVisuals.join(", ")}.`);
    }

    // Key facts: enrich visual context
    if (insights?.keyFacts?.length > 0) {
      const contextFact = insights.keyFacts[0];
      parts.push(`Contexto de la noticia: ${contextFact}.`);
    }

    // Web search info: extract geographic locations
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

    // Country/region detection for geographic visual reference
    const titleLower = title.toLowerCase();
    const geoMappings: Record<string, string> = {
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

    // Main topic of the news
    parts.push(`Tema de la noticia: "${title}".`);

    // Technical restrictions (ALWAYS)
    parts.push(
      "IMPORTANTE: La imagen NO debe contener texto, letras, palabras, logos, ni marcas de agua. " +
      "Debe ser una imagen limpia que funcione como fondo para una placa informativa de noticias. " +
      "Formato cuadrado 1:1. Colores que permitan superponer texto blanco con buena legibilidad.",
    );

    return parts.join(" ");
  }

  /**
   * Crea una imagen placeholder cuando no hay imagen web ni IA disponible.
   * Usa un gradiente con los colores de la marca Radio Uno.
   */
  private async createPlaceholderImage(): Promise<string> {
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(1080, 1080);
    const ctx = canvas.getContext("2d");

    // Background with dark blue gradient (Radio Uno colors)
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
  private async publish(title: string, content: string, flyerPath: string): Promise<void> {
    const errors: string[] = [];

    // 1. Upload image to Google Drive
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
      const err = error as Error;
      errors.push(`Google Drive: ${err.message}`);
      this.emit("detail", {
        step: "publishing",
        sub: "google_drive_error",
        message: `Error subiendo a Google Drive: ${err.message}`,
        icon: "warning",
      });
    }

    // 2. Publish via webhook (Make/N8N)
    this.emit("detail", {
      step: "publishing",
      sub: "webhook",
      message: "Enviando a webhook (Make.com/N8N)...",
      icon: "send",
    });
    const webhookUrl = getWebhookPipelineUrl();
    if (!webhookUrl) {
      this.emit("detail", {
        step: "publishing", sub: "webhook_skip",
        message: "Webhook no configurado, omitiendo envío.",
        icon: "info",
      });
    }
    try {
      if (!webhookUrl) throw new Error("Webhook no configurado");
      await axios.post(webhookUrl, {
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
      const err = error as Error;
      errors.push(`Webhook: ${err.message}`);
    }

    // 3. Publish on Twitter
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
      const err = error as Error;
      errors.push(`Twitter: ${err.message}`);
      this.emit("detail", {
        step: "publishing",
        sub: "twitter_error",
        message: `Error en Twitter: ${err.message}`,
        icon: "warning",
      });
    }

    // 4. Publish directly via Meta API if connected
    try {
      if (isMetaConnected()) {
        this.emit("detail", {
          step: "publishing",
          sub: "meta",
          message: "Publicando en Facebook e Instagram (Meta API directa)...",
          icon: "send",
        });
        const metaResults: MetaPublishResults = await publishToAllMeta({
          title,
          content,
          imageUrl: imageDriveUrl,
          imagePath: flyerPath,
        });
        if (metaResults.errors.length > 0) {
          metaResults.errors.forEach((e: { platform?: string; pageName?: string; accountName?: string; error?: string }) => {
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
      const err = error as Error;
      errors.push(`Meta API: ${err.message}`);
    }

    // Persist publication in DB
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

  private async authorizeGoogleDrive(): Promise<InstanceType<typeof google.auth.JWT>> {
    const client_email = process.env.GOOGLE_CLIENT_EMAIL;
    const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!client_email || !private_key) {
      throw new Error("Credenciales de Google Drive no configuradas");
    }
    const auth = new google.auth.JWT(
      client_email,
      undefined,
      private_key,
      ["https://www.googleapis.com/auth/drive.file"],
    );
    return auth;
  }

  private async uploadToGoogleDrive(auth: InstanceType<typeof google.auth.JWT>, filePath: string): Promise<string> {
    await limiters.googleDrive.acquire();
    const drive = google.drive({ version: "v3", auth });
    const folderId = process.env.GOOGLE_FOLDER_ID;

    const response = await drive.files.create({
      requestBody: {
        name: path.basename(filePath),
        parents: folderId ? [folderId] : [],
      },
      media: {
        mimeType: "image/jpeg",
        body: fs.createReadStream(filePath),
      },
      fields: "id, webContentLink",
    });

    return response.data.webContentLink || "";
  }

  /**
   * Detener el pipeline.
   */
  stop(): void {
    this.running = false;
    this.currentStep = "stopped";
    if (this.captureTimeout) {
      clearTimeout(this.captureTimeout);
    }
    const totalMinutes = Math.round((this.chunks.length * this.config.segmentDuration) / 60);
    this.emit("stopped", {
      totalPublished: this.publishedNotes.length,
      totalMinutes,
      publishedTopics: this.publishedTopics,
    });
  }

  /**
   * Obtener el estado actual del pipeline.
   */
  getStatus(): PipelineStatus {
    return {
      running: this.running,
      currentStep: this.currentStep,
      config: this.config,
      chunksTranscribed: this.chunks.length,
      totalMinutes: Math.round((this.chunks.length * this.config.segmentDuration) / 60),
      transcriptionLength: this.fullTranscription.length,
      publishedTopics: this.publishedTopics,
      totalPublished: this.publishedNotes.length,
      publishedNotes: this.publishedNotes.slice(-10),
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.captureTimeout = setTimeout(resolve, ms);
    });
  }
}

export { AutoPipeline };
