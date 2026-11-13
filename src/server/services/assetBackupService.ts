/**
 * assetBackupService — backup incremental de assets derivados (PI-05).
 *
 * Espejo incremental de los archivos que el producto GENERA (renders de
 * clips, quote-flyers, imágenes) hacia un árbol de backup separado, usando
 * el MISMO patrón de adapter que `rawStorageService.ts`: interface chica
 * (`BackupStorage`) + implementación filesystem hoy; el backend S3/R2 llega
 * implementando la interfaz y seleccionándose en `getBackupStorage()` — sin
 * tocar consumidores. La MISMA clase se usa dos veces con raíces distintas:
 * la fuente (`ASSET_SOURCE_ROOT` o `<repo>/output`, convención `OUTPUT_DIR`
 * de `index.ts`) y el destino (`BACKUP_ROOT` o `<repo>/data/backup`).
 *
 * Fuentes escaneadas (todas filtran `tenant_id`):
 *   - `clips.video_path` — MP4 del render vigente (cutter / reframe / subs:
 *      los tres lo pisan con el archivo nuevo bajo `output/`).
 *   - `clips.subtitles_path` — MP4 con subtítulos+branding quemados.
 *   - `clips.metadata->>'sourceVideoPath'` — el render ANTERIOR que reframe/
 *      subs deja auditable (sigue existiendo en disco: también se respalda).
 *   - `publications.image_path` — imagen generada/editada de la pieza.
 *   - `publications.quote_flyer_paths[]` — flyers por cita (jsonb array).
 *   `clips.audio_path` NO se respalda: es el audio de INPUT del corte (no un
 *   render derivado — documentado para que nadie lo "arregle" a lo bestia).
 *   El ledger `assets` (PF-10) no se escanea aparte: es una CAPA sobre
 *   clips/publications — sus `payload.videoPath`/`flyerPath` son los mismos
 *   paths ya cubiertos, y el manifest deduparía por (tenant, source_path).
 *
 * Decisiones documentadas:
 *   - Manifest en TABLA `asset_backup_entries` (no jsonb): el repo modela
 *     estado durable por dominio con pgTable (job_queue, ai_usage_events,
 *     assets) — un jsonb liviano rompería la convención de migraciones
 *     drizzle + verificador PGlite y complicaría la cobertura por tenant
 *     (GROUP BY) que pide el endpoint status. UNIQUE (tenant_id,
 *     source_path) = contrato de idempotencia, mismo patrón que assets.
 *   - Idempotencia por `bytes` + `source_mtime_ms` (test barato de cambio,
 *     estilo rsync): si la entrada `backed_up` coincide en size+mtime con el
 *     stat de la fuente, se saltea SIN LEER el archivo — una segunda
 *     corrida es un no-op de puros stats. `checksum` sha256 se persiste por
 *     integridad del respaldo, no como detector de cambio (releer y hashear
 *     cada archivo en cada corrida saldría caro en MP4s). Trade-off
 *     aceptado: un archivo reescrito con el mismo size Y el mismo mtime se
 *     saltea (idéntico al criterio default de rsync).
 *   - `source_path` en DB puede venir como ruta ABSOLUTA (convención
 *     `videoPath` = `path.join(PROJECT_ROOT,'output',...)`) o relativa
 *     `output/x.jpg`: `resolveSourceKey` normaliza a una key relativa bajo
 *     la raíz fuente. Lo que resuelva FUERA de la raíz (path traversal o
 *     archivo ajeno al árbol derivado) NO se respalda — va a `errors[]`.
 *   - `backup_path` = `{tenantId}/{sourceKey}`: el árbol de backup queda
 *     tenant-scoped igual que TODA escritura del repo. Los nombres bajo
 *     output/ son únicos por construcción (uuid / clip_id), así que la key
 *     relativa preserva el nombre 1:1.
 *   - Fuente ausente en disco → entrada `status='missing'` (el sync la vio
 *     y no hay qué copiar; si reaparece, el próximo run la copia). Fallo de
 *     copia → `status='error'` + `last_error`, y la próxima corrida
 *     reintenta. Una falla NO aborta el job: el error va a
 *     `BackupOutcome.errors[]` y se sigue con la fuente siguiente — igual
 *     que `purgeExpiredRecordings`.
 *   - `dryRun` idéntico al del purge: calcula el outcome completo sin
 *     escribir archivos NI tocar el manifest.
 *   - Tenant-scoped en TODA escritura (regla dura): las lecturas de
 *     fuentes y el upsert del manifest llevan `tenant_id`; `opts.tenantId`
 *     acota el scan para la corrida manual del endpoint admin.
 *
 * Dependencias inyectables (`deps`): `BackupStore` (drizzle en prod, memoria
 * en tests — mismos filtros por tenant), `source`/`backup` (`BackupStorage`
 * real o fake que registra llamadas), `checksumOf` (sha256 por default).
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, count, eq, max, sql, sum } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { assetBackupEntries } from '../db/schema/assetBackup.js';
import { clips } from '../db/schema/clips.js';
import { publications } from '../db/schema/publications.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ─── Adapter de storage (misma filosofía que rawStorageService) ─────────────

/**
 * Interfaz chica del storage de backup — y de la fuente. Las `key` son
 * rutas relativas bajo la raíz del adapter; toda key se valida contra
 * path traversal ANTES de tocar el disco (mismo guard que RawStorage).
 */
export interface BackupStorage {
  writeFile(key: string, data: Buffer): Promise<void>;
  readFile(key: string): Promise<Buffer>;
  /** size + mtimeMs — el par del test de cambio; null si no existe. */
  statFile(key: string): Promise<{ size: number; mtimeMs: number } | null>;
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  publicPath(key: string): string;
}

function backupRoot(): string {
  return process.env.BACKUP_ROOT || path.join(PROJECT_ROOT, 'data', 'backup');
}

function assetSourceRoot(): string {
  return (
    process.env.ASSET_SOURCE_ROOT || path.join(PROJECT_ROOT, 'output')
  );
}

export class FilesystemBackupStorage implements BackupStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Resuelve una key a una ruta absoluta garantizadamente bajo `root`.
   * Mismo guard que `FilesystemRawStorage.resolveKey`: vacías, NUL,
   * absolutas o escapes (`..`) se rechazan con error descriptivo.
   */
  private resolveKey(key: string): string {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) {
      throw new Error(`BackupStorage: key inválida: ${JSON.stringify(key)}`);
    }
    const resolved = path.resolve(this.root, key);
    const rel = path.relative(this.root, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(
        `BackupStorage: la key escapa de la raíz de storage: ${JSON.stringify(key)}`,
      );
    }
    return resolved;
  }

  async writeFile(key: string, data: Buffer): Promise<void> {
    const file = this.resolveKey(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }

  async readFile(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(key));
  }

  async statFile(key: string): Promise<{ size: number; mtimeMs: number } | null> {
    const stat = await fs.stat(this.resolveKey(key)).catch(() => null);
    return stat && stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
  }

  async deletePrefix(prefix: string): Promise<void> {
    await fs.rm(this.resolveKey(prefix), { recursive: true, force: true });
  }

  async exists(key: string): Promise<boolean> {
    return fs
      .access(this.resolveKey(key))
      .then(() => true)
      .catch(() => false);
  }

  publicPath(key: string): string {
    return this.resolveKey(key);
  }
}

let cachedBackup: BackupStorage | null = null;
let cachedSource: BackupStorage | null = null;

/**
 * BackupStorage destino del espejo. Hoy siempre filesystem bajo
 * `BACKUP_ROOT`/`<repo>/data/backup`; el driver S3/R2 se selecciona acá
 * (p.ej. por `BACKUP_DRIVER`) implementando la misma interfaz.
 */
export function getBackupStorage(): BackupStorage {
  cachedBackup ??= new FilesystemBackupStorage(backupRoot());
  return cachedBackup;
}

/**
 * Storage de la FUENTE: el árbol de assets derivados (`<repo>/output` por
 * convención `OUTPUT_DIR`, sobre-escribible con `ASSET_SOURCE_ROOT` para
 * despliegues que lo muevan — tests incluidos). Misma interfaz, otra raíz.
 */
export function getAssetSourceStorage(): BackupStorage {
  cachedSource ??= new FilesystemBackupStorage(assetSourceRoot());
  return cachedSource;
}

// ─── API pública ────────────────────────────────────────────────────────────

/** Una referencia a archivo derivado que el sync debe espejar. */
export interface AssetSourceRow {
  tenantId: string;
  /** Path tal como figura en la fila origen (absoluto o `output/x`). */
  sourcePath: string;
  /** Procedencia legible, p.ej. `clip:{id}:video_path`. */
  sourceRef: string;
}

/** Entrada del manifest `asset_backup_entries`. */
export interface BackupEntry {
  tenantId: string;
  sourcePath: string;
  sourceRef: string;
  backupPath: string;
  bytes: number;
  sourceMtimeMs: number;
  checksum: string | null;
  status: 'backed_up' | 'missing' | 'error';
  lastError: string | null;
  backedUpAt: Date;
}

export interface BackupOutcome {
  /** Fuentes candidatas evaluadas en la corrida. */
  scanned: number;
  /** Copiadas (o que se copiarían, en dryRun) esta corrida. */
  copied: number;
  /** Ya respaldadas y sin cambios (size+mtime iguales). */
  skipped: number;
  /** La fila origen apunta a un archivo que ya no existe. */
  missing: number;
  bytesCopied: number;
  errors: Array<{ sourcePath: string; message: string }>;
}

/** Cobertura por tenant para `GET /admin/backup/status`. */
export interface BackupTenantCoverage {
  tenantId: string;
  /** Entradas `backed_up` del tenant. */
  entries: number;
  /** Bytes respaldados (sólo entradas `backed_up`). */
  bytes: number;
  /** Entradas cuya fuente ya no existe en disco. */
  missing: number;
  /** Entradas cuya última copia falló. */
  errors: number;
  /** Última vez que el sync tocó una entrada de este tenant. */
  lastBackedUpAt: Date | null;
}

export interface BackupStatus {
  tenants: BackupTenantCoverage[];
  /** Máximo `backed_up_at` global — la última corrida registrada. */
  lastRunAt: Date | null;
}

export interface BackupStore {
  /**
   * Referencias a archivos derivados de las tablas fuente (clips +
   * publications). Cada fila lleva su `tenant_id` real — el aislamiento NO
   * depende del caller. `tenantId` opcional acota el scan (modo manual del
   * endpoint); `limit` corta el lote para que el job no bloquee la DB.
   */
  listAssetSources(opts: {
    limit: number;
    tenantId?: string;
  }): Promise<AssetSourceRow[]>;
  /** Entrada del manifest para (tenant, source_path) — null si nunca se vio. */
  getEntry(tenantId: string, sourcePath: string): Promise<BackupEntry | null>;
  /**
   * Upsert del manifest: INSERT ON CONFLICT (tenant_id, source_path) DO
   * UPDATE — la UNIQUE es el contrato de idempotencia (re-correr nunca
   * duplica). Toda escritura lleva `tenant_id` embebido en la fila.
   */
  recordEntry(entry: BackupEntry): Promise<void>;
  /** Cobertura por tenant (admin cross-tenant, lectura). */
  summarize(opts?: { tenantId?: string }): Promise<BackupTenantCoverage[]>;
}

export interface BackupDeps {
  store?: BackupStore;
  /** Storage del árbol derivado (default `<repo>/output`). */
  source?: BackupStorage;
  /** Storage destino del espejo (default `<repo>/data/backup`). */
  backup?: BackupStorage;
  /** Hash del contenido copiado (default sha256 hex). */
  checksumOf?: (data: Buffer) => string;
}

// ─── Constantes ─────────────────────────────────────────────────────────────

/** Lote máximo de fuentes por corrida — el sync no bloquea la DB de una vez. */
export const DEFAULT_SYNC_LIMIT = 200;

// ─── Implementación drizzle del store ───────────────────────────────────────

/** Implementación drizzle — las lecturas/escrituras siempre filtran `tenant_id`. */
export function createDrizzleBackupStore(
  executor: Database = db,
): BackupStore {
  return {
    async listAssetSources(opts) {
      const clipTenant = opts.tenantId ? eq(clips.tenantId, opts.tenantId) : undefined;
      const pubTenant = opts.tenantId ? eq(publications.tenantId, opts.tenantId) : undefined;

      // Render vigente + render anterior auditable + MP4 con subs.
      const clipRows = await executor
        .select({
          tenantId: clips.tenantId,
          clipId: clips.id,
          videoPath: clips.videoPath,
          subtitlesPath: clips.subtitlesPath,
          previousVideoPath: sql<string | null>`${clips.metadata} ->> 'sourceVideoPath'`,
        })
        .from(clips)
        .where(
          and(
            clipTenant,
            sql`(${clips.videoPath} is not null or ${clips.subtitlesPath} is not null or ${clips.metadata} ->> 'sourceVideoPath' is not null)`,
          ),
        )
        .orderBy(asc(clips.createdAt))
        .limit(opts.limit);

      const pubRows = await executor
        .select({
          tenantId: publications.tenantId,
          pubId: publications.id,
          imagePath: publications.imagePath,
          flyerPaths: publications.quoteFlyerPaths,
        })
        .from(publications)
        .where(
          and(
            pubTenant,
            sql`(${publications.imagePath} is not null or jsonb_array_length(coalesce(${publications.quoteFlyerPaths}, '[]'::jsonb)) > 0)`,
          ),
        )
        .orderBy(asc(publications.createdAt))
        .limit(opts.limit);

      const rows: AssetSourceRow[] = [];
      for (const c of clipRows) {
        if (c.previousVideoPath) {
          rows.push({
            tenantId: c.tenantId,
            sourcePath: c.previousVideoPath,
            sourceRef: `clip:${c.clipId}:metadata.sourceVideoPath`,
          });
        }
        if (c.videoPath) {
          rows.push({
            tenantId: c.tenantId,
            sourcePath: c.videoPath,
            sourceRef: `clip:${c.clipId}:video_path`,
          });
        }
        if (c.subtitlesPath) {
          rows.push({
            tenantId: c.tenantId,
            sourcePath: c.subtitlesPath,
            sourceRef: `clip:${c.clipId}:subtitles_path`,
          });
        }
      }
      for (const p of pubRows) {
        if (p.imagePath) {
          rows.push({
            tenantId: p.tenantId,
            sourcePath: p.imagePath,
            sourceRef: `publication:${p.pubId}:image_path`,
          });
        }
        const flyers = Array.isArray(p.flyerPaths) ? (p.flyerPaths as unknown[]) : [];
        flyers.forEach((fp, i) => {
          if (typeof fp === 'string' && fp.length > 0) {
            rows.push({
              tenantId: p.tenantId,
              sourcePath: fp,
              sourceRef: `publication:${p.pubId}:quote_flyer_paths[${i}]`,
            });
          }
        });
      }
      // Dedup por (tenant, source_path) al nivel del service — el manifest
      // tiene la misma UNIQUE, así que esto sólo evita trabajo repetido en
      // la misma corrida (dos refs pueden apuntar al mismo archivo).
      const seen = new Set<string>();
      return rows
        .filter((r) => {
          const k = `${r.tenantId}${r.sourcePath}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, opts.limit);
    },

    async getEntry(tenantId, sourcePath) {
      const [row] = await executor
        .select()
        .from(assetBackupEntries)
        .where(
          and(
            eq(assetBackupEntries.tenantId, tenantId),
            eq(assetBackupEntries.sourcePath, sourcePath),
          ),
        )
        .limit(1);
      return row ? toEntry(row) : null;
    },

    async recordEntry(entry) {
      // Upsert por la UNIQUE (tenant_id, source_path): la misma fuente
      // siempre pisa la MISMA fila — re-correr el sync nunca duplica.
      await executor
        .insert(assetBackupEntries)
        .values({
          tenantId: entry.tenantId,
          sourcePath: entry.sourcePath,
          sourceRef: entry.sourceRef,
          backupPath: entry.backupPath,
          bytes: entry.bytes,
          sourceMtimeMs: entry.sourceMtimeMs,
          checksum: entry.checksum,
          status: entry.status,
          lastError: entry.lastError,
          backedUpAt: entry.backedUpAt,
        })
        .onConflictDoUpdate({
          target: [assetBackupEntries.tenantId, assetBackupEntries.sourcePath],
          set: {
            sourceRef: entry.sourceRef,
            backupPath: entry.backupPath,
            bytes: entry.bytes,
            sourceMtimeMs: entry.sourceMtimeMs,
            checksum: entry.checksum,
            status: entry.status,
            lastError: entry.lastError,
            backedUpAt: entry.backedUpAt,
          },
        });
    },

    // EXCEPCIÓN cross-tenant documentada: cobertura agregada para el panel
    // admin (requirePlatformAdmin) — lectura solamente, mismos criterios que
    // jobQueueService.countByStatus sin tenant.
    async summarize(opts) {
      const rows = await executor
        .select({
          tenantId: assetBackupEntries.tenantId,
          status: assetBackupEntries.status,
          entries: count(),
          bytes: sum(assetBackupEntries.bytes),
          lastBackedUpAt: max(assetBackupEntries.backedUpAt),
        })
        .from(assetBackupEntries)
        .where(opts?.tenantId ? eq(assetBackupEntries.tenantId, opts.tenantId) : undefined)
        .groupBy(assetBackupEntries.tenantId, assetBackupEntries.status);

      const byTenant = new Map<string, BackupTenantCoverage>();
      for (const r of rows) {
        const cov =
          byTenant.get(r.tenantId) ??
          {
            tenantId: r.tenantId,
            entries: 0,
            bytes: 0,
            missing: 0,
            errors: 0,
            lastBackedUpAt: null,
          };
        if (r.status === 'backed_up') {
          cov.entries += r.entries;
          cov.bytes += Number(r.bytes ?? 0);
        } else if (r.status === 'missing') {
          cov.missing += r.entries;
        } else if (r.status === 'error') {
          cov.errors += r.entries;
        }
        if (
          r.lastBackedUpAt &&
          (cov.lastBackedUpAt === null || r.lastBackedUpAt > cov.lastBackedUpAt)
        ) {
          cov.lastBackedUpAt = r.lastBackedUpAt;
        }
        byTenant.set(r.tenantId, cov);
      }
      return [...byTenant.values()].sort((a, b) =>
        a.tenantId.localeCompare(b.tenantId),
      );
    },
  };
}

function toEntry(row: typeof assetBackupEntries.$inferSelect): BackupEntry {
  return {
    tenantId: row.tenantId,
    sourcePath: row.sourcePath,
    sourceRef: row.sourceRef,
    backupPath: row.backupPath,
    bytes: row.bytes,
    sourceMtimeMs: row.sourceMtimeMs,
    checksum: row.checksum,
    status: row.status as BackupEntry['status'],
    lastError: row.lastError,
    backedUpAt: row.backedUpAt,
  };
}

// ─── Funciones del servicio ─────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultChecksum(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function resolveDeps(deps: BackupDeps): Required<BackupDeps> {
  return {
    store: deps.store ?? createDrizzleBackupStore(),
    source: deps.source ?? getAssetSourceStorage(),
    backup: deps.backup ?? getBackupStorage(),
    checksumOf: deps.checksumOf ?? defaultChecksum,
  };
}

/**
 * Normaliza un `source_path` de la fila origen a una key relativa bajo la
 * raíz fuente (`output/`):
 *   - absoluta (`/…/output/x.mp4`, `C:\…\output\x.mp4`) → relativa a la raíz;
 *   - `output/x` o `./output/x` → `x`;
 *   - nombre suelto `x.jpg` → `x.jpg`.
 * Devuelve `null` si resuelve FUERA de la raíz (path traversal o archivo
 * ajeno al árbol derivado): ese source no se respalda.
 */
export function resolveSourceKey(
  sourcePath: string,
  sourceRoot: string = assetSourceRoot(),
): string | null {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) return null;
  const posix = sourcePath.replace(/\\/g, '/');
  if (path.isAbsolute(sourcePath) || /^[a-zA-Z]:\//.test(posix)) {
    const rel = path.relative(sourceRoot, sourcePath).replace(/\\/g, '/');
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  }
  const rel = posix.replace(/^\.\//, '').replace(/^output\//, '');
  if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) {
    return null;
  }
  return rel;
}

/**
 * Espejo incremental: copia al backup sólo lo nuevo/modificado y actualiza
 * el manifest. `now` inyectable para tests; `opts.tenantId` acota el scan
 * (modo manual del endpoint admin); `dryRun` devuelve lo que la corrida
 * HARÍA sin escribir archivos ni manifest.
 */
export async function syncAssetBackups(
  now: Date,
  opts: { limit?: number; dryRun?: boolean; tenantId?: string } = {},
  deps: BackupDeps = {},
): Promise<BackupOutcome> {
  const { store, source, backup, checksumOf } = resolveDeps(deps);
  const outcome: BackupOutcome = {
    scanned: 0,
    copied: 0,
    skipped: 0,
    missing: 0,
    bytesCopied: 0,
    errors: [],
  };

  const rows = await store.listAssetSources({
    limit: opts.limit ?? DEFAULT_SYNC_LIMIT,
    tenantId: opts.tenantId,
  });
  outcome.scanned = rows.length;

  for (const row of rows) {
    // Fuera del try: si resuelve, la key destino queda disponible para el
    // catch (una fuente que resolvió pero falló la copia queda en 'error'
    // con su backup_path real, no con un placeholder).
    const sourceKey = resolveSourceKey(row.sourcePath);
    if (!sourceKey) {
      // Fuera de la raíz derivada: no se respalda (documentado arriba).
      outcome.errors.push({
        sourcePath: row.sourcePath,
        message: 'la ruta resuelve fuera de la raíz de assets',
      });
      continue;
    }
    const backupKey = `${row.tenantId}/${sourceKey}`;
    try {

      const stat = await source.statFile(sourceKey);
      if (!stat) {
        outcome.missing++;
        if (!opts.dryRun) {
          // Conserva bytes/checksum/mtime de la última copia buena: describen
          // el respaldo existente, no la fuente ausente.
          const prev = await store.getEntry(row.tenantId, row.sourcePath);
          await store.recordEntry({
            tenantId: row.tenantId,
            sourcePath: row.sourcePath,
            sourceRef: row.sourceRef,
            backupPath: prev?.backupPath ?? backupKey,
            bytes: prev?.bytes ?? 0,
            sourceMtimeMs: prev?.sourceMtimeMs ?? 0,
            checksum: prev?.checksum ?? null,
            status: 'missing',
            lastError: 'la fuente no existe en disco',
            backedUpAt: now,
          });
        }
        continue;
      }

      const prev = await store.getEntry(row.tenantId, row.sourcePath);
      // Test de cambio barato: size+mtime iguales a la última copia → skip.
      if (
        prev?.status === 'backed_up' &&
        prev.bytes === stat.size &&
        prev.sourceMtimeMs === stat.mtimeMs
      ) {
        outcome.skipped++;
        continue;
      }

      if (!opts.dryRun) {
        const data = await source.readFile(sourceKey);
        await backup.writeFile(backupKey, data);
        await store.recordEntry({
          tenantId: row.tenantId,
          sourcePath: row.sourcePath,
          sourceRef: row.sourceRef,
          backupPath: backupKey,
          bytes: stat.size,
          sourceMtimeMs: stat.mtimeMs,
          checksum: checksumOf(data),
          status: 'backed_up',
          lastError: null,
          backedUpAt: now,
        });
      }
      outcome.copied++;
      outcome.bytesCopied += stat.size;
    } catch (err) {
      // Una falla no aborta el job: se registra y se sigue.
      outcome.errors.push({ sourcePath: row.sourcePath, message: errorMessage(err) });
      if (!opts.dryRun) {
        try {
          const prev = await store.getEntry(row.tenantId, row.sourcePath);
          await store.recordEntry({
            tenantId: row.tenantId,
            sourcePath: row.sourcePath,
            sourceRef: row.sourceRef,
            backupPath: prev?.backupPath ?? backupKey,
            bytes: prev?.bytes ?? 0,
            sourceMtimeMs: prev?.sourceMtimeMs ?? 0,
            checksum: prev?.checksum ?? null,
            status: 'error',
            lastError: errorMessage(err),
            backedUpAt: now,
          });
        } catch {
          // Si ni el manifest escribe, el error de arriba ya quedó en
          // outcome.errors — nada más que hacer acá.
        }
      }
    }
  }

  return outcome;
}

/**
 * Estado del backup para `GET /admin/backup/status`: cobertura por tenant
 * (entries/bytes/missing/errors) + última corrida registrada. Cross-tenant
 * de lectura — mismo guard requirePlatformAdmin que el resto del router.
 */
export async function getBackupStatus(
  opts: { tenantId?: string } = {},
  deps: BackupDeps = {},
): Promise<BackupStatus> {
  const store = deps.store ?? createDrizzleBackupStore();
  const tenants = await store.summarize({ tenantId: opts.tenantId });
  const lastRunAt = tenants.reduce<Date | null>(
    (acc, t) =>
      t.lastBackedUpAt && (acc === null || t.lastBackedUpAt > acc)
        ? t.lastBackedUpAt
        : acc,
    null,
  );
  return { tenants, lastRunAt };
}
