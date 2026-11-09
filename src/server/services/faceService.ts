import { db } from '../db/index.js';
import { faceEmbeddings, personPhotos, persons } from '../db/schema/index.js';
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import { cosineSimilarity } from '../lib/cosine.js';
import { setEnrollmentProcessor, refreshEnrollmentStatus } from './personService.js';
import { resolveFeature } from './featureFlagService.js';
import { audit } from './auditService.js';

// ---------------------------------------------------------------------------
// faceService — cliente HTTP del container InsightFace (T-24, D4)
//
//   POST {FACE_SERVICE_URL}/enroll {image:b64} → {faceCount, embedding?}
//   POST {FACE_SERVICE_URL}/detect {image:b64} → {faces:[{bbox,embedding}]}
//   GET  {FACE_SERVICE_URL}/health             → {status, loaded}
//
// Responsabilidades:
//   - enroll: pipeline async al subir person_photos (hook de personService):
//     detect→exactamente 1 cara→insert face_embeddings; estados
//     pending/enrolled/no_face/multi_face/error; persons.enrollment_status
//     derivado vía refreshEnrollmentStatus.
//   - match: cosine en app contra embeddings del tenant (GATE-1 fallback,
//     SIN pgvector) — ENROLLED-ONLY + CONSENT: solo se matchea contra
//     persons consentidas (consent_at NOT NULL) y activas del tenant (D4).
//   - degradación: health-check cacheado; si el servicio cae, el pipeline
//     sigue (speakers genéricos) — nunca rompe el request ni el worker.
// ---------------------------------------------------------------------------

const FACE_SERVICE_URL = (process.env.FACE_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');
const FACE_TIMEOUT_MS = Number(process.env.FACE_TIMEOUT_MS ?? 10_000);
const FACE_DETECT_TIMEOUT_MS = Number(process.env.FACE_DETECT_TIMEOUT_MS ?? 20_000);
const FACE_RETRIES = Number(process.env.FACE_RETRIES ?? 1);
const HEALTH_CACHE_MS = 30_000;

/** Umbral cosine default para matchear un embedding contra enrolled (~0.5). */
export const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.5);

export interface DetectedFace {
    bbox: [number, number, number, number]; // [x,y,w,h] px del frame enviado
    embedding: number[];
    detScore?: number | null;
}

interface EnrollResponse {
    faceCount: number;
    embedding?: number[];
}

interface DetectResponse {
    faces: DetectedFace[];
}

class FaceServiceError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = 'FaceServiceError';
    }
}

// ---------------------------------------------------------------------------
// HTTP core — timeout + retry corto (1 retry en errores de red / 5xx)
// ---------------------------------------------------------------------------
async function postJson<T>(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= FACE_RETRIES; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${FACE_SERVICE_URL}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                const err = new FaceServiceError(`face ${path} → HTTP ${res.status}: ${detail.slice(0, 200)}`, res.status);
                // 4xx = input inválido → no reintentar
                if (res.status >= 400 && res.status < 500) throw err;
                lastErr = err;
                continue;
            }
            return (await res.json()) as T;
        } catch (err) {
            if (err instanceof FaceServiceError && err.status !== undefined && err.status < 500) throw err;
            lastErr = err;
        } finally {
            clearTimeout(timer);
        }
        if (attempt < FACE_RETRIES) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
    }
    throw lastErr instanceof Error ? lastErr : new FaceServiceError(String(lastErr));
}

// ---------------------------------------------------------------------------
// Health — cacheado para no pegarle al servicio por cada frame/photo
// ---------------------------------------------------------------------------
let healthCache: { ok: boolean; checkedAt: number } = { ok: false, checkedAt: 0 };

export async function checkFaceHealth(force = false): Promise<boolean> {
    if (!force && Date.now() - healthCache.checkedAt < HEALTH_CACHE_MS) return healthCache.ok;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4_000);
        const res = await fetch(`${FACE_SERVICE_URL}/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        healthCache = { ok: res.ok, checkedAt: Date.now() };
    } catch {
        healthCache = { ok: false, checkedAt: Date.now() };
    }
    return healthCache.ok;
}

/** Degradación: ¿el servicio responde? (no tira — consulta el cache). */
export async function isFaceAvailable(): Promise<boolean> {
    return checkFaceHealth();
}

// ---------------------------------------------------------------------------
// API pública del cliente
// ---------------------------------------------------------------------------

/** Enrolamiento: foto → {faceCount, embedding?}. Lanza FaceServiceError. */
export async function enrollImage(image: Buffer): Promise<EnrollResponse> {
    return postJson<EnrollResponse>('/enroll', { image: image.toString('base64') }, FACE_TIMEOUT_MS);
}

/** Detección: frame → caras con bbox+embedding. Lanza FaceServiceError. */
export async function detectFaces(image: Buffer): Promise<DetectedFace[]> {
    const res = await postJson<DetectResponse>('/detect', { image: image.toString('base64') }, FACE_DETECT_TIMEOUT_MS);
    return res.faces ?? [];
}

// ---------------------------------------------------------------------------
// Matching — enrolled-only + consent gate (D4; cosine en app por GATE-1)
// ---------------------------------------------------------------------------
export interface FaceMatch {
    personId: string;
    personName: string;
    similarity: number;
}

interface TenantEmbedding {
    personId: string;
    personName: string;
    embedding: number[];
}

let tenantEmbCache = new Map<string, { rows: TenantEmbedding[]; at: number }>();
const EMB_CACHE_MS = 60_000;

export function invalidateTenantEmbeddings(tenantId?: string): void {
    if (tenantId) tenantEmbCache.delete(tenantId);
    else tenantEmbCache.clear();
}

async function loadTenantEmbeddings(tenantId: string): Promise<TenantEmbedding[]> {
    const cached = tenantEmbCache.get(tenantId);
    if (cached && Date.now() - cached.at < EMB_CACHE_MS) return cached.rows;

    // Enrolled-only + consentimiento: join persons con consent_at NOT NULL e
    // is_active — jamás se matchea cross-tenant ni sin consentimiento (D4).
    const rows = await db.select({
        personId: faceEmbeddings.personId,
        personName: persons.name,
        embedding: faceEmbeddings.embedding,
    })
        .from(faceEmbeddings)
        .innerJoin(persons, eq(faceEmbeddings.personId, persons.id))
        .where(and(
            eq(faceEmbeddings.tenantId, tenantId),
            eq(persons.isActive, true),
            isNotNull(persons.consentAt),
        ));

    const out = rows.map((r) => ({
        personId: r.personId,
        personName: r.personName,
        embedding: r.embedding as number[],
    }));
    tenantEmbCache.set(tenantId, { rows: out, at: Date.now() });
    return out;
}

/**
 * Matchea un embedding detectado contra los enrolados DEL TENANT.
 * Devuelve null cuando nadie supera el umbral (rostro desconocido).
 */
export async function matchFace(
    tenantId: string,
    embedding: number[],
    threshold: number = FACE_MATCH_THRESHOLD,
): Promise<FaceMatch | null> {
    const candidates = await loadTenantEmbeddings(tenantId);
    let best: FaceMatch | null = null;
    for (const c of candidates) {
        const sim = cosineSimilarity(embedding, c.embedding);
        if (sim >= threshold && (best === null || sim > best.similarity)) {
            best = { personId: c.personId, personName: c.personName, similarity: sim };
        }
    }
    return best;
}

/** Embeddings enrolados de un tenant (para debug/panel). */
export async function countTenantEmbeddings(tenantId: string): Promise<number> {
    return (await loadTenantEmbeddings(tenantId)).length;
}

// ---------------------------------------------------------------------------
// Enrollment pipeline — procesador del hook de personService.addPhoto
// Estados: pending → enrolled | no_face | multi_face | error
// ---------------------------------------------------------------------------
async function setPhotoStatus(
    photoId: string,
    status: 'enrolled' | 'no_face' | 'multi_face' | 'error',
    rejectionReason: string | null,
): Promise<void> {
    await db.update(personPhotos)
        .set({ enrollmentStatus: status, rejectionReason })
        .where(eq(personPhotos.id, photoId));
}

export async function processPhotoEnrollment(input: {
    tenantId: string;
    personId: string;
    photoIds: string[];
}): Promise<void> {
    const { tenantId, personId, photoIds } = input;
    if (photoIds.length === 0) return;

    // Flag face_attribution: si la superficie está off, no enviamos datos
    // biométricos al servicio — las fotos quedan 'pending' (degradación).
    const flag = await resolveFeature(tenantId, 'face_attribution').catch(() => false);
    if (flag !== true) {
        console.log(`[Face] enrollment skip person=${personId} — flag face_attribution off`);
        return;
    }

    const photos = await db.select({ id: personPhotos.id, photoData: personPhotos.photoData })
        .from(personPhotos)
        .where(and(eq(personPhotos.personId, personId), inArray(personPhotos.id, photoIds)));

    const available = await checkFaceHealth();
    if (!available) {
        // Degradación: el upload ya respondió — marcamos 'error' para retry
        // manual posterior; no rompemos nada.
        for (const p of photos) {
            await setPhotoStatus(p.id, 'error', 'face service no disponible').catch(() => undefined);
        }
        await refreshEnrollmentStatus(personId).catch(() => undefined);
        console.warn(`[Face] servicio caído — ${photos.length} foto(s) de person=${personId} quedan en error`);
        return;
    }

    for (const photo of photos) {
        try {
            const res = await enrollImage(Buffer.from(photo.photoData));
            if (res.faceCount === 0) {
                await setPhotoStatus(photo.id, 'no_face', 'no se detectó un rostro');
            } else if (res.faceCount > 1) {
                await setPhotoStatus(photo.id, 'multi_face', `se detectaron ${res.faceCount} rostros — subir una foto más clara`);
            } else if (!res.embedding || res.embedding.length !== 512) {
                await setPhotoStatus(photo.id, 'error', 'el servicio no devolvió embedding válido');
            } else {
                await db.insert(faceEmbeddings).values({
                    tenantId,
                    personId,
                    photoId: photo.id,
                    embedding: res.embedding,
                    model: 'buffalo_l',
                });
                await setPhotoStatus(photo.id, 'enrolled', null);
                invalidateTenantEmbeddings(tenantId);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await setPhotoStatus(photo.id, 'error', msg.slice(0, 500)).catch(() => undefined);
            console.warn(`[Face] enroll photo=${photo.id} error: ${msg}`);
        }
    }

    await refreshEnrollmentStatus(personId).catch(() => undefined);
    void audit({
        tenantId,
        action: 'person.enrollment_processed',
        metadata: { personId, photos: photoIds.length },
    });
}

// ---------------------------------------------------------------------------
// initFaceService — registra el procesador de enrolamiento en personService.
// Idempotente; lo llama el api (upload de fotos) y el engine (combined).
// ---------------------------------------------------------------------------
let initialized = false;

export function initFaceService(): void {
    if (initialized) return;
    initialized = true;
    setEnrollmentProcessor((input) => processPhotoEnrollment(input));
    console.log(`[Face] enrollment processor registrado (FACE_SERVICE_URL=${FACE_SERVICE_URL})`);
}
