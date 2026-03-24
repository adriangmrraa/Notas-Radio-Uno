# SPEC 05: Frontend — Landing Pública, Auth Pages y App Autenticada

> Separar la SPA en rutas públicas (landing, pricing, login/register) y rutas protegidas (dashboard, schedule, settings).
>
> **Nota**: Esta spec es 100% frontend (React). El backend que consume usa Prisma ORM (SPECs 01-04). Los endpoints y respuestas JSON son idénticos independientemente del ORM — el frontend no conoce Prisma.

---

## Contexto

El frontend actual es un SPA monolítico en `App.tsx` (~1000 líneas) con dos rutas: `/` (dashboard) y `/editor` (pipeline editor). No tiene landing page, login ni register. Todo se sirve sin autenticación.

### Estado Actual
```
main.tsx
  └─ PipelineProvider
       ├─ / → App (dashboard completo)
       └─ /editor → PipelineEditor
```

### Estado Objetivo
```
main.tsx
  └─ AuthProvider
       ├─ RUTAS PÚBLICAS (sin auth)
       │   ├─ / → Landing
       │   ├─ /pricing → Pricing
       │   ├─ /login → Login
       │   ├─ /register → Register
       │   ├─ /verify-email → VerifyEmail
       │   ├─ /forgot-password → ForgotPassword
       │   └─ /reset-password → ResetPassword
       │
       └─ RUTAS PROTEGIDAS (auth + subscription)
           └─ PipelineProvider
                ├─ /dashboard → Dashboard (App actual)
                ├─ /editor → PipelineEditor
                ├─ /schedule → ScheduleManager
                ├─ /history → History
                ├─ /settings → Settings
                ├─ /settings/integrations → Integrations
                ├─ /settings/team → TeamManager
                ├─ /billing → Billing
                └─ /profile → Profile
```

---

## 1. Dependencias Nuevas (Frontend)

```bash
npm install js-cookie              # Leer/escribir cookies en el cliente
npm install @types/js-cookie -D
```

No se necesitan otras dependencias — React Router ya está instalado.

---

## 2. Estructura de Carpetas

```
src/client/
├── main.tsx                         # Entry point + rutas
├── App.tsx                          # Dashboard (se mantiene, se renombra el contenido)
├── App.css                          # Estilos globales
├── context/
│   └── AuthContext.tsx              # Auth state + provider
├── hooks/
│   ├── usePipelineState.tsx         # (existente, sin cambios)
│   └── useSocket.ts                 # (actualizado para enviar token)
├── pages/
│   ├── public/
│   │   ├── Landing.tsx
│   │   ├── Pricing.tsx
│   │   ├── Login.tsx
│   │   ├── Register.tsx
│   │   ├── VerifyEmail.tsx
│   │   ├── ForgotPassword.tsx
│   │   └── ResetPassword.tsx
│   └── protected/
│       ├── Dashboard.tsx            # (contenido actual de App.tsx)
│       ├── Schedule.tsx
│       ├── History.tsx
│       ├── Settings.tsx
│       ├── Integrations.tsx
│       ├── TeamManager.tsx
│       ├── Billing.tsx
│       └── Profile.tsx
├── components/
│   ├── ProtectedRoute.tsx
│   ├── PublicRoute.tsx              # Redirige a /dashboard si ya logueado
│   ├── AppLayout.tsx                # Sidebar + header para rutas protegidas
│   ├── Sidebar.tsx
│   └── SubscriptionBanner.tsx       # Banner de trial/expiración
├── editor/                          # (existente, sin cambios)
│   ├── PipelineEditor.tsx
│   └── components/
├── types/
│   └── index.ts                     # (existente + tipos de auth)
└── lib/
    └── api.ts                       # HTTP client wrapper
```

---

## 3. AuthContext

### `src/client/context/AuthContext.tsx`

```typescript
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { api } from '../lib/api';

// =============================================
// TIPOS
// =============================================
interface User {
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string | null;
    role: 'owner' | 'editor' | 'viewer';
    status: string;
    isVerified: boolean;
    lastLoginAt: string | null;
    createdAt: string;
}

interface Tenant {
    id: string;
    name: string;
    slug: string;
    platformName: string;
    logoUrl: string | null;
    timezone: string;
    config: Record<string, any>;
}

interface Subscription {
    id: string;
    status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'suspended' | 'expired';
    planName: string;
    planDisplayName: string;
    priceUsd: number;
    billingPeriod: string;
    trialEndsAt: string | null;
    trialDaysRemaining: number | null;
    cancelAtPeriodEnd: boolean;
    limits: Record<string, number | null>;
    features: Record<string, boolean>;
}

interface AuthState {
    user: User | null;
    tenant: Tenant | null;
    subscription: Subscription | null;
    isAuthenticated: boolean;
    isLoading: boolean;
}

interface AuthContextType extends AuthState {
    login: (email: string, password: string) => Promise<void>;
    register: (data: RegisterData) => Promise<{ message: string }>;
    logout: () => Promise<void>;
    refreshSession: () => Promise<void>;
}

interface RegisterData {
    email: string;
    password: string;
    fullName: string;
    organizationName: string;
}

// =============================================
// CONTEXT
// =============================================
const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}

// =============================================
// PROVIDER
// =============================================
export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>({
        user: null,
        tenant: null,
        subscription: null,
        isAuthenticated: false,
        isLoading: true
    });

    // Verificar sesión al montar
    useEffect(() => {
        checkSession();
    }, []);

    const checkSession = useCallback(async () => {
        try {
            const data = await api.get('/api/auth/me');
            setState({
                user: data.user,
                tenant: data.tenant,
                subscription: data.subscription,
                isAuthenticated: true,
                isLoading: false
            });
        } catch {
            setState(prev => ({ ...prev, isLoading: false }));
        }
    }, []);

    const login = useCallback(async (email: string, password: string) => {
        const data = await api.post('/api/auth/login', { email, password });

        // Guardar token para Socket.IO
        if (data.accessToken) {
            localStorage.setItem('access_token', data.accessToken);
        }

        setState({
            user: data.user,
            tenant: data.tenant,
            subscription: null,  // Se cargará con refreshSession
            isAuthenticated: true,
            isLoading: false
        });

        // Cargar subscription info
        await checkSession();
    }, [checkSession]);

    const register = useCallback(async (data: RegisterData) => {
        return await api.post('/api/auth/register', data);
    }, []);

    const logout = useCallback(async () => {
        try {
            await api.post('/api/auth/logout');
        } catch {
            // Ignorar error
        }
        localStorage.removeItem('access_token');
        setState({
            user: null,
            tenant: null,
            subscription: null,
            isAuthenticated: false,
            isLoading: false
        });
    }, []);

    const refreshSession = checkSession;

    return (
        <AuthContext.Provider value={{
            ...state,
            login, register, logout, refreshSession
        }}>
            {children}
        </AuthContext.Provider>
    );
}
```

---

## 4. API Client

### `src/client/lib/api.ts`

```typescript
class ApiClient {
    private baseUrl = '';

    async request(method: string, url: string, body?: any): Promise<any> {
        const options: RequestInit = {
            method,
            credentials: 'include',  // Enviar cookies
            headers: {
                'Content-Type': 'application/json',
            }
        };

        // Agregar Authorization header como backup
        const token = localStorage.getItem('access_token');
        if (token) {
            (options.headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
        }

        if (body) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(`${this.baseUrl}${url}`, options);

        // Manejar respuestas de error
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Error de red' }));

            // 402: Subscription required → redirigir
            if (response.status === 402) {
                window.dispatchEvent(new CustomEvent('subscription-error', { detail: error }));
            }

            // 401: No autenticado → redirigir a login
            if (response.status === 401) {
                localStorage.removeItem('access_token');
                window.dispatchEvent(new CustomEvent('auth-error'));
            }

            throw new ApiError(error.error || 'Error', response.status, error);
        }

        return response.json();
    }

    get(url: string) { return this.request('GET', url); }
    post(url: string, body?: any) { return this.request('POST', url, body); }
    put(url: string, body?: any) { return this.request('PUT', url, body); }
    patch(url: string, body?: any) { return this.request('PATCH', url, body); }
    delete(url: string) { return this.request('DELETE', url); }
}

class ApiError extends Error {
    constructor(
        message: string,
        public status: number,
        public data: any
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

export const api = new ApiClient();
```

---

## 5. Protected & Public Routes

### `src/client/components/ProtectedRoute.tsx`

```typescript
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, isLoading, subscription } = useAuth();
    const location = useLocation();

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (!isAuthenticated) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    // Permitir acceso a billing aunque la suscripción esté expirada
    if (location.pathname === '/billing') {
        return <>{children}</>;
    }

    // Verificar suscripción
    if (subscription && ['expired', 'canceled', 'suspended'].includes(subscription.status)) {
        return <Navigate to="/billing" replace />;
    }

    return <>{children}</>;
}

function LoadingScreen() {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100vh', background: '#0b0d17', color: '#fff'
        }}>
            <div>Cargando...</div>
        </div>
    );
}
```

### `src/client/components/PublicRoute.tsx`

```typescript
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Redirige a dashboard si ya está autenticado
export function PublicRoute({ children }: { children: React.ReactNode }) {
    const { isAuthenticated, isLoading } = useAuth();

    if (isLoading) return null;
    if (isAuthenticated) return <Navigate to="/dashboard" replace />;

    return <>{children}</>;
}
```

---

## 6. Router Actualizado

### `src/client/main.tsx`

```typescript
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { PipelineProvider } from './hooks/usePipelineState';
import { ProtectedRoute } from './components/ProtectedRoute';
import { PublicRoute } from './components/PublicRoute';
import { AppLayout } from './components/AppLayout';

// Páginas públicas
import Landing from './pages/public/Landing';
import Pricing from './pages/public/Pricing';
import Login from './pages/public/Login';
import Register from './pages/public/Register';
import VerifyEmail from './pages/public/VerifyEmail';
import ForgotPassword from './pages/public/ForgotPassword';
import ResetPassword from './pages/public/ResetPassword';

// Páginas protegidas
import Dashboard from './pages/protected/Dashboard';
import Schedule from './pages/protected/Schedule';
import History from './pages/protected/History';
import Settings from './pages/protected/Settings';
import Integrations from './pages/protected/Integrations';
import Billing from './pages/protected/Billing';
import Profile from './pages/protected/Profile';
import { PipelineEditor } from './editor/PipelineEditor';

function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <Routes>
                    {/* RUTAS PÚBLICAS */}
                    <Route path="/" element={<PublicRoute><Landing /></PublicRoute>} />
                    <Route path="/pricing" element={<Pricing />} />
                    <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
                    <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
                    <Route path="/verify-email" element={<VerifyEmail />} />
                    <Route path="/forgot-password" element={<ForgotPassword />} />
                    <Route path="/reset-password" element={<ResetPassword />} />

                    {/* RUTAS PROTEGIDAS */}
                    <Route element={
                        <ProtectedRoute>
                            <PipelineProvider>
                                <AppLayout />
                            </PipelineProvider>
                        </ProtectedRoute>
                    }>
                        <Route path="/dashboard" element={<Dashboard />} />
                        <Route path="/editor" element={<PipelineEditor />} />
                        <Route path="/schedule" element={<Schedule />} />
                        <Route path="/history" element={<History />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/settings/integrations" element={<Integrations />} />
                        <Route path="/billing" element={<Billing />} />
                        <Route path="/profile" element={<Profile />} />
                    </Route>
                </Routes>
            </AuthProvider>
        </BrowserRouter>
    );
}
```

---

## 7. AppLayout (Sidebar + Content)

### `src/client/components/AppLayout.tsx`

```typescript
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { SubscriptionBanner } from './SubscriptionBanner';
import { useAuth } from '../context/AuthContext';

export function AppLayout() {
    const { subscription, tenant } = useAuth();

    return (
        <div style={{ display: 'flex', height: '100vh', background: '#0b0d17' }}>
            <Sidebar />
            <main style={{ flex: 1, overflow: 'auto', padding: '0' }}>
                {/* Banner de trial/expiración */}
                {subscription?.status === 'trialing' && subscription.trialDaysRemaining !== null && (
                    <SubscriptionBanner
                        type="trial"
                        daysRemaining={subscription.trialDaysRemaining}
                    />
                )}
                {subscription?.status === 'past_due' && (
                    <SubscriptionBanner type="past_due" />
                )}

                <Outlet />
            </main>
        </div>
    );
}
```

### `src/client/components/Sidebar.tsx`

```typescript
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV_ITEMS = [
    { path: '/dashboard', label: 'Dashboard', icon: '📡' },
    { path: '/editor', label: 'Pipeline Editor', icon: '🔧' },
    { path: '/schedule', label: 'Programación', icon: '📅' },
    { path: '/history', label: 'Historial', icon: '📰' },
    { path: '/settings', label: 'Configuración', icon: '⚙️' },
    { path: '/settings/integrations', label: 'Integraciones', icon: '🔗' },
    { path: '/billing', label: 'Facturación', icon: '💳' },
];

export function Sidebar() {
    const { user, tenant, logout } = useAuth();
    const navigate = useNavigate();

    const handleLogout = async () => {
        await logout();
        navigate('/login');
    };

    return (
        <aside style={{
            width: 240, background: '#12141f', borderRight: '1px solid #1e2235',
            display: 'flex', flexDirection: 'column', padding: '16px 0'
        }}>
            {/* Logo + Tenant Name */}
            <div style={{ padding: '0 16px 24px', borderBottom: '1px solid #1e2235' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>
                    PeriodistApp
                </div>
                <div style={{ fontSize: 12, color: '#555d70', marginTop: 4 }}>
                    {tenant?.platformName || tenant?.name}
                </div>
            </div>

            {/* Navigation */}
            <nav style={{ flex: 1, padding: '16px 8px' }}>
                {NAV_ITEMS.map(item => (
                    <NavLink
                        key={item.path}
                        to={item.path}
                        style={({ isActive }) => ({
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 12px', borderRadius: 8, marginBottom: 2,
                            textDecoration: 'none', fontSize: 14,
                            color: isActive ? '#fff' : '#888',
                            background: isActive ? '#1e2235' : 'transparent'
                        })}
                    >
                        <span>{item.icon}</span>
                        <span>{item.label}</span>
                    </NavLink>
                ))}
            </nav>

            {/* User */}
            <div style={{ padding: '16px', borderTop: '1px solid #1e2235' }}>
                <NavLink to="/profile" style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    textDecoration: 'none', color: '#ccc', marginBottom: 12
                }}>
                    <div style={{
                        width: 32, height: 32, borderRadius: '50%',
                        background: '#e94560', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 700, color: '#fff'
                    }}>
                        {user?.fullName?.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{user?.fullName}</div>
                        <div style={{ fontSize: 11, color: '#555' }}>{user?.email}</div>
                    </div>
                </NavLink>
                <button onClick={handleLogout} style={{
                    width: '100%', padding: '8px', borderRadius: 6,
                    border: '1px solid #333', background: 'transparent',
                    color: '#888', cursor: 'pointer', fontSize: 13
                }}>
                    Cerrar sesión
                </button>
            </div>
        </aside>
    );
}
```

---

## 8. Landing Page

### `src/client/pages/public/Landing.tsx`

Secciones principales:

1. **Nav**: Logo | Pricing | Login | Register (botón CTA)
2. **Hero**: Título grande + subtítulo + CTA "Comienza gratis" + screenshot/video
3. **Problema**: "Tu programa se transmite en vivo, pero el contenido se pierde después del aire"
4. **Cómo Funciona** (3 steps):
   - Conecta tu stream (YouTube, Twitch, radio)
   - La IA procesa tu transmisión en tiempo real
   - Publica automáticamente en todas tus redes
5. **Features Grid** (6 cards):
   - Pipeline autónomo
   - Publicación multi-plataforma
   - Programación de horarios
   - Agentes IA personalizables
   - Análisis de temas inteligente
   - Generación de placas/flyers
6. **Para Quién** (4 targets):
   - Canales de streaming
   - Noticieros y programas en vivo
   - Radios online
   - Medios de comunicación
7. **Pricing Preview**: Cards de 3 planes con CTA
8. **Footer**: Links, legal, copyright

### Estilo: Dark mode consistente con la app (`#0b0d17`, `#12141f`, `#e94560`)

---

## 9. Auth Pages

### Login (`src/client/pages/public/Login.tsx`)

```typescript
// Elementos:
// - Logo
// - Formulario: email + password
// - Botón "Iniciar sesión"
// - Link "¿Olvidaste tu contraseña?"
// - Link "¿No tienes cuenta? Regístrate"
// - Manejo de errores (email no verificado, credenciales incorrectas)

// Flujo:
// 1. Submit → api.post('/api/auth/login')
// 2. Si OK → authContext.login() → redirect a /dashboard
// 3. Si error EMAIL_NOT_VERIFIED → mostrar mensaje + link resend
// 4. Si error 401 → mostrar "Credenciales inválidas"
```

### Register (`src/client/pages/public/Register.tsx`)

```typescript
// Elementos:
// - Logo
// - Formulario: nombre completo, organización, email, password, confirmar password
// - Validación en tiempo real (Zod o manual)
// - Botón "Crear cuenta"
// - Link "¿Ya tienes cuenta? Inicia sesión"

// Flujo:
// 1. Validar client-side (passwords match, min 8 chars, etc.)
// 2. Submit → api.post('/api/auth/register')
// 3. Si OK → mostrar pantalla "Revisa tu email" con ícono de email
// 4. Si error 409 → "Este email ya está registrado"
```

### VerifyEmail (`src/client/pages/public/VerifyEmail.tsx`)

```typescript
// Flujo:
// 1. Leer ?token= de la URL
// 2. Auto-submit → api.post('/api/auth/verify-email', { token })
// 3. Si OK → mostrar "Email verificado" + redirect a /login en 3s
// 4. Si error → mostrar mensaje de error + link para reenviar
```

### ForgotPassword / ResetPassword

```typescript
// ForgotPassword: formulario con solo email → POST /api/auth/forgot-password
// Siempre muestra "Si el email existe, recibirás un enlace"

// ResetPassword: leer ?token= → formulario con nueva password + confirmar
// POST /api/auth/reset-password → redirect a /login
```

---

## 10. Billing Page

### `src/client/pages/protected/Billing.tsx`

```typescript
// Secciones:
// 1. Plan actual + status (trial/active/expired)
// 2. Si trial: banner con días restantes + CTA
// 3. Si expired: banner rojo con CTA urgente
// 4. Uso del mes (barras de progreso: horas pipeline, publicaciones)
// 5. Planes disponibles (cards con toggle mensual/anual)
// 6. Historial de facturas (tabla)

// API calls:
// GET /api/billing/my-subscription
// GET /api/billing/usage
// GET /api/billing/plans
// GET /api/billing/invoices
// POST /api/billing/checkout → redirige a Stripe/MP
// POST /api/billing/cancel → confirmar con modal
```

---

## 11. Schedule Page

### `src/client/pages/protected/Schedule.tsx`

```typescript
// Secciones:
// 1. Header: "Programación" + botón "Nuevo programa"
// 2. Lista de jobs (cards o tabla):
//    - Nombre del programa
//    - Días de la semana (badges: L M X J V)
//    - Horario (08:00 - 10:00)
//    - Estado (activo/inactivo toggle)
//    - Próxima ejecución
//    - Última ejecución + status
//    - Acciones: editar, eliminar, ejecutar ahora
// 3. Modal de creación/edición:
//    - Nombre
//    - URL del stream
//    - Tipo: recurring / one_time
//    - Selector de días (checkboxes)
//    - Hora de inicio (time picker)
//    - Duración (slider o input: 5min - 8h)
//    - Configuración del pipeline (tone, structure, ai provider, auto_publish)
//    - Plataformas de publicación (checkboxes)
//    - Notificaciones (email al completar/fallar)
// 4. Detalle de job (click en un job):
//    - Historial de ejecuciones (tabla paginada)
//    - Cada ejecución: status, duración, publicaciones, temas, errores
//    - Expandir para ver execution_log

// API calls:
// GET /api/schedule
// POST /api/schedule
// PUT /api/schedule/:id
// DELETE /api/schedule/:id
// PATCH /api/schedule/:id/toggle
// GET /api/schedule/:id/executions
// POST /api/schedule/:id/run-now
```

---

## 12. Dashboard (Refactor de App.tsx)

El contenido actual de `App.tsx` se mueve a `Dashboard.tsx`, con estos cambios:

1. **Remover**: TopBar (el sidebar lo reemplaza), MetaConnection (se mueve a Integrations), WebhookSettings (se mueve a Settings), History (se mueve a History page)
2. **Mantener**: PipelineControl, ActivityFeed, PublishedNotes, TranscriptionViewer, NoteModal
3. **Agregar**: Header con nombre del tenant + status del pipeline

El Dashboard se simplifica a: control del pipeline + activity feed en tiempo real.

---

## 13. Migración de App.tsx

### Paso a paso:

1. Copiar contenido de `App.tsx` a `pages/protected/Dashboard.tsx`
2. Extraer sección de Meta Connection a `pages/protected/Integrations.tsx`
3. Extraer sección de Webhooks a `pages/protected/Settings.tsx`
4. Extraer sección de History a `pages/protected/History.tsx`
5. Agregar sidebar y layout en `AppLayout.tsx`
6. Actualizar `main.tsx` con nuevo routing
7. Actualizar `useSocket.ts` para enviar token
8. `App.tsx` original queda como archivo legacy o se elimina

---

## 14. SubscriptionBanner

### `src/client/components/SubscriptionBanner.tsx`

```typescript
import { Link } from 'react-router-dom';

interface Props {
    type: 'trial' | 'past_due' | 'expired';
    daysRemaining?: number;
}

export function SubscriptionBanner({ type, daysRemaining }: Props) {
    const configs = {
        trial: {
            bg: '#1a3a5c',
            border: '#2a5a8c',
            text: `Te quedan ${daysRemaining} días de prueba gratuita.`,
            cta: 'Elegir plan'
        },
        past_due: {
            bg: '#5c3a1a',
            border: '#8c5a2a',
            text: 'Tu último pago falló. Actualiza tu método de pago.',
            cta: 'Actualizar pago'
        },
        expired: {
            bg: '#5c1a1a',
            border: '#8c2a2a',
            text: 'Tu suscripción ha expirado.',
            cta: 'Reactivar'
        }
    };

    const config = configs[type];

    return (
        <div style={{
            background: config.bg,
            borderBottom: `1px solid ${config.border}`,
            padding: '10px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 14,
            color: '#fff'
        }}>
            <span>{config.text}</span>
            <Link to="/billing" style={{
                color: '#e94560',
                fontWeight: 600,
                textDecoration: 'none'
            }}>
                {config.cta} →
            </Link>
        </div>
    );
}
```

---

## 15. Testing Checklist

- [ ] Landing page se muestra sin autenticación
- [ ] Pricing se muestra sin autenticación
- [ ] Login redirige a /dashboard después de login exitoso
- [ ] Login muestra error si email no verificado
- [ ] Register crea cuenta y muestra "Revisa tu email"
- [ ] Register muestra error si email ya existe
- [ ] VerifyEmail verifica token y redirige a login
- [ ] VerifyEmail muestra error si token expirado
- [ ] ForgotPassword siempre muestra mensaje genérico
- [ ] ResetPassword cambia password y redirige a login
- [ ] Rutas protegidas redirigen a /login si no autenticado
- [ ] Rutas protegidas redirigen a /billing si subscription expired
- [ ] Sidebar muestra navegación correcta
- [ ] Sidebar muestra nombre de usuario y tenant
- [ ] Logout limpia sesión y redirige a /login
- [ ] SubscriptionBanner muestra días de trial restantes
- [ ] Dashboard funciona igual que antes (pipeline, activity feed)
- [ ] Schedule page lista, crea, edita, elimina jobs
- [ ] Billing page muestra plan, uso, y permite checkout
- [ ] Profile page permite actualizar nombre y password
- [ ] Socket.IO se conecta con token de auth
- [ ] Socket.IO reconecta si el token se renueva
