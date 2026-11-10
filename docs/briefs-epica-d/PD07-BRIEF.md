# PD-07 — Soporte de fuentes: YouTube Live, Twitch, Kick, HLS genérico + VOD upload fallback

Ejecutá este brief **end-to-end, de forma totalmente autónoma**. No esperes aprobación de nadie.
Si un gate falla, arreglalo antes de reportar. **No dejes nada a medias.**

## Contexto del repo

- Worktree: el que ya tenés abierto. Rama de este slice: `pd-07-sources`.
- Stack: **Express 4 + TypeScript (ESM) + React 19 SPA + Drizzle ORM + Postgres (Neon)**.
- Contratos que ya existen y tenés que **reutilizar** (leelos primero):
  - `src/server/services/streamSourceResolver.ts` — el resolver de URL (creado en el slice D2/PD-01).
    **NO lo reescribas**: extendelo si hace falta.
  - `src/server/services/streamRecorderService.ts` — el recorder (creado en D2/PD-01). Su API pública
    (`startRecording`) es la que tenés que consumir.
  - `src/server/db/schema/transmissions.ts` — tabla `transmissions`. Ya tiene `source` (enum
    `TransmissionSource`: `live_capture | vod_upload | manual`), `stream_url`, `resolved_stream_url`,
    `crudo_ref`, `status`, `program_id`, `scheduled_transmission_id`, `pipeline_config`, `tenant_id`.
  - `src/server/db/schema/recordings.ts` — `stream_recordings` / `recording_segments`.
  - `src/server/services/rawStorageService.ts` — la interfaz de storage.
  - `src/server/services/liveDetectorService.ts` — detección de live por plataforma (YT/Twitch/Kick/HLS).
  - `src/server/services/transcriptionService.ts` — patrón de `findBinary` y de invocación de yt-dlp/ffmpeg.
  - `src/server/routes/transmissions.ts` — router existente de transmisiones (montado en `src/server/index.ts`).
  - `src/server/middleware/auth.ts` — `requireAuth`, `requireActiveSubscription`.
  - `src/server/routes/pipeline.ts` — ejemplo de rutas con auth + gates de suscripción.
  - `src/server/middleware/authz.ts` — `optionalAuth`, `viewerWriteGuard` (globals en `/api`).
- Tests: `vitest`, en `tests/*.test.ts`.

## Objetivo

Cerrar **PD-07**: que el sistema acepte **todas las fuentes** del checklist y tenga el **fallback de upload de
video** para los early adopters a los que YouTube les bloquea la IP de datacenter.

### Parte A — Registro de fuentes soportadas

Agregá un **registry explícito** de fuentes (archivo nuevo `src/server/lib/streamSources.ts`):

```ts
export type StreamSourceKind = 'youtube' | 'twitch' | 'kick' | 'hls' | 'upload';

export interface StreamSourceDef {
  kind: StreamSourceKind;
  label: string;
  /** Detecta si la URL/valor corresponde a esta fuente. */
  matches(input: string): boolean;
  /** true si la fuente requiere yt-dlp para resolver (HLS genérico no). */
  needsResolver: boolean;
  /** Soporta live en vivo (upload no). */
  supportsLive: boolean;
}

export function detectStreamSource(input: string): StreamSourceDef;
export const STREAM_SOURCES: readonly StreamSourceDef[];
```

Reglas de detección (mirá cómo ya lo hace `liveDetectorService.detectPlatform` — **reutilizá/alineate**, no
dupliques con criterios distintos):
- `youtube` → `youtube.com` / `youtu.be`
- `twitch` → `twitch.tv`
- `kick` → `kick.com`
- `hls` → termina en `.m3u8`, o URL de stream directo (`.mp4`, `/stream`, `radio`, `shoutcast`, `icecast`).
- `upload` → NO es una URL: es un archivo subido por el usuario (se maneja en la Parte B).

**Importante:** el registry debe ser la **única** fuente de verdad. Si `liveDetectorService` o
`transcriptionService` tienen su propia detección de plataforma, **refactorizá** para que usen el registry
(sin romper sus tests). Si eso implicaría un refactor demasiado invasivo, al menos dejá claro en el informe
qué quedó duplicado y por qué.

### Parte B — VOD upload fallback (el camino que habilita early adopters)

Endpoint nuevo: `POST /api/transmissions/vod-upload` en `src/server/routes/transmissions.ts`.

Flujo:
1. `requireAuth` + `requireActiveSubscription` (mismo criterio que el resto de las rutas que crean recursos).
2. `tenantId` **SIEMPRE** de `req.auth!.tenantId` — **nunca** del body. Regla dura del repo.
3. Acepta `multipart/form-data` con:
   - `file` → el MP4 (obligatorio). **Límite de tamaño**: leé el límite de `multer` que ya usa el repo
     (`src/server/index.ts` importa `multer`) y **reusalo** — no inventes un límite distinto ni un límite
     sin cota. Si el repo no tiene un límite global, poné uno razonable y **constante**.
   - `programId` (opcional), `name` (opcional), `durationMinutes` (opcional), `startedAt` (opcional: si el
     usuario indica cuándo se emitió el programa, se usa ese instante como ancla wall-clock).
4. Validaciones (todas con mensaje claro en español, 400):
   - El archivo tiene extensión de video (`.mp4`, `.mov`, `.webm`, `.mkv`) **y** tamaño > 0.
   - `programId`, si viene, **pertenece al tenant** (query filtrada por `tenant_id`; si no pertenece → 404,
     no 403 — no reveles existencia de recursos ajenos).
   - `durationMinutes` entre 5 y 480 (mismo rango que `scheduleRules.ts`).
5. **Rechazo de archivo corrupto / sin pista de video**: usá `ffprobe` (el repo ya lo usa en
   `clipService.ts`) para verificar que el archivo tiene **pista de video**. Si no tiene → **400 con mensaje
   claro** ("el archivo no contiene pista de video"). Si `ffprobe` no está disponible en el entorno,
   **NO inventes**: hacé la validación por extensión + tamaño y **dejá la verificación de pista como
   warning explícito en el informe** (decí que no se pudo verificar).
6. Guardá el archivo en el storage con `RawStorage` bajo el prefijo
   `{tenantId}/{transmissionId}/vod/seg-00001.mp4` (mismo layout que el recorder).
7. Creá la fila `transmissions` con:
   - `source: 'vod_upload'` (**obligatorio** — es el que distingue el fallback)
   - `status: 'processing'` (el crudo ya está; no hay nada que esperar en vivo)
   - `stream_url`: `null` o una pseudo-URL descriptiva — **decidí y documentá** cuál usás. OJO: `stream_url` es
     `text` y **nullable** en el schema, así que `null` es válido.
   - `startedAt`: el instante del ancla (el `startedAt` del body o now).
   - `crudo_ref`: el prefijo de storage.
8. Creá la fila `stream_recordings` (status `'completed'`) y el `recording_segment` con
   `start_ms: 0`, `end_ms: durationMs`, `file_ref` relativo, `bytes` real.
9. Respondé **201** con la transmisión serializada (mismo shape que devuelve el resto de las rutas de
   transmisiones).

**Alternativa si el upload directo a storage es frágil**: también aceptá una **URL de VOD descargable**
(`vodUrl` en el body, http/https) y descargala al storage. Implementá **las dos** si es razonable: el upload
directo es el camino principal (early adopter), la URL es el fallback.

### Parte C — Endpoint de "soporte de fuentes" (UX)

`GET /api/transmissions/sources` (con `requireAuth`): devuelve el registry serializado
(`kind`, `label`, `supportsLive`, `needsResolver`) + una nota de que `youtube` requiere VPS/proxies
(riesgo R-1) y que `upload` es el camino recomendado para early adopters. Sin datos sensibles.

### Parte D — Disparo manual de una fuente live

`POST /api/transmissions/start-live` (con `requireAuth` + `requireActiveSubscription`):
- Body: `{ streamUrl: string, programId?: string, durationMinutes?: number }`.
- Valida la URL (http/https) y detecta la fuente con el registry.
- **NO** puede ser `upload` (eso es el endpoint de VOD) → 400 con mensaje claro.
- Crea `transmissions` con `source: 'live_capture'`, `status: 'waiting'`, `stream_url`, `duration_minutes`,
  `program_id` (si pertenece al tenant), `pipeline_config` (vacío por defecto).
- Actualiza `last_run_at` / `next_run_at` / `last_transmission_id` si viene de una `scheduled_transmission_id`.
- Respondé **201**.

**Dejá preparado el enganche con el recorder**: llamá a `startRecording()` desde un worker/slice posterior
(PD-03), **no** desde la ruta HTTP (una request HTTP no debe bloquearse grabando una hora). En esta Parte D
solo creá la transmisión en `waiting` y **dejá un TODO explícito en el código** diciendo que el scheduler
(PD-03) la va a tomar. Si el recorder ya expone una función tipo `startRecording` que devuelve un handle
sin bloquear, podés llamarla **en background** (`void startRecording(...).catch(...)`) — pero **tomá la
decisión y documentala**.

### Parte E — Seguridad de tenant (OBLIGATORIO)

- `tenant_id` en **toda** query nueva — sin excepciones.
- El `transmissionId` que se genera para el prefijo de storage **debe** derivarse de la fila creada, no de
  un id del body.
- **No aceptes `tenantId` del body en ningún endpoint.**
- El archivo subido **no** debe quedar accesible por una URL pública sin auth. `RawStorage.publicPath` devuelve
  la ruta de filesystem; **no** la expongas en la respuesta HTTP como si fuera una URL pública. Devolvé el
  `fileRef` / `crudoRef` (la clave relativa), no la ruta absoluta.

## Tests — `tests/streamSources.test.ts` + `tests/transmissionsVodUpload.test.ts`

- `detectStreamSource`: YouTube, Twitch, Kick, `.m3u8`, HLS genérico, URL desconocida → `hls`/genérica.
- `detectStreamSource` con una URL de upload → `upload`.
- Upload VOD: **401 sin auth**, **400 sin archivo**, **400 con archivo sin extensión de video**,
  **404 con `programId` de otro tenant**, **201 con archivo válido** → se creó `transmissions` con
  `source='vod_upload'` y `stream_recordings` + `recording_segments`.
- Upload VOD: **el `tenant_id` de la fila creada es el del token, nunca uno del body**.
- `GET /api/transmissions/sources` → 200 con el registry.
- `POST /api/transmissions/start-live` → 201 con `source='live_capture'`, `status='waiting'`; y 400 si la
  fuente es `upload`.

**Patrón de tests del repo**: mirá `tests/dossier-transmission.test.ts` y `tests/editorial-resolution.test.ts`
para copiar el estilo de mocking (el repo mockea **parcialmente** los repos: `vi.mock(p, async (io) => ({...await io(),
factory: vi.fn()}))`; un mock total rompe imports).

## Gates — TODOS tienen que dar EXIT 0 real

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
```

Si este slice **no** toca el schema, `drizzle-kit generate` debe imprimir **"No schema changes, nothing to migrate"**.
Si tocás el schema, generá la migración idempotente `0012_...` y actualizá el verificador PGlite.

## Commit

- **UN commit** al final, con los gates verdes.
- Conventional Commits, mensaje en español, **sin atribución a IA**, sin `Co-Authored-By`.
  - Sugerido: `feat(transmissions): soporte de fuentes y fallback de upload VOD`
- **Paths explícitos** (nunca `git add -A` ni `git add .`).
- **NO** push, **NO** merge, **NO** deploy. **NO** agregues `remotion/package-lock.json`.

## Informe final (obligatorio, en español)

1. Archivos creados/modificados (paths).
2. Exit code real de los 5 gates + línea de resumen de vitest + salida final del PGlite.
3. Qué imprimió `drizzle-kit generate`.
4. SHA del commit + `git show --stat`.
5. `git status --short` final.
6. **Qué está verificado por test y qué NO** (separado, explícito). En particular: ¿pudiste verificar con
   `ffprobe` que el archivo tiene pista de video? ¿Qué pasa si `ffprobe` no está en el entorno?
7. Decisiones que tomaste (p.ej. el formato de `stream_url` en VOD, si llamaste al recorder en background).
8. Límites/supuestos, explícito.

Nada de "debería funcionar".
