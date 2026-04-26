/**
 * AlertKeywordsSettings — Gestión de keywords de alertas en vivo
 *
 * Permite al tenant configurar palabras clave que disparan alertas inmediatas
 * cuando se mencionan en la transmisión (sin esperar análisis IA).
 */

import { useState, useEffect, KeyboardEvent } from 'react';
import { Plus, X, Save, Tag, CheckCircle, AlertTriangle } from 'lucide-react';
import { useApi } from '../../hooks/useApi';

const EXAMPLE_KEYWORDS = ['renuncia', 'inflación', 'dólar', 'crisis', 'elecciones'];

export function AlertKeywordsSettings() {
  const { fetchApi } = useApi();
  const [keywords, setKeywords] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetchApi<{ keywords: string[] }>('/settings/alert-keywords')
      .then(data => {
        setKeywords(data.keywords || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  };

  const addKeyword = () => {
    const trimmed = inputValue.trim().toLowerCase();
    if (!trimmed) return;
    if (keywords.includes(trimmed)) {
      showToast('error', `"${trimmed}" ya está en la lista`);
      return;
    }
    if (keywords.length >= 100) {
      showToast('error', 'Máximo 100 keywords');
      return;
    }
    setKeywords(prev => [...prev, trimmed]);
    setInputValue('');
    setDirty(true);
  };

  const removeKeyword = (kw: string) => {
    setKeywords(prev => prev.filter(k => k !== kw));
    setDirty(true);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addKeyword();
    }
  };

  const addExample = (kw: string) => {
    if (keywords.includes(kw)) return;
    setKeywords(prev => [...prev, kw]);
    setDirty(true);
  };

  const saveKeywords = async () => {
    setSaving(true);
    try {
      await fetchApi('/settings/alert-keywords', {
        method: 'PUT',
        body: { keywords },
      });
      setDirty(false);
      showToast('success', 'Keywords guardados correctamente');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al guardar';
      showToast('error', msg);
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2].map(i => (
          <div key={i} className="h-8 rounded-xl bg-white/[0.04] animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Toast */}
      {toast && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium ${
          toast.type === 'success'
            ? 'bg-emerald-950/50 border-emerald-500/30 text-emerald-300'
            : 'bg-red-950/50 border-red-500/30 text-red-300'
        }`}>
          {toast.type === 'success'
            ? <CheckCircle className="w-4 h-4 shrink-0" />
            : <AlertTriangle className="w-4 h-4 shrink-0" />}
          {toast.msg}
        </div>
      )}

      {/* Input para agregar keyword */}
      <div>
        <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
          Agregar keyword
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='Ej: "renuncia", "inflación"...'
            className="input-premium flex-1"
            maxLength={80}
          />
          <button
            onClick={addKeyword}
            disabled={!inputValue.trim()}
            className="btn-primary inline-flex items-center gap-2 !py-2.5 !px-4 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" />
            Agregar
          </button>
        </div>
        <p className="text-xs text-white/20 mt-1.5">
          Presioná Enter o coma para agregar · Sin distinción de mayúsculas/minúsculas
        </p>
      </div>

      {/* Keywords chips */}
      {keywords.length > 0 && (
        <div>
          <label className="text-xs font-medium text-white/40 mb-2.5 block uppercase tracking-wider">
            Keywords activos ({keywords.length})
          </label>
          <div className="flex flex-wrap gap-2">
            {keywords.map(kw => (
              <span
                key={kw}
                className="
                  flex items-center gap-1.5 px-3 py-1.5 rounded-xl
                  bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 text-sm font-medium
                  group hover:border-cyan-500/40 hover:bg-cyan-500/15 transition-all duration-200
                "
              >
                <Tag className="w-3 h-3 text-cyan-400/60 flex-shrink-0" />
                {kw}
                <button
                  onClick={() => removeKeyword(kw)}
                  className="
                    w-4 h-4 rounded-full flex items-center justify-center ml-0.5
                    text-cyan-400/40 hover:text-red-400 hover:bg-red-500/20
                    transition-all duration-150
                  "
                  aria-label={`Eliminar "${kw}"`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {keywords.length === 0 && (
        <div className="py-6 text-center border border-dashed border-white/[0.07] rounded-2xl">
          <Tag className="w-6 h-6 text-white/15 mx-auto mb-2" />
          <p className="text-sm text-white/25">Sin keywords configurados</p>
          <p className="text-xs text-white/15 mt-1">
            Agregá palabras clave para disparar alertas instantáneas
          </p>
        </div>
      )}

      {/* Sugerencias */}
      <div>
        <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
          Ejemplos comunes
        </label>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_KEYWORDS.map(kw => (
            <button
              key={kw}
              onClick={() => addExample(kw)}
              disabled={keywords.includes(kw)}
              className={`
                text-xs px-2.5 py-1.5 rounded-xl border transition-all duration-200
                ${keywords.includes(kw)
                  ? 'border-white/[0.04] text-white/15 cursor-not-allowed'
                  : 'border-white/[0.08] text-white/40 hover:border-white/20 hover:text-white/60 cursor-pointer'
                }
              `}
            >
              + {kw}
            </button>
          ))}
        </div>
      </div>

      {/* Guardar */}
      <div className="flex justify-end">
        <button
          onClick={saveKeywords}
          disabled={!dirty || saving}
          className="btn-primary inline-flex items-center gap-2 disabled:opacity-40"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Guardando...' : 'Guardar keywords'}
        </button>
      </div>
    </div>
  );
}
