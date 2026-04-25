import axios from "axios";
import * as cheerio from "cheerio";
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

interface ScrapedArticle {
  title: string;
  content: string;
  imageUrl: string | undefined;
  datePublished: string | undefined;
}

/**
 * Scrapes a news article from ANY portal.
 * Step 1: Fetch HTML + extract with cheerio (og:image, basic text)
 * Step 2: Use AI to extract clean title + content from raw text (no ads, no nav, no junk)
 */
async function scrapeElComercialArticle(url: string): Promise<ScrapedArticle> {
  try {
    // Step 1: Fetch and parse HTML
    const response = await axios.get<string>(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
      timeout: 15000,
    });
    const html = response.data;
    const $ = cheerio.load(html);

    // Remove noise before extracting text
    $("script, style, nav, footer, header, aside, .ad, .ads, .advertisement, .sidebar, .menu, .nav, .comments, .related, .social-share, .share-buttons, iframe, noscript").remove();

    // Extract metadata (reliable across sites)
    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() || "";
    const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() || "";
    const ogImage = $('meta[property="og:image"]').attr("content")?.trim() || "";
    const twitterImage = $('meta[name="twitter:image"]').attr("content")?.trim() || "";
    const h1 = $("h1").first().text().trim() || "";
    const datePublished =
      $('meta[property="article:published_time"]').attr("content") ||
      $('meta[itemprop="datePublished"]').attr("content") ||
      $("time[datetime]").first().attr("datetime") ||
      undefined;

    // Image: og:image is the most reliable across all portals
    const imageUrl = ogImage || twitterImage || $("article img").first().attr("src") || undefined;

    // Extract raw article text for AI processing
    const rawText = (
      $("article").text() ||
      $('[itemprop="articleBody"]').text() ||
      $(".article-body, .story-body, .entry-content, .post-content, .nota-cuerpo, .body-nota, .cuerpo-nota, main").text() ||
      $("body").text()
    ).replace(/\s+/g, " ").trim();

    // Step 2: Use AI to extract clean title + content
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && rawText.length > 100) {
      try {
        const google = createGoogleGenerativeAI({ apiKey });
        const { text: aiResult } = await generateText({
          model: google("gemini-2.0-flash"),
          prompt: `Sos un extractor de noticias. De este texto crudo de una página web, extraé SOLAMENTE el contenido periodístico.

CONTEXTO:
- URL: ${url}
- Título detectado: ${ogTitle || h1}
- Descripción OG: ${ogDesc}

TEXTO CRUDO DE LA PÁGINA:
${rawText.slice(0, 8000)}

RESPONDÉ en formato JSON estricto (sin markdown, sin backticks):
{"title": "título limpio de la nota", "content": "contenido completo de la nota periodística, solo el cuerpo, sin anuncios ni navegación ni textos laterales. Máximo 3 párrafos."}`,
          maxOutputTokens: 1000,
        });

        // Parse AI response
        const cleaned = aiResult.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const parsed = JSON.parse(cleaned) as { title: string; content: string };

        console.log(`[Scraper] AI extraction OK: "${parsed.title.slice(0, 50)}..." (${parsed.content.length} chars)`);

        return {
          title: parsed.title || ogTitle || h1,
          content: parsed.content || ogDesc,
          imageUrl,
          datePublished,
        };
      } catch (aiError) {
        console.error("[Scraper] AI extraction failed, falling back to meta tags:", aiError);
      }
    }

    // Fallback: use meta tags only (no AI)
    const title = ogTitle || h1 || $("title").text().trim();
    const content = ogDesc || rawText.slice(0, 500);

    if (!title) {
      throw new Error(`No se pudo extraer el título de: ${url}`);
    }

    console.log(`[Scraper] Fallback extraction: "${title.slice(0, 50)}..." (${content.length} chars)`);

    return { title, content, imageUrl, datePublished };
  } catch (error) {
    console.error("Error al raspar el artículo:", error);
    throw error;
  }
}

export { scrapeElComercialArticle };
export type { ScrapedArticle };
