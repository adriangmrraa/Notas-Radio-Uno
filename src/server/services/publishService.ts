/**
 * publishService.ts — Servicio de publicación reutilizable
 *
 * Extrae la lógica de publicación multicanal del pipeline para que pueda ser
 * invocada tanto por el pipeline automático como por el copiloto editorial
 * (aprobación manual desde la cola de revisión).
 *
 * Canales soportados:
 *   1. Google Drive (opcional, requiere credenciales de env)
 *   2. Webhook Make/N8N (opcional, requiere configuración en DB/env)
 *   3. Twitter (opcional, requiere token configurado)
 *   4. Meta API — Facebook + Instagram (opcional, requiere conexión Meta activa)
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { postTweetNuevoBoton } from "./twitterService.js";
import { publishToAllMeta } from "./metaPublishService.js";
import { isMetaConnected, getSetting, updatePublicationStatus } from "./databaseService.js";
import { limiters } from "./rateLimiter.js";
import type { MetaPublishResults } from "../../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

async function getWebhookPipelineUrl(): Promise<string> {
  return (await getSetting("webhook_pipeline")) || process.env.WEBHOOK_URL_PIPELINE || "";
}

async function authorizeGoogleDrive(): Promise<InstanceType<typeof google.auth.JWT>> {
  const client_email = process.env.GOOGLE_CLIENT_EMAIL;
  const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!client_email || !private_key) {
    throw new Error("Credenciales de Google Drive no configuradas");
  }
  return new google.auth.JWT(
    client_email,
    undefined,
    private_key,
    ["https://www.googleapis.com/auth/drive.file"],
  );
}

async function uploadToGoogleDrive(
  auth: InstanceType<typeof google.auth.JWT>,
  filePath: string,
): Promise<string> {
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

// ---------------------------------------------------------------------------
// Función principal exportada
// ---------------------------------------------------------------------------

export interface PublishInput {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  imagePath?: string | null;
  imageUrl?: string | null;
}

export interface PublishResult {
  webhookSent: boolean;
  metaResults: MetaPublishResults | null;
  twitterSent: boolean;
  driveUrl: string;
  errors: string[];
}

/**
 * Publica una nota aprobada en todos los canales configurados.
 * Al finalizar con éxito actualiza el estado a 'published' en la base de datos.
 */
export async function publishToChannels(input: PublishInput): Promise<PublishResult> {
  const errors: string[] = [];
  let driveUrl = input.imageUrl || "";
  let webhookSent = false;
  let twitterSent = false;
  let metaResults: MetaPublishResults | null = null;

  // 1. Google Drive (opcional)
  if (input.imagePath) {
    try {
      const auth = await authorizeGoogleDrive();
      driveUrl = await uploadToGoogleDrive(auth, input.imagePath);
      console.log(`[PublishService] Imagen subida a Google Drive: ${driveUrl}`);
    } catch (err) {
      const e = err as Error;
      errors.push(`Google Drive: ${e.message}`);
      console.warn(`[PublishService] Google Drive no disponible: ${e.message}`);
    }
  }

  // 2. Webhook Make/N8N (opcional)
  const webhookUrl = await getWebhookPipelineUrl();
  if (webhookUrl) {
    try {
      await axios.post(webhookUrl, {
        title: input.title,
        datePublished: new Date().toISOString(),
        content: input.content,
        imageUrl: driveUrl,
        linkUrl: driveUrl,
        imageDriveUrl: driveUrl,
        source: "pipeline-review",
      });
      webhookSent = true;
      console.log(`[PublishService] Webhook enviado correctamente`);
    } catch (err) {
      const e = err as Error;
      errors.push(`Webhook: ${e.message}`);
    }
  }

  // 3. Twitter (opcional)
  if (driveUrl) {
    try {
      await postTweetNuevoBoton(input.title, driveUrl);
      twitterSent = true;
      console.log(`[PublishService] Publicado en Twitter`);
    } catch (err) {
      const e = err as Error;
      errors.push(`Twitter: ${e.message}`);
    }
  }

  // 4. Meta API — Facebook + Instagram (opcional)
  try {
    if (await isMetaConnected(input.tenantId)) {
      metaResults = await publishToAllMeta({
        title: input.title,
        content: input.content,
        imageUrl: driveUrl,
        imagePath: input.imagePath || undefined,
      });
      if (metaResults.errors.length > 0) {
        metaResults.errors.forEach((e: { platform?: string; pageName?: string; accountName?: string; error?: string }) => {
          errors.push(`Meta ${e.platform} (${e.pageName || e.accountName}): ${e.error}`);
        });
      }
      console.log(
        `[PublishService] Meta: ${metaResults.facebook.length} Facebook, ${metaResults.instagram.length} Instagram`,
      );
    }
  } catch (err) {
    const e = err as Error;
    errors.push(`Meta API: ${e.message}`);
  }

  // 5. Marcar como publicado en DB
  await updatePublicationStatus(input.id, input.tenantId, 'published');

  if (errors.length > 0) {
    console.warn("[PublishService] Errores no fatales durante publicación:", errors);
  }

  return { webhookSent, metaResults, twitterSent, driveUrl, errors };
}
