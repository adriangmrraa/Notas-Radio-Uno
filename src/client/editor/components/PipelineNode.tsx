import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

interface PipelineNodeData {
  label: string;
  icon: string;
  description: string;
  nodeType: 'builtin' | 'agent';
  status: string;
  isSelected: boolean;
  onAddAgent: () => void;
}

function PipelineNodeComponent({ data }: { data: PipelineNodeData }) {
  const statusClass = data.status === 'running' ? 'node-running'
    : data.status === 'completed' ? 'node-completed'
    : data.status === 'error' ? 'node-error'
    : '';

  return (
    <>
      <Handle type="target" position={Position.Top} className="node-handle" />
      <div className={`pipeline-node ${data.nodeType} ${statusClass} ${data.isSelected ? 'selected' : ''}`}>
        <div className="pipeline-node-header">
          <span className="pipeline-node-icon">{data.icon}</span>
          <span className="pipeline-node-label">{data.label}</span>
          {data.status === 'running' && <span className="node-pulse" />}
        </div>
        <div className="pipeline-node-desc">{data.description}</div>
        {data.nodeType === 'agent' && (
          <div className="pipeline-node-badge">🤖 Agente Custom</div>
        )}
      </div>
      <div className="node-add-btn" onClick={(e) => { e.stopPropagation(); data.onAddAgent(); }} title="Agregar agente aquí">
        +
      </div>
      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </>
  );
}

export default memo(PipelineNodeComponent);
