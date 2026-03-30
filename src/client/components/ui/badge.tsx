import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "badge inline-flex items-center justify-center whitespace-nowrap rounded-full text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20",
        secondary:
          "badge-purple bg-purple-500/10 text-purple-400 border border-purple-500/20",
        destructive:
          "badge-danger bg-red-500/10 text-red-400 border border-red-500/20",
        outline:
          "border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-input)]",
        success:
          "badge-success",
        warning:
          "badge-warning",
        info:
          "badge-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
