import React, { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';

interface PublishedNote {
  id: string;
  title: string;
  content?: string;
  previewUrl?: string;
  timestamp: string;
  topic?: string;
  totalPublished?: number;
  publishResults?: { platform: string; success: boolean; error?: string }[];
}

interface PublishedNotesProps {
  socket: Socket | null;
}

export default function PublishedNotes({ socket }: PublishedNotesProps) {
  const [notes, setNotes] = useState<PublishedNote[]>([]);

  useEffect(() => {
    if (!socket) return;

    const handleUpdate = (data: any) => {
      if (data.event === 'note') {
        setNotes((prev) => {
          // Store note data for later association with flyer
          const existing = prev.find((n) => n.id === `pending-${Date.now()}`);
          if (!existing) {
            return [
              {
                id: `note-${Date.now()}`,
                title: data.title || 'Sin titulo',
                content: data.content,
                timestamp: new Date().toISOString(),
              },
              ...prev,
            ];
          }
          return prev;
        });
      }

      if (data.event === 'flyer' && data.previewUrl) {
        // Attach flyer to the most recent note without a preview
        setNotes((prev) => {
          const idx = prev.findIndex((n) => !n.previewUrl);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], previewUrl: data.previewUrl };
            return updated;
          }
          return prev;
        });
      }

      if (data.event === 'published') {
        setNotes((prev) => {
          // Update the most recent note or create a new entry
          const idx = prev.findIndex(
            (n) => n.title === data.title || (!n.publishResults && prev.indexOf(n) === 0)
          );
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              title: data.title,
              timestamp: data.timestamp || updated[idx].timestamp,
              topic: data.topic,
              totalPublished: data.totalPublished,
              publishResults: data.publishResults,
            };
            return updated;
          }
          return [
            {
              id: `pub-${Date.now()}`,
              title: data.title,
              timestamp: data.timestamp || new Date().toISOString(),
              topic: data.topic,
              totalPublished: data.totalPublished,
              publishResults: data.publishResults,
            },
            ...prev,
          ];
        });
      }
    };

    socket.on('pipeline-update', handleUpdate);
    return () => { socket.off('pipeline-update', handleUpdate); };
  }, [socket]);

  if (notes.length === 0) return null;

  return (
    <div>
      <h4 className="section-label">Notas publicadas</h4>
      {notes.map((note) => (
        <div key={note.id} className="published-note">
          <strong>{note.title}</strong>
          {note.topic && (
            <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              [{note.topic}]
            </span>
          )}
          <br />
          {note.content && (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0' }}>
              {note.content.slice(0, 200)}
              {note.content.length > 200 ? '...' : ''}
            </p>
          )}
          {note.previewUrl && (
            <img
              src={note.previewUrl}
              alt="Placa"
              style={{
                maxWidth: 180,
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                marginTop: 8,
              }}
            />
          )}
          {note.publishResults && note.publishResults.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11 }}>
              {note.publishResults.map((r, i) => (
                <span
                  key={i}
                  style={{
                    marginRight: 8,
                    color: r.success ? 'var(--success)' : 'var(--error)',
                  }}
                >
                  {r.platform}: {r.success ? '\u2705' : '\u274C'}
                  {r.error && ` (${r.error})`}
                </span>
              ))}
            </div>
          )}
          <br />
          <small>{new Date(note.timestamp).toLocaleString()}</small>
        </div>
      ))}
    </div>
  );
}
