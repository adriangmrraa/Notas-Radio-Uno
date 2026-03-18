import axios from "axios";
import fs from "fs";
import { getCredential, getAssetsByType } from "./databaseService.js";

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

/**
 * Publica en una Facebook Page específica.
 *
 * @param {string} pageId - ID de la Facebook Page
 * @param {object} post - { message, imageUrl?, imagePath? }
 * @returns {object} - { id, postUrl }
 */
export async function publishToFacebookPage(pageId, { message, imageUrl, imagePath }) {
  const pageToken = getCredential(`META_PAGE_TOKEN_${pageId}`);
  if (!pageToken) {
    throw new Error(`No hay token para la página ${pageId}`);
  }

  let result;

  if (imageUrl || imagePath) {
    // Publicación con foto
    if (imagePath && fs.existsSync(imagePath)) {
      // Subir imagen directamente desde archivo local
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("source", fs.createReadStream(imagePath));
      form.append("message", message);
      form.append("access_token", pageToken);

      result = await axios.post(
        `${GRAPH_API_BASE}/${pageId}/photos`,
        form,
        { headers: form.getHeaders(), timeout: 60000 }
      );
    } else if (imageUrl) {
      // Publicar con URL de imagen (la imagen ya debe estar hospedada)
      result = await axios.post(`${GRAPH_API_BASE}/${pageId}/photos`, {
        url: imageUrl,
        message,
        access_token: pageToken,
      }, { timeout: 30000 });
    }
  } else {
    // Publicación solo texto
    result = await axios.post(`${GRAPH_API_BASE}/${pageId}/feed`, {
      message,
      access_token: pageToken,
    }, { timeout: 30000 });
  }

  const postId = result.data.id || result.data.post_id;
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
 * No acepta upload directo de archivos.
 *
 * @param {string} igAccountId - ID del Instagram Business Account
 * @param {object} post - { caption, imageUrl }
 * @returns {object} - { id }
 */
export async function publishToInstagram(igAccountId, { caption, imageUrl }) {
  if (!imageUrl) {
    throw new Error("Instagram requiere una URL de imagen pública para publicar");
  }

  const igToken = getCredential(`META_IG_TOKEN_${igAccountId}`);
  if (!igToken) {
    throw new Error(`No hay token para la cuenta Instagram ${igAccountId}`);
  }

  // Paso 1: Crear media container
  const containerResponse = await axios.post(
    `${GRAPH_API_BASE}/${igAccountId}/media`,
    {
      image_url: imageUrl,
      caption,
      access_token: igToken,
    },
    { timeout: 30000 }
  );

  const containerId = containerResponse.data.id;
  console.log(`[Meta] Container IG creado: ${containerId}`);

  // Esperar a que el container esté listo (puede tardar unos segundos)
  await waitForContainerReady(igAccountId, containerId, igToken);

  // Paso 2: Publicar el container
  const publishResponse = await axios.post(
    `${GRAPH_API_BASE}/${igAccountId}/media_publish`,
    {
      creation_id: containerId,
      access_token: igToken,
    },
    { timeout: 30000 }
  );

  const mediaId = publishResponse.data.id;
  console.log(`[Meta] Publicado en Instagram ${igAccountId}: ${mediaId}`);

  return {
    id: mediaId,
    platform: "instagram",
    igAccountId,
  };
}

/**
 * Espera a que un media container de Instagram esté listo para publicar.
 * El container pasa por estados: IN_PROGRESS → FINISHED (o ERROR).
 */
async function waitForContainerReady(igAccountId, containerId, token, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const statusResponse = await axios.get(`${GRAPH_API_BASE}/${containerId}`, {
      params: {
        fields: "status_code",
        access_token: token,
      },
    });

    const status = statusResponse.data.status_code;

    if (status === "FINISHED") {
      return;
    }

    if (status === "ERROR") {
      throw new Error(`Error en media container de Instagram: ${containerId}`);
    }

    // Esperar 2 segundos antes de reintentar
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timeout esperando media container de Instagram: ${containerId}`);
}

/**
 * Publica en todas las plataformas Meta conectadas.
 * Usa los assets guardados en la DB.
 *
 * @param {object} post - { title, content, imageUrl, imagePath }
 * @returns {object} - Resultados por plataforma
 */
export async function publishToAllMeta({ title, content, imageUrl, imagePath }) {
  const results = {
    facebook: [],
    instagram: [],
    errors: [],
  };

  const message = `${title}\n\n${content}`;
  const caption = `${title}\n\n${content}`;

  // Publicar en todas las Facebook Pages activas
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
      console.error(`[Meta] Error publicando en Facebook Page ${page.name}:`, error.message);
      results.errors.push({
        platform: "facebook",
        pageId: page.external_id,
        pageName: page.name,
        error: error.message,
      });
    }
  }

  // Publicar en todas las cuentas Instagram activas
  const igAccounts = getAssetsByType("instagram_account");
  for (const ig of igAccounts) {
    try {
      // Instagram requiere URL pública (no acepta upload directo)
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
      console.error(`[Meta] Error publicando en Instagram ${ig.name}:`, error.message);
      results.errors.push({
        platform: "instagram",
        accountId: ig.external_id,
        accountName: ig.name,
        error: error.message,
      });
    }
  }

  return results;
}
