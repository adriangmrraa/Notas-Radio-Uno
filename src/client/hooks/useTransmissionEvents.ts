/**
 * useTransmissionEvents — suscripción tipada a los eventos de transmisión
 * (PD-04).
 *
 *   - `transmission:status`  → transición de la FSM (room transmisión+tenant).
 *   - `transmission:updated` → fila completa serializada (room tenant).
 *   - `transmission:error`   → suscripción rechazada por el server.
 *
 * Con `transmissionId` además emite `transmission:subscribe` para entrar al
 * room `transmission:{id}` (el server verifica ownership contra el tenant
 * del JWT — un id ajeno recibe `transmission:error`). El room del tenant se
 * decide en el server: el cliente NUNCA elige a qué tenant unirse.
 *
 * Re-suscripción automática: al reconectar el socket (vuelve `connected`)
 * se repite el subscribe del room de transmisión.
 */
import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { useSocket } from './useSocket';
import type {
    SerializedTransmission,
    TransmissionErrorEvent,
    TransmissionStatusEvent,
} from '../../shared/types';

export interface TransmissionEventHandlers {
    onStatus?: (payload: TransmissionStatusEvent) => void;
    onUpdated?: (transmission: SerializedTransmission) => void;
    onError?: (payload: TransmissionErrorEvent) => void;
}

export function useTransmissionEvents(
    handlers: TransmissionEventHandlers,
    transmissionId?: string | null,
): { socket: Socket | null; connected: boolean } {
    const { socket, connected } = useSocket();

    // Los handlers viven en un ref: los listeners se registran una sola vez
    // por socket y siempre llaman a la versión vigente del handler.
    const handlersRef = useRef(handlers);
    handlersRef.current = handlers;

    useEffect(() => {
        if (!socket) return;
        const onStatus = (p: TransmissionStatusEvent) =>
            handlersRef.current.onStatus?.(p);
        const onUpdated = (p: SerializedTransmission) =>
            handlersRef.current.onUpdated?.(p);
        const onError = (p: TransmissionErrorEvent) =>
            handlersRef.current.onError?.(p);
        socket.on('transmission:status', onStatus);
        socket.on('transmission:updated', onUpdated);
        socket.on('transmission:error', onError);
        return () => {
            socket.off('transmission:status', onStatus);
            socket.off('transmission:updated', onUpdated);
            socket.off('transmission:error', onError);
        };
    }, [socket]);

    useEffect(() => {
        if (!socket || !connected || !transmissionId) return;
        socket.emit('transmission:subscribe', { transmissionId });
        return () => {
            socket.emit('transmission:unsubscribe', { transmissionId });
        };
    }, [socket, connected, transmissionId]);

    return { socket, connected };
}
