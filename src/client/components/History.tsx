import React, { useState, useEffect, useCallback } from 'react';
import type { Socket } from 'socket.io-client';

interface Publication {
  id: number;
  title: string;
  content?: string;
  image_url?: string;
  image_path?: string;
  source: string;
  created_at: string;
}

interface Transcription {
  id: number;
  text: string;
  audio_file?: string;
  source: string;
  duration_seconds?: number;
  created_at: string;
}

interface HistoryProps {
  socket: Socket | null;
}

const PAGE_SIZE = 20;

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export default function History({ socket }: HistoryProps) {
  const [activeTab, setActiveTab] = useState<'publications' | 'transcriptions'>('publications');
  const [publications, setPublications] = useState<Publication[]>([]);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [pubTotal, setPubTotal] = useState(0);
  const [transTotal, setTransTotal] = useState(0);
  const [pubOffset, setPubOffset] = useState(0);
  const [transOffset, setTransOffset] = useState(0);

  // Load publications
  const loadPublications = useCallback(async (append = false) => {
    try {
      const offset = append ? pubOffset : 0;
      const res = await fetch(`/api/history/publications?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      setPubTotal(data.total);

      if (append) {
        setPublications((prev) => [...prev, ...data.publications]);
        setPubOffset((prev) => prev + data.publications.length);
      } else {
        setPublications(data.publications);
        setPubOffset(data.publications.length);
      }
    } catch (error) {
      console.error('Error cargando publicaciones:', error);
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
        setTranscriptions((prev) => [...prev, ...data.transcriptions]);
        setTransOffset((prev) => prev + data.transcriptions.length);
      } else {
        setTranscriptions(data.transcriptions);
        setTransOffset(data.transcriptions.length);
      }
    } catch (error) {
      console.error('Error cargando transcripciones:', error);
    }
  }, [transOffset]);

  // Initial load
  useEffect(() => {
    loadPublications();
    loadTranscriptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Socket listeners
  useEffect(() => {
    if (!socket) return;

    const handleNewPub = (pub: Publication) => {
      setPublications((prev) => [pub, ...prev]);
      setPubTotal((prev) => prev + 1);
      setPubOffset((prev) => prev + 1);
    };

    const handleNewTrans = (trans: Transcription) => {
      setTranscriptions((prev) => [trans, ...prev]);
      setTransTotal((prev) => prev + 1);
      setTransOffset((prev) => prev + 1);
    };

    const handleDeletePub = ({ id }: { id: number }) => {
      setPublications((prev) => prev.filter((p) => p.id !== id));
      setPubTotal((prev) => Math.max(0, prev - 1));
    };

    const handleDeleteTrans = ({ id }: { id: number }) => {
      setTranscriptions((prev) => prev.filter((t) => t.id !== id));
      setTransTotal((prev) => Math.max(0, prev - 1));
    };

    socket.on('history-new-publication', handleNewPub);
    socket.on('history-new-transcription', handleNewTrans);
    socket.on('history-delete-publication', handleDeletePub);
    socket.on('history-delete-transcription', handleDeleteTrans);

    return () => {
      socket.off('history-new-publication', handleNewPub);
      socket.off('history-new-transcription', handleNewTrans);
      socket.off('history-delete-publication', handleDeletePub);
      socket.off('history-delete-transcription', handleDeleteTrans);
    };
  }, [socket]);

  const deleteItem = async (type: 'publication' | 'transcription', id: number) => {
    if (!confirm('Eliminar este item del historial?')) return;

    const endpoint = type === 'publication' ? 'publications' : 'transcriptions';
    try {
      const res = await fetch(`/api/history/${endpoint}/${id}`, { method: 'DELETE' });
      if (res.ok) {
        if (type === 'publication') {
          setPublications((prev) => prev.filter((p) => p.id !== id));
          setPubTotal((prev) => Math.max(0, prev - 1));
        } else {
          setTranscriptions((prev) => prev.filter((t) => t.id !== id));
          setTransTotal((prev) => Math.max(0, prev - 1));
        }
      }
    } catch (error) {
      console.error('Error eliminando:', error);
    }
  };

  const renderPublicationCard = (pub: Publication) => {
    const badgeClass =
      pub.source === 'pipeline'
        ? 'badge-pipeline'
        : pub.source === 'url'
          ? 'badge-url'
          : 'badge-manual';
    const badgeLabel =
      pub.source === 'pipeline'
        ? 'Pipeline'
        : pub.source === 'url'
          ? 'URL'
          : 'Manual';
    const date = new Date(pub.created_at + 'Z').toLocaleString();
    const contentPreview = pub.content
      ? pub.content.slice(0, 200) + (pub.content.length > 200 ? '...' : '')
      : '';

    const imageSrc = pub.image_url
      ? pub.image_url
      : pub.image_path
        ? `/output/${pub.image_path.split('/').pop()}`
        : null;

    return (
      <div key={pub.id} className="history-card" data-id={pub.id}>
        <div className="history-card-header">
          <span
            className="history-card-title"
            dangerouslySetInnerHTML={{ __html: escapeHtml(pub.title) }}
          />
          <button
            className="history-card-delete"
            title="Eliminar"
            onClick={() => deleteItem('publication', pub.id)}
          >
            &times;
          </button>
        </div>
        {imageSrc && (
          <img
            src={imageSrc}
            className="history-card-image"
            alt="Placa"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        {contentPreview && (
          <div
            className="history-card-content"
            dangerouslySetInnerHTML={{ __html: escapeHtml(contentPreview) }}
          />
        )}
        <div className="history-card-meta">
          <span className={`history-card-badge ${badgeClass}`}>{badgeLabel}</span>
          <span>{date}</span>
        </div>
      </div>
    );
  };

  const renderTranscriptionCard = (trans: Transcription) => {
    const badgeClass = trans.source === 'pipeline' ? 'badge-pipeline' : 'badge-manual';
    const badgeLabel = trans.source === 'pipeline' ? 'Pipeline' : 'Manual';
    const date = new Date(trans.created_at + 'Z').toLocaleString();
    const textPreview = trans.text.slice(0, 300) + (trans.text.length > 300 ? '...' : '');
    const durationText = trans.duration_seconds ? ` | ${trans.duration_seconds}s` : '';

    return (
      <div key={trans.id} className="history-card" data-id={trans.id}>
        <div className="history-card-header">
          <span
            className="history-card-title"
            dangerouslySetInnerHTML={{
              __html: escapeHtml(trans.audio_file || 'Transcripcion'),
            }}
          />
          <button
            className="history-card-delete"
            title="Eliminar"
            onClick={() => deleteItem('transcription', trans.id)}
          >
            &times;
          </button>
        </div>
        <div
          className="history-card-text"
          dangerouslySetInnerHTML={{ __html: escapeHtml(textPreview) }}
        />
        <div className="history-card-meta">
          <span className={`history-card-badge ${badgeClass}`}>{badgeLabel}</span>
          <span>
            {date}
            {durationText}
          </span>
        </div>
      </div>
    );
  };

  return (
    <section className="card">
      <div className="card-header">
        <div className="card-header-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
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
      <div
        className={`history-tab-content ${activeTab === 'publications' ? 'active' : ''}`}
        style={{ display: activeTab === 'publications' ? 'block' : 'none' }}
      >
        <div className="history-list">
          {publications.map(renderPublicationCard)}
        </div>
        {publications.length === 0 && (
          <p className="empty-state">No hay publicaciones aun</p>
        )}
        {pubOffset < pubTotal && (
          <button
            className="btn btn-ghost btn-block"
            onClick={() => loadPublications(true)}
          >
            Cargar mas
          </button>
        )}
      </div>

      {/* Transcriptions tab */}
      <div
        className={`history-tab-content ${activeTab === 'transcriptions' ? 'active' : ''}`}
        style={{ display: activeTab === 'transcriptions' ? 'block' : 'none' }}
      >
        <div className="history-list">
          {transcriptions.map(renderTranscriptionCard)}
        </div>
        {transcriptions.length === 0 && (
          <p className="empty-state">No hay transcripciones aun</p>
        )}
        {transOffset < transTotal && (
          <button
            className="btn btn-ghost btn-block"
            onClick={() => loadTranscriptions(true)}
          >
            Cargar mas
          </button>
        )}
      </div>
    </section>
  );
}
