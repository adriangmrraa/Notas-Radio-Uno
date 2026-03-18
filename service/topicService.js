import { chatCompletion, extractJSON } from "../scripts/aiService.js";

/**
 * Servicio de segmentación inteligente de temas.
 *
 * Problema: en radio es muy común que hagan un comentario breve sobre otra
 * cosa y después vuelvan al tema principal. Publicar en la primera detección
 * genera notas prematuras.
 *
 * Solución: sistema de confirmación en 2 fases.
 *   1. Primera detección: el tema se marca como "possibly_completed"
 *   2. Siguiente análisis: si el tema NO reapareció, se confirma
 *   Si reapareció → se descarta la señal (falso positivo evitado)
 */

const SYSTEM_PROMPT = `Sos el editor jefe de la mesa de noticias de Radio Uno Formosa. Estás monitoreando una transmisión en vivo y tu trabajo es detectar cuándo un tema noticioso se completó para que el equipo pueda publicar una nota.

CONOCIMIENTO DE RADIO EN VIVO:
- Los conductores saltan entre temas constantemente: tangentes de 30 segundos, chistes, saludos a oyentes, lectura de mensajes del WhatsApp, pausas comerciales
- Un tema NO está completado solo porque hubo una interrupción breve
- Un tema SÍ está completado cuando llevan VARIOS MINUTOS hablando de algo completamente diferente y no muestran intención de volver
- Los conductores suelen "cerrar" un tema con frases como "bueno, pasemos a otra cosa", "y eso es lo que hay", "veremos cómo sigue"
- A veces retoman temas después de una pausa: "como decíamos antes", "volviendo al tema de..."
- Las pausas comerciales, la música, los saludos y la charla social NO son temas noticiosos

CRITERIOS PARA "COMPLETED":
✓ El tema tuvo desarrollo sustancial (mínimo 2-3 minutos de discusión)
✓ Pasaron a hablar de algo completamente diferente por varios minutos
✓ No hubo indicios de que vayan a retomarlo
✓ Tiene datos concretos publicables (no fue solo opinología)

CRITERIOS PARA "NEWSWORTHY":
✓ Contiene información verificable: cifras, declaraciones oficiales, decisiones, hechos concretos
✓ Tiene relevancia pública: afecta a ciudadanos, es de interés general
✗ NO es noticioso: opiniones sin sustento, rumores, charla casual, anécdotas personales, humor

FORMATO: Respondé SOLO en JSON válido, sin markdown ni backticks.`;

/**
 * Analiza la transcripción acumulada y detecta segmentos temáticos.
 */
export async function analyzeTopicSegments(
  fullTranscription,
  latestChunk,
  alreadyPublishedTopics = [],
  pendingConfirmation = [],
) {
  const publishedContext = alreadyPublishedTopics.length > 0
    ? `\nTemas YA PUBLICADOS (NO repetir bajo ninguna circunstancia): ${alreadyPublishedTopics.join(", ")}`
    : "";

  const pendingContext = pendingConfirmation.length > 0
    ? `\nTemas que parecían completados en el análisis ANTERIOR y necesitan verificación: ${pendingConfirmation.join(", ")}. ¿Efectivamente NO volvieron a hablar de ellos, o fue solo una pausa/tangente?`
    : "";

  const userPrompt = `TRANSCRIPCIÓN ACUMULADA (últimos fragmentos cronológicos):
"""
${fullTranscription.slice(-8000)}
"""

ÚLTIMO FRAGMENTO RECIBIDO (lo más reciente):
"""
${latestChunk}
"""
${publishedContext}${pendingContext}

Analizá los SEGMENTOS TEMÁTICOS. Para cada uno respondé:

{
  "segments": [
    {
      "topic": "título corto y descriptivo del tema",
      "summary": "resumen de 1-2 oraciones con los datos clave",
      "status": "completed | ongoing",
      "newsworthy": true | false,
      "suggestedNotes": 1,
      "confidence": "high | medium | low",
      "startText": "primeras 8-10 palabras del segmento en la transcripción",
      "endText": "últimas 8-10 palabras del segmento en la transcripción"
    }
  ],
  "ongoingTopic": "tema actualmente en discusión (o null)",
  "recommendation": "wait | publish",
  "reason": "explicación breve de la decisión"
}

REGLAS DE STATUS:
- "completed" + confidence "high": tema con desarrollo extenso (3+ minutos) que claramente terminó, con señales de cierre
- "completed" + confidence "medium": probablemente terminó pero sin señales claras de cierre
- "completed" + confidence "low": podría ser solo una pausa, no recomendado publicar aún
- "ongoing": se sigue discutiendo, o se mencionó recientemente, o podría retomarse

Solo recomendá "publish" si hay al menos un tema "completed" con newsworthy=true y confidence "high" o "medium".`;

  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.15,
      maxTokens: 1500,
      jsonMode: true,
    });

    const analysis = extractJSON(text);
    if (!analysis) {
      return emptyResult("No se pudo parsear respuesta de IA");
    }

    const segments = analysis.segments || [];

    // ─── Sistema de confirmación en 2 fases ───

    const aiCompletedNewsworthy = segments.filter(
      (s) => s.status === "completed" && s.newsworthy,
    );

    const confirmedNow = [];
    const needsConfirmation = [];

    for (const seg of aiCompletedNewsworthy) {
      const wasAlreadyPending = pendingConfirmation.some(
        (t) => topicsSimilar(t, seg.topic),
      );

      if (seg.confidence === "high") {
        confirmedNow.push(seg);
      } else if (wasAlreadyPending) {
        // Ya estaba pendiente + sigue como completed → CONFIRMADO
        confirmedNow.push(seg);
      } else {
        // Primera detección con confianza media/baja → esperar
        needsConfirmation.push(seg.topic);
      }
    }

    // Temas que estaban pending pero ahora son ongoing = falso positivo evitado
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
      newPendingConfirmation: needsConfirmation,
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
 */
function topicsSimilar(a, b) {
  const normalize = (s) =>
    s.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim();

  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

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
