import React, { useState, useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

interface TranscriptionViewerProps {
  socket: Socket | null;
}

export default function TranscriptionViewer({ socket }: TranscriptionViewerProps) {
  const [text, setText] = useState('');
  const [totalMinutes, setTotalMinutes] = useState<number | null>(null);
  const [chunkCount, setChunkCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!socket) return;

    const handleUpdate = (data: any) => {
      if (data.event !== 'transcription') return;

      const timestamp = new Date(data.timestamp).toLocaleTimeString();
      setText((prev) => prev + `[${timestamp}] ${data.text}\n\n`);

      if (data.totalMinutes != null) {
        setTotalMinutes(data.totalMinutes);
      }
      setChunkCount((prev) => prev + 1);
    };

    socket.on('pipeline-update', handleUpdate);
    return () => { socket.off('pipeline-update', handleUpdate); };
  }, [socket]);

  // Auto-scroll
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
    }
  }, [text]);

  return (
    <details className="collapsible">
      <summary className="collapsible-trigger">
        Transcripcion en vivo
        {totalMinutes != null && (
          <span style={{ marginLeft: 12, fontSize: 10, color: 'var(--text-muted)' }}>
            {totalMinutes} min | {chunkCount} chunks
          </span>
        )}
      </summary>
      <textarea
        ref={textareaRef}
        rows={8}
        readOnly
        placeholder="La transcripcion aparecera aqui..."
        value={text}
      />
    </details>
  );
}
