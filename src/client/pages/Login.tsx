import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Newspaper, Mail, Lock, ArrowRight, Zap } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al iniciar sesion');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-void flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background orbs */}
      <div className="glow-orb glow-orb-cyan w-[600px] h-[600px] -top-40 -right-60" />
      <div className="glow-orb glow-orb-purple w-[500px] h-[500px] -bottom-40 -left-60" style={{ animationDelay: '2s' }} />
      <div className="glow-orb glow-orb-blue w-[300px] h-[300px] top-1/3 left-1/3 opacity-[0.05]" style={{ animationDelay: '3s' }} />

      <div className="w-full max-w-md relative z-10 animate-slide-up">
        {/* Logo */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-cyan-600/10 flex items-center justify-center border border-cyan-500/20 mb-4 shadow-glow-cyan">
            <Newspaper className="w-8 h-8 text-cyan-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">PeriodistApp</h1>
          <p className="text-white/25 text-xs mt-1 tracking-wider uppercase">AI-Powered Newsroom</p>
        </div>

        {/* Card */}
        <div className="glass-card-static p-8 relative overflow-hidden">
          {/* Top gradient accent */}
          <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-cyan-500/40 to-transparent" />

          <h2 className="text-xl font-semibold mb-1">Iniciar sesion</h2>
          <p className="text-white/35 text-sm mb-6">Ingresa a tu plataforma de automatizacion periodistica</p>

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

            <div>
              <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">Password</label>
              <div className="relative group">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors duration-300" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="input-premium pl-11"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Link to="/forgot-password" className="text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors duration-300">
                Olvidaste tu password?
              </Link>
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
                  <Zap className="w-4 h-4" />
                  Ingresar
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-white/25 mt-8">
          No tenes cuenta?{' '}
          <Link to="/register" className="text-cyan-400 hover:text-cyan-300 transition-colors duration-300 font-medium">
            Registrate gratis
          </Link>
        </p>
      </div>
    </div>
  );
}
