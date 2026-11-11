import type { ReactNode } from 'react';
import { CloudOff, FileQuestion, Lock, RefreshCw, ServerCrash, WifiOff, type LucideIcon } from 'lucide-react';
import type { AsyncError, AsyncErrorKind } from '../../lib/errors';

const KIND_CONTENT: Record<AsyncErrorKind, { icon: LucideIcon; title: string; description: string }> = {
  offline: {
    icon: WifiOff,
    title: 'Sin conexión',
    description: 'No pudimos conectarnos al servidor. Revisá tu conexión a internet y probá de nuevo.',
  },
  forbidden: {
    icon: Lock,
    title: 'No tenés acceso a esto',
    description: 'Tu cuenta no tiene permisos para ver esta sección. Si creés que es un error, consultá con el administrador.',
  },
  notFound: {
    icon: FileQuestion,
    title: 'No encontrado',
    description: 'Lo que buscás no existe o fue eliminado.',
  },
  server: {
    icon: ServerCrash,
    title: 'El servidor tuvo un problema',
    description: 'Falló algo del lado del servidor. Probá de nuevo en unos segundos.',
  },
  generic: {
    icon: CloudOff,
    title: 'No pudimos cargar esta sección',
    description: 'Algo falló del lado del servidor. Probá de nuevo en unos segundos.',
  },
};

export interface ErrorStateProps {
  /** Error clasificado (salida de `useAsyncData` o `classifyError`). */
  error?: AsyncError | null;
  /** Permite forzar la categoría cuando no hay un `AsyncError`. */
  kind?: AsyncErrorKind;
  /** Overrides de copy para casos puntuales (p. ej. "transmisión no encontrada"). */
  title?: string;
  description?: string;
  /** Icono custom; default según `kind`. */
  icon?: ReactNode;
  /** Handler del botón "Reintentar". Sin handler no se muestra botón. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Versión inline (banner) para errores dentro de paneles. */
  compact?: boolean;
  className?: string;
}

/**
 * ErrorState — estado de error compartido (PH-05).
 * NUNCA renderiza el mensaje crudo del backend ni stack traces: el copy es
 * fijo por categoría (offline / forbidden / generic) salvo overrides
 * explícitos del caller.
 */
export function ErrorState({
  error,
  kind,
  title,
  description,
  icon,
  onRetry,
  retryLabel = 'Reintentar',
  compact = false,
  className = '',
}: ErrorStateProps) {
  const resolvedKind: AsyncErrorKind = kind ?? error?.kind ?? 'generic';
  const defaults = KIND_CONTENT[resolvedKind];
  const Icon = defaults.icon;

  const content = (
    <>
      <div className={`rounded-2xl bg-red-500/[0.06] ring-1 ring-red-500/15 flex items-center justify-center mx-auto text-red-300/70 ${compact ? 'w-10 h-10 mb-2 [&_svg]:w-5 [&_svg]:h-5' : 'w-14 h-14 mb-3 [&_svg]:w-6 [&_svg]:h-6'}`}>
        {icon ?? <Icon />}
      </div>
      <p className="text-white/60 text-sm font-medium">{title ?? defaults.title}</p>
      <p className="text-white/30 text-xs mt-1 max-w-sm mx-auto">{description ?? defaults.description}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-xl bg-white/[0.05] border border-white/[0.08] text-sm text-white/70 hover:bg-white/[0.09] hover:text-white transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {retryLabel}
        </button>
      )}
    </>
  );

  if (compact) {
    return (
      <div role="alert" className={`py-6 text-center ${className}`}>
        {content}
      </div>
    );
  }
  return (
    <div role="alert" className={`glass-card-static p-10 text-center ${className}`}>
      {content}
    </div>
  );
}
