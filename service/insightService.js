import { chatCompletion, extractJSON } from "../scripts/aiService.js";

const SYSTEM_PROMPT = `Sos un analista de inteligencia informativa de Radio Uno Formosa. Tu trabajo es procesar transcripciones en bruto de transmisiones en vivo y extraer datos estructurados para el equipo editorial.

CRITERIOS DE ANÁLISIS:
- Priorizá la relevancia para Formosa y el NEA argentino
- Distinguí hechos verificables de opiniones
- Identificá personas con nombre completo y cargo cuando sea posible
- Las búsquedas sugeridas deben ser específicas y en español argentino
- Los datos clave deben ser citables: cifras, fechas, declaraciones textuales
- Clasificá correctamente: un saludo al oyente NO es un tema noticioso

FORMATO: Respondé SOLO en JSON válido, sin markdown ni backticks.`;

/**
 * Extrae insights clave de un bloque de transcripción.
 * @returns {{ topics, people, keyFacts, searchQueries, summary }}
 */
async function extractInsights(transcriptionText) {
  const userPrompt = `TRANSCRIPCIÓN:
"""
${transcriptionText}
"""

Extraé la información clave en esta estructura JSON:
{
  "topics": ["tema noticioso 1", "tema noticioso 2"],
  "people": ["Nombre Completo - cargo/rol (si se menciona)"],
  "keyFacts": ["dato concreto y citable 1", "dato concreto 2"],
  "searchQueries": ["búsqueda Google específica 1", "búsqueda 2"],
  "summary": "Resumen ejecutivo de 2-3 oraciones con los hechos principales"
}

Reglas:
- "topics": solo temas con sustancia periodística (no saludos, no música, no cortes)
- "people": nombres propios mencionados con contexto
- "keyFacts": datos duros: cifras, fechas, declaraciones textuales, decisiones
- "searchQueries": búsquedas que ayuden a verificar o ampliar la información (en español)
- Si no hay contenido noticioso, devolvé arrays vacíos y un summary indicándolo`;

  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.2,
      maxTokens: 1000,
      jsonMode: true,
    });

    const insights = extractJSON(text);
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
  } catch (error) {
    console.error("[Insights] Error:", error.message);
    throw new Error("Error al extraer insights: " + error.message);
  }
}

export { extractInsights };
