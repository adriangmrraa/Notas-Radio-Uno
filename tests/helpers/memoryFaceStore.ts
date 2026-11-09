/**
 * memoryFaceStore — implementación en memoria de `FaceStore` para tests del
 * pipeline de rostros. Sin DB, sin red: los mismos filtros por tenant que la
 * implementación drizzle (un id ajeno al tenant no se encuentra → 404 y no se
 * escribe nada).
 */
import type {
    FacePersonRow,
    FacePhotoRow,
    FaceStore,
} from '../../src/server/services/faceEnrollmentService';

export interface MemoryPerson extends FacePersonRow {
    tenantId: string;
}

export interface MemoryPhoto extends FacePhotoRow {
    tenantId: string;
}

export interface MemoryEmbedding {
    id: string;
    tenantId: string;
    personId: string;
    personPhotoId: string;
    model: string;
    dimensions: number;
    embedding: number[];
    detScore: number | null;
}

export interface MemorySeed {
    persons?: MemoryPerson[];
    photos?: MemoryPhoto[];
    embeddings?: MemoryEmbedding[];
}

export function createMemoryFaceStore(seed: MemorySeed) {
    const persons = new Map<string, MemoryPerson>(
        (seed.persons ?? []).map((p) => [p.id, { ...p }]),
    );
    const photos = new Map<string, MemoryPhoto>(
        (seed.photos ?? []).map((p) => [p.id, { ...p }]),
    );
    const embeddings = new Map<string, MemoryEmbedding>(
        (seed.embeddings ?? []).map((e) => [e.id, { ...e }]),
    );
    let seq = 0;

    const store: FaceStore = {
        async findPerson(tenantId, personId) {
            const p = persons.get(personId);
            return p && p.tenantId === tenantId ? { ...p } : null;
        },

        async findPhoto(tenantId, personId, photoId) {
            const p = photos.get(photoId);
            return p && p.tenantId === tenantId && p.personId === personId ? { ...p } : null;
        },

        async findPrimaryPhoto(tenantId, personId) {
            const all = [...photos.values()].filter(
                (p) => p.tenantId === tenantId && p.personId === personId,
            );
            all.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
            return all.length > 0 ? { ...all[0] } : null;
        },

        async countEmbeddings(tenantId, personId) {
            return [...embeddings.values()].filter(
                (e) => e.tenantId === tenantId && e.personId === personId,
            ).length;
        },

        async deleteEmbeddingsForPhoto(tenantId, photoId) {
            const ids = [...embeddings.values()]
                .filter((e) => e.tenantId === tenantId && e.personPhotoId === photoId)
                .map((e) => e.id);
            for (const id of ids) embeddings.delete(id);
            return ids;
        },

        async insertEmbedding(v) {
            const id = `mem-emb-${++seq}`;
            embeddings.set(id, { id, ...v });
            return { id };
        },

        async setPhotoFace(tenantId, photoId, patch) {
            const p = photos.get(photoId);
            if (p && p.tenantId === tenantId) Object.assign(p, patch);
        },

        async setPersonFace(tenantId, personId, patch) {
            const p = persons.get(personId);
            if (p && p.tenantId === tenantId) Object.assign(p, patch);
        },

        tx(fn) {
            return fn(store);
        },
    };

    return { store, persons, photos, embeddings };
}

export function makePerson(over: Partial<MemoryPerson> & { id: string; tenantId: string }): MemoryPerson {
    return {
        faceStatus: 'pending',
        consentGiven: false,
        consentAt: null,
        embeddingRef: null,
        ...over,
    };
}

export function makePhoto(
    over: Partial<MemoryPhoto> & { id: string; tenantId: string; personId: string },
): MemoryPhoto {
    return {
        photoData: Buffer.from('fake-image-bytes'),
        mimeType: 'image/png',
        isPrimary: false,
        faceDetected: false,
        faceCount: 0,
        ...over,
    };
}
