export interface LoadingStateProps {
  /** Texto bajo el spinner; `''` lo oculta. */
  text?: string;
  /** Si se pasa, renderiza N filas skeleton en lugar del spinner. */
  rows?: number;
  className?: string;
}

/**
 * LoadingState — spinner o skeleton compartido (PH-05).
 * Siempre `role="status"` + `aria-busy` para lectores de pantalla.
 */
export function LoadingState({ text = 'Cargando…', rows, className = '' }: LoadingStateProps) {
  if (rows !== undefined) {
    return (
      <div role="status" aria-busy="true" aria-live="polite" className={`space-y-3 ${className}`}>
        <span className="sr-only">{text}</span>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton h-16 rounded-2xl" />
        ))}
      </div>
    );
  }

  return (
    <div role="status" aria-busy="true" aria-live="polite" className={`flex flex-col items-center justify-center py-16 gap-3 ${className}`}>
      <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
      {text && <p className="text-sm text-white/30">{text}</p>}
    </div>
  );
}
