/**
 * faceDetectionService — pipeline de rostros (PC-04): foto → caras → embeddings.
 *
 * Interfaz inyectable `FaceDetector` con dos implementaciones:
 *   - `OnnxFaceDetector`: SCRFD (det_10g.onnx) para detección + ArcFace
 *     (w600k_r50.onnx) para el embedding de 512 dims, corriendo sobre
 *     `onnxruntime-node` (InsightFace buffalo_l, self-hosted, sin Python).
 *   - `FakeFaceDetector`: implementación determinista para tests (sin modelos,
 *     sin red, sin DB).
 *
 * `getFaceDetector()` resuelve el detector real de forma perezosa: descarga los
 * modelos la primera vez (ver faceModels.ts), cachea las sesiones ONNX en
 * memoria y nunca lanza al importar el módulo. Si los modelos no están
 * disponibles lanza `FaceDetectorUnavailableError` — la capa de API la traduce
 * a 503 (distinto de "foto sin cara", que es un 400).
 */
import { ensureFaceModels } from './faceModels.js';

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------
export interface DetectedFace {
    /** [x1, y1, x2, y2] en coordenadas de la imagen original. */
    bbox: [number, number, number, number];
    detScore: number;
    /** Embedding ArcFace normalizado (512 dimensiones). */
    embedding: number[];
}

export interface FaceDetectionResult {
    faces: DetectedFace[];
    model: string;
}

export interface FaceDetector {
    detect(input: Buffer): Promise<FaceDetectionResult>;
}

export type FaceDetectorResolver = () => Promise<FaceDetector>;

export const FACE_MODEL_ID = 'insightface-buffalo_l';

export class FaceDetectorUnavailableError extends Error {
    readonly code = 'FACE_DETECTOR_UNAVAILABLE' as const;
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'FaceDetectorUnavailableError';
        this.cause = options?.cause;
    }
}

export class InvalidFaceImageError extends Error {
    readonly code = 'INVALID_IMAGE' as const;
    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'InvalidFaceImageError';
        this.cause = options?.cause;
    }
}

export function isFaceDetectorUnavailableError(e: unknown): e is FaceDetectorUnavailableError {
    return (
        e instanceof FaceDetectorUnavailableError ||
        (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'FACE_DETECTOR_UNAVAILABLE')
    );
}

export function isInvalidFaceImageError(e: unknown): e is InvalidFaceImageError {
    return (
        e instanceof InvalidFaceImageError ||
        (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'INVALID_IMAGE')
    );
}

// ---------------------------------------------------------------------------
// Implementación real: SCRFD + ArcFace sobre onnxruntime-node
// ---------------------------------------------------------------------------
const SCRFD_INPUT = 640;
const DET_SCORE_THRESH = 0.5;
const NMS_THRESH = 0.4;
const NUM_ANCHORS = 2;

/** Landmarks destino del template ArcFace para 112x112 (insightface face_align). */
const ARCFACE_DST: ReadonlyArray<readonly [number, number]> = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];
const ARCFACE_SIZE = 112;

interface ScrfdCandidate {
    bbox: [number, number, number, number];
    score: number;
    kps: Float32Array; // 5 landmarks (x,y)*5, coords de imagen original
}

type OrtModule = typeof import('onnxruntime-node');
type OrtSession = import('onnxruntime-node').InferenceSession;
type OrtTensor = import('onnxruntime-node').Tensor;
type SharpFactory = typeof import('sharp');

interface DecodedImage {
    /** RGB crudo interleaved (3 canales), `width`×`height`. */
    rgb: Buffer;
    width: number;
    height: number;
    /** Factor original→canvas 640 (bboxes y kps se dividen por esto). */
    detScale: number;
}

/** Carga perezosa de sharp (CJS export=): resuelve el callable sin romper el import. */
async function loadSharp(): Promise<SharpFactory> {
    let mod: unknown;
    try {
        mod = await import('sharp');
    } catch (e) {
        throw new FaceDetectorUnavailableError('sharp no está disponible para decodificar imágenes', { cause: e });
    }
    const m = mod as { default?: SharpFactory } & SharpFactory;
    return m.default ?? m;
}

async function decodeLetterboxed(input: Buffer): Promise<DecodedImage> {
    const sharp = await loadSharp();

    let meta: import('sharp').Metadata;
    try {
        meta = await sharp(input).metadata();
    } catch (e) {
        throw new InvalidFaceImageError('El archivo no es una imagen válida', { cause: e });
    }
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) {
        throw new InvalidFaceImageError('La imagen no tiene dimensiones válidas');
    }

    // Letterbox idéntico a insightface (det_scale_input): resize preservando el
    // aspecto dentro de 640×640 y canvas negro con la imagen pegada arriba-izq.
    const ratio = height / width;
    let newW: number, newH: number;
    if (ratio > 1) {
        newH = SCRFD_INPUT;
        newW = Math.round(SCRFD_INPUT / ratio);
    } else {
        newW = SCRFD_INPUT;
        newH = Math.round(SCRFD_INPUT * ratio);
    }
    const detScale = newH / height;

    let rgb: Buffer;
    try {
        rgb = await sharp(input)
            .removeAlpha()
            .resize(newW, newH, { fit: 'fill' })
            .extend({
                top: 0,
                left: 0,
                bottom: SCRFD_INPUT - newH,
                right: SCRFD_INPUT - newW,
                background: { r: 0, g: 0, b: 0 },
            })
            .raw()
            .toBuffer();
    } catch (e) {
        throw new InvalidFaceImageError('No se pudo decodificar la imagen', { cause: e });
    }
    return { rgb, width: SCRFD_INPUT, height: SCRFD_INPUT, detScale };
}

async function decodeFullRgb(input: Buffer): Promise<{ rgb: Buffer; width: number; height: number }> {
    const sharp = await loadSharp();
    const meta = await sharp(input).metadata().catch((e: unknown) => {
        throw new InvalidFaceImageError('El archivo no es una imagen válida', { cause: e });
    });
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const rgb = await sharp(input).removeAlpha().raw().toBuffer().catch((e: unknown) => {
        throw new InvalidFaceImageError('No se pudo decodificar la imagen', { cause: e });
    });
    return { rgb, width, height };
}

function toNchwBlob(rgb: Buffer, width: number, height: number, mean: number, scale: number): Float32Array {
    const plane = width * height;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
        out[i] = (rgb[i * 3] - mean) * scale;             // R
        out[plane + i] = (rgb[i * 3 + 1] - mean) * scale; // G
        out[2 * plane + i] = (rgb[i * 3 + 2] - mean) * scale; // B
    }
    return out;
}

/** NMS por IoU (insightface: thresh 0.4). */
function nms(cands: ScrfdCandidate[], thresh: number): ScrfdCandidate[] {
    const order = [...cands].sort((a, b) => b.score - a.score);
    const keep: ScrfdCandidate[] = [];
    const suppressed = new Array<boolean>(order.length).fill(false);
    for (let i = 0; i < order.length; i++) {
        if (suppressed[i]) continue;
        const a = order[i];
        keep.push(a);
        const [ax1, ay1, ax2, ay2] = a.bbox;
        const aArea = (ax2 - ax1) * (ay2 - ay1);
        for (let j = i + 1; j < order.length; j++) {
            if (suppressed[j]) continue;
            const [bx1, by1, bx2, by2] = order[j].bbox;
            const iw = Math.min(ax2, bx2) - Math.max(ax1, bx1);
            const ih = Math.min(ay2, by2) - Math.max(ay1, by1);
            if (iw <= 0 || ih <= 0) continue;
            const inter = iw * ih;
            const bArea = (bx2 - bx1) * (by2 - by1);
            const iou = inter / (aArea + bArea - inter);
            if (iou > thresh) suppressed[j] = true;
        }
    }
    return keep;
}

/**
 * Decodifica las salidas de SCRFD agrupándolas por forma: `[N,1]` scores,
 * `[N,4]` distancias a bbox, `[N,10]` distancias a 5 landmarks. N determina el
 * stride: N = (640/stride)² × 2 anchors.
 */
function decodeScrfdOutputs(
    outputNames: readonly string[],
    tensors: Record<string, OrtTensor>,
): ScrfdCandidate[] {
    const byShape = (w: number) =>
        outputNames
            .map((name) => ({ name, t: tensors[name] }))
            .filter(({ t }) => t.dims.length === 2 && t.dims[1] === w);

    const cands: ScrfdCandidate[] = [];
    for (const { t: scores } of byShape(1)) {
        const n = scores.dims[0];
        const fmc = Math.round(Math.sqrt(n / NUM_ANCHORS));
        const stride = Math.round(SCRFD_INPUT / fmc);
        const bbox = byShape(4).find(({ t }) => t.dims[0] === n)?.t;
        const kps = byShape(10).find(({ t }) => t.dims[0] === n)?.t;
        if (!bbox || !kps) continue;

        const sData = scores.data as Float32Array;
        const bData = bbox.data as Float32Array;
        const kData = kps.data as Float32Array;

        for (let i = 0; i < n; i++) {
            const score = sData[i];
            if (score < DET_SCORE_THRESH) continue;
            // SCRFD: cada celda produce NUM_ANCHORS anchors con centro en la
            // esquina (x = col*stride, y = row*stride).
            const cell = Math.floor(i / NUM_ANCHORS);
            const ax = (cell % fmc) * stride;
            const ay = Math.floor(cell / fmc) * stride;

            const x1 = ax - bData[i * 4] * stride;
            const y1 = ay - bData[i * 4 + 1] * stride;
            const x2 = ax + bData[i * 4 + 2] * stride;
            const y2 = ay + bData[i * 4 + 3] * stride;

            const kps = new Float32Array(10);
            for (let k = 0; k < 5; k++) {
                kps[k * 2] = ax + kData[i * 10 + k * 2] * stride;
                kps[k * 2 + 1] = ay + kData[i * 10 + k * 2 + 1] * stride;
            }
            cands.push({ bbox: [x1, y1, x2, y2], score, kps });
        }
    }
    return cands;
}

/**
 * SimilarityTransform por mínimos cuadrados (equivalente a
 * `skimage.transform.SimilarityTransform.estimate`): dst = s·R·src + t.
 * Devuelve la matriz afín 2×3 que mapea src → dst, o null si degenera.
 */
function estimateSimilarity(
    src: ArrayLike<number>, // 10 valores (x,y)*5
    dst: ReadonlyArray<readonly [number, number]>,
): [number, number, number, number, number, number] | null {
    // Ecuaciones: dstX = a·x − b·y + tx ; dstY = b·x + a·y + ty
    // A (10×4) × p(4) = b(10), resuelto por ecuaciones normales AᵀA p = Aᵀb.
    const ata = new Array<number>(16).fill(0);
    const atb = new Array<number>(4).fill(0);
    for (let i = 0; i < 5; i++) {
        const x = src[i * 2];
        const y = src[i * 2 + 1];
        const dx = dst[i][0];
        const dy = dst[i][1];
        const r1 = [x, -y, 1, 0];
        const r2 = [y, x, 0, 1];
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                ata[r * 4 + c] += r1[r] * r1[c] + r2[r] * r2[c];
            }
            atb[r] += r1[r] * dx + r2[r] * dy;
        }
    }
    // Eliminación gaussiana 4×4 con pivoteo parcial.
    const m = ata;
    const b = atb;
    for (let col = 0; col < 4; col++) {
        let piv = col;
        for (let r = col + 1; r < 4; r++) {
            if (Math.abs(m[r * 4 + col]) > Math.abs(m[piv * 4 + col])) piv = r;
        }
        if (Math.abs(m[piv * 4 + col]) < 1e-12) return null;
        if (piv !== col) {
            for (let c = col; c < 4; c++) {
                [m[col * 4 + c], m[piv * 4 + c]] = [m[piv * 4 + c], m[col * 4 + c]];
            }
            [b[col], b[piv]] = [b[piv], b[col]];
        }
        for (let r = col + 1; r < 4; r++) {
            const f = m[r * 4 + col] / m[col * 4 + col];
            for (let c = col; c < 4; c++) m[r * 4 + c] -= f * m[col * 4 + c];
            b[r] -= f * b[col];
        }
    }
    const p = new Array<number>(4);
    for (let r = 3; r >= 0; r--) {
        let s = b[r];
        for (let c = r + 1; c < 4; c++) s -= m[r * 4 + c] * p[c];
        p[r] = s / m[r * 4 + r];
    }
    const [a, bb, tx, ty] = p;
    // dst = [[a, -b, tx], [b, a, ty]]
    return [a, -bb, tx, bb, a, ty];
}

/** Invierte una afín 2×3 (devuelve mapeo dst → src). */
function invertAffine(m: [number, number, number, number, number, number]): [number, number, number, number, number, number] | null {
    const [m00, m01, m02, m10, m11, m12] = m;
    const det = m00 * m11 - m01 * m10;
    if (Math.abs(det) < 1e-12) return null;
    const i00 = m11 / det;
    const i01 = -m01 / det;
    const i10 = -m10 / det;
    const i11 = m00 / det;
    return [i00, i01, -(i00 * m02 + i01 * m12), i10, i11, -(i10 * m02 + i11 * m12)];
}

/** Warp bilineal de `src` (RGB) a la grilla 112×112 usando la afín inversa. */
function warpAffineRgb(
    src: Buffer,
    srcW: number,
    srcH: number,
    inv: [number, number, number, number, number, number],
    outSize: number,
): Float32Array {
    const out = new Float32Array(3 * outSize * outSize);
    const plane = outSize * outSize;
    for (let v = 0; v < outSize; v++) {
        for (let u = 0; u < outSize; u++) {
            const x = inv[0] * u + inv[1] * v + inv[2];
            const y = inv[3] * u + inv[4] * v + inv[5];
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const dx = x - x0;
            const dy = y - y0;
            const xa = Math.max(0, Math.min(srcW - 1, x0));
            const ya = Math.max(0, Math.min(srcH - 1, y0));
            const xb = Math.max(0, Math.min(srcW - 1, x0 + 1));
            const yb = Math.max(0, Math.min(srcH - 1, y0 + 1));
            const i00 = (ya * srcW + xa) * 3;
            const i01 = (ya * srcW + xb) * 3;
            const i10 = (yb * srcW + xa) * 3;
            const i11 = (yb * srcW + xb) * 3;
            const w00 = (1 - dx) * (1 - dy);
            const w01 = dx * (1 - dy);
            const w10 = (1 - dx) * dy;
            const w11 = dx * dy;
            const idx = v * outSize + u;
            out[idx] = src[i00] * w00 + src[i01] * w01 + src[i10] * w10 + src[i11] * w11;
            out[plane + idx] = src[i00 + 1] * w00 + src[i01 + 1] * w01 + src[i10 + 1] * w10 + src[i11 + 1] * w11;
            out[2 * plane + idx] = src[i00 + 2] * w00 + src[i01 + 2] * w01 + src[i10 + 2] * w10 + src[i11 + 2] * w11;
        }
    }
    return out;
}

function l2Normalize(v: Float32Array): number[] {
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    return Array.from(v, (x) => x / norm);
}

class OnnxFaceDetector implements FaceDetector {
    private constructor(
        private readonly ort: OrtModule,
        private readonly detSession: OrtSession,
        private readonly recSession: OrtSession,
    ) {}

    static async create(): Promise<OnnxFaceDetector> {
        let ort: OrtModule;
        try {
            ort = await import('onnxruntime-node');
        } catch (e) {
            throw new FaceDetectorUnavailableError(
                'onnxruntime-node no está disponible en esta máquina',
                { cause: e },
            );
        }

        let paths: { detPath: string; recPath: string };
        try {
            paths = await ensureFaceModels();
        } catch (e) {
            throw new FaceDetectorUnavailableError(
                'Los modelos de detección de rostros no están disponibles. Ejecutá `npx tsx scripts/download-face-models.ts` para descargarlos.',
                { cause: e },
            );
        }

        try {
            const [detSession, recSession] = await Promise.all([
                ort.InferenceSession.create(paths.detPath, { executionProviders: ['cpu'] }),
                ort.InferenceSession.create(paths.recPath, { executionProviders: ['cpu'] }),
            ]);
            return new OnnxFaceDetector(ort, detSession, recSession);
        } catch (e) {
            throw new FaceDetectorUnavailableError(
                'No se pudieron inicializar las sesiones ONNX de rostros',
                { cause: e },
            );
        }
    }

    async detect(input: Buffer): Promise<FaceDetectionResult> {
        const letterboxed = await decodeLetterboxed(input);
        const blob = toNchwBlob(letterboxed.rgb, letterboxed.width, letterboxed.height, 127.5, 1 / 128);
        const detInput = new this.ort.Tensor('float32', blob, [1, 3, SCRFD_INPUT, SCRFD_INPUT]);

        const outputs = await this.detSession.run({ [this.detSession.inputNames[0]]: detInput });
        let cands = decodeScrfdOutputs(this.detSession.outputNames, outputs);
        cands = nms(cands, NMS_THRESH);

        // Volver a coordenadas de la imagen original (insightface: bboxes y kps
        // se dividen por det_scale).
        for (const c of cands) {
            c.bbox = [
                c.bbox[0] / letterboxed.detScale,
                c.bbox[1] / letterboxed.detScale,
                c.bbox[2] / letterboxed.detScale,
                c.bbox[3] / letterboxed.detScale,
            ];
            for (let i = 0; i < 10; i++) c.kps[i] /= letterboxed.detScale;
        }

        if (cands.length === 0) return { faces: [], model: FACE_MODEL_ID };

        const full = await decodeFullRgb(input);
        const faces: DetectedFace[] = [];
        for (const c of cands) {
            const embedding = await this.embed(full.rgb, full.width, full.height, c);
            faces.push({ bbox: c.bbox, detScore: c.score, embedding });
        }
        return { faces, model: FACE_MODEL_ID };
    }

    /** Alinea la cara al template ArcFace 112×112 y corre w600k_r50. */
    private async embed(
        rgb: Buffer,
        width: number,
        height: number,
        face: ScrfdCandidate,
    ): Promise<number[]> {
        let pixels: Float32Array;
        const M = estimateSimilarity(face.kps, ARCFACE_DST);
        const inv = M ? invertAffine(M) : null;
        if (inv) {
            pixels = warpAffineRgb(rgb, width, height, inv, ARCFACE_SIZE);
        } else {
            // Fallback: crop cuadrado alrededor del bbox, resize a 112.
            const sharp = await loadSharp();
            const cx = (face.bbox[0] + face.bbox[2]) / 2;
            const cy = (face.bbox[1] + face.bbox[3]) / 2;
            const side = Math.max(face.bbox[2] - face.bbox[0], face.bbox[3] - face.bbox[1]);
            const left = Math.max(0, Math.round(cx - side / 2));
            const top = Math.max(0, Math.round(cy - side / 2));
            const w = Math.min(Math.round(side), width - left);
            const h = Math.min(Math.round(side), height - top);
            const crop = await sharp(rgb, { raw: { width, height, channels: 3 } })
                .extract({ left, top, width: Math.max(1, w), height: Math.max(1, h) })
                .resize(ARCFACE_SIZE, ARCFACE_SIZE, { fit: 'fill' })
                .raw()
                .toBuffer();
            const plane = ARCFACE_SIZE * ARCFACE_SIZE;
            pixels = new Float32Array(3 * plane);
            for (let i = 0; i < plane; i++) {
                pixels[i] = crop[i * 3];
                pixels[plane + i] = crop[i * 3 + 1];
                pixels[2 * plane + i] = crop[i * 3 + 2];
            }
        }

        // ArcFace: (x − 127.5) / 127.5, RGB, NCHW.
        for (let i = 0; i < pixels.length; i++) pixels[i] = (pixels[i] - 127.5) / 127.5;
        const recInput = new this.ort.Tensor('float32', pixels, [1, 3, ARCFACE_SIZE, ARCFACE_SIZE]);
        const out = await this.recSession.run({ [this.recSession.inputNames[0]]: recInput });
        const vec = out[this.recSession.outputNames[0]].data as Float32Array;
        return l2Normalize(vec);
    }
}

// ---------------------------------------------------------------------------
// Implementación fake para tests — determinista, sin modelos ni red.
// ---------------------------------------------------------------------------
export class FakeFaceDetector implements FaceDetector {
    constructor(private readonly faces: DetectedFace[]) {}

    static withFaces(count: number, seed = 7): FakeFaceDetector {
        const faces: DetectedFace[] = Array.from({ length: count }, (_, i) => {
            const embedding = Array.from({ length: 512 }, (__, k) => {
                const v = Math.sin(seed * 31 + i * 17 + k);
                return v;
            });
            const norm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0)) || 1;
            return {
                bbox: [10 + i * 120, 20, 90 + i * 120, 110] as [number, number, number, number],
                detScore: Math.round((0.95 - i * 0.05) * 1000) / 1000,
                embedding: embedding.map((x) => x / norm),
            };
        });
        return new FakeFaceDetector(faces);
    }

    async detect(_input: Buffer): Promise<FaceDetectionResult> {
        return { faces: this.faces.map((f) => ({ ...f, embedding: [...f.embedding] })), model: 'fake-face-detector' };
    }
}

// ---------------------------------------------------------------------------
// Resolver perezoso — una sola instancia, nunca lanza al importar el módulo.
// ---------------------------------------------------------------------------
let cachedDetector: Promise<FaceDetector> | null = null;

export function getFaceDetector(): Promise<FaceDetector> {
    if (!cachedDetector) {
        cachedDetector = OnnxFaceDetector.create().catch((e) => {
            cachedDetector = null; // permitir reintento si falla
            throw isFaceDetectorUnavailableError(e)
                ? e
                : new FaceDetectorUnavailableError('El detector de rostros no está disponible', { cause: e });
        });
    }
    return cachedDetector;
}
