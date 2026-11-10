/**
 * Tests del slice PE-03: `personIdentityService` — atribución
 * `speaker_label` → `person_id` sampleando frames del video en la ventana
 * del speaker, detectando rostros y matcheando embeddings 512d contra
 * `face_embeddings` (distancia coseno, umbral 0.35 por defecto).
 *
 * Deterministas: store en memoria con los mismos filtros por tenant que la
 * implementación drizzle (incluido el `WHERE person_id IS NULL` de
 * `assignPersonToSpeaker`), `FakeFaceDetector`/`detectFaces` stubbed y
 * `extractFrame` stubbed — no corre ffmpeg, ni ONNX, ni DB, ni red.
 * Embeddings sintéticos normalizados: vectores base (1 en una posición),
 * así la distancia coseno es exactamente 0 (idéntico) o 1 (ortogonal).
 */
import { describe, expect, it, vi } from 'vitest';

import type { DetectedFace } from '../src/server/services/faceDetectionService';
import { FakeFaceDetector } from '../src/server/services/faceDetectionService';
import {
    createPersonIdentityService,
    type DetectFacesFn,
    type ExtractFrameFn,
    type IdentityTransmission,
} from '../src/server/services/personIdentityService';
import { createTransmissionSegmentsService } from '../src/server/services/transmissionSegmentsService';
import {
    createMemoryPersonIdentityStore,
    type MemoryFaceEmbedding,
    type MemoryPerson,
    type MemoryRecordingSegment,
    type MemoryTranscriptRow,
} from './helpers/memoryPersonIdentityStore';
import { createMemorySegmentsStore } from './helpers/memorySegmentsStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TX_1 = 'tx-1';
const REC_1 = 'rec-1';
const PREFIX = `${T_A}/${TX_1}`;
const P1 = 'person-1';
const P2 = 'person-2';

const BASE_TX: IdentityTransmission = { id: TX_1, tenantId: T_A, status: 'live' };

/** Vector base normalizado (1 en `index`, 0 en el resto) — 512 dims. */
function unitEmbedding(index: number, dims = 512): number[] {
    const v = new Array<number>(dims).fill(0);
    v[index % dims] = 1;
    return v;
}

const EMB_A = unitEmbedding(0);
const EMB_B = unitEmbedding(1);
const EMB_FAR = unitEmbedding(7);

function faceWith(embedding: number[], detScore = 0.95): DetectedFace {
    return { bbox: [10, 20, 90, 110], detScore, embedding };
}

function detectWith(detector: FakeFaceDetector): DetectFacesFn {
    return async (frame) => (await detector.detect(frame)).faces;
}

function tseg(id: string, over: Partial<MemoryTranscriptRow> = {}): MemoryTranscriptRow {
    return {
        id,
        tenantId: T_A,
        transmissionId: TX_1,
        startMs: 0,
        endMs: 120_000,
        speakerLabel: 'A',
        personId: null,
        ...over,
    };
}

function rseg(
    sequence: number,
    startMs: number,
    endMs: number | null,
    over: Partial<MemoryRecordingSegment> = {},
): MemoryRecordingSegment {
    return {
        tenantId: T_A,
        transmissionId: TX_1,
        recordingId: REC_1,
        sequence,
        startMs,
        endMs,
        fileRef: `seg-0000${sequence}.mp4`,
        storagePrefix: PREFIX,
        status: 'active',
        ...over,
    };
}

function person(id: string, name: string, tenantId = T_A): MemoryPerson {
    return { id, tenantId, name };
}

function embedding(personId: string, vec: number[], tenantId = T_A, id = `emb-${personId}`): MemoryFaceEmbedding {
    return { id, tenantId, personId, embedding: vec };
}

function makeService(opts: {
    transmissions?: IdentityTransmission[];
    transcriptSegments?: MemoryTranscriptRow[];
    recordingSegments?: MemoryRecordingSegment[];
    persons?: MemoryPerson[];
    embeddings?: MemoryFaceEmbedding[];
    detectFaces?: DetectFacesFn;
    extractFrame?: ExtractFrameFn;
    samplesPerSpeaker?: number;
    matchThreshold?: number;
} = {}) {
    const { store, state } = createMemoryPersonIdentityStore({
        transmissions: opts.transmissions ?? [BASE_TX],
        transcriptSegments:
            opts.transcriptSegments ?? [tseg('ts-1'), tseg('ts-2', { startMs: 60_000 })],
        recordingSegments:
            opts.recordingSegments ?? [rseg(0, 0, 60_000), rseg(1, 60_000, 120_000)],
        persons: opts.persons ?? [person(P1, 'Conductora'), person(P2, 'Invitado')],
        embeddings:
            opts.embeddings ?? [embedding(P1, EMB_A), embedding(P2, EMB_B)],
    });
    const { store: segmentsStore, state: segmentsState } = createMemorySegmentsStore();

    const extractFrame = vi.fn<ExtractFrameFn>(
        opts.extractFrame ?? (async () => Buffer.from('fake-jpeg')),
    );
    const detectFaces = vi.fn<DetectFacesFn>(
        opts.detectFaces ?? detectWith(new FakeFaceDetector([faceWith(EMB_A)])),
    );

    const service = createPersonIdentityService(store, {
        detectFaces,
        extractFrame,
        segments: createTransmissionSegmentsService(segmentsStore),
        samplesPerSpeaker: opts.samplesPerSpeaker,
        matchThreshold: opts.matchThreshold,
    });

    return { service, state, segmentsStore, segmentsState, extractFrame, detectFaces };
}

const RESOLVE = { tenantId: T_A, transmissionId: TX_1 };

describe('resolveTransmissionSpeakers — speaker resuelto sobre el umbral', () => {
    it('asigna el personId del match con votos bajo umbral y confianza', async () => {
        const { service, state, extractFrame, detectFaces } = makeService();

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res).toHaveLength(1);
        expect(res[0]).toMatchObject({
            speakerLabel: 'A',
            personId: P1,
            personName: 'Conductora',
            reason: null,
        });
        // 5 votos de 5 caras, mejor distancia 0 → confianza 1.
        expect(res[0].confidence).toBeCloseTo(1, 3);
        expect(res[0].evidence).toMatchObject({
            samplesPlanned: 5,
            framesExtracted: 5,
            facesDetected: 5,
            matchedFaces: 5,
            bestDistance: 0,
            segmentsAssigned: 2,
        });
        expect(res[0].evidence.votes).toEqual({ [P1]: 5 });
        // Las dos utterances sin atribuir quedaron con personId.
        expect(state.transcriptSegments.every((r) => r.personId === P1)).toBe(true);

        // 5 samples: t=20000/40000 caen en seg-0, t=60000+ en seg-1 — el
        // seek de ffmpeg es RELATIVO AL ARCHIVO (t − segment.startMs).
        expect(extractFrame).toHaveBeenCalledTimes(5);
        expect(extractFrame).toHaveBeenNthCalledWith(1, `${PREFIX}/seg-00000.mp4`, 20_000);
        expect(extractFrame).toHaveBeenNthCalledWith(5, `${PREFIX}/seg-00001.mp4`, 40_000);
        expect(detectFaces).toHaveBeenCalledTimes(5);
    });

    it('un FakeFaceDetector real (withFaces) también resuelve contra el mismo embedding enrolado', async () => {
        const detector = FakeFaceDetector.withFaces(1, 7);
        const enrolled = (await detector.detect(Buffer.from('x'))).faces[0].embedding;
        const { service, state } = makeService({
            embeddings: [embedding(P1, enrolled)],
            detectFaces: detectWith(detector),
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res[0].personId).toBe(P1);
        expect(state.transcriptSegments.every((r) => r.personId === P1)).toBe(true);
    });
});

describe('resolveTransmissionSpeakers — sin evidencia suficiente', () => {
    it('sin match bajo umbral → personId NULL con razón below_threshold', async () => {
        const { service, state } = makeService({
            // El único embedding enrolado es ortogonal (distancia 1 > 0.35).
            embeddings: [embedding(P1, EMB_FAR)],
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res).toHaveLength(1);
        expect(res[0]).toMatchObject({
            speakerLabel: 'A',
            personId: null,
            personName: null,
            confidence: null,
            reason: 'below_threshold',
        });
        expect(res[0].evidence.matchedFaces).toBe(0);
        // Nunca se escribió nada: los person_id siguen NULL.
        expect(state.transcriptSegments.every((r) => r.personId === null)).toBe(true);
        expect(state.calls.some((c) => c.method === 'assignPersonToSpeaker')).toBe(false);
    });

    it('sin segmentos de grabación que cubran la ventana → no_frames', async () => {
        const { service, state, extractFrame, detectFaces } = makeService({
            recordingSegments: [],
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res[0]).toMatchObject({ personId: null, reason: 'no_frames' });
        expect(res[0].evidence.framesExtracted).toBe(0);
        expect(extractFrame).not.toHaveBeenCalled();
        expect(detectFaces).not.toHaveBeenCalled();
        expect(state.transcriptSegments.every((r) => r.personId === null)).toBe(true);
    });

    it('frames extraídos pero sin rostros → no_faces', async () => {
        const { service } = makeService({
            detectFaces: detectWith(new FakeFaceDetector([])),
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res[0]).toMatchObject({ personId: null, reason: 'no_faces' });
        expect(res[0].evidence.framesExtracted).toBe(5);
        expect(res[0].evidence.facesDetected).toBe(0);
    });

    it('una extracción que falla se saltea sin romper al speaker', async () => {
        let calls = 0;
        const { service } = makeService({
            extractFrame: async () => {
                calls++;
                if (calls <= 2) throw new Error('ffmpeg salió con código 1');
                return Buffer.from('fake-jpeg');
            },
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        // 3 frames válidos → 3 votos → resuelve igual.
        expect(res[0].personId).toBe(P1);
        expect(res[0].evidence.framesExtracted).toBe(3);
    });
});

describe('corrección manual — persiste y pisa', () => {
    it('auto-resolve NO pisa un person_id ya asignado (WHERE person_id IS NULL)', async () => {
        const { service, state } = makeService({
            transcriptSegments: [
                tseg('ts-manual', { personId: 'manual-person' }), // corrección previa
                tseg('ts-null', { startMs: 60_000 }),
            ],
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res[0].personId).toBe(P1);
        // Sólo la fila NULL se escribió.
        expect(res[0].evidence.segmentsAssigned).toBe(1);
        const manual = state.transcriptSegments.find((r) => r.id === 'ts-manual')!;
        const auto = state.transcriptSegments.find((r) => r.id === 'ts-null')!;
        expect(manual.personId).toBe('manual-person'); // la corrección persiste
        expect(auto.personId).toBe(P1);
    });

    it('speaker 100% atribuido no entra en la resolución', async () => {
        const { service, state, extractFrame } = makeService({
            transcriptSegments: [tseg('ts-1', { personId: P2 })],
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res).toHaveLength(0);
        expect(extractFrame).not.toHaveBeenCalled();
        expect(state.transcriptSegments[0].personId).toBe(P2);
    });

    it('correctSpeakerPerson pisa asignaciones previas y admite desasignar (null)', async () => {
        const { service, state } = makeService({
            transcriptSegments: [
                tseg('ts-1', { personId: P1 }),
                tseg('ts-2', { startMs: 60_000, personId: P1 }),
            ],
        });

        const res = await service.correctSpeakerPerson({
            ...RESOLVE,
            speakerLabel: 'A',
            personId: P2,
        });
        expect(res.segmentsUpdated).toBe(2);
        expect(state.transcriptSegments.every((r) => r.personId === P2)).toBe(true);

        const un = await service.correctSpeakerPerson({
            ...RESOLVE,
            speakerLabel: 'A',
            personId: null,
        });
        expect(un.segmentsUpdated).toBe(2);
        expect(state.transcriptSegments.every((r) => r.personId === null)).toBe(true);
    });
});

describe('propagación a transmission_segments (jsonb speakers)', () => {
    it('la resolución escribe personId sólo en labels coincidentes y sin atribuir', async () => {
        const { service, segmentsStore, segmentsState } = makeService();
        await segmentsStore.insertSegment({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 0,
            endMs: 120_000,
            speakers: [{ label: 'A' }, { label: 'B' }, { label: 'C', personId: 'manual-c' }],
        });

        await service.resolveTransmissionSpeakers(RESOLVE);

        const seg = [...segmentsState.segments.values()][0];
        expect(seg.speakers).toEqual([
            { label: 'A', personId: P1 },       // propagado
            { label: 'B' },                      // label distinto — intacto
            { label: 'C', personId: 'manual-c' }, // ya atribuido — persiste
        ]);
    });

    it('correctSpeakerPerson pisa el personId del segmento temático', async () => {
        const { service, segmentsStore, segmentsState } = makeService();
        await segmentsStore.insertSegment({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 0,
            endMs: 120_000,
            speakers: [{ label: 'A', personId: P1 }],
        });

        await service.correctSpeakerPerson({ ...RESOLVE, speakerLabel: 'A', personId: P2 });

        const seg = [...segmentsState.segments.values()][0];
        expect(seg.speakers).toEqual([{ label: 'A', personId: P2 }]);
    });
});

describe('aislamiento por tenant', () => {
    it('toda query del store lleva tenant_id y no ve datos del otro tenant', async () => {
        const { service, state } = makeService({
            transmissions: [BASE_TX, { id: TX_1, tenantId: T_B, status: 'live' }],
            transcriptSegments: [
                tseg('ts-a'),
                tseg('ts-b', { tenantId: T_B, speakerLabel: 'Z' }),
            ],
            recordingSegments: [
                rseg(0, 0, 120_000),
                rseg(0, 0, 120_000, { tenantId: T_B, storagePrefix: `${T_B}/${TX_1}` }),
            ],
            persons: [person(P1, 'Conductora'), person('person-b', 'Ajena', T_B)],
            embeddings: [embedding(P1, EMB_A), embedding('person-b', EMB_A, T_B)],
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        // Sólo el speaker de T_A se listó y resolvió.
        expect(res).toHaveLength(1);
        expect(res[0].speakerLabel).toBe('A');
        expect(res[0].personId).toBe(P1);

        // La fila del otro tenant quedó intacta.
        const foreign = state.transcriptSegments.find((r) => r.id === 'ts-b')!;
        expect(foreign.personId).toBeNull();

        // Y TODA llamada al store fue con el tenant del input.
        expect(state.calls.length).toBeGreaterThan(0);
        for (const call of state.calls) expect(call.tenantId).toBe(T_A);
    });

    it('resolver una transmisión ajena al tenant → rechaza sin tocar nada', async () => {
        const { service, extractFrame } = makeService();

        await expect(
            service.resolveTransmissionSpeakers({ tenantId: T_B, transmissionId: TX_1 }),
        ).rejects.toThrow(/no encontrada/);
        expect(extractFrame).not.toHaveBeenCalled();
    });
});

describe('múltiples speakers independientes', () => {
    it('cada speaker vota y se resuelve por separado', async () => {
        // A habla en [0, 60s), B en [60s, 120s): 5 samples por ventana →
        // las primeras 5 detecciones son de A (EMB_A→P1), las 5 siguientes
        // de B (EMB_B→P2).
        let detectCalls = 0;
        const detectFaces: DetectFacesFn = async () => {
            detectCalls++;
            return [faceWith(detectCalls <= 5 ? EMB_A : EMB_B)];
        };
        const { service, state } = makeService({
            transcriptSegments: [
                tseg('ts-a1', { startMs: 1_000, endMs: 30_000, speakerLabel: 'A' }),
                tseg('ts-a2', { startMs: 30_000, endMs: 59_000, speakerLabel: 'A' }),
                tseg('ts-b1', { startMs: 61_000, endMs: 90_000, speakerLabel: 'B' }),
                tseg('ts-b2', { startMs: 90_000, endMs: 119_000, speakerLabel: 'B' }),
            ],
            detectFaces,
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res).toHaveLength(2);
        expect(res[0]).toMatchObject({ speakerLabel: 'A', personId: P1, reason: null });
        expect(res[1]).toMatchObject({ speakerLabel: 'B', personId: P2, reason: null });
        expect(res[0].evidence.votes).toEqual({ [P1]: 5 });
        expect(res[1].evidence.votes).toEqual({ [P2]: 5 });

        const byLabel = (label: string) =>
            state.transcriptSegments.filter((r) => r.speakerLabel === label);
        expect(byLabel('A').every((r) => r.personId === P1)).toBe(true);
        expect(byLabel('B').every((r) => r.personId === P2)).toBe(true);
    });

    it('un speaker sin evidencia no impide resolver al otro', async () => {
        let detectCalls = 0;
        const detectFaces: DetectFacesFn = async () => {
            detectCalls++;
            // A no tiene cara en sus frames; B sí.
            return detectCalls <= 5 ? [] : [faceWith(EMB_B)];
        };
        const { service, state } = makeService({
            transcriptSegments: [
                tseg('ts-a1', { startMs: 1_000, endMs: 59_000, speakerLabel: 'A' }),
                tseg('ts-b1', { startMs: 61_000, endMs: 119_000, speakerLabel: 'B' }),
            ],
            detectFaces,
        });

        const res = await service.resolveTransmissionSpeakers(RESOLVE);

        expect(res).toHaveLength(2);
        expect(res[0]).toMatchObject({ speakerLabel: 'A', personId: null, reason: 'no_faces' });
        expect(res[1]).toMatchObject({ speakerLabel: 'B', personId: P2, reason: null });
        expect(state.transcriptSegments.find((r) => r.id === 'ts-a1')!.personId).toBeNull();
        expect(state.transcriptSegments.find((r) => r.id === 'ts-b1')!.personId).toBe(P2);
    });
});
