/**
 * rawStorageService — storage adapter del crudo de video (PD-01/D-1).
 *
 * Interfaz chica (`RawStorage`) que consume el recorder del slice siguiente
 * para escribir/leer/borrar segmentos. Hoy la única implementación es
 * `FilesystemRawStorage` (raíz en STORAGE_ROOT o `<repo>/data/raw`); el punto
 * de extensión para S3/R2 es implementar esta misma interfaz y seleccionarla
 * en `getRawStorage()` — sin dependencias nuevas.
 *
 * Las `key` son rutas relativas tipo `{tenantId}/{transmissionId}/seg-00001.mp4`.
 * Toda key se valida contra la raíz: `..`, absolutas y cualquier escape por
 * path traversal se rechazan con error descriptivo antes de tocar el disco.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface RawStorage {
  writeFile(key: string, data: Buffer): Promise<void>;
  appendFile?(key: string, data: Buffer): Promise<void>;
  readFile(key: string): Promise<Buffer>;
  statFile(key: string): Promise<{ size: number } | null>;
  deleteFile(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Ruta/URL servible del archivo (en filesystem: la ruta absoluta bajo la raíz). */
  publicPath(key: string): string;
}

function defaultRoot(): string {
  return process.env.STORAGE_ROOT || path.join(PROJECT_ROOT, 'data', 'raw');
}

export class FilesystemRawStorage implements RawStorage {
  readonly root: string;

  constructor(root: string = defaultRoot()) {
    this.root = path.resolve(root);
  }

  /**
   * Resuelve una key a una ruta absoluta garantizadamente bajo `root`.
   * Rechaza keys vacías, con NUL, absolutas, o que escapen de la raíz (`..`),
   * sin importar el separador (`/` o `\`) ni la plataforma.
   */
  private resolveKey(key: string): string {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) {
      throw new Error(`RawStorage: key inválida: ${JSON.stringify(key)}`);
    }
    const resolved = path.resolve(this.root, key);
    const rel = path.relative(this.root, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`RawStorage: la key escapa de la raíz de storage: ${JSON.stringify(key)}`);
    }
    return resolved;
  }

  async writeFile(key: string, data: Buffer): Promise<void> {
    const file = this.resolveKey(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }

  async appendFile(key: string, data: Buffer): Promise<void> {
    const file = this.resolveKey(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, data);
  }

  async readFile(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveKey(key));
  }

  async statFile(key: string): Promise<{ size: number } | null> {
    const stat = await fs.stat(this.resolveKey(key)).catch(() => null);
    return stat && stat.isFile() ? { size: stat.size } : null;
  }

  async deleteFile(key: string): Promise<void> {
    await fs.rm(this.resolveKey(key), { force: true });
  }

  /** Borra recursivamente el directorio/archivo del prefijo; no falla si no existe. */
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

let cached: RawStorage | null = null;

/**
 * Devuelve el RawStorage activo. Hoy siempre filesystem; cuando llegue el
 * driver S3/R2 (misma interfaz, otra implementación) se selecciona acá, p.ej.
 * por STORAGE_DRIVER.
 */
export function getRawStorage(): RawStorage {
  cached ??= new FilesystemRawStorage();
  return cached;
}
