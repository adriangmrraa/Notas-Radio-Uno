/**
 * Tests del slice PE-04: `liveAnalysisRunner` + el hook
 * `setSegmentFinalizedHook` de `streamRecorderService`.
 *
 * Sin DB, sin sockets, sin ffmpeg:
 *   - El runner corre con `engine`/`store`/`emit` inyectados (memoryRunnerStore
 *     con el mismo filtro por tenant que drizzle).
 *   - El test del hook usa el harness del recorder (spawnProcess fake,
 *     FilesystemRawStorage sobre tmpdir, segmentos .mp4 falsos) — verifica que
 *     el cierre de un segmento invoca el hook con los 4 ids y que un hook que
 *     falla NUNCA rompe la grabación.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
    createLiveAnalysisRunner,
    type LiveAnalysisEmit,
    type LiveAnalysisEngine,
} from '../src/server/services/liveAnalysisRunner';
import type {
    ProcessRecordingSegmentInput,
    ProcessSegmentSummary,
} from '../src/server/services/analysisEngineService';
import type { TransmissionRow } from '../src/server/services/transmissionService';
import { FilesystemRawStorage } from '../src/server/services/rawStorageService';
import {
    setSegmentFinalizedHook,
    startRecording,
    type RecorderProcess,
    type RecorderSpawner,
    type SegmentFinalizedInfo,
} from '../src/server/services/streamRecorderService';
import type { ResolvedStream } from '../src/server/services/streamSourceResolver';
import { createMemoryRunnerStore } from './helpers/memoryRunnerStore';
import { createMemoryRecorderStore } from './helpers/memoryRecorderStore';
import { createMemoryTransitionRunner } from './helpers/memoryTransitionRunner';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const TX_A = '00000000-0000-4000-8000-0000000000e1';
const REC_A = '00000000-0000-4000-8000-0000000000r1';

// ─── Runner: engine → rooms ─────────────────────────────────────────────────

function makeTxRow(overrides: Partial<TransmissionRow> = {}): TransmissionRow {
    const t0 = new Date('2026-11-09T12:00:00.000Z');
    return {
        id: TX_A,
        tenantId: TENANT_A,
        programId: null,
        scheduledTransmissionId: null,
        source: 'live_capture',
        status: 'live',
        streamUrl: 'https://x.example.com/live',
        resolvedStreamUrl: 'https://cdn.example.com/live.m3u8',
        crudoRef: `${TENANT_A}/${TX_A}`,
        durationMinutes: 60,
        startedAt: t0,
        endedAt: null,
        waitingSince: null,
        lastHeartbeatAt: null,
        errorMessage: null,
        pipelineConfig: {},
        createdAt: t0,
        updatedAt: t0,
        ...overrides,
    };
}

function makeSummary(overrides: Partial<ProcessSegmentSummary> = {}): ProcessSegmentSummary {
    return {
        utterancesInserted: 4,
        segmentsWritten: 1,
        momentsWritten: 2,
        quotesWritten: 1,
        transcript: '[0-1000ms] A: hola',
        ...overrides,
    };
}

const INFO: SegmentFinalizedInfo = {
    tenantId: TENANT_A,
    transmissionId: TX_A,
    recordingId: REC_A,
    sequence: 3,
};

function makeRunner(opts: {
    engineResult?: ProcessSegmentSummary | Error;
    rows?: TransmissionRow[];
}) {
    const calls: ProcessRecordingSegmentInput[] = [];
    const engine: LiveAnalysisEngine = {
        async processRecordingSegment(input) {
            calls.push(input);
            if (opts.engineResult instanceof Error) throw opts.engineResult;
            return opts.engineResult ?? makeSummary();
        },
    };
    const { store, state } = createMemoryRunnerStore({
        transmissions: opts.rows ?? [makeTxRow()],
    });
    const emitted: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
    const emit: LiveAnalysisEmit = (rooms, event, payload) => {
        emitted.push({ rooms, event, payload });
    };

    const runner = createLiveAnalysisRunner({ engine, store, emit });
    return { runner, calls, emitted, state };
}

describe('handleSegmentFinalized', () => {
    it('segmento cerrado → engine con los 4 ids → emite a ambos rooms', async () => {
        const { runner, calls, emitted, state } = makeRunner({});

        await runner.handleSegmentFinalized(INFO);

        // El engine recibe exactamente el contrato heredado.
        expect(calls).toEqual([
            {
                tenantId: TENANT_A,
                transmissionId: TX_A,
                recordingId: REC_A,
                sequence: 3,
            },
        ]);

        // La fila fresca se leyó tenant-scoped.
        expect(state.calls).toEqual([{ tenantId: TENANT_A, transmissionId: TX_A }]);

        // transmission:updated → tenant:{id} con la fila serializada.
        const updated = emitted.find((e) => e.event === 'transmission:updated');
        expect(updated).toBeTruthy();
        expect(updated!.rooms).toEqual([`tenant:${TENANT_A}`]);
        const payload = updated!.payload as Record<string, unknown>;
        expect(payload.id).toBe(TX_A);
        expect(payload.tenantId).toBe(TENANT_A);
        expect(payload.status).toBe('live');
        expect(payload.startedAt).toBe('2026-11-09T12:00:00.000Z');
        // La URL resuelta efímera nunca viaja en el broadcast.
        expect(payload.resolvedStreamUrl).toBeUndefined();

        // transmission:moments → transmission:{id} + tenant:{id} con el summary.
        const moments = emitted.find((e) => e.event === 'transmission:moments');
        expect(moments).toBeTruthy();
        expect(moments!.rooms).toEqual([
            `transmission:${TX_A}`,
            `tenant:${TENANT_A}`,
        ]);
        const mp = moments!.payload as {
            transmissionId: string;
            summary: ProcessSegmentSummary;
        };
        expect(mp.transmissionId).toBe(TX_A);
        expect(mp.summary.momentsWritten).toBe(2);
        expect(mp.summary.quotesWritten).toBe(1);
        expect(mp.summary.segmentsWritten).toBe(1);
    });

    it('emite si aunque sea UN contador quedó > 0 (sólo segmentos temáticos)', async () => {
        const { runner, emitted } = makeRunner({
            engineResult: makeSummary({
                momentsWritten: 0,
                quotesWritten: 0,
                segmentsWritten: 1,
            }),
        });

        await runner.handleSegmentFinalized(INFO);
        expect(emitted.map((e) => e.event)).toEqual([
            'transmission:updated',
            'transmission:moments',
        ]);
    });

    it('engine devuelve todo en 0 → NO emite nada', async () => {
        const { runner, emitted } = makeRunner({
            engineResult: makeSummary({
                utterancesInserted: 0,
                segmentsWritten: 0,
                momentsWritten: 0,
                quotesWritten: 0,
                transcript: '',
            }),
        });

        await runner.handleSegmentFinalized(INFO);
        expect(emitted).toEqual([]);
    });

    it('engine que rechaza → error tolerado, no propaga ni emite', async () => {
        const { runner, emitted } = makeRunner({
            engineResult: new Error('extractAudio: ffmpeg not found'),
        });

        await expect(runner.handleSegmentFinalized(INFO)).resolves.toBeUndefined();
        expect(emitted).toEqual([]);
    });

    it('fila no encontrada → igual emite transmission:moments (los momentos ya están)', async () => {
        const { runner, emitted } = makeRunner({
            rows: [makeTxRow({ tenantId: TENANT_B })], // ajena al tenant
        });

        await runner.handleSegmentFinalized(INFO);
        expect(emitted.map((e) => e.event)).toEqual(['transmission:moments']);
    });
});

// ─── Hook en el recorder (fire-and-forget, nunca rompe la captura) ───────────

interface FakeProc {
    proc: RecorderProcess;
    close(code: number | null, signal?: string | null): void;
}

function makeSpawner() {
    const spawned: FakeProc[] = [];
    const spawnProcess: RecorderSpawner = () => {
        const events = new EventEmitter();
        const fake: FakeProc = {
            proc: {
                stdin: { write: () => {} },
                stderr: null,
                kill: () => true,
                on: (ev: string, cb: (...a: unknown[]) => void) => events.on(ev, cb),
            },
            close: (code, signal = null) => events.emit('close', code, signal),
        };
        spawned.push(fake);
        return fake.proc;
    };
    return { spawnProcess, spawned };
}

const pad = (n: number) => String(n).padStart(2, '0');
function segNameAt(epochMs: number): string {
    const d = new Date(epochMs);
    return (
        `seg-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.mp4`
    );
}

const tick = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

describe('setSegmentFinalizedHook en streamRecorderService', () => {
    const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
    let root: string;
    let storage: FilesystemRawStorage;
    let nowMs: number;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'livehook-'));
        storage = new FilesystemRawStorage(root);
        nowMs = T0;
    });

    afterEach(async () => {
        setSegmentFinalizedHook(null);
        await rm(root, { recursive: true, force: true });
    });

    function makeDeps() {
        const { store, state } = createMemoryRecorderStore({
            transmissions: [
                { id: TX_A, tenantId: TENANT_A, status: 'waiting', durationMinutes: null },
            ],
        });
        const spawner = makeSpawner();
        const resolver = async (): Promise<ResolvedStream> => ({
            url: 'https://cdn.example.com/live.m3u8',
            kind: 'hls',
            title: null,
            platform: 'generic',
            proxy: null,
        });
        const deps = {
            store,
            storage,
            resolver,
            spawnProcess: spawner.spawnProcess,
            probeDuration: null,
            heartbeatMs: 5,
            pollMs: 5,
            stopGraceMs: 50,
            sleep: () => Promise.resolve(),
            now: () => nowMs,
            transitionRun: createMemoryTransitionRunner({
                find: (tenantId, id) => state.transmissions.get(`${tenantId}/${id}`),
                now: () => new Date(nowMs),
            }),
        };
        return { deps, spawner };
    }

    it('los dos puntos de cierre invocan el hook con los 4 ids', async () => {
        const received: SegmentFinalizedInfo[] = [];
        setSegmentFinalizedHook((info) => {
            received.push(info);
        });

        const { deps, spawner } = makeDeps();
        const handle = await startRecording(
            { tenantId: TENANT_A, transmissionId: TX_A, streamUrl: 'https://x.example.com/live' },
            deps,
        );

        // Sólo un segmento abierto → todavía NO cierra → hook no disparado.
        const dir = storage.publicPath(`${TENANT_A}/${TX_A}`);
        await writeFile(path.join(dir, segNameAt(T0 + 5_000)), Buffer.alloc(100));
        await tick(80);
        expect(received).toEqual([]);

        // Aparece el siguiente → el anterior cierra en pollSegments.
        nowMs = T0 + 60_000;
        await writeFile(path.join(dir, segNameAt(T0 + 65_000)), Buffer.alloc(200));
        await vi.waitFor(() => expect(received).toHaveLength(1));
        expect(received[0]).toEqual({
            tenantId: TENANT_A,
            transmissionId: TX_A,
            recordingId: handle.recordingId,
            sequence: 0,
        });

        // El último pending cierra en finalize → segundo disparo, sequence 1.
        spawner.spawned[0].close(0);
        const outcome = await handle.done;
        expect(outcome.status).toBe('completed');
        await vi.waitFor(() => expect(received).toHaveLength(2));
        expect(received[1]).toEqual({
            tenantId: TENANT_A,
            transmissionId: TX_A,
            recordingId: handle.recordingId,
            sequence: 1,
        });
    });

    it('un hook que rechaza/tira NUNCA rompe la grabación', async () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        let calls = 0;
        setSegmentFinalizedHook(() => {
            calls += 1;
            if (calls === 1) throw new Error('boom sync');
            return Promise.reject(new Error('boom async'));
        });

        const { deps, spawner } = makeDeps();
        const handle = await startRecording(
            { tenantId: TENANT_A, transmissionId: TX_A, streamUrl: 'https://x.example.com/live' },
            deps,
        );

        const dir = storage.publicPath(`${TENANT_A}/${TX_A}`);
        await writeFile(path.join(dir, segNameAt(T0 + 5_000)), Buffer.alloc(100));
        nowMs = T0 + 60_000;
        await writeFile(path.join(dir, segNameAt(T0 + 65_000)), Buffer.alloc(200));
        await tick(80);

        spawner.spawned[0].close(0);
        const outcome = await handle.done;

        // La grabación completó igual: 2 segmentos, hook invocado en ambos.
        expect(outcome.status).toBe('completed');
        expect(outcome.segmentCount).toBe(2);
        await vi.waitFor(() => expect(calls).toBe(2));
        // PI-02: el logger estructurado emite UNA línea por evento (sin el
        // segundo argumento suelto del console.error anterior).
        expect(errors).toHaveBeenCalledWith(
            expect.stringContaining('[recorder] segmentFinalizedHook falló'),
        );
        errors.mockRestore();
    });
});
