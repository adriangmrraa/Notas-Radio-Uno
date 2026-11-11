import { useState } from 'react';
import {
  Users, Mail, UserPlus, Trash2, Send, Shield, Eye, PenLine, Crown, AlertCircle, CheckCircle,
} from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useAsyncData } from '../../hooks/useAsyncData';
import { ErrorState, LoadingState } from '../feedback';
import { useAuth } from '../../contexts/AuthContext';

type Role = 'owner' | 'editor' | 'viewer';

interface Member {
  id: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  role: Role;
  status: string;
  isVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface Invite {
  id: string;
  email: string;
  role: Role;
  status: string;
  expiresAt: string;
  lastSentAt: string;
  createdAt: string;
  invitedByName: string | null;
  isExpired: boolean;
}

interface TeamData {
  members: Member[];
  invites: Invite[];
  seats: { used: number; limit: number };
}

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Lector',
};

const ROLE_ICON: Record<Role, typeof Crown> = {
  owner: Crown,
  editor: PenLine,
  viewer: Eye,
};

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
}

export function TeamSettings() {
  const { user } = useAuth();
  const { fetchApi } = useApi();

  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');

  const isOwner = user?.role === 'owner';

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const { data, loading, error, reload } = useAsyncData(
    () => fetchApi<TeamData>('/team'),
    [],
  );
  const load = reload;

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setBusy('invite');
    try {
      const result = await fetchApi<{ resent: boolean }>('/team/invites', {
        method: 'POST',
        body: { email: inviteEmail.trim(), role: inviteRole },
      });
      showToast('success', result.resent ? 'Invitación reenviada' : 'Invitación enviada');
      setInviteEmail('');
      await load();
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo invitar');
    } finally {
      setBusy(null);
    }
  };

  const resend = async (invite: Invite) => {
    setBusy(`resend:${invite.id}`);
    try {
      await fetchApi(`/team/invites/${invite.id}/resend`, { method: 'POST' });
      showToast('success', `Invitación reenviada a ${invite.email}`);
      await load();
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo reenviar');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (invite: Invite) => {
    if (!window.confirm(`¿Revocar la invitación de ${invite.email}?`)) return;
    setBusy(`revoke:${invite.id}`);
    try {
      await fetchApi(`/team/invites/${invite.id}`, { method: 'DELETE' });
      showToast('success', 'Invitación revocada');
      await load();
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo revocar');
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (member: Member, role: Role) => {
    setBusy(`role:${member.id}`);
    try {
      await fetchApi(`/team/members/${member.id}/role`, { method: 'PATCH', body: { role } });
      showToast('success', `Rol de ${member.fullName} actualizado a ${ROLE_LABEL[role]}`);
      await load();
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo cambiar el rol');
    } finally {
      setBusy(null);
    }
  };

  const removeMember = async (member: Member) => {
    if (!window.confirm(`¿Quitar a ${member.fullName} del equipo? Va a perder el acceso.`)) return;
    setBusy(`remove:${member.id}`);
    try {
      await fetchApi(`/team/members/${member.id}`, { method: 'DELETE' });
      showToast('success', `${member.fullName} ya no tiene acceso`);
      await load();
    } catch (err: unknown) {
      showToast('error', err instanceof Error ? err.message : 'No se pudo quitar al miembro');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <LoadingState text="Cargando equipo…" />;
  }

  if (error) {
    return <ErrorState error={error} compact onRetry={() => void reload()} />;
  }

  const seats = data?.seats ?? { used: 0, limit: 1 };
  const seatsFull = seats.used >= seats.limit;

  return (
    <div className="space-y-6">
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 toast ${toast.type === 'success' ? 'toast-success' : 'toast-error'} flex items-center gap-3`}>
          {toast.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span className="text-sm">{toast.msg}</span>
        </div>
      )}

      {/* Cupo */}
      <div className="glass-card-static p-6">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Users className="w-4 h-4 text-cyan-400" />
              Equipo
            </h3>
            <p className="text-xs text-white/35 mt-1">
              Invitá editores para producir y lectores para revisar sin modificar nada.
            </p>
          </div>
          <span className={`text-xs px-2.5 py-1 rounded-lg ${seatsFull ? 'bg-amber-500/10 text-amber-400' : 'bg-white/[0.04] text-white/50'}`}>
            {seats.used} / {seats.limit} colaboradores
          </span>
        </div>

        {/* Invitar */}
        {isOwner ? (
          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="colega@medio.com"
                className="input-premium pl-11"
                disabled={seatsFull || busy === 'invite'}
              />
            </div>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}
              className="px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-white/70"
              disabled={seatsFull || busy === 'invite'}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Lector</option>
            </select>
            <button
              type="submit"
              disabled={seatsFull || busy === 'invite' || !inviteEmail.trim()}
              className="btn-primary flex items-center justify-center gap-2 disabled:opacity-40"
            >
              <UserPlus className="w-4 h-4" />
              Invitar
            </button>
          </form>
        ) : (
          <p className="text-xs text-white/30">Solo el owner puede invitar gente.</p>
        )}

        {seatsFull && isOwner && (
          <p className="text-xs text-amber-400/80 mt-2">
            Llegaste al cupo de colaboradores de tu plan. Mejorá el plan para sumar más.
          </p>
        )}
      </div>

      {/* Miembros */}
      <div className="glass-card-static p-6">
        <h3 className="text-sm font-semibold mb-4">Miembros ({data?.members.length ?? 0})</h3>
        <div className="space-y-2">
          {data?.members.map((member) => {
            const RoleIcon = ROLE_ICON[member.role] ?? Eye;
            const isSelf = member.id === user?.id;
            return (
              <div
                key={member.id}
                className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.04]"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-500/25 to-purple-500/15 flex items-center justify-center text-xs font-semibold text-white/70 shrink-0">
                    {initials(member.fullName) || '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-white/85 truncate">
                      {member.fullName}
                      {isSelf && <span className="text-white/25"> (vos)</span>}
                      {member.status === 'suspended' && <span className="text-amber-400/70 text-xs"> · suspendido</span>}
                    </p>
                    <p className="text-xs text-white/35 truncate">{member.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] text-white/25 hidden sm:block">
                    Alta {formatDate(member.createdAt)}
                  </span>

                  {isOwner && member.role !== 'owner' ? (
                    <select
                      value={member.role}
                      onChange={(e) => changeRole(member, e.target.value as Role)}
                      disabled={busy === `role:${member.id}`}
                      className="px-2.5 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-xs text-white/70"
                    >
                      <option value="editor">Editor</option>
                      <option value="viewer">Lector</option>
                      <option value="owner">Owner</option>
                    </select>
                  ) : (
                    <span className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg bg-white/[0.04] text-white/50">
                      <RoleIcon className="w-3 h-3" />
                      {ROLE_LABEL[member.role]}
                    </span>
                  )}

                  {isOwner && member.role !== 'owner' && (
                    <button
                      onClick={() => removeMember(member)}
                      disabled={busy === `remove:${member.id}`}
                      title="Quitar del equipo"
                      className="p-2 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Invitaciones */}
      <div className="glass-card-static p-6">
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Shield className="w-4 h-4 text-white/40" />
          Invitaciones
          {data && data.invites.length > 0 && (
            <span className="text-xs text-white/30">({data.invites.length})</span>
          )}
        </h3>

        {!data || data.invites.length === 0 ? (
          <p className="text-xs text-white/25">No hay invitaciones todavía.</p>
        ) : (
          <div className="space-y-2">
            {data.invites.map((invite) => {
              const statusLabel = invite.status === 'accepted'
                ? 'Aceptada'
                : invite.status === 'revoked'
                  ? 'Revocada'
                  : invite.isExpired
                    ? 'Vencida'
                    : 'Pendiente';
              const statusClass = invite.status === 'pending' && !invite.isExpired
                ? 'bg-cyan-500/10 text-cyan-400'
                : 'bg-white/[0.04] text-white/35';

              return (
                <div
                  key={invite.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.04]"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white/80 truncate">{invite.email}</p>
                    <p className="text-xs text-white/30">
                      {ROLE_LABEL[invite.role]} · enviada {formatDate(invite.lastSentAt)}
                      {invite.invitedByName ? ` por ${invite.invitedByName}` : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[11px] px-2.5 py-1 rounded-lg ${statusClass}`}>{statusLabel}</span>

                    {isOwner && invite.status !== 'accepted' && (
                      <>
                        <button
                          onClick={() => resend(invite)}
                          disabled={busy === `resend:${invite.id}`}
                          title="Reenviar invitación"
                          className="p-2 rounded-lg text-white/30 hover:text-cyan-400 hover:bg-cyan-500/10 transition-colors disabled:opacity-40"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                        {invite.status !== 'revoked' && (
                          <button
                            onClick={() => revoke(invite)}
                            disabled={busy === `revoke:${invite.id}`}
                            title="Revocar invitación"
                            className="p-2 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
