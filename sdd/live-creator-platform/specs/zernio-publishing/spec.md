# Spec: zernio-publishing — Conexión embebida y publicación multi-red vía Zernio (Tanda T3)

## Propósito

Publicar en las redes del canal sin que PeriodistApp vea credenciales: conexión embebida white-label de Zernio (Profile con `externalId=tenantId`), `social_connections` por cuenta conectada, `publish_jobs` con estados y reintento — EN CONVIVENCIA con el `publishService` actual (Meta directo para portfolios/businessAssets existentes, Twitter/webhooks legacy). Decisión D-4.

## Actores

- Owner/editor (conecta cuentas, aprueba publicaciones).
- Zernio (capa de publicación, webhooks de estado).
- Sistema (encola y rutea publish_jobs al canal correcto).

## Comportamiento observable

### Requirement: Conexión embebida white-label

El sistema MUST iniciar el connect de Zernio por plataforma con `welcome=true` y welcome-screen configurado con la marca del tenant, obteniendo una authUrl que el usuario sigue en flujo embebido. El webhook `account.connected` (que trae `externalId=tenantId`) MUST registrar la `social_connection` resultante. PeriodistApp MUST NUNCA recibir ni almacenar tokens/credenciales sociales.

#### Scenario: Conectar Instagram del canal

- GIVEN el owner en /conexiones
- WHEN pulsa "Conectar Instagram" y completa el OAuth en la pantalla white-label
- THEN llega `account.connected`, se crea la social_connection vinculada al tenant y aparece activa en la lista — sin que la app haya visto credenciales

### Requirement: Convivencia con publishService legacy

El enrutador de publicación MUST usar Zernio como canal default para TODAS las plataformas nuevas (16 redes: TikTok, Instagram, YouTube, LinkedIn, Threads, Bluesky, X, Facebook…) y MUST mantener el camino Meta directo para `social_portfolios`/`business_assets` existentes y webhooks/Twitter legacy mientras conviven. El routing MUST ser explícito por conexión (cada social_connection declara provider `zernio|meta_legacy|twitter_legacy`).

#### Scenario: Tenant mixto publica igual

- GIVEN tenant con portfolio Meta legacy + IG conectada vía Zernio
- WHEN aprueba un asset destinado a ambas
- THEN se crean publish_jobs por el provider de cada conexión y ambos resuelven su estado

### Requirement: publish_jobs con ciclo de vida

Cada destino de publicación MUST ser un `publish_job` (assetId, socialConnectionId, copy/variante, estado `queued → sending → published | failed`, externalPostId, último error). Aprobación del asset MUST encolar sus jobs; fallos MUST soportar reintento manual y backoff; webhooks de estado de Zernio MUST actualizar el job por su referencia.

#### Scenario: Clip aprobado sale a TikTok e IG

- GIVEN un clip aprobado con 2 conexiones destino
- WHEN se encolan los jobs
- THEN cada uno publica vía Zernio, el estado avanza a `published` con su externalPostId, y un fallo puntual queda `failed` reintentable sin afectar al otro

### Requirement: Gating por maxConnectedPlatforms

El sistema MUST limitar las cuentas conectadas a `plans.maxConnectedPlatforms` (costo Zernio por cuenta absorbido vía plan — decisión A-4): conectar por encima del límite MUST rechazar con oferta de upgrade.

#### Scenario: Plan Creator con 3 cuentas

- GIVEN 3/3 conexiones activas
- WHEN intenta conectar una 4.ª
- THEN 403 con código de límite

### Requirement: Menciones con handles de persons

Al publicar un asset que menciona personas con `socials` declaradas y plataforma coincidente, el sistema SHOULD etiquetar con el handle correcto por red (PG-06); si la plataforma no soporta menciones vía API, el handle va como texto en el copy.

#### Scenario: Clip de Martín etiquetado

- GIVEN clip con Martín (@martin en IG)
- WHEN se publica a Instagram
- THEN el post etiqueta/menciona a @martin

## Datos involucrados (conceptual)

- `social_connections`: tenantId, provider (zernio|meta_legacy|twitter_legacy), platform, zernioAccountId?, portfolioId? (legacy), displayName, isActive.
- `publish_jobs`: assetId, socialConnectionId, payload copy/media, status, attempts, externalPostId, lastError.
- Perfil Zernio del tenant: `externalId=tenantId` (único, retry-safe).
- Webhooks entrantes: `account.connected`, `account.disconnected`, estado de post.

## Errores y edge cases

- Cuenta desconectada desde la red/Zernio → webhook la marca `isActive=false`; jobs futuros a esa conexión fallan con causa clara.
- Webhook duplicado → dedup por externalId del evento.
- Media incompatible (formato/tamaño para la red) → job `failed` con error traducido, sin bloquear otros destinos.
- Zernio caído → jobs permanecen `queued` con reintento; flag `zernio_publishing` permite cortar a legacy.
- Tenant sin Zernio configurado → publishService legacy sigue funcionando (convivencia total).
- Spike pendiente (R-4): validar en S1 connect embebido + post de video 9:16 en IG/TikTok antes de construir encima — gate de diseño.

## Trazabilidad

PG-04, PG-05, PG-06, PG-07, D-4, PF-09 (menciones/handles), R-4. Depende de assets-unified (asset aprobado), feature-flags (kill-switch), usage-quota (maxConnectedPlatforms), review-and-autopublish (trigger).
