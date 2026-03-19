import React, { useState, useEffect, useCallback } from 'react';

interface MetaPage {
  id: string;
  name: string;
}

interface MetaIgAccount {
  id: string;
  name?: string;
  username?: string;
}

interface MetaStatus {
  connected: boolean;
  pages?: MetaPage[];
  instagramAccounts?: MetaIgAccount[];
  expiresAt?: string;
}

declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
    META_APP_ID: string;
    META_CONFIG_ID: string;
  }
}

export default function MetaConnection() {
  const [status, setStatus] = useState<MetaStatus>({ connected: false });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [fbSdkReady, setFbSdkReady] = useState(false);
  const [missingPermissions, setMissingPermissions] = useState<string[]>([]);
  const [statusDotClass, setStatusDotClass] = useState('');
  const [statusText, setStatusText] = useState('Verificando...');

  const updateUI = useCallback((s: MetaStatus) => {
    setStatus(s);
    if (s.connected) {
      setStatusDotClass('active');
      setStatusText('Conectado a Meta');
      // Check token expiration
      if (s.expiresAt) {
        const daysLeft = Math.ceil(
          (new Date(s.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        if (daysLeft > 0 && daysLeft < 10) {
          setStatusText(`Conectado a Meta (token expira en ${daysLeft} dias)`);
          setStatusDotClass('warning');
        }
      }
    } else {
      setStatusDotClass('');
      setStatusText('No conectado');
    }
  }, []);

  const loadFacebookSdk = useCallback((appId: string): Promise<boolean> => {
    return new Promise((resolve) => {
      if (window.FB) {
        setFbSdkReady(true);
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => {
        console.warn('[Meta] Facebook SDK timeout');
        resolve(false);
      }, 5000);

      window.fbAsyncInit = function () {
        clearTimeout(timeout);
        window.FB.init({
          appId,
          cookie: true,
          xfbml: false,
          version: 'v22.0',
        });
        setFbSdkReady(true);
        resolve(true);
      };

      const script = document.createElement('script');
      script.src = 'https://connect.facebook.net/es_LA/sdk.js';
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      document.head.appendChild(script);
    });
  }, []);

  // Initialize on mount
  useEffect(() => {
    (async () => {
      // Load config
      try {
        const configRes = await fetch('/api/meta/config');
        if (configRes.ok) {
          const config = await configRes.json();
          window.META_APP_ID = config.appId || '';
          window.META_CONFIG_ID = config.configId || '';
        }
      } catch {
        // ignore
      }

      // Load SDK
      if (window.META_APP_ID) {
        await loadFacebookSdk(window.META_APP_ID);
      }

      // Check status
      try {
        const res = await fetch('/api/meta/status');
        const data = await res.json();
        updateUI(data);
      } catch {
        updateUI({ connected: false });
      }

      setLoading(false);
    })();
  }, [loadFacebookSdk, updateUI]);

  const handleConnect = () => {
    if (!fbSdkReady) {
      alert('El SDK de Facebook no se pudo cargar. Verifica tu conexion a internet y que META_APP_ID este configurado.');
      return;
    }

    const loginOptions: any = {
      scope:
        'pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,pages_show_list',
      return_scopes: true,
    };

    if (window.META_CONFIG_ID) {
      loginOptions.config_id = window.META_CONFIG_ID;
      loginOptions.response_type = 'code';
    }

    window.FB.login(async (response: any) => {
      if (response.authResponse) {
        const { accessToken, code } = response.authResponse;
        await connectWithBackend({ accessToken, code });
      }
    }, loginOptions);
  };

  const connectWithBackend = async ({
    accessToken,
    code,
  }: {
    accessToken?: string;
    code?: string;
  }) => {
    setConnecting(true);
    try {
      const res = await fetch('/api/meta/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken,
          code,
          redirectUri: window.location.origin,
        }),
      });
      const data = await res.json();

      if (data.success) {
        updateUI({
          connected: true,
          pages: data.assets.pages,
          instagramAccounts: data.assets.instagramAccounts,
        });

        if (data.permissions?.missing?.length > 0) {
          setMissingPermissions(data.permissions.missing);
        }

        alert(
          `Meta conectado con exito!\n\nPages: ${data.assets.pages.length}\nInstagram: ${data.assets.instagramAccounts.length}`
        );
      } else {
        alert('Error al conectar: ' + (data.error || 'Error desconocido'));
      }
    } catch (error: any) {
      alert('Error de conexion: ' + error.message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (
      !confirm(
        'Seguro que queres desconectar Meta? Las publicaciones ya no se enviaran directamente a Facebook e Instagram.'
      )
    ) {
      return;
    }
    try {
      const res = await fetch('/api/meta/disconnect', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        updateUI({ connected: false });
        setMissingPermissions([]);
      }
    } catch (error: any) {
      alert('Error al desconectar: ' + error.message);
    }
  };

  return (
    <section className="card card-meta">
      <div className="card-header">
        <div className="card-header-icon card-header-icon-meta">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
          </svg>
        </div>
        <div>
          <h2 className="card-title">Conexion Meta</h2>
          <p className="card-description">Facebook e Instagram para publicacion directa</p>
        </div>
        <div className="meta-status-inline">
          <span className={`status-dot ${statusDotClass}`} />
          <span>{loading ? 'Verificando...' : statusText}</span>
        </div>
      </div>

      {/* Connected: show assets */}
      {status.connected && (
        <div>
          <div className="meta-assets">
            <div className="meta-assets-list">
              {status.pages && status.pages.length > 0 && (
                <>
                  <h4>Facebook Pages:</h4>
                  {status.pages.map((page) => (
                    <div key={page.id} className="meta-asset-item">
                      <span className="meta-asset-icon">{'\uD83D\uDCD8'}</span> {page.name}
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="meta-assets-list">
              {status.instagramAccounts && status.instagramAccounts.length > 0 && (
                <>
                  <h4>Instagram:</h4>
                  {status.instagramAccounts.map((ig) => (
                    <div key={ig.id} className="meta-asset-item">
                      <span className="meta-asset-icon">{'\uD83D\uDCF8'}</span>{' '}
                      {ig.name || ig.username}
                      {ig.username && ` (@${ig.username})`}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
          <div className="meta-actions">
            <button className="btn btn-ghost btn-sm" onClick={handleDisconnect}>
              Desconectar
            </button>
          </div>
        </div>
      )}

      {/* Disconnected: show connect button */}
      {!status.connected && !loading && (
        <div>
          <button
            className="btn btn-meta"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              'Conectando...'
            ) : (
              <>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                </svg>
                Conectar con Meta
              </>
            )}
          </button>
          <p className="hint hint-center">Se abrira un popup para autorizar permisos</p>
        </div>
      )}

      {/* Missing permissions warning */}
      {missingPermissions.length > 0 && (
        <div className="alert alert-warning">
          <strong>Permisos faltantes:</strong>
          <ul>
            {missingPermissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
