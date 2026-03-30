import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Read JWT from cookie or localStorage for socket auth
    // The backend sets an httpOnly cookie, but we also support Bearer token
    // For socket auth, we try to get it from a non-httpOnly source
    const getToken = (): string | undefined => {
      // Try to read from a meta tag or localStorage if available
      try {
        const stored = localStorage.getItem('accessToken');
        if (stored) return stored;
      } catch { /* ignore */ }
      return undefined;
    };

    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      auth: {
        token: getToken(),
      },
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket.id);
      setConnected(true);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      setConnected(false);
    });

    socket.on('connect_error', (err) => {
      console.warn('[Socket] Connection error:', err.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return { socket: socketRef.current, connected };
}
