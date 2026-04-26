/**
 * ClipsPage.tsx — Auto-Clips Verticales
 *
 * Visualiza los clips generados automáticamente por el pipeline:
 * video preview, hook text, duración, estado y acciones de revisión.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Film,
  Play,
  Download,
  Check,
  X,
  Eye,
  Loader2,
  AlertCircle,
  Clock,
  CheckCircle2,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';

// ─── Types ────────────────────────────────────────────────────────────────────

type ClipStatus = 'generating' | 'ready' | 'pending_review' | 'published' | 'error';

interface Clip {
  id: string;
  title: string;
  hookText: string;
  videoPath: string | null;
  duration: number;
  status: ClipStatus;
  programId: string | null;
  metadata: {
    reason?: string;
    startMs?: number;
    endMs?: number;
    speakerCount?: number;
  } | null;
  createdAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const diff = now - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} hs`;
  return `hace ${Math.floor(hrs / 24)} días`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// ─── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<ClipStatus, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  generating: { label: 'Generando', color: 'text-amber-400', icon: Loader2 },
  ready:       { label: 'Listo',     color: 'text-emerald-400', icon: CheckCircle2 },
  pending_review: { label: 'Pendiente', color: 'text-violet-400', icon: Clock },
  published:   { label: 'Publicado', color: 'text-sky-400', icon: CheckCircle2 },
  error:       { label: 'Error',     color: 'text-red-400', icon: AlertCircle },
};

type FilterStatus = 'all' | ClipStatus;

const FILTER_TABS: { key: FilterStatus; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'pending_review', label: 'Pendientes' },
  { key: 'ready', label: 'Listos' },
  { key: 'published', label: 'Publicados' },
];

// ─── Video Preview Modal ───────────────────────────────────────────────────────

interface PreviewModalProps {
  clip: Clip;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  approving: boolean;
  rejecting: boolean;
}

function PreviewModal({ clip, onClose, onApprove, onReject, approving, rejecting }: PreviewModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        className="relative flex flex-col items-center gap-4 max-h-[95vh] overflow-y-auto"
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'linear-gradient(160deg, #0f0f1a 0%, #0a0a12 100%)',
          border: '1px solid rgba(139,92,246,0.2)',
          borderRadius: 20,
          padding: '24px 20px',
          boxShadow: '0 0 60px rgba(139,92,246,0.15)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-white/10 transition-all"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Video player — 9:16 aspect ratio */}
        <div
          className="relative w-full overflow-hidden rounded-xl"
          style={{ aspectRatio: '9/16', maxWidth: 270, background: '#0a0a12' }}
        >
          {clip.videoPath ? (
            <video
              ref={videoRef}
              src={`/api/clips/${clip.id}/video`}
              className="w-full h-full object-cover"
              controls
              autoPlay
              playsInline
              style={{ borderRadius: 12 }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <div className="text-center">
                <Film className="w-12 h-12 text-white/20 mx-auto mb-2" />
                <p className="text-white/30 text-sm">Video no disponible</p>
              </div>
            </div>
          )}
        </div>

        {/* Clip info */}
        <div className="w-full space-y-2">
          <h3 className="text-white font-semibold text-base leading-snug">
            {clip.hookText}
          </h3>
          {clip.metadata?.reason && (
            <p className="text-white/50 text-sm leading-relaxed">
              {clip.metadata.reason}
            </p>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="flex items-center gap-1.5 text-xs text-white/40">
              <Clock className="w-3 h-3" />
              {formatDuration(clip.duration)}
            </span>
            {clip.metadata?.speakerCount && clip.metadata.speakerCount > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-white/40">
                <Volume2 className="w-3 h-3" />
                {clip.metadata.speakerCount} orador{clip.metadata.speakerCount !== 1 ? 'es' : ''}
              </span>
            )}
            <span className="text-xs text-white/30">{timeAgo(clip.createdAt)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="w-full flex gap-2">
          {clip.videoPath && (
            <a
              href={`/api/clips/${clip.id}/video`}
              download={`clip_${clip.id}.mp4`}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium text-white/70 border border-white/10 hover:bg-white/5 hover:text-white transition-all"
            >
              <Download className="w-4 h-4" />
              Descargar
            </a>
          )}
          {clip.status === 'pending_review' && (
            <>
              <button
                onClick={() => onReject(clip.id)}
                disabled={rejecting}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium text-red-400 border border-red-500/20 hover:bg-red-500/10 transition-all disabled:opacity-50"
              >
                {rejecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                Rechazar
              </button>
              <button
                onClick={() => onApprove(clip.id)}
                disabled={approving}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-medium text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/10 transition-all disabled:opacity-50"
              >
                {approving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Aprobar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Clip Card ─────────────────────────────────────────────────────────────────

interface ClipCardProps {
  clip: Clip;
  onPreview: (clip: Clip) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDelete: (id: string) => void;
  loading: boolean;
}

function ClipCard({ clip, onPreview, onApprove, onReject, onDelete, loading }: ClipCardProps) {
  const statusCfg = STATUS_CONFIG[clip.status];
  const StatusIcon = statusCfg.icon;

  return (
    <div
      className="group relative flex flex-col overflow-hidden rounded-2xl transition-all duration-300 hover:-translate-y-0.5"
      style={{
        background: 'linear-gradient(160deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
        border: '1px solid rgba(255,255,255,0.07)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
      }}
    >
      {/* Thumbnail area — 9:16 ratio */}
      <div
        className="relative w-full overflow-hidden cursor-pointer"
        style={{ aspectRatio: '9/16', background: 'linear-gradient(180deg, #0d0d1a 0%, #060610 100%)' }}
        onClick={() => onPreview(clip)}
      >
        {/* Background pattern */}
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 20px, rgba(139,92,246,0.1) 20px, rgba(139,92,246,0.1) 21px)',
          }}
        />

        {/* Play button overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          {clip.status === 'generating' ? (
            <>
              <Loader2 className="w-10 h-10 text-violet-400 animate-spin" />
              <span className="text-white/50 text-xs">Generando clip...</span>
            </>
          ) : clip.videoPath ? (
            <>
              <div
                className="w-14 h-14 flex items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-110"
                style={{
                  background: 'rgba(139,92,246,0.25)',
                  border: '2px solid rgba(139,92,246,0.5)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                <Play className="w-6 h-6 text-violet-300 ml-0.5" />
              </div>
              <span className="text-white/40 text-xs">Ver clip</span>
            </>
          ) : (
            <>
              <Film className="w-10 h-10 text-white/20" />
              <span className="text-white/30 text-xs">Sin video</span>
            </>
          )}
        </div>

        {/* Duration badge */}
        <div
          className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md text-xs font-semibold"
          style={{ background: 'rgba(0,0,0,0.7)', color: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(4px)' }}
        >
          {formatDuration(clip.duration)}
        </div>

        {/* Status badge */}
        <div
          className="absolute top-2 left-2 flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
        >
          <StatusIcon className={`w-3 h-3 ${statusCfg.color} ${clip.status === 'generating' ? 'animate-spin' : ''}`} />
          <span className={statusCfg.color}>{statusCfg.label}</span>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-3 p-3">
        <p className="text-white/90 text-sm font-medium leading-snug line-clamp-2">
          {clip.hookText}
        </p>

        {clip.metadata?.reason && (
          <p className="text-white/40 text-xs leading-relaxed line-clamp-2">
            {clip.metadata.reason}
          </p>
        )}

        <p className="text-white/25 text-xs">{timeAgo(clip.createdAt)}</p>

        {/* Actions */}
        <div className="flex gap-1.5">
          <button
            onClick={() => onPreview(clip)}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-medium text-white/60 border border-white/10 hover:bg-white/5 hover:text-white transition-all"
          >
            <Eye className="w-3.5 h-3.5" />
            Ver
          </button>

          {clip.videoPath && (
            <a
              href={`/api/clips/${clip.id}/video`}
              download={`clip_${clip.id}.mp4`}
              className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-medium text-sky-400 border border-sky-500/20 hover:bg-sky-500/10 transition-all"
              onClick={e => e.stopPropagation()}
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Descargar</span>
            </a>
          )}

          {clip.status === 'pending_review' && (
            <>
              <button
                onClick={() => onReject(clip.id)}
                disabled={loading}
                className="flex items-center justify-center gap-1 py-2 px-2.5 rounded-xl text-xs font-medium text-red-400 border border-red-500/20 hover:bg-red-500/10 transition-all disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onApprove(clip.id)}
                disabled={loading}
                className="flex items-center justify-center gap-1 py-2 px-2.5 rounded-xl text-xs font-medium text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/10 transition-all disabled:opacity-50"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </>
          )}

          <button
            onClick={() => onDelete(clip.id)}
            disabled={loading}
            className="flex items-center justify-center gap-1 py-2 px-2.5 rounded-xl text-xs font-medium text-white/20 border border-white/5 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/20 transition-all disabled:opacity-50"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export function ClipsPage() {
  const { fetchApi } = useApi();
  const [clips, setClips] = useState<Clip[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterStatus>('all');
  const [previewClip, setPreviewClip] = useState<Clip | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null); // clip id being actioned

  const loadClips = useCallback(async (filter: FilterStatus) => {
    setLoading(true);
    try {
      const params = filter !== 'all' ? `?status=${filter}` : '';
      const data = await fetchApi<{ clips: Clip[]; total: number }>(`/clips${params}`);
      setClips(data.clips || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('[ClipsPage] Error cargando clips:', err);
    } finally {
      setLoading(false);
    }
  }, [fetchApi]);

  useEffect(() => {
    loadClips(activeFilter);
  }, [activeFilter, loadClips]);

  const handleApprove = async (id: string) => {
    setActionLoading(id);
    try {
      await fetchApi(`/clips/${id}/approve`, { method: 'POST' });
      setClips(prev => prev.map(c => c.id === id ? { ...c, status: 'ready' } : c));
      if (previewClip?.id === id) setPreviewClip(p => p ? { ...p, status: 'ready' } : p);
    } catch (err) {
      console.error('[ClipsPage] Error aprobando clip:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (id: string) => {
    if (!confirm('¿Rechazar este clip?')) return;
    setActionLoading(id);
    try {
      await fetchApi(`/clips/${id}`, { method: 'DELETE' });
      setClips(prev => prev.filter(c => c.id !== id));
      setTotal(t => Math.max(0, t - 1));
      if (previewClip?.id === id) setPreviewClip(null);
    } catch (err) {
      console.error('[ClipsPage] Error rechazando clip:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este clip definitivamente?')) return;
    setActionLoading(id);
    try {
      await fetchApi(`/clips/${id}`, { method: 'DELETE' });
      setClips(prev => prev.filter(c => c.id !== id));
      setTotal(t => Math.max(0, t - 1));
      if (previewClip?.id === id) setPreviewClip(null);
    } catch (err) {
      console.error('[ClipsPage] Error eliminando clip:', err);
    } finally {
      setActionLoading(null);
    }
  };

  // Pending count badge
  const pendingCount = clips.filter(c => c.status === 'pending_review').length;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-screen-xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 flex items-center justify-center rounded-xl"
            style={{
              background: 'linear-gradient(135deg, rgba(139,92,246,0.2) 0%, rgba(99,102,241,0.15) 100%)',
              border: '1px solid rgba(139,92,246,0.25)',
            }}
          >
            <Film className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h1 className="text-white font-bold text-xl tracking-tight">Clips</h1>
            <p className="text-white/40 text-sm">Momentos virales generados automáticamente</p>
          </div>
          {pendingCount > 0 && (
            <span
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold"
              style={{
                background: 'rgba(139,92,246,0.15)',
                color: '#a78bfa',
                border: '1px solid rgba(139,92,246,0.25)',
              }}
            >
              <Sparkles className="w-3 h-3" />
              {pendingCount} nuevo{pendingCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <button
          onClick={() => loadClips(activeFilter)}
          className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-white/50 border border-white/10 hover:bg-white/5 hover:text-white transition-all"
        >
          <Film className="w-4 h-4" />
          Actualizar
        </button>
      </div>

      {/* Filter tabs */}
      <div
        className="flex items-center gap-1 p-1 rounded-xl w-fit"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {FILTER_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveFilter(tab.key)}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-200"
            style={
              activeFilter === tab.key
                ? {
                    background: 'rgba(139,92,246,0.2)',
                    color: '#a78bfa',
                    border: '1px solid rgba(139,92,246,0.3)',
                  }
                : {
                    color: 'rgba(255,255,255,0.4)',
                  }
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <Loader2 className="w-10 h-10 text-violet-400 animate-spin mx-auto mb-3" />
            <p className="text-white/40 text-sm">Cargando clips...</p>
          </div>
        </div>
      ) : clips.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <Film className="w-16 h-16 text-white/10 mx-auto mb-4" />
            <p className="text-white/40 font-medium mb-1">No hay clips aún</p>
            <p className="text-white/25 text-sm max-w-xs mx-auto">
              Los clips se generan automáticamente cuando el pipeline detecta momentos virales en el stream con AssemblyAI activo.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Stats bar */}
          <p className="text-white/30 text-sm">
            {total} clip{total !== 1 ? 's' : ''} en total
          </p>

          {/* Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {clips.map(clip => (
              <ClipCard
                key={clip.id}
                clip={clip}
                onPreview={setPreviewClip}
                onApprove={handleApprove}
                onReject={handleReject}
                onDelete={handleDelete}
                loading={actionLoading === clip.id}
              />
            ))}
          </div>
        </>
      )}

      {/* Preview Modal */}
      {previewClip && (
        <PreviewModal
          clip={previewClip}
          onClose={() => setPreviewClip(null)}
          onApprove={handleApprove}
          onReject={handleReject}
          approving={actionLoading === previewClip.id}
          rejecting={actionLoading === previewClip.id}
        />
      )}
    </div>
  );
}
