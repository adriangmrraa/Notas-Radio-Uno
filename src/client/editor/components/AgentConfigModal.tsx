import React, { useState, useEffect } from 'react';

interface Props {
  agent: any | null;
  afterStep: string;
  templates: any[];
  currentNodeOrder: string[];
  onSave: () => void;
  onClose: () => void;
}

const STEP_OPTIONS = [
  { value: 'transcribe', label: 'Después de Transcripción' },
  { value: 'analyze', label: 'Después de Análisis de Temas' },
  { value: 'insights', label: 'Después de Extracción de Insights' },
  { value: 'search', label: 'Después de Investigación Web' },
  { value: 'generate_news', label: 'Después de Generación de Nota' },
  { value: 'generate_title', label: 'Después de Generación de Título' },
  { value: 'generate_flyer', label: 'Después de Creación de Placa' },
];

export default function AgentConfigModal({ agent, afterStep, templates, currentNodeOrder, onSave, onClose }: Props) {
  const isEditing = agent?.id;

  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt || '');
  const [position, setPosition] = useState(afterStep);
  const [temperature, setTemperature] = useState(agent?.temperature || 0.5);
  const [maxTokens, setMaxTokens] = useState(agent?.max_tokens || 2000);
  const [tools, setTools] = useState<string[]>(agent?.tools || []);
  const [templateId, setTemplateId] = useState(agent?.template_id || null);
  const [aiProvider, setAiProvider] = useState(agent?.ai_provider || 'auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (agent) {
      setName(agent.name || '');
      setDescription(agent.description || '');
      setSystemPrompt(agent.system_prompt || '');
      setPosition(agent.after_step || afterStep);
      setTemperature(agent.temperature || 0.5);
      setMaxTokens(agent.max_tokens || 2000);
      setTools(agent.tools || []);
      setTemplateId(agent.template_id || null);
      setAiProvider(agent.ai_provider || 'auto');
    }
  }, [agent, afterStep]);

  const applyTemplate = (tmpl: any) => {
    setName(tmpl.name);
    setDescription(tmpl.description);
    setSystemPrompt(tmpl.systemPrompt);
    setPosition(tmpl.defaultAfterStep);
    setTools(tmpl.tools);
    setTemperature(tmpl.temperature);
    setTemplateId(tmpl.id);
  };

  const handleSave = async () => {
    if (!name.trim() || !systemPrompt.trim()) {
      setError('Nombre y System Prompt son obligatorios');
      return;
    }
    setSaving(true);
    setError('');

    try {
      const body = {
        name, description, system_prompt: systemPrompt,
        after_step: position, temperature, max_tokens: maxTokens,
        tools, template_id: templateId, ai_provider: aiProvider,
      };

      let savedAgent: any;

      if (isEditing) {
        const res = await fetch(`/api/agents/${agent.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        savedAgent = data.agent;
      } else {
        const res = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        savedAgent = data.agent;

        // Auto-insert into pipeline config
        if (savedAgent) {
          const agentNodeId = `agent_${savedAgent.id}`;
          const newOrder = [...currentNodeOrder];
          const insertIdx = newOrder.indexOf(position);
          if (insertIdx !== -1) {
            newOrder.splice(insertIdx + 1, 0, agentNodeId);
          } else {
            newOrder.splice(newOrder.length - 1, 0, agentNodeId); // Before publish
          }
          await fetch('/api/pipeline-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_order: newOrder }),
          });
        }
      }

      onSave();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleTool = (tool: string) => {
    setTools(prev => prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content agent-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h3 className="modal-title">{isEditing ? 'Editar Agente' : 'Crear Agente'}</h3>

        {!isEditing && templates.length > 0 && (
          <div className="agent-templates-row">
            <label className="form-label">Templates rápidos:</label>
            <div className="templates-chips">
              {templates.map(tmpl => (
                <button key={tmpl.id} className={`chip ${templateId === tmpl.id ? 'active' : ''}`}
                  onClick={() => applyTemplate(tmpl)}>
                  {tmpl.icon} {tmpl.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Nombre *</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Nombre del agente" />
        </div>

        <div className="form-group">
          <label className="form-label">Descripción</label>
          <input className="form-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="Descripción breve" />
        </div>

        <div className="form-group">
          <label className="form-label">Posición en el Pipeline *</label>
          <select className="form-select" value={position} onChange={e => setPosition(e.target.value)}>
            {STEP_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">System Prompt *</label>
          <textarea className="form-input agent-prompt-textarea" rows={12} value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder="Instrucciones para el agente. Usá JSON en la respuesta para que se integre con el pipeline." />
        </div>

        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Proveedor IA</label>
            <select className="form-select" value={aiProvider} onChange={e => setAiProvider(e.target.value)}>
              <option value="auto">Auto (DeepSeek → Gemini)</option>
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Temperatura: {temperature}</label>
            <input type="range" min="0" max="1" step="0.1" value={temperature}
              onChange={e => setTemperature(parseFloat(e.target.value))} />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Max Tokens</label>
            <input type="number" className="form-input" value={maxTokens}
              onChange={e => setMaxTokens(parseInt(e.target.value) || 2000)} />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Tools habilitadas</label>
          <div className="tools-checkboxes">
            <label className="checkbox-label">
              <input type="checkbox" checked={tools.includes('web_search')}
                onChange={() => toggleTool('web_search')} />
              🌐 Búsqueda web
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={tools.includes('image_processing')}
                onChange={() => toggleTool('image_processing')} />
              🖼️ Procesamiento de imágenes
            </label>
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Guardando...' : isEditing ? 'Actualizar' : 'Crear y agregar al pipeline'}
          </button>
        </div>
      </div>
    </div>
  );
}
