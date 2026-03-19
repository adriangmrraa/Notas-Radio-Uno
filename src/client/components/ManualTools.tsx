import React, { useState, useRef, useEffect } from 'react';

interface GenerateResult {
  imageUrl: string;
  finalImagePath?: string;
  title?: string;
  content?: string;
}

export default function ManualTools() {
  // === Crear Placa Manual ===
  const [manualTitle, setManualTitle] = useState('');
  const [manualDescription, setManualDescription] = useState('');
  const [manualResult, setManualResult] = useState<GenerateResult | null>(null);
  const [manualLoading, setManualLoading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // === Generar desde URL ===
  const [urlInput, setUrlInput] = useState('');
  const [urlResult, setUrlResult] = useState<GenerateResult | null>(null);
  const [urlLoading, setUrlLoading] = useState(false);

  // === Captura de Audio ===
  const [isCapturing, setIsCapturing] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [showCreateNews, setShowCreateNews] = useState(false);
  const [newsContext, setNewsContext] = useState('');
  const [generatedCopy, setGeneratedCopy] = useState('');
  const [showNewsOutput, setShowNewsOutput] = useState(false);
  const transcriptionRef = useRef<HTMLTextAreaElement>(null);

  // Load existing transcriptions on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/get-transcriptions');
        const data = await res.json();
        if (data?.transcriptions) {
          const text = data.transcriptions
            .map((t: any) => `${t.timestamp} - ${t.text}`)
            .join('\n');
          setTranscription(text);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  // Auto-scroll transcription
  useEffect(() => {
    if (transcriptionRef.current) {
      transcriptionRef.current.scrollTop = transcriptionRef.current.scrollHeight;
    }
  }, [transcription]);

  // === Crear Placa Manual handlers ===
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = imageInputRef.current?.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);
    formData.append('title', manualTitle);
    formData.append('description', manualDescription);

    setManualLoading(true);
    try {
      const res = await fetch('/api/generate', { method: 'POST', body: formData });
      const data = await res.json();
      setManualResult({
        imageUrl: data.imageUrl,
        finalImagePath: data.finalImagePath,
      });
    } catch (error: any) {
      alert('Error al procesar la imagen: ' + error.message);
    } finally {
      setManualLoading(false);
    }
  };

  const handleManualPublish = async () => {
    if (!manualResult) return;
    try {
      await fetch('/api/sendWebhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: manualTitle,
          description: manualDescription,
          imageUrl: manualResult.imageUrl,
          finalImagePath: manualResult.finalImagePath,
        }),
      });
    } catch (error: any) {
      console.error('Error al enviar el webhook:', error);
    }
  };

  // === Generar desde URL handlers ===
  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput) return;

    setUrlLoading(true);
    try {
      const res = await fetch('/api/generate-from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput }),
      });
      const data = await res.json();
      setUrlResult({
        imageUrl: data.imageUrl,
        finalImagePath: data.finalImagePath,
        title: data.title,
        content: data.content,
      });
    } catch (error: any) {
      alert('Error al generar la placa: ' + error.message);
    } finally {
      setUrlLoading(false);
    }
  };

  const handleUrlPublish = async () => {
    if (!urlResult) return;
    try {
      await fetch('/api/sendWebhookNuevoBoton', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: urlResult.title,
          content: urlResult.content,
          imageUrl: urlResult.imageUrl,
          finalImagePath: urlResult.finalImagePath,
        }),
      });
    } catch (error: any) {
      console.error('Error al enviar el webhook (nuevo boton):', error);
    }
  };

  // === Audio Capture handlers ===
  const handleStartCapture = async () => {
    try {
      const res = await fetch('/api/start-capture', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setIsCapturing(true);
      } else {
        alert('Error al iniciar captura: ' + data.message);
      }
    } catch (error: any) {
      alert('Error al iniciar captura: ' + error);
    }
  };

  const handleStopCapture = async () => {
    try {
      const res = await fetch('/api/stop-capture', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setIsCapturing(false);
        setShowCreateNews(true);
      } else {
        alert('Error al detener captura: ' + data.message);
      }
    } catch (error: any) {
      alert('Error al detener captura: ' + error);
    }
  };

  const handleGenerateCopy = async () => {
    try {
      const res = await fetch('/api/generateNewsCopy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: newsContext,
          transcription: transcription,
        }),
      });
      const data = await res.json();
      setGeneratedCopy(data.generatedCopy);
      setShowNewsOutput(true);
    } catch (error: any) {
      alert('Error al generar la nota: ' + error.message);
    }
  };

  return (
    <section className="card">
      <details className="collapsible-section">
        <summary className="card-header card-header-clickable">
          <div className="card-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3v18m-9-9h18" />
            </svg>
          </div>
          <div>
            <h2 className="card-title">Herramientas Manuales</h2>
            <p className="card-description">Crear placas, capturar audio y generar notas manualmente</p>
          </div>
          <svg className="chevron-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>

        <div className="manual-tools-content">
          {/* Crear Placa Manual */}
          <div className="tool-section">
            <h3 className="tool-title">Crear Placa Manual</h3>
            <form onSubmit={handleManualSubmit}>
              <div className="form-grid-2">
                <div className="form-group">
                  <label htmlFor="imageInput">Imagen</label>
                  <input type="file" id="imageInput" accept="image/*" required ref={imageInputRef} />
                </div>
                <div className="form-group">
                  <label htmlFor="titleInput">Titulo del post</label>
                  <input
                    type="text"
                    id="titleInput"
                    placeholder="Titulo"
                    required
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                  />
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="descriptionInput">Descripcion</label>
                <textarea
                  id="descriptionInput"
                  placeholder="Descripcion del post"
                  rows={3}
                  value={manualDescription}
                  onChange={(e) => setManualDescription(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-secondary" disabled={manualLoading}>
                {manualLoading ? 'Generando...' : 'Generar Post'}
              </button>
            </form>

            {manualResult && (
              <div className="tool-output">
                <img
                  src={manualResult.imageUrl}
                  className="preview-image"
                  alt="Imagen procesada"
                />
                <div className="output-actions">
                  <a
                    href={manualResult.imageUrl}
                    download="placa.png"
                    className="btn btn-ghost btn-sm"
                  >
                    Descargar
                  </a>
                  <button className="btn btn-secondary btn-sm" onClick={handleManualPublish}>
                    Publicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Generar desde URL */}
          <div className="tool-section">
            <h3 className="tool-title">Generar Placa desde URL</h3>
            <form onSubmit={handleUrlSubmit}>
              <div className="form-group">
                <label htmlFor="urlInput">URL de la noticia</label>
                <input
                  type="url"
                  id="urlInput"
                  placeholder="https://..."
                  required
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-secondary" disabled={urlLoading}>
                {urlLoading ? 'Generando...' : 'Crear Nota'}
              </button>
            </form>

            {urlResult && (
              <div className="tool-output">
                <img
                  src={urlResult.imageUrl}
                  className="preview-image"
                  alt="Imagen generada"
                />
                <div className="output-actions">
                  <a
                    href={urlResult.imageUrl}
                    download="placa.png"
                    className="btn btn-ghost btn-sm"
                  >
                    Descargar
                  </a>
                  <button className="btn btn-secondary btn-sm" onClick={handleUrlPublish}>
                    Publicar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Captura de Audio */}
          <div className="tool-section">
            <h3 className="tool-title">Captura de Audio</h3>
            <div className="audio-controls">
              <button
                className="btn btn-secondary"
                onClick={handleStartCapture}
                disabled={isCapturing}
              >
                Iniciar Captura
              </button>
              <button
                className="btn btn-ghost"
                onClick={handleStopCapture}
                disabled={!isCapturing}
              >
                Detener
              </button>
            </div>
            <textarea
              ref={transcriptionRef}
              rows={6}
              readOnly
              placeholder="Transcripcion en tiempo real..."
              value={transcription}
            />

            {showCreateNews && (
              <div style={{ marginTop: 12 }}>
                <div className="form-group">
                  <label htmlFor="contextInput2">Contexto</label>
                  <textarea
                    id="contextInput2"
                    placeholder="Contexto de la noticia"
                    rows={3}
                    value={newsContext}
                    onChange={(e) => setNewsContext(e.target.value)}
                  />
                </div>
                <button className="btn btn-secondary btn-sm" onClick={handleGenerateCopy}>
                  Crear Nota
                </button>
              </div>
            )}

            {showNewsOutput && (
              <div style={{ marginTop: 12 }}>
                <h4 className="section-label">Nota generada</h4>
                <textarea
                  rows={8}
                  value={generatedCopy}
                  onChange={(e) => setGeneratedCopy(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      </details>
    </section>
  );
}
