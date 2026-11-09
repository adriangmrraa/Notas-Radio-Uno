import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Newspaper, Mail, Lock, User, ArrowRight, AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';

interface InvitePreview {
  email: string;
  role: 'editor' | 'viewer';
  tenantName: string;
  tenantSlug: string | null;
  invitedByName: string | null;
  expiresAt: string;
}

export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { fetchApi } = useApi();
  const navigate = useNavigate();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ message: string; email: string } | null>(null);

  useEffect(() => {
    if (!token) {
      setError('El link no incluye el token de la invitación.');
      setLoading(false);
      return;
    }

    fetchApi<InvitePreview>(`/team/invite/${token}`, { skipRedirect: true })
      .then(setPreview)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Invitación inválida'))
      .finally(() => setLoading(false));
  }, [token, fetchApi]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await fetchApi<{ message: string; email: string }>(`/team/invite/${token}/accept`, {
        method: 'POST',
        body: { fullName, password },
        skipRedirect: true,
      });
      setDone(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No se pudo aceptar la invitación');
    } finally {
      setSubmitting(false);
    }
  };

  const roleLabel = preview?.role === 'viewer' ? 'lector (solo lectura)' : 'editor';

  return (
    <div className="min-h-screen bg-void flex items-center justify-center px-4 relative overflow-hidden">
      <div className="glow-orb glow-orb-cyan w-[600px] h-[600px] -top-40 -right-60" />
      <div className="glow-orb glow-orb-purple w-[500px] h-[500px] -bottom-40 -left-60" style={{ animationDelay: '2s' }} />

      <div className="w-full max-w-md relative z-10 animate-slide-up">
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-cyan-600/10 flex items-center justify-center border border-cyan-500/20 mb-4 shadow-glow-cyan">
            <Newspaper className="w-8 h-8 text-cyan-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
            PeriodistApp
          </h1>
          <p className="text-white/25 text-xs mt-1 tracking-wider uppercase">AI-Powered Newsroom</p>
        </div>

        <div className="glass-card-static p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />

          {loading && (
            <div className="flex items-center justify-center gap-3 py-10 text-white/40 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Validando invitación…
            </div>
          )}

          {!loading && done && (
            <div className="text-center">
              <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">¡Listo!</h2>
              <p className="text-white/40 text-sm mb-6">{done.message}</p>
              <button
                onClick={() => navigate('/login')}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                Iniciar sesión
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {!loading && !done && error && (
            <div className="text-center">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h2 className="text-xl font-semibold mb-2">No pudimos validar la invitación</h2>
              <p className="text-white/40 text-sm mb-6">{error}</p>
              <Link to="/login" className="text-cyan-400 text-sm hover:underline">
                Volver al login
              </Link>
            </div>
          )}

          {!loading && !done && !error && preview && (
            <>
              <h2 className="text-xl font-semibold mb-1">Te invitaron a {preview.tenantName}</h2>
              <p className="text-white/35 text-sm mb-6">
                {preview.invitedByName ? `${preview.invitedByName} te sumó` : 'Te sumaron'} al equipo como{' '}
                <span className="text-white/60">{roleLabel}</span>.
              </p>

              <div className="mb-5 p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06] text-sm text-white/60 flex items-center gap-2">
                <Mail className="w-4 h-4 text-white/30 shrink-0" />
                {preview.email}
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
                    Tu nombre
                  </label>
                  <div className="relative group">
                    <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors" />
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                      minLength={2}
                      className="input-premium pl-11"
                      placeholder="Nombre y apellido"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">
                    Creá tu contraseña
                  </label>
                  <div className="relative group">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      className="input-premium pl-11"
                      placeholder="Mínimo 8 caracteres"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                  Unirme al equipo
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
