import axios from "axios";
import fs from "fs";
import type { MetaPublishResults } from "../../shared/types.js";
import { getCredential, getAssetsByType } from "./databaseService.js";
import { limiters } from "./rateLimiter.js";

/**
 * Servicio de publicación directa a Facebook Pages e Instagram.
 * Usa los tokens almacenados y encriptados en la DB para publicar
 * sin depender de webhooks externos (Make.com/N8N).
 *
 * Permisos requeridos:
 * - pages_manage_posts (publicar en Facebook Pages)
 * - instagram_content_publish (publicar en Instagram)
 * - instagram_basic (leer info de IG)
 */

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

interface FacebookPostParams {
  message: string;
  imageUrl?: string;
  imagePath?: string;
}

interface InstagramPostParams {
  caption: string;
  imageUrl: string;
}

interface PublishAllParams {
  title: string;
  content: string;
  imageUrl?: string;
  imagePath?: string;
}

interface FacebookPublishResult {
  id: string;
  platform: "facebook";
  pageId: string;
}

interface InstagramPublishResult {
  id: string;
  platform: "instagram";
  igAccountId: string;
}

/**
 * Publica en una Facebook Page específica.
 */
export async function publishToFacebookPage(
  pageId: string,
  { message, imageUrl, imagePath }: FacebookPostParams,
): Promise<FacebookPublishResult> {
  const pageToken = getCredential(`META_PAGE_TOKEN_${pageId}`);
  if (!pageToken) {
    throw new Error(`No hay token para la página ${pageId}`);
  }

  let result: { data: { id?: string; post_id?: string } };

  await limiters.metaApi.acquire();

  if (imageUrl || imagePath) {
    // Photo post
    if (imagePath && fs.existsSync(imagePath)) {
      // Upload image directly from local file
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("source", fs.createReadStream(imagePath));
      form.append("message", message);
      form.append("access_token", pageToken);

      result = await axios.post(
        `${GRAPH_API_BASE}/${pageId}/photos`,
        form,
        { headers: form.getHeaders(), timeout: 60000 },
      );
    } else if (imageUrl) {
      // Post with image URL (image must already be hosted)
      result = await axios.post(`${GRAPH_API_BASE}/${pageId}/photos`, {
        url: imageUrl,
        message,
        access_token: pageToken,
      }, { timeout: 30000 });
    } else {
      throw new Error("No se proporcionó una imagen válida");
    }
  } else {
    // Text-only post
    result = await axios.post(`${GRAPH_API_BASE}/${pageId}/feed`, {
      message,
      access_token: pageToken,
    }, { timeout: 30000 });
  }

  const postId = result.data.id || result.data.post_id || "";
  console.log(`[Meta] Publicado en Facebook Page ${pageId}: ${postId}`);

  return {
    id: postId,
    platform: "facebook",
    pageId,
  };
}

/**
 * Publica en Instagram Business Account.
 * Flujo de 2 pasos:
 *   1. Crear media container (con image_url)
 *   2. Publicar el container
 *
 * NOTA: Instagram API requiere que la imagen sea accesible via URL pública.
 */
export async function publishToInstagram(
  igAccountId: string,
  { caption, imageUrl }: InstagramPostParams,
): Promise<InstagramPublishResult> {
  if (!imageUrl) {
    throw new Error("Instagram requiere una URL de imagen pública para publicar");
  }

  const igToken = getCredential(`META_IG_TOKEN_${igAccountId}`);
  if (!igToken) {
    throw new Error(`No hay token para la cuenta Instagram ${igAccountId}`);
  }

  await limiters.metaApi.acquire();

  // Step 1: Create media container
  const containerResponse = await axios.post(
    `${GRAPH_API_BASE}/${igAccountId}/media`,
    {
      image_url: imageUrl,
      caption,
      access_token: igToken,
    },
    { timeout: 30000 },
  );

  const containerId: string = containerResponse.data.id;
  console.log(`[Meta] Container IG creado: ${containerId}`);

  // Wait for container to be ready
  await waitForContainerReady(igAccountId, containerId, igToken);

  // Step 2: Publish the container
  const publishResponse = await axios.post(
    `${GRAPH_API_BASE}/${igAccountId}/media_publish`,
    {
      creation_id: containerId,
      access_token: igToken,
    },
    { timeout: 30000 },
  );

  const mediaId: string = publishResponse.data.id;
  console.log(`[Meta] Publicado en Instagram ${igAccountId}: ${mediaId}`);

  return {
    id: mediaId,
    platform: "instagram",
    igAccountId,
  };
}

/**
 * Espera a que un media container de Instagram esté listo para publicar.
 * El container pasa por estados: IN_PROGRESS -> FINISHED (o ERROR).
 */
async function waitForContainerReady(
  _igAccountId: string,
  containerId: string,
  token: string,
  maxAttempts: number = 10,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const statusResponse = await axios.get(`${GRAPH_API_BASE}/${containerId}`, {
      params: {
        fields: "status_code",
        access_token: token,
      },
    });

    const status: string = statusResponse.data.status_code;

    if (status === "FINISHED") {
      return;
    }

    if (status === "ERROR") {
      throw new Error(`Error en media container de Instagram: ${containerId}`);
    }

    // Wait 2 seconds before retrying
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timeout esperando media container de Instagram: ${containerId}`);
}

/**
 * Publica en todas las plataformas Meta conectadas.
 * Usa los assets guardados en la DB.
 */
export async function publishToAllMeta({ title, content, imageUrl, imagePath }: PublishAllParams): Promise<MetaPublishResults> {
  const results: MetaPublishResults = {
    facebook: [],
    instagram: [],
    errors: [],
  };

  const message = `${title}\n\n${content}`;
  const caption = `${title}\n\n${content}`;

  // Publish to all active Facebook Pages
  const pages = getAssetsByType("facebook_page");
  for (const page of pages) {
    try {
      const fbResult = await publishToFacebookPage(page.external_id, {
        message,
        imageUrl,
        imagePath,
      });
      results.facebook.push(fbResult);
    } catch (error) {
      const err = error as Error;
      console.error(`[Meta] Error publicando en Facebook Page ${page.name}:`, err.message);
      results.errors.push({
        platform: "facebook",
        pageId: page.external_id,
        pageName: page.name,
        error: err.message,
      });
    }
  }

  // Publish to all active Instagram accounts
  const igAccounts = getAssetsByType("instagram_account");
  for (const ig of igAccounts) {
    try {
      // Instagram requires a public URL (no direct upload)
      if (!imageUrl) {
        results.errors.push({
          platform: "instagram",
          accountId: ig.external_id,
          accountName: ig.name,
          error: "Instagram requiere URL de imagen pública (imageUrl)",
        });
        continue;
      }

      const igResult = await publishToInstagram(ig.external_id, {
        caption,
        imageUrl,
      });
      results.instagram.push(igResult);
    } catch (error) {
      const err = error as Error;
      console.error(`[Meta] Error publicando en Instagram ${ig.name}:`, err.message);
      results.errors.push({
        platform: "instagram",
        accountId: ig.external_id,
        accountName: ig.name,
        error: err.message,
      });
    }
  }

  return results;
}
