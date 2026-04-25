import { chatCompletion } from "./aiSdkService.js";
import type { AttributedQuote, Insights } from "../../shared/types.js";

/**
 * Extract JSON from text response (for backward compatibility)
 */
function extractJSON(text: string): unknown {
  // Intentar parsear directamente
  try {
    return JSON.parse(text);
  } catch (_) {
    // no-op
  }

  // Buscar JSON en markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {
      // no-op
    }
  }

  // Buscar objeto JSON suelto
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) {
      // no-op
    }
  }

  return null;
}

const SYSTEM_PROMPT = `Sos un analista de inteligencia informativa. Tu trabajo es procesar transcripciones en bruto de transmisiones en vivo y extraer datos estructurados para el equipo editorial.

CRITERIOS DE ANALISIS:
- Distingui hechos verificables de opiniones
- Identifica personas con nombre completo y cargo cuando sea posible
- Las busquedas sugeridas deben ser especificas y en espanol
- Los datos clave deben ser citables: cifras, fechas, declaraciones textuales
- Clasifica correctamente: un saludo al oyente NO es un tema noticioso

FORMATO: Responde SOLO en JSON valido, sin markdown ni backticks.`;

/**
 * Parsea los nombres conocidos del speakerContext.
 * Formato esperado: "Nombre — rol\nNombre2 — rol2\n..."
 */
function parseKnownSpeakers(speakerContext: string): string[] {
  return speakerContext
    .split("\n")
    .map((line) => line.split(" — ")[0].trim())
    .filter((name) => name.length > 0);
}

/**
 * Filtra y valida las citas atribuidas según las reglas de post-procesamiento.
 */
function filterQuotes(
  quotes: AttributedQuote[],
  knownSpeakers: string[]
): AttributedQuote[] {
  const knownLower = knownSpeakers.map((s) => s.toLowerCase());

  const filtered = quotes.filter((q) => {
    if (q.confidence === "low") return false;
    if (q.speaker === "Desconocido") return false;
    if (!knownLower.includes(q.speaker.toLowerCase())) return false;
    return true;
  });

  return filtered.slice(0, 5);
}

/**
 * Extrae insights clave de un bloque de transcripcion.
 */
async function extractInsights(
  transcriptionText: string,
  speakerContext?: string | null
): Promise<Insights> {
  const basePrompt = `TRANSCRIPCION:
"""
${transcriptionText}
"""

Extrae la informacion clave en esta estructura JSON:
{
  "topics": ["tema noticioso 1", "tema noticioso 2"],
  "people": ["Nombre Completo - cargo/rol (si se menciona)"],
  "keyFacts": ["dato concreto y citable 1", "dato concreto 2"],
  "searchQueries": ["busqueda Google especifica 1", "busqueda 2"],
  "summary": "Resumen ejecutivo de 2-3 oraciones con los hechos principales",
  "quotes": [{"speaker": "...", "role": "...", "text": "...", "confidence": "high|medium|low"}]
}

Reglas:
- "topics": solo temas con sustancia periodistica (no saludos, no musica, no cortes)
- "people": nombres propios mencionados con contexto
- "keyFacts": datos duros: cifras, fechas, declaraciones textuales, decisiones
- "searchQueries": busquedas que ayuden a verificar o ampliar la informacion (en espanol)
- "quotes": campo opcional, incluilo solo si se indica mas abajo
- Si no hay contenido noticioso, devuelve arrays vacios y un summary indicandolo`;

  const speakerBlock =
    speakerContext && speakerContext.trim().length > 0
      ? `\n\nTambién, identifica citas textuales relevantes de los participantes conocidos del programa:\n${speakerContext}\n\nPara cada cita textual encontrada, incluí en el JSON un campo "quotes" como array de objetos con:\n- "speaker": nombre exacto del participante (debe coincidir con la lista anterior)\n- "role": rol del participante\n- "text": la cita textual exacta (sin modificar las palabras)\n- "confidence": "high" si el hablante se identifica explícitamente en el texto, "medium" si se puede inferir del contexto, "low" si es una suposición\n\nIMPORTANTE: NO inventes atribuciones. Si no estás seguro de quién habla, usá "Desconocido" como speaker.`
      : "";

  const userPrompt = basePrompt + speakerBlock;

  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.2,
      maxTokens: 1000,
      jsonMode: true,
    });

    const raw = extractJSON(text) as Partial<Insights & { quotes: AttributedQuote[] }> | null;
    if (raw) {
      const base: Insights = {
        topics: raw.topics || [],
        people: raw.people || [],
        keyFacts: raw.keyFacts || [],
        searchQueries: raw.searchQueries || [],
        summary: raw.summary || "",
      };

      if (speakerContext && speakerContext.trim().length > 0 && Array.isArray(raw.quotes)) {
        const knownSpeakers = parseKnownSpeakers(speakerContext);
        const filtered = filterQuotes(raw.quotes, knownSpeakers);
        if (filtered.length > 0) {
          base.quotes = filtered;
        }
      }

      return base;
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
