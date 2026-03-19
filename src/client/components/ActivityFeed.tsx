import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Socket } from 'socket.io-client';

interface SubStep {
  id: string;
  message: string;
  icon: string;
  className: string;
}

interface ActivityCard {
  id: string;
  icon: string;
  title: string;
  status: 'active' | 'done' | 'error';
  subSteps: SubStep[];
  previewUrl?: string;
  type: 'capture' | 'processing';
}

interface ActivityFeedProps {
  socket: Socket | null;
}

const DETAIL_ICONS: Record<string, string> = {
  satellite: '\uD83D\uDCE1', check: '\u2705', mic: '\uD83C\uDFA4',
  brain: '\uD83E\uDDE0', document: '\uD83D\uDCC4', tag: '\uD83C\uDFF7\uFE0F',
  people: '\uD83D\uDC65', lightbulb: '\uD83D\uDCA1', search: '\uD83D\uDD0D',
  link: '\uD83D\uDD17', download: '\u2B07\uFE0F', info: '\u2139\uFE0F',
  edit: '\u270F\uFE0F', merge: '\uD83D\uDD00', image: '\uD83D\uDDBC\uFE0F',
  layers: '\uD83C\uDF9E\uFE0F', upload: '\u2B06\uFE0F', send: '\uD83D\uDCE8',
  rocket: '\uD83D\uDE80', clock: '\u23F3', warning: '\u26A0\uFE0F',
};

const STEP_META: Record<string, { icon: string; label: string }> = {
  capturing: { icon: '\uD83C\uDFA4', label: 'Captura y Transcripcion' },
  analyzing: { icon: '\uD83D\uDD0D', label: 'Analisis con IA' },
  searching: { icon: '\uD83C\uDF10', label: 'Investigacion Web' },
  generating: { icon: '\u270D\uFE0F', label: 'Redaccion de Nota' },
  creating_flyer: { icon: '\uD83D\uDDBC\uFE0F', label: 'Creacion de Placa' },
  publishing: { icon: '\uD83D\uDCE4', label: 'Publicacion en Redes' },
};

let subStepCounter = 0;

function getIcon(name: string): string {
  return DETAIL_ICONS[name] || '';
}

export default function ActivityFeed({ socket }: ActivityFeedProps) {
  const [cards, setCards] = useState<ActivityCard[]>([]);
  const [logEntries, setLogEntries] = useState<string[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Refs to track current card IDs
  const captureCardIdRef = useRef<string | null>(null);
  const processingCardIdRef = useRef<string | null>(null);

  const scrollFeed = useCallback(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, []);

  const addLogEntry = useCallback((message: string, icon?: string) => {
    const time = new Date().toLocaleTimeString();
    const iconStr = icon && DETAIL_ICONS[icon] ? DETAIL_ICONS[icon] + ' ' : '';
    setLogEntries((prev) => [...prev, `[${time}] ${iconStr}${message}`]);
  }, []);

  const markCardDone = useCallback((cardId: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId && c.status === 'active' ? { ...c, status: 'done' } : c))
    );
  }, []);

  const markCardError = useCallback((cardId: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId && c.status === 'active' ? { ...c, status: 'error' } : c))
    );
  }, []);

  const getOrCreateCaptureCard = useCallback((): string => {
    if (captureCardIdRef.current) return captureCardIdRef.current;
    const id = `capture-${Date.now()}`;
    const meta = STEP_META['capturing'];
    const newCard: ActivityCard = {
      id,
      icon: meta.icon,
      title: meta.label,
      status: 'active',
      subSteps: [],
      type: 'capture',
    };
    captureCardIdRef.current = id;
    setCards((prev) => [...prev, newCard]);
    return id;
  }, []);

  const getOrCreateProcessingCard = useCallback(
    (stepName: string, topicLabel?: string): string => {
      // Mark previous processing card as done
      if (processingCardIdRef.current) {
        markCardDone(processingCardIdRef.current);
      }
      const id = `proc-${Date.now()}-${Math.random()}`;
      const meta = STEP_META[stepName] || { icon: '\u2699\uFE0F', label: stepName };
      const label = topicLabel ? `${meta.label}: ${topicLabel}` : meta.label;
      const newCard: ActivityCard = {
        id,
        icon: meta.icon,
        title: label,
        status: 'active',
        subSteps: [],
        type: 'processing',
      };
      processingCardIdRef.current = id;
      setCards((prev) => [...prev, newCard]);
      return id;
    },
    [markCardDone]
  );

  const addSubStep = useCallback(
    (cardId: string, message: string, icon?: string, className?: string) => {
      const iconStr = icon ? getIcon(icon) : '\u2022';
      const sub: SubStep = {
        id: `sub-${++subStepCounter}`,
        message,
        icon: iconStr,
        className: className || '',
      };
      setCards((prev) =>
        prev.map((c) => (c.id === cardId ? { ...c, subSteps: [...c.subSteps, sub] } : c))
      );
    },
    []
  );

  const addCardPreview = useCallback((cardId: string, imageUrl: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, previewUrl: imageUrl } : c))
    );
  }, []);

  useEffect(() => {
    if (!socket) return;

    const handleUpdate = (data: any) => {
      switch (data.event) {
        case 'step': {
          addLogEntry(data.message);

          if (data.step === 'capturing') {
            const ccId = getOrCreateCaptureCard();
            setCards((prev) =>
              prev.map((c) => (c.id === ccId ? { ...c, title: data.message } : c))
            );
            // Mark any open processing card as done
            if (processingCardIdRef.current) {
              markCardDone(processingCardIdRef.current);
              processingCardIdRef.current = null;
            }
          } else if (data.step && data.step !== 'waiting') {
            const topicMatch = data.message.match(/["":]"?([^""]+)"?$/);
            const topic = topicMatch ? topicMatch[1] : null;
            getOrCreateProcessingCard(data.step, topic);
          }
          break;
        }

        case 'detail': {
          addLogEntry(data.message, data.icon);
          const cardId =
            data.step === 'capturing'
              ? captureCardIdRef.current || getOrCreateCaptureCard()
              : processingCardIdRef.current;
          if (cardId) {
            const isCheck = data.icon === 'check';
            const isWarning = data.icon === 'warning';
            addSubStep(
              cardId,
              data.message,
              data.icon,
              isCheck ? 'sub-done' : isWarning ? 'sub-error' : ''
            );
          }
          break;
        }

        case 'transcription':
          addLogEntry(
            `Transcripcion lista (${data.totalMinutes || '?'} min capturados, ${data.bufferSize} chunks)`,
            'check'
          );
          break;

        case 'insights':
          addLogEntry(
            `Insights: ${data.insights.topics.length} temas, ${data.insights.people.length} personas, ${data.insights.keyFacts.length} datos`,
            'lightbulb'
          );
          break;

        case 'search':
          addLogEntry(`Investigacion: ${data.resultsCount} articulos encontrados`, 'search');
          break;

        case 'note': {
          addLogEntry(`Nota: "${data.title}"`, 'edit');
          if (data.content) {
            addLogEntry(`Preview: "${data.content.slice(0, 120)}..."`, 'document');
          }
          if (processingCardIdRef.current && data.content) {
            addSubStep(
              processingCardIdRef.current,
              `"${data.content.slice(0, 100)}..."`,
              'document'
            );
          }
          break;
        }

        case 'flyer_bg': {
          const pcId = processingCardIdRef.current;
          if (data.source === 'ai_generating') {
            addLogEntry(`Generando fondo con IA (${data.model === 'grok' ? 'Grok' : 'Gemini'})...`, 'brain');
            if (pcId) addSubStep(pcId, `Generando fondo con ${data.model === 'grok' ? 'Grok' : 'Google Imagen'}...`, 'brain');
          } else if (data.source === 'gemini_imagen') {
            addLogEntry('Fondo generado con Google Imagen', 'check');
            if (pcId) addSubStep(pcId, 'Fondo generado con Google Imagen', 'check', 'sub-done');
          } else if (data.source === 'grok_image') {
            addLogEntry('Fondo generado con Grok Image', 'check');
            if (pcId) addSubStep(pcId, 'Fondo generado con Grok Image', 'check', 'sub-done');
          } else if (data.source === 'web') {
            addLogEntry('Fondo de articulo web', 'download');
            if (pcId) addSubStep(pcId, 'Fondo obtenido de articulo web', 'download', 'sub-done');
          } else if (data.source === 'placeholder') {
            addLogEntry('Usando placeholder', 'warning');
            if (pcId) addSubStep(pcId, 'Usando fondo placeholder', 'warning', 'sub-error');
          }
          break;
        }

        case 'flyer':
          addLogEntry('Placa creada', 'image');
          if (data.previewUrl && processingCardIdRef.current) {
            addCardPreview(processingCardIdRef.current, data.previewUrl);
          }
          break;

        case 'published':
          addLogEntry(
            `PUBLICADO: "${data.title}"${data.topic ? ` [${data.topic}]` : ''} (Total: ${data.totalPublished})`,
            'rocket'
          );
          if (processingCardIdRef.current) {
            addSubStep(processingCardIdRef.current, `Publicado: "${data.title}"`, 'rocket', 'sub-done');
            markCardDone(processingCardIdRef.current);
            processingCardIdRef.current = null;
          }
          break;

        case 'error': {
          addLogEntry(`ERROR en ${data.step}: ${data.message}`, 'warning');
          const errCardId =
            data.step === 'capturing'
              ? captureCardIdRef.current
              : processingCardIdRef.current;
          if (errCardId) {
            addSubStep(errCardId, `Error: ${data.message}`, 'warning', 'sub-error');
            if (data.step !== 'capturing') markCardError(errCardId);
          }
          break;
        }

        case 'publish_warnings':
          data.warnings.forEach((w: string) => addLogEntry(`Advertencia: ${w}`, 'warning'));
          break;

        case 'stopped': {
          if (captureCardIdRef.current) {
            markCardDone(captureCardIdRef.current);
            captureCardIdRef.current = null;
          }
          if (processingCardIdRef.current) {
            markCardDone(processingCardIdRef.current);
            processingCardIdRef.current = null;
          }
          break;
        }
      }
    };

    socket.on('pipeline-update', handleUpdate);
    return () => { socket.off('pipeline-update', handleUpdate); };
  }, [socket, addLogEntry, getOrCreateCaptureCard, getOrCreateProcessingCard, addSubStep, addCardPreview, markCardDone, markCardError]);

  // Auto-scroll
  useEffect(() => {
    scrollFeed();
  }, [cards, scrollFeed]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logEntries]);

  return (
    <div>
      <div className="activity-feed-container">
        <h4 className="section-label">Actividad en tiempo real</h4>
        <div className="activity-feed" ref={feedRef}>
          {cards.map((card) => (
            <div key={card.id} className={`activity-card ${card.status === 'active' ? 'active' : card.status === 'done' ? 'done' : 'error'}`}>
              <div className="activity-card-header">
                <span className="activity-card-icon">{card.icon}</span>
                <span className="activity-card-title">{card.title}</span>
                <span className="activity-card-status">
                  {card.status === 'active' && <span className="spinner" />}
                  {card.status === 'done' && '\u2705'}
                  {card.status === 'error' && '\u26A0\uFE0F'}
                </span>
              </div>
              <div className="activity-card-steps">
                {card.subSteps.map((sub) => (
                  <div key={sub.id} className={`activity-sub-step ${sub.className}`}>
                    <span className="sub-icon">{sub.icon}</span>
                    <span className="sub-text">{sub.message}</span>
                  </div>
                ))}
              </div>
              {card.previewUrl && (
                <div className="activity-card-preview">
                  <img src={card.previewUrl} alt="Placa" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <details className="collapsible">
        <summary className="collapsible-trigger">Log detallado</summary>
        <div className="pipeline-log" ref={logRef}>
          {logEntries.map((entry, i) => (
            <div key={i} className="log-entry log-info">
              {entry}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
