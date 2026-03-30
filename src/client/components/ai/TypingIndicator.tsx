/**
 * Typing Indicator Component
 * 
 * Animated dots component for AI loading states.
 * Uses Tailwind animations from the project's design system.
 */

interface TypingIndicatorProps {
  /** Number of dots (default: 3) */
  dots?: number;
  /** Size of each dot in pixels (default: 8) */
  dotSize?: number;
  /** Gap between dots in pixels (default: 4) */
  dotGap?: number;
  /** Custom className for additional styling */
  className?: string;
  /** Color variant (default: primary) */
  variant?: 'primary' | 'white' | 'muted';
}

const variantStyles = {
  primary: 'bg-cyan-400',
  white: 'bg-white',
  muted: 'bg-white/40',
};

export function TypingIndicator({
  dots = 3,
  dotSize = 8,
  dotGap = 4,
  className = '',
  variant = 'primary',
}: TypingIndicatorProps) {
  return (
    <div
      className={`flex items-center gap-[${dotGap}px] ${className}`}
      style={{ gap: `${dotGap}px` }}
      role="status"
      aria-label="Cargando..."
    >
      {Array.from({ length: dots }).map((_, index) => (
        <div
          key={index}
          className={`
            ${variantStyles[variant]} rounded-full
            animate-pulse-soft
          `}
          style={{
            width: `${dotSize}px`,
            height: `${dotSize}px`,
            animationDelay: `${index * 150}ms`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Typing indicator with text label
 */
interface TypingIndicatorWithLabelProps extends TypingIndicatorProps {
  /** Label text to display */
  label?: string;
}

export function TypingIndicatorWithLabel({
  label = 'Pensando',
  ...props
}: TypingIndicatorWithLabelProps) {
  return (
    <div className="flex items-center gap-3">
      <TypingIndicator {...props} />
      <span className="text-sm text-white/50 animate-pulse-soft">
        {label}
      </span>
    </div>
  );
}

/**
 * Skeleton loading card for AI-generated content
 */
interface AISkeletonCardProps {
  /** Show title skeleton */
  showTitle?: boolean;
  /** Number of content lines */
  contentLines?: number;
}

export function AISkeletonCard({
  showTitle = true,
  contentLines = 4,
}: AISkeletonCardProps) {
  return (
    <div className="glass-card p-5 animate-in">
      {showTitle && (
        <div className="skeleton h-6 w-3/4 mb-4 rounded-lg" />
      )}
      <div className="space-y-2">
        {Array.from({ length: contentLines }).map((_, index) => (
          <div
            key={index}
            className="skeleton rounded-lg"
            style={{
              height: '16px',
              width: index === contentLines - 1 ? '60%' : '100%',
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default TypingIndicator;
