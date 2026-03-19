import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from './useSocket';
import type {
  ActivityCardData,
  SubStep,
  PipelineStep,
  PipelineUpdateEvent,
} from '../types';
import {
  STEP_META as stepMeta,
  DETAIL_ICONS as detailIcons,
} from '../types';

// ─── Utility ────────────────────────────────────────────────

function getIcon(name?: string): string {
  if (!name) return '•';
  return detailIcons[name] || '•';
}

let cardIdCounter = 0;
function nextCardId(): string {
  return `card-${++cardIdCounter}`;
}

// ─── Types ──────────────────────────────────────────────────

interface PublishedNote {
  title: string;
  content?: string;
  previewUrl?: string;
  timestamp: string;
}

export interface PipelineState {
  // Connection
  socket: ReturnType<typeof useSocket>['socket'];
  connected: boolean;

  // Pipeline status
  running: boolean;
  statusText: string;
  statusClass: string;
  activeStep: string;

  // Activity feed
  activityCards: ActivityCardData[];

  // Published notes
  publishedNotes: PublishedNote[];

  // Transcription
  transcription: string;

  // Node statuses (for editor)
  nodeStatuses: Record<string, string>;

  // Actions
  startPipeline: (config: any) => Promise<void>;
  stopPipeline: () => Promise<void>;
}

// ─── Context ────────────────────────────────────────────────

const PipelineContext = createContext<PipelineState | null>(null);

export function PipelineProvider({ children }: { children: React.ReactNode }) {
  const { socket, connected } = useSocket();

  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState('Inactivo');
  const [statusClass, setStatusClass] = useState('');
  const [activeStep, setActiveStep] = useState('');
  const [activityCards, setActivityCards] = useState<ActivityCardData[]>([]);
  const [publishedNotes, setPublishedNotes] = useState<PublishedNote[]>([]);
  const [transcription, setTranscription] = useState('');
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, string>>({});

  const captureCardIdRef = useRef<string | null>(null);
  const processingCardIdRef = useRef<string | null>(null);
  const pendingNoteRef = useRef<{ title?: string; content?: string; previewUrl?: string }>({});

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
    if (processingCardIdRef.current) {
      markCardStatus(processingCardIdRef.current, 'done');
    }
    const id = nextCardId();
    processingCardIdRef.current = id;
    const meta = stepMeta[stepName as PipelineStep] || { icon: '\u2699\uFE0F', label: stepName };
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

  // ─── Fetch pipeline status on mount (recover if already running) ───

  useEffect(() => {
    fetch('/api/pipeline/status')
      .then(r => r.json())
      .then(data => {
        if (data.running) {
          setRunning(true);
          setStatusText(`En ejecuci\u00f3n - ${data.totalMinutes || 0} min capturados, ${data.totalPublished || 0} notas publicadas`);
          setStatusClass('active');
          setActiveStep(data.currentStep || 'capturing');
        }
      })
      .catch(() => {});
  }, []);

  // ─── Socket event handler ─────────────────────────────────

  useEffect(() => {
    if (!socket) return;

    const handler = (data: PipelineUpdateEvent) => {
      switch (data.event) {
        case 'step': {
          setActiveStep(data.step || '');

          // Update node statuses
          setNodeStatuses(prev => {
            const updated = { ...prev };
            for (const key of Object.keys(updated)) {
              if (updated[key] === 'running') updated[key] = 'completed';
            }
            if (data.step) updated[data.step] = 'running';
            return updated;
          });

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

          // Agent node status for editor
          if (data.step && (data as any).sub) {
            const agentKey = `agent_${(data as any).sub}`;
            if (data.message?.includes('Ejecutando agente')) {
              setNodeStatuses(prev => ({ ...prev, [agentKey]: 'running' }));
            } else if (data.message?.includes('completado')) {
              setNodeStatuses(prev => ({ ...prev, [agentKey]: 'completed' }));
            }
          }
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
          pendingNoteRef.current = { ...pendingNoteRef.current, title: data.title, content: data.content };
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
            addSubStepToCard(fcId, 'Fondo obtenido de art\u00edculo web', 'download', 'sub-done');
          } else if (data.source === 'placeholder') {
            addSubStepToCard(fcId, 'Usando fondo placeholder', 'warning', 'sub-error');
          }
          break;
        }

        case 'flyer':
          if (data.previewUrl && processingCardIdRef.current) {
            addPreviewToCard(processingCardIdRef.current, data.previewUrl);
          }
          pendingNoteRef.current = { ...pendingNoteRef.current, previewUrl: data.previewUrl };
          break;

        case 'published':
          setPublishedNotes(prev => [...prev, {
            title: data.title as string || '',
            content: pendingNoteRef.current.content || '',
            previewUrl: pendingNoteRef.current.previewUrl || '',
            timestamp: new Date().toISOString(),
          }]);
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
          setNodeStatuses({});
          break;
        }
      }
    };

    socket.on('pipeline-update', handler);
    return () => { socket.off('pipeline-update', handler); };
  }, [socket, getOrCreateCaptureCard, getOrCreateProcessingCard, markCardStatus, addSubStepToCard, addPreviewToCard, updateCardTitle]);

  // ─── Polling pipeline status ──────────────────────────────

  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/pipeline/status')
        .then(r => r.json())
        .then(data => {
          if (data.running) {
            setRunning(true);
            setStatusClass('active');
            setStatusText(`En ejecuci\u00f3n - ${data.totalMinutes || 0} min capturados, ${data.totalPublished || 0} notas publicadas`);
          }
        })
        .catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // ─── Actions ──────────────────────────────────────────────

  const startPipeline = useCallback(async (config: any) => {
    const res = await fetch('/api/pipeline/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Error al iniciar el pipeline.');
    // Reset state for new run
    setRunning(true);
    setStatusClass('active');
    setStatusText('En ejecuci\u00f3n');
    setActivityCards([]);
    setTranscription('');
    setPublishedNotes([]);
    setNodeStatuses({});
    captureCardIdRef.current = null;
    processingCardIdRef.current = null;
    pendingNoteRef.current = {};
  }, []);

  const stopPipeline = useCallback(async () => {
    const res = await fetch('/api/pipeline/stop', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      setRunning(false);
      setStatusClass('stopped');
      setStatusText('Detenido');
      setActiveStep('');
    }
  }, []);

  // ─── Value ────────────────────────────────────────────────

  const value: PipelineState = {
    socket, connected,
    running, statusText, statusClass, activeStep,
    activityCards, publishedNotes, transcription, nodeStatuses,
    startPipeline, stopPipeline,
  };

  return (
    <PipelineContext.Provider value={value}>
      {children}
    </PipelineContext.Provider>
  );
}

export function usePipelineState(): PipelineState {
  const ctx = useContext(PipelineContext);
  if (!ctx) throw new Error('usePipelineState must be used within PipelineProvider');
  return ctx;
}
