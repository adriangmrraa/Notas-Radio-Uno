import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

export interface EmptyStateAction {
  label: string;
  /** Navega con React Router cuando está presente. */
  to?: string;
  /** Acción in-place (abrir diálogo, limpiar filtros…). */
  onClick?: () => void;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  /** Versión sin card, para empties dentro de paneles/secciones. */
  compact?: boolean;
  className?: string;
}

/**
 * EmptyState — estado vacío compartido (extraído del patrón de Dashboard,
 * PH-05). Ícono + título + descripción + acción opcional.
 */
export function EmptyState({ icon, title, description, action, compact = false, className = '' }: EmptyStateProps) {
  const body = (
    <>
      {icon && (
        <div className={`rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto ring-1 ring-white/[0.06] text-white/20 ${compact ? 'w-10 h-10 mb-2 [&_svg]:w-5 [&_svg]:h-5' : 'w-14 h-14 mb-3 [&_svg]:w-6 [&_svg]:h-6'}`}>
          {icon}
        </div>
      )}
      <p className="text-white/40 text-sm font-medium">{title}</p>
      {description && <p className="text-white/25 text-xs mt-1 max-w-sm mx-auto">{description}</p>}
      {action && (
        action.to ? (
          <Link
            to={action.to}
            className="inline-flex items-center gap-1.5 mt-3 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            {action.label}
            <ArrowRight className="w-4 h-4" />
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="inline-flex items-center gap-1.5 mt-3 text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            {action.label}
          </button>
        )
      )}
    </>
  );

  if (compact) {
    return <div className={`py-6 text-center ${className}`}>{body}</div>;
  }
  return <div className={`glass-card-static p-10 text-center ${className}`}>{body}</div>;
}
