import type { Express, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireAuth } from "../middleware/auth.js";
import { createAgent, getAgent, getAllAgents, updateAgent, deleteAgent } from "../services/databaseService.js";
import { AGENT_TEMPLATES } from "../services/agentTemplates.js";

export function registerAgentRoutes(app: Express): void {
  // List all agents
  app.get("/api/agents", requireAuth, (_req: Request, res: Response) => {
    try {
      const agents = getAllAgents();
      res.json({ agents });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Get agent templates
  app.get("/api/agents/templates", requireAuth, (_req: Request, res: Response) => {
    res.json({ templates: AGENT_TEMPLATES });
  });

  // Get single agent
  app.get("/api/agents/:id", requireAuth, (req: Request, res: Response) => {
    const agent = getAgent(String(req.params.id));
    if (!agent) {
      res.status(404).json({ error: "Agente no encontrado" });
      return;
    }
    res.json(agent);
  });

  // Create agent
  app.post("/api/agents", requireAuth, (req: Request, res: Response) => {
    const { name, description, system_prompt, after_step, position, ai_provider, temperature, max_tokens, tools, template_id } = req.body;

    if (!name || !system_prompt || !after_step) {
      res.status(400).json({ error: "Se requiere name, system_prompt y after_step" });
      return;
    }

    try {
      const agent = createAgent({
        id: uuidv4(),
        name, description, system_prompt, after_step,
        position: position || 0,
        ai_provider: ai_provider || 'auto',
        temperature: temperature || 0.5,
        max_tokens: max_tokens || 2000,
        tools: tools || [],
        template_id: template_id || null,
      });
      res.json({ success: true, agent });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Update agent
  app.put("/api/agents/:id", requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const existing = getAgent(id);
    if (!existing) {
      res.status(404).json({ error: "Agente no encontrado" });
      return;
    }

    try {
      const updated = updateAgent(id, req.body);
      res.json({ success: true, agent: updated });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // Delete agent
  app.delete("/api/agents/:id", requireAuth, (req: Request, res: Response) => {
    const id = String(req.params.id);
    const deleted = deleteAgent(id);
    if (!deleted) {
      res.status(404).json({ error: "Agente no encontrado" });
      return;
    }
    res.json({ success: true });
  });
}
