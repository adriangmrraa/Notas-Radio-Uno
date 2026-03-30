import type { Express, Request, Response } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getActivePipelineConfig, savePipelineConfig, resetPipelineConfig, getAllAgents } from "../services/databaseService.js";
import { BUILTIN_NODES, DEFAULT_NODE_ORDER } from "../../shared/types.js";

export function registerPipelineConfigRoutes(app: Express): void {
  // Get active pipeline config
  app.get("/api/pipeline-config", requireAuth, (_req: Request, res: Response) => {
    try {
      const config = getActivePipelineConfig();
      res.json({
        config: config || { id: 'default', name: 'Default Pipeline', node_order: DEFAULT_NODE_ORDER, is_active: true },
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Save pipeline config
  app.put("/api/pipeline-config", requireAuth, (req: Request, res: Response) => {
    const { node_order, name } = req.body;
    if (!node_order || !Array.isArray(node_order)) {
      res.status(400).json({ error: "Se requiere node_order como array" });
      return;
    }

    try {
      const config = savePipelineConfig({ node_order, name });
      res.json({ success: true, config });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Reset to default
  app.post("/api/pipeline-config/reset", requireAuth, (_req: Request, res: Response) => {
    try {
      resetPipelineConfig();
      res.json({ success: true, config: { id: 'default', name: 'Default Pipeline', node_order: DEFAULT_NODE_ORDER, is_active: true } });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get all available nodes (built-in + custom agents)
  app.get("/api/pipeline-config/nodes", requireAuth, (_req: Request, res: Response) => {
    try {
      const agents = getAllAgents();
      const agentNodes = agents.map((a: any) => ({
        id: `agent_${a.id}`,
        type: 'agent' as const,
        name: a.name,
        description: a.description,
        icon: '\u{1F916}',
        inputType: 'any',
        outputType: 'any',
        configurable: true,
        agent: a,
      }));
      res.json({ nodes: [...BUILTIN_NODES, ...agentNodes] });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
}
