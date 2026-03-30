/**
 * Animation Utilities
 * 
 * Tailwind animation classes for pipeline and UI components.
 * These map to the keyframes defined in index.css.
 */

// ─── Running State Animations ────────────────────────────────────────────────

/**
 * Pulse glow animation for running pipeline state
 * Creates a breathing cyan glow effect
 */
export const pulseGlow = "animate-[glowPulse_5s_ease-in-out_infinite]";

/**
 * Faster pulse for active processing indicators
 */
export const pulseFast = "animate-[pulseSoft_3s_ease-in-out_infinite]";

/**
 * Subtle shimmer for loading states
 */
export const shimmer = "animate-[shimmer_2.5s_linear_infinite]";


// ─── Entrance Animations ─────────────────────────────────────────────────────

/**
 * Slide in from bottom - for card entrance animations
 * Uses cubic-bezier for smooth easing
 */
export const slideInUp = "animate-[slideUp_0.6s_cubic-bezier(0.16,1,0.3,1)_both]";

/**
 * Slide in from top - for modals and dropdowns
 */
export const slideInDown = "animate-[slideDown_0.4s_cubic-bezier(0.16,1,0.3,1)_both]";

/**
 * Scale in with bounce effect
 */
export const scaleIn = "animate-[scaleIn_0.4s_cubic-bezier(0.34,1.56,0.64,1)_both]";

/**
 * Fade in - for smooth opacity transitions
 */
export const fadeIn = "animate-[fadeIn_0.5s_ease-out_both]";

/**
 * Float animation for decorative elements
 */
export const float = "animate-[float_8s_ease-in-out_infinite]";

/**
 * Slow spin for loading spinners
 */
export const spinSlow = "animate-[spin-slow_linear_infinite]";


// ─── Staggered Animations ────────────────────────────────────────────────────

/**
 * Container for staggered children animations
 * Use with: stagger-children > * 
 */
export const staggerContainer = "stagger-children";

/**
 * Individual stagger delays (add manually to children)
 */
export const staggerDelays = {
  1: "",
  2: "animation-delay-80",
  3: "animation-delay-160", 
  4: "animation-delay-240",
  5: "animation-delay-320",
  6: "animation-delay-400",
  7: "animation-delay-480",
  8: "animation-delay-560",
} as const;


// ─── Combined Animation Classes ─────────────────────────────────────────────

/**
 * Card entrance - slide up with fade
 */
export const cardEntrance = `${slideInUp} ${fadeIn}`;

/**
 * Loading card skeleton effect
 */
export const skeleton = `${shimmer} bg-white/5`;

/**
 * Running step indicator - pulsing glow
 */
export const runningStep = `${pulseGlow} ring-2 ring-cyan-500/30`;

/**
 * Completed step - static success
 */
export const completedStep = "ring-2 ring-emerald-500/20";

/**
 * Error step indicator
 */
export const errorStep = "ring-2 ring-red-500/30";

/**
 * Pipeline step base styles
 */
export const pipelineStepBase = "flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/5 transition-all duration-300";

/**
 * Active pipeline step
 */
export const pipelineStepActive = `${pipelineStepBase} ${runningStep} bg-cyan-500/10`;


// ─── Animation Utilities ────────────────────────────────────────────────────

/**
 * Get animation class based on pipeline step status
 */
export function getStepAnimation(status: 'idle' | 'running' | 'completed' | 'error'): string {
  switch (status) {
    case 'running':
      return runningStep;
    case 'completed':
      return completedStep;
    case 'error':
      return errorStep;
    default:
      return "";
  }
}

/**
 * Get status badge variant
 */
export function getStatusBadgeVariant(status: 'idle' | 'running' | 'completed' | 'error'): 'secondary' | 'warning' | 'success' | 'destructive' {
  switch (status) {
    case 'running':
      return 'warning';
    case 'completed':
      return 'success';
    case 'error':
      return 'destructive';
    default:
      return 'secondary';
  }
}
