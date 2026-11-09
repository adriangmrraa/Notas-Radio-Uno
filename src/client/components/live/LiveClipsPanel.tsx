import { Bookmark, Clapperboard, Loader2, Users, Zap } from 'lucide-react';
import type {
    LiveRoomClip,
    LiveRoomMoment,
    LiveRoomPerson,
} from '../../../shared/types';
import { formatMs } from './LiveTimeline';

const CLIP_STATUS_BADGE: Record<string, string> = {
    generating: 'badge-warning',
    ready: 'badge-success',
    pending_review: 'badge-info',
    published: 'badge-purple',
    error: 'badge-danger',
};

const CLIP_STATUS_LABEL: Record<string, string> = {
    generating: 'Generando',
    ready: 'Listo',
    pending_review: 'En revisión',
    published: 'Publicado',
    error: 'Error',
};

interface LiveClipsPanelProps {
    moments: LiveRoomMoment[];
    clips: LiveRoomClip[];
    people: LiveRoomPerson[];
}

/**
 * Rail derecho de la sala: momentos detectados (score + motivo), clips en
 * generación/listos y personas detectadas con su confianza.
 */
export function LiveClipsPanel({ moments, clips, people }: LiveClipsPanelProps) {
    return (
        <div className="space-y-5">
            {/* Momentos detectados */}
            <section className="glass-card-static p-4">
                <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    Momentos detectados
                </h3>
                {moments.length === 0 ? (
                    <p className="text-xs text-white/30">
                        Sin momentos todavía. Los marks manuales y los que
                        detecte el análisis aparecen acá.
                    </p>
                ) : (
                    <ul className="space-y-2.5">
                        {moments.map((m) => (
                            <li
                                key={m.id}
                                className="border border-white/[0.05] rounded-lg px-3 py-2 bg-white/[0.02]"
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-medium text-white/75 truncate">
                                        {m.title ?? 'Momento'}
                                    </span>
                                    <span className="flex items-center gap-1.5 shrink-0">
                                        {m.kind === 'mark' && (
                                            <Bookmark className="w-3 h-3 text-cyan-400" />
                                        )}
                                        {m.score != null && (
                                            <span className="badge badge-info">
                                                {Math.round(m.score * 100)}%
                                            </span>
                                        )}
                                    </span>
                                </div>
                                <div className="mt-1 flex items-center justify-between gap-2">
                                    <span className="text-[10px] font-mono text-white/30">
                                        {formatMs(m.startMs)}–{formatMs(m.endMs)}
                                    </span>
                                    {m.reason && (
                                        <span className="text-[10px] text-white/35 truncate">
                                            {m.reason}
                                        </span>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* Clips de la transmisión */}
            <section className="glass-card-static p-4">
                <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Clapperboard className="w-3.5 h-3.5 text-cyan-400" />
                    Clips
                </h3>
                {clips.length === 0 ? (
                    <p className="text-xs text-white/30">
                        Ningún clip todavía. Usá «Generar clip ahora» para
                        marcar un fragmento.
                    </p>
                ) : (
                    <ul className="space-y-2.5">
                        {clips.map((c) => (
                            <li
                                key={c.id}
                                className="border border-white/[0.05] rounded-lg px-3 py-2 bg-white/[0.02]"
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-medium text-white/75 truncate">
                                        {c.title}
                                    </span>
                                    <span
                                        className={`badge ${CLIP_STATUS_BADGE[c.status] ?? 'badge-info'} inline-flex items-center gap-1`}
                                    >
                                        {c.status === 'generating' && (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                        )}
                                        {CLIP_STATUS_LABEL[c.status] ?? c.status}
                                    </span>
                                </div>
                                <div className="mt-1 flex items-center justify-between">
                                    <span className="text-[10px] text-white/30">
                                        {c.duration}s
                                    </span>
                                    {c.videoUrl && (
                                        <a
                                            href={c.videoUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-[10px] text-cyan-400 hover:text-cyan-300"
                                        >
                                            Ver video
                                        </a>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* Personas detectadas */}
            <section className="glass-card-static p-4">
                <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Users className="w-3.5 h-3.5 text-violet-400" />
                    Personas detectadas
                </h3>
                {people.length === 0 ? (
                    <p className="text-xs text-white/30">
                        Nadie identificado todavía — los speakers sin
                        atribución figuran como «Speaker A», «Speaker B»…
                    </p>
                ) : (
                    <ul className="space-y-2">
                        {people.map((p) => (
                            <li key={p.personId} className="flex items-center gap-2.5">
                                {p.photoUrl ? (
                                    <img
                                        src={p.photoUrl}
                                        alt=""
                                        className="w-7 h-7 rounded-full object-cover"
                                    />
                                ) : (
                                    <div className="w-7 h-7 rounded-full bg-white/[0.06] flex items-center justify-center text-[10px] font-semibold text-white/50">
                                        {p.name.charAt(0).toUpperCase()}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-white/75 truncate">
                                        {p.name}
                                    </p>
                                    {p.speakerLabel && (
                                        <p className="text-[10px] text-white/30">
                                            {p.speakerLabel}
                                        </p>
                                    )}
                                </div>
                                {p.confidence != null && (
                                    <span className="badge badge-info shrink-0">
                                        {Math.round(p.confidence * 100)}%
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
