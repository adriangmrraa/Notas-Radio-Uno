import { chatCompletion, extractJSON } from "./aiService.js";
import type { TopicSegment, TopicAnalysisResult } from "../../shared/types.js";

/**
 * Servicio de segmentacion inteligente de temas.
 *
 * Problema: en radio es muy comun que hagan un comentario breve sobre otra
 * cosa y despues vuelvan al tema principal. Publicar en la primera deteccion
 * genera notas prematuras.
 *
 * Solucion: sistema de confirmacion en 2 fases.
 *   1. Primera deteccion: el tema se marca como "possibly_completed"
 *   2. Siguiente analisis: si el tema NO reaparecio, se confirma
 *   Si reaparecio -> se descarta la senal (falso positivo evitado)
 */

const SYSTEM_PROMPT = `Sos el editor jefe de una mesa de noticias en vivo. Estas monitoreando una transmision en vivo y tu trabajo es detectar cuando un tema noticioso se completo para que el equipo pueda publicar una nota.

CONOCIMIENTO DE RADIO EN VIVO:
- Los conductores saltan entre temas constantemente: tangentes de 30 segundos, chistes, saludos a oyentes, lectura de mensajes del WhatsApp, pausas comerciales
- Un tema NO esta completado solo porque hubo una interrupcion breve
- Un tema SI esta completado cuando llevan VARIOS MINUTOS hablando de algo completamente diferente y no muestran intencion de volver
- Los conductores suelen "cerrar" un tema con frases como "bueno, pasemos a otra cosa", "y eso es lo que hay", "veremos como sigue"
- A veces retoman temas despues de una pausa: "como deciamos antes", "volviendo al tema de..."
- Las pausas comerciales, la musica, los saludos y la charla social NO son temas noticiosos

CRITERIOS PARA "COMPLETED":
- El tema tuvo desarrollo sustancial (minimo 2-3 minutos de discusion)
- Pasaron a hablar de algo completamente diferente por varios minutos
- No hubo indicios de que vayan a retomarlo
- Tiene datos concretos publicables (no fue solo opinologia)

CRITERIOS PARA "NEWSWORTHY" (NOTICIA REAL):
- Contiene informacion verificable: cifras, declaraciones oficiales, decisiones, hechos concretos
- Tiene relevancia publica: afecta a ciudadanos, es de interes general
- Hay un hecho noticioso concreto: algo que paso, se anuncio, se decidio o se denuncio

NO ES NOTICIOSO (IRRELEVANTE):
- Opiniones sin sustento, rumores sin fuente, especulacion pura
- Charla casual, anecdotas personales, humor, chistes entre conductores
- Saludos a oyentes, lectura de mensajes del WhatsApp sin contenido informativo
- Comentarios sobre musica, publicidad, cortes comerciales
- Banter entre conductores sin sustancia informativa
- Si los conductores estan haciendo humor, charla casual, saludos o comentarios sin sustancia informativa, NO es un tema noticioso

FORMATO: Responde SOLO en JSON valido, sin markdown ni backticks.`;

/**
 * Analiza la transcripcion acumulada y detecta segmentos tematicos.
 */
export async function analyzeTopicSegments(
  fullTranscription: string,
  latestChunk: string,
  alreadyPublishedTopics: string[] = [],
  pendingConfirmation: string[] = [],
): Promise<TopicAnalysisResult> {
  const publishedContext =
    alreadyPublishedTopics.length > 0
      ? `\nTemas YA PUBLICADOS (NO repetir bajo ninguna circunstancia): ${alreadyPublishedTopics.join(", ")}`
      : "";

  const pendingContext =
    pendingConfirmation.length > 0
      ? `\nTemas que parecian completados en el analisis ANTERIOR y necesitan verificacion: ${pendingConfirmation.join(", ")}. Efectivamente NO volvieron a hablar de ellos, o fue solo una pausa/tangente?`
      : "";

  const userPrompt = `TRANSCRIPCION ACUMULADA (ultimos fragmentos cronologicos):
"""
${fullTranscription.slice(-8000)}
"""

ULTIMO FRAGMENTO RECIBIDO (lo mas reciente):
"""
${latestChunk}
"""
${publishedContext}${pendingContext}

Analiza los SEGMENTOS TEMATICOS. Para cada uno responde:

{
  "segments": [
    {
      "topic": "titulo corto y descriptivo del tema",
      "summary": "resumen de 1-2 oraciones con los datos clave",
      "status": "completed | ongoing",
      "newsworthy": true | false,
      "suggestedNotes": 1,
      "confidence": "high | medium | low",
      "startText": "primeras 8-10 palabras del segmento en la transcripcion",
      "endText": "ultimas 8-10 palabras del segmento en la transcripcion"
    }
  ],
  "ongoingTopic": "tema actualmente en discusion (o null)",
  "recommendation": "wait | publish",
  "reason": "explicacion breve de la decision"
}

REGLAS DE STATUS:
- "completed" + confidence "high": tema con desarrollo extenso (3+ minutos) que claramente termino, con senales de cierre
- "completed" + confidence "medium": probablemente termino pero sin senales claras de cierre
- "completed" + confidence "low": podria ser solo una pausa, no recomendado publicar aun
- "ongoing": se sigue discutiendo, o se menciono recientemente, o podria retomarse

Solo recomenda "publish" si hay al menos un tema "completed" con newsworthy=true y confidence "high" o "medium".`;

  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.15,
      maxTokens: 1500,
      jsonMode: true,
    });

    const analysis = extractJSON(text) as {
      segments?: TopicSegment[];
      ongoingTopic?: string | null;
      reason?: string;
    } | null;

    if (!analysis) {
      return emptyResult("No se pudo parsear respuesta de IA");
    }

    const segments: TopicSegment[] = analysis.segments || [];

    // ─── Sistema de confirmacion en 2 fases ───

    const aiCompletedNewsworthy = segments.filter(
      (s) => s.status === "completed" && s.newsworthy,
    );

    const confirmedNow: TopicSegment[] = [];
    const needsConfirmation: string[] = [];

    for (const seg of aiCompletedNewsworthy) {
      const wasAlreadyPending = pendingConfirmation.some((t) =>
        topicsSimilar(t, seg.topic),
      );

      if (seg.confidence === "high") {
        confirmedNow.push(seg);
      } else if (wasAlreadyPending) {
        // Ya estaba pendiente + sigue como completed -> CONFIRMADO
        confirmedNow.push(seg);
      } else {
        // Primera deteccion con confianza media/baja -> esperar
        needsConfirmation.push(seg.topic);
      }
    }

    // Temas que estaban pending pero ahora son ongoing = falso positivo evitado
    const retakenTopics = pendingConfirmation.filter((pendingTopic) => {
      const currentSegment = segments.find((s) =>
        topicsSimilar(s.topic, pendingTopic),
      );
      return currentSegment && currentSegment.status === "ongoing";
    });

    return {
      segments,
      ongoingTopic: analysis.ongoingTopic || null,
      recommendation: confirmedNow.length > 0 ? "publish" : "wait",
      reason:
        confirmedNow.length > 0
          ? `${confirmedNow.length} tema(s) confirmado(s) como completado(s)`
          : needsConfirmation.length > 0
            ? `${needsConfirmation.length} tema(s) posiblemente completado(s), esperando confirmacion`
            : analysis.reason || "Esperando mas contenido",
      hasCompletedTopics: confirmedNow.length > 0,
      completedSegments: confirmedNow,
      newPendingConfirmation: needsConfirmation,
      retakenTopics,
    };
  } catch (error: unknown) {
    const err = error as Error;
    console.error("[TopicSegmenter] Error:", err.message);
    return emptyResult(`Error: ${err.message}`);
  }
}

function emptyResult(reason: string): TopicAnalysisResult {
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
export function topicsSimilar(a: string, b: string): boolean {
  const normalize = (s: string): string =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
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
 * Extrae la porcion de transcripcion que corresponde a un segmento tematico.
 */
export function extractSegmentText(
  fullTranscription: string,
  segment: { startText?: string; endText?: string },
): string {
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
