/**
 * transmissionSocketService — autenticación y rooms Socket.IO por tenant
 * (PD-04).
 *
 * Rooms:
 *   - `tenant:{tenantId}`     — el cliente entra automáticamente al conectar;
 *                               el tenant sale del JWT verificado, NUNCA del
 *                               cliente.
 *   - `transmission:{id}`     — el cliente lo pide con `transmission:subscribe`
 *                               y sólo se une si la transmisión pertenece a
 *                               SU tenant (query tenant-safe). Un room de
 *                               transmisión ajeno nunca se puede unir.
 *
 * Autenticación del handshake: `socket.handshake.auth.token` debe ser un JWT
 * de sesión válido (mismo secreto que `signSessionToken`) y la membresía del
 * tenant activo tiene que seguir activa — suspender una membresía corta los
 * sockets igual que corta los requests HTTP. Sin token, con token inválido o
 * sin membresía → `next(new Error('unauthorized'))` y el socket no conecta.
 *
 * Dependencias inyectables para tests (`deps`): verificación del JWT,
 * verificación de membresía y ownership de la transmisión.
 */
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import type { Server, Socket } from 'socket.io';

import { db } from '../db/index.js';
import { transmissions } from '../db/schema/transmissions.js';
import { getActiveMembership } from './membershipService.js';

// ─── Tipos y dependencias ───────────────────────────────────────────────────

export interface SocketTokenPayload {
    userId: string;
    activeTenantId?: string | null;
    /** Mirror legacy del claim (tokens pre-B-2 sólo traían `tenantId`). */
    tenantId?: string;
}

export interface SocketAuthData {
    userId: string;
    tenantId: string;
}

export interface TransmissionSocketDeps {
    verifyToken?: (token: string) => SocketTokenPayload | null;
    checkMembership?: (userId: string, tenantId: string) => Promise<boolean>;
    ownsTransmission?: (
        tenantId: string,
        transmissionId: string,
    ) => Promise<boolean>;
}

// ─── Implementaciones de producción ─────────────────────────────────────────

function defaultVerifyToken(token: string): SocketTokenPayload | null {
    try {
        const secret =
            process.env.JWT_SECRET || 'dev-secret-change-in-production';
        return jwt.verify(token, secret) as SocketTokenPayload;
    } catch {
        return null;
    }
}

async function defaultCheckMembership(
    userId: string,
    tenantId: string,
): Promise<boolean> {
    return (await getActiveMembership(userId, tenantId)) !== null;
}

async function defaultOwnsTransmission(
    tenantId: string,
    transmissionId: string,
): Promise<boolean> {
    const [row] = await db
        .select({ id: transmissions.id })
        .from(transmissions)
        .where(
            and(
                eq(transmissions.id, transmissionId),
                eq(transmissions.tenantId, tenantId),
            ),
        )
        .limit(1);
    return !!row;
}

// ─── Resolución del handshake ───────────────────────────────────────────────

/**
 * Verifica token + membresía. Devuelve el tenant AUTORIZADO (del JWT, nunca
 * del payload del cliente) o null si el socket debe rechazarse.
 */
export async function resolveSocketAuth(
    token: string | undefined,
    deps: TransmissionSocketDeps = {},
): Promise<SocketAuthData | null> {
    if (!token) return null;
    const verify = deps.verifyToken ?? defaultVerifyToken;
    const checkMembership = deps.checkMembership ?? defaultCheckMembership;

    const payload = verify(token);
    if (!payload?.userId) return null;

    const tenantId = payload.activeTenantId ?? payload.tenantId ?? null;
    if (!tenantId) return null; // sesión sin tenant activo: no hay room que darle

    if (!(await checkMembership(payload.userId, tenantId))) return null;
    return { userId: payload.userId, tenantId };
}

/** Middleware `io.use(...)`: rechaza sin token / token inválido / membresía caída. */
export function createSocketAuthMiddleware(
    deps: TransmissionSocketDeps = {},
): (socket: Socket, next: (err?: Error) => void) => Promise<void> {
    return async (socket, next) => {
        try {
            const auth = await resolveSocketAuth(
                socket.handshake.auth?.token as string | undefined,
                deps,
            );
            if (!auth) {
                next(new Error('unauthorized'));
                return;
            }
            socket.data.userId = auth.userId;
            socket.data.tenantId = auth.tenantId;
            next();
        } catch {
            next(new Error('unauthorized'));
        }
    };
}

// ─── Rooms de transmisión ───────────────────────────────────────────────────

const TRANSMISSION_ERROR = 'transmission:error';

function emitTransmissionError(socket: Socket, message: string): void {
    socket.emit(TRANSMISSION_ERROR, { message });
}

/**
 * Registra middleware de auth + handlers de rooms sobre el `io` del proceso.
 * Es el único punto donde se decide a qué rooms entra un socket.
 */
export function registerTransmissionSocketHandlers(
    io: Server,
    deps: TransmissionSocketDeps = {},
): void {
    const ownsTransmission = deps.ownsTransmission ?? defaultOwnsTransmission;

    io.use(createSocketAuthMiddleware(deps));

    io.on('connection', (socket) => {
        const tenantId = socket.data.tenantId as string;
        void socket.join(`tenant:${tenantId}`);
        console.log(`[Socket.IO] Client connected to tenant:${tenantId}`);

        socket.on('transmission:subscribe', async (payload: unknown) => {
            const transmissionId = (
                payload as { transmissionId?: unknown } | undefined
            )?.transmissionId;
            if (typeof transmissionId !== 'string' || transmissionId.length === 0) {
                emitTransmissionError(socket, 'transmissionId inválido');
                return;
            }
            try {
                // Autorización por room: la transmisión debe ser del tenant
                // del socket — jamás del tenantId que mande el cliente.
                if (!(await ownsTransmission(tenantId, transmissionId))) {
                    emitTransmissionError(socket, 'transmisión no encontrada');
                    return;
                }
                await socket.join(`transmission:${transmissionId}`);
            } catch (err) {
                console.error(
                    '[Socket.IO] transmission:subscribe falló:',
                    err,
                );
                emitTransmissionError(socket, 'error al suscribirse');
            }
        });

        socket.on('transmission:unsubscribe', (payload: unknown) => {
            const transmissionId = (
                payload as { transmissionId?: unknown } | undefined
            )?.transmissionId;
            if (typeof transmissionId === 'string' && transmissionId.length > 0) {
                void socket.leave(`transmission:${transmissionId}`);
            }
        });
    });
}
