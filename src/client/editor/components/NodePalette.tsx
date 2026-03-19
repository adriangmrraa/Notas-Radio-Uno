import React, { useState } from 'react';

interface Props {
  templates: any[];
  nodeOrder: string[];
  allNodes: any[];
  onSelectTemplate: (tmpl: any) => void;
  onMoveNode: (nodeId: string, direction: 'up' | 'down') => void;
  onDeleteAgent: (agentId: string) => void;
  onEditAgent: (agent: any) => void;
}

export default function NodePalette({ templates, nodeOrder, allNodes, onSelectTemplate, onMoveNode, onDeleteAgent, onEditAgent }: Props) {
  const [activeTab, setActiveTab] = useState<'order' | 'templates'>('order');

  return (
    <div className="node-palette">
      <div className="palette-tabs">
        <button className={`palette-tab ${activeTab === 'order' ? 'active' : ''}`} onClick={() => setActiveTab('order')}>
          Pipeline
        </button>
        <button className={`palette-tab ${activeTab === 'templates' ? 'active' : ''}`} onClick={() => setActiveTab('templates')}>
          Templates
        </button>
      </div>

      {activeTab === 'order' && (
        <div className="palette-section">
          <h4 className="palette-label">Orden del Pipeline</h4>
          <div className="node-order-list">
            {nodeOrder.map((nodeId, idx) => {
              const nodeDef = allNodes.find((n: any) => n.id === nodeId);
              const isAgent = nodeId.startsWith('agent_');
              const agentId = isAgent ? nodeId.replace('agent_', '') : null;
              return (
                <div key={nodeId} className={`node-order-item ${isAgent ? 'agent' : 'builtin'}`}>
                  <span className="node-order-icon">{nodeDef?.icon || '⚙️'}</span>
                  <span className="node-order-name">{nodeDef?.name || nodeId}</span>
                  <div className="node-order-actions">
                    {nodeId !== 'capture' && nodeId !== 'publish' && (
                      <>
                        <button className="node-order-btn" onClick={() => onMoveNode(nodeId, 'up')} disabled={idx <= 1}>↑</button>
                        <button className="node-order-btn" onClick={() => onMoveNode(nodeId, 'down')} disabled={idx >= nodeOrder.length - 2}>↓</button>
                      </>
                    )}
                    {isAgent && agentId && (
                      <>
                        <button className="node-order-btn edit" onClick={() => onEditAgent(nodeDef?.agent)}>✏️</button>
                        <button className="node-order-btn delete" onClick={() => onDeleteAgent(agentId)}>🗑️</button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'templates' && (
        <div className="palette-section">
          <h4 className="palette-label">Agentes Predefinidos</h4>
          <div className="template-list">
            {templates.map(tmpl => (
              <div key={tmpl.id} className="template-card" onClick={() => onSelectTemplate(tmpl)}>
                <div className="template-card-header">
                  <span className="template-icon">{tmpl.icon}</span>
                  <span className="template-name">{tmpl.name}</span>
                </div>
                <div className="template-desc">{tmpl.description}</div>
                <div className="template-position">Después de: {tmpl.defaultAfterStep}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
