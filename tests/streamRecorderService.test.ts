/**
 * Tests del slice PD-02: `streamRecorderService.ts`.
 *
 * Sin red, sin ffmpeg real, sin DB:
 *   - `buildFfmpegArgs`, `computeSegmentStartMs`, `segmentFileStartMs` y
 *     `shouldRetryFfmpeg` son funciones puras testeadas directamente.
 *   - El loop completo corre con `spawnProcess` fake (EventEmitter), un
 *     `FilesystemRawStorage` real sobre tmpdir, un `RecorderStore` en memoria
 *     (mismo filtro por tenant que drizzle) y un `resolver` fake.
 *   - Los "segmentos" son .mp4 falsos escritos a mano en el dir de storage
 *     con nombre strftime — el watcher los detecta por polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FilesystemRawStorage } from '../src/server/services/rawStorageService';
import {
    buildFfmpegArgs,
    computeSegmentStartMs,
    segmentFileStartMs,
    shouldRetryFfmpeg,
    startRecording,
    type RecorderProcess,
    type RecorderSpawner,
} from '../src/server/services/streamRecorderService';
import type { ResolvedStream } from '../src/server/services/streamSourceResolver';
import { createMemoryRecorderStore } from './helpers/memoryRecorderStore';
import { createMemoryTransitionRunner } from './helpers/memoryTransitionRunner';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TX_A = '00000000-0000-4000-8000-0000000000e1';

// ─── Fake ffmpeg process ────────────────────────────────────────────────────

interface FakeProc {
    proc: RecorderProcess;
    command: string;
    args: string[];
    stdinWrites: string[];
    kills: Array<string | undefined>;
    close(code: number | null, signal?: string | null): void;
    fail(err: Error): void;
    emitStderr(text: string): void;
}

function makeSpawner() {
    const spawned: FakeProc[] = [];
    const spawnProcess: RecorderSpawner = (command, args) => {
        const events = new EventEmitter();
        const stderr = new EventEmitter();
        const fake: FakeProc = {
            command,
            args,
            stdinWrites: [],
            kills: [],
            proc: {
                stdin: { write: (c: string) => void fake.stdinWrites.push(c) },
                stderr: { on: (ev: string, cb: (d: Buffer | string) => void) => stderr.on(ev, cb) },
                kill: (sig?: string) => {
                    fake.kills.push(sig);
                    return true;
                },
                on: (ev: string, cb: (...a: unknown[]) => void) => events.on(ev, cb),
            },
            close: (code, signal = null) => events.emit('close', code, signal),
            fail: (err) => events.emit('error', err),
            emitStderr: (text) => stderr.emit('data', text),
        };
        spawned.push(fake);
        return fake.proc;
    };
    return { spawnProcess, spawned };
}

function makeResolver(impl: (call: number) => ResolvedStream | Error) {
    const calls: Array<{ url: string }> = [];
    const resolver = async (url: string): Promise<ResolvedStream> => {
        calls.push({ url });
        const out = impl(calls.length - 1);
        if (out instanceof Error) throw out;
        return out;
    };
    return { resolver, calls };
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

// ─── Funciones puras ────────────────────────────────────────────────────────

describe('buildFfmpegArgs', () => {
    it('graba sin re-encode y segmentado: -c copy -f segment -segment_time -strftime 1', () => {
        const args = buildFfmpegArgs({
            inputUrl: 'https://cdn.example.com/live.m3u8',
            outputPattern: '/data/raw/t/tx/seg-%Y%m%d-%H%M%S.mp4',
            segmentSeconds: 60,
        });
        expect(args.slice(0, 3)).toEqual(['-hide_banner', '-loglevel', 'warning']);
        expect(args).toContain('-c');
        expect(args[args.indexOf('-c') + 1]).toBe('copy');
        expect(args[args.indexOf('-f') + 1]).toBe('segment');
        expect(args[args.indexOf('-segment_time') + 1]).toBe('60');
        expect(args).toContain('-reset_timestamps');
        expect(args).toContain('-strftime');
        expect(args[args.indexOf('-strftime') + 1]).toBe('1');
        expect(args[args.indexOf('-i') + 1]).toBe('https://cdn.example.com/live.m3u8');
        expect(args.at(-1)).toBe('/data/raw/t/tx/seg-%Y%m%d-%H%M%S.mp4');
    });

    it('NO agrega -protocol_whitelist para HLS remoto (la default de ffmpeg alcanza)', () => {
        const args = buildFfmpegArgs({
            inputUrl: 'https://cdn.example.com/live.m3u8',
            outputPattern: '/tmp/seg.mp4',
            segmentSeconds: 30,
        });
        expect(args).not.toContain('-protocol_whitelist');
    });

    it('agrega -protocol_whitelist antes de -i sólo para .m3u8 local', () => {
        const args = buildFfmpegArgs({
            inputUrl: '/media/lista.m3u8',
            outputPattern: '/tmp/seg.mp4',
            segmentSeconds: 30,
            localHlsInput: true,
        });
        expect(args).toContain('-protocol_whitelist');
        expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,http,https,tcp,tls,crypto');
        // Opción de input: va antes del -i.
        expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    });
});

describe('computeSegmentStartMs — anclaje wall-clock', () => {
    const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

    it('prefiere el timestamp strftime del nombre sobre el mtime', () => {
        const name = segNameAt(T0 + 5_000);
        const startMs = computeSegmentStartMs({
            fileName: name,
            mtimeMs: T0 + 99_000,
            startedAtMs: T0,
        });
        expect(startMs).toBe(5_000);
    });

    it('cae al mtime si el nombre no parsea', () => {
        const startMs = computeSegmentStartMs({
            fileName: 'segmento-raro.mp4',
            mtimeMs: T0 + 7_500,
            startedAtMs: T0,
        });
        expect(startMs).toBe(7_500);
    });

    it('clampea a >= 0 si el reloj del archivo quedó atrás del ancla', () => {
        const name = segNameAt(T0 - 60_000);
        expect(
            computeSegmentStartMs({ fileName: name, mtimeMs: T0 - 1_000, startedAtMs: T0 }),
        ).toBe(0);
    });

    it('segmentFileStartMs parsea seg-YYYYMMDD-HHMMSS como UTC', () => {
        expect(segmentFileStartMs('seg-20261109-120530.mp4')).toBe(Date.UTC(2026, 10, 9, 12, 5, 30));
        expect(segmentFileStartMs('no-es-seg.mp4')).toBeNull();
        expect(segmentFileStartMs('seg-20261109-120530.mp4.part')).toBe(Date.UTC(2026, 10, 9, 12, 5, 30));
    });
});

describe('shouldRetryFfmpeg', () => {
    it('no reintenta si se pidió stop ni si el exit fue limpio', () => {
        expect(shouldRetryFfmpeg({ exitCode: 1, stopRequested: true, attempt: 0, maxRetries: 3 })).toBe(false);
        expect(shouldRetryFfmpeg({ exitCode: 0, stopRequested: false, attempt: 0, maxRetries: 3 })).toBe(false);
    });

    it('reintenta con error hasta agotar maxRetries', () => {
        expect(shouldRetryFfmpeg({ exitCode: 1, stopRequested: false, attempt: 0, maxRetries: 3 })).toBe(true);
        expect(shouldRetryFfmpeg({ exitCode: 1, stopRequested: false, attempt: 3, maxRetries: 3 })).toBe(false);
        expect(shouldRetryFfmpeg({ exitCode: null, stopRequested: false, attempt: 1, maxRetries: 3 })).toBe(true);
    });
});

// ─── Loop completo con dependencias inyectadas ─────────────────────────────

describe('startRecording — loop de captura', () => {
    let root: string;
    let storage: FilesystemRawStorage;
    let nowMs: number;
    const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'recorder-'));
        storage = new FilesystemRawStorage(root);
        nowMs = T0;
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    function makeDeps(spawned: ReturnType<typeof makeSpawner>, resolverImpl: (call: number) => ResolvedStream | Error) {
        const { store, state } = createMemoryRecorderStore({
            transmissions: [
                { id: TX_A, tenantId: TENANT_A, status: 'waiting', durationMinutes: null },
            ],
        });
        const { resolver, calls: resolverCalls } = makeResolver(resolverImpl);
        const deps = {
            store,
            storage,
            resolver,
            spawnProcess: spawned.spawnProcess,
            probeDuration: null,
            heartbeatMs: 5,
            pollMs: 5,
            stopGraceMs: 50,
            sleep: () => Promise.resolve(),
            now: () => nowMs,
            // Los cambios de estado de la corrida van por la FSM real (PD-04),
            // igual que transitionTransmission hace sobre la DB.
            transitionRun: createMemoryTransitionRunner({
                find: (tenantId, id) =>
                    state.transmissions.get(`${tenantId}/${id}`),
                now: () => new Date(nowMs),
            }),
        };
        return { deps, store, state, resolverCalls };
    }

    it('graba segmentos anclados a wall-clock, cierra la grabación y deja crudo_ref = storagePrefix', async () => {
        const spawner = makeSpawner();
        const { deps, state } = makeDeps(spawner, () => ({
            url: 'https://cdn.example.com/live.m3u8',
            kind: 'hls',
            title: null,
            platform: 'generic',
            proxy: null,
        }));

        const prefix = `${TENANT_A}/${TX_A}`;
        const handle = await startRecording(
            { tenantId: TENANT_A, transmissionId: TX_A, streamUrl: 'https://x.example.com/live', segmentSeconds: 60 },
            deps,
        );
        expect(handle.recordingId).toBeTruthy();
        expect(spawner.spawned).toHaveLength(1);
        expect(spawner.spawned[0].args).toContain('-c');
        expect(spawner.spawned[0].args[spawner.spawned[0].args.indexOf('-c') + 1]).toBe('copy');

        // La transmisión quedó live con la URL resuelta.
        let tx = state.transmissions.get(`${TENANT_A}/${TX_A}`)!;
        expect(tx.status).toBe('live');
        expect(tx.resolvedStreamUrl).toBe('https://cdn.example.com/live.m3u8');
        expect(tx.startedAt).toEqual(new Date(T0));

        // Aparecen dos segmentos falsos.
        const dir = storage.publicPath(prefix);
        await writeFile(path.join(dir, segNameAt(T0 + 5_000)), Buffer.alloc(100, 1));
        nowMs = T0 + 60_000;
        await writeFile(path.join(dir, segNameAt(T0 + 65_000)), Buffer.alloc(200, 2));
        await tick(80);

        spawner.spawned[0].close(0);
        const outcome = await handle.done;

        expect(outcome.status).toBe('completed');
        expect(outcome.segmentCount).toBe(2);
        expect(outcome.totalBytes).toBe(300);

        // Segmentos: startMs anclados (5s y 65s), seg-0 cerrado al llegar seg-1.
        const segs = state.segments;
        expect(segs).toHaveLength(2);
        expect(segs[0].sequence).toBe(0);
        expect(segs[0].startMs).toBe(5_000);
        expect(segs[0].startMs).toBeGreaterThanOrEqual(0);
        expect(segs[0].endMs).toBe(65_000);
        expect(segs[1].sequence).toBe(1);
        expect(segs[1].startMs).toBe(65_000);
        expect(segs[1].endMs).toBeGreaterThanOrEqual(65_000);
        expect(segs.every((s) => s.tenantId === TENANT_A && s.fileRef.startsWith('seg-'))).toBe(true);

        // Grabación cerrada como completed; crudo_ref = storagePrefix (NO una URL).
        const rec = [...state.recordings.values()][0];
        expect(rec.status).toBe('completed');
        expect(rec.totalBytes).toBe(300);
        expect(rec.endedAt).not.toBeNull();

        tx = state.transmissions.get(`${TENANT_A}/${TX_A}`)!;
        expect(tx.status).toBe('processing');
        expect(tx.endedAt).toBeTruthy();
        expect(tx.crudoRef).toBe(prefix);
        expect(tx.crudoRef).not.toMatch(/^https?:\/\//);

        // Heartbeat disparó al menos una vez.
        expect(
            state.transmissionPatches.some((p) => p.patch.lastHeartbeatAt !== undefined),
        ).toBe(true);
    });

    it('stream caído → re-resuelve y sigue grabando en el MISMO recordingId', async () => {
        const spawner = makeSpawner();
        const { deps, state, resolverCalls } = makeDeps(spawner, (call) => ({
            url: `https://cdn.example.com/live-v${call}.m3u8`,
            kind: 'hls',
            title: null,
            platform: 'generic',
            proxy: null,
        }));

        const prefix = `${TENANT_A}/${TX_A}`;
        const handle = await startRecording(
            { tenantId: TENANT_A, transmissionId: TX_A, streamUrl: 'https://x.example.com/live' },
            { ...deps, maxRetries: 2 },
        );

        const dir = storage.publicPath(prefix);
        await writeFile(path.join(dir, segNameAt(T0 + 2_000)), Buffer.alloc(50));
        await tick(60);

        // ffmpeg muere con error → reintento: re-resuelve y respawnea.
        spawner.spawned[0].emitStderr('Connection reset by peer');
        spawner.spawned[0].close(1);
        await vi.waitFor(() => expect(spawner.spawned).toHaveLength(2));
        expect(resolverCalls).toHaveLength(2);
        // El segundo spawn usa la URL re-resuelta.
        expect(spawner.spawned[1].args).toContain('https://cdn.example.com/live-v1.m3u8');
        // La transmisión actualizó su resolved_stream_url.
        expect(state.transmissions.get(`${TENANT_A}/${TX_A}`)!.resolvedStreamUrl).toBe(
            'https://cdn.example.com/live-v1.m3u8',
        );

        nowMs = T0 + 70_000;
        await writeFile(path.join(dir, segNameAt(T0 + 72_000)), Buffer.alloc(60));
        await tick(60);
        spawner.spawned[1].close(0);
        const outcome = await handle.done;

        expect(outcome.status).toBe('completed');
        expect(outcome.segmentCount).toBe(2);
        // Mismo recordingId (reanudación = segmentos nuevos en la misma fila).
        expect(state.recordings.size).toBe(1);
        const seqs = state.segments.map((s) => s.sequence).sort();
        expect(seqs).toEqual([0, 1]);
    });

    it('stop() envía "q" a ffmpeg y cierra como completed', async () => {
        const spawner = makeSpawner();
        const { deps, state } = makeDeps(spawner, () => ({
            url: 'https://cdn.example.com/live.m3u8',
            kind: 'hls',
            title: null,
            platform: 'generic',
            proxy: null,
        }));

        const handle = await startRecording(
            { tenantId: TENANT_A, transmissionId: TX_A, streamUrl: 'https://x.example.com/live' },
            deps,
        );
        const stopPromise = handle.stop();
        await tick(30);
        expect(spawner.spawned[0].stdinWrites).toContain('q');
        spawner.spawned[0].close(0);
        await stopPromise;
        const outcome = await handle.done;
        expect(outcome.status).toBe('completed');
        expect(state.transmissions.get(`${TENANT_A}/${TX_A}`)!.status).toBe('processing');
    });

    it('ffmpeg en error terminal → status error en recording y transmisión', async () => {
        const spawner = makeSpawner();
        const { deps, state } = makeDeps(spawner, () => ({
            url: 'https://cdn.example.com/live.m3u8',
            kind: 'hls',
            title: null,
            platform: 'generic',
            proxy: null,
        }));

        const handle = await startRecording(
            { tenantId: TENANT_A, transmissionId: TX_A, streamUrl: 'https://x.example.com/live' },
            { ...deps, maxRetries: 0 },
        );
        spawner.spawned[0].emitStderr('Server returned 404');
        spawner.spawned[0].close(1);
        const outcome = await handle.done;

        expect(outcome.status).toBe('error');
        expect(outcome.errorMessage).toBeTruthy();
        const rec = [...state.recordings.values()][0];
        expect(rec.status).toBe('error');
        const tx = state.transmissions.get(`${TENANT_A}/${TX_A}`)!;
        expect(tx.status).toBe('error');
        expect(tx.errorMessage).toBeTruthy();
    });

    it('falla de resolución → rechaza y marca la transmisión en error', async () => {
        const spawner = makeSpawner();
        const { deps, state } = makeDeps(spawner, () => new Error('HTTP Error 403: Forbidden'));

        await expect(
            startRecording(
                { tenantId: TENANT_A, transmissionId: TX_A, streamUrl: 'https://x.example.com/live' },
                deps,
            ),
        ).rejects.toThrow('403');
        expect(spawner.spawned).toHaveLength(0);
        const tx = state.transmissions.get(`${TENANT_A}/${TX_A}`)!;
        expect(tx.status).toBe('error');
        expect(tx.errorMessage).toMatch(/resolver/i);
        // Nunca se creó la grabación.
        expect(state.recordings.size).toBe(0);
    });

    it('transmisión de OTRO tenant → rechaza y no toca nada', async () => {
        const spawner = makeSpawner();
        const { deps, state } = makeDeps(spawner, () => ({
            url: 'https://cdn.example.com/live.m3u8',
            kind: 'hls',
            title: null,
            platform: 'generic',
            proxy: null,
        }));

        await expect(
            startRecording(
                {
                    tenantId: '00000000-0000-4000-8000-00000000000b',
                    transmissionId: TX_A,
                    streamUrl: 'https://x.example.com/live',
                },
                deps,
            ),
        ).rejects.toThrow(/no encontrada/i);
        expect(spawner.spawned).toHaveLength(0);
        expect(state.recordings.size).toBe(0);
        // La transmisión del tenant A quedó intacta.
        expect(state.transmissions.get(`${TENANT_A}/${TX_A}`)!.status).toBe('waiting');
    });
});
