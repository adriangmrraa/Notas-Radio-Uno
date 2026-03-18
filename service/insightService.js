import { CohereClient } from "cohere-ai";
import * as dotenv from "dotenv";
dotenv.config();

const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY,
});

/**
 * Extrae insights clave de un bloque de transcripción.
 * Retorna: { topics, people, keyFacts, searchQueries, summary }
 */
async function extractInsights(transcriptionText) {
  const prompt = `Analiza la siguiente transcripción de una transmisión en vivo y extrae la información clave.

TRANSCRIPCIÓN:
"""
${transcriptionText}
"""

Responde SOLO en formato JSON válido (sin markdown, sin backticks) con esta estructura exacta:
{
  "topics": ["tema1", "tema2"],
  "people": ["persona1", "persona2"],
  "keyFacts": ["dato clave 1", "dato clave 2"],
  "searchQueries": ["búsqueda 1 para Google", "búsqueda 2 para Google"],
  "summary": "Resumen de 2-3 oraciones de lo más relevante"
}

Si la transcripción no tiene contenido noticioso claro, devuelve arrays vacíos y un summary indicándolo.`;

  try {
    const response = await cohere.generate({
      prompt,
      model: "command-nightly",
      max_tokens: 800,
      temperature: 0.3,
      k: 0,
      stop_sequences: [],
      return_likelihoods: "NONE",
    });

    const rawText = response.generations[0].text.trim();

    // Intentar parsear el JSON de la respuesta
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const insights = JSON.parse(jsonMatch[0]);
      return {
        topics: insights.topics || [],
        people: insights.people || [],
        keyFacts: insights.keyFacts || [],
        searchQueries: insights.searchQueries || [],
        summary: insights.summary || "",
      };
    }

    // Si no se puede parsear, retornar estructura básica
    return {
      topics: [],
      people: [],
      keyFacts: [],
      searchQueries: [],
      summary: rawText.slice(0, 200),
    };
  } catch (error) {
    console.error("Error extrayendo insights:", error);
    throw new Error("Error al extraer insights: " + error.message);
  }
}

export { extractInsights };
