import * as React from "react"
import { cn } from "../../lib/utils"

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[60px] w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-input)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:bg-[var(--bg-input-focus)] focus:border-[var(--border-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)] disabled:cursor-not-allowed disabled:opacity-35 font-[var(--font-mono)] text-xs resize-y",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
