import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from './hooks/useSocket';
import type {
  PipelineConfig,
  Publication,
  Transcription,
  MetaStatus,
  WebhookSettings,
  ActivityCardData,
  SubStep,
  PipelineStep,
  PipelineUpdateEvent,
  HistoryTab,
  STEP_META,
  PIPELINE_STEPS,
  DETAIL_ICONS,
} from './types';
import {
  STEP_META as stepMeta,
  PIPELINE_STEPS as pipelineSteps,
  DETAIL_ICONS as detailIcons,
} from './types';

// ─── Utility ────────────────────────────────────────────────

function getIcon(name?: string): string {
  if (!name) return '•';
  return detailIcons[name] || '•';
}

let cardIdCounter = 0;
function nextCardId(): string {
  return `card-${++cardIdCounter}`;
}

// ─── Inline SVG icons ───────────────────────────────────────

const PlayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
);
const StopIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
);
const PipelineIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>
);
const FacebookIcon = ({ size = 20, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
  </svg>
);
const SettingsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
const ToolsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18m-9-9h18" /></svg>
);
const HistoryIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
);
const ChevronIcon = () => (
  <svg className="chevron-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
);

// ═══════════════════════════════════════════════════════════
// App
// ═══════════════════════════════════════════════════════════

export default function App() {
  const { socket, connected } = useSocket();

  return (
    <>
      <TopBar />
      <main className="main-container">
        <PipelineControl socket={socket} />
        <MetaConnection />
        <WebhookSettingsSection />
        <ManualTools />
        <History socket={socket} />
      </main>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// TopBar
// ═══════════════════════════════════════════════════════════

function TopBar() {
  return (
    <header className="top-bar">
      <div className="top-bar-inner">
        <div className="top-bar-brand">
          <img src="/logo.png" alt="Radio Uno" className="top-bar-logo" />
          <div>
            <h1 className="top-bar-title">Radio Uno Formosa</h1>
            <p className="top-bar-subtitle">Centro de Noticias Inteligente</p>
          </div>
        </div>
        <div className="top-bar-badges">
          <span className="badge badge-ai">DeepSeek AI</span>
          <span className="badge badge-ai">Gemini</span>
        </div>
      </div>
    </header>
  );
}

// ═══════════════════════════════════════════════════════════
// PipelineControl (hero section)
// ═══════════════════════════════════════════════════════════

function PipelineControl({ socket }: { socket: ReturnType<typeof useSocket>['socket'] }) {
  // Config form
  const [url, setUrl] = useState('');
  const [tone, setTone] = useState('formal');
  const [structure, setStructure] = useState('completa');
  const [imageModel, setImageModel] = useState('gemini');
  const [segmentDuration, setSegmentDuration] = useState(120);
  const [autoPublish, setAutoPublish] = useState(true);

  // Pipeline state
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState('Inactivo');
  const [statusClass, setStatusClass] = useState('');
  const [showStatus, setShowStatus] = useState(false);
  const [activeStep, setActiveStep] = useState<string>('');

  // Activity feed
  const [activityCards, setActivityCards] = useState<ActivityCardData[]>([]);
  const captureCardIdRef = useRef<string | null>(null);
  const processingCardIdRef = useRef<string | null>(null);
  const activityFeedRef = useRef<HTMLDivElement>(null);

  // Published notes
  const [publishedNotes, setPublishedNotes] = useState<Array<{ title: string; content?: string; previewUrl?: string; timestamp: string }>>([]);
  const [pendingNote, setPendingNote] = useState<{ title?: string; content?: string; previewUrl?: string }>({});
  const pendingNoteRef = useRef<{ title?: string; content?: string; previewUrl?: string }>({});
  const [selectedNote, setSelectedNote] = useState<{ title: string; content?: string; previewUrl?: string; timestamp: string } | null>(null);

  // Transcription
  const [transcription, setTranscription] = useState('');

  // Lightbox
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Image model hint
  const modelHints: Record<string, string> = {
    gemini: 'Requiere GEMINI_API_KEY en el servidor',
    grok: 'Requiere XAI_API_KEY en el servidor',
  };

  // ─── Card helpers ─────────────────────────────────────────

  const markCardStatus = useCallback((cardId: string | null, status: 'done' | 'error') => {
    if (!cardId) return;
    setActivityCards(prev => prev.map(c =>
      c.id === cardId ? { ...c, status } : c
    ));
  }, []);

  const getOrCreateCaptureCard = useCallback((): string => {
    if (captureCardIdRef.current) return captureCardIdRef.current;
    const id = nextCardId();
    captureCardIdRef.current = id;
    const meta = stepMeta.capturing;
    setActivityCards(prev => [...prev, {
      id, icon: meta.icon, title: meta.label, status: 'active', subSteps: [],
    }]);
    return id;
  }, []);

  const getOrCreateProcessingCard = useCallback((stepName: string, topicLabel?: string | null): string => {
    // Mark previous processing card as done
    if (processingCardIdRef.current) {
      markCardStatus(processingCardIdRef.current, 'done');
    }
    const id = nextCardId();
    processingCardIdRef.current = id;
    const meta = stepMeta[stepName as PipelineStep] || { icon: '⚙️', label: stepName };
    const label = topicLabel ? `${meta.label}: ${topicLabel}` : meta.label;
    setActivityCards(prev => [...prev, {
      id, icon: meta.icon, title: label, status: 'active', subSteps: [],
    }]);
    return id;
  }, [markCardStatus]);

  const addSubStepToCard = useCallback((cardId: string | null, text: string, icon?: string, className?: SubStep['className']) => {
    if (!cardId) return;
    setActivityCards(prev => prev.map(c =>
      c.id === cardId
        ? { ...c, subSteps: [...c.subSteps, { icon: getIcon(icon), text, className: className || '' }] }
        : c
    ));
  }, []);

  const addPreviewToCard = useCallback((cardId: string | null, previewUrl: string) => {
    if (!cardId) return;
    setActivityCards(prev => prev.map(c =>
      c.id === cardId ? { ...c, previewUrl } : c
    ));
  }, []);

  const updateCardTitle = useCallback((cardId: string | null, title: string) => {
    if (!cardId) return;
    setActivityCards(prev => prev.map(c =>
      c.id === cardId ? { ...c, title } : c
    ));
  }, []);

  // ─── Step progress ────────────────────────────────────────

  const updateStepUI = useCallback((step: string) => {
    setActiveStep(step);
  }, []);

  // ─── Socket events ───────────────────────────────────────

  useEffect(() => {
    if (!socket) return;

    const handler = (data: PipelineUpdateEvent) => {
      switch (data.event) {
        case 'step': {
          updateStepUI(data.step || '');

          if (data.step === 'capturing') {
            const ccId = getOrCreateCaptureCard();
            updateCardTitle(ccId, data.message || stepMeta.capturing.label);
            if (processingCardIdRef.current) {
              markCardStatus(processingCardIdRef.current, 'done');
              processingCardIdRef.current = null;
            }
          } else if (data.step && data.step !== 'waiting') {
            const topicMatch = data.message?.match(/["":]"?([^""]+)"?$/);
            const topic = topicMatch ? topicMatch[1] : null;
            getOrCreateProcessingCard(data.step, topic);
          }
          break;
        }

        case 'detail': {
          const targetId = data.step === 'capturing'
            ? captureCardIdRef.current || getOrCreateCaptureCard()
            : processingCardIdRef.current;
          const isCheck = data.icon === 'check';
          const isWarning = data.icon === 'warning';
          addSubStepToCard(
            targetId,
            data.message || '',
            data.icon,
            isCheck ? 'sub-done' : isWarning ? 'sub-error' : '',
          );
          break;
        }

        case 'transcription':
          setTranscription(prev =>
            prev + `[${new Date(data.timestamp || Date.now()).toLocaleTimeString()}] ${data.text}\n\n`
          );
          break;

        case 'note':
          if (processingCardIdRef.current && data.content) {
            addSubStepToCard(processingCardIdRef.current, `"${data.content.slice(0, 100)}..."`, 'document', '');
          }
          setPendingNote(prev => {
            const next = { ...prev, title: data.title as string, content: data.content as string };
            pendingNoteRef.current = next;
            return next;
          });
          break;

        case 'flyer_bg': {
          const fcId = processingCardIdRef.current;
          if (data.source === 'ai_generating') {
            addSubStepToCard(fcId, `Generando fondo con ${data.model === 'grok' ? 'Grok' : 'Google Imagen'}...`, 'brain', '');
          } else if (data.source === 'gemini_imagen') {
            addSubStepToCard(fcId, 'Fondo generado con Google Imagen', 'check', 'sub-done');
          } else if (data.source === 'grok_image') {
            addSubStepToCard(fcId, 'Fondo generado con Grok Image', 'check', 'sub-done');
          } else if (data.source === 'web') {
            addSubStepToCard(fcId, 'Fondo obtenido de artículo web', 'download', 'sub-done');
          } else if (data.source === 'placeholder') {
            addSubStepToCard(fcId, 'Usando fondo placeholder', 'warning', 'sub-error');
          }
          break;
        }

        case 'flyer':
          if (data.previewUrl && processingCardIdRef.current) {
            addPreviewToCard(processingCardIdRef.current, data.previewUrl);
          }
          setPendingNote(prev => {
            const next = { ...prev, previewUrl: data.previewUrl as string };
            pendingNoteRef.current = next;
            return next;
          });
          break;

        case 'published':
          setPublishedNotes(prev => [...prev, {
            title: data.title as string || '',
            content: pendingNoteRef.current.content || '',
            previewUrl: pendingNoteRef.current.previewUrl || '',
            timestamp: new Date().toISOString(),
          }]);
          setPendingNote({});
          pendingNoteRef.current = {};
          if (processingCardIdRef.current) {
            addSubStepToCard(processingCardIdRef.current, `Publicado: "${data.title}"`, 'rocket', 'sub-done');
            markCardStatus(processingCardIdRef.current, 'done');
            processingCardIdRef.current = null;
          }
          break;

        case 'error': {
          const errCardId = data.step === 'capturing'
            ? captureCardIdRef.current
            : processingCardIdRef.current;
          addSubStepToCard(errCardId, `Error: ${data.message}`, 'warning', 'sub-error');
          if (data.step !== 'capturing' && errCardId) {
            markCardStatus(errCardId, 'error');
          }
          break;
        }

        case 'publish_warnings': {
          const warnings = data.warnings as string[] || [];
          warnings.forEach((w: string) => {
            addSubStepToCard(processingCardIdRef.current, `Advertencia: ${w}`, 'warning', 'sub-error');
          });
          break;
        }

        case 'stopped': {
          setRunning(false);
          setStatusClass('stopped');
          const info = data.totalMinutes ? ` (${data.totalMinutes} min, ${data.totalPublished} notas)` : '';
          setStatusText(`Detenido${info}`);
          if (captureCardIdRef.current) { markCardStatus(captureCardIdRef.current, 'done'); captureCardIdRef.current = null; }
          if (processingCardIdRef.current) { markCardStatus(processingCardIdRef.current, 'done'); processingCardIdRef.current = null; }
          break;
        }
      }
    };

    socket.on('pipeline-update', handler);
    return () => { socket.off('pipeline-update', handler); };
  }, [socket, getOrCreateCaptureCard, getOrCreateProcessingCard, updateStepUI, markCardStatus, addSubStepToCard, addPreviewToCard, updateCardTitle]);

  // Auto-scroll activity feed
  useEffect(() => {
    if (activityFeedRef.current) {
      activityFeedRef.current.scrollTop = activityFeedRef.current.scrollHeight;
    }
  }, [activityCards]);

  // Polling pipeline status
  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/pipeline/status')
        .then(r => r.json())
        .then(data => {
          if (data.running) {
            setStatusClass('active');
            setStatusText(`En ejecución - ${data.totalMinutes || 0} min capturados, ${data.totalPublished || 0} notas publicadas`);
          }
        })
        .catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // ─── Handlers ─────────────────────────────────────────────

  const handleStart = async () => {
    if (!url) { alert('Ingresá una URL de transmisión.'); return; }
    const config: PipelineConfig = { url, tone, structure, imageModel, segmentDuration, autoPublish };
    try {
      const res = await fetch('/api/pipeline/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (data.success) {
        setRunning(true);
        setShowStatus(true);
        setStatusClass('active');
        setStatusText('En ejecución');
        setActivityCards([]);
        setTranscription('');
        setPublishedNotes([]);
        captureCardIdRef.current = null;
        processingCardIdRef.current = null;
      } else {
        alert(data.error || 'Error al iniciar el pipeline.');
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  const handleStop = async () => {
    try {
      const res = await fetch('/api/pipeline/stop', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setRunning(false);
        setStatusClass('stopped');
        setStatusText('Detenido');
        updateStepUI('');
      }
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  return (
    <section className="card card-pipeline">
      <div className="card-header">
        <div className="card-header-icon"><PipelineIcon /></div>
        <div>
          <h2 className="card-title">Pipeline Autónomo</h2>
          <p className="card-description">Captura continua sin cortes + segmentación inteligente por temas con IA</p>
        </div>
      </div>

      {/* Config form */}
      <div className="pipeline-config">
        <div className="form-group">
          <label htmlFor="pipelineUrl">URL de transmisión</label>
          <input type="url" id="pipelineUrl" placeholder="https://youtube.com/live/... o URL de stream de radio"
            value={url} onChange={e => setUrl(e.target.value)} />
        </div>

        <div className="form-grid-3">
          <div className="form-group">
            <label htmlFor="pipelineTone">Tono</label>
            <select id="pipelineTone" value={tone} onChange={e => setTone(e.target.value)}>
              <option value="formal">Formal</option>
              <option value="informal">Informal</option>
              <option value="urgente">Urgente</option>
              <option value="analitico">Analítico</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="pipelineStructure">Estructura</label>
            <select id="pipelineStructure" value={structure} onChange={e => setStructure(e.target.value)}>
              <option value="flash">Flash informativo</option>
              <option value="corta">Nota corta</option>
              <option value="completa">Nota completa</option>
              <option value="cronica">Crónica</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="pipelineImageModel">Imagen IA</label>
            <select id="pipelineImageModel" value={imageModel} onChange={e => setImageModel(e.target.value)}>
              <option value="gemini">Google Imagen</option>
              <option value="grok">Grok Image (xAI)</option>
            </select>
            <span className="hint">{modelHints[imageModel]}</span>
          </div>
        </div>

        <div className="form-grid-2">
          <div className="form-group">
            <label htmlFor="pipelineSegment">Duración chunk (seg)</label>
            <input type="number" id="pipelineSegment" value={segmentDuration}
              min={30} max={300} onChange={e => setSegmentDuration(Number(e.target.value))} />
          </div>
          <div className="form-group form-group-checkbox">
            <label className="checkbox-label">
              <input type="checkbox" checked={autoPublish} onChange={e => setAutoPublish(e.target.checked)} />
              Publicar automáticamente
            </label>
          </div>
        </div>

        <div className="pipeline-actions">
          <button className="btn btn-primary btn-lg" onClick={handleStart} disabled={running}>
            <PlayIcon /> Iniciar Pipeline
          </button>
          <button className="btn btn-danger btn-lg" onClick={handleStop} disabled={!running}>
            <StopIcon /> Detener
          </button>
        </div>
      </div>

      {/* Pipeline status */}
      {showStatus && (
        <div className="pipeline-status">
          <div className="pipeline-status-header">
            <div className="status-indicator">
              <span className={`status-dot ${statusClass}`} />
              <span>{statusText}</span>
            </div>
          </div>

          {/* Step Progress */}
          <StepProgress activeStep={activeStep} />

          <div className="pipeline-left">
            {/* Activity Feed */}
            <div className="activity-feed-container">
              <h4 className="section-label">&#9889; Pipeline en vivo</h4>
              <div className="activity-feed" ref={activityFeedRef}>
                {activityCards.map(card => (
                  <ActivityCard key={card.id} card={card} onImageClick={url => setLightboxUrl(url)} />
                ))}
              </div>
            </div>
          </div>

          <div className="pipeline-right">
            {/* Published Notes */}
            {publishedNotes.length > 0 && (
              <div>
                <h4 className="section-label">Notas publicadas ({publishedNotes.length})</h4>
                {publishedNotes.map((note, i) => (
                  <div key={i} className="published-note clickable" onClick={() => setSelectedNote(note)}>
                    {note.previewUrl && <img src={note.previewUrl} className="published-note-thumb" alt="" />}
                    <div className="published-note-info">
                      <strong>{note.title}</strong>
                      <small>{new Date(note.timestamp).toLocaleString()}</small>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Live Transcription */}
            <TranscriptionViewer transcription={transcription} />
          </div>
        </div>
      )}

      <NoteModal note={selectedNote} onClose={() => setSelectedNote(null)} />
      <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />
    </section>
  );
}

// ─── NoteModal ──────────────────────────────────────────────

function NoteModal({ note, onClose }: {
  note: { title: string; content?: string | null; previewUrl?: string | null; image_url?: string | null; image_path?: string | null; timestamp?: string; created_at?: string } | null;
  onClose: () => void;
}) {
  if (!note) return null;
  const imageSrc = note.previewUrl || note.image_url || (note.image_path ? `/output/${note.image_path.split(/[/\\]/).pop()}` : null);
  const date = note.timestamp ? new Date(note.timestamp).toLocaleString() : note.created_at ? new Date(note.created_at + 'Z').toLocaleString() : '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h3 className="modal-title">{note.title}</h3>
        {date && <p className="modal-date">{date}</p>}
        {imageSrc && <img src={imageSrc} className="modal-image" alt="Placa" />}
        {note.content && <div className="modal-text">{note.content}</div>}
      </div>
    </div>
  );
}

// ─── ImageLightbox ──────────────────────────────────────────

function ImageLightbox({ url, onClose }: { url: string | null; onClose: () => void }) {
  if (!url) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <img src={url} className="lightbox-image" alt="Placa" onClick={e => e.stopPropagation()} />
    </div>
  );
}

// ─── StepProgress ───────────────────────────────────────────

function StepProgress({ activeStep }: { activeStep: string }) {
  const steps: Array<{ key: PipelineStep; icon: string; label: string }> = pipelineSteps.map(s => ({
    key: s,
    icon: stepMeta[s].icon,
    label: stepMeta[s].label.split(' ')[0], // short label
  }));

  const shortLabels: Record<PipelineStep, string> = {
    capturing: 'Captura',
    analyzing: 'Análisis',
    searching: 'Research',
    generating: 'Nota',
    creating_flyer: 'Placa',
    publishing: 'Publicar',
  };

  const activeIdx = pipelineSteps.indexOf(activeStep as PipelineStep);

  return (
    <div className="pipeline-steps">
      {steps.map((step, i) => {
        let cls = 'step';
        if (step.key === activeStep) cls += ' active';
        // Capturing always active while pipeline runs
        if (step.key === 'capturing' && activeStep && activeStep !== 'stopped') cls += ' active';
        // Completed steps
        if (activeIdx > 0 && i > 0 && i < activeIdx) cls += ' completed';

        return (
          <React.Fragment key={step.key}>
            {i > 0 && <div className="step-connector" />}
            <div className={cls}>
              <div className="step-icon-wrap"><span className="step-icon">{step.icon}</span></div>
              <span className="step-label">{shortLabels[step.key]}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── ActivityCard ───────────────────────────────────────────

function ActivityCard({ card, onImageClick }: { card: ActivityCardData; onImageClick?: (url: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const MAX_VISIBLE = 3;
  const totalSteps = card.subSteps.length;
  const hasMore = totalSteps > MAX_VISIBLE;
  const visibleSteps = expanded ? card.subSteps : card.subSteps.slice(-MAX_VISIBLE);

  return (
    <div className={`activity-card ${card.status}`}>
      <div className="activity-card-header" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
        <span className="activity-card-icon">{card.icon}</span>
        <span className="activity-card-title">{card.title}</span>
        <span className="activity-card-status">
          {card.status === 'active' && <span className="spinner" />}
          {card.status === 'done' && '✅'}
          {card.status === 'error' && '⚠️'}
        </span>
      </div>
      {visibleSteps.length > 0 && (
        <div className="activity-card-steps">
          {hasMore && !expanded && (
            <div className="activity-show-more" onClick={() => setExpanded(true)}>
              ▸ Ver {totalSteps - MAX_VISIBLE} pasos anteriores
            </div>
          )}
          {hasMore && expanded && (
            <div className="activity-show-more" onClick={() => setExpanded(false)}>
              ▾ Colapsar
            </div>
          )}
          {visibleSteps.map((sub, i) => (
            <div key={i} className={`activity-sub-step ${sub.className || ''}`}>
              <span className="sub-icon">{sub.icon}</span>
              <span className="sub-text">{sub.text}</span>
            </div>
          ))}
        </div>
      )}
      {card.previewUrl && (
        <div className="activity-card-preview">
          <img src={card.previewUrl} alt="Placa" onClick={() => onImageClick?.(card.previewUrl!)} />
        </div>
      )}
    </div>
  );
}

// ─── TranscriptionViewer ────────────────────────────────────

function TranscriptionViewer({ transcription }: { transcription: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="collapsible">
      <div
        className="collapsible-trigger"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
      >
        {open ? '▾' : '▸'} Transcripción en vivo
      </div>
      {open && (
        <textarea readOnly rows={8} placeholder="La transcripción aparecerá aquí..."
          value={transcription} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// MetaConnection
// ═══════════════════════════════════════════════════════════

function MetaConnection() {
  const [status, setStatus] = useState<MetaStatus>({ connected: false });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/meta/status').then(r => r.json()).then(setStatus).catch(() => setStatus({ connected: false }));
  }, []);

  const handleConnect = async () => {
    setLoading(true);
    try {
      // Load Meta config
      const cfgRes = await fetch('/api/meta/config');
      const cfg = await cfgRes.json();
      if (!cfg.appId) { alert('META_APP_ID no configurado en el servidor'); setLoading(false); return; }

      // Load Facebook SDK if not loaded
      if (!(window as any).FB) {
        await new Promise<void>((resolve) => {
          const script = document.createElement('script');
          script.src = 'https://connect.facebook.net/es_LA/sdk.js';
          script.onload = () => {
            (window as any).FB.init({ appId: cfg.appId, cookie: true, xfbml: false, version: 'v22.0' });
            resolve();
          };
          document.body.appendChild(script);
        });
      }

      // Open FB login popup
      (window as any).FB.login((response: any) => {
        if (response.authResponse) {
          const { accessToken } = response.authResponse;
          fetch('/api/meta/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken }),
          })
            .then(r => r.json())
            .then(data => {
              if (data.success) {
                fetch('/api/meta/status').then(r => r.json()).then(setStatus);
              } else {
                alert('Error conectando Meta: ' + (data.error || 'desconocido'));
              }
            })
            .catch(err => alert('Error: ' + err.message))
            .finally(() => setLoading(false));
        } else {
          setLoading(false);
        }
      }, { scope: 'pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish', config_id: cfg.configId || undefined });
    } catch (err: any) {
      alert('Error: ' + err.message);
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('¿Seguro que querés desconectar Meta?')) return;
    try {
      const res = await fetch('/api/meta/disconnect', { method: 'POST' });
      const data = await res.json();
      if (data.success) setStatus({ connected: false });
    } catch (err: any) {
      alert('Error al desconectar: ' + err.message);
    }
  };

  const statusDotClass = status.connected ? 'status-dot active' : 'status-dot';
  let statusLabel = status.connected ? 'Conectado a Meta' : 'No conectado';

  if (status.connected && status.expiresAt) {
    const daysLeft = Math.ceil((new Date(status.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (daysLeft > 0 && daysLeft < 10) {
      statusLabel = `Conectado a Meta (token expira en ${daysLeft} días)`;
    }
  }

  return (
    <section className="card card-meta">
      <div className="card-header">
        <div className="card-header-icon card-header-icon-meta"><FacebookIcon /></div>
        <div>
          <h2 className="card-title">Conexión Meta</h2>
          <p className="card-description">Facebook e Instagram para publicación directa</p>
        </div>
        <div className="meta-status-inline">
          <span className={statusDotClass} />
          <span>{statusLabel}</span>
        </div>
      </div>

      {status.connected ? (
        <>
          <div className="meta-assets">
            {status.pages && status.pages.length > 0 && (
              <div className="meta-assets-list">
                <h4>Facebook Pages:</h4>
                {status.pages.map(p => (
                  <div key={p.id} className="meta-asset-item">
                    <span className="meta-asset-icon">📘</span> {p.name}
                  </div>
                ))}
              </div>
            )}
            {status.instagramAccounts && status.instagramAccounts.length > 0 && (
              <div className="meta-assets-list">
                <h4>Instagram:</h4>
                {status.instagramAccounts.map(ig => (
                  <div key={ig.id} className="meta-asset-item">
                    <span className="meta-asset-icon">📸</span> {ig.name || ig.username}{ig.username ? ` (@${ig.username})` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="meta-actions">
            <button className="btn btn-ghost btn-sm" onClick={handleDisconnect}>Desconectar</button>
          </div>
        </>
      ) : (
        <div>
          <button className="btn btn-meta" onClick={handleConnect}>
            <FacebookIcon size={18} color="white" /> Conectar con Meta
          </button>
          <p className="hint hint-center">Se abrirá un popup para autorizar permisos</p>
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// WebhookSettings
// ═══════════════════════════════════════════════════════════

function WebhookSettingsSection() {
  const [open, setOpen] = useState(false);
  const [webhooks, setWebhooks] = useState<WebhookSettings>({
    webhook_pipeline: '', webhook_nuevo_boton: '', webhook_viejo_boton: '', webhook_tercer_boton: '',
  });
  const [saveMsg, setSaveMsg] = useState('');
  const [saveMsgType, setSaveMsgType] = useState<'success' | 'error'>('success');

  useEffect(() => {
    fetch('/api/settings/webhooks')
      .then(r => r.json())
      .then(data => setWebhooks({
        webhook_pipeline: data.webhook_pipeline || '',
        webhook_nuevo_boton: data.webhook_nuevo_boton || '',
        webhook_viejo_boton: data.webhook_viejo_boton || '',
        webhook_tercer_boton: data.webhook_tercer_boton || '',
      }))
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    try {
      await fetch('/api/settings/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhooks),
      });
      setSaveMsg('Webhooks guardados correctamente.');
      setSaveMsgType('success');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch (err: any) {
      setSaveMsg('Error guardando webhooks: ' + err.message);
      setSaveMsgType('error');
    }
  };

  return (
    <section className="card">
      <div className={`collapsible-section ${open ? 'open' : ''}`}>
        <div className="card-header card-header-clickable" onClick={() => setOpen(!open)}>
          <div className="card-header-icon"><SettingsIcon /></div>
          <div>
            <h2 className="card-title">Configuración de Webhooks</h2>
            <p className="card-description">Configurar URLs de webhooks para Make.com, N8N, etc.</p>
          </div>
          <ChevronIcon />
        </div>

        {open && (
          <div className="manual-tools-content">
            <div className="tool-section">
              <div className="form-group">
                <label>Webhook Pipeline (N8N/Make)</label>
                <input type="url" placeholder="https://..." value={webhooks.webhook_pipeline}
                  onChange={e => setWebhooks(w => ({ ...w, webhook_pipeline: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Webhook Nuevo Botón</label>
                <input type="url" placeholder="https://..." value={webhooks.webhook_nuevo_boton}
                  onChange={e => setWebhooks(w => ({ ...w, webhook_nuevo_boton: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Webhook Viejo Botón</label>
                <input type="url" placeholder="https://..." value={webhooks.webhook_viejo_boton}
                  onChange={e => setWebhooks(w => ({ ...w, webhook_viejo_boton: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Webhook Tercer Botón</label>
                <input type="url" placeholder="https://..." value={webhooks.webhook_tercer_boton}
                  onChange={e => setWebhooks(w => ({ ...w, webhook_tercer_boton: e.target.value }))} />
              </div>
              <button className="btn btn-primary" onClick={handleSave}>Guardar Webhooks</button>
              {saveMsg && (
                <p style={{ marginTop: 8, fontSize: '0.85rem', color: saveMsgType === 'success' ? 'var(--success)' : 'var(--error)' }}>
                  {saveMsg}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// ManualTools
// ═══════════════════════════════════════════════════════════

function ManualTools() {
  const [open, setOpen] = useState(false);

  // Flyer manual
  const [flyerImage, setFlyerImage] = useState<File | null>(null);
  const [flyerTitle, setFlyerTitle] = useState('');
  const [flyerDesc, setFlyerDesc] = useState('');
  const [flyerResult, setFlyerResult] = useState<{ imageUrl: string; finalImagePath: string } | null>(null);

  // URL generator
  const [urlInput, setUrlInput] = useState('');
  const [urlResult, setUrlResult] = useState<{ imageUrl: string; title: string; content: string; finalImagePath: string } | null>(null);

  // Audio capture
  const [capturing, setCapturing] = useState(false);
  const [manualTranscription, setManualTranscription] = useState('');
  const [newsContext, setNewsContext] = useState('');
  const [generatedCopy, setGeneratedCopy] = useState('');
  const [showNewsForm, setShowNewsForm] = useState(false);

  const handleFlyerSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!flyerImage) return;
    const formData = new FormData();
    formData.append('image', flyerImage);
    formData.append('title', flyerTitle);
    formData.append('description', flyerDesc);
    try {
      const res = await fetch('/api/generate', { method: 'POST', body: formData });
      const data = await res.json();
      setFlyerResult({ imageUrl: data.imageUrl, finalImagePath: data.finalImagePath });
    } catch (err: any) {
      alert('Error al procesar la imagen: ' + err.message);
    }
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/generate-from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput }),
      });
      const data = await res.json();
      setUrlResult(data);
    } catch (err: any) {
      alert('Error al generar la placa: ' + err.message);
    }
  };

  const handleStartCapture = async () => {
    try {
      const res = await fetch('/api/start-capture', { method: 'POST' });
      const data = await res.json();
      if (data.success) setCapturing(true);
      else alert('Error al iniciar captura: ' + data.message);
    } catch (err: any) {
      alert('Error al iniciar captura: ' + err.message);
    }
  };

  const handleStopCapture = async () => {
    try {
      const res = await fetch('/api/stop-capture', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setCapturing(false);
        setShowNewsForm(true);
      }
    } catch (err: any) {
      alert('Error al detener captura: ' + err.message);
    }
  };

  const handleGenerateCopy = async () => {
    try {
      const res = await fetch('/api/generateNewsCopy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: newsContext, transcription: manualTranscription }),
      });
      const data = await res.json();
      setGeneratedCopy(data.generatedCopy);
    } catch (err: any) {
      alert('Error al generar la nota: ' + err.message);
    }
  };

  const handleWebhook = async (endpoint: string, payload: Record<string, any>) => {
    try {
      await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err: any) {
      alert('Error al enviar webhook: ' + err.message);
    }
  };

  return (
    <section className="card">
      <div className={`collapsible-section ${open ? 'open' : ''}`}>
        <div className="card-header card-header-clickable" onClick={() => setOpen(!open)}>
          <div className="card-header-icon"><ToolsIcon /></div>
          <div>
            <h2 className="card-title">Herramientas Manuales</h2>
            <p className="card-description">Crear placas, capturar audio y generar notas manualmente</p>
          </div>
          <ChevronIcon />
        </div>

        {open && (
          <div className="manual-tools-content">
            {/* Manual Flyer */}
            <div className="tool-section">
              <h3 className="tool-title">Crear Placa Manual</h3>
              <form onSubmit={handleFlyerSubmit}>
                <div className="form-grid-2">
                  <div className="form-group">
                    <label>Imagen</label>
                    <input type="file" accept="image/*" onChange={e => setFlyerImage(e.target.files?.[0] || null)} required />
                  </div>
                  <div className="form-group">
                    <label>Título del post</label>
                    <input type="text" placeholder="Título" value={flyerTitle} onChange={e => setFlyerTitle(e.target.value)} required />
                  </div>
                </div>
                <div className="form-group">
                  <label>Descripción</label>
                  <textarea placeholder="Descripción del post" rows={3} value={flyerDesc} onChange={e => setFlyerDesc(e.target.value)} />
                </div>
                <button type="submit" className="btn btn-secondary">Generar Post</button>
              </form>
              {flyerResult && (
                <div className="tool-output">
                  <img src={flyerResult.imageUrl} className="preview-image" alt="Imagen procesada" />
                  <div className="output-actions">
                    <a href={flyerResult.imageUrl} download="placa.png" className="btn btn-ghost btn-sm">Descargar</a>
                    <button className="btn btn-secondary btn-sm"
                      onClick={() => handleWebhook('sendWebhook', { title: flyerTitle, description: flyerDesc, imageUrl: flyerResult.imageUrl, finalImagePath: flyerResult.finalImagePath })}>
                      Publicar
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* URL Generator */}
            <div className="tool-section">
              <h3 className="tool-title">Generar Placa desde URL</h3>
              <form onSubmit={handleUrlSubmit}>
                <div className="form-group">
                  <label>URL de la noticia</label>
                  <input type="url" placeholder="https://..." value={urlInput} onChange={e => setUrlInput(e.target.value)} required />
                </div>
                <button type="submit" className="btn btn-secondary">Crear Nota</button>
              </form>
              {urlResult && (
                <div className="tool-output">
                  <img src={urlResult.imageUrl} className="preview-image" alt="Imagen generada" />
                  <div className="output-actions">
                    <a href={urlResult.imageUrl} download="placa.png" className="btn btn-ghost btn-sm">Descargar</a>
                    <button className="btn btn-secondary btn-sm"
                      onClick={() => handleWebhook('sendWebhookNuevoBoton', { title: urlResult.title, content: urlResult.content, imageUrl: urlResult.imageUrl, finalImagePath: urlResult.finalImagePath })}>
                      Publicar
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Audio Capture */}
            <div className="tool-section">
              <h3 className="tool-title">Captura de Audio</h3>
              <div className="audio-controls">
                <button className="btn btn-secondary" onClick={handleStartCapture} disabled={capturing}>Iniciar Captura</button>
                <button className="btn btn-ghost" onClick={handleStopCapture} disabled={!capturing}>Detener</button>
              </div>
              <textarea rows={6} readOnly placeholder="Transcripción en tiempo real..."
                value={manualTranscription} />

              {showNewsForm && (
                <div style={{ marginTop: 12 }}>
                  <div className="form-group">
                    <label>Contexto</label>
                    <textarea placeholder="Contexto de la noticia" rows={3} value={newsContext} onChange={e => setNewsContext(e.target.value)} />
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={handleGenerateCopy}>Generar Copy</button>
                </div>
              )}

              {generatedCopy && (
                <div style={{ marginTop: 12 }}>
                  <h4 className="section-label">Nota generada</h4>
                  <textarea rows={8} value={generatedCopy} onChange={e => setGeneratedCopy(e.target.value)} />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════
// History
// ═══════════════════════════════════════════════════════════

const PAGE_SIZE = 20;

function History({ socket }: { socket: ReturnType<typeof useSocket>['socket'] }) {
  const [activeTab, setActiveTab] = useState<HistoryTab>('publications');

  const [publications, setPublications] = useState<Publication[]>([]);
  const [pubTotal, setPubTotal] = useState(0);
  const [pubOffset, setPubOffset] = useState(0);

  const [selectedPub, setSelectedPub] = useState<Publication | null>(null);

  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [transTotal, setTransTotal] = useState(0);
  const [transOffset, setTransOffset] = useState(0);

  // Load publications
  const loadPublications = useCallback(async (append = false) => {
    try {
      const offset = append ? pubOffset : 0;
      const res = await fetch(`/api/history/publications?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      setPubTotal(data.total);
      if (append) {
        setPublications(prev => [...prev, ...data.publications]);
      } else {
        setPublications(data.publications);
      }
      setPubOffset((append ? offset : 0) + data.publications.length);
    } catch (err) {
      console.error('Error cargando publicaciones:', err);
    }
  }, [pubOffset]);

  // Load transcriptions
  const loadTranscriptions = useCallback(async (append = false) => {
    try {
      const offset = append ? transOffset : 0;
      const res = await fetch(`/api/history/transcriptions?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      setTransTotal(data.total);
      if (append) {
        setTranscriptions(prev => [...prev, ...data.transcriptions]);
      } else {
        setTranscriptions(data.transcriptions);
      }
      setTransOffset((append ? offset : 0) + data.transcriptions.length);
    } catch (err) {
      console.error('Error cargando transcripciones:', err);
    }
  }, [transOffset]);

  // Initial load
  useEffect(() => { loadPublications(); }, []);
  useEffect(() => { loadTranscriptions(); }, []);

  // Real-time updates via socket
  useEffect(() => {
    if (!socket) return;

    const onNewPub = (pub: Publication) => {
      setPublications(prev => [pub, ...prev]);
      setPubTotal(prev => prev + 1);
      setPubOffset(prev => prev + 1);
    };
    const onNewTrans = (trans: Transcription) => {
      setTranscriptions(prev => [trans, ...prev]);
      setTransTotal(prev => prev + 1);
      setTransOffset(prev => prev + 1);
    };
    const onDeletePub = ({ id }: { id: number }) => {
      setPublications(prev => prev.filter(p => p.id !== id));
      setPubTotal(prev => Math.max(0, prev - 1));
    };
    const onDeleteTrans = ({ id }: { id: number }) => {
      setTranscriptions(prev => prev.filter(t => t.id !== id));
      setTransTotal(prev => Math.max(0, prev - 1));
    };

    socket.on('history-new-publication', onNewPub);
    socket.on('history-new-transcription', onNewTrans);
    socket.on('history-delete-publication', onDeletePub);
    socket.on('history-delete-transcription', onDeleteTrans);

    return () => {
      socket.off('history-new-publication', onNewPub);
      socket.off('history-new-transcription', onNewTrans);
      socket.off('history-delete-publication', onDeletePub);
      socket.off('history-delete-transcription', onDeleteTrans);
    };
  }, [socket]);

  const deleteItem = async (type: 'publication' | 'transcription', id: number) => {
    if (!confirm('¿Eliminar este item del historial?')) return;
    const endpoint = type === 'publication' ? 'publications' : 'transcriptions';
    try {
      const res = await fetch(`/api/history/${endpoint}/${id}`, { method: 'DELETE' });
      if (res.ok) {
        if (type === 'publication') {
          setPublications(prev => prev.filter(p => p.id !== id));
          setPubTotal(prev => Math.max(0, prev - 1));
        } else {
          setTranscriptions(prev => prev.filter(t => t.id !== id));
          setTransTotal(prev => Math.max(0, prev - 1));
        }
      }
    } catch (err) {
      console.error('Error eliminando:', err);
    }
  };

  return (
    <section className="card">
      <div className="card-header">
        <div className="card-header-icon"><HistoryIcon /></div>
        <div>
          <h2 className="card-title">Historial</h2>
          <p className="card-description">Publicaciones y transcripciones guardadas</p>
        </div>
      </div>

      <div className="history-tabs">
        <button
          className={`history-tab ${activeTab === 'publications' ? 'active' : ''}`}
          onClick={() => setActiveTab('publications')}
        >
          Publicaciones <span className="tab-count">{pubTotal}</span>
        </button>
        <button
          className={`history-tab ${activeTab === 'transcriptions' ? 'active' : ''}`}
          onClick={() => setActiveTab('transcriptions')}
        >
          Transcripciones <span className="tab-count">{transTotal}</span>
        </button>
      </div>

      {/* Publications tab */}
      {activeTab === 'publications' && (
        <div>
          {publications.length === 0 ? (
            <p className="empty-state">No hay publicaciones aún</p>
          ) : (
            <div className="history-list">
              {publications.map(pub => (
                <PublicationCard key={pub.id} pub={pub} onDelete={() => deleteItem('publication', pub.id!)} onClick={() => setSelectedPub(pub)} />
              ))}
            </div>
          )}
          {pubOffset < pubTotal && (
            <button className="btn btn-ghost btn-block" onClick={() => loadPublications(true)}>Cargar más</button>
          )}
        </div>
      )}

      {/* Transcriptions tab */}
      {activeTab === 'transcriptions' && (
        <div>
          {transcriptions.length === 0 ? (
            <p className="empty-state">No hay transcripciones aún</p>
          ) : (
            <div className="history-list">
              {transcriptions.map(trans => (
                <TranscriptionCard key={trans.id} trans={trans} onDelete={() => deleteItem('transcription', trans.id!)} />
              ))}
            </div>
          )}
          {transOffset < transTotal && (
            <button className="btn btn-ghost btn-block" onClick={() => loadTranscriptions(true)}>Cargar más</button>
          )}
        </div>
      )}

      <NoteModal note={selectedPub ? { title: selectedPub.title, content: selectedPub.content, image_url: selectedPub.image_url, image_path: selectedPub.image_path, created_at: selectedPub.created_at } : null} onClose={() => setSelectedPub(null)} />
    </section>
  );
}

// ─── History Cards ──────────────────────────────────────────

function PublicationCard({ pub, onDelete, onClick }: { pub: Publication; onDelete: () => void; onClick: () => void }) {
  const badgeClass = pub.source === 'pipeline' ? 'badge-pipeline' : pub.source === 'url' ? 'badge-url' : 'badge-manual';
  const badgeLabel = pub.source === 'pipeline' ? 'Pipeline' : pub.source === 'url' ? 'URL' : 'Manual';
  const date = new Date(pub.created_at + 'Z').toLocaleString();
  const contentPreview = pub.content ? pub.content.slice(0, 200) + (pub.content.length > 200 ? '...' : '') : '';
  const imageSrc = pub.image_url || (pub.image_path ? `/output/${pub.image_path.split(/[/\\]/).pop()}` : null);

  return (
    <div className="history-card clickable" onClick={onClick}>
      <div className="history-card-header">
        <span className="history-card-title">{pub.title}</span>
        <button className="history-card-delete" title="Eliminar" onClick={e => { e.stopPropagation(); onDelete(); }}>&times;</button>
      </div>
      {imageSrc && <img src={imageSrc} className="history-card-image" alt="Placa" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />}
      {contentPreview && <div className="history-card-content">{contentPreview}</div>}
      <div className="history-card-meta">
        <span className={`history-card-badge ${badgeClass}`}>{badgeLabel}</span>
        <span>{date}</span>
      </div>
    </div>
  );
}

function TranscriptionCard({ trans, onDelete }: { trans: Transcription; onDelete: () => void }) {
  const badgeClass = trans.source === 'pipeline' ? 'badge-pipeline' : 'badge-manual';
  const badgeLabel = trans.source === 'pipeline' ? 'Pipeline' : 'Manual';
  const date = new Date(trans.created_at + 'Z').toLocaleString();
  const textPreview = trans.text.slice(0, 300) + (trans.text.length > 300 ? '...' : '');
  const durationText = trans.duration_seconds ? ` | ${trans.duration_seconds}s` : '';

  return (
    <div className="history-card">
      <div className="history-card-header">
        <span className="history-card-title">{trans.audio_file || 'Transcripción'}</span>
        <button className="history-card-delete" title="Eliminar" onClick={onDelete}>&times;</button>
      </div>
      <div className="history-card-text">{textPreview}</div>
      <div className="history-card-meta">
        <span className={`history-card-badge ${badgeClass}`}>{badgeLabel}</span>
        <span>{date}{durationText}</span>
      </div>
    </div>
  );
}
