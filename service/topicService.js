import { CohereClient } from "cohere-ai";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Servicio de segmentación inteligente de temas.
 *
 * Problema que resuelve: en radio es muy común que en medio de un tema
 * hagan un comentario breve sobre otra cosa y después vuelvan al tema
 * principal. Si marcamos "completed" la primera vez que detectamos un
 * cambio, generamos notas prematuras sobre temas incompletos.
 *
 * Solución: sistema de confirmación en 2 fases.
 *   1. Primera detección: el tema se marca como "possibly_completed"
 *   2. Siguiente análisis: si el tema NO reapareció, se confirma como "completed"
 *   Si el tema reapareció en el siguiente análisis, se descarta la señal.
 *
 * Esto evita falsos positivos por:
 *   - Comentarios al paso ("hablando de X... pero volviendo a lo nuestro")
 *   - Tangentes breves (30 segundos sobre otro asunto)
 *   - Referencias cruzadas entre temas
 *   - Pausas comerciales cortas
 */

/**
 * Analiza la transcripción acumulada y detecta segmentos temáticos.
 *
 * @param {string} fullTranscription - Toda la transcripción acumulada
 * @param {string} latestChunk - El chunk más reciente
 * @param {string[]} alreadyPublishedTopics - Temas ya publicados
 * @param {string[]} pendingConfirmation - Temas que necesitan confirmación de cierre
 * @returns {object} { segments, completedSegments, newPendingConfirmation, ... }
 */
export async function analyzeTopicSegments(
  fullTranscription,
  latestChunk,
  alreadyPublishedTopics = [],
  pendingConfirmation = [],
) {
  const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
  });

  const publishedContext = alreadyPublishedTopics.length > 0
    ? `\nTemas YA publicados (NO repetir): ${alreadyPublishedTopics.join(", ")}`
    : "";

  const pendingContext = pendingConfirmation.length > 0
    ? `\nTemas que parecían haber terminado en el análisis ANTERIOR: ${pendingConfirmation.join(", ")}. Verificar si efectivamente no volvieron a hablar de ellos o si fue solo un comentario al paso.`
    : "";

  const prompt = `Eres un editor de noticias analizando una transcripción en vivo de un programa de radio.

TRANSCRIPCIÓN ACUMULADA (últimos fragmentos en orden cronológico):
"""
${fullTranscription.slice(-8000)}
"""

ÚLTIMO FRAGMENTO RECIBIDO (lo más reciente que se dijo):
"""
${latestChunk}
"""
${publishedContext}${pendingContext}

TAREA: Analiza la transcripción y detecta los SEGMENTOS TEMÁTICOS distintos.

IMPORTANTE sobre cambios de tema:
- En radio es MUY COMÚN hacer comentarios breves sobre otro tema y VOLVER al tema principal. Esto NO es un cambio de tema real.
- Un tema está REALMENTE completado solo si llevan varios minutos hablando de algo COMPLETAMENTE diferente.
- Si mencionan otro tema solo de pasada (1-2 oraciones, un comentario, una referencia rápida), eso es una tangente, NO un tema separado.
- Un "ongoing" que tuvo una interrupción breve sigue siendo "ongoing" si retomaron el tema.
- Pausas comerciales, saludos a oyentes, y charla social NO son temas noticiosos.

Para cada segmento temático real detectado:
1. ¿De qué trata? (tema principal, no tangentes)
2. ¿Ya terminaron DEFINITIVAMENTE de hablar de esto? (llevan rato en otro tema)
3. ¿Tiene sustancia periodística real? (datos, declaraciones, hechos concretos)

Responde SOLO en JSON válido (sin markdown, sin backticks):
{
  "segments": [
    {
      "topic": "título corto del tema",
      "summary": "resumen de 1-2 oraciones",
      "status": "completed" | "ongoing",
      "newsworthy": true | false,
      "suggestedNotes": 1,
      "confidence": "high" | "medium" | "low",
      "startText": "primeras 10 palabras del segmento",
      "endText": "últimas 10 palabras del segmento"
    }
  ],
  "ongoingTopic": "tema que se sigue discutiendo actualmente (o null)",
  "recommendation": "wait" | "publish",
  "reason": "explicación breve de por qué publicar o esperar"
}

Reglas para "status":
- "completed": llevan VARIOS MINUTOS en un tema totalmente diferente, y NO volvieron al tema anterior
- "ongoing": siguen hablándolo, o lo mencionaron recientemente, o podría retomarse

Reglas para "confidence":
- "high": el tema tuvo un desarrollo extenso (varios minutos) y claramente terminó
- "medium": parece que terminaron pero podría ser una pausa
- "low": no es claro si terminaron o es solo un desvío temporal

Reglas para "newsworthy":
- true: tiene información periodística real (datos, declaraciones, hechos concretos, decisiones oficiales)
- false: charla casual, opiniones sin sustento, tangentes, saludos, comerciales

Solo recomendar "publish" si hay al menos un tema "completed" con "newsworthy: true" y "confidence: high" o "medium".`;

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

    if (!jsonMatch) {
      return emptyResult("No se pudo parsear respuesta de IA");
    }

    const analysis = JSON.parse(jsonMatch[0]);
    const segments = analysis.segments || [];

    // ─── Sistema de confirmación en 2 fases ───

    // Temas que la IA dice que están completed Y son noticiosos
    const aiCompletedNewsworthy = segments.filter(
      (s) => s.status === "completed" && s.newsworthy,
    );

    // Fase 1: temas con confidence alta → confirmed directamente
    // Fase 2: temas con confidence media/baja → necesitan confirmación
    const confirmedNow = [];
    const needsConfirmation = [];

    for (const seg of aiCompletedNewsworthy) {
      const wasAlreadyPending = pendingConfirmation.some(
        (t) => topicsSimilar(t, seg.topic),
      );

      if (seg.confidence === "high") {
        // Alta confianza: confirmar directamente
        confirmedNow.push(seg);
      } else if (wasAlreadyPending) {
        // Ya estaba pendiente de confirmación desde el análisis anterior
        // y la IA sigue diciendo que está completed → CONFIRMADO
        confirmedNow.push(seg);
      } else {
        // Primera vez que se detecta como completed con confianza media/baja
        // → marcar para confirmación en el próximo análisis
        needsConfirmation.push(seg.topic);
      }
    }

    // Temas que estaban pending pero la IA ahora dice que son ongoing
    // → el hablante retomó el tema, fue solo un desvío temporal
    const retakenTopics = pendingConfirmation.filter((pendingTopic) => {
      const currentSegment = segments.find((s) => topicsSimilar(s.topic, pendingTopic));
      return currentSegment && currentSegment.status === "ongoing";
    });

    return {
      segments,
      ongoingTopic: analysis.ongoingTopic || null,
      recommendation: confirmedNow.length > 0 ? "publish" : "wait",
      reason: confirmedNow.length > 0
        ? `${confirmedNow.length} tema(s) confirmado(s) como completado(s)`
        : needsConfirmation.length > 0
          ? `${needsConfirmation.length} tema(s) posiblemente completado(s), esperando confirmación`
          : analysis.reason || "Esperando más contenido",
      hasCompletedTopics: confirmedNow.length > 0,
      completedSegments: confirmedNow,
      // Temas que necesitan confirmación en el próximo análisis
      newPendingConfirmation: needsConfirmation,
      // Temas que el hablante retomó (falso positivo evitado)
      retakenTopics,
    };
  } catch (error) {
    console.error("[TopicSegmenter] Error:", error.message);
    return emptyResult(`Error: ${error.message}`);
  }
}

function emptyResult(reason) {
  return {
    segments: [],
    ongoingTopic: null,
    recommendation: "wait",
    reason,
    hasCompletedTopics: false,
    completedSegments: [],
    newPendingConfirmation: [],
    retakenTopics: [],
  };
}

/**
 * Compara si dos nombres de temas se refieren a lo mismo.
 * Normaliza y busca overlap significativo.
 */
function topicsSimilar(a, b) {
  const normalize = (s) =>
    s.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim();

  const na = normalize(a);
  const nb = normalize(b);

  // Exacto
  if (na === nb) return true;

  // Uno contiene al otro
  if (na.includes(nb) || nb.includes(na)) return true;

  // Overlap de palabras significativas (>= 50%)
  const wordsA = na.split(/\s+/).filter((w) => w.length > 3);
  const wordsB = nb.split(/\s+/).filter((w) => w.length > 3);
  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const overlap = wordsA.filter((w) => wordsB.includes(w)).length;
  return overlap / Math.min(wordsA.length, wordsB.length) >= 0.5;
}

/**
 * Extrae la porción de transcripción que corresponde a un segmento temático.
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
