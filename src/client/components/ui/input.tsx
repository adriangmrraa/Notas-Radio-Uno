import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const inputVariants = cva(
  "form-input w-full px-4 py-2.5 text-sm rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-input)] text-[var(--text-primary)] transition-all duration-200 outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:bg-[var(--bg-input-focus)] focus:shadow-[0_0_0_3px_rgba(6,182,212,0.08)] disabled:cursor-not-allowed disabled:opacity-35",
  {
    variants: {
      variant: {
        default: "border-[var(--border)]",
        ghost: "bg-transparent border-0 border-b border-[var(--border)] rounded-none focus:shadow-none",
        error: "border-[var(--error)] focus:border-[var(--error)]",
      },
      size: {
        default: "h-10 px-4 py-2.5",
        sm: "h-9 px-3 py-2 text-xs",
        lg: "h-12 px-5 py-3 text-base",
        icon: "h-10 w-10 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant, size, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(inputVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input, inputVariants }
