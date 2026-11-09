/**
 * Tests de `transmissionService` (PD-04) — la única puerta de cambio de
 * estado de `transmissions`.
 *
 * A diferencia de los otros tests del repo (stores en memoria), acá la DB
 * es REAL: PGlite en memoria con las tablas `tenants` + `transmissions`
 * creadas con el mismo DDL de columnas/enums que el schema drizzle. Eso da
 * verificación de verdad sobre el WHERE tenant_id: una corrida de otro
 * tenant no se toca porque el UPDATE no la matchea — no porque un fake lo
 * decida.
 *
 * Cubre el brief:
 *   - Transición válida → UPDATE con tenant_id + eventos emitidos.
 *   - Inválida → no UPDATE, ok:false con motivo.
 *   - Otro tenant → "no encontrada", sin evento ni escritura.
 *   - waiting dos veces → waiting_since no se reinicia.
 *   - error → error_message seteado (y error→error lo actualiza).
 *   - El evento se emite DESPUÉS del commit (orden registrado por mocks).
 *   - Rooms: transmission:status → transmission:{id}+tenant:{id},
 *     transmission:updated → tenant:{id}; payload sin resolvedStreamUrl.
 */
import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq as pg_eq } from 'drizzle-orm';
import type { Server } from 'socket.io';

// El módulo real crea un Pool Neon (pediría DATABASE_URL): mock parcial.
vi.mock('../src/server/db/index.js', async (io) => ({
    ...(await io()),
    db: {},
}));

import * as schema from '../src/server/db/schema/index';
import { transmissions } from '../src/server/db/schema/transmissions';
import type { Database } from '../src/server/db/index.js';
import {
    computeTransitionUpdate,
    emitTransmissionEvents,
    initTransmissionService,
    transitionTransmission,
    type TransmissionRow,
} from '../src/server/services/transmissionService';
import type { TransmissionStatus } from '../src/server/db/schema/enums';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

// ─── PGlite + DDL mínima (mismas columnas/enums que el schema) ──────────────

const pglite = new PGlite();
const pg = drizzle({ client: pglite, schema });
const executor = pg as unknown as Database;

await pglite.exec(`
    CREATE TYPE "TransmissionSource" AS ENUM ('live_capture', 'vod_upload', 'manual');
    CREATE TYPE "TransmissionStatus" AS ENUM ('scheduled', 'waiting', 'live', 'processing', 'done', 'error', 'canceled');
    CREATE TABLE tenants (id uuid PRIMARY KEY);
    CREATE TABLE transmissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        program_id uuid,
        scheduled_transmission_id uuid,
        source "TransmissionSource" NOT NULL,
        status "TransmissionStatus" NOT NULL DEFAULT 'scheduled',
        stream_url text,
        resolved_stream_url text,
        crudo_ref text,
        duration_minutes integer,
        started_at timestamptz,
        ended_at timestamptz,
        waiting_since timestamptz,
        last_heartbeat_at timestamptz,
        error_message text,
        pipeline_config jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO tenants (id) VALUES ('${TENANT_A}'), ('${TENANT_B}');
`);

async function seedTx(over: {
    tenantId?: string;
    status?: TransmissionStatus;
    waitingSince?: Date | null;
    errorMessage?: string | null;
}): Promise<TransmissionRow> {
    const [row] = await pg
        .insert(transmissions)
        .values({
            tenantId: over.tenantId ?? TENANT_A,
            source: 'live_capture',
            status: over.status ?? 'scheduled',
            waitingSince: over.waitingSince ?? null,
            errorMessage: over.errorMessage ?? null,
            streamUrl: 'https://www.youtube.com/@canal',
            pipelineConfig: { tone: 'formal' },
        })
        .returning();
    return row;
}

const fresh = async (id: string) => {
    const [row] = await pg
        .select()
        .from(transmissions)
        .where(pg_eq(transmissions.id, id))
        .limit(1);
    return row;
};

// ─── Fake io para el emisor canónico ────────────────────────────────────────

interface EmitCall {
    rooms: string[];
    event: string;
    payload: Record<string, unknown>;
}

function makeFakeIo() {
    const calls: EmitCall[] = [];
    const makeTarget = (rooms: string[]) => ({
        to: (...rs: string[]) => makeTarget([...rooms, ...rs]),
        emit: (event: string, payload: Record<string, unknown>) => {
            calls.push({ rooms, event, payload });
        },
    });
    const io = {
        to: (...rs: string[]) => makeTarget(rs),
    } as unknown as Server;
    return { calls, io };
}

// ─── Transiciones válidas ───────────────────────────────────────────────────

describe('transitionTransmission — válidas', () => {
    it('scheduled → live: UPDATE con started_at + updated_at, y emite tras commit', async () => {
        const seq: string[] = [];
        const { calls, io } = makeFakeIo();
        initTransmissionService(io);

        // Executor que registra el commit: el evento debe salir DESPUÉS.
        const wrapped = new Proxy(executor, {
            get(target, prop, recv) {
                if (prop === 'transaction') {
                    return async (fn: (tx: Database) => Promise<unknown>) => {
                        const r = await (target as Database).transaction(fn);
                        seq.push('commit');
                        return r;
                    };
                }
                return Reflect.get(target, prop, recv);
            },
        }) as Database;

        const row = await seedTx({ status: 'scheduled' });
        const res = await transitionTransmission(
            { tenantId: TENANT_A, transmissionId: row.id, to: 'live' },
            {
                executor: wrapped,
                now: () => new Date(T0),
                // emit real (fakeIo) + registro estricto del orden.
                emit: (input) => {
                    seq.push('emit');
                    emitTransmissionEvents(input);
                },
            },
        );

        expect(res.ok).toBe(true);
        expect(res.transmission?.status).toBe('live');

        // La fila quedó persistida con los campos de la regla.
        const db = await fresh(row.id);
        expect(db.status).toBe('live');
        expect(db.startedAt?.getTime()).toBe(T0);
        expect(db.updatedAt.getTime()).toBe(T0);

        // Emisión después del commit, con los dos eventos y sus rooms.
        expect(seq).toEqual(['commit', 'emit']);
        expect(calls).toHaveLength(2);
        expect(calls[0].event).toBe('transmission:status');
        expect(calls[0].rooms).toEqual([
            `transmission:${row.id}`,
            `tenant:${TENANT_A}`,
        ]);
        expect(calls[0].payload).toMatchObject({
            transmissionId: row.id,
            tenantId: TENANT_A,
            status: 'live',
            previousStatus: 'scheduled',
            startedAt: new Date(T0).toISOString(),
            crudoRef: null,
            errorMessage: null,
        });
        expect(calls[1].event).toBe('transmission:updated');
        expect(calls[1].rooms).toEqual([`tenant:${TENANT_A}`]);
        expect(calls[1].payload).toMatchObject({
            id: row.id,
            status: 'live',
            streamUrl: 'https://www.youtube.com/@canal',
            startedAt: new Date(T0).toISOString(),
        });
        // El payload nunca lleva la URL resuelta (posible URL firmada).
        expect(calls[1].payload.resolvedStreamUrl).toBeUndefined();
    });

    it('patch explícito pisa las reglas automáticas (crudo_ref + ended_at)', async () => {
        const row = await seedTx({ status: 'live' });
        const custom = new Date(T0 + 3_600_000);
        const res = await transitionTransmission(
            {
                tenantId: TENANT_A,
                transmissionId: row.id,
                to: 'processing',
                patch: { endedAt: custom, crudoRef: 'tenant/tx/seg' },
            },
            { executor, emit: () => {} },
        );
        expect(res.ok).toBe(true);
        const db = await fresh(row.id);
        expect(db.status).toBe('processing');
        expect(db.endedAt?.getTime()).toBe(custom.getTime());
        expect(db.crudoRef).toBe('tenant/tx/seg');
    });
});

// ─── Transiciones inválidas ─────────────────────────────────────────────────

describe('transitionTransmission — inválidas', () => {
    it('scheduled → processing: rechazada por la FSM, sin UPDATE ni evento', async () => {
        const emit = vi.fn();
        const row = await seedTx({ status: 'scheduled' });
        const res = await transitionTransmission(
            { tenantId: TENANT_A, transmissionId: row.id, to: 'processing' },
            { executor, emit },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toBeTruthy();
        expect(res.transmission).toBeUndefined();
        expect(emit).not.toHaveBeenCalled();
        expect((await fresh(row.id)).status).toBe('scheduled');
    });

    it('done → live: terminal, rechazada', async () => {
        const row = await seedTx({ status: 'done' });
        const res = await transitionTransmission(
            { tenantId: TENANT_A, transmissionId: row.id, to: 'live' },
            { executor, emit: () => {} },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/terminal/i);
        expect((await fresh(row.id)).status).toBe('done');
    });
});

// ─── Tenant safety ──────────────────────────────────────────────────────────

describe('tenant safety', () => {
    it('corrida de otro tenant → "no encontrada", sin UPDATE ni evento', async () => {
        const emit = vi.fn();
        const foreign = await seedTx({ tenantId: TENANT_B, status: 'live' });
        const res = await transitionTransmission(
            { tenantId: TENANT_A, transmissionId: foreign.id, to: 'processing' },
            { executor, emit },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('transmisión no encontrada');
        expect(emit).not.toHaveBeenCalled();

        const db = await fresh(foreign.id);
        expect(db.status).toBe('live'); // intacta
    });

    it('id inexistente → "no encontrada"', async () => {
        const res = await transitionTransmission(
            {
                tenantId: TENANT_A,
                transmissionId: '00000000-0000-4000-8000-00000000ffff',
                to: 'live',
            },
            { executor, emit: () => {} },
        );
        expect(res.ok).toBe(false);
        expect(res.reason).toBe('transmisión no encontrada');
    });
});

// ─── waiting_since: nunca se reinicia ───────────────────────────────────────

describe('waiting_since', () => {
    it('scheduled → waiting fija el ancla; waiting → waiting es inválida y no la mueve', async () => {
        const anchor = new Date(T0);
        const row = await seedTx({ status: 'scheduled' });

        const first = await transitionTransmission(
            { tenantId: TENANT_A, transmissionId: row.id, to: 'waiting' },
            { executor, emit: () => {}, now: () => anchor },
        );
        expect(first.ok).toBe(true);
        expect((await fresh(row.id)).waitingSince?.getTime()).toBe(T0);

        // Segunda entrada a waiting: la FSM la rechaza (waiting→waiting no
        // es arista) y el ancla queda intacta.
        const second = await transitionTransmission(
            { tenantId: TENANT_A, transmissionId: row.id, to: 'waiting' },
            { executor, emit: () => {}, now: () => new Date(T0 + 999_000) },
        );
        expect(second.ok).toBe(false);
        expect((await fresh(row.id)).waitingSince?.getTime()).toBe(T0);
    });

    it('computeTransitionUpdate no pisa un waiting_since ya fijado', () => {
        const set = computeTransitionUpdate({
            currentStatus: 'waiting',
            currentWaitingSince: new Date(T0),
            to: 'waiting',
            now: new Date(T0 + 60_000),
        });
        expect(set.waitingSince).toBeUndefined();

        const nullAnchor = computeTransitionUpdate({
            currentStatus: 'scheduled',
            currentWaitingSince: null,
            to: 'waiting',
            now: new Date(T0 + 60_000),
        });
        expect(nullAnchor.waitingSince?.getTime()).toBe(T0 + 60_000);
    });
});

// ─── error: mensaje y auto-transición ───────────────────────────────────────

describe('transiciones a error', () => {
    it('live → error setea error_message y ended_at', async () => {
        const row = await seedTx({ status: 'live' });
        const res = await transitionTransmission(
            {
                tenantId: TENANT_A,
                transmissionId: row.id,
                to: 'error',
                errorMessage: 'ffmpeg murió',
            },
            { executor, emit: () => {}, now: () => new Date(T0) },
        );
        expect(res.ok).toBe(true);
        const db = await fresh(row.id);
        expect(db.status).toBe('error');
        expect(db.errorMessage).toBe('ffmpeg murió');
        expect(db.endedAt?.getTime()).toBe(T0);
    });

    it('error → error actualiza el mensaje (auto-transición permitida)', async () => {
        const row = await seedTx({ status: 'error', errorMessage: 'primer error' });
        const res = await transitionTransmission(
            {
                tenantId: TENANT_A,
                transmissionId: row.id,
                to: 'error',
                errorMessage: 'detalle nuevo del error',
            },
            { executor, emit: () => {} },
        );
        expect(res.ok).toBe(true);
        expect((await fresh(row.id)).errorMessage).toBe('detalle nuevo del error');
    });

    it('done → done rechazada (terminal + idéntica)', async () => {
        const row = await seedTx({ status: 'done' });
        const res = await transitionTransmission(
            { tenantId: TENANT_A, transmissionId: row.id, to: 'done' },
            { executor, emit: () => {} },
        );
        expect(res.ok).toBe(false);
    });
});

// ─── Emisor canónico ────────────────────────────────────────────────────────

describe('emitTransmissionEvents', () => {
    it('emite transmission:status a ambos rooms y transmission:updated al tenant', () => {
        const { calls, io } = makeFakeIo();
        initTransmissionService(io);
        const row = {
            id: 'tx-1',
            tenantId: TENANT_A,
            programId: null,
            scheduledTransmissionId: null,
            source: 'manual',
            status: 'done',
            streamUrl: null,
            resolvedStreamUrl: 'https://cdn.firmada/seg?sig=abc',
            crudoRef: 't/tx-1',
            durationMinutes: 30,
            startedAt: new Date(T0),
            endedAt: new Date(T0 + 1_800_000),
            waitingSince: null,
            lastHeartbeatAt: null,
            errorMessage: null,
            pipelineConfig: {},
            createdAt: new Date(T0),
            updatedAt: new Date(T0 + 1_800_000),
        } as unknown as TransmissionRow;

        emitTransmissionEvents({
            tenantId: TENANT_A,
            transmission: row,
            previousStatus: 'processing',
        });

        expect(calls).toHaveLength(2);
        expect(calls[0].rooms).toEqual(['transmission:tx-1', `tenant:${TENANT_A}`]);
        expect(calls[0].event).toBe('transmission:status');
        expect(calls[0].payload.previousStatus).toBe('processing');
        expect(calls[0].payload.endedAt).toBe(new Date(T0 + 1_800_000).toISOString());
        expect(calls[1].rooms).toEqual([`tenant:${TENANT_A}`]);
        expect(calls[1].event).toBe('transmission:updated');
        expect(calls[1].payload.resolvedStreamUrl).toBeUndefined();
    });
});
