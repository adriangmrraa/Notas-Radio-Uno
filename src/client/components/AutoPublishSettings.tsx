/**
 * AutoPublishSettings — Sección "Auto-publicación" de Configuración (PG-03).
 *
 * Cada tenant puede tener UNA config global ("Todos los programas") y una por
 * programa. El formulario edita la config del programa seleccionado (o la
 * global) y la guarda vía PUT /api/auto-publish.
 *
 * El estado del plan SIEMPRE se muestra: si la feature no está habilitada se
 * ve el motivo (nunca se esconde), y si el plan topa plataformas se ve el
 * contador "en uso / máximo". Las plataformas guardadas son nombres de red —
 * la conexión a cuentas reales llega con PG-04/PG-05.
 */

import { useState, useEffect, useMemo } from 'react';
import { Save, Trash2, CheckCircle, AlertTriangle, Send, Clock, Globe2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';

type AutoPublishMode = 'off' | 'on_approval' | 'scheduled';

interface AutoPublishConfig {
  id: string;
  tenantId: string;
  programId: string | null;
  mode: AutoPublishMode;
  platforms: string[];
  publishDays: number[];
  publishTime: string | null;
  timezone: string;
  isActive: boolean;
}

interface AutoPublishResponse {
  configs: AutoPublishConfig[];
  planAllowsAutoPublish: boolean;
  maxPlatforms: number | null;
  usedPlatforms: number;
}

interface ProgramOption {
  id: string;
  name: string;
}

const PLATFORMS: Array<{ key: string; label: string }> = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'twitter', label: 'Twitter / X' },
  { key: 'threads', label: 'Threads' },
  { key: 'pinterest', label: 'Pinterest' },
  { key: 'reddit', label: 'Reddit' },
  { key: 'bluesky', label: 'Bluesky' },
];

const WEEK_DAYS = [
  { value: 0, label: 'Dom' },
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' },
  { value: 5, label: 'Vie' },
  { value: 6, label: 'Sáb' },
];

const MODE_OPTIONS: Array<{ value: AutoPublishMode; label: string; hint: string }> = [
  { value: 'off', label: 'Desactivado', hint: 'No se publica nada automáticamente' },
  { value: 'on_approval', label: 'Al aprobar', hint: 'Publica apenas el contenido queda aprobado' },
  { value: 'scheduled', label: 'Programado', hint: 'Publica los días y hora que elijas' },
];

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

export function AutoPublishSettings() {
  const { fetchApi } = useApi();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const [configs, setConfigs] = useState<AutoPublishConfig[]>([]);
  const [planAllows, setPlanAllows] = useState(false);
  const [maxPlatforms, setMaxPlatforms] = useState<number | null>(null);
  const [usedPlatforms, setUsedPlatforms] = useState(0);
  const [programs, setPrograms] = useState<ProgramOption[]>([]);

  // Formulario de la config seleccionada ('' = global).
  const [selectedProgram, setSelectedProgram] = useState('');
  const [mode, setMode] = useState<AutoPublishMode>('off');
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [publishDays, setPublishDays] = useState<number[]>([]);
  const [publishTime, setPublishTime] = useState('09:00');
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);

  const loadConfigs = async () => {
    try {
      const data = await fetchApi<AutoPublishResponse>('/auto-publish');
      setConfigs(data.configs ?? []);
      setPlanAllows(data.planAllowsAutoPublish);
      setMaxPlatforms(data.maxPlatforms);
      setUsedPlatforms(data.usedPlatforms);
    } catch {
      /* la UI queda con el estado de error vacío */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfigs();
    fetchApi<{ programs: ProgramOption[] }>('/programs')
      .then((data) => setPrograms(data.programs ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentConfig = useMemo(
    () => configs.find((c) => (c.programId ?? '') === selectedProgram) ?? null,
    [configs, selectedProgram],
  );

  // Al cambiar de programa, carga su config (o defaults si no tiene).
  useEffect(() => {
    if (currentConfig) {
      setMode(currentConfig.mode);
      setPlatforms(currentConfig.platforms);
      setPublishDays(currentConfig.publishDays);
      setPublishTime(currentConfig.publishTime ?? '09:00');
      setTimezone(currentConfig.timezone || DEFAULT_TIMEZONE);
    } else {
      setMode('off');
      setPlatforms([]);
      setPublishDays([]);
      setPublishTime('09:00');
      setTimezone(DEFAULT_TIMEZONE);
    }
  }, [currentConfig]);

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  };

  const togglePlatform = (key: string) => {
    setPlatforms((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));
  };

  const toggleDay = (day: number) => {
    setPublishDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  };

  const save = async () => {
    if (mode === 'scheduled' && publishDays.length === 0) {
      showToast('error', 'Elegí al menos un día de publicación');
      return;
    }
    setSaving(true);
    try {
      await fetchApi('/auto-publish', {
        method: 'PUT',
        body: {
          programId: selectedProgram || null,
          mode,
          platforms,
          publishDays,
          publishTime,
          timezone,
        },
      });
      await loadConfigs();
      showToast('success', 'Configuración guardada');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al guardar';
      showToast('error', msg);
    }
    setSaving(false);
  };

  const remove = async () => {
    if (!currentConfig) return;
    if (!confirm('¿Eliminar esta configuración de auto-publicación?')) return;
    setDeleting(true);
    try {
      await fetchApi(`/auto-publish/${currentConfig.id}`, { method: 'DELETE' });
      await loadConfigs();
      showToast('success', 'Configuración eliminada');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al eliminar';
      showToast('error', msg);
    }
    setDeleting(false);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
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

      {/* Estado del plan — el motivo nunca se esconde. */}
      {!planAllows ? (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-xl border border-amber-500/25 bg-amber-950/30 text-amber-200/90 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Tu plan no incluye la auto-publicación</p>
            <p className="text-xs text-amber-200/60 mt-1">
              Esta función está disponible desde el plan Creator. Actualizá tu plan en Billing para
              configurar la publicación automática.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between px-4 py-3 rounded-xl border border-white/[0.06] bg-white/[0.02] text-sm">
          <span className="text-white/50 flex items-center gap-2">
            <Globe2 className="w-4 h-4 text-cyan-400" />
            Plataformas destino en uso
          </span>
          <span className="font-mono text-white/70">
            {usedPlatforms}{maxPlatforms !== null ? ` / ${maxPlatforms}` : ''}
          </span>
        </div>
      )}

      {/* Selector de programa */}
      <div>
        <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
          Programa
        </label>
        <select
          value={selectedProgram}
          onChange={(e) => setSelectedProgram(e.target.value)}
          className="input-premium"
          disabled={!planAllows}
        >
          <option value="">Todos los programas (config global)</option>
          {programs.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <p className="text-xs text-white/20 mt-1.5">
          La config global aplica a los programas sin configuración propia
        </p>
      </div>

      {/* Modo */}
      <div>
        <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
          Modo de publicación
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => planAllows && setMode(opt.value)}
              disabled={!planAllows}
              className={`px-4 py-3.5 rounded-xl border text-left transition-all duration-200 ${
                mode === opt.value
                  ? 'border-cyan-400/40 bg-cyan-400/[0.06] ring-1 ring-cyan-400/20'
                  : 'border-white/[0.07] bg-white/[0.02] hover:border-white/[0.15] hover:bg-white/[0.04]'
              } ${!planAllows ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <p className="text-sm font-semibold text-white/85">{opt.label}</p>
              <p className="text-xs text-white/35 leading-snug mt-1">{opt.hint}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Plataformas */}
      <div>
        <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
          Plataformas destino
        </label>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => {
            const active = platforms.includes(p.key);
            return (
              <button
                key={p.key}
                onClick={() => planAllows && togglePlatform(p.key)}
                disabled={!planAllows}
                className={`text-sm px-3.5 py-2 rounded-xl border transition-all duration-200 ${
                  active
                    ? 'border-cyan-400/40 bg-cyan-400/[0.08] text-cyan-300 font-medium'
                    : 'border-white/[0.08] text-white/40 hover:border-white/20 hover:text-white/60'
                } ${!planAllows ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {maxPlatforms !== null && mode !== 'off' && (
          <p className="text-xs text-white/20 mt-2">
            Tu plan permite hasta {maxPlatforms} plataformas distintas entre todas las configs activas
          </p>
        )}
      </div>

      {/* Agenda — sólo con modo programado */}
      {mode === 'scheduled' && (
        <div className="space-y-4 p-4 rounded-xl border border-white/[0.06] bg-white/[0.02]">
          <div>
            <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Días de publicación
            </label>
            <div className="flex flex-wrap gap-2">
              {WEEK_DAYS.map((d) => {
                const active = publishDays.includes(d.value);
                return (
                  <button
                    key={d.value}
                    onClick={() => toggleDay(d.value)}
                    className={`text-xs px-3 py-2 rounded-xl border transition-all duration-200 ${
                      active
                        ? 'border-cyan-400/40 bg-cyan-400/[0.08] text-cyan-300 font-medium'
                        : 'border-white/[0.08] text-white/40 hover:border-white/20 hover:text-white/60'
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
                Hora
              </label>
              <input
                type="time"
                value={publishTime}
                onChange={(e) => setPublishTime(e.target.value)}
                className="input-premium"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
                Zona horaria
              </label>
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="input-premium"
                placeholder={DEFAULT_TIMEZONE}
              />
            </div>
          </div>
        </div>
      )}

      {/* Guardar / eliminar */}
      <div className="flex items-center justify-between gap-3">
        <div>
          {currentConfig && (
            <button
              onClick={remove}
              disabled={deleting}
              className="btn-danger inline-flex items-center gap-2 !py-2.5 !px-4 !text-sm"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Eliminando...' : 'Eliminar config'}
            </button>
          )}
        </div>
        <button
          onClick={save}
          disabled={!planAllows || saving}
          className="btn-primary inline-flex items-center gap-2 disabled:opacity-40"
        >
          {saving ? <Send className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {saving ? 'Guardando...' : 'Guardar configuración'}
        </button>
      </div>
    </div>
  );
}
