import axios from "axios";
import type { MetaAsset } from "../../shared/types.js";
import {
  setCredential,
  getCredential,
  deleteCredentialsByCategory,
  upsertAsset,
  deactivateAllAssets,
  getAllActiveAssets,
  isMetaConnected,
} from "./databaseService.js";
import { limiters } from "./rateLimiter.js";

/**
 * Servicio de autenticación Meta (Facebook/Instagram).
 * Flujo:
 *   1. Frontend abre popup con FB.login()
 *   2. Popup retorna authorization code o short-lived token
 *   3. Backend intercambia por long-lived token
 *   4. Backend descubre Pages e IG accounts
 *   5. Tokens encriptados se guardan en DB
 */

const GRAPH_API_VERSION = "v22.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

interface ExchangeTokenParams {
  code?: string;
  accessToken?: string;
  redirectUri?: string;
}

interface ExchangeTokenResult {
  longLivedToken: string;
  expiresIn: number | undefined;
}

interface PageInfo {
  id: string;
  name: string;
}

interface InstagramAccountInfo {
  id: string;
  name: string;
  username: string;
  profilePicture: string | undefined;
  linkedPageId: string;
}

interface DiscoverAssetsResult {
  pages: PageInfo[];
  instagramAccounts: InstagramAccountInfo[];
}

interface ConnectionStatus {
  connected: boolean;
  expiresAt: string | null;
  pages: PageInfo[];
  instagramAccounts: Array<{
    id: string;
    name: string;
    username: string | undefined;
    profilePicture: string | undefined;
  }>;
}

interface PermissionsResult {
  valid: boolean;
  granted?: string[];
  missing?: string[];
  error?: string;
  permissions?: never[];
}

/**
 * Intercambia un short-lived token por un long-lived token.
 * O intercambia un authorization code por un token.
 */
export async function exchangeToken({ code, accessToken, redirectUri }: ExchangeTokenParams): Promise<ExchangeTokenResult> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error("META_APP_ID y META_APP_SECRET son requeridos en .env");
  }

  let shortLivedToken = accessToken;

  // If we have a code, exchange it for a token first
  if (code && !shortLivedToken) {
    await limiters.metaApi.acquire();
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

  // Exchange short-lived for long-lived token (60 days)
  await limiters.metaApi.acquire();
  const longTokenResponse = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    },
  });

  const longLivedToken: string = longTokenResponse.data.access_token;
  const expiresIn: number | undefined = longTokenResponse.data.expires_in;

  // Save encrypted token in DB
  setCredential("META_USER_LONG_TOKEN", longLivedToken, "meta");
  if (expiresIn) {
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    setCredential("META_TOKEN_EXPIRES_AT", expiresAt, "meta");
  }

  return { longLivedToken, expiresIn };
}

/**
 * Descubre todos los assets del usuario: Facebook Pages e Instagram accounts.
 */
export async function discoverAssets(userToken?: string): Promise<DiscoverAssetsResult> {
  const token = userToken || getCredential("META_USER_LONG_TOKEN");
  if (!token) {
    throw new Error("No hay token de Meta disponible");
  }

  // Deactivate previous assets
  deactivateAllAssets();

  const result: DiscoverAssetsResult = {
    pages: [],
    instagramAccounts: [],
  };

  // 1. Get user's Facebook Pages
  await limiters.metaApi.acquire();
  const pagesResponse = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
    params: {
      access_token: token,
      fields: "id,name,access_token,instagram_business_account{id,name,username,profile_picture_url}",
    },
  });

  for (const page of pagesResponse.data.data || []) {
    // Save page token (automatically long-lived for pages)
    setCredential(`META_PAGE_TOKEN_${page.id}`, page.access_token, "meta");

    // Save page as asset
    upsertAsset("facebook_page", page.id, page.name, {
      access_token_ref: `META_PAGE_TOKEN_${page.id}`,
    });

    result.pages.push({
      id: page.id,
      name: page.name,
    });

    // 2. If the page has a linked Instagram Business Account
    if (page.instagram_business_account) {
      const igAccount = page.instagram_business_account;

      // The page token works for IG publishing
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
export function getConnectionStatus(): ConnectionStatus {
  const connected = isMetaConnected();
  const assets: MetaAsset[] = connected ? getAllActiveAssets() : [];
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
export function disconnectMeta(): { success: boolean; message: string } {
  deleteCredentialsByCategory("meta");
  deactivateAllAssets();
  return { success: true, message: "Meta desconectado correctamente" };
}

/**
 * Verifica que los permisos necesarios estén otorgados.
 */
export async function checkPermissions(userToken?: string): Promise<PermissionsResult> {
  const token = userToken || getCredential("META_USER_LONG_TOKEN");
  if (!token) return { valid: false, permissions: [] };

  try {
    const response = await axios.get(`${GRAPH_API_BASE}/me/permissions`, {
      params: { access_token: token },
    });

    const granted = (response.data.data || [])
      .filter((p: { status: string; permission: string }) => p.status === "granted")
      .map((p: { status: string; permission: string }) => p.permission);

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
    const err = error as Error;
    return { valid: false, error: err.message, permissions: [] };
  }
}
