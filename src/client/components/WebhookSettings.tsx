import React, { useState, useEffect } from 'react';

interface WebhookValues {
  webhook_pipeline: string;
  webhook_nuevo_boton: string;
  webhook_viejo_boton: string;
  webhook_tercer_boton: string;
}

export default function WebhookSettings() {
  const [values, setValues] = useState<WebhookValues>({
    webhook_pipeline: '',
    webhook_nuevo_boton: '',
    webhook_viejo_boton: '',
    webhook_tercer_boton: '',
  });
  const [saveStatus, setSaveStatus] = useState<{ message: string; isError: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings/webhooks');
        const data = await res.json();
        setValues({
          webhook_pipeline: data.webhook_pipeline || '',
          webhook_nuevo_boton: data.webhook_nuevo_boton || '',
          webhook_viejo_boton: data.webhook_viejo_boton || '',
          webhook_tercer_boton: data.webhook_tercer_boton || '',
        });
      } catch (error) {
        console.error('Error cargando webhooks:', error);
      }
    })();
  }, []);

  const handleSave = async () => {
    try {
      const res = await fetch('/api/settings/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhook_pipeline: values.webhook_pipeline.trim(),
          webhook_nuevo_boton: values.webhook_nuevo_boton.trim(),
          webhook_viejo_boton: values.webhook_viejo_boton.trim(),
          webhook_tercer_boton: values.webhook_tercer_boton.trim(),
        }),
      });
      await res.json();
      setSaveStatus({ message: 'Webhooks guardados correctamente.', isError: false });
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (error: any) {
      setSaveStatus({ message: 'Error guardando webhooks: ' + error.message, isError: true });
    }
  };

  const updateField = (field: keyof WebhookValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <section className="card">
      <details className="collapsible-section">
        <summary className="card-header card-header-clickable">
          <div className="card-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
          <div>
            <h2 className="card-title">Configuracion de Webhooks</h2>
            <p className="card-description">Configurar URLs de webhooks para Make.com, N8N, etc.</p>
          </div>
          <svg className="chevron-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </summary>

        <div className="manual-tools-content">
          <div className="tool-section">
            <div className="form-group">
              <label htmlFor="webhookPipeline">Webhook Pipeline (N8N/Make)</label>
              <input
                type="url"
                id="webhookPipeline"
                placeholder="https://..."
                className="form-input"
                value={values.webhook_pipeline}
                onChange={(e) => updateField('webhook_pipeline', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="webhookNuevoBoton">Webhook Nuevo Boton</label>
              <input
                type="url"
                id="webhookNuevoBoton"
                placeholder="https://..."
                className="form-input"
                value={values.webhook_nuevo_boton}
                onChange={(e) => updateField('webhook_nuevo_boton', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="webhookViejoBoton">Webhook Viejo Boton</label>
              <input
                type="url"
                id="webhookViejoBoton"
                placeholder="https://..."
                className="form-input"
                value={values.webhook_viejo_boton}
                onChange={(e) => updateField('webhook_viejo_boton', e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="webhookTercerBoton">Webhook Tercer Boton</label>
              <input
                type="url"
                id="webhookTercerBoton"
                placeholder="https://..."
                className="form-input"
                value={values.webhook_tercer_boton}
                onChange={(e) => updateField('webhook_tercer_boton', e.target.value)}
              />
            </div>
            <button type="button" className="btn btn-primary" onClick={handleSave}>
              Guardar Webhooks
            </button>
            {saveStatus && (
              <p style={{ marginTop: 8, fontSize: '0.85rem', color: saveStatus.isError ? 'var(--danger)' : 'var(--success)' }}>
                {saveStatus.message}
              </p>
            )}
          </div>
        </div>
      </details>
    </section>
  );
}
