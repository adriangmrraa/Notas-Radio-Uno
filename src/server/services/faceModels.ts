/**
 * faceModels — descarga perezosa y cache local de los modelos InsightFace
 * `buffalo_l` (SCRFD `det_10g.onnx` + ArcFace `w600k_r50.onnx`) usados por el
 * pipeline de rostros (PC-04).
 *
 * Los binarios (~200 MB) NO se commitean: se descargan en runtime la primera
 * vez que se necesitan, dentro de `.cache/face-models/` (fuera de git, ver
 * .gitignore). La descarga se verifica contra el SHA-256 del zip.
 *
 *   URL     : https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
 *   SHA-256 : 80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f
 *
 * Overrides por entorno: `FACE_MODELS_DIR`, `FACE_MODELS_URL`,
 * `FACE_MODELS_SHA256`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// src/server/services (y dist/server/services) están a 3 niveles del root.
const PROJECT_ROOT = join(MODULE_DIR, '..', '..', '..');

export const FACE_MODELS_URL =
    'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip';
export const FACE_MODELS_SHA256 =
    '80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f';

export const DET_MODEL_FILE = 'det_10g.onnx';
export const REC_MODEL_FILE = 'w600k_r50.onnx';
const REQUIRED_MODELS = [DET_MODEL_FILE, REC_MODEL_FILE] as const;

export function faceModelsDir(): string {
    return process.env.FACE_MODELS_DIR ?? join(PROJECT_ROOT, '.cache', 'face-models');
}

export function faceModelPaths(): { detPath: string; recPath: string } {
    const dir = faceModelsDir();
    return { detPath: join(dir, DET_MODEL_FILE), recPath: join(dir, REC_MODEL_FILE) };
}

/** Los dos .onnx requeridos existen en disco y no están vacíos. */
export function faceModelsPresent(): boolean {
    const { detPath, recPath } = faceModelPaths();
    return [detPath, recPath].every(
        (p) => existsSync(p) && statSync(p).size > 1024,
    );
}

// ---------------------------------------------------------------------------
// Lector mínimo de ZIP (central directory → local headers). Soporta entradas
// STORED (0) y DEFLATE (8), que es lo que produce el release de InsightFace.
// ---------------------------------------------------------------------------
interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function listZipEntries(buf: Buffer): ZipEntry[] {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('ZIP inválido: no se encontró el directorio central (EOCD)');

    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    const entries: ZipEntry[] = [];

    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(offset) !== CENTRAL_SIG) {
            throw new Error('ZIP inválido: firma de entrada central incorrecta');
        }
        const method = buf.readUInt16LE(offset + 10);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const localOffset = buf.readUInt32LE(offset + 42);
        const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
        entries.push({ name, method, compressedSize, localOffset });
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function extractZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
    const o = entry.localOffset;
    if (buf.readUInt32LE(o) !== LOCAL_SIG) {
        throw new Error(`ZIP inválido: header local de '${entry.name}' incorrecto`);
    }
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const start = o + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`ZIP: método de compresión ${entry.method} no soportado`);
}

// ---------------------------------------------------------------------------
// Descarga + verificación + extracción
// ---------------------------------------------------------------------------
async function downloadZip(url: string): Promise<Buffer> {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok && res.status !== 206) {
        throw new Error(`Descarga de modelos falló: HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
        throw new Error('La descarga no es un ZIP válido (magic PK\\x03\\x04 ausente)');
    }
    return bytes;
}

function sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Garantiza que los dos modelos requeridos estén en `faceModelsDir()`.
 * Descarga el zip UNA sola vez (perezoso), verifica SHA-256 y extrae sólo los
 * archivos necesarios. Lanza Error con detalle si algo falla — el caller lo
 * traduce a `FaceDetectorUnavailableError`.
 */
export async function ensureFaceModels(): Promise<{ detPath: string; recPath: string }> {
    const paths = faceModelPaths();
    if (faceModelsPresent()) return paths;

    const dir = faceModelsDir();
    mkdirSync(dir, { recursive: true });

    const url = process.env.FACE_MODELS_URL ?? FACE_MODELS_URL;
    const expectedSha = (process.env.FACE_MODELS_SHA256 ?? FACE_MODELS_SHA256).toLowerCase();

    const zip = await downloadZip(url);
    const actual = sha256(zip);
    if (expectedSha && actual !== expectedSha) {
        throw new Error(
            `SHA-256 del zip de modelos no coincide: esperado ${expectedSha}, obtenido ${actual}`,
        );
    }

    const entries = listZipEntries(zip);
    for (const required of REQUIRED_MODELS) {
        const entry = entries.find(
            (e) => e.name === required || e.name.endsWith(`/${required}`),
        );
        if (!entry) {
            throw new Error(`El zip de modelos no contiene '${required}'`);
        }
        writeFileSync(join(dir, required), extractZipEntry(zip, entry));
    }

    if (!faceModelsPresent()) {
        throw new Error('Los modelos se extrajeron pero no quedaron válidos en disco');
    }
    return faceModelPaths();
}
