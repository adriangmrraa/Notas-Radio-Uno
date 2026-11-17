/**
 * s3BackupStorage — driver S3/R2 del `BackupStorage` (Épica J / PJ-05).
 *
 * Implementa la misma interfaz chica que `FilesystemBackupStorage` sobre un
 * bucket S3-compatible (AWS, R2, MinIO, etc.) vía `@aws-sdk/client-s3`.
 *
 * Selección: `getBackupStorage()` en `assetBackupService.ts` lo activa con
 * `BACKUP_DRIVER=s3` (default `fs`). Variables:
 *   - `S3_BUCKET`      (requerida)
 *   - `S3_REGION`      (default `us-east-1`; R2 usa `auto`)
 *   - `S3_ENDPOINT`    (opcional — R2/MinIO; vacío → AWS estándar)
 *   - `S3_ACCESS_KEY`  (requerida)
 *   - `S3_SECRET_KEY`  (requerida)
 *   - `S3_PREFIX`      (opcional — prefijo de keys dentro del bucket)
 *
 * Scope honesto: el destino de backup es WRITE-ONLY para el sync (stat para
 * comparar, write, delete por prefijo, exists). `publicPath` devuelve el URI
 * `s3://{bucket}/{key}` — NINGÚN consumidor lo usa como ruta local (el
 * recorder/ffmpeg del crudo no pasa por este adapter; ver decisión en
 * docs/EPICA-J.md: S3 para el crudo requiere staging local + upload).
 *
 * Guard de keys: mismo criterio que el fs adapter — vacías, NUL, absolutas,
 * backslash o segmentos `..` se rechazan ANTES de tocar el bucket.
 */
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { BackupStorage } from './assetBackupService.js';

/** Subconjunto del SDK que el driver necesita (los tests inyectan un fake). */
export interface S3LikeClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3BackupStorageOptions {
  client?: S3LikeClient;
  bucket?: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Resuelve una key relativa de storage a la key completa en el bucket.
 * Rechaza keys vacías, NUL, backslash, absolutas (`/`, `C:`) y cualquier
 * segmento `..` — el guard corre antes de cualquier request al bucket.
 */
function resolveKey(prefix: string, key: string): string {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) {
    throw new Error(`S3BackupStorage: key inválida: ${JSON.stringify(key)}`);
  }
  if (key.includes('\\')) {
    throw new Error(`S3BackupStorage: la key usa backslash: ${JSON.stringify(key)}`);
  }
  if (key.startsWith('/') || /^[a-zA-Z]:/.test(key)) {
    throw new Error(`S3BackupStorage: la key es absoluta: ${JSON.stringify(key)}`);
  }
  const segments = key.split('/');
  if (segments.some((s) => s === '..' || s === '')) {
    throw new Error(
      `S3BackupStorage: la key escapa de la raíz de storage: ${JSON.stringify(key)}`,
    );
  }
  return prefix ? `${prefix.replace(/\/+$/, '')}/${key}` : key;
}

/** Prefijo para deletes/listados (acepta prefijos de directorio sin archivo). */
function resolvePrefix(prefix: string, keyPrefix: string): string {
  if (typeof keyPrefix !== 'string' || keyPrefix.length === 0 || keyPrefix.includes('\0')) {
    throw new Error(`S3BackupStorage: prefijo inválido: ${JSON.stringify(keyPrefix)}`);
  }
  if (keyPrefix.includes('\\') || keyPrefix.startsWith('/') || /^[a-zA-Z]:/.test(keyPrefix)) {
    throw new Error(`S3BackupStorage: prefijo absoluto/backslash: ${JSON.stringify(keyPrefix)}`);
  }
  const segs = keyPrefix.split('/').filter(Boolean);
  if (segs.some((s) => s === '..')) {
    throw new Error(
      `S3BackupStorage: el prefijo escapa de la raíz: ${JSON.stringify(keyPrefix)}`,
    );
  }
  const joined = segs.join('/');
  return prefix ? `${prefix.replace(/\/+$/, '')}/${joined}` : joined;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  if (body && typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  if (body && Symbol.asyncIterator in (body as object)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('S3BackupStorage: body de GetObject no es leíble');
}

export class S3BackupStorage implements BackupStorage {
  private readonly client: S3LikeClient;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3BackupStorageOptions = {}) {
    this.bucket = opts.bucket ?? env('S3_BUCKET') ?? '';
    if (!this.bucket) {
      throw new Error(
        'S3BackupStorage: S3_BUCKET no está configurada (BACKUP_DRIVER=s3 la requiere)',
      );
    }
    this.prefix = opts.prefix ?? env('S3_PREFIX') ?? '';
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region ?? env('S3_REGION') ?? 'us-east-1',
        ...(opts.endpoint ?? env('S3_ENDPOINT')
          ? {
              endpoint: opts.endpoint ?? env('S3_ENDPOINT'),
              // R2/MinIO usan path-style; AWS soporta ambos — forzar path-style
              // maximiza compatibilidad con endpoints custom.
              forcePathStyle: true,
            }
          : {}),
        // Solo setear credenciales si AMBAS están — si no, dejar la cadena
        // de providers del SDK (env, IAM role, ~/.aws). Pasar strings vacíos
        // la cortocircuita y rompe la firma.
        ...(() => {
          const accessKeyId = opts.accessKey ?? env('S3_ACCESS_KEY');
          const secretAccessKey = opts.secretKey ?? env('S3_SECRET_KEY');
          return accessKeyId && secretAccessKey
            ? { credentials: { accessKeyId, secretAccessKey } }
            : {};
        })(),
      });
  }

  async writeFile(key: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: resolveKey(this.prefix, key),
        Body: data,
      }),
    );
  }

  async readFile(key: string): Promise<Buffer> {
    const out = (await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: resolveKey(this.prefix, key),
      }),
    )) as { Body?: unknown };
    return streamToBuffer(out.Body);
  }

  async statFile(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const out = (await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: resolveKey(this.prefix, key),
        }),
      )) as { ContentLength?: number; LastModified?: Date };
      return {
        size: out.ContentLength ?? 0,
        mtimeMs: out.LastModified ? out.LastModified.getTime() : 0,
      };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === 'NotFound' || status === 404) return null;
      throw err;
    }
  }

  /** Borra TODOS los objetos bajo el prefijo (paginado, lotes de 1000). */
  async deletePrefix(prefix: string): Promise<void> {
    const full = resolvePrefix(this.prefix, prefix);
    if (!full) return;
    let token: string | undefined;
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: full.endsWith('/') ? full : `${full}/`,
          ContinuationToken: token,
        }),
      )) as {
        Contents?: { Key?: string }[];
        NextContinuationToken?: string;
      };
      const keys = (page.Contents ?? [])
        .map((c) => c.Key)
        .filter((k): k is string => Boolean(k));
      for (let i = 0; i < keys.length; i += 1000) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: {
              Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })),
              Quiet: true,
            },
          }),
        );
      }
      token = page.NextContinuationToken;
    } while (token);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.statFile(key)) !== null;
  }

  /**
   * URI del objeto — `s3://{bucket}/{prefix}{key}`. NO es una ruta local ni
   * una URL HTTP firmada: documentado en el header del módulo.
   */
  publicPath(key: string): string {
    return `s3://${this.bucket}/${resolveKey(this.prefix, key)}`;
  }
}
