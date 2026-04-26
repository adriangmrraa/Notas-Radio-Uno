import { useState, useEffect, useCallback } from 'react';
import {
  ClipboardCheck,
  Eye,
  Check,
  X,
  Wand2,
  ImageIcon,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  AlertCircle,
  Clock,
  CheckCircle2,
  XCircle,
  FileImage,
  Pencil,
  MessageSquare,
  Camera,
  Briefcase,
  PlayCircle,
  Mail,
  Copy,
  CheckCheck,
  Sparkles,
  Layers,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';

// ─── Types ────────────────────────────────────────────────────────────────────

type ReviewStatus = 'pending_review' | 'published' | 'rejected';

type VariantKey = 'twitterThread' | 'instagramCarousel' | 'linkedinPost' | 'youtubeDescription' | 'newsletterBlurb';

interface ContentVariants {
  twitterThread: string[];
  instagramCarousel: string[];
  linkedinPost: string;
  youtubeDescription: string;
  newsletterBlurb: string;
}

interface EditHistoryEntry {
  id: string;
  type: 'text' | 'image';
  prompt?: string;
  createdAt: string;
}

interface ReviewPublication {
  id: string;
  title: string;
  content: string;
  imageUrl?: string;
  imagePath?: string;
  status: ReviewStatus;
  createdAt: string;
  editHistory?: EditHistoryEntry[];
  contentVariants?: ContentVariants | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} hs`;
  const days = Math.floor(hrs / 24);
  return `hace ${days} días`;
}

const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending_review: 'Pendiente',
  published: 'Publicado',
  rejected: 'Rechazado',
};

const STATUS_BADGE: Record<ReviewStatus, string> = {
  pending_review: 'badge badge-warning',
  published: 'badge badge-success',
  rejected: 'badge badge-danger',
};

const TAB_STATUSES: { key: ReviewStatus; label: string }[] = [
  { key: 'pending_review', label: 'Pendientes' },
  { key: 'published', label: 'Publicados' },
  { key: 'rejected', label: 'Rechazados' },
];

const TEMPLATE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'bold', label: 'Bold' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'breaking', label: 'Breaking' },
  { value: 'sport', label: 'Sport' },
];

const FONT_OPTIONS = [
  { value: 'inter', label: 'Inter' },
  { value: 'roboto', label: 'Roboto' },
  { value: 'merriweather', label: 'Merriweather' },
  { value: 'playfair', label: 'Playfair Display' },
  { value: 'oswald', label: 'Oswald' },
  { value: 'montserrat', label: 'Montserrat' },
];

// ─── Platform config ──────────────────────────────────────────────────────────

interface PlatformTab {
  key: VariantKey | 'article';
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bgColor: string;
  borderColor: string;
}

const PLATFORM_TABS: PlatformTab[] = [
  { key: 'article', label: 'Nota', icon: Pencil, color: 'text-cyan-400', bgColor: 'bg-cyan-400/10', borderColor: 'border-cyan-400/30' },
  { key: 'twitterThread', label: 'Twitter/X', icon: MessageSquare, color: 'text-sky-400', bgColor: 'bg-sky-400/10', borderColor: 'border-sky-400/30' },
  { key: 'instagramCarousel', label: 'Instagram', icon: Camera, color: 'text-pink-400', bgColor: 'bg-pink-400/10', borderColor: 'border-pink-400/30' },
  { key: 'linkedinPost', label: 'LinkedIn', icon: Briefcase, color: 'text-blue-400', bgColor: 'bg-blue-400/10', borderColor: 'border-blue-400/30' },
  { key: 'youtubeDescription', label: 'YouTube', icon: PlayCircle, color: 'text-red-400', bgColor: 'bg-red-400/10', borderColor: 'border-red-400/30' },
  { key: 'newsletterBlurb', label: 'Newsletter', icon: Mail, color: 'text-amber-400', bgColor: 'bg-amber-400/10', borderColor: 'border-amber-400/30' },
];

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };
  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
        copied
          ? 'bg-green-500/15 text-green-400 border border-green-500/25'
          : 'bg-white/[0.04] text-white/40 border border-white/[0.08] hover:bg-white/[0.08] hover:text-white/70'
      } ${className}`}
    >
      {copied ? (
        <>
          <CheckCheck className="w-3 h-3" />
          Copiado
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" />
          Copiar
        </>
      )}
    </button>
  );
}

// ─── Twitter Thread Preview ───────────────────────────────────────────────────

function TwitterThreadPreview({
  tweets,
  onRegenerate,
  regenerating,
}: {
  tweets: string[];
  onRegenerate: (prompt?: string) => void;
  regenerating: boolean;
}) {
  const [regenPrompt, setRegenPrompt] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/30">{tweets.length} tweets en el hilo</p>
        <div className="flex items-center gap-2">
          <CopyButton text={tweets.join('\n\n')} />
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-400/[0.08] text-sky-400 border border-sky-400/20 hover:bg-sky-400/[0.15] transition-colors"
          >
            <Wand2 className="w-3 h-3" />
            Regenerar
          </button>
        </div>
      </div>

      {showPrompt && (
        <div className="flex gap-2">
          <input
            type="text"
            value={regenPrompt}
            onChange={(e) => setRegenPrompt(e.target.value)}
            placeholder="Instrucción opcional (ej: más informal, con emojis...)"
            className="input-premium !py-2 !text-xs flex-1"
            disabled={regenerating}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRegenerate(regenPrompt || undefined);
                setShowPrompt(false);
                setRegenPrompt('');
              }
            }}
          />
          <button
            onClick={() => {
              onRegenerate(regenPrompt || undefined);
              setShowPrompt(false);
              setRegenPrompt('');
            }}
            disabled={regenerating}
            className="btn-primary !py-2 !px-4 !text-xs inline-flex items-center gap-1.5"
          >
            {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {regenerating ? 'Generando...' : 'Ir'}
          </button>
          <button onClick={() => setShowPrompt(false)} className="btn-secondary !py-2 !px-3 !text-xs">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="space-y-2">
        {tweets.map((tweet, i) => {
          const charCount = tweet.length;
          const isOver = charCount > 280;
          return (
            <div
              key={i}
              className="rounded-2xl bg-[#0f172a] border border-sky-400/[0.12] p-4 space-y-2"
            >
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-sky-400/20 flex items-center justify-center shrink-0">
                  <MessageSquare className="w-3.5 h-3.5 text-sky-400" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-white/70">Tu medio</p>
                  <p className="text-[10px] text-white/25">@tumedio · ahora</p>
                </div>
                <div className="ml-auto">
                  <span className={`text-[10px] font-mono ${isOver ? 'text-red-400' : charCount > 250 ? 'text-amber-400' : 'text-white/25'}`}>
                    {charCount}/280
                  </span>
                </div>
              </div>
              <p className="text-sm text-white/80 leading-relaxed whitespace-pre-wrap">{tweet}</p>
              <div className="flex items-center justify-between pt-1">
                <p className="text-[10px] text-white/20">Tweet {i + 1} de {tweets.length}</p>
                <CopyButton text={tweet} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Instagram Carousel Preview ───────────────────────────────────────────────

function InstagramCarouselPreview({
  slides,
  onRegenerate,
  regenerating,
}: {
  slides: string[];
  onRegenerate: (prompt?: string) => void;
  regenerating: boolean;
}) {
  const [activeSlide, setActiveSlide] = useState(0);
  const [regenPrompt, setRegenPrompt] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-white/30">{slides.length} slides en el carrusel</p>
        <div className="flex items-center gap-2">
          <CopyButton text={slides.join('\n\n---\n\n')} />
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-pink-400/[0.08] text-pink-400 border border-pink-400/20 hover:bg-pink-400/[0.15] transition-colors"
          >
            <Wand2 className="w-3 h-3" />
            Regenerar
          </button>
        </div>
      </div>

      {showPrompt && (
        <div className="flex gap-2">
          <input
            type="text"
            value={regenPrompt}
            onChange={(e) => setRegenPrompt(e.target.value)}
            placeholder="Instrucción opcional (ej: más visual, con preguntas...)"
            className="input-premium !py-2 !text-xs flex-1"
            disabled={regenerating}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRegenerate(regenPrompt || undefined);
                setShowPrompt(false);
                setRegenPrompt('');
              }
            }}
          />
          <button
            onClick={() => {
              onRegenerate(regenPrompt || undefined);
              setShowPrompt(false);
              setRegenPrompt('');
            }}
            disabled={regenerating}
            className="btn-primary !py-2 !px-4 !text-xs inline-flex items-center gap-1.5"
          >
            {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {regenerating ? 'Generando...' : 'Ir'}
          </button>
          <button onClick={() => setShowPrompt(false)} className="btn-secondary !py-2 !px-3 !text-xs">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Slide navigator */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {slides.map((_, i) => (
          <button
            key={i}
            onClick={() => setActiveSlide(i)}
            className={`w-7 h-7 rounded-lg text-xs font-bold transition-all duration-150 ${
              activeSlide === i
                ? 'bg-pink-400/20 text-pink-400 border border-pink-400/40'
                : 'bg-white/[0.04] text-white/30 border border-white/[0.08] hover:bg-white/[0.08]'
            }`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {/* Active slide */}
      <div className="rounded-2xl overflow-hidden border border-pink-400/[0.15] bg-gradient-to-br from-pink-950/30 via-purple-950/20 to-[#0c1018]">
        {/* Phone chrome */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <div className="w-6 h-6 rounded-full bg-pink-400/20 flex items-center justify-center">
            <Camera className="w-3 h-3 text-pink-400" />
          </div>
          <span className="text-xs text-white/40 font-medium">tumedio</span>
          <div className="ml-auto flex items-center gap-1">
            {slides.map((_, i) => (
              <div
                key={i}
                className={`h-0.5 rounded-full transition-all duration-200 ${
                  i === activeSlide ? 'w-4 bg-pink-400' : 'w-2 bg-white/20'
                }`}
              />
            ))}
          </div>
        </div>
        <div className="p-6 min-h-[160px] flex flex-col justify-center">
          <p className="text-base text-white/80 leading-relaxed text-center whitespace-pre-wrap">
            {slides[activeSlide]}
          </p>
        </div>
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.06]">
          <p className="text-[10px] text-white/25">Slide {activeSlide + 1} / {slides.length}</p>
          <CopyButton text={slides[activeSlide]} />
        </div>
      </div>
    </div>
  );
}

// ─── Generic text variant preview ────────────────────────────────────────────

interface TextVariantPreviewProps {
  content: string;
  platform: PlatformTab;
  onRegenerate: (prompt?: string) => void;
  regenerating: boolean;
}

function TextVariantPreview({ content, platform, onRegenerate, regenerating }: TextVariantPreviewProps) {
  const [regenPrompt, setRegenPrompt] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const Icon = platform.icon;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-lg ${platform.bgColor} flex items-center justify-center`}>
            <Icon className={`w-3 h-3 ${platform.color}`} />
          </div>
          <span className="text-xs text-white/30">{platform.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton text={content} />
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${platform.bgColor} ${platform.color} border ${platform.borderColor} hover:opacity-80 transition-opacity`}
          >
            <Wand2 className="w-3 h-3" />
            Regenerar
          </button>
        </div>
      </div>

      {showPrompt && (
        <div className="flex gap-2">
          <input
            type="text"
            value={regenPrompt}
            onChange={(e) => setRegenPrompt(e.target.value)}
            placeholder="Instrucción opcional para la regeneración..."
            className="input-premium !py-2 !text-xs flex-1"
            disabled={regenerating}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRegenerate(regenPrompt || undefined);
                setShowPrompt(false);
                setRegenPrompt('');
              }
            }}
          />
          <button
            onClick={() => {
              onRegenerate(regenPrompt || undefined);
              setShowPrompt(false);
              setRegenPrompt('');
            }}
            disabled={regenerating}
            className="btn-primary !py-2 !px-4 !text-xs inline-flex items-center gap-1.5"
          >
            {regenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {regenerating ? 'Generando...' : 'Ir'}
          </button>
          <button onClick={() => setShowPrompt(false)} className="btn-secondary !py-2 !px-3 !text-xs">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className={`rounded-2xl border ${platform.borderColor} bg-gradient-to-br from-white/[0.02] to-transparent p-5`}>
        {regenerating ? (
          <div className="flex items-center gap-3 py-8 justify-center">
            <Loader2 className={`w-5 h-5 animate-spin ${platform.color}`} />
            <span className="text-sm text-white/40">Generando variante...</span>
          </div>
        ) : (
          <p className="text-sm text-white/70 leading-relaxed whitespace-pre-wrap">{content}</p>
        )}
      </div>
    </div>
  );
}

// ─── Content Variants Panel ───────────────────────────────────────────────────

interface ContentVariantsPanelProps {
  publicationId: string;
  pub: ReviewPublication;
  onVariantsUpdated: (variants: ContentVariants) => void;
}

function ContentVariantsPanel({ publicationId, pub, onVariantsUpdated }: ContentVariantsPanelProps) {
  const { fetchApi } = useApi();
  const [activePlatform, setActivePlatform] = useState<VariantKey | 'article'>('article');
  const [regeneratingVariant, setRegeneratingVariant] = useState<VariantKey | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState('');

  const variants = pub.contentVariants;

  const handleGenerateVariants = async () => {
    setGenerating(true);
    setGenError('');
    try {
      const data = await fetchApi<{ success: boolean; variants: ContentVariants }>(
        `/review/${publicationId}/generate-variants`,
        { method: 'POST' }
      );
      onVariantsUpdated(data.variants);
    } catch (err: any) {
      setGenError(err.message || 'Error al generar variantes');
    }
    setGenerating(false);
  };

  const handleRegenerate = async (variantKey: VariantKey, customPrompt?: string) => {
    setRegeneratingVariant(variantKey);
    try {
      const data = await fetchApi<{ success: boolean; variant: VariantKey; content: unknown }>(
        `/review/${publicationId}/regenerate-variant`,
        { method: 'POST', body: { variant: variantKey, prompt: customPrompt } }
      );
      if (variants) {
        onVariantsUpdated({ ...variants, [data.variant]: data.content });
      }
    } catch { /* ignore */ }
    setRegeneratingVariant(null);
  };

  const activePlatformInfo = PLATFORM_TABS.find((t) => t.key === activePlatform)!;

  return (
    <div className="space-y-4">
      {/* Platform tab bar */}
      <div className="flex items-center gap-1 flex-wrap border-b border-white/[0.06] pb-3">
        {PLATFORM_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activePlatform === tab.key;
          const hasVariant = tab.key === 'article' || !!(variants?.[tab.key as VariantKey]);
          return (
            <button
              key={tab.key}
              onClick={() => setActivePlatform(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all duration-150 ${
                isActive
                  ? `${tab.bgColor} ${tab.color} border ${tab.borderColor}`
                  : `text-white/35 hover:text-white/60 hover:bg-white/[0.04] ${!hasVariant ? 'opacity-50' : ''}`
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
              {!hasVariant && tab.key !== 'article' && (
                <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
              )}
            </button>
          );
        })}
      </div>

      {/* Content area */}
      {activePlatform === 'article' ? (
        /* Nota original */
        <div className="space-y-3">
          <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] p-5 min-h-[200px]">
            <h3 className="text-sm font-bold text-white/90 leading-snug mb-3">{pub.title}</h3>
            <p className="text-sm text-white/55 leading-relaxed whitespace-pre-wrap">{pub.content}</p>
          </div>
        </div>
      ) : !variants ? (
        /* No hay variantes — botón para generar */
        <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] p-8 text-center space-y-4">
          <div className="w-12 h-12 rounded-2xl bg-cyan-400/10 flex items-center justify-center mx-auto">
            <Layers className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white/70 mb-1">
              Sin variantes de contenido
            </p>
            <p className="text-xs text-white/30">
              Generá versiones optimizadas para Twitter, Instagram, LinkedIn, YouTube y Newsletter en un solo clic.
            </p>
          </div>
          {genError && (
            <p className="text-xs text-red-400">{genError}</p>
          )}
          <button
            onClick={handleGenerateVariants}
            disabled={generating}
            className="btn-primary inline-flex items-center gap-2 !py-2.5 !px-5 !text-sm"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Generando variantes...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generar variantes multiplataforma
              </>
            )}
          </button>
        </div>
      ) : activePlatform === 'twitterThread' ? (
        <TwitterThreadPreview
          tweets={variants.twitterThread}
          onRegenerate={(prompt) => handleRegenerate('twitterThread', prompt)}
          regenerating={regeneratingVariant === 'twitterThread'}
        />
      ) : activePlatform === 'instagramCarousel' ? (
        <InstagramCarouselPreview
          slides={variants.instagramCarousel}
          onRegenerate={(prompt) => handleRegenerate('instagramCarousel', prompt)}
          regenerating={regeneratingVariant === 'instagramCarousel'}
        />
      ) : (
        <TextVariantPreview
          content={variants[activePlatform as keyof ContentVariants] as string}
          platform={activePlatformInfo}
          onRegenerate={(prompt) => handleRegenerate(activePlatform as VariantKey, prompt)}
          regenerating={regeneratingVariant === activePlatform}
        />
      )}
    </div>
  );
}

// ─── Review Detail Modal ──────────────────────────────────────────────────────

interface ReviewDetailModalProps {
  publicationId: string;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onUpdated: () => void;
}

function ReviewDetailModal({
  publicationId,
  onClose,
  onApprove,
  onReject,
  onUpdated,
}: ReviewDetailModalProps) {
  const { fetchApi } = useApi();

  const [pub, setPub] = useState<ReviewPublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Modal content tab: 'content' | 'variants'
  const [modalTab, setModalTab] = useState<'content' | 'variants'>('content');

  // Text edit state
  const [showTextEdit, setShowTextEdit] = useState(false);
  const [textPrompt, setTextPrompt] = useState('');
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState('');

  // Image edit state
  const [showImageEdit, setShowImageEdit] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('default');
  const [selectedFont, setSelectedFont] = useState('inter');
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState('');

  // History
  const [historyOpen, setHistoryOpen] = useState(false);

  // Action states
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const loadPublication = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchApi<ReviewPublication>(`/review/${publicationId}`);
      setPub(data);
    } catch (err: any) {
      setError(err.message || 'Error al cargar la publicación');
    }
    setLoading(false);
  }, [publicationId, fetchApi]);

  useEffect(() => {
    loadPublication();
  }, [loadPublication]);

  const handleApprove = async () => {
    if (!pub) return;
    setApproving(true);
    try {
      await fetchApi(`/review/${pub.id}/approve`, { method: 'POST' });
      onApprove(pub.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error al aprobar');
    }
    setApproving(false);
  };

  const handleReject = async () => {
    if (!pub) return;
    setRejecting(true);
    try {
      await fetchApi(`/review/${pub.id}/reject`, { method: 'POST' });
      onReject(pub.id);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Error al rechazar');
    }
    setRejecting(false);
  };

  const handleTextEdit = async () => {
    if (!pub || !textPrompt.trim()) return;
    setTextLoading(true);
    setTextError('');
    try {
      const data = await fetchApi<{ publication: ReviewPublication }>(
        `/review/${pub.id}/edit-text`,
        { method: 'POST', body: { prompt: textPrompt.trim() } }
      );
      setPub(data.publication);
      setTextPrompt('');
      setShowTextEdit(false);
      onUpdated();
    } catch (err: any) {
      setTextError(err.message || 'Error al editar el texto');
    }
    setTextLoading(false);
  };

  const handleImageEdit = async () => {
    if (!pub) return;
    setImageLoading(true);
    setImageError('');
    try {
      const data = await fetchApi<{ publication: ReviewPublication }>(
        `/review/${pub.id}/edit-image`,
        {
          method: 'POST',
          body: {
            templateId: selectedTemplate,
            fontFamily: selectedFont,
            prompt: imagePrompt.trim() || undefined,
          },
        }
      );
      setPub(data.publication);
      setShowImageEdit(false);
      onUpdated();
    } catch (err: any) {
      setImageError(err.message || 'Error al regenerar la imagen');
    }
    setImageLoading(false);
  };

  const hasVariants = !!pub?.contentVariants;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-content w-full" style={{ maxWidth: '1040px' }}>
        {/* Header */}
        <div className="modal-header">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-cyan-400/[0.1] flex items-center justify-center">
              <Eye className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white/85">
                {loading ? 'Cargando...' : (pub?.title ?? 'Revisión de contenido')}
              </h2>
              {pub && (
                <p className="text-xs text-white/30 mt-0.5">
                  {timeAgo(pub.createdAt)} ·{' '}
                  <span className={STATUS_BADGE[pub.status]}>
                    {STATUS_LABELS[pub.status]}
                  </span>
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4 text-white/50" />
          </button>
        </div>

        {/* Modal tab switcher */}
        {pub && (
          <div className="flex items-center gap-1 px-6 pt-4 border-b border-white/[0.06]">
            <button
              onClick={() => setModalTab('content')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                modalTab === 'content'
                  ? 'border-cyan-400 text-cyan-400'
                  : 'border-transparent text-white/40 hover:text-white/60'
              }`}
            >
              Contenido
            </button>
            <button
              onClick={() => setModalTab('variants')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
                modalTab === 'variants'
                  ? 'border-cyan-400 text-cyan-400'
                  : 'border-transparent text-white/40 hover:text-white/60'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Variantes
              {hasVariants && (
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
              )}
            </button>
          </div>
        )}

        {/* Body */}
        <div className="modal-body">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
            </div>
          ) : error && !pub ? (
            <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/[0.06] border border-red-500/15 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : pub ? (
            <div className="space-y-6">
              {/* Error banner */}
              {error && (
                <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/[0.06] border border-red-500/15 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* ── CONTENIDO TAB ── */}
              {modalTab === 'content' && (
                <>
                  {/* Split view */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {/* LEFT — Article text */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Pencil className="w-3.5 h-3.5 text-white/30" />
                        <span className="text-xs font-medium text-white/40 uppercase tracking-wider">
                          Artículo
                        </span>
                      </div>
                      <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] p-5 space-y-3 min-h-[280px]">
                        <h3 className="text-sm font-bold text-white/90 leading-snug">
                          {pub.title}
                        </h3>
                        <p className="text-sm text-white/55 leading-relaxed whitespace-pre-wrap">
                          {pub.content}
                        </p>
                      </div>

                      {/* Text edit */}
                      {showTextEdit ? (
                        <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] p-4 space-y-3">
                          <label className="text-xs font-medium text-white/40 uppercase tracking-wider block">
                            ¿Qué querés cambiar?
                          </label>
                          <textarea
                            value={textPrompt}
                            onChange={(e) => setTextPrompt(e.target.value)}
                            className="input-premium resize-none text-sm"
                            rows={3}
                            placeholder="Ej: hacelo más corto, cambiá el tono a formal..."
                            disabled={textLoading}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleTextEdit();
                              }
                            }}
                          />
                          {textError && (
                            <p className="text-xs text-red-400">{textError}</p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setShowTextEdit(false);
                                setTextPrompt('');
                                setTextError('');
                              }}
                              className="btn-secondary !py-2 !px-4 !text-xs"
                              disabled={textLoading}
                            >
                              Cancelar
                            </button>
                            <button
                              onClick={handleTextEdit}
                              disabled={textLoading || !textPrompt.trim()}
                              className="btn-primary !py-2 !px-4 !text-xs inline-flex items-center gap-2"
                            >
                              {textLoading ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  Procesando...
                                </>
                              ) : (
                                <>
                                  <Wand2 className="w-3.5 h-3.5" />
                                  Aplicar
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setShowTextEdit(true);
                            setShowImageEdit(false);
                          }}
                          className="btn-secondary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                        >
                          <Wand2 className="w-4 h-4" />
                          Editar texto
                        </button>
                      )}
                    </div>

                    {/* RIGHT — Flyer preview */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <ImageIcon className="w-3.5 h-3.5 text-white/30" />
                        <span className="text-xs font-medium text-white/40 uppercase tracking-wider">
                          Flyer
                        </span>
                      </div>
                      <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden min-h-[280px] flex items-center justify-center relative">
                        {pub.imageUrl ? (
                          <img
                            src={pub.imageUrl}
                            alt={pub.title}
                            className="w-full h-full object-contain max-h-[400px]"
                            key={pub.imageUrl}
                          />
                        ) : (
                          <div className="flex flex-col items-center gap-3 py-16">
                            <FileImage className="w-10 h-10 text-white/10" />
                            <p className="text-xs text-white/20">Sin imagen</p>
                          </div>
                        )}
                        {imageLoading && (
                          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center">
                            <div className="flex flex-col items-center gap-3">
                              <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                              <p className="text-xs text-white/50">Regenerando flyer...</p>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Image edit */}
                      {showImageEdit ? (
                        <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] p-4 space-y-4">
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">
                                Template
                              </label>
                              <div className="relative">
                                <select
                                  value={selectedTemplate}
                                  onChange={(e) => setSelectedTemplate(e.target.value)}
                                  className="input-premium appearance-none pr-8 !py-3 !text-sm cursor-pointer"
                                  disabled={imageLoading}
                                >
                                  {TEMPLATE_OPTIONS.map((t) => (
                                    <option key={t.value} value={t.value} className="bg-[#0c1018]">
                                      {t.label}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                              </div>
                            </div>
                            <div>
                              <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">
                                Fuente
                              </label>
                              <div className="relative">
                                <select
                                  value={selectedFont}
                                  onChange={(e) => setSelectedFont(e.target.value)}
                                  className="input-premium appearance-none pr-8 !py-3 !text-sm cursor-pointer"
                                  disabled={imageLoading}
                                >
                                  {FONT_OPTIONS.map((f) => (
                                    <option key={f.value} value={f.value} className="bg-[#0c1018]">
                                      {f.label}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown className="w-3.5 h-3.5 text-white/30 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                              </div>
                            </div>
                          </div>
                          <div>
                            <label className="text-xs font-medium text-white/40 uppercase tracking-wider mb-2 block">
                              Instrucción adicional (opcional)
                            </label>
                            <input
                              type="text"
                              value={imagePrompt}
                              onChange={(e) => setImagePrompt(e.target.value)}
                              className="input-premium !py-3 !text-sm"
                              placeholder="Ej: usá colores azules, estilo urgente..."
                              disabled={imageLoading}
                            />
                          </div>
                          {imageError && (
                            <p className="text-xs text-red-400">{imageError}</p>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                setShowImageEdit(false);
                                setImageError('');
                              }}
                              className="btn-secondary !py-2 !px-4 !text-xs"
                              disabled={imageLoading}
                            >
                              Cancelar
                            </button>
                            <button
                              onClick={handleImageEdit}
                              disabled={imageLoading}
                              className="btn-primary !py-2 !px-4 !text-xs inline-flex items-center gap-2"
                            >
                              {imageLoading ? (
                                <>
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  Regenerando...
                                </>
                              ) : (
                                <>
                                  <RefreshCw className="w-3.5 h-3.5" />
                                  Regenerar
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setShowImageEdit(true);
                            setShowTextEdit(false);
                          }}
                          className="btn-secondary inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
                        >
                          <ImageIcon className="w-4 h-4" />
                          Editar imagen
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Edit history */}
                  {(pub.editHistory?.length ?? 0) > 0 && (
                    <div className="rounded-2xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
                      <button
                        onClick={() => setHistoryOpen(!historyOpen)}
                        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-white/[0.02] transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <Clock className="w-3.5 h-3.5 text-white/30" />
                          <span className="text-xs font-medium text-white/40 uppercase tracking-wider">
                            Historial de ediciones ({pub.editHistory!.length})
                          </span>
                        </div>
                        {historyOpen ? (
                          <ChevronUp className="w-4 h-4 text-white/25" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-white/25" />
                        )}
                      </button>
                      {historyOpen && (
                        <div className="border-t border-white/[0.05] divide-y divide-white/[0.04]">
                          {pub.editHistory!.map((entry) => (
                            <div key={entry.id} className="flex items-start gap-3 px-5 py-3">
                              <div
                                className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                                  entry.type === 'text'
                                    ? 'bg-cyan-400/10'
                                    : 'bg-purple-400/10'
                                }`}
                              >
                                {entry.type === 'text' ? (
                                  <Wand2 className="w-3 h-3 text-cyan-400" />
                                ) : (
                                  <ImageIcon className="w-3 h-3 text-purple-400" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-white/60">
                                  {entry.type === 'text' ? 'Texto editado' : 'Imagen regenerada'}
                                  {entry.prompt && (
                                    <span className="text-white/30"> — "{entry.prompt}"</span>
                                  )}
                                </p>
                                <p className="text-xs text-white/25 mt-0.5">
                                  {timeAgo(entry.createdAt)}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* ── VARIANTES TAB ── */}
              {modalTab === 'variants' && (
                <ContentVariantsPanel
                  publicationId={pub.id}
                  pub={pub}
                  onVariantsUpdated={(variants) => {
                    setPub((prev) => prev ? { ...prev, contentVariants: variants } : prev);
                    onUpdated();
                  }}
                />
              )}
            </div>
          ) : null}
        </div>

        {/* Footer actions */}
        {pub && pub.status === 'pending_review' && (
          <div className="modal-footer">
            <button
              onClick={handleReject}
              disabled={rejecting || approving}
              className="btn-danger !py-2.5 !px-5 !text-sm inline-flex items-center gap-2 mr-auto"
            >
              {rejecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <XCircle className="w-4 h-4" />
              )}
              Rechazar
            </button>
            <button
              onClick={onClose}
              className="btn-secondary !py-2.5 !px-5 !text-sm"
              disabled={approving || rejecting}
            >
              Cerrar
            </button>
            <button
              onClick={handleApprove}
              disabled={approving || rejecting}
              className="btn-primary !py-2.5 !px-5 !text-sm inline-flex items-center gap-2"
            >
              {approving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              Aprobar y publicar
            </button>
          </div>
        )}
        {pub && pub.status !== 'pending_review' && (
          <div className="modal-footer">
            <button
              onClick={onClose}
              className="btn-secondary !py-2.5 !px-5 !text-sm"
            >
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Review Page ──────────────────────────────────────────────────────────────

export function ReviewPage() {
  const { fetchApi } = useApi();

  const [activeTab, setActiveTab] = useState<ReviewStatus>('pending_review');
  const [publications, setPublications] = useState<ReviewPublication[]>([]);
  const [tabCounts, setTabCounts] = useState<Record<ReviewStatus, number>>({
    pending_review: 0,
    published: 0,
    rejected: 0,
  });
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [actionError, setActionError] = useState('');

  const loadPublications = useCallback(
    async (status: ReviewStatus) => {
      setLoading(true);
      setSelectedIds(new Set());
      setActionError('');
      try {
        const data = await fetchApi<{ publications: ReviewPublication[]; total: number }>(
          `/review?status=${status}&limit=50&offset=0`
        );
        setPublications(data.publications ?? []);
        setTabCounts((prev) => ({ ...prev, [status]: data.total ?? 0 }));
      } catch {
        setPublications([]);
      }
      setLoading(false);
    },
    [fetchApi]
  );

  const loadAllCounts = useCallback(async () => {
    const statuses: ReviewStatus[] = ['pending_review', 'published', 'rejected'];
    await Promise.allSettled(
      statuses.map(async (s) => {
        try {
          const d = await fetchApi<{ total: number }>(
            `/review?status=${s}&limit=1&offset=0`
          );
          setTabCounts((prev) => ({ ...prev, [s]: d.total ?? 0 }));
        } catch { /* ignore */ }
      })
    );
  }, [fetchApi]);

  useEffect(() => {
    loadAllCounts();
  }, [loadAllCounts]);

  useEffect(() => {
    loadPublications(activeTab);
  }, [activeTab, loadPublications]);

  const handleTabChange = (tab: ReviewStatus) => {
    setActiveTab(tab);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === publications.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(publications.map((p) => p.id)));
    }
  };

  const handleBatchAction = async (action: 'approve' | 'reject') => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    setActionError('');
    try {
      await fetchApi('/review/batch', {
        method: 'POST',
        body: { ids: Array.from(selectedIds), action },
      });
      await loadPublications(activeTab);
      await loadAllCounts();
    } catch (err: any) {
      setActionError(err.message || 'Error en la operación');
    }
    setBatchLoading(false);
  };

  const handleApproveOne = async (id: string) => {
    setPublications((prev) => prev.filter((p) => p.id !== id));
    setTabCounts((prev) => ({
      ...prev,
      pending_review: Math.max(0, prev.pending_review - 1),
      published: prev.published + 1,
    }));
  };

  const handleRejectOne = async (id: string) => {
    setPublications((prev) => prev.filter((p) => p.id !== id));
    setTabCounts((prev) => ({
      ...prev,
      pending_review: Math.max(0, prev.pending_review - 1),
      rejected: prev.rejected + 1,
    }));
  };

  const handleApproveCard = async (id: string) => {
    setActionError('');
    try {
      await fetchApi(`/review/${id}/approve`, { method: 'POST' });
      handleApproveOne(id);
    } catch (err: any) {
      setActionError(err.message || 'Error al aprobar');
    }
  };

  const handleRejectCard = async (id: string) => {
    setActionError('');
    try {
      await fetchApi(`/review/${id}/reject`, { method: 'POST' });
      handleRejectOne(id);
    } catch (err: any) {
      setActionError(err.message || 'Error al rechazar');
    }
  };

  const pendingOnly = activeTab === 'pending_review';

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-400/[0.1] flex items-center justify-center">
            <ClipboardCheck className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white/90 tracking-tight">
              Revisión de Contenido
            </h1>
            <p className="text-xs text-white/30 mt-0.5">
              Revisá y aprobá las publicaciones generadas por la IA
            </p>
          </div>
        </div>

        {/* Batch actions */}
        {pendingOnly && selectedIds.size > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-white/40 mr-1">
              {selectedIds.size} seleccionado{selectedIds.size !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => handleBatchAction('approve')}
              disabled={batchLoading}
              className="btn-primary !py-2 !px-4 !text-xs inline-flex items-center gap-2"
            >
              {batchLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Aprobar seleccionados
            </button>
            <button
              onClick={() => handleBatchAction('reject')}
              disabled={batchLoading}
              className="btn-danger !py-2 !px-4 !text-xs inline-flex items-center gap-2"
            >
              {batchLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <X className="w-3.5 h-3.5" />
              )}
              Rechazar seleccionados
            </button>
          </div>
        )}
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 border-b border-white/[0.06] mb-6">
        {TAB_STATUSES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => handleTabChange(key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
              activeTab === key
                ? 'border-cyan-400 text-cyan-400'
                : 'border-transparent text-white/40 hover:text-white/60'
            }`}
          >
            {label}
            {tabCounts[key] > 0 && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full font-semibold ${
                  activeTab === key
                    ? 'bg-cyan-400/15 text-cyan-400'
                    : 'bg-white/[0.06] text-white/30'
                }`}
              >
                {tabCounts[key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Error */}
      {actionError && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/[0.06] border border-red-500/15 text-red-400 text-sm mb-5">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {/* Content list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-24 rounded-2xl" />
          ))}
        </div>
      ) : publications.length === 0 ? (
        <div className="glass-card-static p-16 text-center">
          <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-4 ring-1 ring-white/[0.06]">
            <ClipboardCheck className="w-6 h-6 text-white/15" />
          </div>
          <p className="text-white/30 text-sm">
            {activeTab === 'pending_review'
              ? 'No hay contenido pendiente de revisión'
              : activeTab === 'published'
              ? 'No hay publicaciones aprobadas todavía'
              : 'No hay publicaciones rechazadas'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Select all row — only for pending */}
          {pendingOnly && publications.length > 1 && (
            <div className="flex items-center gap-3 px-2 pb-1">
              <input
                type="checkbox"
                checked={selectedIds.size === publications.length}
                onChange={toggleSelectAll}
                className="w-4 h-4 rounded accent-cyan-400 cursor-pointer"
              />
              <span className="text-xs text-white/30">Seleccionar todos</span>
            </div>
          )}

          {publications.map((pub) => (
            <div
              key={pub.id}
              className={`rounded-2xl bg-white/[0.02] border transition-all duration-200 ${
                selectedIds.has(pub.id)
                  ? 'border-cyan-400/30 bg-cyan-400/[0.03]'
                  : 'border-white/[0.06] hover:border-white/[0.1]'
              }`}
            >
              <div className="flex items-center gap-4 p-4">
                {/* Checkbox — only for pending */}
                {pendingOnly && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(pub.id)}
                    onChange={() => toggleSelect(pub.id)}
                    className="w-4 h-4 rounded accent-cyan-400 cursor-pointer shrink-0"
                  />
                )}

                {/* Thumbnail */}
                <div className="w-16 h-16 rounded-xl bg-white/[0.04] border border-white/[0.07] overflow-hidden flex items-center justify-center shrink-0">
                  {pub.imageUrl ? (
                    <img
                      src={pub.imageUrl}
                      alt={pub.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <FileImage className="w-5 h-5 text-white/15" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-white/85 truncate flex-1 min-w-0">
                      {pub.title}
                    </h3>
                    <div className="flex items-center gap-1.5">
                      {pub.contentVariants && (
                        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-cyan-400/10 text-cyan-400 border border-cyan-400/20 font-medium">
                          <Layers className="w-2.5 h-2.5" />
                          5 variantes
                        </span>
                      )}
                      <span className={STATUS_BADGE[pub.status]}>
                        {STATUS_LABELS[pub.status]}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-white/40 mt-1 line-clamp-2 leading-relaxed">
                    {pub.content?.slice(0, 100)}
                    {(pub.content?.length ?? 0) > 100 ? '...' : ''}
                  </p>
                  <p className="text-xs text-white/25 mt-1.5">
                    {timeAgo(pub.createdAt)}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setDetailId(pub.id)}
                    className="w-8 h-8 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center transition-colors text-white/40 hover:text-white/70"
                    title="Ver detalle"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                  {pendingOnly && (
                    <>
                      <button
                        onClick={() => handleApproveCard(pub.id)}
                        className="w-8 h-8 rounded-lg bg-green-500/[0.08] hover:bg-green-500/[0.15] flex items-center justify-center transition-colors text-green-400"
                        title="Aprobar"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleRejectCard(pub.id)}
                        className="w-8 h-8 rounded-lg bg-red-500/[0.08] hover:bg-red-500/[0.15] flex items-center justify-center transition-colors text-red-400"
                        title="Rechazar"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {detailId && (
        <ReviewDetailModal
          publicationId={detailId}
          onClose={() => setDetailId(null)}
          onApprove={(id) => {
            handleApproveOne(id);
            loadAllCounts();
          }}
          onReject={(id) => {
            handleRejectOne(id);
            loadAllCounts();
          }}
          onUpdated={() => loadPublications(activeTab)}
        />
      )}
    </div>
  );
}
