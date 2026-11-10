import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FilterX, Inbox, Sparkles } from 'lucide-react';
import { useApi } from '../hooks/useApi';

type Asset = { id: string; kind: string; title: string | null; status: string };
type Page = { assets: Asset[]; total: number; page: number; pageSize: number };
type Program = { id: string; name: string };
type Transmission = { id: string; programId?: string | null; name?: string; status?: string };

const KIND_LABELS: Record<string, string> = {
  clip: 'Clip',
  note: 'Nota',
  flyer: 'Flyer',
  post: 'Post',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  pending_review: 'Revisión pendiente',
  approved: 'Aprobado',
  published: 'Publicado',
  archived: 'Archivado',
};

const DEFAULT_TEXT_INSTRUCTION = 'Mejorá claridad y concisión sin inventar hechos.';
const DEFAULT_IMAGE_INSTRUCTION = 'Regenerá la imagen manteniendo el contexto editorial.';

interface TextEditState {
  assetId: string;
  instruction: string;
  proposal: string | null;
  provider: string | null;
  proposing: boolean;
  applying: boolean;
}

interface FlyerRegenState {
  assetId: string;
  instruction: string;
  running: boolean;
}

export function AssetsInboxPage() {
  const { fetchApi } = useApi();
  const navigate = useNavigate();
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [programId, setProgramId] = useState('');
  const [transmissionId, setTransmissionId] = useState('');
  const [programs, setPrograms] = useState<Program[]>([]);
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page>({ assets: [], total: 0, page: 1, pageSize: 25 });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<TextEditState | null>(null);
  const [flyerRegen, setFlyerRegen] = useState<FlyerRegenState | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    fetchApi<{ programs?: Program[] }>('/programs')
      .then((r) => setPrograms(r.programs ?? []))
      .catch(() => {});
    fetchApi<{ transmissions?: Transmission[] }>('/transmissions')
      .then((r) => setTransmissions(r.transmissions ?? []))
      .catch(() => {});
  }, [fetchApi]);

  const visibleTransmissions = transmissions.filter((t) => !programId || t.programId === programId);

  const query = useMemo(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (kind) q.set('kind', kind);
    if (status) q.set('status', status);
    if (programId) q.set('programId', programId);
    if (transmissionId) q.set('transmissionId', transmissionId);
    return q;
  }, [kind, status, programId, transmissionId, page]);

  useEffect(() => {
    fetchApi<Page>(`/assets?${query}`)
      .then(setData)
      .catch(() => setData({ assets: [], total: 0, page, pageSize: 25 }));
  }, [fetchApi, query, page, refreshTick]);

  const errorMessage = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;

  const startTextEdit = (asset: Asset) => {
    setFeedback(null);
    setFlyerRegen(null);
    setTextEdit({
      assetId: asset.id,
      instruction: DEFAULT_TEXT_INSTRUCTION,
      proposal: null,
      provider: null,
      proposing: false,
      applying: false,
    });
  };

  const requestProposal = async () => {
    if (!textEdit) return;
    setFeedback(null);
    setTextEdit({ ...textEdit, proposing: true, proposal: null, provider: null });
    try {
      const result = await fetchApi<{ proposal: string; provider: string }>(
        `/assets/${textEdit.assetId}/edit-text`,
        { method: 'POST', body: { instruction: textEdit.instruction } },
      );
      setTextEdit((current) =>
        current ? { ...current, proposal: result.proposal, provider: result.provider, proposing: false } : current,
      );
    } catch (error) {
      setTextEdit((current) => (current ? { ...current, proposing: false } : current));
      setFeedback(errorMessage(error, 'Falló la edición con IA.'));
    }
  };

  const applyProposal = async () => {
    if (!textEdit || !textEdit.proposal) return;
    setTextEdit({ ...textEdit, applying: true });
    try {
      await fetchApi(`/assets/${textEdit.assetId}/apply-text`, {
        method: 'POST',
        body: { text: textEdit.proposal },
      });
      setTextEdit(null);
      setFeedback('Edición aplicada: se actualizó el asset y la publicación.');
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setTextEdit((current) => (current ? { ...current, applying: false } : current));
      setFeedback(errorMessage(error, 'No se pudo aplicar la edición.'));
    }
  };

  const reprocessClip = async (asset: Asset) => {
    setAction(`${asset.id}:reprocess`);
    setFeedback(null);
    try {
      const result = await fetchApi<{ jobId: string }>(`/assets/${asset.id}/regenerate`, {
        method: 'POST',
        body: {},
      });
      setFeedback(`Re-encuadre del clip encolado (job ${result.jobId}).`);
    } catch (error) {
      setFeedback(errorMessage(error, 'No se pudo encolar el reprocesamiento.'));
    } finally {
      setAction(null);
    }
  };

  const startFlyerRegen = (asset: Asset) => {
    setFeedback(null);
    setTextEdit(null);
    setFlyerRegen({ assetId: asset.id, instruction: DEFAULT_IMAGE_INSTRUCTION, running: false });
  };

  const regenerateFlyer = async () => {
    if (!flyerRegen) return;
    setFeedback(null);
    setFlyerRegen({ ...flyerRegen, running: true });
    try {
      await fetchApi(`/assets/${flyerRegen.assetId}/regenerate`, {
        method: 'POST',
        body: { instruction: flyerRegen.instruction },
      });
      setFlyerRegen(null);
      setFeedback('Imagen regenerada y vinculada al asset.');
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setFlyerRegen((current) => (current ? { ...current, running: false } : current));
      setFeedback(errorMessage(error, 'No se pudo regenerar la imagen.'));
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Bandeja de assets</h2>
          <p className="text-sm text-white/50">Contenido editorial unificado.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setKind('');
            setStatus('');
            setProgramId('');
            setTransmissionId('');
            setPage(1);
          }}
          className="btn-secondary"
        >
          <FilterX className="w-4 h-4" />
          Limpiar filtros
        </button>
      </div>

      {feedback && <p role="status">{feedback}</p>}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <label>
          Tipo
          <select aria-label="Tipo" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
            <option value="">Todos</option>
            {['clip', 'note', 'flyer', 'post'].map((value) => (
              <option key={value} value={value}>{KIND_LABELS[value] ?? value}</option>
            ))}
          </select>
        </label>
        <label>
          Estado
          <select aria-label="Estado" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Todos</option>
            {['draft', 'pending_review', 'approved', 'published', 'archived'].map((value) => (
              <option key={value} value={value}>{STATUS_LABELS[value] ?? value}</option>
            ))}
          </select>
        </label>
        <label>
          Programa
          <select
            aria-label="Programa"
            value={programId}
            onChange={(e) => { setProgramId(e.target.value); setTransmissionId(''); setPage(1); }}
          >
            <option value="">Todos</option>
            {programs.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label>
          Transmisión
          <select aria-label="Transmisión" value={transmissionId} onChange={(e) => { setTransmissionId(e.target.value); setPage(1); }}>
            <option value="">Todas</option>
            {visibleTransmissions.map((t) => (
              <option key={t.id} value={t.id}>{t.name || t.status || t.id}</option>
            ))}
          </select>
        </label>
      </div>

      {data.assets.length === 0 ? (
        <div className="p-12 text-center">
          <Inbox className="mx-auto" />
          <h3>No hay assets para estos filtros</h3>
        </div>
      ) : (
        <ul>
          {data.assets.map((asset) => (
            <li key={asset.id} className="p-4">
              <strong>{asset.title || 'Asset sin título'}</strong>
              <p>
                {KIND_LABELS[asset.kind] ?? asset.kind} · {STATUS_LABELS[asset.status] ?? asset.status}
              </p>
              <button type="button" onClick={() => navigate(asset.kind === 'clip' ? '/clips' : '/review')}>
                Abrir asset
              </button>
              {(asset.kind === 'note' || asset.kind === 'post') && (
                <button type="button" onClick={() => startTextEdit(asset)}>
                  <Sparkles className="w-4 h-4" />
                  Editar con IA
                </button>
              )}
              {asset.kind === 'clip' && (
                <button
                  type="button"
                  disabled={action === `${asset.id}:reprocess`}
                  onClick={() => void reprocessClip(asset)}
                >
                  {action === `${asset.id}:reprocess` ? 'Encolando…' : 'Reprocesar clip'}
                </button>
              )}
              {asset.kind === 'flyer' && (
                <button type="button" onClick={() => startFlyerRegen(asset)}>
                  Regenerar imagen
                </button>
              )}

              {textEdit?.assetId === asset.id && (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-white/60">
                    Instrucción editorial
                    <input
                      value={textEdit.instruction}
                      onChange={(e) => setTextEdit({ ...textEdit, instruction: e.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={textEdit.proposing || textEdit.applying || !textEdit.instruction.trim()}
                    onClick={() => void requestProposal()}
                  >
                    {textEdit.proposing ? 'Generando propuesta…' : 'Generar propuesta'}
                  </button>
                  {textEdit.proposal !== null && (
                    <>
                      <textarea
                        aria-label="Propuesta de texto editada"
                        rows={5}
                        value={textEdit.proposal}
                        onChange={(e) => setTextEdit({ ...textEdit, proposal: e.target.value })}
                      />
                      <p className="text-xs text-white/40">
                        Propuesta generada por {textEdit.provider}. Podés revisarla y editarla antes de aplicar.
                      </p>
                      <button type="button" disabled={textEdit.applying} onClick={() => void applyProposal()}>
                        {textEdit.applying ? 'Aplicando…' : 'Aplicar edición'}
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => setTextEdit(null)}>
                    Descartar
                  </button>
                </div>
              )}

              {flyerRegen?.assetId === asset.id && (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-white/60">
                    Instrucción para la imagen
                    <input
                      value={flyerRegen.instruction}
                      onChange={(e) => setFlyerRegen({ ...flyerRegen, instruction: e.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={flyerRegen.running || !flyerRegen.instruction.trim()}
                    onClick={() => void regenerateFlyer()}
                  >
                    {flyerRegen.running ? 'Generando…' : 'Generar imagen'}
                  </button>
                  <button type="button" onClick={() => setFlyerRegen(null)}>
                    Cancelar
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <nav aria-label="Paginación">
        <button type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>
          Anterior
        </button>
        <span>
          {data.total} assets · página {page}
        </span>
        <button type="button" disabled={page * 25 >= data.total} onClick={() => setPage(page + 1)}>
          Siguiente
        </button>
      </nav>
    </section>
  );
}
