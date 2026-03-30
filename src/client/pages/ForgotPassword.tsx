import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Newspaper, Mail, ArrowLeft, CheckCircle, Send } from 'lucide-react';
import { useApi } from '../hooks/useApi';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { fetchApi } = useApi();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await fetchApi('/auth/forgot-password', {
        method: 'POST',
        body: { email },
        skipRedirect: true,
      });
      setSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al enviar email');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center px-4 relative overflow-hidden">
        <div className="glow-orb glow-orb-cyan w-[500px] h-[500px] top-1/4 left-1/3 opacity-[0.08]" />
        <div className="w-full max-w-md text-center relative z-10 animate-scale-in">
          <div className="glass-card-static p-10">
            <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-5 ring-2 ring-emerald-500/20">
              <CheckCircle className="w-10 h-10 text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold mb-2">Email enviado</h2>
            <p className="text-white/40 mb-8">
              Si existe una cuenta con <span className="text-white font-medium">{email}</span>, recibiras un link para resetear tu password.
            </p>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-cyan-400 hover:text-cyan-300 transition-colors duration-300 text-sm font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Volver a login
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-void flex items-center justify-center px-4 relative overflow-hidden">
      <div className="glow-orb glow-orb-cyan w-[500px] h-[500px] -top-40 -right-60" />
      <div className="glow-orb glow-orb-purple w-[400px] h-[400px] -bottom-40 -left-40" style={{ animationDelay: '2s' }} />

      <div className="w-full max-w-md relative z-10 animate-slide-up">
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-cyan-600/10 flex items-center justify-center border border-cyan-500/20 mb-4 shadow-glow-cyan">
            <Newspaper className="w-8 h-8 text-cyan-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">PeriodistApp</h1>
        </div>

        <div className="glass-card-static p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />

          <h2 className="text-xl font-semibold mb-1">Recuperar password</h2>
          <p className="text-white/35 text-sm mb-6">Te enviaremos un link para resetear tu password</p>

          {error && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-500/8 border border-red-500/15 text-red-400 text-sm flex items-center gap-2 animate-scale-in">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Email</label>
              <div className="relative group">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors duration-300" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="input-premium pl-11"
                  placeholder="tu@email.com"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full flex items-center justify-center gap-2 py-3"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Enviar link de recuperacion
                </>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-white/25 mt-8">
          <Link to="/login" className="inline-flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300 transition-colors duration-300 font-medium">
            <ArrowLeft className="w-3.5 h-3.5" />
            Volver a login
          </Link>
        </p>
      </div>
    </div>
  );
}
