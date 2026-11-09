/**
 * Tests HTTP de la API de la Sala "En vivo" (PD-05):
 *
 *   GET  /api/live/transmissions/:id       — payload completo de la sala.
 *   POST /api/live/transmissions/:id/mark  — mark manual (clip/nota).
 *   POST /api/live/transmissions/:id/stop  — finalizar (vía FSM).
 *
 * Mismo estilo que transmissionsVodUpload.test.ts: router montado en una app
 * express efímera (listen(0) + fetch real), auth mockeado (header
 * `x-test-tenant` como stand-in del JWT), store en memoria con los mismos
 * filtros por tenant que la impl drizzle y FSM REAL vía
 * `createMemoryTransitionRunner` — un stop no puede pasar por una arista que
 * la FSM rechaza.
 *
 * Cubre el brief:
 *   - GET sin auth → 401; con auth → 200 con la forma esperada (timeline
 *     con personas resueltas + speaker labels genéricos, momentos con
 *     score/reason, clips, people con confianza).
 *   - Transmisión de otro tenant → 404 en los tres endpoints (sin leak).
 *   - POST /mark → 201: crea momento + clip 'generating' con la ventana
 *     [nowMs−window, nowMs] relativa a started_at; 'note' crea momento sin
 *     clip. Guardias: no-live → 409, sin started_at → 409.
 *   - POST /stop → 200: live→processing y waiting→canceled por la FSM real;
 *     done → 409.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de auth (mismo contrato que el resto del repo) ──────────────
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
    return { ...actual, requireAuth: fakeRequireAuth };
});

import { liveRouter, liveRouteDeps } from '../src/server/routes/live';
import type { LiveRoomStore, TranscriptSegmentRow, TransmissionMomentRow, ClipRow, StreamRecordingRow, RecordingSegmentRow } from '../src/server/services/liveRoomService';
import type { TransmissionRow } from '../src/server/services/transmissionService';
import { createMemoryTransitionRunner } from './helpers/memoryTransitionRunner';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const PROGRAM_A = '00000000-0000-4000-8000-0000000000a1';
const PERSON_A = '00000000-0000-4000-8000-0000000000c1';
const TX_LIVE = '00000000-0000-4000-8000-0000000000f1';
const TX_FOREIGN = '00000000-0000-4000-8000-0000000000f2';
const NOW = new Date('2026-03-01T12:00:00Z');
// started_at hace 90s: un mark "ahora" cae en el offset 90_000ms.
const STARTED_AT = new Date(NOW.getTime() - 90_000);

// ─── Fixtures de filas (misma forma que los $inferSelect de drizzle) ──────────

function makeTransmissionRow(over: Partial<TransmissionRow> = {}): TransmissionRow {
    return {
        id: TX_LIVE,
        tenantId: TENANT_A,
        programId: PROGRAM_A,
        scheduledTransmissionId: null,
        source: 'live_capture',
        status: 'live',
        streamUrl: 'https://www.twitch.tv/canal',
        resolvedStreamUrl: null,
        crudoRef: null,
        durationMinutes: 60,
        startedAt: STARTED_AT,
        endedAt: null,
        waitingSince: null,
        lastHeartbeatAt: null,
        errorMessage: null,
        pipelineConfig: {},
        createdAt: NOW,
        updatedAt: NOW,
        ...over,
    };
}

function makeTranscriptRow(over: Partial<TranscriptSegmentRow>): TranscriptSegmentRow {
    return {
        id: 'seg-x',
        tenantId: TENANT_A,
        transmissionId: TX_LIVE,
        startMs: 0,
        endMs: 1000,
        speakerLabel: 'Speaker A',
        personId: null,
        text: 'texto',
        confidence: null,
        createdAt: NOW,
        ...over,
    };
}

// ─── Estado + store en memoria (mismo filtro por tenant que drizzle) ──────────

interface MemoryState {
    transmissions: TransmissionRow[];
    transcriptRows: TranscriptSegmentRow[];
    momentRows: TransmissionMomentRow[];
    clipRows: ClipRow[];
    recordings: StreamRecordingRow[];
    recordingSegments: RecordingSegmentRow[];
    programsOfA: Map<string, string>;
    persons: Array<{ id: string; tenantId: string; name: string; primaryPhotoId: string | null }>;
}

function createMemoryLiveRoomStore(state: MemoryState): LiveRoomStore {
    let seq = 0;
    return {
        async findTransmission(tenantId, transmissionId) {
            // WHERE id AND tenant_id — un id ajeno NO se encuentra.
            return (
                state.transmissions.find(
                    (t) => t.id === transmissionId && t.tenantId === tenantId,
                ) ?? null
            );
        },
        async programName(tenantId, programId) {
            return tenantId === TENANT_A ? (state.programsOfA.get(programId) ?? null) : null;
        },
        async findRecording(tenantId, transmissionId) {
            return (
                state.recordings.find(
                    (r) => r.transmissionId === transmissionId && r.tenantId === tenantId,
                ) ?? null
            );
        },
        async listRecordingSegments(tenantId, recordingId) {
            return state.recordingSegments
                .filter((s) => s.recordingId === recordingId && s.tenantId === tenantId)
                .sort((a, b) => a.sequence - b.sequence);
        },
        async listTranscriptSegments(tenantId, transmissionId) {
            return state.transcriptRows
                .filter((s) => s.transmissionId === transmissionId && s.tenantId === tenantId)
                .sort((a, b) => a.startMs - b.startMs);
        },
        async listMoments(tenantId, transmissionId) {
            return state.momentRows
                .filter((m) => m.transmissionId === transmissionId && m.tenantId === tenantId)
                .sort((a, b) => a.startMs - b.startMs);
        },
        async listClips(tenantId, transmissionId) {
            return state.clipRows.filter(
                (c) => c.transmissionId === transmissionId && c.tenantId === tenantId,
            );
        },
        async findPersons(tenantId, personIds) {
            return state.persons.filter(
                (p) => p.tenantId === tenantId && personIds.includes(p.id),
            );
        },
        async insertMoment(v) {
            const row: TransmissionMomentRow = {
                id: `moment-${++seq}`,
                tenantId: v.tenantId,
                transmissionId: v.transmissionId,
                kind: v.kind,
                startMs: v.startMs,
                endMs: v.endMs,
                title: v.title,
                reason: v.reason,
                score: v.score,
                clipId: v.clipId,
                createdAt: NOW,
            };
            state.momentRows.push(row);
            return row;
        },
        async insertClip(v) {
            const row: ClipRow = {
                id: `clip-${++seq}`,
                tenantId: v.tenantId,
                transmissionId: v.transmissionId,
                programId: v.programId,
                title: v.title,
                hookText: v.hookText,
                duration: v.duration,
                status: v.status,
                audioPath: null,
                videoPath: null,
                metadata: v.metadata,
                createdAt: NOW,
            };
            state.clipRows.push(row);
            return row;
        },
    };
}

function makeState(): MemoryState {
    return {
        transmissions: [
            makeTransmissionRow(),
            // La transmisión ajena EXISTE en el estado — el 404 sale del
            // filtro por tenant, no de "no existe".
            makeTransmissionRow({ id: TX_FOREIGN, tenantId: TENANT_B }),
        ],
        transcriptRows: [
            makeTranscriptRow({
                id: 'seg-1',
                startMs: 1_000,
                endMs: 4_000,
                speakerLabel: 'Speaker A',
                personId: PERSON_A,
                text: 'hola, buen día',
                confidence: 0.92,
            }),
            makeTranscriptRow({
                id: 'seg-2',
                startMs: 4_500,
                endMs: 8_000,
                speakerLabel: 'Speaker B',
                personId: null,
                text: 'gracias por invitarme',
                confidence: 0.71,
            }),
        ],
        momentRows: [
            {
                id: 'moment-detected-1',
                tenantId: TENANT_A,
                transmissionId: TX_LIVE,
                kind: 'detected',
                startMs: 2_000,
                endMs: 32_000,
                title: 'Frase de gancho',
                reason: 'pico de energía + keyword',
                score: 0.87,
                clipId: null,
                createdAt: NOW,
            },
        ],
        clipRows: [
            {
                id: 'clip-live-1',
                tenantId: TENANT_A,
                transmissionId: TX_LIVE,
                programId: PROGRAM_A,
                title: 'Clip del vivo',
                hookText: 'gancho',
                duration: 30,
                status: 'generating',
                audioPath: null,
                videoPath: null,
                metadata: {},
                createdAt: NOW,
            },
        ],
        recordings: [],
        recordingSegments: [],
        programsOfA: new Map([[PROGRAM_A, 'Noticiero del Mediodía']]),
        persons: [
            {
                id: PERSON_A,
                tenantId: TENANT_A,
                name: 'María González',
                primaryPhotoId: null,
            },
        ],
    };
}

// ─── App efímera + deps inyectadas ────────────────────────────────────────────

let server: Server;
let baseUrl: string;
let state: MemoryState;

beforeEach(async () => {
    state = makeState();
    liveRouteDeps.store = createMemoryLiveRoomStore(state);
    liveRouteDeps.now = () => NOW;
    // FSM real sobre las filas en memoria — /stop no puede esquivar aristas.
    liveRouteDeps.transition = createMemoryTransitionRunner({
        find: (tenantId, transmissionId) =>
            state.transmissions.find(
                (t) => t.id === transmissionId && t.tenantId === tenantId,
            ),
        now: () => NOW,
    });

    const app = express();
    app.use(express.json());
    app.use('/api/live', liveRouter);
    server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
    liveRouteDeps.store = undefined;
    liveRouteDeps.transition = undefined;
    liveRouteDeps.now = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

const authHeaders = (tenant?: string) =>
    tenant ? { 'x-test-tenant': tenant } : {};

const postJson = (url: string, body: unknown, tenant?: string) =>
    fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(tenant) },
        body: JSON.stringify(body),
    });

// ─── GET /api/live/transmissions/:id ──────────────────────────────────────────

describe('GET /api/live/transmissions/:id', () => {
    it('sin autenticación → 401', async () => {
        const res = await fetch(`${baseUrl}/api/live/transmissions/${TX_LIVE}`);
        expect(res.status).toBe(401);
    });

    it('transmisión de otro tenant → 404 sin filtrar datos', async () => {
        const res = await fetch(`${baseUrl}/api/live/transmissions/${TX_FOREIGN}`, {
            headers: authHeaders(TENANT_A),
        });
        expect(res.status).toBe(404);
        const body = JSON.stringify(await res.json());
        // No leak: ni el id, ni el tenant ajeno, ni el streamUrl.
        expect(body).not.toContain(TX_FOREIGN);
        expect(body).not.toContain(TENANT_B);
        expect(body).not.toContain('twitch.tv');
    });

    it('con auth → 200 con la forma completa de la sala', async () => {
        const res = await fetch(`${baseUrl}/api/live/transmissions/${TX_LIVE}`, {
            headers: authHeaders(TENANT_A),
        });
        expect(res.status).toBe(200);
        const json = await res.json();

        // Transmisión + metadatos.
        expect(json.transmission).toMatchObject({
            id: TX_LIVE,
            status: 'live',
            source: 'live_capture',
            programId: PROGRAM_A,
            programName: 'Noticiero del Mediodía',
            durationMinutes: 60,
        });
        expect(json.transmission.startedAt).toBe(STARTED_AT.toISOString());

        // Timeline: persona resuelta en seg-1, label genérico en seg-2.
        expect(json.timeline).toHaveLength(2);
        expect(json.timeline[0]).toMatchObject({
            id: 'seg-1',
            startMs: 1_000,
            speakerLabel: 'Speaker A',
            personId: PERSON_A,
            personName: 'María González',
            text: 'hola, buen día',
            confidence: 0.92,
        });
        expect(json.timeline[1]).toMatchObject({
            speakerLabel: 'Speaker B',
            personId: null,
            personName: null,
        });

        // Momentos detectados con score/reason.
        expect(json.moments).toHaveLength(1);
        expect(json.moments[0]).toMatchObject({
            kind: 'detected',
            score: 0.87,
            reason: 'pico de energía + keyword',
        });

        // Clips de la transmisión.
        expect(json.clips).toHaveLength(1);
        expect(json.clips[0]).toMatchObject({
            id: 'clip-live-1',
            status: 'generating',
            duration: 30,
        });

        // Personas detectadas con confianza.
        expect(json.people).toHaveLength(1);
        expect(json.people[0]).toMatchObject({
            personId: PERSON_A,
            name: 'María González',
            confidence: 0.92,
        });

        // Nunca viaja la URL resuelta (posible URL firmada).
        expect(JSON.stringify(json)).not.toContain('resolvedStreamUrl');
    });
});

// ─── POST /api/live/transmissions/:id/mark ────────────────────────────────────

describe('POST /api/live/transmissions/:id/mark', () => {
    const markUrl = (id: string) => `${baseUrl}/api/live/transmissions/${id}/mark`;

    it('sin autenticación → 401', async () => {
        const res = await postJson(markUrl(TX_LIVE), { type: 'clip' });
        expect(res.status).toBe(401);
    });

    it('transmisión de otro tenant → 404', async () => {
        const res = await postJson(markUrl(TX_FOREIGN), { type: 'clip' }, TENANT_A);
        expect(res.status).toBe(404);
        expect(state.momentRows.filter((m) => m.transmissionId === TX_FOREIGN)).toHaveLength(0);
    });

    it('type inválido → 400', async () => {
        const res = await postJson(markUrl(TX_LIVE), { type: 'captura' }, TENANT_A);
        expect(res.status).toBe(400);
    });

    it("type='clip' → 201: momento 'mark' + clip 'generating' con la ventana correcta", async () => {
        const res = await postJson(
            markUrl(TX_LIVE),
            { type: 'clip', windowSeconds: 30 },
            TENANT_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();

        // nowMs = 90_000 (NOW − started_at); ventana 30s → [60_000, 90_000].
        expect(json.moment).toMatchObject({
            kind: 'mark',
            startMs: 60_000,
            endMs: 90_000,
            reason: 'mark manual',
        });
        expect(json.clip).toMatchObject({ status: 'generating', duration: 30 });
        // El momento quedó vinculado al clip.
        expect(json.moment.clipId).toBe(json.clip.id);

        // Persistidos con el tenant del token, no del body.
        const moment = state.momentRows.find((m) => m.id === json.moment.id);
        const clip = state.clipRows.find((c) => c.id === json.clip.id);
        expect(moment?.tenantId).toBe(TENANT_A);
        expect(clip?.tenantId).toBe(TENANT_A);
        expect(clip?.metadata).toMatchObject({
            origin: 'manual_mark',
            startMs: 60_000,
            endMs: 90_000,
            windowSeconds: 30,
        });
    });

    it('ventana por default (sin windowSeconds) usa 30s', async () => {
        const res = await postJson(markUrl(TX_LIVE), { type: 'clip' }, TENANT_A);
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.moment.endMs - json.moment.startMs).toBe(30_000);
    });

    it("type='note' → 201: momento 'mark' sin clip", async () => {
        const res = await postJson(
            markUrl(TX_LIVE),
            { type: 'note', title: 'Chequear este dato' },
            TENANT_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.moment).toMatchObject({
            kind: 'mark',
            title: 'Chequear este dato',
            startMs: 90_000,
            endMs: 90_000,
            clipId: null,
        });
        expect(json.clip).toBeNull();
        expect(state.clipRows.filter((c) => c.transmissionId === TX_LIVE)).toHaveLength(1);
    });

    it('transmisión no live → 409', async () => {
        state.transmissions[0].status = 'waiting';
        const res = await postJson(markUrl(TX_LIVE), { type: 'clip' }, TENANT_A);
        expect(res.status).toBe(409);
    });

    it('live sin started_at → 409 (no hay ancla temporal)', async () => {
        state.transmissions[0].startedAt = null;
        const res = await postJson(markUrl(TX_LIVE), { type: 'clip' }, TENANT_A);
        expect(res.status).toBe(409);
    });
});

// ─── POST /api/live/transmissions/:id/stop ────────────────────────────────────

describe('POST /api/live/transmissions/:id/stop', () => {
    const stopUrl = (id: string) => `${baseUrl}/api/live/transmissions/${id}/stop`;

    it('sin autenticación → 401', async () => {
        const res = await postJson(stopUrl(TX_LIVE), {});
        expect(res.status).toBe(401);
    });

    it('transmisión de otro tenant → 404 sin tocar la fila', async () => {
        const res = await postJson(stopUrl(TX_FOREIGN), {}, TENANT_A);
        expect(res.status).toBe(404);
        const foreign = state.transmissions.find((t) => t.id === TX_FOREIGN);
        expect(foreign?.status).toBe('live'); // intacta
    });

    it('live → processing por la FSM → 200', async () => {
        const res = await postJson(stopUrl(TX_LIVE), {}, TENANT_A);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.transmission.status).toBe('processing');
        expect(state.transmissions[0].status).toBe('processing');
    });

    it('waiting → canceled (nunca hubo señal) → 200', async () => {
        state.transmissions[0].status = 'waiting';
        const res = await postJson(stopUrl(TX_LIVE), {}, TENANT_A);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.transmission.status).toBe('canceled');
    });

    it('done → 409 (terminal, la FSM rechaza)', async () => {
        state.transmissions[0].status = 'done';
        const res = await postJson(stopUrl(TX_LIVE), {}, TENANT_A);
        expect(res.status).toBe(409);
        expect(state.transmissions[0].status).toBe('done');
    });
});
