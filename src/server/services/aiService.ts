import axios, { type AxiosError } from "axios";
import * as dotenv from "dotenv";
import { limiters } from "./rateLimiter.js";
import type { ChatCompletionOptions, ChatCompletionResult } from "../../shared/types.js";

dotenv.config();

/**
 * Servicio unificado de IA - DeepSeek (primario) + Gemini (fallback)
 *
 * DeepSeek: API compatible con OpenAI, modelos deepseek-chat (V3)
 * Gemini: Google AI Studio, modelo gemini-2.0-flash
 *
 * Ambos se invocan con la misma interfaz: sistema + usuario -> texto.
 */

const DEEPSEEK_API = "https://api.deepseek.com/chat/completions";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── DeepSeek ───

interface DeepSeekRequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  max_tokens: number;
  stream: boolean;
  response_format?: { type: string };
}

async function callDeepSeek({
  systemPrompt,
  userPrompt,
  temperature = 0.5,
  maxTokens = 1000,
  jsonMode = false,
}: ChatCompletionOptions): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const body: DeepSeekRequestBody = {
    model: "deepseek-chat",
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  await limiters.deepseek.acquire();

  const response = await axios.post(DEEPSEEK_API, body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeout: 90000,
  });

  return response.data.choices[0].message.content as string;
}

// ─── Gemini ───

interface GeminiRequestBody {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
    responseMimeType?: string;
  };
  systemInstruction?: { parts: Array<{ text: string }> };
}

async function callGemini({
  systemPrompt,
  userPrompt,
  temperature = 0.5,
  maxTokens = 1000,
  jsonMode = false,
}: ChatCompletionOptions): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = "gemini-2.0-flash";
  const url = `${GEMINI_API}/${model}:generateContent?key=${apiKey}`;

  const body: GeminiRequestBody = {
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

  await limiters.gemini.acquire();

  const response = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 90000,
  });

  return response.data.candidates[0].content.parts[0].text as string;
}

// ─── Interfaz unificada ───

/**
 * Ejecuta una completion de IA. Prueba DeepSeek primero, Gemini como fallback.
 */
export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  // Intento 1: DeepSeek
  try {
    const result = await callDeepSeek(options);
    if (result) return { text: result, provider: "deepseek" };
  } catch (error: unknown) {
    const axiosErr = error as AxiosError<{ error?: { message?: string } }>;
    console.error(
      "[AI] DeepSeek error:",
      axiosErr.response?.data?.error?.message || axiosErr.message,
    );
  }

  // Intento 2: Gemini
  try {
    const result = await callGemini(options);
    if (result) return { text: result, provider: "gemini" };
  } catch (error: unknown) {
    const axiosErr = error as AxiosError<{ error?: { message?: string } }>;
    console.error(
      "[AI] Gemini error:",
      axiosErr.response?.data?.error?.message || axiosErr.message,
    );
  }

  throw new Error(
    "Ningun proveedor de IA disponible. Configura DEEPSEEK_API_KEY o GEMINI_API_KEY en las variables de entorno.",
  );
}

/**
 * Extrae JSON de una respuesta de texto que puede contener markdown u otros wrappers.
 */
export function extractJSON(text: string): unknown {
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
