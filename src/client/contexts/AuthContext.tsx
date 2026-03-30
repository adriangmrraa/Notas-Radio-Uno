import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useApi } from '../hooks/useApi';

interface User {
  id: string;
  email: string;
  fullName: string;
  role: string;
  tenantId: string;
  isVerified: boolean;
  tenant?: {
    id: string;
    name: string;
    platformName?: string;
  };
  subscription?: {
    status: string;
    planName: string;
    trialEndsAt?: string;
    trialDaysRemaining?: number;
    limits?: Record<string, number>;
  };
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterData) => Promise<{ message: string }>;
  logout: () => void;
  refreshProfile: () => Promise<void>;
}

interface RegisterData {
  email: string;
  password: string;
  fullName: string;
  organizationName: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { fetchApi } = useApi();

  const checkSession = async () => {
    try {
      const data = await fetchApi<{ user: User; tenant: any; subscription: any }>('/auth/me', { skipRedirect: true });
      if (data?.user?.id) {
        setUser({
          ...data.user,
          tenantId: data.tenant?.id || data.user.tenantId,
          tenant: data.tenant,
          subscription: data.subscription,
        });
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    checkSession();
  }, []);

  const login = async (email: string, password: string) => {
    const result = await fetchApi<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      skipRedirect: true,
    });
    // Store token for Socket.IO auth (httpOnly cookie handles API requests)
    if (result?.accessToken) {
      localStorage.setItem('accessToken', result.accessToken);
    }
    await checkSession();
  };

  const register = async (data: RegisterData) => {
    const result = await fetchApi<{ message: string }>('/auth/register', {
      method: 'POST',
      body: data,
      skipRedirect: true,
    });
    return result;
  };

  const logout = () => {
    document.cookie = 'token=; Max-Age=0; path=/';
    localStorage.removeItem('accessToken');
    setUser(null);
    window.location.href = '/login';
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        register,
        logout,
        refreshProfile: checkSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
