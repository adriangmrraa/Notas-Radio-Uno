import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Node,
  Edge,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { usePipelineState } from '../hooks/usePipelineState';
import NodePalette from './components/NodePalette';
import PipelineNode from './components/PipelineNode';
import NodeInspector from './components/NodeInspector';
import AgentConfigModal from './components/AgentConfigModal';
import './PipelineEditor.css';

// Types
interface PipelineNodeDef {
  id: string;
  type: 'builtin' | 'agent';
  name: string;
  description: string;
  icon: string;
  agent?: any;
}

interface PipelineConfig {
  id: string;
  name: string;
  node_order: string[];
  is_active: boolean;
}

interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  defaultAfterStep: string;
  systemPrompt: string;
  tools: string[];
  temperature: number;
  icon: string;
}

const nodeTypes = { pipelineNode: PipelineNode };

export default function PipelineEditor() {
  const { nodeStatuses } = usePipelineState();

  // Data
  const [config, setConfig] = useState<PipelineConfig | null>(null);
  const [allNodes, setAllNodes] = useState<PipelineNodeDef[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Modal
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<any>(null);
  const [insertAfterStep, setInsertAfterStep] = useState<string>('generate_news');

  // React Flow
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Fetch data
  useEffect(() => {
    Promise.all([
      fetch('/api/pipeline-config').then(r => r.json()),
      fetch('/api/pipeline-config/nodes').then(r => r.json()),
      fetch('/api/agents/templates').then(r => r.json()),
    ]).then(([configData, nodesData, templatesData]) => {
      setConfig(configData.config);
      setAllNodes(nodesData.nodes);
      setTemplates(templatesData.templates);
    }).catch(console.error);
  }, []);

  // Build graph from config
  useEffect(() => {
    if (!config || allNodes.length === 0) return;

    const nodeOrder = config.node_order.length > 0 ? config.node_order : [
      'capture', 'transcribe', 'analyze', 'insights', 'search',
      'generate_news', 'generate_title', 'generate_flyer', 'publish'
    ];

    const flowNodes: Node[] = nodeOrder.map((nodeId, index) => {
      const nodeDef = allNodes.find(n => n.id === nodeId);
      const status = nodeStatuses[nodeId] || 'idle';
      return {
        id: nodeId,
        type: 'pipelineNode',
        position: { x: 300, y: index * 120 },
        data: {
          label: nodeDef?.name || nodeId,
          icon: nodeDef?.icon || '⚙️',
          description: nodeDef?.description || '',
          nodeType: nodeDef?.type || 'builtin',
          status,
          isSelected: selectedNodeId === nodeId,
          onAddAgent: () => { setInsertAfterStep(nodeId); setShowAgentModal(true); },
        },
      };
    });

    const flowEdges: Edge[] = [];
    for (let i = 0; i < nodeOrder.length - 1; i++) {
      const status = nodeStatuses[nodeOrder[i]];
      flowEdges.push({
        id: `e-${nodeOrder[i]}-${nodeOrder[i + 1]}`,
        source: nodeOrder[i],
        target: nodeOrder[i + 1],
        animated: status === 'running',
        style: {
          stroke: status === 'completed' ? '#00d4aa' : status === 'running' ? '#e94560' : '#555d70',
          strokeWidth: 2,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: status === 'running' ? '#e94560' : '#555d70' },
      });
    }

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [config, allNodes, nodeStatuses, selectedNodeId]);

  // Save config
  const saveConfig = useCallback(async (newOrder: string[]) => {
    try {
      const res = await fetch('/api/pipeline-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_order: newOrder }),
      });
      const data = await res.json();
      if (data.config) setConfig(data.config);
    } catch (err) {
      console.error('Error saving config:', err);
    }
  }, []);

  // Reset config
  const resetConfig = useCallback(async () => {
    if (!confirm('¿Resetear el pipeline al orden por defecto?')) return;
    try {
      const res = await fetch('/api/pipeline-config/reset', { method: 'POST' });
      const data = await res.json();
      setConfig(data.config);
      // Reload nodes
      const nodesRes = await fetch('/api/pipeline-config/nodes');
      const nodesData = await nodesRes.json();
      setAllNodes(nodesData.nodes);
    } catch (err) {
      console.error('Error resetting config:', err);
    }
  }, []);

  // Add agent
  const handleAgentSaved = useCallback(async () => {
    setShowAgentModal(false);
    setEditingAgent(null);
    // Reload everything
    const [configData, nodesData] = await Promise.all([
      fetch('/api/pipeline-config').then(r => r.json()),
      fetch('/api/pipeline-config/nodes').then(r => r.json()),
    ]);
    setConfig(configData.config);
    setAllNodes(nodesData.nodes);
  }, []);

  // Delete agent
  const handleDeleteAgent = useCallback(async (agentId: string) => {
    if (!confirm('¿Eliminar este agente?')) return;
    try {
      await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
      // Remove from pipeline config
      if (config) {
        const newOrder = config.node_order.filter(id => id !== `agent_${agentId}`);
        await saveConfig(newOrder);
      }
      handleAgentSaved();
    } catch (err) {
      console.error('Error deleting agent:', err);
    }
  }, [config, saveConfig, handleAgentSaved]);

  // Move node up/down
  const moveNode = useCallback((nodeId: string, direction: 'up' | 'down') => {
    if (!config) return;
    const order = [...config.node_order];
    const idx = order.indexOf(nodeId);
    if (idx === -1) return;

    // Don't move capture from first or publish from last
    if (nodeId === 'capture' || nodeId === 'publish') return;

    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 1 || newIdx >= order.length) return; // Keep capture first
    if (newIdx >= order.length - 1 && order[order.length - 1] === 'publish') {
      if (direction === 'down' && idx === order.length - 2) return; // Don't move past publish
    }

    [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
    saveConfig(order);
  }, [config, saveConfig]);

  const selectedNode = selectedNodeId ? allNodes.find(n => n.id === selectedNodeId) : null;

  return (
    <div className="editor-layout">
      <div className="editor-topbar">
        <Link to="/" className="btn btn-ghost btn-sm">← Operaciones</Link>
        <h1 className="editor-title">⚡ Pipeline Editor</h1>
        <div className="editor-topbar-actions">
          <button className="btn btn-ghost btn-sm" onClick={resetConfig}>Resetear</button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAgentModal(true)}>+ Agregar Agente</button>
        </div>
      </div>

      <div className="editor-body">
        <NodePalette
          templates={templates}
          onSelectTemplate={(tmpl) => {
            setInsertAfterStep(tmpl.defaultAfterStep);
            setEditingAgent({
              name: tmpl.name,
              description: tmpl.description,
              system_prompt: tmpl.systemPrompt,
              after_step: tmpl.defaultAfterStep,
              tools: tmpl.tools,
              temperature: tmpl.temperature,
              template_id: tmpl.id,
            });
            setShowAgentModal(true);
          }}
          nodeOrder={config?.node_order || []}
          allNodes={allNodes}
          onMoveNode={moveNode}
          onDeleteAgent={handleDeleteAgent}
          onEditAgent={(agent) => {
            setEditingAgent(agent);
            setInsertAfterStep(agent.after_step);
            setShowAgentModal(true);
          }}
        />

        <div className="editor-graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#1a1f35" gap={20} />
            <Controls position="bottom-right" />
            <MiniMap
              nodeColor={(n) => {
                const status = n.data?.status;
                if (status === 'running') return '#e94560';
                if (status === 'completed') return '#00d4aa';
                return '#2a3050';
              }}
              maskColor="rgba(0,0,0,0.7)"
            />
          </ReactFlow>
        </div>

        <NodeInspector
          node={selectedNode}
          onEditAgent={(agent) => {
            setEditingAgent(agent);
            setInsertAfterStep(agent.after_step);
            setShowAgentModal(true);
          }}
        />
      </div>

      {showAgentModal && (
        <AgentConfigModal
          agent={editingAgent}
          afterStep={insertAfterStep}
          templates={templates}
          currentNodeOrder={config?.node_order || []}
          onSave={handleAgentSaved}
          onClose={() => { setShowAgentModal(false); setEditingAgent(null); }}
        />
      )}
    </div>
  );
}
