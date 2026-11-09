import { useEffect, useRef } from 'react';
import { User } from 'lucide-react';
import type { LiveRoomTimelineItem } from '../../../shared/types';

export function formatMs(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

interface LiveTimelineProps {
    items: LiveRoomTimelineItem[];
}

/**
 * Timeline de transcripción en vivo. Los items vienen ordenados por
 * `startMs` (el server los ordena); el auto-scroll sigue el último
 * utterance salvo que el usuario haya scrolleado hacia arriba.
 */
export function LiveTimeline({ items }: LiveTimelineProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const pinnedToBottom = useRef(true);

    useEffect(() => {
        const el = containerRef.current;
        if (el && pinnedToBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [items.length]);

    const onScroll = () => {
        const el = containerRef.current;
        if (!el) return;
        // "Pegado al fondo" con tolerancia: si el usuario sube, no lo
        // arrastramos de vuelta con cada utterance nuevo.
        pinnedToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };

    if (items.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center text-white/30 text-sm py-16">
                Todavía no hay transcripción. Los segmentos aparecen acá a
                medida que se detecta habla.
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            onScroll={onScroll}
            className="flex-1 overflow-y-auto space-y-3 pr-1"
        >
            {items.map((item) => (
                <div key={item.id} className="flex gap-3">
                    <div className="w-14 shrink-0 pt-1 text-right">
                        <span className="text-[11px] font-mono text-white/35">
                            {formatMs(item.startMs)}
                        </span>
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                            {item.personPhotoUrl ? (
                                <img
                                    src={item.personPhotoUrl}
                                    alt=""
                                    className="w-5 h-5 rounded-full object-cover"
                                />
                            ) : (
                                <div className="w-5 h-5 rounded-full bg-white/[0.06] flex items-center justify-center">
                                    <User className="w-3 h-3 text-white/40" />
                                </div>
                            )}
                            <span
                                className={`text-xs font-medium ${
                                    item.personName
                                        ? 'text-cyan-300'
                                        : 'text-white/45'
                                }`}
                            >
                                {item.personName ?? item.speakerLabel ?? 'Sin identificar'}
                            </span>
                            {item.confidence != null && (
                                <span className="text-[10px] text-white/25">
                                    {Math.round(item.confidence * 100)}%
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-white/75 leading-relaxed">
                            {item.text}
                        </p>
                    </div>
                </div>
            ))}
        </div>
    );
}
