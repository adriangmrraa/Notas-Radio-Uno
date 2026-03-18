import { chatCompletion } from "./aiService.js";
import * as dotenv from "dotenv";
dotenv.config();

const TONE_PROMPTS = {
  formal:
    "Tono FORMAL: lenguaje institucional, preciso y sobrio. Oraciones estructuradas con sujeto-verbo-predicado claro. Evitar coloquialismos. Citar fuentes con nombre y cargo cuando estén disponibles.",
  informal:
    "Tono INFORMAL: lenguaje cercano y accesible sin perder rigurosidad periodística. Permitir expresiones coloquiales argentinas ('se viene', 'pega fuerte'). Mantener datos duros pero explicarlos con naturalidad.",
  urgente:
    "Tono ÚLTIMO MOMENTO: máxima inmediatez. Oraciones cortas y punzantes. Arrancar con el hecho duro. Usar presente indicativo ('confirman', 'anuncian'). Transmitir la gravedad sin sensacionalismo.",
  analitico:
    "Tono ANALÍTICO: contextualizar cada hecho con antecedentes y consecuencias. Relacionar con tendencias más amplias. Incluir perspectivas múltiples. Usar lenguaje reflexivo ('esto implica que', 'en el marco de').",
};

const STRUCTURE_PROMPTS = {
  flash:
    "FLASH INFORMATIVO: Exactamente 2-3 oraciones. Primera oración = hecho + protagonista + lugar. Segunda = dato complementario o consecuencia inmediata. Sin introducción ni cierre.",
  corta:
    "NOTA CORTA: Un párrafo de 4-5 oraciones. Abrir con el hecho principal respondiendo qué-quién-dónde. Desarrollar con un dato de contexto. Cerrar con impacto o proyección.",
  completa:
    "NOTA COMPLETA: 3-4 párrafos. P1: Lead informativo (qué, quién, cuándo, dónde, por qué). P2: Desarrollo con detalles, cifras y declaraciones. P3: Contexto y antecedentes relevantes. P4 (opcional): Reacciones o proyección futura.",
  cronica:
    "CRÓNICA: 4-5 párrafos narrativos. Abrir con la escena o momento más impactante (in medias res). Desarrollar cronológicamente incorporando voces directas entre comillas. Incluir descripciones del ambiente. Cerrar con una reflexión que conecte con el lector formoseño.",
};

const SYSTEM_PROMPT_NEWS = `Sos un periodista senior de Radio Uno Formosa, el medio de referencia de la provincia de Formosa, Argentina.

DIRECTRICES EDITORIALES:
- Escribís para una audiencia formoseña y del NEA argentino
- Priorizá la relevancia local: si hay ángulo formoseño, destacalo
- Usá español rioplatense (vos, tenés) pero sin exceso de lunfardo
- Atribuí toda declaración a su fuente ("según X", "X afirmó que")
- Nunca inventés declaraciones ni datos que no estén en la transcripción
- Si hay cifras, verificá que sean coherentes dentro del texto
- No uses muletillas periodísticas vacías ("cabe destacar", "es importante señalar")
- Evitá adjetivos valorativos salvo en crónicas: dejá que los hechos hablen
- Si la información es incompleta, escribí con lo que hay sin rellenar con especulación

FORMATO:
- No incluyas encabezados, metadatos ni etiquetas
- Solo el texto de la nota, listo para publicar
- No uses markdown ni formato especial`;

const SYSTEM_PROMPT_TITLE = `Sos el editor de titulares de Radio Uno Formosa. Tu trabajo es crear títulos periodísticos que capten la atención en redes sociales y placas informativas.

REGLAS PARA TITULARES:
- Máximo 10 palabras, idealmente 6-8
- Usar verbos en presente indicativo (confirman, anuncian, denuncian, lanzan)
- Incluir el sujeto principal (quién) y la acción (qué)
- Si hay dato numérico impactante, incluirlo
- No usar signos de pregunta ni exclamación
- No usar "ÚLTIMO MOMENTO" ni "URGENTE" (eso va en la placa, no en el título)
- Priorizar claridad sobre creatividad
- Si es local (Formosa), incluir la referencia geográfica
- Solo el título, sin comillas ni explicación`;

/**
 * Genera una nota periodística con DeepSeek/Gemini.
 */
async function generateNewsCopy(contextOrOptions, transcription) {
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
  const structureInstruction = STRUCTURE_PROMPTS[options.structure] || STRUCTURE_PROMPTS.completa;

  let userPrompt = `${toneInstruction}

${structureInstruction}

TRANSCRIPCIÓN DE LA TRANSMISIÓN EN VIVO:
"""
${options.transcription}
"""`;

  if (options.insights) {
    userPrompt += `

ANÁLISIS EDITORIAL (insights extraídos automáticamente):
"""
${options.insights}
"""`;
  }

  if (options.webContext) {
    userPrompt += `

INFORMACIÓN COMPLEMENTARIA DE FUENTES WEB (usar para enriquecer y contextualizar, citando la fuente):
"""
${options.webContext}
"""`;
  }

  if (options.context) {
    userPrompt += `

CONTEXTO ADICIONAL DEL EDITOR:
"""
${options.context}
"""`;
  }

  userPrompt += `

Redactá la nota periodística ahora.`;

  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT_NEWS,
      userPrompt,
      temperature: options.tone === "urgente" ? 0.3 : 0.5,
      maxTokens: 1200,
    });

    const generatedText = text.trim();
    console.log("[AI] Nota generada:", generatedText.slice(0, 100) + "...");
    return generatedText;
  } catch (error) {
    console.error("[AI] Error generando nota:", error.message);
    throw new Error("Error al generar la nota: " + error.message);
  }
}

/**
 * Genera un título periodístico.
 */
async function generateTitle(transcription, insights) {
  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT_TITLE,
      userPrompt: `Transcripción: ${transcription.slice(0, 600)}
Insights: ${insights || ""}

Generá UN SOLO título:`,
      temperature: 0.6,
      maxTokens: 60,
    });

    return text.trim().replace(/^["'«»]|["'«»]$/g, "").split("\n")[0].trim();
  } catch (error) {
    console.error("[AI] Error generando título:", error.message);
    return "Último Momento - Radio Uno Formosa";
  }
}

export { generateNewsCopy, generateTitle, TONE_PROMPTS, STRUCTURE_PROMPTS };
