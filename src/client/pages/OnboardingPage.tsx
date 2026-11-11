/**
 * OnboardingPage — wizard de 4 pasos (PC-10).
 *
 *   1. Canal           → POST /api/onboarding/step/channel  (tenants del usuario)
 *   2. Programa        → POST /api/onboarding/step/program  (programId o crear)
 *   3. Personas        → POST /api/onboarding/step/persons  (personIds o create)
 *   4. Canales y redes → POST /api/onboarding/step/channels (portfolioIds o create)
 *
 * Las altas rápidas de pasos 3 y 4 usan las APIs reales (/api/persons,
 * /api/connections/portfolios); el endpoint de paso sólo guarda avance + valida
 * ids contra el tenant. "Finalizar" pega a /api/onboarding/complete y el guard
 * (OnboardingGuard) re-evalúa antes de navegar a /dashboard.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Check, ChevronLeft, ChevronRight, Mic, Plus, Share2, Users,
} from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAsyncData } from '../hooks/useAsyncData';
import { ErrorState } from '../components/feedback';
import { useOnboarding } from '../components/OnboardingGuard';

// ─── Types ───────────────────────────────────────────────────────────────────

type StepId = 'channel' | 'program' | 'persons' | 'channels';

interface StatusStep {
  id: StepId;
  title: string;
  required: boolean;
  saved: boolean;
  done: boolean;
  completed: boolean;
}

interface OnboardingStatus {
  completed: boolean;
  currentStep: number;
  canComplete: boolean;
  steps: StatusStep[];
  data?: {
    channel?: { name: string; slug: string; platformName: string | null; timezone: string; logoUrl: string | null };
    programCount: number;
    personCount: number;
    portfolioCount: number;
  };
}

interface Program {
  id: string;
  name: string;
  description?: string;
}

interface Person {
  id: string;
  name: string;
  role: string;
}

interface Portfolio {
  id: string;
  name: string;
  isActive: boolean;
  assets?: Array<{ id: string; name?: string; assetType: string }>;
}

const STEP_ICONS = [Building2, Mic, Users, Share2] as const;

const PERSON_ROLES = ['conductor', 'columnista', 'productor', 'invitado', 'colaborador', 'otro'];

const FALLBACK_TIMEZONES = [
  'America/Argentina/Buenos_Aires', 'America/Argentina/Cordoba', 'America/Montevideo',
  'America/Santiago', 'America/Sao_Paulo', 'America/Asuncion', 'America/La_Paz',
  'America/Lima', 'America/Bogota', 'America/Mexico_City', 'America/New_York',
  'America/Los_Angeles', 'Europe/Madrid', 'UTC',
];

const TIMEZONES: string[] = (() => {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf?.('timeZone');
    return list && list.length > 0 ? list : FALLBACK_TIMEZONES;
  } catch {
    return FALLBACK_TIMEZONES;
  }
})();

// ─── Page ────────────────────────────────────────────────────────────────────

export function OnboardingPage() {
  const { fetchApi } = useApi();
  const { refresh } = useOnboarding();
  const navigate = useNavigate();

  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [stepIdx, setStepIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await fetchApi<OnboardingStatus>('/onboarding/status', { skipRedirect: true });
      setStatus(s);
      setStepIdx(Math.min(s.currentStep, 3));
    } catch (err: any) {
      setLoadError(err?.message || 'No se pudo cargar el estado del onboarding');
    }
  }, [fetchApi]);

  useEffect(() => { void load(); }, [load]);

  const saveStep = async (stepId: StepId, body: unknown) => {
    const next = await fetchApi<OnboardingStatus>(`/onboarding/step/${stepId}`, {
      method: 'POST',
      body,
    });
    setStatus(next);
    return next;
  };

  const finish = async () => {
    try {
      await fetchApi('/onboarding/complete', { method: 'POST' });
      await refresh();
      navigate('/dashboard', { replace: true });
    } catch (err: any) {
      setError(err?.message || 'No se pudo completar el onboarding');
    }
  };

  const goNext = () => { setError(''); setStepIdx((i) => Math.min(3, i + 1)); };
  const goBack = () => { setError(''); setStepIdx((i) => Math.max(0, i - 1)); };
  const goTo = (i: number) => { setError(''); setStepIdx(i); };

  if (loadError) {
    return (
      <div className="card" style={{ maxWidth: 640, margin: '40px auto' }}>
        <p style={{ color: '#f87171' }}>{loadError}</p>
        <button className="btn btn-secondary" onClick={() => { setLoadError(''); void load(); }}>
          Reintentar
        </button>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: 300 }}>
        <div className="w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const currentDef = status.steps[stepIdx];

  return (
    <div style={{ maxWidth: 760, margin: '24px auto', padding: '0 16px 48px' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Configuración inicial</h2>
        <p className="hint" style={{ fontSize: 13 }}>
          Cuatro pasos para dejar tu canal operativo. El progreso se guarda a medida que avanzás.
        </p>
      </div>

      {/* Step indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24 }}>
        {status.steps.map((s, i) => {
          const Icon = STEP_ICONS[i] ?? Check;
          const active = i === stepIdx;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', flex: i < status.steps.length - 1 ? 1 : 0 }}>
              <button
                type="button"
                onClick={() => i < stepIdx && goTo(i)}
                disabled={i >= stepIdx}
                title={s.title}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, background: 'none',
                  border: 'none', cursor: i < stepIdx ? 'pointer' : 'default', padding: 0,
                }}
              >
                <span
                  style={{
                    width: 32, height: 32, borderRadius: '50%', display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600,
                    background: s.done ? 'rgba(16,185,129,0.15)' : active ? 'rgba(34,211,238,0.15)' : 'rgba(255,255,255,0.05)',
                    border: `1px solid ${s.done ? 'rgba(16,185,129,0.4)' : active ? 'rgba(34,211,238,0.5)' : 'rgba(255,255,255,0.1)'}`,
                    color: s.done ? '#34d399' : active ? '#22d3ee' : 'rgba(255,255,255,0.4)',
                  }}
                >
                  {s.done ? <Check size={15} /> : <Icon size={15} />}
                </span>
                <span style={{ fontSize: 12, color: active ? '#fff' : 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap' }}>
                  {i + 1}. {s.title}
                </span>
              </button>
              {i < status.steps.length - 1 && (
                <div style={{ flex: 1, height: 1, margin: '0 10px', background: s.done ? 'rgba(16,185,129,0.35)' : 'rgba(255,255,255,0.08)' }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Card */}
      <div className="card" style={{ padding: 24 }}>
        {error && (
          <div className="badge badge-danger" style={{ display: 'block', padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
            {error}
          </div>
        )}

        {currentDef?.id === 'channel' && (
          <ChannelStep status={status} busy={busy} onSave={async (body) => {
            setBusy(true); setError('');
            try { await saveStep('channel', body); goNext(); }
            catch (err: any) { setError(err?.message || 'No se pudo guardar el canal'); }
            finally { setBusy(false); }
          }} />
        )}

        {currentDef?.id === 'program' && (
          <ProgramStep fetchApi={fetchApi} busy={busy} onSave={async (body) => {
            setBusy(true); setError('');
            try { await saveStep('program', body); goNext(); }
            catch (err: any) { setError(err?.message || 'No se pudo guardar el programa'); }
            finally { setBusy(false); }
          }} />
        )}

        {currentDef?.id === 'persons' && (
          <PersonsStep fetchApi={fetchApi} busy={busy} onSave={async (body) => {
            setBusy(true); setError('');
            try { await saveStep('persons', body); goNext(); }
            catch (err: any) { setError(err?.message || 'No se pudo guardar las personas'); }
            finally { setBusy(false); }
          }} />
        )}

        {currentDef?.id === 'channels' && (
          <ChannelsStep fetchApi={fetchApi} busy={busy} onSave={async (body) => {
            setBusy(true); setError('');
            try {
              await saveStep('channels', body);
              await finish();
            } catch (err: any) {
              setError(err?.message || 'No se pudo guardar las redes');
            } finally { setBusy(false); }
          }} />
        )}

        {/* Nav */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
          <button className="btn btn-secondary" onClick={goBack} disabled={stepIdx === 0 || busy}>
            <ChevronLeft size={15} /> Atrás
          </button>
          <span className="hint" style={{ alignSelf: 'center' }}>
            Paso {stepIdx + 1} de {status.steps.length}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Step 1: Canal ───────────────────────────────────────────────────────────

function ChannelStep({ status, busy, onSave }: {
  status: OnboardingStatus;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const channel = status.data?.channel;
  const [name, setName] = useState(channel?.name ?? '');
  const [platformName, setPlatformName] = useState(channel?.platformName ?? '');
  const [timezone, setTimezone] = useState(channel?.timezone ?? 'America/Argentina/Buenos_Aires');
  const [slug, setSlug] = useState(channel?.slug ?? '');
  const [localErr, setLocalErr] = useState('');

  const submit = async () => {
    setLocalErr('');
    if (!name.trim()) { setLocalErr('El nombre del canal es obligatorio'); return; }
    if (!platformName.trim()) { setLocalErr('El nombre de la plataforma es obligatorio'); return; }
    const body: Record<string, unknown> = { name: name.trim(), platformName: platformName.trim(), timezone };
    if (slug.trim()) body.slug = slug.trim();
    await onSave(body);
  };

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Tu canal</h3>
      <p className="hint" style={{ marginBottom: 16 }}>Datos básicos de tu medio. El slug es la URL pública única.</p>

      <div className="form-grid-2">
        <div className="form-group">
          <label htmlFor="obChannelName">Nombre del canal *</label>
          <input id="obChannelName" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Canal 12" />
        </div>
        <div className="form-group">
          <label htmlFor="obPlatformName">Nombre de la plataforma *</label>
          <input id="obPlatformName" type="text" value={platformName} onChange={(e) => setPlatformName(e.target.value)} placeholder="Canal 12 Noticias" />
        </div>
      </div>

      <div className="form-grid-2">
        <div className="form-group">
          <label htmlFor="obSlug">Slug (URL pública)</label>
          <input id="obSlug" type="text" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="canal-12" />
          <span className="hint">Minúsculas, números y guiones. Debe ser único.</span>
        </div>
        <div className="form-group">
          <label htmlFor="obTimezone">Timezone</label>
          <input id="obTimezone" type="text" list="ob-tz-list" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          <datalist id="ob-tz-list">
            {TIMEZONES.map((tz) => <option key={tz} value={tz} />)}
          </datalist>
        </div>
      </div>

      {localErr && <div className="badge badge-danger" style={{ display: 'block', padding: '8px 12px', marginBottom: 12 }}>{localErr}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          Siguiente <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Programa ────────────────────────────────────────────────────────

function ProgramStep({ fetchApi, busy, onSave }: {
  fetchApi: <T = unknown>(endpoint: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [programId, setProgramId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [localErr, setLocalErr] = useState('');

  const { loading: loadingList, error: listError, reload: reloadList } = useAsyncData(
    async () => {
      const data = await fetchApi<{ programs: Program[] }>('/programs', { method: 'GET' });
      const list = data.programs ?? [];
      setPrograms(list);
      if (list.length > 0) {
        setMode('existing');
        setProgramId(list[0].id);
      }
      return data;
    },
    [fetchApi],
  );

  const submit = async () => {
    setLocalErr('');
    if (mode === 'existing') {
      if (!programId) { setLocalErr('Elegí un programa'); return; }
      await onSave({ programId });
    } else {
      if (!name.trim()) { setLocalErr('El nombre del programa es obligatorio'); return; }
      await onSave({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Tu primer programa</h3>
      <p className="hint" style={{ marginBottom: 16 }}>Necesitás al menos un programa activo para operar.</p>

      {loadingList ? (
        <p className="hint">Cargando programas…</p>
      ) : listError ? (
        <ErrorState error={listError} compact onRetry={() => void reloadList()} />
      ) : (
        <>
          {programs.length > 0 && (
            <div className="form-group">
              <label>Programa existente</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button
                  type="button"
                  className={`btn btn-sm ${mode === 'existing' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setMode('existing')}
                >
                  Elegir existente
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${mode === 'new' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setMode('new')}
                >
                  Crear nuevo
                </button>
              </div>
              {mode === 'existing' && (
                <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
                  {programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </div>
          )}

          {(mode === 'new' || programs.length === 0) && (
            <>
              <div className="form-group">
                <label htmlFor="obProgramName">Nombre del programa *</label>
                <input id="obProgramName" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Informativo Central" />
              </div>
              <div className="form-group">
                <label htmlFor="obProgramDesc">Descripción</label>
                <input id="obProgramDesc" type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opcional" />
              </div>
            </>
          )}
        </>
      )}

      {localErr && <div className="badge badge-danger" style={{ display: 'block', padding: '8px 12px', marginBottom: 12 }}>{localErr}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={submit} disabled={busy || loadingList}>
          Siguiente <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Personas ────────────────────────────────────────────────────────

function PersonsStep({ fetchApi, busy, onSave }: {
  fetchApi: <T = unknown>(endpoint: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [persons, setPersons] = useState<Person[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('conductor');
  const [adding, setAdding] = useState(false);
  const [localErr, setLocalErr] = useState('');

  const { loading: loadingList, error: listError, reload: reloadList } = useAsyncData(
    async () => {
      const data = await fetchApi<{ items: Person[] }>('/persons?limit=200', { method: 'GET' });
      setPersons(data.items ?? []);
      return data;
    },
    [fetchApi],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const addPerson = async () => {
    setLocalErr('');
    if (!newName.trim()) { setLocalErr('Escribí el nombre de la persona'); return; }
    setAdding(true);
    try {
      const data = await fetchApi<{ person: Person }>('/persons', {
        method: 'POST',
        body: { name: newName.trim(), role: newRole },
      });
      if (data?.person?.id) {
        setPersons((prev) => [...prev, data.person]);
        setSelected((prev) => new Set(prev).add(data.person.id));
      }
      setNewName('');
    } catch (err: any) {
      setLocalErr(err?.message || 'No se pudo crear la persona');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Personas del canal</h3>
      <p className="hint" style={{ marginBottom: 16 }}>
        Conductores, columnistas, invitados… Podés agregar ahora o seguir sin personas.
      </p>

      {loadingList ? (
        <p className="hint">Cargando personas…</p>
      ) : listError ? (
        <ErrorState error={listError} compact onRetry={() => void reloadList()} />
      ) : (
        <>
          {persons.length > 0 && (
            <div className="form-group">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {persons.map((p) => (
                  <label key={p.id} className="checkbox-label" style={{ padding: '6px 8px', borderRadius: 8, background: selected.has(p.id) ? 'rgba(34,211,238,0.06)' : 'transparent' }}>
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    <span style={{ flex: 1 }}>{p.name}</span>
                    <span className="badge badge-info" style={{ fontSize: 11 }}>{p.role}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Agregar persona rápida</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nombre" style={{ flex: 2 }} />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value)} style={{ flex: 1 }}>
                {PERSON_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <button type="button" className="btn btn-secondary" onClick={addPerson} disabled={adding || busy}>
                <Plus size={14} /> Agregar
              </button>
            </div>
          </div>
        </>
      )}

      {localErr && <div className="badge badge-danger" style={{ display: 'block', padding: '8px 12px', marginBottom: 12 }}>{localErr}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={() => onSave({ personIds: [...selected] })} disabled={busy || adding}>
          Siguiente <ChevronRight size={15} />
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Canales y redes ─────────────────────────────────────────────────

function ChannelsStep({ fetchApi, busy, onSave }: {
  fetchApi: <T = unknown>(endpoint: string, options?: { method?: string; body?: unknown }) => Promise<T>;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [localErr, setLocalErr] = useState('');

  const { loading: loadingList, error: listError, reload: reloadList } = useAsyncData(
    async () => {
      const data = await fetchApi<Portfolio[]>('/connections/portfolios', { method: 'GET' });
      const list = Array.isArray(data) ? data : [];
      setPortfolios(list);
      setSelected(new Set(list.filter((p) => p.isActive).map((p) => p.id)));
      return data;
    },
    [fetchApi],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const addPortfolio = async () => {
    setLocalErr('');
    if (!newName.trim()) { setLocalErr('Escribí el nombre de la red'); return; }
    setAdding(true);
    try {
      const data = await fetchApi<Portfolio>('/connections/portfolios', {
        method: 'POST',
        body: { name: newName.trim() },
      });
      if (data?.id) {
        setPortfolios((prev) => [...prev, data]);
        setSelected((prev) => new Set(prev).add(data.id));
      }
      setNewName('');
    } catch (err: any) {
      setLocalErr(err?.message || 'No se pudo crear la red');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Canales y redes</h3>
      <p className="hint" style={{ marginBottom: 16 }}>
        Elegí qué redes sociales quedan activas para publicar. Podés crear nuevas o seguir sin activar ninguna.
      </p>

      {loadingList ? (
        <p className="hint">Cargando redes…</p>
      ) : listError ? (
        <ErrorState error={listError} compact onRetry={() => void reloadList()} />
      ) : (
        <>
          {portfolios.length > 0 && (
            <div className="form-group">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {portfolios.map((p) => (
                  <label key={p.id} className="checkbox-label" style={{ padding: '6px 8px', borderRadius: 8, background: selected.has(p.id) ? 'rgba(34,211,238,0.06)' : 'transparent' }}>
                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    <span style={{ flex: 1 }}>{p.name}</span>
                    {(p.assets?.length ?? 0) > 0 && (
                      <span className="hint">{p.assets!.length} asset{p.assets!.length === 1 ? '' : 's'}</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Agregar red</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nombre (p.ej. Principal)" style={{ flex: 1 }} />
              <button type="button" className="btn btn-secondary" onClick={addPortfolio} disabled={adding || busy}>
                <Plus size={14} /> Agregar
              </button>
            </div>
            <span className="hint">Después podés conectar Meta/Twitter desde Conexiones.</span>
          </div>
        </>
      )}

      {localErr && <div className="badge badge-danger" style={{ display: 'block', padding: '8px 12px', marginBottom: 12 }}>{localErr}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={() => onSave({ portfolioIds: [...selected] })} disabled={busy || adding}>
          Guardar y finalizar <Check size={15} />
        </button>
      </div>
    </div>
  );
}
