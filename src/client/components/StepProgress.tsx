import React from 'react';

interface StepProgressProps {
  currentStep: string;
}

const STEPS = [
  { id: 'capturing', icon: '\uD83C\uDFA4', label: 'Captura' },
  { id: 'analyzing', icon: '\uD83D\uDD0D', label: 'Analisis' },
  { id: 'searching', icon: '\uD83C\uDF10', label: 'Busqueda' },
  { id: 'generating', icon: '\u270D\uFE0F', label: 'Nota' },
  { id: 'creating_flyer', icon: '\uD83D\uDDBC\uFE0F', label: 'Placa' },
  { id: 'publishing', icon: '\uD83D\uDCE4', label: 'Publicar' },
];

export default function StepProgress({ currentStep }: StepProgressProps) {
  const activeIdx = STEPS.findIndex((s) => s.id === currentStep);

  const getStepClass = (stepId: string, idx: number): string => {
    const classes = ['step'];

    if (stepId === currentStep) {
      classes.push('active');
    }

    // Capturing is always active when pipeline runs
    if (stepId === 'capturing' && currentStep && currentStep !== 'stopped') {
      classes.push('active');
    }

    // Mark processing steps as completed once they pass
    if (activeIdx > 0 && idx > 0 && idx < activeIdx) {
      classes.push('completed');
    }

    return classes.join(' ');
  };

  return (
    <div className="pipeline-steps">
      {STEPS.map((step, idx) => (
        <React.Fragment key={step.id}>
          {idx > 0 && <div className="step-connector" />}
          <div className={getStepClass(step.id, idx)} id={`step-${step.id}`}>
            <div className="step-icon-wrap">
              <span className="step-icon">{step.icon}</span>
            </div>
            <span className="step-label">{step.label}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
