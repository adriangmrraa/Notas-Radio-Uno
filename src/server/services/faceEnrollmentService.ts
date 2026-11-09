/**
 * faceEnrollmentService — lógica de negocio del pipeline de rostros (PC-04):
 * enrolar una foto (detect → embedding 512d → persistir) y desenrolar.
 *
 * La persistencia pasa por la interfaz `FaceStore` (inyectable): la
 * implementación real es `createDrizzleFaceStore` (Postgres + pgvector), y los
 * tests usan un store en memoria — sin red ni DB real. El detector también es
 * inyectable (`FaceDetectorResolver`), por lo que "detector no disponible"
 * (503), "foto sin cara" (400) y "varias caras" (400) son caminos
 * distinguibles y testeables.
 *
 * Reglas (ver PC04-BRIEF.md):
 *   - 0 caras → 400 `NO_FACE_DETECTED` (éste es el AC: rechazo explícito).
 *   - >1 caras → 400 `MULTIPLE_FACES` (foto ambigua para enrolar).
 *   - 1 cara  → inserta face_embeddings (512 dims), marca la foto, setea
 *               persons.embedding_ref / face_status='enrolled' / consent.
 *   - Sin consentimiento → 400 `CONSENT_REQUIRED`.
 *   - Detector no disponible → 503 `FACE_DETECTOR_UNAVAILABLE` (NUNCA un 200
 *     silencioso con face_detected=false).
 *   - Re-enrolar la misma foto reemplaza el embedding existente: nunca quedan
 *     dos embeddings vivos para una person_photo_id.
 *   - Todo filtra por tenant_id: ids ajenos → 404 y no escriben nada.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../db/index.js';
import { faceEmbeddings, personPhotos, persons } from '../db/schema/persons.js';
import {
    isFaceDetectorUnavailableError,
    isInvalidFaceImageError,
    type FaceDetector,
} from './faceDetectionService.js';
import { faceModelsPresent } from './faceModels.js';

export const FACE_EMBEDDING_DIMS = 512;

// ---------------------------------------------------------------------------
// Tipos del store
// ---------------------------------------------------------------------------
export interface FacePersonRow {
    id: string;
    faceStatus: 'pending' | 'enrolled' | 'failed';
    consentGiven: boolean;
    consentAt: Date | null;
    embeddingRef: string | null;
}

export interface FacePhotoRow {
    id: string;
    personId: string;
    photoData: Buffer | Uint8Array;
    mimeType: string;
    isPrimary: boolean;
    faceDetected: boolean;
    faceCount: number;
}

export interface FaceStore {
    findPerson(tenantId: string, personId: string): Promise<FacePersonRow | null>;
    findPhoto(tenantId: string, personId: string, photoId: string): Promise<FacePhotoRow | null>;
    /** Foto primaria; si ninguna está marcada, la más antigua (misma regla que DELETE-photo). */
    findPrimaryPhoto(tenantId: string, personId: string): Promise<FacePhotoRow | null>;
    countEmbeddings(tenantId: string, personId: string): Promise<number>;
    /** Borra los embeddings de la foto y devuelve los ids eliminados. */
    deleteEmbeddingsForPhoto(tenantId: string, photoId: string): Promise<string[]>;
    insertEmbedding(v: {
        tenantId: string;
        personId: string;
        personPhotoId: string;
        model: string;
        dimensions: number;
        embedding: number[];
        detScore: number | null;
    }): Promise<{ id: string }>;
    setPhotoFace(
        tenantId: string,
        photoId: string,
        patch: { faceDetected: boolean; faceCount: number },
    ): Promise<void>;
    setPersonFace(
        tenantId: string,
        personId: string,
        patch: {
            faceStatus?: 'pending' | 'enrolled' | 'failed';
            consentGiven?: boolean;
            consentAt?: Date;
            embeddingRef?: string | null;
        },
    ): Promise<void>;
    /** Ejecuta `fn` en una transacción atómica con un store con scope de tx. */
    tx<T>(fn: (store: FaceStore) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Implementación drizzle (Postgres + pgvector)
// ---------------------------------------------------------------------------
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type FaceDbExecutor = Pick<Database | Tx, 'select' | 'insert' | 'update' | 'delete'>;

const personFaceSelect = {
    id: persons.id,
    faceStatus: persons.faceStatus,
    consentGiven: persons.consentGiven,
    consentAt: persons.consentAt,
    embeddingRef: persons.embeddingRef,
} as const;

export function createDrizzleFaceStore(executor: Database | Tx): FaceStore {
    const db = executor as FaceDbExecutor;
    return {
        async findPerson(tenantId, personId) {
            const [row] = await db
                .select(personFaceSelect)
                .from(persons)
                .where(and(eq(persons.id, personId), eq(persons.tenantId, tenantId)))
                .limit(1);
            return row ?? null;
        },

        async findPhoto(tenantId, personId, photoId) {
            const [row] = await db
                .select()
                .from(personPhotos)
                .where(
                    and(
                        eq(personPhotos.id, photoId),
                        eq(personPhotos.personId, personId),
                        eq(personPhotos.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async findPrimaryPhoto(tenantId, personId) {
            const [row] = await db
                .select()
                .from(personPhotos)
                .where(and(eq(personPhotos.tenantId, tenantId), eq(personPhotos.personId, personId)))
                .orderBy(desc(personPhotos.isPrimary), asc(personPhotos.createdAt))
                .limit(1);
            return row ?? null;
        },

        async countEmbeddings(tenantId, personId) {
            const [{ count }] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(faceEmbeddings)
                .where(and(eq(faceEmbeddings.tenantId, tenantId), eq(faceEmbeddings.personId, personId)));
            return count;
        },

        async deleteEmbeddingsForPhoto(tenantId, photoId) {
            const rows = await db
                .delete(faceEmbeddings)
                .where(
                    and(
                        eq(faceEmbeddings.tenantId, tenantId),
                        eq(faceEmbeddings.personPhotoId, photoId),
                    ),
                )
                .returning({ id: faceEmbeddings.id });
            return rows.map((r) => r.id);
        },

        async insertEmbedding(v) {
            const [row] = await db.insert(faceEmbeddings).values(v).returning({ id: faceEmbeddings.id });
            return row;
        },

        async setPhotoFace(tenantId, photoId, patch) {
            await db
                .update(personPhotos)
                .set(patch)
                .where(and(eq(personPhotos.id, photoId), eq(personPhotos.tenantId, tenantId)));
        },

        async setPersonFace(tenantId, personId, patch) {
            await db
                .update(persons)
                .set(patch)
                .where(and(eq(persons.id, personId), eq(persons.tenantId, tenantId)));
        },

        tx(fn) {
            return (executor as Database).transaction((tx) => fn(createDrizzleFaceStore(tx)));
        },
    };
}

// ---------------------------------------------------------------------------
// Servicio — resultado ya viene con status HTTP + body listo para res.json
// ---------------------------------------------------------------------------
export interface ServiceResult {
    status: number;
    body: Record<string, unknown>;
}

export interface FaceDeps {
    store: FaceStore;
    resolveDetector: () => Promise<FaceDetector>;
}

const ok = (body: Record<string, unknown>): ServiceResult => ({ status: 200, body });
const fail = (status: number, error: string, code: string): ServiceResult => ({
    status,
    body: { error, code },
});

const DOWNLOAD_HINT = 'npx tsx scripts/download-face-models.ts';

async function resolveDetectorOr503(resolve: FaceDeps['resolveDetector']): Promise<FaceDetector | ServiceResult> {
    try {
        return await resolve();
    } catch (e) {
        if (isFaceDetectorUnavailableError(e)) {
            return fail(
                503,
                `El modelo de detección de rostros no está disponible. Ejecutá \`${DOWNLOAD_HINT}\` para descargarlo e intentá de nuevo.`,
                'FACE_DETECTOR_UNAVAILABLE',
            );
        }
        throw e;
    }
}

function isDetector(detector: FaceDetector | ServiceResult): detector is FaceDetector {
    return typeof (detector as FaceDetector).detect === 'function';
}

/**
 * Enrola una foto: detect → 1 cara → embedding persistido + persona enrolled.
 * `photoId` undefined → foto primaria.
 */
export async function enrollFace(
    deps: FaceDeps,
    args: { tenantId: string; personId: string; photoId?: string; consent?: boolean },
): Promise<ServiceResult> {
    const { store } = deps;
    const { tenantId, personId, photoId, consent } = args;

    const person = await store.findPerson(tenantId, personId);
    if (!person) return fail(404, 'Persona no encontrada', 'PERSON_NOT_FOUND');

    const photo = photoId
        ? await store.findPhoto(tenantId, personId, photoId)
        : await store.findPrimaryPhoto(tenantId, personId);
    if (!photo) {
        return fail(
            404,
            photoId ? 'Foto no encontrada' : 'La persona no tiene foto primaria para enrolar',
            'PHOTO_NOT_FOUND',
        );
    }

    if (!person.consentGiven && consent !== true) {
        return fail(
            400,
            'Se requiere el consentimiento explícito de la persona para enrolar su rostro (enviá { consent: true })',
            'CONSENT_REQUIRED',
        );
    }

    const detector = await resolveDetectorOr503(deps.resolveDetector);
    if (!isDetector(detector)) return detector;

    let detected;
    try {
        detected = await detector.detect(Buffer.from(photo.photoData));
    } catch (e) {
        if (isInvalidFaceImageError(e)) {
            return fail(400, 'La foto almacenada no pudo decodificarse como imagen', 'INVALID_IMAGE');
        }
        if (isFaceDetectorUnavailableError(e)) {
            return fail(
                503,
                `El modelo de detección de rostros no está disponible. Ejecutá \`${DOWNLOAD_HINT}\` para descargarlo e intentá de nuevo.`,
                'FACE_DETECTOR_UNAVAILABLE',
            );
        }
        throw e;
    }

    const faceCount = detected.faces.length;

    if (faceCount === 0) {
        await store.tx(async (s) => {
            await s.setPhotoFace(tenantId, photo.id, { faceDetected: false, faceCount: 0 });
            if (person.faceStatus !== 'enrolled') {
                await s.setPersonFace(tenantId, person.id, { faceStatus: 'failed' });
            }
        });
        return fail(
            400,
            'No se detectó ningún rostro en la foto. Usá una foto frontal donde la cara se vea con claridad.',
            'NO_FACE_DETECTED',
        );
    }

    if (faceCount > 1) {
        await store.tx(async (s) => {
            await s.setPhotoFace(tenantId, photo.id, { faceDetected: true, faceCount });
            if (person.faceStatus !== 'enrolled') {
                await s.setPersonFace(tenantId, person.id, { faceStatus: 'failed' });
            }
        });
        return fail(
            400,
            `Se detectaron ${faceCount} rostros en la foto. Para enrolar a una persona la foto debe contener un único rostro.`,
            'MULTIPLE_FACES',
        );
    }

    const face = detected.faces[0];
    if (!Array.isArray(face.embedding) || face.embedding.length !== FACE_EMBEDDING_DIMS) {
        return fail(
            502,
            `El detector devolvió un embedding inválido (se esperaban ${FACE_EMBEDDING_DIMS} dimensiones)`,
            'INVALID_EMBEDDING',
        );
    }

    return store.tx(async (s) => {
        // Un embedding por foto: re-enrolar reemplaza (delete + insert), nunca
        // quedan dos embeddings vivos para la misma person_photo_id.
        await s.deleteEmbeddingsForPhoto(tenantId, photo.id);
        const row = await s.insertEmbedding({
            tenantId,
            personId,
            personPhotoId: photo.id,
            model: detected.model,
            dimensions: face.embedding.length,
            embedding: face.embedding,
            detScore: face.detScore,
        });
        await s.setPhotoFace(tenantId, photo.id, { faceDetected: true, faceCount: 1 });
        await s.setPersonFace(tenantId, person.id, {
            faceStatus: 'enrolled',
            consentGiven: true,
            consentAt: person.consentAt ?? new Date(),
            embeddingRef: row.id,
        });
        return ok({
            success: true,
            personId,
            photoId: photo.id,
            embeddingId: row.id,
            model: detected.model,
            dimensions: FACE_EMBEDDING_DIMS,
            detScore: face.detScore,
            faceDetected: true,
            faceCount: 1,
            faceStatus: 'enrolled',
            consentGiven: true,
        });
    });
}

/** Desenrola: borra el embedding de la foto, limpia embedding_ref y marca pending. */
export async function disenrollFace(
    deps: FaceDeps,
    args: { tenantId: string; personId: string; photoId: string },
): Promise<ServiceResult> {
    const { store } = deps;
    const { tenantId, personId, photoId } = args;

    const person = await store.findPerson(tenantId, personId);
    if (!person) return fail(404, 'Persona no encontrada', 'PERSON_NOT_FOUND');

    const photo = await store.findPhoto(tenantId, personId, photoId);
    if (!photo) return fail(404, 'Foto no encontrada', 'PHOTO_NOT_FOUND');

    return store.tx(async (s) => {
        const deleted = await s.deleteEmbeddingsForPhoto(tenantId, photoId);
        await s.setPhotoFace(tenantId, photoId, { faceDetected: false, faceCount: 0 });

        const remaining = await s.countEmbeddings(tenantId, personId);
        if (person.embeddingRef && deleted.includes(person.embeddingRef)) {
            // El embedding canónico era de esta foto → limpiar.
            await s.setPersonFace(tenantId, personId, { embeddingRef: null, faceStatus: 'pending' });
        } else if (remaining === 0) {
            // No queda ningún embedding de la persona → pending.
            await s.setPersonFace(tenantId, personId, { embeddingRef: null, faceStatus: 'pending' });
        }

        return ok({ success: true, deleted: deleted.length > 0 });
    });
}

/** Estado del enrolment de la persona + disponibilidad del detector. */
export async function getFaceStatus(
    deps: FaceDeps,
    args: { tenantId: string; personId: string },
): Promise<ServiceResult> {
    const { store } = deps;
    const person = await store.findPerson(args.tenantId, args.personId);
    if (!person) return fail(404, 'Persona no encontrada', 'PERSON_NOT_FOUND');

    const embeddings = await store.countEmbeddings(args.tenantId, args.personId);
    return ok({
        personId: person.id,
        faceStatus: person.faceStatus,
        consentGiven: person.consentGiven,
        consentAt: person.consentAt,
        embeddingRef: person.embeddingRef,
        faceCount: embeddings,
        detectorAvailable: faceModelsPresent(),
    });
}
