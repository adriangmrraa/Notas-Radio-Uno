import { chatCompletion } from "./aiSdkService.js";
import type { NewsGenerationOptions } from "../../shared/types.js";
import { build as buildPrompt, TONE_PROMPTS, STRUCTURE_PROMPTS } from "./promptBuilderService.js";

// ---------------------------------------------------------------------------
// newsService — generación de nota y título periodístico.
// Los prompts NO se arman acá: todo pasa por promptBuilderService (choke-point
// T-29), que inyecta el perfil editorial efectivo (programa→tenant→default).
// ---------------------------------------------------------------------------

const PLATFORM_NAME = process.env.PLATFORM_NAME || "Noticias";

/** Opciones extra que enrutan por el prompt builder con contexto editorial. */
export interface ProfileContextOptions {
  tenantId?: string | null;
  programId?: string | null;
  persons?: string | null;
  programName?: string | null;
}

/**
 * Genera una nota periodistica con DeepSeek/Gemini.
 * El prompt (system+user) sale de promptBuilder kind='nota'.
 */
async function generateNewsCopy(
  contextOrOptions: string | (NewsGenerationOptions & ProfileContextOptions),
  transcription?: string,
): Promise<string> {
  let options: Required<NewsGenerationOptions> & ProfileContextOptions;
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

  const { system, user } = await buildPrompt({
    tenantId: options.tenantId,
    programId: options.programId,
    kind: "nota",
    context: {
      transcription: options.transcription,
      tone: options.tone,
      structure: options.structure,
      webContext: options.webContext,
      insights: options.insights,
      context: options.context,
      persons: options.persons,
      programName: options.programName,
    },
  });

  try {
    const { text } = await chatCompletion({
      systemPrompt: system,
      userPrompt: user,
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
 * El prompt (system+user) sale de promptBuilder kind='titulo'.
 */
async function generateTitle(
  transcription: string,
  insights?: string,
  profileCtx?: ProfileContextOptions,
): Promise<string> {
  try {
    const { system, user } = await buildPrompt({
      tenantId: profileCtx?.tenantId,
      programId: profileCtx?.programId,
      kind: "titulo",
      context: {
        transcription,
        insights,
        persons: profileCtx?.persons,
        programName: profileCtx?.programName,
      },
    });

    const { text } = await chatCompletion({
      systemPrompt: system,
      userPrompt: user,
      temperature: 0.6,
      maxTokens: 60,
    });

    return text.trim().replace(/^["'<<>>]|["'<<>>]$/g, "").split("\n")[0].trim();
  } catch (error: unknown) {
    const err = error as Error;
    console.error("[AI] Error generando titulo:", err.message);
    return `Ultimo Momento - ${PLATFORM_NAME}`;
  }
}

// TONE_PROMPTS / STRUCTURE_PROMPTS viven en promptBuilderService (choke-point);
// se re-exportan para compat con routes/pipeline.ts (/api/pipeline/options).
export { generateNewsCopy, generateTitle, TONE_PROMPTS, STRUCTURE_PROMPTS };
