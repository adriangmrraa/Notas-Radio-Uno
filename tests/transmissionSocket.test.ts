/**
 * Tests del handshake + rooms de transmisiones (PD-04). Levantan un server
 * Socket.IO real sobre http localhost y conectan clientes reales — así se
 * verifica la autorización de verdad, no un mock.
 *
 *   - Token válido + membresía → connect y join automático a tenant:{id}.
 *   - transmission:subscribe propio → join a transmission:{id}.
 *   - transmission:subscribe ajeno → transmission:error, sin join.
 *   - transmission:unsubscribe → leave.
 *   - Sin token / token inválido → connect_error 'unauthorized'.
 *   - Un socket jamás entra a un room de tenant ajeno (no existe API para
 *     elegir tenant: el room se deriva del JWT verificado).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import {
    io as clientIo,
    type Socket as ClientSocket,
} from 'socket.io-client';

// El módulo real crea un Pool Neon (pediría DATABASE_URL): mock parcial.
vi.mock('../src/server/db/index.js', async (io) => ({
    ...(await io()),
    db: {},
}));

import {
    registerTransmissionSocketHandlers,
    type TransmissionSocketDeps,
} from '../src/server/services/transmissionSocketService';
import type { TransmissionErrorEvent } from '../src/shared/types';

const SECRET = 'socket-test-secret';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_ID = 'user-1';
const TX_OWN = 'tx-aaaa';
const TX_FOREIGN = 'tx-bbbb';

const sign = (payload: Record<string, unknown>) =>
    jwt.sign(payload, SECRET, { expiresIn: '1h' });

/** Mismo shape que `signSessionToken`: userId + activeTenantId + mirror tenantId. */
const validToken = () =>
    sign({
        userId: USER_ID,
        activeTenantId: TENANT_A,
        tenantId: TENANT_A,
        email: 'u@test.dev',
        role: 'admin',
    });

function makeDeps(
    overrides: Partial<TransmissionSocketDeps> = {},
): TransmissionSocketDeps {
    const members = new Set([`${USER_ID}/${TENANT_A}`, `${USER_ID}/${TENANT_B}`]);
    const txTenants = new Map([
        [TX_OWN, TENANT_A],
        [TX_FOREIGN, TENANT_B],
    ]);
    return {
        verifyToken: (token) => {
            try {
                return jwt.verify(token, SECRET) as {
                    userId: string;
                    activeTenantId?: string | null;
                    tenantId?: string;
                };
            } catch {
                return null;
            }
        },
        checkMembership: async (userId, tenantId) =>
            members.has(`${userId}/${tenantId}`),
        ownsTransmission: async (tenantId, transmissionId) =>
            txTenants.get(transmissionId) === tenantId,
        ...overrides,
    };
}

describe('socket.io — autenticación y rooms de transmisiones', () => {
    let httpServer: http.Server;
    let ioServer: Server;
    let port: number;
    const clients: ClientSocket[] = [];

    beforeEach(async () => {
        httpServer = http.createServer();
        ioServer = new Server(httpServer);
        registerTransmissionSocketHandlers(ioServer, makeDeps());
        await new Promise<void>((resolve) => {
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        port = (httpServer.address() as AddressInfo).port;
    });

    afterEach(async () => {
        for (const c of clients.splice(0)) c.disconnect();
        ioServer.disconnectSockets();
        await new Promise<void>((resolve) => ioServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    function openSocket(token?: string): ClientSocket {
        const c = clientIo(`http://127.0.0.1:${port}`, {
            auth: token ? { token } : {},
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
        });
        clients.push(c);
        return c;
    }

    const connected = (c: ClientSocket) =>
        new Promise<void>((resolve, reject) => {
            c.on('connect', resolve);
            c.on('connect_error', reject);
        });

    const roomCount = async (room: string) =>
        (await ioServer.in(room).fetchSockets()).length;

    it('token válido + membresía → conecta y entra a tenant:{tenantId}', async () => {
        const c = openSocket(validToken());
        await connected(c);

        await vi.waitFor(() =>
            expect(roomCount(`tenant:${TENANT_A}`)).resolves.toBe(1),
        );
        // Jamás en el tenant ajeno ni en rooms genéricos.
        expect(await roomCount(`tenant:${TENANT_B}`)).toBe(0);
        expect(await roomCount(TENANT_A)).toBe(0);
    });

    it('transmission:subscribe propio → entra a transmission:{id}', async () => {
        const c = openSocket(validToken());
        await connected(c);
        c.emit('transmission:subscribe', { transmissionId: TX_OWN });

        await vi.waitFor(() =>
            expect(roomCount(`transmission:${TX_OWN}`)).resolves.toBe(1),
        );
    });

    it('subscribe a transmisión de OTRO tenant → transmission:error, sin join', async () => {
        const c = openSocket(validToken());
        await connected(c);

        const err = new Promise<TransmissionErrorEvent>((resolve) =>
            c.on('transmission:error', resolve),
        );
        c.emit('transmission:subscribe', { transmissionId: TX_FOREIGN });

        const payload = await err;
        expect(payload.message).toBeTruthy();
        // No entró al room ni a ningún room de la transmisión ajena.
        expect(await roomCount(`transmission:${TX_FOREIGN}`)).toBe(0);
        expect(await roomCount(`tenant:${TENANT_B}`)).toBe(0);
    });

    it('transmission:unsubscribe sale del room', async () => {
        const c = openSocket(validToken());
        await connected(c);
        c.emit('transmission:subscribe', { transmissionId: TX_OWN });
        await vi.waitFor(() =>
            expect(roomCount(`transmission:${TX_OWN}`)).resolves.toBe(1),
        );

        c.emit('transmission:unsubscribe', { transmissionId: TX_OWN });
        await vi.waitFor(() =>
            expect(roomCount(`transmission:${TX_OWN}`)).resolves.toBe(0),
        );
        // Sigue en su tenant room.
        expect(await roomCount(`tenant:${TENANT_A}`)).toBe(1);
    });

    it('sin token → connect_error unauthorized', async () => {
        const c = openSocket();
        const err = await new Promise<Error>((resolve) =>
            c.on('connect_error', resolve),
        );
        expect(err.message).toBe('unauthorized');
    });

    it('token con firma inválida → connect_error unauthorized', async () => {
        const c = openSocket(sign({ sub: USER_ID, tenantId: TENANT_A }) + 'x');
        const err = await new Promise<Error>((resolve) =>
            c.on('connect_error', resolve),
        );
        expect(err.message).toBe('unauthorized');
    });

    it('token válido sin membresía en el tenant → connect_error unauthorized', async () => {
        // Cierro el io actual y levanto uno con membresías vacías.
        ioServer.disconnectSockets();
        await new Promise<void>((resolve) => ioServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));

        httpServer = http.createServer();
        ioServer = new Server(httpServer);
        registerTransmissionSocketHandlers(
            ioServer,
            makeDeps({ checkMembership: async () => false }),
        );
        await new Promise<void>((resolve) => {
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        port = (httpServer.address() as AddressInfo).port;

        const c = openSocket(validToken());
        const err = await new Promise<Error>((resolve) =>
            c.on('connect_error', resolve),
        );
        expect(err.message).toBe('unauthorized');
    });
});
