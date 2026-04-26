/**
 * contentMultiplierService.ts — Multiplicador de contenido multiplataforma
 *
 * A partir de una nota periodística (título + contenido), genera en un solo
 * llamado a IA versiones optimizadas para Twitter/X, Instagram, LinkedIn,
 * YouTube y Newsletter.
 */

import { chatCompletion, extractJSON } from "./aiSdkService.js";
import type { ContentVariants } from "../../shared/types.js";

const SYSTEM_PROMPT = `Sos un experto en contenido multiplataforma para medios de comunicación.
Tu trabajo es transformar notas periodísticas en piezas optimizadas para cada red social.
Siempre respondés con JSON válido, sin texto extra, sin markdown.`;

/**
 * Genera variantes de contenido multiplataforma a partir de una nota periodística.
 * Un solo llamado a IA que devuelve el JSON con todas las variantes.
 */
export async function generateContentVariants(
  title: string,
  content: string,
  tone: string,
): Promise<ContentVariants> {
  const userPrompt = `A partir de esta nota periodística, generá versiones optimizadas para cada plataforma.

Título: ${title}
Nota: ${content}
Tono: ${tone}

Generá un JSON con exactamente esta estructura:
{
  "twitterThread": ["tweet 1 (max 280 chars)", "tweet 2", "tweet 3"],
  "instagramCarousel": ["Slide 1 texto", "Slide 2", "Slide 3", "Slide 4", "Slide 5"],
  "linkedinPost": "Post completo para LinkedIn (profesional, 300-500 palabras)",
  "youtubeDescription": "Descripción para YouTube con timestamps y keywords SEO",
  "newsletterBlurb": "Resumen para newsletter (2-3 párrafos, enganche + link)"
}

Reglas estrictas:
- Twitter: máximo 5 tweets, cada uno ≤280 caracteres, usá emojis moderadamente, primer tweet debe enganchar
- Instagram: 5-7 slides, texto conciso por slide, primer slide = hook, último slide = CTA
- LinkedIn: tono profesional, incluí datos duros, cerrá con pregunta para engagement
- YouTube: incluí keywords SEO, estructura con timestamps ficticios (ej: 0:00, 1:30, etc.)
- Newsletter: tono cercano, como si le escribieras a un suscriptor, cerrá con call to action
- Todo en español rioplatense
- Solo el JSON, sin texto adicional`;

  const { text } = await chatCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
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
): Promise<ContentVariants[typeof variant]> {
  const variantInstructions: Record<keyof ContentVariants, string> = {
    twitterThread: "un hilo de Twitter (máximo 5 tweets, cada uno ≤280 caracteres, con emojis moderados). Devolvé JSON: { \"twitterThread\": [\"tweet1\", \"tweet2\"] }",
    instagramCarousel: "textos para un carrusel de Instagram (5-7 slides, primer slide = hook, último = CTA). Devolvé JSON: { \"instagramCarousel\": [\"slide1\", \"slide2\"] }",
    linkedinPost: "un post de LinkedIn (tono profesional, 300-500 palabras, cerrá con pregunta). Devolvé JSON: { \"linkedinPost\": \"...\" }",
    youtubeDescription: "una descripción de YouTube (incluí keywords SEO y timestamps ficticios). Devolvé JSON: { \"youtubeDescription\": \"...\" }",
    newsletterBlurb: "un blurb para newsletter (2-3 párrafos, tono cercano, CTA final). Devolvé JSON: { \"newsletterBlurb\": \"...\" }",
  };

  const customInstruction = customPrompt ? `\nInstrucción adicional del editor: "${customPrompt}"` : "";

  const userPrompt = `Tenés esta nota periodística:

Título: ${title}
Nota: ${content}

Generá ${variantInstructions[variant]}${customInstruction}

Solo el JSON, sin texto adicional.`;

  const { text } = await chatCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
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
