import React, { useState, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';

interface PipelineConfig {
  url: string;
  tone: string;
  structure: string;
  imageModel: string;
  segmentDuration: number;
  autoPublish: boolean;
}

interface PipelineControlProps {
  socket: Socket | null;
}

const MODEL_HINTS: Record<string, string> = {
  gemini: 'Requiere GEMINI_API_KEY en el servidor',
  grok: 'Requiere XAI_API_KEY en el servidor',
};

export default function PipelineControl({ socket }: PipelineControlProps) {
  const [config, setConfig] = useState<PipelineConfig>({
    url: '',
    tone: 'formal',
    structure: 'completa',
    imageModel: 'gemini',
    segmentDuration: 120,
    autoPublish: true,
  });
  const [running, setRunning] = useState(false);
  const [statusText, setStatusText] = useState('Inactivo');
  const [statusClass, setStatusClass] = useState('');
  const [showStatus, setShowStatus] = useState(false);

  // Fetch pipeline status on mount and poll every 30s
  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/pipeline/status');
      const data = await res.json();
      if (data.running) {
        setRunning(true);
        setShowStatus(true);
        setStatusClass('active');
        setStatusText(
          `En ejecucion - ${data.totalMinutes || 0} min capturados, ${data.totalPublished || 0} notas publicadas`
        );
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Listen for stopped events
  useEffect(() => {
    if (!socket) return;
    const handleUpdate = (data: any) => {
      if (data.event === 'stopped') {
        setRunning(false);
        setStatusClass('stopped');
        const info = data.totalMinutes
          ? ` (${data.totalMinutes} min, ${data.totalPublished} notas)`
          : '';
        setStatusText(`Detenido${info}`);
      }
    };
    socket.on('pipeline-update', handleUpdate);
    return () => { socket.off('pipeline-update', handleUpdate); };
  }, [socket]);

  const handleStart = async () => {
    if (!config.url) {
      alert('Ingresa una URL de transmision.');
      return;
    }
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
        setStatusText('En ejecucion');
      } else {
        alert(data.error || 'Error al iniciar el pipeline.');
      }
    } catch (error: any) {
      alert('Error: ' + error.message);
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
      }
    } catch (error: any) {
      alert('Error: ' + error.message);
    }
  };

  const updateField = (field: keyof PipelineConfig, value: any) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <section className="card card-pipeline">
      <div className="card-header">
        <div className="card-header-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
        <div>
          <h2 className="card-title">Pipeline Autonomo</h2>
          <p className="card-description">
            Captura continua sin cortes + segmentacion inteligente por temas con IA
          </p>
        </div>
      </div>

      <div className="pipeline-config">
        <div className="form-group">
          <label htmlFor="pipelineUrl">URL de transmision</label>
          <input
            type="url"
            id="pipelineUrl"
            placeholder="https://youtube.com/live/... o URL de stream de radio"
            value={config.url}
            onChange={(e) => updateField('url', e.target.value)}
            required
          />
        </div>

        <div className="form-grid-3">
          <div className="form-group">
            <label htmlFor="pipelineTone">Tono</label>
            <select
              id="pipelineTone"
              value={config.tone}
              onChange={(e) => updateField('tone', e.target.value)}
            >
              <option value="formal">Formal</option>
              <option value="informal">Informal</option>
              <option value="urgente">Urgente</option>
              <option value="analitico">Analitico</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="pipelineStructure">Estructura</label>
            <select
              id="pipelineStructure"
              value={config.structure}
              onChange={(e) => updateField('structure', e.target.value)}
            >
              <option value="flash">Flash informativo</option>
              <option value="corta">Nota corta</option>
              <option value="completa">Nota completa</option>
              <option value="cronica">Cronica</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="pipelineImageModel">Imagen IA</label>
            <select
              id="pipelineImageModel"
              value={config.imageModel}
              onChange={(e) => updateField('imageModel', e.target.value)}
            >
              <option value="gemini">Google Imagen</option>
              <option value="grok">Grok Image (xAI)</option>
            </select>
            <span className="hint">{MODEL_HINTS[config.imageModel] || ''}</span>
          </div>
        </div>

        <div className="form-grid-2">
          <div className="form-group">
            <label htmlFor="pipelineSegment">Duracion chunk (seg)</label>
            <input
              type="number"
              id="pipelineSegment"
              value={config.segmentDuration}
              min={30}
              max={300}
              onChange={(e) => updateField('segmentDuration', parseInt(e.target.value) || 120)}
            />
          </div>
          <div className="form-group form-group-checkbox">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={config.autoPublish}
                onChange={(e) => updateField('autoPublish', e.target.checked)}
              />
              <span className="checkbox-custom" />
              Publicar automaticamente
            </label>
          </div>
        </div>

        <div className="pipeline-actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={handleStart}
            disabled={running}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Iniciar Pipeline
          </button>
          <button
            className="btn btn-danger btn-lg"
            onClick={handleStop}
            disabled={!running}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1" />
            </svg>
            Detener
          </button>
        </div>
      </div>

      {showStatus && (
        <div className="pipeline-status">
          <div className="pipeline-status-header">
            <div className="status-indicator">
              <span className={`status-dot ${statusClass}`} />
              <span>{statusText}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
