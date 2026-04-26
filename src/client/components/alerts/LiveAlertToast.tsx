/**
 * LiveAlertToast — Toast de alerta en tiempo real
 *
 * Se muestra en la esquina superior derecha cuando el pipeline detecta
 * un momento relevante. Severity-coded: rojo (high), ámbar (medium), azul (low).
 */

import { X, Radio } from 'lucide-react';
import type { AlertWithId } from '../../hooks/useLiveAlerts';

interface Props {
  toasts: AlertWithId[];
  onDismiss: (id: string) => void;
}

const SEVERITY_STYLES = {
  high: {
    border: 'border-red-500/50',
    bg: 'bg-red-950/80',
    badge: 'bg-red-500/20 text-red-300 border border-red-500/30',
    icon: '🔴',
    glow: 'shadow-[0_0_20px_rgba(239,68,68,0.25)]',
    pulse: 'animate-pulse-slow',
  },
  medium: {
    border: 'border-amber-500/40',
    bg: 'bg-amber-950/80',
    badge: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
    icon: '⚡',
    glow: 'shadow-[0_0_16px_rgba(245,158,11,0.20)]',
    pulse: '',
  },
  low: {
    border: 'border-blue-500/30',
    bg: 'bg-blue-950/70',
    badge: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    icon: 'ℹ️',
    glow: 'shadow-[0_0_12px_rgba(59,130,246,0.15)]',
    pulse: '',
  },
};

const TYPE_ICONS: Record<string, string> = {
  breaking_news: '🔴',
  strong_statement: '⚡',
  key_data: '📊',
  emotional_peak: '🔥',
  keyword: '🏷️',
};

const TYPE_LABELS: Record<string, string> = {
  breaking_news: 'Último momento',
  strong_statement: 'Declaración fuerte',
  key_data: 'Dato clave',
  emotional_peak: 'Pico emocional',
  keyword: 'Keyword detectado',
};

export function LiveAlertToast({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((alert) => {
        const s = SEVERITY_STYLES[alert.severity];
        const typeIcon = TYPE_ICONS[alert.type] || '🔔';
        const typeLabel = TYPE_LABELS[alert.type] || alert.type;

        return (
          <div
            key={alert.id}
            className={`
              pointer-events-auto
              relative rounded-2xl border backdrop-blur-xl p-4
              ${s.border} ${s.bg} ${s.glow}
              animate-slide-in-right
            `}
          >
            {/* Pulse ring para breaking news */}
            {alert.severity === 'high' && (
              <span className="absolute inset-0 rounded-2xl border border-red-500/30 animate-ping-slow pointer-events-none" />
            )}

            {/* Header */}
            <div className="flex items-start gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-xl leading-none flex-shrink-0">{typeIcon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md tracking-wide uppercase ${s.badge}`}>
                      {typeLabel}
                    </span>
                    {alert.severity === 'high' && (
                      <span className="flex items-center gap-1 text-[10px] font-semibold text-red-400 animate-pulse">
                        <Radio className="w-2.5 h-2.5" />
                        EN VIVO
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-white/90 leading-snug line-clamp-2">
                    {alert.title}
                  </p>
                </div>
              </div>
              <button
                onClick={() => onDismiss(alert.id)}
                className="flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-white/30 hover:text-white/70 hover:bg-white/10 transition-colors"
                aria-label="Cerrar alerta"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Excerpt */}
            {alert.excerpt && (
              <p className="mt-2 text-xs text-white/50 leading-relaxed line-clamp-3 pl-8 border-l border-white/10 italic">
                "{alert.excerpt}"
              </p>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between mt-2 pl-8">
              {alert.speaker && (
                <span className="text-xs text-white/35">— {alert.speaker}</span>
              )}
              {alert.matchedKeyword && (
                <span className="text-xs text-white/35">
                  keyword: <span className="font-mono text-cyan-400/70">"{alert.matchedKeyword}"</span>
                </span>
              )}
              <span className="text-[10px] text-white/20 ml-auto">
                {new Date(alert.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
