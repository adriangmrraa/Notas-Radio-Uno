import { chatCompletion, extractJSON } from "./aiService.js";
import type { Insights } from "../../shared/types.js";

const SYSTEM_PROMPT = `Sos un analista de inteligencia informativa. Tu trabajo es procesar transcripciones en bruto de transmisiones en vivo y extraer datos estructurados para el equipo editorial.

CRITERIOS DE ANALISIS:
- Distingui hechos verificables de opiniones
- Identifica personas con nombre completo y cargo cuando sea posible
- Las busquedas sugeridas deben ser especificas y en espanol
- Los datos clave deben ser citables: cifras, fechas, declaraciones textuales
- Clasifica correctamente: un saludo al oyente NO es un tema noticioso

FORMATO: Responde SOLO en JSON valido, sin markdown ni backticks.`;

/**
 * Extrae insights clave de un bloque de transcripcion.
 */
async function extractInsights(transcriptionText: string): Promise<Insights> {
  const userPrompt = `TRANSCRIPCION:
"""
${transcriptionText}
"""

Extrae la informacion clave en esta estructura JSON:
{
  "topics": ["tema noticioso 1", "tema noticioso 2"],
  "people": ["Nombre Completo - cargo/rol (si se menciona)"],
  "keyFacts": ["dato concreto y citable 1", "dato concreto 2"],
  "searchQueries": ["busqueda Google especifica 1", "busqueda 2"],
  "summary": "Resumen ejecutivo de 2-3 oraciones con los hechos principales"
}

Reglas:
- "topics": solo temas con sustancia periodistica (no saludos, no musica, no cortes)
- "people": nombres propios mencionados con contexto
- "keyFacts": datos duros: cifras, fechas, declaraciones textuales, decisiones
- "searchQueries": busquedas que ayuden a verificar o ampliar la informacion (en espanol)
- Si no hay contenido noticioso, devuelve arrays vacios y un summary indicandolo`;

  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.2,
      maxTokens: 1000,
      jsonMode: true,
    });

    const insights = extractJSON(text) as Partial<Insights> | null;
    if (insights) {
      return {
        topics: insights.topics || [],
        people: insights.people || [],
        keyFacts: insights.keyFacts || [],
        searchQueries: insights.searchQueries || [],
        summary: insights.summary || "",
      };
    }

    return {
      topics: [],
      people: [],
      keyFacts: [],
      searchQueries: [],
      summary: text.slice(0, 200),
    };
  } catch (error: unknown) {
    const err = error as Error;
    console.error("[Insights] Error:", err.message);
    throw new Error("Error al extraer insights: " + err.message);
  }
}

export { extractInsights };
