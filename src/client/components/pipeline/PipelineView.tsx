/**
 * PipelineView - Simplified pipeline visualization for execution mode
 * 
 * Shows current step with progress indicator using shadcn components.
 * Designed for a clean, focused view during pipeline execution.
 */

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge as BadgeComponent, badgeVariants } from '../ui/badge';
import { Progress } from '../ui/progress';
import { STEP_META, PIPELINE_STEPS, type PipelineStep } from '../../types';
import { cn } from '../../lib/utils';
import {
  pulseGlow,
  slideInUp,
  fadeIn,
  runningStep,
  completedStep,
} from '../../lib/animations';
import { 
  CheckCircle2, 
  Circle, 
  Loader2, 
  AlertCircle 
} from 'lucide-react';

// Badge component wrapper with proper typing
type BadgeProps = React.HTMLAttributes<HTMLDivElement> & Parameters<typeof badgeVariants>[0];

const Badge = ({ className, variant, ...props }: BadgeProps) => (
  <BadgeComponent className={badgeVariants({ variant })} {...props} />
);

interface PipelineViewProps {
  /** Current active step in the pipeline */
  activeStep: string;
  /** Whether the pipeline is currently running */
  isRunning: boolean;
  /** Optional: custom className */
  className?: string;
  /** Optional: callback when clicking a step */
  onStepClick?: (step: PipelineStep) => void;
}

/**
 * Get status for a specific step relative to active step
 */
function getStepStatus(step: PipelineStep, activeStep: string, isRunning: boolean): 'completed' | 'current' | 'pending' | 'error' {
  if (!isRunning) return 'pending';
  
  const stepOrder = PIPELINE_STEPS;
  const currentIndex = stepOrder.indexOf(activeStep as PipelineStep);
  const stepIndex = stepOrder.indexOf(step);
  
  if (stepIndex < currentIndex) return 'completed';
  if (stepIndex === currentIndex) return 'current';
  return 'pending';
}

/**
 * Get badge variant based on step status
 */
function getBadgeVariant(status: 'completed' | 'current' | 'pending' | 'error'): 'success' | 'warning' | 'secondary' | 'destructive' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'current':
      return 'warning';
    case 'error':
      return 'destructive';
    default:
      return 'secondary';
  }
}

/**
 * PipelineView Component
 * 
 * A simplified visualization of the pipeline for execution mode.
 * Shows all steps with their current status and progress.
 */
export function PipelineView({
  activeStep,
  isRunning,
  className,
  onStepClick,
}: PipelineViewProps) {
  // Calculate progress percentage
  const currentIndex = PIPELINE_STEPS.indexOf(activeStep as PipelineStep);
  const progress = isRunning && currentIndex >= 0 
    ? ((currentIndex + 1) / PIPELINE_STEPS.length) * 100 
    : 0;

  return (
    <Card className={cn("bg-transparent border-white/5", className)}>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-semibold text-white">
            Pipeline de Noticias
          </CardTitle>
          {isRunning ? (
            <Badge variant="warning" className="gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Ejecutando
            </Badge>
          ) : (
            <Badge variant="secondary">
              Inactivo
            </Badge>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-white/50">
            <span>Progreso</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress 
            value={progress} 
            className="h-2"
            indicatorClassName={isRunning ? "animate-pulse" : ""}
          />
        </div>

        {/* Steps List */}
        <div className="space-y-2">
          {PIPELINE_STEPS.map((step, index) => {
            const status = getStepStatus(step, activeStep, isRunning);
            const meta = STEP_META[step];
            
            return (
              <div
                key={step}
                onClick={() => onStepClick?.(step)}
                className={cn(
                  "flex items-center gap-3 p-3 rounded-xl transition-all duration-300",
                  "border border-white/5 bg-white/[0.02]",
                  status === 'current' && runningStep,
                  status === 'completed' && completedStep,
                  onStepClick && "cursor-pointer hover:bg-white/[0.04]"
                )}
                style={{ animationDelay: `${index * 50}ms` }}
              >
                {/* Status Icon */}
                <div className={cn(
                  "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
                  status === 'completed' && "bg-emerald-500/20 text-emerald-400",
                  status === 'current' && "bg-cyan-500/20 text-cyan-400",
                  status === 'pending' && "bg-white/5 text-white/30",
                  status === 'error' && "bg-red-500/20 text-red-400"
                )}>
                  {status === 'completed' && <CheckCircle2 className="w-4 h-4" />}
                  {status === 'current' && <Loader2 className={cn("w-4 h-4", pulseGlow)} />}
                  {status === 'pending' && <Circle className="w-4 h-4" />}
                  {status === 'error' && <AlertCircle className="w-4 h-4" />}
                </div>

                {/* Step Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/90">
                      {meta.label}
                    </span>
                    {status === 'current' && isRunning && (
                      <span className={cn("text-xs text-cyan-400", pulseGlow)}>
                        Processando...
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-white/40">
                    {meta.icon} Paso {index + 1} de {PIPELINE_STEPS.length}
                  </span>
                </div>

                {/* Status Badge */}
                <Badge 
                  variant={getBadgeVariant(status)}
                  className="text-xs"
                >
                  {status === 'completed' && 'Completado'}
                  {status === 'current' && 'Activo'}
                  {status === 'pending' && 'Pendiente'}
                  {status === 'error' && 'Error'}
                </Badge>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Compact version of PipelineView for sidebar or small spaces
 */
interface PipelineViewCompactProps {
  activeStep: string;
  isRunning: boolean;
  className?: string;
}

export function PipelineViewCompact({
  activeStep,
  isRunning,
  className,
}: PipelineViewCompactProps) {
  const meta = STEP_META[activeStep as PipelineStep];
  const currentIndex = PIPELINE_STEPS.indexOf(activeStep as PipelineStep);
  const progress = isRunning && currentIndex >= 0 
    ? ((currentIndex + 1) / PIPELINE_STEPS.length) * 100 
    : 0;

  return (
    <Card className={cn("bg-transparent border-white/5", className)}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <Loader2 className={cn("w-4 h-4 text-cyan-400", pulseGlow)} />
            ) : (
              <Circle className="w-4 h-4 text-white/30" />
            )}
            <span className="text-sm font-medium text-white">
              {meta?.label || 'Pipeline'}
            </span>
          </div>
          <Badge variant={isRunning ? 'warning' : 'secondary'} className="text-xs">
            {isRunning ? `${Math.round(progress)}%` : 'Inactivo'}
          </Badge>
        </div>
        
        <Progress 
          value={progress} 
          className="h-1.5"
        />
      </CardContent>
    </Card>
  );
}

export default PipelineView;
