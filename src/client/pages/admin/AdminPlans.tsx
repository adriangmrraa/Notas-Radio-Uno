import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Loader2, Save, AlertCircle } from 'lucide-react';
import { useApi } from '../../hooks/useApi';

interface AdminPlan {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  priceUsd: string;
  priceUsdYearly: string | null;
  priceArs: string | null;
  priceArsYearly: string | null;
  transmissionsPerCycle: number | null;
  maxTransmissionMinutes: number | null;
  maxClipsPerTransmission: number | null;
  maxPeople: number | null;
  rawRetentionDays: number | null;
  maxTeamMembers: number;
  maxStorageGb: number;
  isActive: boolean;
  sortOrder: number;
}

type DraftField = 'priceUsd' | 'priceArs' | 'transmissionsPerCycle' | 'maxTransmissionMinutes'
  | 'maxClipsPerTransmission' | 'maxPeople' | 'rawRetentionDays' | 'maxTeamMembers'
  | 'maxStorageGb' | 'sortOrder' | 'displayName';

type Draft = Partial<Record<DraftField, string>>;

function NumCell({ value, field, draft, onChange, placeholder }: {
  value: number | null;
  field: DraftField;
  draft: Draft;
  onChange: (field: DraftField, v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      className="w-20 bg-white/[0.03] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-white/80 focus:outline-none focus:border-cyan-500/40"
      value={draft[field] ?? (value === null ? '' : String(value))}
      placeholder={placeholder ?? '—'}
      onChange={(e) => onChange(field, e.target.value)}
    />
  );
}

export function AdminPlans() {
  const { fetchApi } = useApi();
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setPlans(await fetchApi<AdminPlan[]>('/admin/plans'));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando planes');
    } finally {
      setLoading(false);
    }
  }, [fetchApi]);

  useEffect(() => { load(); }, [load]);

  const setDraft = (planId: string, field: DraftField, v: string) => {
    setDrafts((prev) => ({ ...prev, [planId]: { ...prev[planId], [field]: v } }));
  };

  const toggleActive = async (plan: AdminPlan) => {
    setSaving(plan.id);
    try {
      await fetchApi(`/admin/plans/${plan.id}`, { method: 'PATCH', body: { isActive: !plan.isActive } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error actualizando plan');
    } finally {
      setSaving(null);
    }
  };

  const saveRow = async (plan: AdminPlan) => {
    const draft = drafts[plan.id];
    if (!draft) return;
    setSaving(plan.id);
    setNotice('');
    try {
      const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : Number(v));
      await fetchApi(`/admin/plans/${plan.id}`, {
        method: 'PATCH',
        body: {
          ...(draft.displayName !== undefined ? { displayName: draft.displayName } : {}),
          ...(draft.priceUsd !== undefined ? { priceUsd: Number(draft.priceUsd) } : {}),
          ...(draft.priceArs !== undefined ? { priceArs: num(draft.priceArs) } : {}),
          ...(draft.transmissionsPerCycle !== undefined ? { transmissionsPerCycle: num(draft.transmissionsPerCycle) } : {}),
          ...(draft.maxTransmissionMinutes !== undefined ? { maxTransmissionMinutes: num(draft.maxTransmissionMinutes) } : {}),
          ...(draft.maxClipsPerTransmission !== undefined ? { maxClipsPerTransmission: num(draft.maxClipsPerTransmission) } : {}),
          ...(draft.maxPeople !== undefined ? { maxPeople: num(draft.maxPeople) } : {}),
          ...(draft.rawRetentionDays !== undefined ? { rawRetentionDays: num(draft.rawRetentionDays) } : {}),
          ...(draft.maxTeamMembers !== undefined ? { maxTeamMembers: num(draft.maxTeamMembers) } : {}),
          ...(draft.maxStorageGb !== undefined ? { maxStorageGb: num(draft.maxStorageGb) } : {}),
          ...(draft.sortOrder !== undefined ? { sortOrder: num(draft.sortOrder) } : {}),
        },
      });
      setDrafts((prev) => { const next = { ...prev }; delete next[plan.id]; return next; });
      setNotice(`Plan ${plan.name} actualizado`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando plan');
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-white/40" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <CreditCard className="w-5 h-5 text-cyan-400" />
        <div>
          <h1 className="text-lg font-semibold">Planes</h1>
          <p className="text-xs text-white/30">Catálogo completo (incluye inactivos). Vacío = ilimitado / sin tope.</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 rounded-lg px-3 py-2">
          {notice}
        </div>
      )}

      <div className="glass-card-static overflow-x-auto">
        <table className="table-premium">
          <thead>
            <tr>
              <th>Plan</th>
              <th>USD/mes</th>
              <th>ARS/mes</th>
              <th>Transmisiones</th>
              <th>Min máx</th>
              <th>Clips</th>
              <th>Personas</th>
              <th>Retención (d)</th>
              <th>Equipo</th>
              <th>Storage GB</th>
              <th>Orden</th>
              <th>Activo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => {
              const draft = drafts[plan.id] ?? {};
              const dirty = Object.keys(draft).length > 0;
              const onChange = (field: DraftField, v: string) => setDraft(plan.id, field, v);
              return (
                <tr key={plan.id} className={!plan.isActive ? 'opacity-50' : ''}>
                  <td>
                    <input
                      className="w-28 bg-white/[0.03] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-white/80 focus:outline-none focus:border-cyan-500/40"
                      value={draft.displayName ?? plan.displayName}
                      onChange={(e) => onChange('displayName', e.target.value)}
                    />
                    <p className="text-[10px] text-white/25 mt-0.5">{plan.name}</p>
                  </td>
                  <td><NumCell value={Number(plan.priceUsd)} field="priceUsd" draft={draft} onChange={onChange} /></td>
                  <td><NumCell value={plan.priceArs === null ? null : Number(plan.priceArs)} field="priceArs" draft={draft} onChange={onChange} /></td>
                  <td><NumCell value={plan.transmissionsPerCycle} field="transmissionsPerCycle" draft={draft} onChange={onChange} placeholder="∞" /></td>
                  <td><NumCell value={plan.maxTransmissionMinutes} field="maxTransmissionMinutes" draft={draft} onChange={onChange} /></td>
                  <td><NumCell value={plan.maxClipsPerTransmission} field="maxClipsPerTransmission" draft={draft} onChange={onChange} /></td>
                  <td><NumCell value={plan.maxPeople} field="maxPeople" draft={draft} onChange={onChange} placeholder="∞" /></td>
                  <td><NumCell value={plan.rawRetentionDays} field="rawRetentionDays" draft={draft} onChange={onChange} /></td>
                  <td><NumCell value={plan.maxTeamMembers} field="maxTeamMembers" draft={draft} onChange={onChange} /></td>
                  <td><NumCell value={plan.maxStorageGb} field="maxStorageGb" draft={draft} onChange={onChange} /></td>
                  <td><NumCell value={plan.sortOrder} field="sortOrder" draft={draft} onChange={onChange} /></td>
                  <td>
                    <button
                      onClick={() => toggleActive(plan)}
                      disabled={saving === plan.id}
                      className={`text-[11px] px-2 py-1 rounded-lg transition-colors ${
                        plan.isActive
                          ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                          : 'bg-white/[0.04] text-white/30 hover:bg-white/[0.08]'
                      }`}
                    >
                      {plan.isActive ? 'Activo' : 'Inactivo'}
                    </button>
                  </td>
                  <td>
                    <button
                      onClick={() => saveRow(plan)}
                      disabled={!dirty || saving === plan.id}
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      {saving === plan.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      Guardar
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
