/**
 * Tests del slice PC-04 (pipeline de rostros): enroll / disenroll / status.
 *
 * Corren contra la implementación FAKE del detector (sin modelos, sin red) y un
 * FaceStore en memoria (sin DB real). El AC central es la distinción honesta:
 * "foto sin cara" → 400 explícito, "detector no disponible" → 503, nunca un
 * 200 silencioso con face_detected=false.
 */
import { describe, expect, it } from 'vitest';

import {
    enrollFace,
    disenrollFace,
    getFaceStatus,
    FACE_EMBEDDING_DIMS,
    type FaceStore,
} from '../src/server/services/faceEnrollmentService';
import {
    FaceDetectorUnavailableError,
    FakeFaceDetector,
} from '../src/server/services/faceDetectionService';
import { faceModelsPresent } from '../src/server/services/faceModels';
import {
    createMemoryFaceStore,
    makePerson,
    makePhoto,
} from './helpers/memoryFaceStore';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const PERSON_ID = '00000000-0000-4000-8000-0000000000aa';
const PHOTO_ID = '00000000-0000-4000-8000-0000000000f1';

function seed(opts: { consent?: boolean } = {}) {
    return createMemoryFaceStore({
        persons: [
            makePerson({ id: PERSON_ID, tenantId: TENANT_A, consentGiven: opts.consent ?? false }),
            // Una persona y una foto del OTRO tenant para pruebas de aislamiento.
            makePerson({ id: 'person-b', tenantId: TENANT_B }),
        ],
        photos: [
            makePhoto({ id: PHOTO_ID, tenantId: TENANT_A, personId: PERSON_ID, isPrimary: true }),
            makePhoto({ id: 'photo-b', tenantId: TENANT_B, personId: 'person-b', isPrimary: true }),
        ],
    });
}

function deps(store: FaceStore, detector: FakeFaceDetector | 'unavailable') {
    return {
        store,
        resolveDetector: async () => {
            if (detector === 'unavailable') {
                throw new FaceDetectorUnavailableError('modelos no descargados');
            }
            return detector;
        },
    };
}

describe('enrollFace — foto sin cara (AC)', () => {
    it('devuelve 400 con mensaje explícito y marca la foto sin cara', async () => {
        const { store, photos, persons } = seed({ consent: true });
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(0)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            photoId: PHOTO_ID,
        });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NO_FACE_DETECTED');
        expect(String(res.body.error)).toMatch(/ning[uú]n rostro/i);
        expect(photos.get(PHOTO_ID)!.faceDetected).toBe(false);
        expect(photos.get(PHOTO_ID)!.faceCount).toBe(0);
        expect(persons.get(PERSON_ID)!.faceStatus).toBe('failed');
    });
});

describe('enrollFace — foto con varias caras', () => {
    it('devuelve 400 con mensaje claro y registra face_count real', async () => {
        const { store, photos } = seed({ consent: true });
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(2)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            photoId: PHOTO_ID,
        });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MULTIPLE_FACES');
        expect(String(res.body.error)).toMatch(/2 rostros/);
        expect(photos.get(PHOTO_ID)!.faceDetected).toBe(true);
        expect(photos.get(PHOTO_ID)!.faceCount).toBe(2);
    });
});

describe('enrollFace — foto con 1 cara', () => {
    it('persiste embedding 512d + photo face_detected + persona enrolled/consent', async () => {
        const { store, photos, persons, embeddings } = seed();
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(1)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            photoId: PHOTO_ID,
            consent: true,
        });

        expect(res.status).toBe(200);
        expect(res.body.dimensions).toBe(FACE_EMBEDDING_DIMS);
        expect(res.body.model).toBe('fake-face-detector');

        expect(embeddings.size).toBe(1);
        const emb = [...embeddings.values()][0];
        expect(emb.personId).toBe(PERSON_ID);
        expect(emb.personPhotoId).toBe(PHOTO_ID);
        expect(emb.tenantId).toBe(TENANT_A);
        expect(emb.dimensions).toBe(512);
        expect(emb.embedding).toHaveLength(512);
        expect(emb.detScore).toBeGreaterThan(0);

        expect(photos.get(PHOTO_ID)!.faceDetected).toBe(true);
        expect(photos.get(PHOTO_ID)!.faceCount).toBe(1);

        const person = persons.get(PERSON_ID)!;
        expect(person.faceStatus).toBe('enrolled');
        expect(person.consentGiven).toBe(true);
        expect(person.consentAt).toBeInstanceOf(Date);
        expect(person.embeddingRef).toBe(emb.id);
    });
});

describe('enrollFace — consentimiento', () => {
    it('sin consentimiento → 400 CONSENT_REQUIRED, no escribe nada', async () => {
        const { store, embeddings } = seed({ consent: false });
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(1)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            photoId: PHOTO_ID,
        });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CONSENT_REQUIRED');
        expect(String(res.body.error)).toMatch(/consentimiento/i);
        expect(embeddings.size).toBe(0);
    });

    it('persona ya consentida no necesita consent en el body', async () => {
        const { store } = seed({ consent: true });
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(1)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            photoId: PHOTO_ID,
        });
        expect(res.status).toBe(200);
    });
});

describe('enrollFace — detector no disponible', () => {
    it('devuelve 503 (NUNCA 200 con face_detected=false) y no escribe nada', async () => {
        const { store, photos, embeddings, persons } = seed({ consent: true });
        const res = await enrollFace(deps(store, 'unavailable'), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            photoId: PHOTO_ID,
        });

        expect(res.status).toBe(503);
        expect(res.body.code).toBe('FACE_DETECTOR_UNAVAILABLE');
        expect(String(res.body.error)).toMatch(/download-face-models/);
        expect(photos.get(PHOTO_ID)!.faceDetected).toBe(false);
        expect(embeddings.size).toBe(0);
        expect(persons.get(PERSON_ID)!.faceStatus).toBe('pending');
    });
});

describe('enrollFace — re-enrolar la misma foto', () => {
    it('nunca deja dos embeddings vivos para la misma person_photo_id', async () => {
        const { store, embeddings, persons } = seed();
        const d = deps(store, FakeFaceDetector.withFaces(1));
        const base = { tenantId: TENANT_A, personId: PERSON_ID, photoId: PHOTO_ID, consent: true };

        const r1 = await enrollFace(d, base);
        expect(r1.status).toBe(200);
        const r2 = await enrollFace(d, base);
        expect(r2.status).toBe(200);

        const alive = [...embeddings.values()].filter((e) => e.personPhotoId === PHOTO_ID);
        expect(alive).toHaveLength(1);
        // embedding_ref apunta al embedding vigente.
        expect(persons.get(PERSON_ID)!.embeddingRef).toBe(alive[0].id);
    });
});

describe('disenrollFace', () => {
    it('borra el embedding, limpia embedding_ref y vuelve a pending', async () => {
        const { store, embeddings, persons, photos } = seed();
        const d = deps(store, FakeFaceDetector.withFaces(1));
        await enrollFace(d, { tenantId: TENANT_A, personId: PERSON_ID, photoId: PHOTO_ID, consent: true });
        expect(embeddings.size).toBe(1);

        const res = await disenrollFace(d, { tenantId: TENANT_A, personId: PERSON_ID, photoId: PHOTO_ID });

        expect(res.status).toBe(200);
        expect(embeddings.size).toBe(0);
        const person = persons.get(PERSON_ID)!;
        expect(person.embeddingRef).toBeNull();
        expect(person.faceStatus).toBe('pending');
        expect(photos.get(PHOTO_ID)!.faceDetected).toBe(false);
        expect(photos.get(PHOTO_ID)!.faceCount).toBe(0);
    });
});

describe('aislamiento multi-tenant', () => {
    it('personId de otro tenant → 404 y no escribe nada', async () => {
        const { store, embeddings, persons } = seed();
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(1)), {
            tenantId: TENANT_A,
            personId: 'person-b', // existe, pero es de TENANT_B
            photoId: 'photo-b',
            consent: true,
        });

        expect(res.status).toBe(404);
        expect(embeddings.size).toBe(0);
        expect(persons.get('person-b')!.faceStatus).toBe('pending');
    });

    it('photoId de otro tenant → 404 y no escribe nada', async () => {
        const { store, embeddings } = seed();
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(1)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            photoId: 'photo-b', // existe, pero es de TENANT_B y de otra persona
            consent: true,
        });

        expect(res.status).toBe(404);
        expect(embeddings.size).toBe(0);
    });
});

describe('getFaceStatus', () => {
    it('devuelve estado del enrolment + disponibilidad del detector', async () => {
        const { store } = seed();
        const res = await getFaceStatus(
            { store, resolveDetector: async () => FakeFaceDetector.withFaces(0) },
            { tenantId: TENANT_A, personId: PERSON_ID },
        );

        expect(res.status).toBe(200);
        expect(res.body.faceStatus).toBe('pending');
        expect(res.body.consentGiven).toBe(false);
        expect(res.body.embeddingRef).toBeNull();
        expect(res.body.faceCount).toBe(0);
        expect(res.body.detectorAvailable).toBe(faceModelsPresent());
    });

    it('persona de otro tenant → 404', async () => {
        const { store } = seed();
        const res = await getFaceStatus(
            { store, resolveDetector: async () => FakeFaceDetector.withFaces(0) },
            { tenantId: TENANT_A, personId: 'person-b' },
        );
        expect(res.status).toBe(404);
    });
});

describe('enrollFace — atajo foto primaria', () => {
    it('sin photoId enrola la foto primaria', async () => {
        const { store, embeddings } = seed();
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(1)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            consent: true,
        });

        expect(res.status).toBe(200);
        expect(res.body.photoId).toBe(PHOTO_ID);
        expect(embeddings.size).toBe(1);
    });

    it('sin foto primaria → 404', async () => {
        const { store } = createMemoryFaceStore({
            persons: [makePerson({ id: PERSON_ID, tenantId: TENANT_A })],
            photos: [],
        });
        const res = await enrollFace(deps(store, FakeFaceDetector.withFaces(1)), {
            tenantId: TENANT_A,
            personId: PERSON_ID,
            consent: true,
        });
        expect(res.status).toBe(404);
        expect(String(res.body.error)).toMatch(/foto primaria/i);
    });
});
