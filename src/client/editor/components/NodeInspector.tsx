import React from 'react';

interface Props {
  node: any | null;
  onEditAgent: (agent: any) => void;
}

export default function NodeInspector({ node, onEditAgent }: Props) {
  if (!node) {
    return (
      <div className="node-inspector">
        <div className="inspector-empty">
          <p>Seleccioná un nodo del grafo para ver sus detalles</p>
        </div>
      </div>
    );
  }

  return (
    <div className="node-inspector">
      <div className="inspector-header">
        <span className="inspector-icon">{node.icon}</span>
        <h3 className="inspector-title">{node.name}</h3>
      </div>

      <div className="inspector-field">
        <label>Tipo</label>
        <span className={`inspector-badge ${node.type}`}>
          {node.type === 'agent' ? '🤖 Agente Custom' : '⚙️ Built-in'}
        </span>
      </div>

      <div className="inspector-field">
        <label>Descripción</label>
        <p>{node.description}</p>
      </div>

      <div className="inspector-field">
        <label>Input</label>
        <code>{node.inputType}</code>
      </div>

      <div className="inspector-field">
        <label>Output</label>
        <code>{node.outputType}</code>
      </div>

      {node.type === 'agent' && node.agent && (
        <>
          <div className="inspector-divider" />
          <div className="inspector-field">
            <label>System Prompt</label>
            <pre className="inspector-prompt">{node.agent.system_prompt?.slice(0, 300)}...</pre>
          </div>
          <div className="inspector-field">
            <label>Temperatura</label>
            <span>{node.agent.temperature}</span>
          </div>
          <div className="inspector-field">
            <label>Tools</label>
            <span>{(node.agent.tools || []).join(', ') || 'Ninguna'}</span>
          </div>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
            onClick={() => onEditAgent(node.agent)}>
            ✏️ Editar Agente
          </button>
        </>
      )}
    </div>
  );
}
