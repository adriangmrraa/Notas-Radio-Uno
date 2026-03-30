import { useState, useEffect, useRef } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useSocket } from '../hooks/useSocket';

interface Notification {
    id: string;
    type: string;
    title: string;
    message: string | null;
    icon: string | null;
    isRead: boolean;
    createdAt: string;
}

export function NotificationBell() {
    const { fetchApi } = useApi();
    const { socket } = useSocket();
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [open, setOpen] = useState(false);
    const [pulse, setPulse] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetchApi<{ notifications: Notification[]; unreadCount: number }>('/jobs/notifications?limit=20')
            .then((data) => {
                setNotifications(data.notifications);
                setUnreadCount(data.unreadCount);
            })
            .catch(() => {});
    }, []);

    // Listen for real-time notifications
    useEffect(() => {
        if (!socket) return;
        const handler = (notif: Notification) => {
            setNotifications((prev) => [notif, ...prev].slice(0, 30));
            setUnreadCount((c) => c + 1);
            // Trigger pulse animation
            setPulse(true);
            setTimeout(() => setPulse(false), 1000);
        };
        socket.on('notification', handler);
        return () => { socket.off('notification', handler); };
    }, [socket]);

    // Close on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        if (open) document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const markAllRead = async () => {
        await fetchApi('/jobs/notifications/read-all', { method: 'POST' });
        setUnreadCount(0);
        setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    };

    const getTypeColor = (type: string) => {
        if (type.includes('error') || type.includes('failed')) return 'bg-red-500';
        if (type.includes('completed')) return 'bg-emerald-500';
        if (type.includes('published') || type.includes('note')) return 'bg-purple-500';
        if (type.includes('started')) return 'bg-cyan-500';
        return 'bg-cyan-500';
    };

    return (
        <div className="relative" ref={panelRef}>
            <button
                onClick={() => setOpen(!open)}
                className={`relative p-2.5 rounded-xl hover:bg-white/[0.06] transition-all duration-300 group ${pulse ? 'animate-scale-in' : ''}`}
            >
                <Bell className={`w-5 h-5 transition-colors duration-300 ${open ? 'text-cyan-400' : 'text-white/40 group-hover:text-white/60'}`} />
                {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-gradient-to-br from-cyan-400 to-cyan-600 rounded-full text-[10px] font-bold flex items-center justify-center text-white px-1 shadow-glow-cyan animate-scale-in">
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute right-0 top-12 w-96 max-h-[28rem] bg-surface border border-white/[0.08] rounded-2xl shadow-elevated overflow-hidden z-50 animate-scale-in">
                    {/* Top gradient accent */}
                    <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/30 to-transparent" />

                    <div className="flex items-center justify-between px-5 py-3.5 border-b border-white/[0.06]">
                        <span className="text-sm font-semibold">Notificaciones</span>
                        {unreadCount > 0 && (
                            <button onClick={markAllRead} className="text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors duration-300 flex items-center gap-1.5">
                                <CheckCheck className="w-3.5 h-3.5" />
                                Marcar leidas
                            </button>
                        )}
                    </div>

                    <div className="overflow-y-auto max-h-[22rem] no-scrollbar">
                        {notifications.length === 0 && (
                            <div className="flex flex-col items-center justify-center py-12">
                                <div className="w-12 h-12 rounded-xl bg-white/[0.03] flex items-center justify-center mb-3 ring-1 ring-white/[0.06]">
                                    <Bell className="w-5 h-5 text-white/15" />
                                </div>
                                <p className="text-white/20 text-sm">Sin notificaciones</p>
                            </div>
                        )}
                        {notifications.map((n, i) => (
                            <div
                                key={n.id}
                                className={`px-5 py-3.5 border-b border-white/[0.03] transition-all duration-300 hover:bg-white/[0.02] ${!n.isRead ? 'bg-white/[0.02]' : ''}`}
                                style={{ animation: `notifSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) ${i * 30}ms both` }}
                            >
                                <div className="flex items-start gap-3">
                                    <span className="text-base mt-0.5 shrink-0">{n.icon || '📢'}</span>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium leading-snug">{n.title}</p>
                                        {n.message && <p className="text-xs text-white/30 mt-0.5 truncate">{n.message}</p>}
                                        <p className="text-[10px] text-white/15 mt-1.5">{new Date(n.createdAt).toLocaleTimeString()}</p>
                                    </div>
                                    {!n.isRead && <div className={`w-2 h-2 ${getTypeColor(n.type)} rounded-full mt-2 shrink-0 animate-pulse-soft`} />}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
