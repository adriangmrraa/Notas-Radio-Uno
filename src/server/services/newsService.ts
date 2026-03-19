import { chatCompletion } from "./aiService.js";
import type { NewsGenerationOptions } from "../../shared/types.js";

const TONE_PROMPTS: Record<string, string> = {
  formal:
    "Tono FORMAL: lenguaje institucional, preciso y sobrio. Oraciones estructuradas con sujeto-verbo-predicado claro. Evitar coloquialismos. Citar fuentes con nombre y cargo cuando esten disponibles.",
  informal:
    "Tono INFORMAL: lenguaje cercano y accesible sin perder rigurosidad periodistica. Permitir expresiones coloquiales argentinas ('se viene', 'pega fuerte'). Mantener datos duros pero explicarlos con naturalidad.",
  urgente:
    "Tono ULTIMO MOMENTO: maxima inmediatez. Oraciones cortas y punzantes. Arrancar con el hecho duro. Usar presente indicativo ('confirman', 'anuncian'). Transmitir la gravedad sin sensacionalismo.",
  analitico:
    "Tono ANALITICO: contextualizar cada hecho con antecedentes y consecuencias. Relacionar con tendencias mas amplias. Incluir perspectivas multiples. Usar lenguaje reflexivo ('esto implica que', 'en el marco de').",
};

const STRUCTURE_PROMPTS: Record<string, string> = {
  flash:
    "FLASH INFORMATIVO: Exactamente 2-3 oraciones. Primera oracion = hecho + protagonista + lugar. Segunda = dato complementario o consecuencia inmediata. Sin introduccion ni cierre.",
  corta:
    "NOTA CORTA: Un parrafo de 4-5 oraciones. Abrir con el hecho principal respondiendo que-quien-donde. Desarrollar con un dato de contexto. Cerrar con impacto o proyeccion.",
  completa:
    "NOTA COMPLETA: 3-4 parrafos. P1: Lead informativo (que, quien, cuando, donde, por que). P2: Desarrollo con detalles, cifras y declaraciones. P3: Contexto y antecedentes relevantes. P4 (opcional): Reacciones o proyeccion futura.",
  cronica:
    "CRONICA: 4-5 parrafos narrativos. Abrir con la escena o momento mas impactante (in medias res). Desarrollar cronologicamente incorporando voces directas entre comillas. Incluir descripciones del ambiente. Cerrar con una reflexion que conecte con el lector formoseno.",
};

const SYSTEM_PROMPT_NEWS = `Sos un periodista senior de Radio Uno Formosa, el medio de referencia de la provincia de Formosa, Argentina.

DIRECTRICES EDITORIALES:
- Escribis para una audiencia formosena y del NEA argentino
- Prioriza la relevancia local: si hay angulo formoseno, destacalo
- Usa espanol rioplatense (vos, tenes) pero sin exceso de lunfardo
- Atribui toda declaracion a su fuente ("segun X", "X afirmo que")
- Nunca inventes declaraciones ni datos que no esten en la transcripcion
- Si hay cifras, verifica que sean coherentes dentro del texto
- No uses muletillas periodisticas vacias ("cabe destacar", "es importante senalar")
- Evita adjetivos valorativos salvo en cronicas: deja que los hechos hablen
- Si la informacion es incompleta, escribi con lo que hay sin rellenar con especulacion

FORMATO:
- No incluyas encabezados, metadatos ni etiquetas
- Solo el texto de la nota, listo para publicar
- No uses markdown ni formato especial`;

const SYSTEM_PROMPT_TITLE = `Sos el editor de titulares de Radio Uno Formosa. Tu trabajo es crear titulos periodisticos que capten la atencion en redes sociales y placas informativas.

REGLAS PARA TITULARES:
- Maximo 10 palabras, idealmente 6-8
- Usar verbos en presente indicativo (confirman, anuncian, denuncian, lanzan)
- Incluir el sujeto principal (quien) y la accion (que)
- Si hay dato numerico impactante, incluirlo
- No usar signos de pregunta ni exclamacion
- No usar "ULTIMO MOMENTO" ni "URGENTE" (eso va en la placa, no en el titulo)
- Priorizar claridad sobre creatividad
- Si es local (Formosa), incluir la referencia geografica
- Solo el titulo, sin comillas ni explicacion`;

/**
 * Genera una nota periodistica con DeepSeek/Gemini.
 */
async function generateNewsCopy(
  contextOrOptions: string | NewsGenerationOptions,
  transcription?: string,
): Promise<string> {
  let options: Required<NewsGenerationOptions>;
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
    const defaults: Required<NewsGenerationOptions> = {
      tone: "formal",
      structure: "completa",
      webContext: "",
      insights: "",
      context: "",
      transcription: "",
    };
    options = { ...defaults, ...contextOrOptions };
  }

  const toneInstruction = TONE_PROMPTS[options.tone] || TONE_PROMPTS.formal;
  const structureInstruction = STRUCTURE_PROMPTS[options.structure] || STRUCTURE_PROMPTS.completa;

  let userPrompt = `${toneInstruction}

${structureInstruction}

TRANSCRIPCION DE LA TRANSMISION EN VIVO:
"""
${options.transcription}
"""`;

  if (options.insights) {
    userPrompt += `

ANALISIS EDITORIAL (insights extraidos automaticamente):
"""
${options.insights}
"""`;
  }

  if (options.webContext) {
    userPrompt += `

INFORMACION COMPLEMENTARIA DE FUENTES WEB (usar para enriquecer y contextualizar, citando la fuente):
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

Redacta la nota periodistica ahora.`;

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
  } catch (error: unknown) {
    const err = error as Error;
    console.error("[AI] Error generando nota:", err.message);
    throw new Error("Error al generar la nota: " + err.message);
  }
}

/**
 * Genera un titulo periodistico.
 */
async function generateTitle(transcription: string, insights?: string): Promise<string> {
  try {
    const { text } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT_TITLE,
      userPrompt: `Transcripcion: ${transcription.slice(0, 600)}
Insights: ${insights || ""}

Genera UN SOLO titulo:`,
      temperature: 0.6,
      maxTokens: 60,
    });

    return text.trim().replace(/^["'<<>>]|["'<<>>]$/g, "").split("\n")[0].trim();
  } catch (error: unknown) {
    const err = error as Error;
    console.error("[AI] Error generando titulo:", err.message);
    return "Ultimo Momento - Radio Uno Formosa";
  }
}

export { generateNewsCopy, generateTitle, TONE_PROMPTS, STRUCTURE_PROMPTS };
