import axios from "axios";
import {
  setCredential,
  getCredential,
  deleteCredentialsByCategory,
  upsertAsset,
  deactivateAllAssets,
  getAllActiveAssets,
  isMetaConnected,
} from "./databaseService.js";

/**
 * Servicio de autenticación Meta (Facebook/Instagram).
 * Flujo inspirado en Platform ROI meta_service/core/auth.py:
 *
 * 1. Frontend abre popup con FB.login()
 * 2. Popup retorna authorization code o short-lived token
 * 3. Backend intercambia por long-lived token
 * 4. Backend descubre Pages e IG accounts
 * 5. Tokens encriptados se guardan en DB
 */

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Intercambia un short-lived token por un long-lived token.
 * O intercambia un authorization code por un token.
 */
export async function exchangeToken({ code, accessToken, redirectUri }) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("META_APP_ID y META_APP_SECRET son requeridos en .env");
  }

  let shortLivedToken = accessToken;

  // Si tenemos un code, intercambiarlo por un token primero
  if (code && !shortLivedToken) {
    const codeResponse = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri || "",
        code,
      },
    });
    shortLivedToken = codeResponse.data.access_token;
  }

  if (!shortLivedToken) {
    throw new Error("Se requiere code o access_token");
  }

  // Intercambiar short-lived por long-lived token (60 días)
  const longTokenResponse = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });

  const longLivedToken = longTokenResponse.data.access_token;
  const expiresIn = longTokenResponse.data.expires_in; // ~5184000 (60 días)

  // Guardar token encriptado en DB
  setCredential("META_USER_LONG_TOKEN", longLivedToken, "meta");
  if (expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    setCredential("META_TOKEN_EXPIRES_AT", expiresAt, "meta");
  }

  return { longLivedToken, expiresIn };
}

/**
 * Descubre todos los assets del usuario: Facebook Pages e Instagram accounts.
 * Similar a MetaAuthService.get_accounts() en Platform ROI.
 */
export async function discoverAssets(userToken) {
  const token = userToken || getCredential("META_USER_LONG_TOKEN");
  if (!token) {
    throw new Error("No hay token de Meta disponible");
  }

  // Desactivar assets anteriores
  deactivateAllAssets();

  const result = {
    pages: [],
    instagramAccounts: [],
  };

  // 1. Obtener Facebook Pages del usuario
  const pagesResponse = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
    params: {
      access_token: token,
      fields: "id,name,access_token,instagram_business_account{id,name,username,profile_picture_url}",
    },
  });

  for (const page of pagesResponse.data.data || []) {
    // Guardar token de la página (son long-lived automáticamente para pages)
    setCredential(`META_PAGE_TOKEN_${page.id}`, page.access_token, "meta");

    // Guardar page como asset
    upsertAsset("facebook_page", page.id, page.name, {
      access_token_ref: `META_PAGE_TOKEN_${page.id}`,
    });

    result.pages.push({
      id: page.id,
      name: page.name,
    });

    // 2. Si la página tiene Instagram Business Account vinculada
    if (page.instagram_business_account) {
      const igAccount = page.instagram_business_account;

      // El token de la página sirve para publicar en IG
      setCredential(`META_IG_TOKEN_${igAccount.id}`, page.access_token, "meta");

      upsertAsset("instagram_account", igAccount.id, igAccount.name || igAccount.username, {
        username: igAccount.username,
        profile_picture_url: igAccount.profile_picture_url,
        linked_page_id: page.id,
        access_token_ref: `META_IG_TOKEN_${igAccount.id}`,
      });

      result.instagramAccounts.push({
        id: igAccount.id,
        name: igAccount.name || igAccount.username,
        username: igAccount.username,
        profilePicture: igAccount.profile_picture_url,
        linkedPageId: page.id,
      });
    }
  }

  return result;
}

/**
 * Obtiene el estado actual de conexión Meta.
 * Respuesta sanitizada (sin tokens).
 */
export function getConnectionStatus() {
  const connected = isMetaConnected();
  const assets = connected ? getAllActiveAssets() : [];
  const expiresAt = getCredential("META_TOKEN_EXPIRES_AT");

  return {
    connected,
    expiresAt,
    pages: assets.filter((a) => a.asset_type === "facebook_page").map((a) => ({
      id: a.external_id,
      name: a.name,
    })),
    instagramAccounts: assets.filter((a) => a.asset_type === "instagram_account").map((a) => ({
      id: a.external_id,
      name: a.name,
      username: a.metadata?.username,
      profilePicture: a.metadata?.profile_picture_url,
    })),
  };
}

/**
 * Desconecta Meta: elimina todos los tokens y assets.
 */
export function disconnectMeta() {
  deleteCredentialsByCategory("meta");
  deactivateAllAssets();
  return { success: true, message: "Meta desconectado correctamente" };
}

/**
 * Verifica que los permisos necesarios estén otorgados.
 */
export async function checkPermissions(userToken) {
  const token = userToken || getCredential("META_USER_LONG_TOKEN");
  if (!token) return { valid: false, permissions: [] };

  try {
    const response = await axios.get(`${GRAPH_API_BASE}/me/permissions`, {
      params: { access_token: token },
    });

    const granted = (response.data.data || [])
      .filter((p) => p.status === "granted")
      .map((p) => p.permission);

    const required = [
      "pages_manage_posts",
      "pages_read_engagement",
      "instagram_basic",
      "instagram_content_publish",
    ];

    const missing = required.filter((p) => !granted.includes(p));

    return {
      valid: missing.length === 0,
      granted,
      missing,
    };
  } catch (error) {
    return { valid: false, error: error.message, permissions: [] };
  }
}
