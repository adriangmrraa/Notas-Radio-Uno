/**
 * vodUploadService — fallback VOD para early adopters (PD-07, Parte B).
 *
 * Cuando YouTube bloquea la IP del datacenter (riesgo R-1) el canal no puede
 * capturar en vivo: el usuario sube el MP4 del programa y el sistema lo
 * ingiere como si fuera el crudo grabado — MISMO layout del recorder:
 *
 *   {tenantId}/{transmissionId}/vod/seg-00001.<ext>
 *
 *   transmissions.source = 'vod_upload', status = 'processing' (el crudo ya
 *   está — no hay live que esperar), crudo_ref = prefijo de storage.
 *   stream_recordings(status='completed') + recording_segments(1 segmento,
 *   start_ms=0, end_ms=durationMs, file_ref relativo, bytes reales).
 *
 * Reglas duras (Parte E):
 *   - tenantId SIEMPRE del token — toda query filtra por tenant_id y un
 *     programId ajeno ⇒ 404 (no se revela existencia).
 *   - El transmissionId del prefijo se genera ANTES de insertar y es el id
 *     real de la fila creada — nunca viene del body.
 *   - `publicPath` devuelve la ruta de filesystem: se usa para COPIAR el
 *     archivo a storage (mismo patrón que el recorder — la respuesta HTTP
 *     expone sólo la clave relativa, nunca la ruta absoluta).
 *
 * Verificación del archivo: `ffprobe` (mismo binario que usa el recorder
 * vía `lib/binaries`) chequea pista de video + duración. Si el binario no
 * existe en el entorno (ENOENT) la verificación se SALTEA — la validación
 * queda en extensión + tamaño y el resultado lo marca `videoVerified:null`
 * (warning explícito del informe PD-07). Si ffprobe corre y el archivo no
 * se lee o no tiene video ⇒ AppError 400.
 *
 * Dependencias inyectables (`deps`): store de DB, storage, probe y fetch —
 * los tests corren sin DB, sin ffprobe y sin red.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { and, eq } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { programs } from '../db/schema/programs.js';
import { recordingSegments, streamRecordings } from '../db/schema/recordings.js';
import { transmissions } from '../db/schema/transmissions.js';
import type { TransmissionRow } from './transmissionService.js';
import { findBinary } from '../lib/binaries.js';
import { AppError } from '../lib/errors.js';
import { getRawStorage, type RawStorage } from './rawStorageService.js';

// ─── Constantes del contrato ────────────────────────────────────────────────

/** Extensiones de video aceptadas (validación de la capa HTTP y del download). */
export const VOD_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv'] as const;

/**
 * Prefijo del segmento VOD dentro del storage_prefix de la transmisión.
 * El archivo queda como `vod/seg-00001.<ext>` — subdirectorio `vod/` para
 * distinguirlo de los `seg-*.mp4` que escribe el recorder en la raíz.
 */
export const VOD_SEGMENT_BASENAME = 'vod/seg-00001';

/** Content-types aceptables cuando la URL del VOD no tiene extensión. */
const VOD_MIME_TO_EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
};

// ─── Tipos ──────────────────────────────────────────────────────────────────

/** Resultado del probe de video (ffprobe o fake inyectado). */
export interface VideoProbeResult {
  /** El archivo tiene al menos una pista de video. */
  hasVideo: boolean;
  /** Duración reportada por el contenedor (ms) — puede ser null. */
  durationMs: number | null;
}

export interface VodBundleInsert {
  /** Id real de la fila transmissions (generado por el servicio). */
  transmissionId: string;
  tenantId: string;
  programId: string | null;
  /** Pseudo-URL descriptiva `vod://upload/<archivo>` — nunca una ruta local. */
  streamUrl: string;
  durationMinutes: number | null;
  /** Ancla wall-clock del programa (startedAt del body o el instante actual). */
  startedAt: Date;
  /** Prefijo de storage `{tenantId}/{transmissionId}` — va a crudo_ref. */
  storagePrefix: string;
  /** file_ref relativo del segmento (`vod/seg-00001.<ext>`). */
  fileRef: string;
  bytes: number;
  /** end_ms del segmento (start_ms siempre 0); null si no hay duración. */
  endMs: number | null;
  recordingStartedAt: Date;
  /** Rótulo del usuario — se persiste en pipeline_config.name. */
  name: string | null;
}

/**
 * Store del ingest VOD — TODA operación filtra por tenant_id. La inserción
 * del bundle (transmission + recording + segment) es UNA transacción.
 */
export interface VodUploadStore {
  /** El programa existe Y pertenece al tenant (id ajeno ⇒ false ⇒ 404). */
  programBelongsToTenant(tenantId: string, programId: string): Promise<boolean>;
  createVodBundle(v: VodBundleInsert): Promise<TransmissionRow>;
}

export interface VodIngestInput {
  tenantId: string;
  /** Archivo local ya validado (extensión + tamaño) por la capa HTTP. */
  filePath: string;
  /** Nombre original del upload — alimenta la pseudo stream_url. */
  originalName: string;
  /** Bytes reales del archivo. */
  bytes: number;
  programId?: string | null;
  /** Rótulo opcional del usuario — se conserva en pipeline_config.name. */
  name?: string | null;
  /** Duración del programa en minutos (5..480 — validado por la ruta). */
  durationMinutes?: number | null;
  /** Ancla wall-clock opcional (cuándo se emitió el programa). */
  startedAt?: Date;
}

export interface VodIngestResult {
  transmission: TransmissionRow;
  storagePrefix: string;
  fileRef: string;
  /**
   * `true` probe OK con video · `false` sería 400 (no retorna) · `null`
   * ffprobe no disponible: la pista de video NO quedó verificada (warning).
   */
  videoVerified: boolean | null;
  /** Duración usada para end_ms (de durationMinutes o del probe), o null. */
  durationMs: number | null;
}

export interface VodIngestDeps {
  store?: VodUploadStore;
  storage?: RawStorage;
  /** Probe de video; `null` lo desactiva. Default: ffprobe real. */
  probeVideo?: ((filePath: string) => Promise<VideoProbeResult | null>) | null;
  /** fetch inyectable para `downloadVodToTemp` (tests sin red). */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Generador de ids (default crypto.randomUUID) — determinista en tests. */
  newId?: () => string;
}

// ─── Store drizzle ──────────────────────────────────────────────────────────

/** Implementación drizzle — todas las queries filtran por tenant_id. */
export function createDrizzleVodUploadStore(executor: Database = db): VodUploadStore {
  return {
    async programBelongsToTenant(tenantId, programId) {
      const [row] = await executor
        .select({ id: programs.id })
        .from(programs)
        .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
        .limit(1);
      return !!row;
    },

    async createVodBundle(v) {
      return executor.transaction(async (tx) => {
        const [t] = await tx
          .insert(transmissions)
          .values({
            id: v.transmissionId,
            tenantId: v.tenantId,
            programId: v.programId,
            source: 'vod_upload',
            status: 'processing',
            streamUrl: v.streamUrl,
            crudoRef: v.storagePrefix,
            durationMinutes: v.durationMinutes,
            startedAt: v.startedAt,
            pipelineConfig: v.name != null ? { name: v.name } : {},
          })
          .returning();

        const [rec] = await tx
          .insert(streamRecordings)
          .values({
            tenantId: v.tenantId,
            transmissionId: v.transmissionId,
            storagePrefix: v.storagePrefix,
            status: 'completed',
            totalBytes: v.bytes,
            startedAt: v.recordingStartedAt,
            endedAt: v.recordingStartedAt,
          })
          .returning({ id: streamRecordings.id });

        await tx.insert(recordingSegments).values({
          tenantId: v.tenantId,
          recordingId: rec.id,
          sequence: 0,
          startMs: 0,
          endMs: v.endMs,
          fileRef: v.fileRef,
          bytes: v.bytes,
          status: 'active',
        });

        return t;
      });
    },
  };
}

// ─── Probe de video (ffprobe) ───────────────────────────────────────────────

/**
 * Probe real: `ffprobe -show_entries stream=codec_type:format=duration` en
 * JSON. ENOENT (binario ausente) ⇒ null — el caller decide saltear la
 * verificación; cualquier otro fallo (archivo ilegible/corrupto) ⇒
 * hasVideo:false. Misma filosofía que `createFfprobeDurationProbe` del
 * recorder: el probe nunca tumba por excepción, informa por resultado.
 */
export function createFfprobeVideoProbe(
  ffprobePath: string = findBinary('ffprobe'),
): (filePath: string) => Promise<VideoProbeResult | null> {
  return (filePath) =>
    new Promise((resolve) => {
      execFile(
        ffprobePath,
        [
          '-v', 'error',
          '-print_format', 'json',
          '-show_entries', 'stream=codec_type:format=duration',
          filePath,
        ],
        { timeout: 15_000 },
        (error, stdout) => {
          if (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              resolve(null); // ffprobe no está en el entorno
              return;
            }
            resolve({ hasVideo: false, durationMs: null });
            return;
          }
          try {
            const info = JSON.parse(stdout.toString()) as {
              streams?: Array<{ codec_type?: string }>;
              format?: { duration?: string };
            };
            const hasVideo = (info.streams ?? []).some(
              (s) => s.codec_type === 'video',
            );
            const seconds = Number.parseFloat(info.format?.duration ?? '');
            resolve({
              hasVideo,
              durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
            });
          } catch {
            resolve({ hasVideo: false, durationMs: null });
          }
        },
      );
    });
}

// ─── Descarga del VOD por URL (fallback del fallback) ───────────────────────

export interface VodDownloadResult {
  filePath: string;
  bytes: number;
  /** Nombre derivado de la URL (o del content-type) — para logs/pseudo-url. */
  fileName: string;
}

/**
 * Descarga `vodUrl` (http/https) a un archivo temporal con cota de tamaño.
 * Content-Length mayor al máximo ⇒ 400 sin descargar; si el stream supera
 * el máximo en curso ⇒ 400 y el temporal se borra. La extensión sale del
 * path de la URL o, en su defecto, del Content-Type video/*.
 */
export async function downloadVodToTemp(
  vodUrl: string,
  opts: {
    maxBytes: number;
    destDir?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<VodDownloadResult> {
  let parsed: URL;
  try {
    parsed = new URL(vodUrl);
  } catch {
    throw new AppError('vodUrl inválida: tiene que ser una URL http/https', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('vodUrl inválida: tiene que ser una URL http/https', 400);
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  let res: Response;
  try {
    res = await fetchImpl(vodUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AppError(
      `No se pudo descargar el VOD: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }
  if (!res.ok || !res.body) {
    throw new AppError(`No se pudo descargar el VOD (HTTP ${res.status})`, 400);
  }

  const maxGb = Math.round((opts.maxBytes / 1024 ** 3) * 10) / 10;
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    throw new AppError(`El archivo supera el máximo de ${maxGb} GB`, 400);
  }

  // Extensión: del path de la URL o del Content-Type video/*.
  const base = path.basename(parsed.pathname);
  let ext = path.extname(base).toLowerCase();
  if (!(VOD_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    ext = VOD_MIME_TO_EXT[mime] ?? '';
  }
  if (ext === '') {
    throw new AppError(
      `La URL del VOD no tiene una extensión de video reconocible (${VOD_VIDEO_EXTENSIONS.join(', ')})`,
      400,
    );
  }

  const destDir = opts.destDir ?? path.join(os.tmpdir(), 'periodistapp-vod');
  await fs.mkdir(destDir, { recursive: true });
  const fileName = base || `vod-descargado${ext}`;
  const filePath = path.join(destDir, `vod-${randomUUID()}${ext}`);

  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        cb(new AppError(`El archivo supera el máximo de ${maxGb} GB`, 400));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      counter,
      createWriteStream(filePath),
    );
  } catch (err) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    if (err instanceof AppError) throw err;
    throw new AppError(
      `No se pudo descargar el VOD: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }
  if (bytes === 0) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw new AppError('El archivo descargado está vacío', 400);
  }
  return { filePath, bytes, fileName };
}

// ─── Ingest principal ───────────────────────────────────────────────────────

function sanitizePseudoName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 120) || 'video';
}

/**
 * Ingesta el archivo ya descargado/subido: verifica programa del tenant,
 * probea pista de video con ffprobe, copia a RawStorage y persiste el
 * bundle (transmission + recording + segment) en una transacción.
 *
 * NO borra `filePath`: el temporal lo creó y lo borra el caller (la ruta,
 * para el upload de multer; `downloadVodToTemp` + caller para vodUrl).
 */
export async function ingestVodUpload(
  input: VodIngestInput,
  deps: VodIngestDeps = {},
): Promise<VodIngestResult> {
  const store = deps.store ?? createDrizzleVodUploadStore();
  const storage = deps.storage ?? getRawStorage();
  const probeVideo =
    deps.probeVideo === undefined ? createFfprobeVideoProbe() : deps.probeVideo;
  const now = deps.now?.() ?? new Date();
  const newId = deps.newId ?? randomUUID;

  if (input.programId) {
    const belongs = await store.programBelongsToTenant(input.tenantId, input.programId);
    if (!belongs) {
      throw new AppError('Programa no encontrado', 404);
    }
  }

  // Probe de pista de video: null ⇒ ffprobe ausente → se valida por
  // extensión + tamaño y queda el warning (`videoVerified: null`).
  const probe = probeVideo ? await probeVideo(input.filePath) : null;
  if (probe !== null && !probe.hasVideo) {
    throw new AppError('El archivo no contiene una pista de video válida', 400);
  }

  const transmissionId = newId();
  const storagePrefix = `${input.tenantId}/${transmissionId}`;
  const ext = path.extname(input.originalName).toLowerCase() || '.mp4';
  const fileRef = `${VOD_SEGMENT_BASENAME}${ext}`;

  // Copia a storage vía publicPath (mismo patrón que el recorder: D-1
  // self-hosted). copyFile no carga el archivo en memoria — crítico para
  // videos grandes.
  const vodDir = storage.publicPath(`${storagePrefix}/vod`);
  await fs.mkdir(vodDir, { recursive: true });
  const bytes =
    input.bytes > 0 ? input.bytes : (await fs.stat(input.filePath)).size;
  await fs.copyFile(input.filePath, path.join(vodDir, path.basename(fileRef)));

  const durationMs =
    input.durationMinutes != null
      ? input.durationMinutes * 60_000
      : (probe?.durationMs ?? null);
  const durationMinutes =
    input.durationMinutes ??
    (probe?.durationMs != null ? Math.max(1, Math.round(probe.durationMs / 60_000)) : null);
  const anchor = input.startedAt ?? now;
  const streamUrl = `vod://upload/${sanitizePseudoName(input.originalName)}`;

  try {
    const transmission = await store.createVodBundle({
      transmissionId,
      tenantId: input.tenantId,
      programId: input.programId ?? null,
      streamUrl,
      durationMinutes,
      startedAt: anchor,
      storagePrefix,
      fileRef,
      bytes,
      endMs: durationMs,
      recordingStartedAt: now,
      name: input.name ?? null,
    });

    return {
      transmission,
      storagePrefix,
      fileRef,
      videoVerified: probe?.hasVideo ?? null,
      durationMs,
    };
  } catch (err) {
    // La tx falló: el archivo no puede quedar huérfano en storage.
    await storage.deletePrefix(storagePrefix).catch(() => {});
    throw err;
  }
}
