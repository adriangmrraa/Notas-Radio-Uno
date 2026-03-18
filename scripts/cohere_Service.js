import { CohereClient } from "cohere-ai";
import * as dotenv from "dotenv";
dotenv.config();

const TONE_PROMPTS = {
  formal:
    "Usa un tono formal, profesional y objetivo. Lenguaje periodístico serio.",
  informal:
    "Usa un tono cercano y conversacional, pero manteniendo la seriedad informativa.",
  urgente:
    "Usa un tono de ÚLTIMO MOMENTO / URGENTE. Frases cortas, impactantes, que transmitan inmediatez.",
  analitico:
    "Usa un tono analítico y reflexivo. Contextualiza los hechos, ofrece perspectiva y explica causas y consecuencias.",
};

const STRUCTURE_PROMPTS = {
  flash:
    "Estructura: Flash informativo. Máximo 3 oraciones directas con lo esencial del hecho. Sin introducción, directo al punto.",
  corta:
    "Estructura: Nota corta. Un párrafo de 4-5 oraciones. Abre con el hecho principal, desarrolla brevemente, cierra con un dato de contexto.",
  completa:
    "Estructura: Nota completa. 3-4 párrafos. Primer párrafo: hecho principal (qué, quién, cuándo, dónde). Segundo párrafo: detalles y contexto. Tercer párrafo: reacciones o impacto. Cuarto párrafo (opcional): antecedentes.",
  cronica:
    "Estructura: Crónica periodística. 4-5 párrafos narrativos. Comienza describiendo la escena, desarrolla la historia cronológicamente, incluye voces y citas, cierra con reflexión o proyección.",
};

/**
 * Genera una nota periodística personalizable.
 *
 * @param {Object} options
 * @param {string} options.transcription - Transcripción fuente
 * @param {string} options.context - Contexto adicional del usuario
 * @param {string} options.tone - Tono: "formal", "informal", "urgente", "analitico"
 * @param {string} options.structure - Estructura: "flash", "corta", "completa", "cronica"
 * @param {string} options.webContext - Información de búsqueda web para enriquecer
 * @param {string} options.insights - Insights extraídos (summary, keyFacts)
 */
async function generateNewsCopy(contextOrOptions, transcription) {
  const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
  });

  // Soportar firma vieja (context, transcription) y nueva (options)
  let options;
  if (typeof contextOrOptions === "string") {
    options = {
      context: contextOrOptions,
      transcription: transcription || "",
      tone: "formal",
      structure: "completa",
      webContext: "",
      insights: "",
    };
  } else {
    options = {
      tone: "formal",
      structure: "completa",
      webContext: "",
      insights: "",
      context: "",
      transcription: "",
      ...contextOrOptions,
    };
  }

  const toneInstruction = TONE_PROMPTS[options.tone] || TONE_PROMPTS.formal;
  const structureInstruction =
    STRUCTURE_PROMPTS[options.structure] || STRUCTURE_PROMPTS.completa;

  let prompt = `Eres un periodista de Radio Uno Formosa. Genera una nota periodística basándote en la información proporcionada.

TONO: ${toneInstruction}

ESTRUCTURA: ${structureInstruction}

TRANSCRIPCIÓN DE LA TRANSMISIÓN:
"""
${options.transcription}
"""`;

  if (options.insights) {
    prompt += `

ANÁLISIS E INSIGHTS:
"""
${options.insights}
"""`;
  }

  if (options.webContext) {
    prompt += `

INFORMACIÓN COMPLEMENTARIA DE INTERNET:
"""
${options.webContext}
"""`;
  }

  if (options.context) {
    prompt += `

CONTEXTO ADICIONAL:
"""
${options.context}
"""`;
  }

  prompt += `

Genera la nota periodística ahora. Solo el texto de la nota, sin encabezados ni metadatos.`;

  try {
    const response = await cohere.generate({
      prompt,
      model: "command-nightly",
      max_tokens: 1000,
      temperature: options.tone === "urgente" ? 0.4 : 0.5,
      k: 0,
      stop_sequences: [],
      return_likelihoods: "NONE",
    });

    const generatedText = response.generations[0].text.trim();
    console.log("Nota generada:", generatedText.slice(0, 100) + "...");
    return generatedText;
  } catch (error) {
    console.error("Error al generar la nota con Cohere:", error);
    throw new Error("Error al generar la nota con Cohere: " + error.message);
  }
}

/**
 * Genera un título atractivo para la nota y el flyer.
 */
async function generateTitle(transcription, insights) {
  const cohere = new CohereClient({
    token: process.env.COHERE_API_KEY,
  });

  const prompt = `A partir de esta transcripción e insights, genera UN SOLO título periodístico impactante y conciso (máximo 10 palabras). Solo el título, sin comillas ni explicación.

Transcripción: ${transcription.slice(0, 500)}
Insights: ${insights || ""}

Título:`;

  try {
    const response = await cohere.generate({
      prompt,
      model: "command-nightly",
      max_tokens: 50,
      temperature: 0.6,
      k: 0,
      stop_sequences: ["\n"],
      return_likelihoods: "NONE",
    });

    return response.generations[0].text.trim().replace(/^["']|["']$/g, "");
  } catch (error) {
    console.error("Error generando título:", error);
    return "Último momento - Radio Uno Formosa";
  }
}

export { generateNewsCopy, generateTitle, TONE_PROMPTS, STRUCTURE_PROMPTS };
