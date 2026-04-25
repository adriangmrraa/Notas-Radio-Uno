import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { Button } from '../../components/ui/button';

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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto bg-zinc-950 border-zinc-800 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="text-xl">{isEditing ? 'Editar Agente' : 'Crear Agente'}</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Configura un agente de IA para el pipeline de procesamiento de audio.
          </DialogDescription>
        </DialogHeader>

        {!isEditing && templates.length > 0 && (
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Templates rápidos:</label>
            <div className="flex flex-wrap gap-2">
              {templates.map(tmpl => (
                <button
                  key={tmpl.id}
                  className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                    templateId === tmpl.id
                      ? 'bg-emerald-600 text-white'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                  onClick={() => applyTemplate(tmpl)}
                >
                  {tmpl.icon} {tmpl.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Nombre *</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Nombre del agente"
              className="bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Descripción</label>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Descripción breve"
              className="bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Posición en el Pipeline *</label>
            <Select value={position} onValueChange={setPosition}>
              <SelectTrigger className="bg-zinc-900 border-zinc-700 text-zinc-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
                {STEP_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value} className="focus:bg-zinc-800 focus:text-zinc-100">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">System Prompt *</label>
            <Textarea
              rows={10}
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="Instrucciones para el agente. Usá JSON en la respuesta para que se integre con el pipeline."
              className="bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-500 resize-none font-mono text-sm"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Proveedor IA</label>
              <Select value={aiProvider} onValueChange={setAiProvider}>
                <SelectTrigger className="bg-zinc-900 border-zinc-700 text-zinc-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-700 text-zinc-100">
                  <SelectItem value="auto" className="focus:bg-zinc-800 focus:text-zinc-100">Auto (DeepSeek → Gemini)</SelectItem>
                  <SelectItem value="deepseek" className="focus:bg-zinc-800 focus:text-zinc-100">DeepSeek</SelectItem>
                  <SelectItem value="gemini" className="focus:bg-zinc-800 focus:text-zinc-100">Gemini</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">
                Temperatura: <span className="text-emerald-400">{temperature}</span>
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={temperature}
                onChange={e => setTemperature(parseFloat(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-300">Max Tokens</label>
              <Input
                type="number"
                value={maxTokens}
                onChange={e => setMaxTokens(parseInt(e.target.value) || 2000)}
                className="bg-zinc-900 border-zinc-700 text-zinc-100"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-300">Tools habilitadas</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tools.includes('web_search')}
                  onChange={() => toggleTool('web_search')}
                  className="accent-emerald-500"
                />
                🌐 Búsqueda web
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tools.includes('image_processing')}
                  onChange={() => toggleTool('image_processing')}
                  className="accent-emerald-500"
                />
                🖼️ Procesamiento de imágenes
              </label>
            </div>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-md bg-red-900/30 border border-red-800 text-red-400 text-sm">
            {error}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={onClose}
            className="text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800"
          >
            Cancelar
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {saving ? 'Guardando...' : isEditing ? 'Actualizar' : 'Crear y agregar al pipeline'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
