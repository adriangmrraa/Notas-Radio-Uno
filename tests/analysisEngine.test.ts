/**
 * Tests del slice PE-02: `analysisEngineService` — el motor que conecta la
 * ingesta con el análisis (segmento MP4 → audio → transcripción →
 * transcript_segments → análisis → transmission_segments + moments/quotes
 * → alertas).
 *
 * Deterministas: store en memoria con los mismos filtros por tenant que la
 * implementación drizzle, y TODAS las deps stubbed (transcribe/analyze/
 * extractAudio/alerts) — no corre ffmpeg, ni APIs externas, ni DB. La
 * escritura de `transmission_segments` usa el servicio real (PE-06) sobre
 * un memorySegmentsStore.
 */
import { describe, expect, it, vi } from 'vitest';

import type { DiarizedTranscription, Utterance } from '../src/shared/types.js';
import {
    createAnalysisEngineService,
    type AnalysisEngineDeps,
    type AnalysisResult,
    type EngineRecording,
    type EngineRecordingSegment,
    type EngineTransmission,
} from '../src/server/services/analysisEngineService';
import { createTransmissionSegmentsService } from '../src/server/services/transmissionSegmentsService';
import { createMemoryAnalysisEngineStore } from './helpers/memoryAnalysisEngineStore';
import { createMemorySegmentsStore } from './helpers/memorySegmentsStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TX_1 = 'tx-1';
const REC_1 = 'rec-1';
const PREFIX = `${T_A}/${TX_1}`;

const BASE_TX: EngineTransmission = {
    id: TX_1,
    tenantId: T_A,
    status: 'live',
    programId: null,
};

const BASE_REC: EngineRecording = {
    id: REC_1,
    tenantId: T_A,
    transmissionId: TX_1,
    storagePrefix: PREFIX,
    status: 'completed',
};

function seg(sequence: number, startMs: number, endMs: number | null, status = 'active'): EngineRecordingSegment {
    return {
        id: `rs-${sequence}`,
        tenantId: T_A,
        recordingId: REC_1,
        sequence,
        startMs,
        endMs,
        fileRef: `seg-0000${sequence}.mp4`,
        status,
    };
}

const UTTERS: Utterance[] = [
    { speaker: 'A', text: 'Hola, arrancamos el bloque.', start: 1_500, end: 3_800 },
    { speaker: 'B', text: 'Hablemos de la inflación.', start: 4_000, end: 5_200 },
];

function diarized(over: Partial<DiarizedTranscription> = {}): DiarizedTranscription {
    return {
        text: 'Hola, arrancamos el bloque. Hablemos de la inflación.',
        diarizedText: '[A]: Hola, arrancamos el bloque.\n[B]: Hablemos de la inflación.',
        speakerCount: 2,
        utterances: UTTERS,
        provider: 'assemblyai',
        ...over,
    };
}

const ANALYSIS: AnalysisResult = {
    segments: [
        {
            startMs: 61_500,
            endMs: 65_200,
            topic: 'Economía',
            summary: 'Apertura y plan de bloque sobre inflación',
            speakers: [{ label: 'A' }, { label: 'B' }],
            confidence: 0.9,
        },
    ],
    moments: [
        {
            startMs: 64_000,
            endMs: 65_200,
            title: 'Anuncia tema central',
            reason: 'anticipo de datos de inflación',
            score: 0.7,
        },
    ],
    quotes: [
        {
            startMs: 64_000,
            endMs: 65_200,
            text: 'Hablemos de la inflación.',
            speakerLabel: 'B',
        },
    ],
};

function makeEngine(opts: {
    transmission?: EngineTransmission | null;
    recordings?: EngineRecording[];
    recordingSegments?: EngineRecordingSegment[];
    transcription?: DiarizedTranscription;
    analysis?: AnalysisResult;
    analyze?: AnalysisEngineDeps['analyze'];
    transcribe?: AnalysisEngineDeps['transcribe'];
    extractAudio?: AnalysisEngineDeps['extractAudio'];
    alerts?: AnalysisEngineDeps['alerts'];
} = {}) {
    const { store, state } = createMemoryAnalysisEngineStore({
        transmissions: opts.transmission === null ? [] : [opts.transmission ?? BASE_TX],
        recordings: opts.recordings ?? [BASE_REC],
        recordingSegments: opts.recordingSegments ?? [seg(0, 60_000, 120_000)],
    });
    const { store: segmentsStore, state: segmentsState } = createMemorySegmentsStore();

    const extractAudio = vi.fn(
        opts.extractAudio ?? (async (fileRef: string) => `/tmp/${fileRef}.mp3`),
    );
    const transcribe = vi.fn(
        opts.transcribe ?? (async () => opts.transcription ?? diarized()),
    );
    const analyze = vi.fn(opts.analyze ?? (async () => opts.analysis ?? ANALYSIS));
    const alerts = vi.fn(opts.alerts ?? (async () => []));

    const service = createAnalysisEngineService(store, {
        extractAudio,
        transcribe,
        analyze,
        alerts,
        segments: createTransmissionSegmentsService(segmentsStore),
    });

    return { service, state, segmentsState, extractAudio, transcribe, analyze, alerts };
}

const PROCESS = { tenantId: T_A, transmissionId: TX_1, recordingId: REC_1, sequence: 0 };

describe('processRecordingSegment — utterances → transcript_segments', () => {
    it('mapea offsets relativos del archivo a absolutos (startMs del segmento + offset)', async () => {
        const { service, state } = makeEngine();

        const res = await service.processRecordingSegment(PROCESS);

        expect(res.utterancesInserted).toBe(2);
        expect(state.transcriptSegments).toHaveLength(2);
        // segment.startMs = 60_000 → 60_000 + 1_500 / 60_000 + 4_000
        expect(state.transcriptSegments[0]).toMatchObject({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 61_500,
            endMs: 63_800,
            speakerLabel: 'A',
            text: 'Hola, arrancamos el bloque.',
        });
        expect(state.transcriptSegments[1]).toMatchObject({
            startMs: 64_000,
            endMs: 65_200,
            speakerLabel: 'B',
        });
    });

    it('extrae el audio de la key storagePrefix/fileRef y transcribe ese archivo', async () => {
        const { service, extractAudio, transcribe } = makeEngine();

        await service.processRecordingSegment(PROCESS);

        expect(extractAudio).toHaveBeenCalledWith(`${PREFIX}/seg-00000.mp4`);
        expect(transcribe).toHaveBeenCalledWith(`/tmp/${PREFIX}/seg-00000.mp4.mp3`);
    });
});

describe('processRecordingSegment — análisis → segments/moments/quotes', () => {
    it('escribe unidades temáticas vía transmissionSegmentsService real', async () => {
        const { service, segmentsState } = makeEngine();

        const res = await service.processRecordingSegment(PROCESS);

        expect(res.segmentsWritten).toBe(1);
        const written = [...segmentsState.segments.values()];
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
            tenantId: T_A,
            transmissionId: TX_1,
            startMs: 61_500,
            endMs: 65_200,
            topic: 'Economía',
            summary: 'Apertura y plan de bloque sobre inflación',
            confidence: 0.9,
        });
        expect(written[0].speakers).toEqual([{ label: 'A' }, { label: 'B' }]);
    });

    it('escribe momentos kind=detected y citas como moments con reason=quote', async () => {
        const { service, state } = makeEngine();

        const res = await service.processRecordingSegment(PROCESS);

        expect(res.momentsWritten).toBe(1);
        expect(res.quotesWritten).toBe(1);
        expect(state.moments).toHaveLength(2);

        expect(state.moments[0]).toMatchObject({
            tenantId: T_A,
            transmissionId: TX_1,
            kind: 'detected',
            startMs: 64_000,
            endMs: 65_200,
            title: 'Anuncia tema central',
            reason: 'anticipo de datos de inflación',
            score: 0.7,
        });
        // La cita persiste el texto en `title` (PE-05 la enriquece después).
        expect(state.moments[1]).toMatchObject({
            kind: 'detected',
            title: 'Hablemos de la inflación.',
            reason: 'quote',
            score: null,
        });
    });

    it('pasa la ventana con offsets absolutos al analyzer', async () => {
        const { service, analyze } = makeEngine();

        await service.processRecordingSegment(PROCESS);

        expect(analyze).toHaveBeenCalledWith({
            transcript:
                '[61500-63800ms] A: Hola, arrancamos el bloque.\n' +
                '[64000-65200ms] B: Hablemos de la inflación.',
            prevContext: undefined,
        });
    });
});

describe('alerts — fire-and-forget sobre el texto nuevo', () => {
    it('llama checkTranscriptAlerts con el texto nuevo y el tenant correcto', async () => {
        const { service, alerts } = makeEngine();

        await service.processRecordingSegment(PROCESS);

        expect(alerts).toHaveBeenCalledTimes(1);
        expect(alerts).toHaveBeenCalledWith(T_A, TX_1, diarized().diarizedText);
    });

    it('un fallo de alerts no corta el segmento', async () => {
        const { service, state } = makeEngine({
            alerts: () => Promise.reject(new Error('alerts caído')),
        });
        const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const res = await service.processRecordingSegment(PROCESS);

        // El rechazo queda atrapado por el fire-and-forget: el segmento
        // procesa igual y todo queda escrito.
        expect(res.utterancesInserted).toBe(2);
        expect(state.transcriptSegments).toHaveLength(2);
        await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
        errSpy.mockRestore();
    });
});

describe('transcripción vacía', () => {
    it('sin utterances ni texto → no escribe nada ni llama analyze ni alerts', async () => {
        const { service, state, segmentsState, analyze, alerts } = makeEngine({
            transcription: diarized({ text: '', diarizedText: '', utterances: [], speakerCount: 0 }),
        });

        const res = await service.processRecordingSegment(PROCESS);

        expect(res).toMatchObject({
            utterancesInserted: 0,
            segmentsWritten: 0,
            momentsWritten: 0,
            quotesWritten: 0,
        });
        expect(state.transcriptSegments).toHaveLength(0);
        expect(state.moments).toHaveLength(0);
        expect(segmentsState.segments.size).toBe(0);
        expect(analyze).not.toHaveBeenCalled();
        expect(alerts).not.toHaveBeenCalled();
    });

    it('texto plano sin utterances (whisper) → alertas igual, sin inserts ni análisis', async () => {
        const { service, state, analyze, alerts } = makeEngine({
            transcription: diarized({
                text: 'Bloque sin diarización, texto plano.',
                diarizedText: '',
                utterances: [],
                speakerCount: 0,
                provider: 'whisper',
            }),
        });

        const res = await service.processRecordingSegment(PROCESS);

        expect(res.utterancesInserted).toBe(0);
        expect(state.transcriptSegments).toHaveLength(0);
        expect(state.moments).toHaveLength(0);
        expect(analyze).not.toHaveBeenCalled();
        expect(alerts).toHaveBeenCalledWith(T_A, TX_1, 'Bloque sin diarización, texto plano.');
    });
});

describe('aislamiento por tenant', () => {
    it('toda query del store lleva tenant_id', async () => {
        const { service, state } = makeEngine();

        await service.processRecordingSegment(PROCESS);

        expect(state.calls.length).toBeGreaterThan(0);
        for (const call of state.calls) {
            expect(call.tenantId).toBe(T_A);
        }
        // y lo escrito quedó con el tenant del input
        expect(state.transcriptSegments.every((r) => r.tenantId === T_A)).toBe(true);
        expect(state.moments.every((m) => m.tenantId === T_A)).toBe(true);
    });

    it('un tenant ajeno no ve la transmisión ni grabaciones del otro', async () => {
        const { service, extractAudio } = makeEngine();

        // TX_1 existe pero es de T_A: para T_B es "no encontrada".
        await expect(
            service.processTransmission({ tenantId: T_B, transmissionId: TX_1 }),
        ).rejects.toThrow(/no encontrada/);
        expect(extractAudio).not.toHaveBeenCalled();
    });
});

describe('processTransmission — loop post-hoc sobre segmentos activos', () => {
    it('procesa los segmentos activos en orden y encadena prevContext', async () => {
        const { service, state, analyze } = makeEngine({
            recordingSegments: [
                seg(0, 0, 60_000),
                seg(1, 60_000, 120_000),
                seg(2, 120_000, 180_000, 'purged'), // sin archivo → se saltea
            ],
        });

        const totals = await service.processTransmission({ tenantId: T_A, transmissionId: TX_1 });

        expect(totals).toMatchObject({
            segmentsProcessed: 2,
            segmentsFailed: 0,
            utterancesInserted: 4,
            segmentsWritten: 2,
            momentsWritten: 2,
            quotesWritten: 2,
        });
        // 2 segmentos × 2 utterances
        expect(state.transcriptSegments).toHaveLength(4);
        // El segundo analyze recibió la ventana del primero como contexto.
        expect(analyze).toHaveBeenCalledTimes(2);
        const secondCall = analyze.mock.calls[1][0];
        expect(secondCall.prevContext).toContain('[1500-3800ms]');
    });

    it('un segmento que falla se loguea y se saltea — no corta el loop', async () => {
        const { service, state } = makeEngine({
            recordingSegments: [seg(0, 0, 60_000), seg(1, 60_000, 120_000)],
            transcribe: vi
                .fn()
                .mockRejectedValueOnce(new Error('audio corrupto'))
                .mockResolvedValue(diarized()),
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const totals = await service.processTransmission({ tenantId: T_A, transmissionId: TX_1 });

        expect(totals.segmentsFailed).toBe(1);
        expect(totals.segmentsProcessed).toBe(1);
        expect(totals.utterancesInserted).toBe(2);
        expect(state.transcriptSegments).toHaveLength(2);
        // los únicos escritos son los del segmento 1 (offsets ≥ 60_000)
        expect(state.transcriptSegments[0].startMs).toBe(61_500);
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });
});

describe('errores de dispatch', () => {
    it('transmisión inexistente → rechaza', async () => {
        const { service } = makeEngine({ transmission: null });
        await expect(service.processRecordingSegment(PROCESS)).rejects.toThrow(/no encontrada/);
    });

    it('segmento inexistente → rechaza', async () => {
        const { service } = makeEngine();
        await expect(
            service.processRecordingSegment({ ...PROCESS, sequence: 99 }),
        ).rejects.toThrow(/no encontrado/);
    });
});
