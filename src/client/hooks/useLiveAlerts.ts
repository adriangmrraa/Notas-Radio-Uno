/**
 * useLiveAlerts — Hook para recibir y gestionar alertas en vivo via Socket.IO
 *
 * Escucha el evento `live_alert` emitido por el pipeline cuando detecta
 * un momento relevante en la transmisión.
 */

import { useState, useEffect, useCallback } from 'react';
import { useSocket } from './useSocket';
import type { LiveAlert } from '../../shared/types';

export interface AlertWithId extends LiveAlert {
  id: string;
  dismissed: boolean;
}

let alertCounter = 0;
function nextAlertId(): string {
  return `alert-${++alertCounter}`;
}

export function useLiveAlerts() {
  const { socket } = useSocket();
  const [alerts, setAlerts] = useState<AlertWithId[]>([]);
  const [toasts, setToasts] = useState<AlertWithId[]>([]);

  useEffect(() => {
    if (!socket) return;

    const handler = (alert: LiveAlert) => {
      const withId: AlertWithId = {
        ...alert,
        id: nextAlertId(),
        dismissed: false,
      };

      // Agregar al feed de alertas
      setAlerts(prev => [withId, ...prev].slice(0, 100)); // máximo 100 alertas

      // Agregar como toast
      setToasts(prev => [...prev, withId]);

      // Auto-dismiss toasts: 10s para medium/low, high permanece hasta dismiss manual
      if (alert.severity !== 'high') {
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== withId.id));
        }, 10000);
      }
    };

    socket.on('live_alert', handler);
    return () => { socket.off('live_alert', handler); };
  }, [socket]);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
    setToasts([]);
  }, []);

  return { alerts, toasts, dismissToast, clearAlerts };
}
