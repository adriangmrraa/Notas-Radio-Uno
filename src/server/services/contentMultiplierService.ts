/**
 * contentMultiplierService.ts — Multiplicador de contenido multiplataforma
 *
 * A partir de una nota periodística (título + contenido), genera en un solo
 * llamado a IA versiones optimizadas para Twitter/X, Instagram, LinkedIn,
 * YouTube y Newsletter.
 *
 * Los prompts pasan por promptBuilderService (choke-point T-29, kind='copy').
 */

import { chatCompletion } from "./aiSdkService.js";
import { extractJSON } from "./aiService.js";
import { build as buildPrompt } from "./promptBuilderService.js";
import type { ContentVariants } from "../../shared/types.js";

export interface CopyProfileContext {
  tenantId?: string | null;
  programId?: string | null;
}

/**
 * Genera variantes de contenido multiplataforma a partir de una nota periodística.
 * Un solo llamado a IA que devuelve el JSON con todas las variantes.
 */
export async function generateContentVariants(
  title: string,
  content: string,
  tone: string,
  profileCtx?: CopyProfileContext,
): Promise<ContentVariants> {
  const { system, user } = await buildPrompt({
    tenantId: profileCtx?.tenantId,
    programId: profileCtx?.programId,
    kind: "copy",
    context: { title, content, tone },
  });

  const { text } = await chatCompletion({
    systemPrompt: system,
    userPrompt: user,
    temperature: 0.6,
    maxTokens: 2000,
    jsonMode: true,
  });

  const parsed = extractJSON(text) as Partial<ContentVariants> | null;

  if (!parsed) {
    throw new Error("La IA no devolvió un JSON válido para las variantes de contenido");
  }

  // Validar y normalizar la respuesta
  return {
    twitterThread: Array.isArray(parsed.twitterThread) ? parsed.twitterThread : [],
    instagramCarousel: Array.isArray(parsed.instagramCarousel) ? parsed.instagramCarousel : [],
    linkedinPost: typeof parsed.linkedinPost === "string" ? parsed.linkedinPost : "",
    youtubeDescription: typeof parsed.youtubeDescription === "string" ? parsed.youtubeDescription : "",
    newsletterBlurb: typeof parsed.newsletterBlurb === "string" ? parsed.newsletterBlurb : "",
  };
}

/**
 * Regenera una variante específica de contenido con un prompt personalizado opcional.
 */
export async function regenerateVariant(
  title: string,
  content: string,
  variant: keyof ContentVariants,
  customPrompt?: string,
  profileCtx?: CopyProfileContext,
): Promise<ContentVariants[typeof variant]> {
  const variantInstructions: Record<keyof ContentVariants, string> = {
    twitterThread: "un hilo de Twitter (máximo 5 tweets, cada uno ≤280 caracteres, con emojis moderados). Devolvé JSON: { \"twitterThread\": [\"tweet1\", \"tweet2\"] }",
    instagramCarousel: "textos para un carrusel de Instagram (5-7 slides, primer slide = hook, último = CTA). Devolvé JSON: { \"instagramCarousel\": [\"slide1\", \"slide2\"] }",
    linkedinPost: "un post de LinkedIn (tono profesional, 300-500 palabras, cerrá con pregunta). Devolvé JSON: { \"linkedinPost\": \"...\" }",
    youtubeDescription: "una descripción de YouTube (incluí keywords SEO y timestamps ficticios). Devolvé JSON: { \"youtubeDescription\": \"...\" }",
    newsletterBlurb: "un blurb para newsletter (2-3 párrafos, tono cercano, CTA final). Devolvé JSON: { \"newsletterBlurb\": \"...\" }",
  };

  const customInstruction = customPrompt ? `\nInstrucción adicional del editor: "${customPrompt}"` : "";

  const { system, user } = await buildPrompt({
    tenantId: profileCtx?.tenantId,
    programId: profileCtx?.programId,
    kind: "copy",
    context: {
      title,
      content,
      variantInstruction: variantInstructions[variant],
      customInstruction,
    },
  });

  const { text } = await chatCompletion({
    systemPrompt: system,
    userPrompt: user,
    temperature: 0.7,
    maxTokens: 800,
    jsonMode: true,
  });

  const parsed = extractJSON(text) as Record<string, unknown> | null;
  if (!parsed || !(variant in parsed)) {
    throw new Error(`No se pudo regenerar la variante "${variant}"`);
  }

  return parsed[variant] as ContentVariants[typeof variant];
}
