# Zernio API — referencia verificada (para PG-04 / PG-05)

Fuente: docs públicas de Zernio (leídas el 2026-11-10). **No inventar endpoints**: si algo no está
acá, verificar en `https://docs.zernio.com` o en el OpenAPI `https://zernio.com/openapi.yaml`
(la spec es pública y completa) antes de codificar.

- Docs: https://docs.zernio.com · Spec: https://zernio.com/openapi.yaml · llms.txt: https://zernio.com/llms.txt

## Base y autenticación
- Base URL: `https://zernio.com/api/v1`
- Auth: header `Authorization: Bearer $ZERNIO_API_KEY` en **cada** request.
- La API key es **de la plataforma PeriodistApp** (la cuenta Zernio que es dueña de los perfiles),
  una sola, por env: `ZERNIO_API_KEY`. Los tenants no tienen key propia: se aíslan por
  `profileId` + `externalId=tenantId`. **Nunca** loguearla, nunca devolverla al cliente, nunca
  escribirla en DB ni en commits.
- Errores: body JSON con `code` legible por máquina (ej. `platform_account_limit`, `account_not_found`,
  `idempotency_conflict`, `profile_not_found`, `duplicate_content`).

## Modelo multi-tenant (guía oficial "Build a platform")
- **Un perfil Zernio por cliente.** `POST /v1/profiles` con `{ name, externalId }`, donde
  `externalId` = **nuestro `tenantId`**. `externalId` es único entre los perfiles que nos pertenecen:
  un reintento de alta devuelve el perfil existente en vez de crear un segundo.
- Respuesta 201: `{ message, profile: { _id, name, userId, description, color, externalId, isDefault, createdAt } }`.
- Recuperación: `GET /v1/profiles?externalId=<tenantId>` devuelve el perfil (usar esto como fallback
  si el `POST` responde 409 con `details.existingProfileId`).
- Los perfiles son gratis; **cada cuenta conectada se metrica** (pricing por cuenta conectada).
- En los webhooks, cada evento vuelve a traer `externalId` en `profiles[]` → el ruteo al tenant no
  necesita lookup.

## Conectar cuentas (OAuth alojado por Zernio)
- `GET /v1/connect/{platform}` con query: `profileId` (**obligatorio**), `redirect_url`,
  `welcome`, `brandName`, `logoUrl`, `primaryColor`, `language`, `headless`, `scopes`,
  `reconnectAccountId`, `handoff`, `signup`.
- Respuesta 200: `{ authUrl }` (a veces `{ authUrl, state, handoff: { id } }`).
- **Flujo embebido white-label**: con `welcome=true` + `brandName` + `logoUrl`, Zernio muestra una
  pantalla propia ("Acme quiere conectar tu Instagram") y reenvía a la plataforma. `welcome=true` es
  incompatible con `headless=true` y con `signup=hosted`.
- `redirect_url` puede ser http(s) absoluta o app scheme (`myapp://callback`). Se le **agregan**
  los params: `connected`, `profileId`, `accountId`, `username`, más `request_id` y `stage`.
  Los params propios se conservan salvo colisión de nombre.
- Valores válidos de `{platform}`: `twitter` (X), `instagram`, `facebook`, `linkedin`, `tiktok`,
  `youtube`, `threads`, `reddit`, `pinterest`, `bluesky`, `googlebusiness`, `telegram`, `snapchat`,
  `discord`, `slack`, `whatsapp`, `google`, `microsoft`.
- Algunas plataformas terminan en un **picker de destino** (IG/Facebook → página, LinkedIn → org,
  Pinterest → board, Google Business → location, Snapchat → perfil): esos son endpoints
  `POST /v1/connect/<platform>/select-*`. Para nuestro slice, el caso pedido es **Instagram**.

## Cuentas conectadas
- `GET /v1/accounts` con query: `profileId`, `platform`, `status=connected|disconnected`,
  `search`, `category=social`, `page`+`limit`, `cursor`, `sort`, `order`.
- Cada cuenta trae `id` (= `accountId` que exige `POST /v1/posts`), `platform`, `username`,
  `displayName`, `status`, `connected`, `enabled`, `profileId`.
- `includeStatusCounts=true` agrega el conteo de cuentas que necesitan reconexión.

## Publicar
- `POST /v1/posts` body:
  - `content` (string, requerido en posts sólo-texto)
  - `platforms`: array de `{ platform, accountId }` (ambos requeridos; `accountId` = id de `/v1/accounts`)
  - uno de: `publishNow: true` | `scheduledFor` (ISO 8601) | `queuedFromProfile: true` | `isDraft: true`
    (además `requiresApproval: true` + `scheduledFor` ⇒ `pending_approval`)
  - opcionales: `mediaUrls` / `mediaItems`, `timezone`, `customContent` por plataforma, `dryRun`.
  - Header opcional **`Idempotency-Key`** (UUID por post lógico): repetir con la misma key dentro de
    24 h devuelve el post original (200); si el original sigue procesando ⇒ 409 `idempotency_conflict`.
    **Es lo que hace seguro el reintento de PG-05.**
- Respuestas: **201** creado · **200** nada creado (dry-run o replay idempotente) · **202** X sin fondos
  (queda esperando funding) · **207** creado pero publicación **parcial** (branchear por
  `post.status`, nunca por "no lanzó") · 400 validación · 401 key inválida · 402 fondos de X · 403
  cuenta desconectada/ads-only/sobre límite · 409 contenido duplicado o conflicto de idempotencia ·
  429 rate limit · 503 upstream (reintentable).
- Estados del post: `draft`, `pending_approval`, `scheduled`, `publishing`, `published`, `partial`,
  `failed`, `cancelled`. Estado por entrada de plataforma: `pending`, `processing`, `uploading`,
  `published`, `failed`, `cancelled` (+ `platformPostUrl` al publicar, `errorMessage`,
  `errorCategory`, `errorSource` al fallar).
- `errorCategory`: `auth_expired` (reconectar), `user_content` (corregir contenido), `user_abuse`,
  `platform_rate_limit` (reintentable), `quota_exhausted`, `account_issue`, `platform_rejected`,
  `platform_error` (reintentable), `system_error` (reintentable), `unknown`.
- `errorSource` = `user` | `platform` | `system`: los de `platform`/`system` vale la pena reintentar.
- `GET /v1/posts/{postId}` → `{ post: { _id, status, platforms: [...] } }`.

## Reintentar
- `POST /v1/posts/{postId}/retry` → republica las plataformas que fallaron. 200 con el post actualizado;
  202/207 según el resultado; 409 `post is currently publishing`; 422 si el texto ya se purgó;
  400 invalid state.

## Webhooks
- `POST /v1/webhooks/settings` body: `{ name, url, secret, events: [...], isActive, profileIds?, accountIds? }`
  (máx. 50 webhooks por usuario; `url` http(s) válida; `events` con al menos uno).
- Eventos útiles: `post.scheduled`, `post.published`, `post.failed`, `post.partial`, `post.cancelled`,
  `account.connected`, `account.disconnected`.
- `GET /v1/webhooks/deliveries` lista los intentos (retención 30 días) — útil para auditar.
- Cada payload trae `profiles[].externalId` → nuestro `tenantId`.

## Lo que NO existe / no prometer
- No hay endpoint para "publicar con menciones automáticas": las menciones/etiquetas van en el
  `content` (o `customContent` por plataforma) que armamos nosotros.
- No hay endpoint para editar un post ya publicado salvo los restringidos por plataforma.
- El límite de cuentas por plan de Zernio existe (`platform_account_limit`, 403) — OUR
  `plans.maxConnectedPlatforms` es nuestro propio límite de negocio, son cosas distintas.
