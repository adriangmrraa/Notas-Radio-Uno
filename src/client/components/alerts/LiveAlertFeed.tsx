/**
 * LiveAlertFeed — Panel de alertas en vivo del pipeline
 *
 * Muestra una lista scrollable de alertas detectadas en la sesión actual.
 * Cada alerta tiene: badge de severidad, ícono de tipo, título, excerpt, timestamp.
 */

import { useState } from 'react';
import { ChevronDown, ChevronUp, Radio, Zap } from 'lucide-react';
import type { AlertWithId } from '../../hooks/useLiveAlerts';

interface Props {
  alerts: AlertWithId[];
}

const SEVERITY_BADGE: Record<string, string> = {
  high: 'bg-red-500/15 text-red-300 border-red-500/25',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  low: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
};

const SEVERITY_LABELS: Record<string, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

const SEVERITY_DOT: Record<string, string> = {
  high: 'bg-red-400',
  medium: 'bg-amber-400',
  low: 'bg-blue-400',
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
  strong_statement: 'Declaración',
  key_data: 'Dato clave',
  emotional_peak: 'Tensión',
  keyword: 'Keyword',
};

function AlertCard({ alert }: { alert: AlertWithId }) {
  const [expanded, setExpanded] = useState(false);
  const badgeClass = SEVERITY_BADGE[alert.severity] || SEVERITY_BADGE.low;
  const dotClass = SEVERITY_DOT[alert.severity] || SEVERITY_DOT.low;
  const typeIcon = TYPE_ICONS[alert.type] || '🔔';
  const typeLabel = TYPE_LABELS[alert.type] || alert.type;

  return (
    <div className="group border border-white/[0.06] rounded-xl p-3.5 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/10 transition-all duration-200">
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="text-base leading-none flex-shrink-0 mt-0.5">{typeIcon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${badgeClass}`}>
              {typeLabel}
            </span>
            <div className="flex items-center gap-1">
              <div className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
              <span className="text-[10px] text-white/30">{SEVERITY_LABELS[alert.severity]}</span>
            </div>
          </div>
          <p className="text-sm font-medium text-white/80 leading-snug">
            {alert.title}
          </p>
        </div>

        {/* Expand toggle */}
        {(alert.excerpt || alert.context || alert.speaker) && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-white/20 hover:text-white/60 hover:bg-white/10 transition-colors"
            aria-label={expanded ? 'Colapsar' : 'Expandir'}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* Excerpt (always visible, truncated) */}
      {alert.excerpt && !expanded && (
        <p className="mt-1.5 text-xs text-white/35 leading-relaxed line-clamp-2 pl-7 italic">
          "{alert.excerpt}"
        </p>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="mt-2 pl-7 space-y-2">
          {alert.excerpt && (
            <div className="border-l border-white/10 pl-3">
              <p className="text-xs text-white/40 italic leading-relaxed">
                "{alert.excerpt}"
              </p>
            </div>
          )}
          {alert.context && (
            <p className="text-xs text-white/50 leading-relaxed">
              {alert.context}
            </p>
          )}
          {alert.speaker && (
            <p className="text-xs text-white/30">
              Orador: <span className="text-white/60">{alert.speaker}</span>
            </p>
          )}
          {alert.matchedKeyword && (
            <p className="text-xs text-white/30">
              Keyword: <span className="font-mono text-cyan-400/60">"{alert.matchedKeyword}"</span>
            </p>
          )}
        </div>
      )}

      {/* Timestamp */}
      <div className="mt-2 pl-7">
        <span className="text-[10px] text-white/20">
          {new Date(alert.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
    </div>
  );
}

export function LiveAlertFeed({ alerts }: Props) {
  if (alerts.length === 0) {
    return (
      <div className="py-8 text-center">
        <div className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.05] flex items-center justify-center mx-auto mb-3">
          <Radio className="w-4 h-4 text-white/15" />
        </div>
        <p className="text-xs text-white/25">Sin alertas detectadas en esta sesión</p>
      </div>
    );
  }

  const highCount = alerts.filter(a => a.severity === 'high').length;
  const mediumCount = alerts.filter(a => a.severity === 'medium').length;

  return (
    <div>
      {/* Stats bar */}
      {alerts.length > 0 && (
        <div className="flex items-center gap-3 mb-3 pb-3 border-b border-white/[0.05]">
          <span className="text-xs text-white/30">{alerts.length} alertas</span>
          {highCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-red-400/70">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
              {highCount} alta
            </span>
          )}
          {mediumCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-amber-400/60">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              {mediumCount} media
            </span>
          )}
        </div>
      )}

      {/* Alert list */}
      <div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
        {alerts.map(alert => (
          <AlertCard key={alert.id} alert={alert} />
        ))}
      </div>
    </div>
  );
}
