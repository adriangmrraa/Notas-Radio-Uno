import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";
import type { Multer } from "multer";

import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { google } from "googleapis";

import { processImage } from "../services/imageService.js";
import { scrapeElComercialArticle as scrapeArticle } from "../services/scraperService.js";
import { generateNewsCopy } from "../services/newsService.js";
import { createPublication } from "../services/databaseService.js";
import { getConnectionStatus } from "../services/metaAuthService.js";
import { publishToAllMeta } from "../services/metaPublishService.js";
import {
  getWebhookNuevoBoton,
  getWebhookViejoBoton,
} from "./settings.js";

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const FOLDER_ID = process.env.GOOGLE_FOLDER_ID || "";

async function authorize(): Promise<InstanceType<typeof google.auth.JWT>> {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) {
    throw new Error("Google Drive credentials not configured in .env");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const auth = new google.auth.JWT(clientEmail, undefined, privateKey, SCOPES);
  return auth;
}

async function uploadFile(
  auth: InstanceType<typeof google.auth.JWT>,
  filePath: string,
): Promise<string> {
  const drive = google.drive({ version: "v3", auth });

  const fileMetadata = {
    name: path.basename(filePath),
    parents: [FOLDER_ID],
  };

  const media = {
    mimeType: "image/png",
    body: fs.createReadStream(filePath),
  };

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, webContentLink",
  });

  console.log("Archivo subido con exito a Google Drive");
  return response.data.webContentLink || "";
}

// ---------------------------------------------------------------------------
// Webhook sender
// ---------------------------------------------------------------------------
interface WebhookNote {
  title: string;
  datePublished: string;
  content: string;
  imageUrl: string;
  linkUrl: string;
  imageDriveUrl: string;
}

async function sendToWebhook(
  webhookUrl: string,
  note: WebhookNote,
): Promise<void> {
  try {
    console.log("Enviando datos al webhook...");
    await axios.post(webhookUrl, {
      title: note.title,
      datePublished: note.datePublished,
      content: note.content,
      imageUrl: note.imageUrl,
      linkUrl: note.linkUrl,
      imageDriveUrl: note.imageDriveUrl,
    });
    console.log("Webhook enviado con exito para la noticia:", note.title);
  } catch (error) {
    console.error("Error enviando datos al webhook:", error);
  }
}

// ---------------------------------------------------------------------------
// Meta publish helper (shared by both webhook endpoints)
// ---------------------------------------------------------------------------
interface MetaPublishParams {
  title: string;
  content: string;
  imageDriveUrl: string;
  finalImagePath: string;
}

async function tryPublishMeta(
  params: MetaPublishParams,
): Promise<unknown | null> {
  try {
    const metaStatus = getConnectionStatus();
    if (metaStatus.connected) {
      const metaResults = await publishToAllMeta({
        title: params.title,
        content: params.content,
        imageUrl: params.imageDriveUrl,
        imagePath: params.finalImagePath,
      });
      console.log("[Meta] Publicacion directa completada:", metaResults);
      return metaResults;
    }
  } catch (metaError) {
    const message =
      metaError instanceof Error ? metaError.message : String(metaError);
    console.error("Error publicando en Meta:", message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerGenerateRoutes(
  app: Express,
  io: Server,
  upload: Multer,
): void {
  // ------------------------------------------------------------------
  // POST /api/generate - Upload image + title -> process -> respond
  // ------------------------------------------------------------------
  app.post(
    "/api/generate",
    upload.single("image"),
    async (req: Request, res: Response) => {
      if (!req.file) {
        res.status(400).json({ error: "Se requiere una imagen." });
        return;
      }

      const { title, description } = req.body as {
        title?: string;
        description?: string;
      };

      if (!title) {
        res.status(400).json({ error: "Se requiere un titulo." });
        return;
      }

      const imagePath = req.file.path;

      try {
        const finalImagePath = await processImage(imagePath, title);

        // Upload to Google Drive
        const auth = await authorize();
        await uploadFile(auth, finalImagePath);

        res.json({
          imageUrl: `/output/${path.basename(finalImagePath)}`,
          title,
          description,
          finalImagePath,
        });
      } catch (error) {
        console.error("Error al procesar la imagen:", error);
        res.status(500).json({ error: "Error al procesar la imagen" });
      }
    },
  );

  // ------------------------------------------------------------------
  // POST /api/generate-from-url - Scrape URL -> generate placa
  // ------------------------------------------------------------------
  app.post("/api/generate-from-url", async (req: Request, res: Response) => {
    const { url } = req.body as { url?: string };

    if (!url) {
      res.status(400).json({ error: "Se requiere una URL." });
      return;
    }

    try {
      const articleData = await scrapeArticle(url);

      const imageResponse = await axios.get(articleData.imageUrl || "", {
        responseType: "arraybuffer",
      });
      const buffer = Buffer.from(imageResponse.data as ArrayBuffer);
      const imagePath = path.join("output", `temp_${uuidv4()}.jpg`);
      fs.writeFileSync(imagePath, buffer);

      const finalImagePath = await processImage(imagePath, articleData.title);
      const imageUrl = `/output/${path.basename(finalImagePath)}`;

      res.json({
        imageUrl,
        title: articleData.title,
        content: articleData.content,
        finalImagePath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error al generar la placa:", message);
      res.status(500).json({ error: message });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/sendWebhook - Viejo boton
  // ------------------------------------------------------------------
  app.post("/api/sendWebhook", async (req: Request, res: Response) => {
    const { title, description, imageUrl, finalImagePath } = req.body as {
      title?: string;
      description?: string;
      imageUrl?: string;
      finalImagePath?: string;
    };

    if (!finalImagePath) {
      res.status(400).json({ error: "finalImagePath is required." });
      return;
    }

    if (!title) {
      res.status(400).json({ error: "Se requiere un titulo." });
      return;
    }

    try {
      const auth = await authorize();
      const imageDriveUrl = await uploadFile(auth, finalImagePath);
      console.log("Imagen subida a Google Drive. URL:", imageDriveUrl);

      const note: WebhookNote = {
        title,
        datePublished: new Date().toISOString(),
        content: description || "",
        imageUrl: imageUrl || "",
        linkUrl: imageDriveUrl,
        imageDriveUrl,
      };

      const webhookViejoUrl = getWebhookViejoBoton();
      if (webhookViejoUrl) {
        await sendToWebhook(webhookViejoUrl, note);
      }

      // Publish via Meta API if connected
      const metaResults = await tryPublishMeta({
        title,
        content: description || "",
        imageDriveUrl,
        finalImagePath,
      });

      // Persist publication
      const publication = createPublication({
        title,
        content: description || "",
        imagePath: finalImagePath,
        imageUrl: imageDriveUrl,
        source: "manual",
        publishResults: metaResults,
      });
      io.emit("history-new-publication", publication);

      res.json({
        success: true,
        message: "Webhook enviado con exito.",
        metaResults,
        publication,
      });
    } catch (error) {
      console.error("Error al enviar el webhook:", error);
      res.status(500).json({ error: "Error al enviar el webhook." });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/sendWebhookNuevoBoton
  // ------------------------------------------------------------------
  app.post("/api/sendWebhookNuevoBoton", async (req: Request, res: Response) => {
    const { title, content, imageUrl, finalImagePath } = req.body as {
      title?: string;
      content?: string;
      imageUrl?: string;
      finalImagePath?: string;
    };

    if (!finalImagePath) {
      res.status(400).json({ error: "finalImagePath is required." });
      return;
    }

    if (!title) {
      res.status(400).json({ error: "Se requiere un titulo." });
      return;
    }

    try {
      const auth = await authorize();
      const imageDriveUrl = await uploadFile(auth, finalImagePath);
      console.log("Imagen subida a Google Drive. URL:", imageDriveUrl);

      const webhookData: WebhookNote = {
        title,
        datePublished: new Date().toISOString(),
        content: content || "",
        imageUrl: imageDriveUrl,
        linkUrl: imageDriveUrl,
        imageDriveUrl,
      };

      const webhookNuevoUrl = getWebhookNuevoBoton();
      if (webhookNuevoUrl) {
        await sendToWebhook(webhookNuevoUrl, webhookData);
      }

      // Publish via Meta API if connected
      const metaResults = await tryPublishMeta({
        title,
        content: content || "",
        imageDriveUrl,
        finalImagePath,
      });

      // Persist publication
      const publication = createPublication({
        title,
        content: content || "",
        imagePath: finalImagePath,
        imageUrl: imageDriveUrl,
        source: "url",
        publishResults: metaResults,
      });
      io.emit("history-new-publication", publication);

      res.json({
        success: true,
        message: "Webhook enviado con exito (Nuevo Boton)",
        metaResults,
        publication,
      });
    } catch (error) {
      console.error("Error al enviar el webhook (Nuevo Boton):", error);
      res.status(500).json({ error: "Error al enviar el webhook (Nuevo Boton)" });
    }
  });

  // ------------------------------------------------------------------
  // POST /api/generateNewsCopy
  // ------------------------------------------------------------------
  app.post("/api/generateNewsCopy", async (req: Request, res: Response) => {
    const { context, transcription } = req.body as {
      context?: string;
      transcription?: string;
    };

    if (!context && !transcription) {
      res.status(400).json({ error: "Se requiere context o transcription." });
      return;
    }

    try {
      const generatedCopy = await generateNewsCopy(
        context || "",
        transcription || "",
      );
      res.setHeader("Content-Type", "application/json");
      res.json({ generatedCopy });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Error al generar la nota:", message);
      res.setHeader("Content-Type", "application/json");
      res.status(500).json({ error: "Error al generar la nota: " + message });
    }
  });
}
