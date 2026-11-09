# PD-01 — Captura de video: `streamRecorderService` (yt-dlp → ffmpeg `-c copy -f segment`)

Ejecutá este brief **end-to-end, de forma totalmente autónoma**. No esperes aprobación de nadie.
Si un gate falla, arreglalo antes de reportar. **No dejes nada a medias.**

> **NOTA DE BASE:** este slice corre sobre la rama que ya contiene el slice D1 (schema `stream_recordings` +
> `recording_segments` + `rawStorageService`). **Leé `src/server/db/schema/recordings.ts` y
> `src/server/services/rawStorageService.ts` primero** — son tu contrato. Si no existen, esperá a que estén
> (el orquestador los integra antes de lanzarte); si no están, reportá el bloqueo sin inventar schema.

## Contexto del repo

- Worktree: el que ya tenés abierto. Rama de este slice: `pd-02-capture-video`.
- Stack: **Express 4 + TypeScript (ESM) + React 19 SPA + Drizzle ORM + Postgres (Neon)**.
- Patrones existentes que tenés que leer y reutilizar (NO reescribas desde cero):
  - `src/server/services/transcriptionService.ts` — **cómo el repo ya resuelve binarios** (`findBinary`), cómo
    invoca `yt-dlp` y `ffmpeg` (`exec`/`spawn`), cómo detecta tipo de fuente (`detectSourceType`). Vas a
    **reutilizar/extraer** ese patrón, no a duplicarlo a ciegas.
  - `src/server/services/liveDetectorService.ts` — detección de live por plataforma (YT/Twitch/Kick/HLS).
  - `src/server/services/clipService.ts` — cómo el repo usa `ffmpeg` para cortar.
  - `src/server/services/rawStorageService.ts` — la interfaz de storage (slice D1).
  - `src/server/db/schema/recordings.ts` — tablas `stream_recordings` / `recording_segments` (slice D1).
  - `src/server/db/schema/transmissions.ts` — tabla `transmissions` (ya tiene `crudo_ref`, `resolved_stream_url`,
    `status`, `started_at`, `ended_at`, `waiting_since`, `last_heartbeat_at`).
  - `src/server/db/schema/enums.ts` — `TransmissionStatus` (`scheduled|waiting|live|processing|done|error|canceled`).
- Tests: `vitest`, archivos en `tests/*.test.ts`.

## Objetivo

Implementar el **servicio que graba el crudo de VIDEO** de un live stream: resuelve la URL del stream **una
sola vez** con `yt-dlp`, y graba con `ffmpeg -c copy -f segment` a MP4 segmentados en el storage del tenant,
sin re-encode. Cada segmento queda anclado a **wall-clock de la ejecución** (offset ms relativo al
`startedAt` de la transmisión) para poder alinearlo con transcripción/rostros.

**Decisión D-1 (vinculante):** self-hosted con `yt-dlp` + `ffmpeg`. NO Livepeer/Mux/CF Stream.
**Decisión B-1 (vinculante):** YouTube es fuente **garantizada** desde v1 → el código debe soportar **rotación
de proxies** para evadir el bloqueo de IPs de datacenter (riesgo R-1). Implementá la rotación con env
`INGEST_PROXY_URLS` (lista separada por comas). Con proxies configurados, cada intento de resolución rota al
siguiente proxy; si la lista está vacía, se usa conexión directa. Documentá esto en el código.

## 1. `src/server/services/streamSourceResolver.ts`

Resolución de URL → URL directa de media, **una sola vez** por transmisión:

```ts
export interface ResolvedStream {
  /** URL directa que ffmpeg puede abrir (HLS/mp4/http). */
  url: string;
  /** 'hls' | 'http' | 'file' */
  kind: 'hls' | 'http' | 'file';
  /** Metadatos útiles (title, platform, thumbnail). */
  title: string | null;
  platform: string;
  /** Proxy usado (null si fue directo). */
  proxy: string | null;
}

export async function resolveStreamUrl(
  streamUrl: string,
  opts?: { proxyUrls?: string[]; timeoutMs?: number },
): Promise<ResolvedStream>
```

Reglas:
- **HLS genérico**: si la URL termina en `.m3u8` (o tiene `format=m3u8`), se usa **directamente**, sin yt-dlp.
  `kind: 'hls'`.
- **YouTube / Twitch / Kick / Vimeo / Dailymotion / Facebook Live**: se usa `yt-dlp`.
  - Preferí `yt-dlp --get-url` (devuelve la URL directa). Si no está disponible/falla, `--dump-json` y tomá
    `url`/`formats`.
  - **IMPORTANTE:** para YouTube Live, `--get-url` puede devolver una URL de HLS (`manifest_hls`) — eso es lo
    que queremos (ffmpeg lo consume nativo).
- **Proxy**: con `INGEST_PROXY_URLS` (o `opts.proxyUrls`), pasá `--proxy <url>` a yt-dlp. **Rotación:** cada
  intento usa el proxy `i % n`; si la resolución falla con un proxy, se reintenta con el siguiente (hasta
  agotar la lista); si agotó todos, se reintenta **sin proxy** (directo) antes de rendirse.
- **Timeout** por defecto 30 s (configurable).
- Errores: lanzá un error con **mensaje descriptivo** que distinga: URL inválida, no hay live, bloqueado por
  plataforma (mencioná "puede ser bloqueo de IP de datacenter"), timeout, binario faltante.

**Extrae** la resolución de binarios (`findBinary`) a un helper compartido si ya existe uno razonable; si no,
**reutilizá** el patrón de `transcriptionService.ts` sin romperlo.

## 2. `src/server/services/streamRecorderService.ts`

API pública (lo que consume el scheduler en el slice siguiente):

```ts
export interface StartRecordingOptions {
  tenantId: string;
  transmissionId: string;
  streamUrl: string;
  /** Duración máxima en minutos (límite del plan). */
  maxDurationMinutes?: number;
  /** Duración del segmento en segundos. Default 60. */
  segmentSeconds?: number;
  /** Prefijo de storage. Default `${tenantId}/${transmissionId}`. */
  storagePrefix?: string;
}

export interface RecordingHandle {
  transmissionId: string;
  recordingId: string;
  /** Se resuelve cuando la grabación termina (por duración o por stream caído). */
  done: Promise<RecordingOutcome>;
  stop(): Promise<void>;
}

export interface RecordingOutcome {
  status: 'completed' | 'error';
  totalBytes: number;
  segmentCount: number;
  errorMessage: string | null;
}

export async function startRecording(opts: StartRecordingOptions): Promise<RecordingHandle>
```

Comportamiento:

1. **Resolvé la URL UNA vez** con `resolveStreamUrl`. Guardá el resultado en `transmissions.resolved_stream_url`.
2. **Creá** la fila `stream_recordings` (status `'recording'`, `storagePrefix`, `startedAt` = now = **ancla
   wall-clock**). Actualizá `transmissions`: `status: 'live'`, `startedAt`, `resolvedStreamUrl`.
3. **Spawná ffmpeg** con este shape de argumentos (adaptá los nombres de archivo, pero mantené la semántica):
   ```
   ffmpeg -hide_banner -loglevel warning \
     -i <resolvedUrl> \
     -c copy -f segment -segment_time <segmentSeconds> -reset_timestamps 1 \
     -strftime 1 \
     <storagePrefix>/seg-%Y%m%d-%H%M%S.mp4
   ```
   - `-c copy` = **sin re-encode** (obligatorio).
   - `-f segment` = segmentado (obligatorio).
   - `-strftime 1` + timestamp en el nombre = permite anclar cada segmento al wall-clock real.
   - Si la fuente es HLS, agregá `-protocol_whitelist file,http,https,tcp,tls,crypto` **solo si hace falta**
     (verificá si ffmpeg local lo requiere; si no, omitilo).
4. **Monitoreá el directorio de segmentos**: cuando aparece un `.mp4` nuevo, calculá su `startMs` =
   `(mtimeDelArchivo - startedAtDeGrabacion) * 1000` y `endMs` = `startMs + duracionDelSegmento` (la duración
   real la podés obtener con `ffprobe` si está; si no, usá `segmentSeconds * 1000` como aproximación y
   ajustá `endMs` cuando el segmento siguiente aparezca). Insertá la fila en `recording_segments`
   (`sequence` incremental, `fileRef` = path relativo dentro del storage, `bytes` = tamaño real, `status:
   'active'`).
   - **Tolerancia**: `startMs` puede ser negativo si el reloj del archivo quedó atrás — clampeá a `>= 0`.
5. **Heartbeat**: actualizá `transmissions.last_heartbeat_at` periódicamente (ej. cada 15 s) mientras graba.
6. **Stream caído**: si ffmpeg sale con error **antes** de alcanzar la duración mínima esperada, reintentá
   (re-resolviendo la URL — el live puede haber kembali) hasta N reintentos (default 3) con backoff. Los
   segmentos ya escritos **NO se pierden**: quedan `active` y el hueco se refleja en los offsets.
7. **Límite de duración**: a los `maxDurationMinutes` (o `transmissions.duration_minutes`), **stop suave**:
   mandá `q` al stdin de ffmpeg o `SIGTERM`, esperá el exit, y cerrá la grabación con status `'completed'`.
   Actualizá `transmissions`: `status: 'processing'`, `endedAt`.
8. **Cierre**: marcá `stream_recordings.status = 'completed'`, `totalBytes` = suma de bytes, `endedAt`.
   Actualizá `transmissions.crudo_ref` = `storagePrefix` (**NO es una URL — es la raíz de storage**).
9. **Errores**: si la grabación falla de forma terminal, `stream_recordings.status = 'error'`,
   `transmissions.status = 'error'` + `errorMessage` descriptivo, y `done` resuelve con `status: 'error'`.
   **Siempre** cerrá los handles de ffmpeg y liberá los listeners.

**Toda query a la DB filtra por `tenantId`** — sin excepciones. Es una regla dura del repo.

## 3. Reanudación (PI-04) — parcial en este slice

Cuando el stream se cae y vuelve, el recorder **debe poder seguir grabando en el mismo `storagePrefix`**
con `sequence` incrementando y offsets coherentes. Implementá el "reintento" del punto 6 de forma que el
`recordingId` **se mantiene** (no se crea una `stream_recording` nueva): la spec dice
"reanudación = nuevos segmentos" dentro de la misma grabación.

## 4. Tests — `tests/streamRecorderService.test.ts` + `tests/streamSourceResolver.test.ts`

Tests **deterministas y sin red**. estrategia: **inyectá las dependencias** (binarios, resolver, storage,
DB) para poder testear con fakes. Si el diseño no permite inyectar, refactorizá para que sí.

Casos OBLIGATORIOS:
- `resolveStreamUrl` con URL `.m3u8` → devuelve `kind: 'hls'` y **no** invoca yt-dlp (verificá con un fake que
  cuente invocaciones).
- `resolveStreamUrl` con una URL de YouTube → invoca yt-dlp **con** `--proxy` cuando hay proxies configurados.
- **Rotación de proxies**: con 2 proxies, el primer intento usa el proxy 0; si falla, el segundo usa el proxy 1;
  si ambos fallan, el último reintento es **sin proxy**.
- `resolveStreamUrl` con URL inválida → error descriptivo.
- Recorder: **args de ffmpeg** — verificar que el comando incluye `-c copy` y `-f segment` y `-segment_time`.
  Testeá el constructor de args como función pura (exportala) para poder assertar sin spawnar ffmpeg.
- Recorder: **anclaje temporal** — `startMs` de un segmento es `>= 0` y consistente con `startedAt`.
- Recorder: `crudo_ref` queda con el `storagePrefix`, no una URL.

Si testear el recorder completo con ffmpeg real es inviable en este entorno, **no inventes**: extraé la lógica
a funciones puras testeables (construcción de args, cálculo de offsets, decisión de reintento) y testéalas.
Dejá explícito en el informe qué quedó verificado por test y qué no.

## 5. Gates — TODOS tienen que dar EXIT 0 real

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
```

Un gate que no imprime su línea de resumen NO está verificado. Reportá exit codes REALES.

## 6. Commit

- **UN commit** al final, con los gates verdes.
- Conventional Commits, mensaje en español, **sin atribución a IA**, sin `Co-Authored-By`.
  - Sugerido: `feat(recorder): captura de video segmentada con ffmpeg y proxy rotation`
- **Paths explícitos** (nunca `git add -A` ni `git add .`). Ajustá a lo que realmente creaste.
- **NO** push, **NO** merge, **NO** deploy. **NO** agregues `remotion/package-lock.json` (residuo del setup).

## 7. Informe final (obligatorio, en español)

1. Archivos creados/modificados (paths).
2. Exit code real de los 5 gates + línea de resumen de vitest + salida final del PGlite.
3. Qué imprimió `drizzle-kit generate` en `npm run build`.
4. SHA del commit + `git show --stat`.
5. `git status --short` final.
6. **Qué está verificado por test y qué NO** (separado, explícito).
7. Límites/supuestos tomados (ej.: si no pudiste probar ffmpeg real en este entorno, decilo).

Nada de "debería funcionar". Si algo no lo pudiste verificar, decilo.
