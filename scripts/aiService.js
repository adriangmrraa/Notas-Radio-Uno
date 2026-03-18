import axios from "axios";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Servicio unificado de IA - DeepSeek (primario) + Gemini (fallback)
 *
 * DeepSeek: API compatible con OpenAI, modelos deepseek-chat (V3)
 * Gemini: Google AI Studio, modelo gemini-2.0-flash
 *
 * Ambos se invocan con la misma interfaz: sistema + usuario → texto.
 */

const DEEPSEEK_API = "https://api.deepseek.com/chat/completions";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── DeepSeek ───

async function callDeepSeek({ systemPrompt, userPrompt, temperature = 0.5, maxTokens = 1000, jsonMode = false }) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const body = {
    model: "deepseek-chat",
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await axios.post(DEEPSEEK_API, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 90000,
  });

  return response.data.choices[0].message.content;
}

// ─── Gemini ───

async function callGemini({ systemPrompt, userPrompt, temperature = 0.5, maxTokens = 1000, jsonMode = false }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = "gemini-2.0-flash";
  const url = `${GEMINI_API}/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
    },
  };

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (jsonMode) {
    body.generationConfig.responseMimeType = "application/json";
  }

  const response = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 90000,
  });

  return response.data.candidates[0].content.parts[0].text;
}

// ─── Interfaz unificada ───

/**
 * Ejecuta una completion de IA. Prueba DeepSeek primero, Gemini como fallback.
 *
 * @param {Object} options
 * @param {string} options.systemPrompt - Instrucción del sistema
 * @param {string} options.userPrompt - Mensaje del usuario
 * @param {number} options.temperature - Creatividad (0-1)
 * @param {number} options.maxTokens - Máximo de tokens de salida
 * @param {boolean} options.jsonMode - Forzar respuesta JSON
 * @returns {{ text: string, provider: string }}
 */
export async function chatCompletion(options) {
  // Intento 1: DeepSeek
  try {
    const result = await callDeepSeek(options);
    if (result) return { text: result, provider: "deepseek" };
  } catch (error) {
    console.error("[AI] DeepSeek error:", error.response?.data?.error?.message || error.message);
  }

  // Intento 2: Gemini
  try {
    const result = await callGemini(options);
    if (result) return { text: result, provider: "gemini" };
  } catch (error) {
    console.error("[AI] Gemini error:", error.response?.data?.error?.message || error.message);
  }

  throw new Error(
    "Ningún proveedor de IA disponible. Configurá DEEPSEEK_API_KEY o GEMINI_API_KEY en las variables de entorno."
  );
}

/**
 * Extrae JSON de una respuesta de texto que puede contener markdown u otros wrappers.
 */
export function extractJSON(text) {
  // Intentar parsear directamente
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Buscar JSON en markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (_) {}
  }

  // Buscar objeto JSON suelto
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (_) {}
  }

  return null;
}
