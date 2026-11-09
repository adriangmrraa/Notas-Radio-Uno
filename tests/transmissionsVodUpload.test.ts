/**
 * Tests HTTP de los endpoints PD-07 (Partes B, C y D):
 *
 *   POST /api/transmissions/vod-upload · GET /api/transmissions/sources ·
 *   POST /api/transmissions/start-live
 *
 * El router se monta en una app express efímera (listen(0) + fetch real —
 * no hay suite HTTP previa en el repo, así que el test ES la primera).
 * Hermético igual que el resto de los tests: auth mockeado (401 sin sesión,
 * tenant del header `x-test-tenant` como stand-in del JWT), stores en
 * memoria con los mismos filtros por tenant que drizzle, RawStorage real
 * sobre tmpdir, probe de video falso (sin ffprobe) y fetch falso para
 * `vodUrl` (sin red).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ─── Mock parcial de auth (mismo estilo que el resto del repo) ────────────────
// El fake de requireAuth reproduce el contrato real: sin sesión → 401; con
// sesión → req.auth.tenantId/activeTenantId del tenant activo. La sesión se
// simula con el header `x-test-tenant` (stand-in del JWT verificado).
// requireActiveSubscription pasa: el gate está cableado en la ruta y lo que
// se testea acá es el comportamiento del endpoint, no la tabla subscriptions.
vi.mock('../src/server/middleware/auth.js', async (io) => {
    const actual = await io<typeof import('../src/server/middleware/auth.js')>();
    const fakeRequireAuth = (req: Request, res: Response, next: NextFunction): void => {
        const tenant = req.headers['x-test-tenant'];
        if (typeof tenant !== 'string' || tenant.length === 0) {
            res.status(401).json({ error: 'Token de autenticacion requerido' });
            return;
        }
        req.auth = {
            userId: '00000000-0000-4000-8000-000000000011',
            activeTenantId: tenant,
            tenantId: tenant,
            email: 'test@example.com',
            role: 'owner',
        };
        next();
    };
    return {
        ...actual,
        requireAuth: fakeRequireAuth,
        requireActiveSubscription: (_req: Request, _res: Response, next: NextFunction) => next(),
    };
});

import { transmissionsRouter, transmissionsRouteDeps } from '../src/server/routes/transmissions';
import { FilesystemRawStorage } from '../src/server/services/rawStorageService';
import type { TransmissionRow } from '../src/server/services/transmissionService';
import type {
    VodBundleInsert,
    VodUploadStore,
} from '../src/server/services/vodUploadService';
import type { StartLiveStore } from '../src/server/services/startLiveService';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_EVIL = '00000000-0000-4000-8000-0000000000ee';
const PROGRAM_A = '00000000-0000-4000-8000-0000000000a1';
const PROGRAM_FOREIGN = '00000000-0000-4000-8000-0000000000b1'; // de otro tenant
const TX_ID = '00000000-0000-4000-8000-0000000000f1';
const NOW = new Date('2026-03-01T12:00:00Z');

// ─── Stores en memoria (mismo filtro por tenant que la impl drizzle) ──────────

interface MemoryVodState {
    programsOfA: Set<string>;
    bundles: VodBundleInsert[];
    recordings: Array<{ id: string; tenantId: string; transmissionId: string; storagePrefix: string; status: string; totalBytes: number }>;
    segments: Array<{ tenantId: string; recordingId: string; sequence: number; startMs: number; endMs: number | null; fileRef: string; bytes: number; status: string }>;
}

function makeTransmissionRow(v: {
    id: string;
    tenantId: string;
    programId: string | null;
    scheduledTransmissionId?: string | null;
    source: TransmissionRow['source'];
    status: TransmissionRow['status'];
    streamUrl: string | null;
    crudoRef?: string | null;
    durationMinutes?: number | null;
    startedAt?: Date | null;
    waitingSince?: Date | null;
    pipelineConfig?: unknown;
}): TransmissionRow {
    return {
        id: v.id,
        tenantId: v.tenantId,
        programId: v.programId,
        scheduledTransmissionId: v.scheduledTransmissionId ?? null,
        source: v.source,
        status: v.status,
        streamUrl: v.streamUrl,
        resolvedStreamUrl: null,
        crudoRef: v.crudoRef ?? null,
        durationMinutes: v.durationMinutes ?? null,
        startedAt: v.startedAt ?? null,
        endedAt: null,
        waitingSince: v.waitingSince ?? null,
        lastHeartbeatAt: null,
        errorMessage: null,
        pipelineConfig: v.pipelineConfig ?? {},
        createdAt: NOW,
        updatedAt: NOW,
    };
}

function createMemoryVodStore(state: MemoryVodState): VodUploadStore {
    let recSeq = 0;
    return {
        async programBelongsToTenant(tenantId, programId) {
            // Misma regla que drizzle: WHERE tenant_id AND id — un programa
            // ajeno NO se encuentra (el caller lo traduce a 404).
            return tenantId === TENANT_A && state.programsOfA.has(programId);
        },
        async createVodBundle(v) {
            // Replica el bundle atómico: recording + 1 segmento.
            state.bundles.push(v);
            const recId = `rec-${++recSeq}`;
            state.recordings.push({
                id: recId,
                tenantId: v.tenantId,
                transmissionId: v.transmissionId,
                storagePrefix: v.storagePrefix,
                status: 'completed',
                totalBytes: v.bytes,
            });
            state.segments.push({
                tenantId: v.tenantId,
                recordingId: recId,
                sequence: 0,
                startMs: 0,
                endMs: v.endMs,
                fileRef: v.fileRef,
                bytes: v.bytes,
                status: 'active',
            });
            return makeTransmissionRow({
                id: v.transmissionId,
                tenantId: v.tenantId,
                programId: v.programId,
                source: 'vod_upload',
                status: 'processing',
                streamUrl: v.streamUrl,
                crudoRef: v.storagePrefix,
                durationMinutes: v.durationMinutes,
                startedAt: v.startedAt,
                pipelineConfig: v.name != null ? { name: v.name } : {},
            });
        },
    };
}

function createMemoryStartLiveStore(state: MemoryVodState): StartLiveStore & {
    runs: Array<{ tenantId: string; streamUrl: string; status: string }>;
} {
    const runs: Array<{ tenantId: string; streamUrl: string; status: string }> = [];
    return {
        runs,
        async programBelongsToTenant(tenantId, programId) {
            return tenantId === TENANT_A && state.programsOfA.has(programId);
        },
        async findScheduled() {
            return null; // sin agendas en estos tests
        },
        async createLiveRun(v) {
            runs.push({ tenantId: v.tenantId, streamUrl: v.streamUrl, status: 'waiting' });
            return makeTransmissionRow({
                id: TX_ID,
                tenantId: v.tenantId,
                programId: v.programId,
                scheduledTransmissionId: v.scheduledTransmissionId,
                source: 'live_capture',
                status: 'waiting',
                streamUrl: v.streamUrl,
                durationMinutes: v.durationMinutes,
                startedAt: v.startedAt,
                waitingSince: v.waitingSince,
            });
        },
    };
}

// ─── App efímera + deps inyectadas ────────────────────────────────────────────

let server: Server;
let baseUrl: string;
let storageRoot: string;
let vodState: MemoryVodState;
let vodStore: VodUploadStore;
let startLiveStore: ReturnType<typeof createMemoryStartLiveStore>;
let probeBehavior: 'video' | 'no-video' | 'unavailable' = 'video';

function vodForm(fields: Record<string, string | { data: Uint8Array; name: string }>): FormData {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
        if (typeof value === 'string') {
            form.append(key, value);
        } else {
            form.append(key, new Blob([value.data]), value.name);
        }
    }
    return form;
}

const VIDEO_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // firma ftyp mp4

async function postVodUpload(form: FormData, tenant?: string) {
    return fetch(`${baseUrl}/api/transmissions/vod-upload`, {
        method: 'POST',
        headers: tenant ? { 'x-test-tenant': tenant } : {},
        body: form,
    });
}

beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(tmpdir(), 'vod-upload-test-'));
    vodState = {
        programsOfA: new Set([PROGRAM_A]),
        bundles: [],
        recordings: [],
        segments: [],
    };
    vodStore = createMemoryVodStore(vodState);
    startLiveStore = createMemoryStartLiveStore(vodState);
    probeBehavior = 'video';

    transmissionsRouteDeps.vodUpload = {
        store: vodStore,
        storage: new FilesystemRawStorage(storageRoot),
        probeVideo: async () =>
            probeBehavior === 'unavailable'
                ? null
                : { hasVideo: probeBehavior === 'video', durationMs: 60_000 },
        now: () => NOW,
        newId: () => TX_ID,
    };
    transmissionsRouteDeps.startLive = { store: startLiveStore, now: () => NOW };

    const app = express();
    app.use(express.json());
    app.use('/api/transmissions', transmissionsRouter);
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    transmissionsRouteDeps.vodUpload = {};
    transmissionsRouteDeps.startLive = {};
    // fetch usa keep-alive: hay que cortar los sockets o close() espera.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storageRoot, { recursive: true, force: true });
});

// ─── POST /vod-upload ─────────────────────────────────────────────────────────

describe('POST /api/transmissions/vod-upload', () => {
    it('sin autenticación → 401', async () => {
        const res = await postVodUpload(
            vodForm({ file: { data: VIDEO_BYTES, name: 'programa.mp4' } }),
        );
        expect(res.status).toBe(401);
        expect(vodState.bundles).toHaveLength(0);
    });

    it('sin archivo ni vodUrl → 400', async () => {
        const res = await postVodUpload(vodForm({ programId: PROGRAM_A }), TENANT_A);
        expect(res.status).toBe(400);
    });

    it('extensión no soportada → 400', async () => {
        const res = await postVodUpload(
            vodForm({ file: { data: VIDEO_BYTES, name: 'documento.txt' } }),
            TENANT_A,
        );
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/extensión/i);
        expect(vodState.bundles).toHaveLength(0);
    });

    it('programId de otro tenant → 404 (no revela existencia)', async () => {
        const res = await postVodUpload(
            vodForm({
                file: { data: VIDEO_BYTES, name: 'programa.mp4' },
                programId: PROGRAM_FOREIGN,
            }),
            TENANT_A,
        );
        expect(res.status).toBe(404);
        expect(vodState.bundles).toHaveLength(0);
    });

    it('upload válido → 201 con source vod_upload y bundle completo', async () => {
        const res = await postVodUpload(
            vodForm({
                file: { data: VIDEO_BYTES, name: 'programa.mp4' },
                programId: PROGRAM_A,
                durationMinutes: '60',
                name: 'Programa del mediodía',
            }),
            TENANT_A,
        );
        expect(res.status).toBe(201);

        const json = await res.json();
        expect(json.transmission.source).toBe('vod_upload');
        expect(json.transmission.status).toBe('processing');
        expect(json.transmission.tenantId).toBe(TENANT_A);
        expect(json.transmission.streamUrl).toBe('vod://upload/programa.mp4');
        expect(json.transmission.crudoRef).toBe(`${TENANT_A}/${TX_ID}`);
        expect(json.transmission.durationMinutes).toBe(60);
        expect(json.transmission.pipelineConfig).toEqual({ name: 'Programa del mediodía' });

        // Bundle atómico: recording + segment existen y son coherentes.
        expect(vodState.bundles).toHaveLength(1);
        expect(vodState.recordings).toHaveLength(1);
        expect(vodState.recordings[0]).toMatchObject({
            tenantId: TENANT_A,
            transmissionId: TX_ID,
            storagePrefix: `${TENANT_A}/${TX_ID}`,
            status: 'completed',
            totalBytes: VIDEO_BYTES.length,
        });
        expect(vodState.segments).toHaveLength(1);
        expect(vodState.segments[0]).toMatchObject({
            tenantId: TENANT_A,
            sequence: 0,
            startMs: 0,
            endMs: 60 * 60_000,
            fileRef: 'vod/seg-00001.mp4',
            bytes: VIDEO_BYTES.length,
        });

        // El archivo quedó copiado en storage con la key relativa.
        const storage = new FilesystemRawStorage(storageRoot);
        expect(existsSync(storage.publicPath(`${TENANT_A}/${TX_ID}/vod/seg-00001.mp4`))).toBe(true);
    });

    it('el tenantId del body se IGNORA: la fila usa el tenant del token', async () => {
        const res = await postVodUpload(
            vodForm({
                file: { data: VIDEO_BYTES, name: 'programa.mp4' },
                tenantId: TENANT_EVIL,
            }),
            TENANT_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.transmission.tenantId).toBe(TENANT_A);
        expect(vodState.bundles[0].tenantId).toBe(TENANT_A);
    });

    it('ffprobe sin pista de video → 400', async () => {
        probeBehavior = 'no-video';
        const res = await postVodUpload(
            vodForm({ file: { data: VIDEO_BYTES, name: 'audio.mp4' } }),
            TENANT_A,
        );
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/video/i);
        expect(vodState.bundles).toHaveLength(0);
    });

    it('ffprobe no disponible → 201 igual (fallback extensión+tamaño)', async () => {
        probeBehavior = 'unavailable';
        const res = await postVodUpload(
            vodForm({ file: { data: VIDEO_BYTES, name: 'programa.mp4' } }),
            TENANT_A,
        );
        expect(res.status).toBe(201);
        expect(vodState.bundles).toHaveLength(1);
    });

    it('vodUrl descarga el archivo a un temporal y lo ingiere → 201', async () => {
        const fakeBody = new ReadableStream({
            start(controller) {
                controller.enqueue(VIDEO_BYTES);
                controller.close();
            },
        });
        transmissionsRouteDeps.vodUpload.fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-length': String(VIDEO_BYTES.length),
                'content-type': 'video/mp4',
            }),
            body: fakeBody,
        })) as unknown as typeof fetch;

        const res = await postVodUpload(
            vodForm({ vodUrl: 'https://media.example.com/programa.mp4' }),
            TENANT_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.transmission.streamUrl).toBe('vod://upload/programa.mp4');
        expect(vodState.segments[0].fileRef).toBe('vod/seg-00001.mp4');
    });
});

// ─── GET /sources ─────────────────────────────────────────────────────────────

describe('GET /api/transmissions/sources', () => {
    it('sin autenticación → 401', async () => {
        const res = await fetch(`${baseUrl}/api/transmissions/sources`);
        expect(res.status).toBe(401);
    });

    it('devuelve el registry serializado con sus capacidades', async () => {
        const res = await fetch(`${baseUrl}/api/transmissions/sources`, {
            headers: { 'x-test-tenant': TENANT_A },
        });
        expect(res.status).toBe(200);
        const json = await res.json();

        const byKind = new Map(json.items.map((i: { kind: string }) => [i.kind, i]));
        expect([...byKind.keys()].sort()).toEqual(['hls', 'kick', 'twitch', 'upload', 'youtube']);
        expect(byKind.get('youtube')).toMatchObject({ needsResolver: true, supportsLive: true });
        expect(byKind.get('hls')).toMatchObject({ needsResolver: false, supportsLive: true });
        expect(byKind.get('upload')).toMatchObject({ needsResolver: false, supportsLive: false });
        // Sin datos de tenant ni rutas internas.
        expect(JSON.stringify(json)).not.toContain(TENANT_A);
    });
});

// ─── POST /start-live ─────────────────────────────────────────────────────────

describe('POST /api/transmissions/start-live', () => {
    async function postStartLive(body: unknown, tenant?: string) {
        return fetch(`${baseUrl}/api/transmissions/start-live`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(tenant ? { 'x-test-tenant': tenant } : {}),
            },
            body: JSON.stringify(body),
        });
    }

    it('sin autenticación → 401', async () => {
        const res = await postStartLive({ streamUrl: 'https://www.twitch.tv/canal' });
        expect(res.status).toBe(401);
    });

    it('crea la corrida live_capture/waiting → 201 (sin grabar en la request)', async () => {
        const res = await postStartLive(
            { streamUrl: 'https://www.twitch.tv/canal', programId: PROGRAM_A },
            TENANT_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.transmission.source).toBe('live_capture');
        expect(json.transmission.status).toBe('waiting');
        expect(json.transmission.tenantId).toBe(TENANT_A);
        expect(json.transmission.waitingSince).not.toBeNull();
        expect(startLiveStore.runs).toHaveLength(1);
        expect(startLiveStore.runs[0].streamUrl).toBe('https://www.twitch.tv/canal');
    });

    it('fuente upload → 400 (no se captura live de un archivo)', async () => {
        const res = await postStartLive({ streamUrl: 'programa.mp4' }, TENANT_A);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/vod-upload|upload/i);
        expect(startLiveStore.runs).toHaveLength(0);
    });

    it('sin streamUrl → 400', async () => {
        const res = await postStartLive({}, TENANT_A);
        expect(res.status).toBe(400);
    });

    it('programId de otro tenant → 404', async () => {
        const res = await postStartLive(
            { streamUrl: 'https://kick.com/canal', programId: PROGRAM_FOREIGN },
            TENANT_A,
        );
        expect(res.status).toBe(404);
        expect(startLiveStore.runs).toHaveLength(0);
    });
});
