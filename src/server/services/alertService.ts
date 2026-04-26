/**
 * alertService.ts
 *
 * Detección de momentos relevantes en transmisiones en vivo.
 * Dos métodos de detección:
 *   A. Keyword matching — instantáneo, sin IA
 *   B. Análisis con Gemini — detección semántica de noticias de último momento,
 *      declaraciones fuertes, datos verificables y picos emocionales
 */

import axios from "axios";
import type { LiveAlert } from "../../shared/types.js";

// ── Keyword matching ─────────────────────────────────────────────────────────

/**
 * Extrae el contexto (±80 chars) alrededor de una coincidencia.
 */
function extractContext(text: string, index: number, keyword: string): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + keyword.length + 80);
  let ctx = text.slice(start, end).trim();
  if (start > 0) ctx = `...${ctx}`;
  if (end < text.length) ctx = `${ctx}...`;
  return ctx;
}

/**
 * Detecta keywords en el texto (case-insensitive, word-boundary aware).
 * Retorna una alerta por cada keyword encontrado.
 */
function detectKeywords(text: string, keywords: string[]): LiveAlert[] {
  if (!keywords.length) return [];

  const alerts: LiveAlert[] = [];
  const lowerText = text.toLowerCase();

  for (const keyword of keywords) {
    const lowerKw = keyword.toLowerCase().trim();
    if (!lowerKw) continue;

    // Word-boundary: verifica que no esté pegado a otras letras
    const pattern = new RegExp(`(?<![a-záéíóúüñ])${escapeRegex(lowerKw)}(?![a-záéíóúüñ])`, "gi");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(lowerText)) !== null) {
      const ctx = extractContext(text, match.index, keyword);
      alerts.push({
        type: "keyword",
        severity: "medium",
        title: `Mención: "${keyword}"`,
        excerpt: ctx,
        context: `Keyword "${keyword}" detectado en la transmisión`,
        matchedKeyword: keyword,
        timestamp: new Date().toISOString(),
      });
      break; // Una alerta por keyword por chunk (evita spam)
    }
  }

  return alerts;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── AI analysis via Gemini ───────────────────────────────────────────────────

const GEMINI_ALERT_PROMPT = (text: string) => `
Analizá este fragmento de una transmisión en vivo y detectá momentos relevantes:

"${text}"

Identificá (si los hay):
1. Breaking news o noticias de último momento
2. Declaraciones fuertes o controversiales
3. Datos verificables importantes
4. Momentos de alta tensión emocional

Para cada detección, devolvé JSON:
{
  "alerts": [
    {
      "type": "breaking_news" | "strong_statement" | "key_data" | "emotional_peak",
      "severity": "high" | "medium" | "low",
      "title": "Título corto del alerta",
      "excerpt": "Cita o fragmento exacto",
      "context": "Por qué es relevante",
      "speaker": "Nombre si se puede identificar"
    }
  ]
}

Si no hay nada relevante, devolvé { "alerts": [] }.
Sé selectivo: solo alertas genuinamente importantes, no ruido.
`.trim();

interface GeminiAlertPayload {
  alerts: Array<{
    type: string;
    severity: string;
    title: string;
    excerpt: string;
    context: string;
    speaker?: string;
  }>;
}

async function detectWithGemini(text: string): Promise<LiveAlert[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  // Texto demasiado corto no vale la pena enviarlo
  if (text.trim().length < 50) return [];

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: GEMINI_ALERT_PROMPT(text) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
        maxOutputTokens: 1024,
      },
    };

    const response = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return [];

    const parsed: GeminiAlertPayload = JSON.parse(raw);
    if (!Array.isArray(parsed.alerts)) return [];

    const validTypes = new Set(["breaking_news", "strong_statement", "key_data", "emotional_peak"]);
    const validSeverities = new Set(["high", "medium", "low"]);

    return parsed.alerts
      .filter((a) => validTypes.has(a.type) && validSeverities.has(a.severity))
      .map((a) => ({
        type: a.type as LiveAlert["type"],
        severity: a.severity as LiveAlert["severity"],
        title: String(a.title || "").slice(0, 120),
        excerpt: String(a.excerpt || "").slice(0, 300),
        context: String(a.context || "").slice(0, 300),
        speaker: a.speaker ? String(a.speaker).slice(0, 80) : undefined,
        timestamp: new Date().toISOString(),
      }));
  } catch (err) {
    console.warn("[AlertService] Gemini analysis failed:", (err as Error).message);
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detecta alertas en un fragmento de transcripción.
 * Combina keyword matching (instantáneo) + análisis Gemini (semántico).
 *
 * @param text           Texto a analizar
 * @param keywords       Lista de palabras clave configuradas por el tenant
 * @param _speakerContext Contexto de conductores/invitados (reservado para uso futuro)
 */
export async function detectAlerts(
  text: string,
  keywords: string[],
  _speakerContext?: string | null,
): Promise<LiveAlert[]> {
  const [keywordAlerts, aiAlerts] = await Promise.all([
    Promise.resolve(detectKeywords(text, keywords)),
    detectWithGemini(text),
  ]);

  return [...keywordAlerts, ...aiAlerts];
}
