/**
 * contentMultiplierService.ts — Multiplicador de contenido multiplataforma
 *
 * A partir de una nota periodística (título + contenido), genera en un solo
 * llamado a IA versiones optimizadas para Twitter/X, Instagram, LinkedIn,
 * YouTube y Newsletter.
 *
 * PC-06: si el canal tiene línea editorial, `editorial.block` se inyecta en
 * el prompt (directriz principal) y `editorial.activeFormats` filtra qué
 * variantes se generan — las no activas se devuelven vacías y el prompt
 * sólo pide los formatos activos. Sin perfil ⇒ todos los formatos, como
 * siempre.
 */

import { chatCompletion } from "./aiSdkService.js";
import { extractJSON } from "./aiService.js";
import { activeVariantKeys } from "./editorialPromptService.js";
import type { EditorialGenerationContext } from "./editorialPromptService.js";
import type { AiUsageContext, ContentVariants } from "../../shared/types.js";

const SYSTEM_PROMPT = `Sos un experto en contenido multiplataforma para medios de comunicación.
Tu trabajo es transformar notas periodísticas en piezas optimizadas para cada red social.
Siempre respondés con JSON válido, sin texto extra, sin markdown.`;

// Spec por variante: ejemplo de campo en el JSON pedido + regla de estilo.
const VARIANT_SPEC: Record<keyof ContentVariants, { example: string; rule: string }> = {
  twitterThread: {
    example: '"twitterThread": ["tweet 1 (max 280 chars)", "tweet 2", "tweet 3"]',
    rule: '- Twitter: máximo 5 tweets, cada uno ≤280 caracteres, usá emojis moderadamente, primer tweet debe enganchar',
  },
  instagramCarousel: {
    example: '"instagramCarousel": ["Slide 1 texto", "Slide 2", "Slide 3", "Slide 4", "Slide 5"]',
    rule: '- Instagram: 5-7 slides, texto conciso por slide, primer slide = hook, último slide = CTA',
  },
  linkedinPost: {
    example: '"linkedinPost": "Post completo para LinkedIn (profesional, 300-500 palabras)"',
    rule: '- LinkedIn: tono profesional, incluí datos duros, cerrá con pregunta para engagement',
  },
  youtubeDescription: {
    example: '"youtubeDescription": "Descripción para YouTube con timestamps y keywords SEO"',
    rule: '- YouTube: incluí keywords SEO, estructura con timestamps ficticios (ej: 0:00, 1:30, etc.)',
  },
  newsletterBlurb: {
    example: '"newsletterBlurb": "Resumen para newsletter (2-3 párrafos, enganche + link)"',
    rule: '- Newsletter: tono cercano, como si le escribieras a un suscriptor, cerrá con call to action',
  },
};

/**
 * Genera variantes de contenido multiplataforma a partir de una nota periodística.
 * Un solo llamado a IA que devuelve el JSON con todas las variantes.
 *
 * `editorial` (opcional, PC-06): contexto de la línea editorial efectiva —
 * `block` se inyecta como directriz principal y `activeFormats` decide qué
 * variantes se piden. Las variantes no activas se devuelven vacías.
 */
export async function generateContentVariants(
  title: string,
  content: string,
  tone: string,
  editorial?: EditorialGenerationContext,
  usageCtx?: AiUsageContext,
): Promise<ContentVariants> {
  const requestedKeys = activeVariantKeys(editorial?.activeFormats);
  const exampleJson = `{\n  ${requestedKeys.map((k) => VARIANT_SPEC[k].example).join(",\n  ")}\n}`;
  const variantRules = requestedKeys.map((k) => VARIANT_SPEC[k].rule).join("\n");
  const editorialSection = editorial?.block?.trim() ? `\n\n${editorial.block.trim()}` : "";

  const userPrompt = `A partir de esta nota periodística, generá versiones optimizadas para cada plataforma.

Título: ${title}
Nota: ${content}
Tono: ${tone}${editorialSection}

Generá un JSON con exactamente esta estructura (SOLO estos formatos, son los activos del canal):
${exampleJson}

Reglas estrictas:
${variantRules}
- Todo en español rioplatense
- Solo el JSON, sin texto adicional`;

  const { text } = await chatCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.6,
    maxTokens: 2000,
    jsonMode: true,
    usageContext: usageCtx,
  });

  const parsed = extractJSON(text) as Partial<ContentVariants> | null;

  if (!parsed) {
    throw new Error("La IA no devolvió un JSON válido para las variantes de contenido");
  }

  // Normalizar: sólo los formatos activos toman el valor parseado; el resto
  // queda vacío (el shape fijo de ContentVariants no cambia).
  return {
    twitterThread:
      requestedKeys.includes("twitterThread") && Array.isArray(parsed.twitterThread)
        ? parsed.twitterThread
        : [],
    instagramCarousel:
      requestedKeys.includes("instagramCarousel") && Array.isArray(parsed.instagramCarousel)
        ? parsed.instagramCarousel
        : [],
    linkedinPost:
      requestedKeys.includes("linkedinPost") && typeof parsed.linkedinPost === "string"
        ? parsed.linkedinPost
        : "",
    youtubeDescription:
      requestedKeys.includes("youtubeDescription") && typeof parsed.youtubeDescription === "string"
        ? parsed.youtubeDescription
        : "",
    newsletterBlurb:
      requestedKeys.includes("newsletterBlurb") && typeof parsed.newsletterBlurb === "string"
        ? parsed.newsletterBlurb
        : "",
  };
}

/**
 * Regenera una variante específica de contenido con un prompt personalizado opcional.
 * `editorialBlock` (opcional, PC-06): la línea editorial también gobierna la
 * regeneración (estilo, reglas, firma). No filtra por activeFormats: pedir
 * una variante puntual es una acción explícita del editor.
 */
export async function regenerateVariant(
  title: string,
  content: string,
  variant: keyof ContentVariants,
  customPrompt?: string,
  editorialBlock?: string,
  usageCtx?: AiUsageContext,
): Promise<ContentVariants[typeof variant]> {
  const variantInstructions: Record<keyof ContentVariants, string> = {
    twitterThread: "un hilo de Twitter (máximo 5 tweets, cada uno ≤280 caracteres, con emojis moderados). Devolvé JSON: { \"twitterThread\": [\"tweet1\", \"tweet2\"] }",
    instagramCarousel: "textos para un carrusel de Instagram (5-7 slides, primer slide = hook, último = CTA). Devolvé JSON: { \"instagramCarousel\": [\"slide1\", \"slide2\"] }",
    linkedinPost: "un post de LinkedIn (tono profesional, 300-500 palabras, cerrá con pregunta). Devolvé JSON: { \"linkedinPost\": \"...\" }",
    youtubeDescription: "una descripción de YouTube (incluí keywords SEO y timestamps ficticios). Devolvé JSON: { \"youtubeDescription\": \"...\" }",
    newsletterBlurb: "un blurb para newsletter (2-3 párrafos, tono cercano, CTA final). Devolvé JSON: { \"newsletterBlurb\": \"...\" }",
  };

  const customInstruction = customPrompt ? `\nInstrucción adicional del editor: "${customPrompt}"` : "";
  const editorialSection = editorialBlock?.trim() ? `\n\n${editorialBlock.trim()}` : "";

  const userPrompt = `Tenés esta nota periodística:

Título: ${title}
Nota: ${content}${editorialSection}

Generá ${variantInstructions[variant]}${customInstruction}

Solo el JSON, sin texto adicional.`;

  const { text } = await chatCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.7,
    maxTokens: 800,
    jsonMode: true,
    usageContext: usageCtx,
  });

  const parsed = extractJSON(text) as Record<string, unknown> | null;
  if (!parsed || !(variant in parsed)) {
    throw new Error(`No se pudo regenerar la variante "${variant}"`);
  }

  return parsed[variant] as ContentVariants[typeof variant];
}
