import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Newspaper, Mail, Lock, User, Building2, ArrowRight, CheckCircle, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export function Register() {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    fullName: '',
    organizationName: '',
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await register(formData);
      setSuccess(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error al registrarse');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center px-4 relative overflow-hidden">
        <div className="glow-orb glow-orb-cyan w-[500px] h-[500px] top-1/4 left-1/3 opacity-[0.08]" />
        <div className="w-full max-w-md text-center relative z-10 animate-scale-in">
          <div className="glass-card-static p-10">
            <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center mx-auto mb-5 ring-2 ring-emerald-500/20">
              <CheckCircle className="w-10 h-10 text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold mb-2">Cuenta creada</h2>
            <p className="text-white/40 mb-8">
              Revisa tu email <span className="text-white font-medium">{formData.email}</span> para verificar tu cuenta.
            </p>
            <button
              onClick={() => navigate('/login')}
              className="btn-primary px-8 py-3"
            >
              Ir a Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  const fields = [
    { key: 'fullName', label: 'Nombre completo', icon: User, type: 'text', placeholder: 'Tu nombre' },
    { key: 'organizationName', label: 'Medio / Organizacion', icon: Building2, type: 'text', placeholder: 'Radio Uno, Diario Norte...' },
    { key: 'email', label: 'Email', icon: Mail, type: 'email', placeholder: 'tu@email.com' },
    { key: 'password', label: 'Password', icon: Lock, type: 'password', placeholder: 'Minimo 8 caracteres' },
  ] as const;

  return (
    <div className="min-h-screen bg-void flex items-center justify-center px-4 relative overflow-hidden">
      {/* Background orbs */}
      <div className="glow-orb glow-orb-purple w-[600px] h-[600px] -top-40 -left-60" />
      <div className="glow-orb glow-orb-cyan w-[500px] h-[500px] -bottom-40 -right-60" style={{ animationDelay: '2s' }} />

      <div className="w-full max-w-md relative z-10 animate-slide-up">
        {/* Logo */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-purple-500/10 flex items-center justify-center border border-cyan-500/20 mb-4 shadow-glow-cyan">
            <Newspaper className="w-8 h-8 text-cyan-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">PeriodistApp</h1>
        </div>

        {/* Card */}
        <div className="glass-card-static p-8 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-purple-500/40 to-transparent" />

          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-xl font-semibold">Crear cuenta</h2>
            <Sparkles className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-white/35 text-sm mb-6">7 dias de prueba gratis, sin tarjeta</p>

          {error && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-500/8 border border-red-500/15 text-red-400 text-sm flex items-center gap-2 animate-scale-in">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {fields.map(({ key, label, icon: Icon, type, placeholder }) => (
              <div key={key}>
                <label className="text-xs font-medium text-white/40 mb-2 block uppercase tracking-wider">{label}</label>
                <div className="relative group">
                  <Icon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20 group-focus-within:text-cyan-400 transition-colors duration-300" />
                  <input
                    type={type}
                    value={formData[key]}
                    onChange={(e) => setFormData({ ...formData, [key]: e.target.value })}
                    required
                    minLength={key === 'password' ? 8 : undefined}
                    className="input-premium pl-11"
                    placeholder={placeholder}
                  />
                </div>
              </div>
            ))}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full flex items-center justify-center gap-2 py-3 mt-2"
            >
              {loading ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Crear cuenta gratis
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-white/25 mt-8">
          Ya tenes cuenta?{' '}
          <Link to="/login" className="text-cyan-400 hover:text-cyan-300 transition-colors duration-300 font-medium">
            Inicia sesion
          </Link>
        </p>
      </div>
    </div>
  );
}
