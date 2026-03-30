import * as React from "react"
import { cn } from "../../lib/utils"

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number
  max?: number
  indicatorClassName?: string
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, max = 100, indicatorClassName, ...props }, ref) => {
    const percentage = Math.min(Math.max((value / max) * 100, 0), 100)
    
    return (
      <div
        ref={ref}
        className={cn(
          "progress-bar relative overflow-hidden rounded-full bg-white/10",
          className
        )}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        {...props}
      >
        <div
          className={cn(
            "progress-bar-fill h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-400",
            indicatorClassName
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
    )
  }
)
Progress.displayName = "Progress"

export { Progress }
