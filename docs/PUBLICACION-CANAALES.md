# Canales de publicación (PG-07)

PeriodistApp tiene **dos caminos** para publicar contenido en redes sociales.
El modo `publish_channel_mode` del tenant (guardado en `settings`, editable en
**Conexiones → Canal de publicación**) decide cuál se usa por plataforma.

## Los dos canales

- **Zernio** — la cola persistente (`publish_jobs` + worker): un job por
  (contenido × red × cuenta), idempotente, con reintentos y errores
  categorizados. Cubre todas las redes: Meta, X, TikTok, YouTube, LinkedIn,
  Threads, Pinterest, Reddit, Bluesky… Las cuentas se conectan por OAuth
  hospedado por Zernio (nunca pedimos credenciales).
- **Legacy (directo)** — el circuito original: `publishToChannels` llama a la
  Graph API de Meta (Facebook Pages + Instagram) y al bot de X por variables
  de entorno, además del webhook y Google Drive. Sigue funcionando igual que
  siempre — está **deprecado pero soportado**: no se elimina, sólo deja de
  ser el default cuando una plataforma migra.

## Los tres modos

| Modo | Qué hace |
|------|----------|
| `hybrid` (default) | Zernio para las plataformas conectadas; el canal directo para los assets Meta/Twitter que todavía no migraron. Un tenant que nunca configuró nada publica **exactamente como antes**. |
| `zernio` | Todo por Zernio. El canal directo sólo corre si la publicación lo pide explícitamente (`forceLegacy` en el approve — "publicar por canal legacy"). |
| `legacy` | Meta/Twitter siempre por el canal directo (comportamiento clásico). Las redes nuevas igual publican por Zernio cuando hay conexión — el canal directo no las conoce. |

Reglas de resolución (`resolvePublishChannels` / `planPublishChannels`):

- **Red nueva** (no Meta/Twitter): sólo Zernio. Sin conexión → no hay canal,
  con el motivo en español para mostrar en la UI.
- **Meta/Twitter en híbrido**: si hay conexión Zernio *y* ningún asset legacy
  activo está marcado `legacy-only`, gana Zernio; si no, canal directo.
- **`forceLegacy`** (por publicación): Meta/Twitter con camino legacy → canal
  directo aunque haya conexión Zernio. Sin camino legacy → sin canal.
- Una plataforma sin conexión ni camino legacy → `none` + motivo.

## Migrar un portfolio Meta de directo a Zernio

1. En **Conexiones → Cuentas sociales**, conectar la cuenta de la red
   (Facebook/Instagram/X) — el OAuth lo hospeda Zernio.
2. Listo: en `hybrid`, la plataforma empieza a publicar por Zernio en la
   próxima aprobación. El asset del portfolio queda "pendiente de migración"
   hasta que se desconecte o deje de usarse.
3. Si un asset concreto debe seguir por el canal directo pese a la conexión
   Zernio, marcarlo **"Sólo legacy"** en su fila del portfolio — la marca se
   guarda explícita (`metadata.legacyOnly`) y ancla **toda la plataforma** al
   canal directo.

## Lo que NO cambia

- `publishService`, `metaPublishService` y `twitterService` siguen ahí y se
  usan tal cual — el modo `legacy` y el default `hybrid` los necesitan.
- Un approve en un tenant sin config ni conexiones hace la misma llamada de
  siempre (drive + webhook + X + Meta completa).
- Las marcas `legacy-only` y el modo son por tenant — ningún tenant ve ni es
  afectado por la configuración de otro.
