import { CohereClient } from "cohere-ai";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Servicio de segmentación inteligente de temas.
 *
 * Analiza una transcripción acumulada y detecta:
 * - Temas/segmentos distintos que se han discutido
 * - Si un tema ya concluyó (el hablante pasó a otro asunto)
 * - Cuántas notas periodísticas amerita cada tema
 *
 * Esto permite que el pipeline escuche 2 horas de programa
 * y publique notas solo cuando un tema se completó, sin
 * intervalos fijos arbitrarios.
 */

/**
 * Analiza la transcripción acumulada y detecta segmentos temáticos.
 *
 * @param {string} fullTranscription - Toda la transcripción acumulada hasta ahora
 * @param {string} latestChunk - El chunk más reciente (para detectar cambio de tema)
 * @param {string[]} alreadyPublishedTopics - Temas ya publicados (para no repetir)
 * @returns {object} { segments, hasCompletedTopics, completedSegments, ongoingTopic }
 */
export async function analyzeTopicSegments(fullTranscription, latestChunk, alreadyPublishedTopics = []) {
  const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
  });

  const publishedContext = alreadyPublishedTopics.length > 0
    ? `\n\nTemas YA publicados (NO repetir): ${alreadyPublishedTopics.join(", ")}`
    : "";

  const prompt = `Eres un editor de noticias analizando una transcripción en vivo de un programa de radio.

TRANSCRIPCIÓN ACUMULADA (completa, en orden cronológico):
"""
${fullTranscription.slice(-8000)}
"""

ÚLTIMO FRAGMENTO RECIBIDO (lo más reciente):
"""
${latestChunk}
"""
${publishedContext}

TAREA: Analiza la transcripción y detecta los SEGMENTOS TEMÁTICOS distintos.

Para cada segmento, determina:
1. ¿De qué trata? (tema principal)
2. ¿Ya terminaron de hablar de esto? (el tema concluyó y pasaron a otro)
3. ¿Amerita una nota periodística? (tiene suficiente sustancia informativa)
4. ¿Cuántas notas periodísticas se podrían hacer con este segmento? (1 o 2 máximo)

Responde SOLO en JSON válido (sin markdown, sin backticks):
{
  "segments": [
    {
      "topic": "título corto del tema",
      "summary": "resumen de 1-2 oraciones",
      "status": "completed" | "ongoing",
      "newsworthy": true | false,
      "suggestedNotes": 1,
      "startText": "primeras 10 palabras del segmento",
      "endText": "últimas 10 palabras del segmento"
    }
  ],
  "ongoingTopic": "tema que se sigue discutiendo actualmente (o null)",
  "recommendation": "wait" | "publish",
  "reason": "explicación breve de por qué publicar o esperar"
}

Reglas:
- Un segmento está "completed" si claramente pasaron a hablar de otra cosa
- Un segmento está "ongoing" si todavía lo están discutiendo
- Solo marcar "newsworthy: true" si tiene información periodística real (datos, declaraciones, hechos)
- Comentarios casuales, chistes, pausas comerciales NO son noticiosos
- Si hay solo un tema y sigue en curso, recomendar "wait"
- Si hay al menos un tema completado y noticioso, recomendar "publish"`;

  try {
    const response = await cohere.generate({
      prompt,
      model: "command-nightly",
      max_tokens: 1200,
      temperature: 0.2,
      k: 0,
      stop_sequences: [],
      return_likelihoods: "NONE",
    });

    const rawText = response.generations[0].text.trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      return {
        segments: analysis.segments || [],
        ongoingTopic: analysis.ongoingTopic || null,
        recommendation: analysis.recommendation || "wait",
        reason: analysis.reason || "",
        hasCompletedTopics: (analysis.segments || []).some(
          (s) => s.status === "completed" && s.newsworthy,
        ),
        completedSegments: (analysis.segments || []).filter(
          (s) => s.status === "completed" && s.newsworthy,
        ),
      };
    }

    return {
      segments: [],
      ongoingTopic: null,
      recommendation: "wait",
      reason: "No se pudo analizar la transcripción",
      hasCompletedTopics: false,
      completedSegments: [],
    };
  } catch (error) {
    console.error("[TopicSegmenter] Error:", error.message);
    return {
      segments: [],
      ongoingTopic: null,
      recommendation: "wait",
      reason: `Error: ${error.message}`,
      hasCompletedTopics: false,
      completedSegments: [],
    };
  }
}

/**
 * Extrae la porción de transcripción que corresponde a un segmento temático.
 * Usa las pistas de startText/endText para delimitar.
 */
export function extractSegmentText(fullTranscription, segment) {
  const { startText, endText } = segment;

  let startIdx = 0;
  let endIdx = fullTranscription.length;

  if (startText) {
    const cleanStart = startText.toLowerCase().trim();
    const idx = fullTranscription.toLowerCase().indexOf(cleanStart);
    if (idx !== -1) startIdx = idx;
  }

  if (endText) {
    const cleanEnd = endText.toLowerCase().trim();
    const idx = fullTranscription.toLowerCase().lastIndexOf(cleanEnd);
    if (idx !== -1) endIdx = idx + cleanEnd.length;
  }

  return fullTranscription.slice(startIdx, endIdx).trim();
}
