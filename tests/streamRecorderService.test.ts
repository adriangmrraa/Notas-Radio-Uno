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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FilesystemRawStorage } from '../src/server/services/rawStorageService';
import type { notify } from '../src/server/services/notificationService';
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
        const notifyCalls: Array<Record<string, unknown>> = [];
        const deps = {
            store,
            storage,
            resolver,
            spawnProcess: spawned.spawnProcess,
            probeDuration: null,
            heartbeatMs: 5,
            pollMs: 5,
            stopGraceMs: 50,
            // Watchdog apagado por defecto: los tests de este bloque saltan el
            // reloj inyectado a mano y un stall de 30 s se dispararía solo.
            // Los tests del watchdog lo habilitan explícitamente.
            stallTimeoutMs: 0,
            // notifyFn fake: registra las notificaciones de ingesta (PI-04)
            // sin tocar la tabla notifications.
            notifyFn: (async (p: Record<string, unknown>) => {
                notifyCalls.push(p);
                return {} as never;
            }) as typeof notify,
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
        return { deps, store, state, resolverCalls, notifyCalls };
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

    describe('watchdog de estancamiento (PI-04)', () => {
        it('ffmpeg colgado sin output ni segmentos nuevos → lo mata y reintenta en el MISMO recordingId', async () => {
            const spawner = makeSpawner();
            const { deps, state, resolverCalls } = makeDeps(spawner, (call) => ({
                url: `https://cdn.example.com/live-v${call}.m3u8`,
                kind: 'hls',
                title: null,
                platform: 'generic',
                proxy: null,
            }));

            const handle = await startRecording(
                {
                    tenantId: TENANT_A,
                    transmissionId: TX_A,
                    streamUrl: 'https://x.example.com/live',
                    storagePrefix: `${TENANT_A}/${TX_A}`,
                },
                { ...deps, stallTimeoutMs: 100 },
            );

            // Progreso real (un segmento) para fijar el baseline del watchdog.
            const dir = storage.publicPath(`${TENANT_A}/${TX_A}`);
            await writeFile(path.join(dir, segNameAt(T0 + 2_000)), Buffer.alloc(50));
            await tick(30);
            expect(spawner.spawned[0].kills).toHaveLength(0);

            // El reloj salta sin más progreso → stall: SIGTERM y luego SIGKILL.
            nowMs = T0 + 5_000;
            await vi.waitFor(() => {
                expect(spawner.spawned[0].kills).toContain('SIGTERM');
            });
            await vi.waitFor(() => {
                expect(spawner.spawned[0].kills).toContain('SIGKILL');
            });

            // El proceso muere y el servicio reintenta — MISMO recordingId.
            spawner.spawned[0].close(null, 'SIGKILL');
            await vi.waitFor(() => expect(spawner.spawned).toHaveLength(2));
            expect(resolverCalls).toHaveLength(2);
            expect(state.recordings.size).toBe(1);

            // El segundo intento cierra bien → completed.
            spawner.spawned[1].close(0);
            const outcome = await handle.done;
            expect(outcome.status).toBe('completed');
        });

        it('output en stderr cuenta como progreso — no mata mientras el proceso habla', async () => {
            const spawner = makeSpawner();
            const { deps } = makeDeps(spawner, () => ({
                url: 'https://cdn.example.com/live.m3u8',
                kind: 'hls',
                title: null,
                platform: 'generic',
                proxy: null,
            }));

            const handle = await startRecording(
                {
                    tenantId: TENANT_A,
                    transmissionId: TX_A,
                    streamUrl: 'https://x.example.com/live',
                    storagePrefix: `${TENANT_A}/${TX_A}`,
                },
                { ...deps, stallTimeoutMs: 120 },
            );

            // 60 ms sin nada — todavía dentro del umbral.
            nowMs = T0 + 60;
            await tick(30);
            spawner.spawned[0].emitStderr('frame= 120');
            // 90 ms desde el último progreso — sigue vivo.
            nowMs = T0 + 150;
            await tick(40);
            expect(spawner.spawned[0].kills).toHaveLength(0);

            // 240 ms desde el último stderr → stall.
            nowMs = T0 + 300;
            await vi.waitFor(() => {
                expect(spawner.spawned[0].kills).toContain('SIGTERM');
            });
            spawner.spawned[0].close(null, 'SIGKILL');
            await vi.waitFor(() => expect(spawner.spawned).toHaveLength(2));

            const stop = handle.stop();
            await tick(5);
            expect(spawner.spawned[1].stdinWrites).toContain('q');
            spawner.spawned[1].close(0);
            await stop;
            const outcome = await handle.done;
            expect(outcome.status).toBe('completed');
        });

        it('stall con reintentos agotados → grabación error, segmento abierto cerrado, notify al tenant', async () => {
            const spawner = makeSpawner();
            const { deps, state, notifyCalls } = makeDeps(spawner, () => ({
                url: 'https://cdn.example.com/live.m3u8',
                kind: 'hls',
                title: null,
                platform: 'generic',
                proxy: null,
            }));

            const handle = await startRecording(
                {
                    tenantId: TENANT_A,
                    transmissionId: TX_A,
                    streamUrl: 'https://x.example.com/live',
                    storagePrefix: `${TENANT_A}/${TX_A}`,
                },
                { ...deps, stallTimeoutMs: 60, maxRetries: 0 },
            );

            const dir = storage.publicPath(`${TENANT_A}/${TX_A}`);
            await writeFile(path.join(dir, segNameAt(T0 + 1_000)), Buffer.alloc(80));
            await tick(30);
            expect(state.segments).toHaveLength(1);

            nowMs = T0 + 5_000;
            await vi.waitFor(() => {
                expect(spawner.spawned[0].kills).toContain('SIGTERM');
            });
            spawner.spawned[0].close(1, 'SIGTERM');

            const outcome = await handle.done;
            expect(outcome.status).toBe('error');
            expect(outcome.errorMessage).toContain('estancado');

            // Recording terminal + segmento abierto cerrado + corrida en error vía FSM.
            expect(state.recordings.get(`${TENANT_A}/${handle.recordingId}`)!.status).toBe('error');
            expect(state.segments[0].endMs).toBe(T0 + 5_000 - T0);
            expect(state.transmissions.get(`${TENANT_A}/${TX_A}`)!.status).toBe('error');
            expect(notifyCalls.some((n) => n.type === 'ingest_recording_failed' && n.tenantId === TENANT_A)).toBe(true);
        });

        it('si el proceso no reporta muerte tras SIGKILL, la salida forzada cuenta el intento como fallido', async () => {
            const spawner = makeSpawner();
            const { deps } = makeDeps(spawner, (call) => ({
                url: `https://cdn.example.com/live-v${call}.m3u8`,
                kind: 'hls',
                title: null,
                platform: 'generic',
                proxy: null,
            }));

            const handle = await startRecording(
                {
                    tenantId: TENANT_A,
                    transmissionId: TX_A,
                    streamUrl: 'https://x.example.com/live',
                    storagePrefix: `${TENANT_A}/${TX_A}`,
                },
                { ...deps, stallTimeoutMs: 60, stopGraceMs: 20 },
            );

            nowMs = T0 + 5_000;
            // Sin close() del lado del proceso: los timers SIGTERM(20) →
            // SIGKILL(40) → salida forzada empujan el retry igual.
            await vi.waitFor(() => {
                expect(spawner.spawned[0].kills).toContain('SIGKILL');
            });
            await vi.waitFor(() => expect(spawner.spawned).toHaveLength(2));

            spawner.spawned[1].close(0);
            const outcome = await handle.done;
            expect(outcome.status).toBe('completed');
        });
    });

    describe('reanudación de captura sobre la misma grabación (PI-04)', () => {
        it('mismo recordingId y ancla original: segmentos previos intactos, gap entre end_ms y el nuevo start_ms', async () => {
            const spawner = makeSpawner();
            const { deps, store, state } = makeDeps(spawner, () => ({
                url: 'https://cdn.example.com/live.m3u8',
                kind: 'hls',
                title: null,
                platform: 'generic',
                proxy: null,
            }));

            // Grabación huérfana: arrancó hace 10 min, quedó 'interrupted' con
            // 2 segmentos comiteados y un archivo en disco sin fila (crash
            // entre el write y el INSERT).
            const startedAt0 = new Date(T0 - 10 * 60_000);
            const { id: recId } = await store.createRecording({
                tenantId: TENANT_A,
                transmissionId: TX_A,
                storagePrefix: `${TENANT_A}/${TX_A}`,
                startedAt: startedAt0,
            });
            state.recordings.get(`${TENANT_A}/${recId}`)!.status = 'interrupted';
            state.recordings.get(`${TENANT_A}/${recId}`)!.endedAt = new Date(T0 - 60_000);
            state.segments.push(
                {
                    tenantId: TENANT_A,
                    recordingId: recId,
                    sequence: 0,
                    startMs: 5_000,
                    endMs: 65_000,
                    fileRef: segNameAt(T0 - 10 * 60_000 + 5_000),
                    bytes: 100,
                },
                {
                    tenantId: TENANT_A,
                    recordingId: recId,
                    sequence: 1,
                    startMs: 65_000,
                    endMs: 540_000,
                    fileRef: segNameAt(T0 - 60_000),
                    bytes: 200,
                },
            );
            const dir = storage.publicPath(`${TENANT_A}/${TX_A}`);
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, segNameAt(T0 - 10 * 60_000 + 5_000)), Buffer.alloc(100));
            await writeFile(path.join(dir, segNameAt(T0 - 60_000)), Buffer.alloc(200));
            // El archivo no comiteado: existe en disco, sin fila.
            await writeFile(path.join(dir, segNameAt(T0 - 30_000)), Buffer.alloc(300));

            // La corrida sigue live (cayó el proceso, no la transmisión).
            state.transmissions.get(`${TENANT_A}/${TX_A}`)!.status = 'live';

            const handle = await startRecording(
                {
                    tenantId: TENANT_A,
                    transmissionId: TX_A,
                    streamUrl: 'https://x.example.com/live',
                    storagePrefix: `${TENANT_A}/${TX_A}`,
                    resume: {
                        recordingId: recId,
                        startedAt: startedAt0,
                        nextSequence: 2,
                    },
                },
                deps,
            );

            // MISMA fila, de vuelta a recording, ancla original.
            expect(handle.recordingId).toBe(recId);
            expect(state.recordings.size).toBe(1);
            const rec = state.recordings.get(`${TENANT_A}/${recId}`)!;
            expect(rec.status).toBe('recording');
            expect(rec.endedAt).toBeNull();
            expect(rec.startedAt.getTime()).toBe(startedAt0.getTime());

            // El archivo no comiteado se recupera como sequence 2.
            await vi.waitFor(() => expect(state.segments).toHaveLength(3));
            const recovered = state.segments.find((s) => s.sequence === 2)!;
            expect(recovered.startMs).toBe(T0 - 30_000 - startedAt0.getTime());

            // Un segmento nuevo del intento reanudado: sequence 3, offset
            // anclado al started_at ORIGINAL (el hueco quedó explícito).
            await writeFile(path.join(dir, segNameAt(T0 + 5_000)), Buffer.alloc(60));
            await vi.waitFor(() => expect(state.segments).toHaveLength(4));
            const seg3 = state.segments.find((s) => s.sequence === 3)!;
            expect(seg3.startMs).toBe(T0 + 5_000 - startedAt0.getTime());

            // Segmentos previos intactos — no se re-insertaron ni se tocó endMs.
            expect(state.segments.find((s) => s.sequence === 0)!.endMs).toBe(65_000);
            expect(state.segments.find((s) => s.sequence === 1)!.endMs).toBe(540_000);

            // La transmisión NO se re-ancló: ningún patch tocó started_at.
            expect(
                state.transmissionPatches.every((p) => p.patch.startedAt === undefined),
            ).toBe(true);

            spawner.spawned[0].close(0);
            const outcome = await handle.done;
            expect(outcome.status).toBe('completed');
            expect(outcome.segmentCount).toBe(4);
        });

        it('resume sobre recordingId inexistente → falla antes de spawnear nada', async () => {
            const spawner = makeSpawner();
            const { deps, state } = makeDeps(spawner, () => ({
                url: 'https://cdn.example.com/live.m3u8',
                kind: 'hls',
                title: null,
                platform: 'generic',
                proxy: null,
            }));
            state.transmissions.set(`${TENANT_A}/tx-huérfana`, {
                id: 'tx-huérfana',
                tenantId: TENANT_A,
                status: 'live',
                durationMinutes: null,
            });

            await expect(
                startRecording(
                    {
                        tenantId: TENANT_A,
                        transmissionId: 'tx-huérfana',
                        streamUrl: 'https://x.example.com/live',
                        storagePrefix: `${TENANT_A}/tx-huérfana`,
                        resume: {
                            recordingId: 'rec-que-no-existe',
                            startedAt: new Date(T0 - 60_000),
                            nextSequence: 3,
                        },
                    },
                    deps,
                ),
            ).rejects.toThrow('no existe');
            expect(spawner.spawned).toHaveLength(0);
        });
    });
});
