import { chatCompletion, extractJSON } from "./aiService.js";
import { searchAndEnrich } from "./searchService.js";
import { limiters } from "./rateLimiter.js";
import type { CustomAgent, AgentInput, AgentOutput } from "../../shared/types.js";

/**
 * Ejecuta un agente custom dentro del pipeline.
 * El agente recibe el output del nodo anterior y produce output para el siguiente.
 */
export async function executeAgent(agent: CustomAgent, input: AgentInput): Promise<AgentOutput> {
  const startTime = Date.now();

  // Build user prompt from input data
  const userPrompt = `INPUT DATA (JSON del paso anterior del pipeline):
\`\`\`json
${JSON.stringify(input.data, null, 2)}
\`\`\`

Procesá estos datos según tus instrucciones y respondé en el formato indicado.`;

  // If agent has web_search tool enabled, do a search first
  let webContext = "";
  if (agent.tools.includes("web_search") && input.data.title) {
    try {
      const results = await searchAndEnrich([String(input.data.title)]);
      if (results.length > 0) {
        webContext = `\n\nCONTEXTO WEB (resultados de búsqueda):\n${results.map(r => `- ${r.title}: ${r.content?.slice(0, 300) || r.snippet}`).join('\n')}`;
      }
    } catch (_) { /* ignore search errors */ }
  }

  const fullUserPrompt = userPrompt + webContext;

  // Determine AI provider
  const providerOptions: Record<string, any> = {};
  if (agent.ai_provider === 'deepseek') {
    providerOptions.forceProvider = 'deepseek';
  } else if (agent.ai_provider === 'gemini') {
    providerOptions.forceProvider = 'gemini';
  }

  try {
    const { text, provider } = await chatCompletion({
      systemPrompt: agent.system_prompt,
      userPrompt: fullUserPrompt,
      temperature: agent.temperature,
      maxTokens: agent.max_tokens,
      jsonMode: true,
    });

    // Try to parse JSON response and merge with input data
    const parsed = extractJSON(text);
    const outputData = parsed
      ? { ...input.data, ...parsed as Record<string, unknown> }
      : { ...input.data, agentResponse: text };

    return {
      nodeId: `agent_${agent.id}`,
      data: outputData,
      executionTimeMs: Date.now() - startTime,
      provider,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[Agent ${agent.name}] Error:`, err.message);
    // On error, pass through input unchanged
    return {
      nodeId: `agent_${agent.id}`,
      data: input.data,
      executionTimeMs: Date.now() - startTime,
      provider: "error",
    };
  }
}
