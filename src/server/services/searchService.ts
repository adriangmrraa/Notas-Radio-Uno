import axios, { type AxiosError } from "axios";
import * as cheerio from "cheerio";
import * as dotenv from "dotenv";
import { limiters } from "./rateLimiter.js";
import type { SearchResult, ScrapedArticle } from "../../shared/types.js";

dotenv.config();

/**
 * Servicio de investigacion web.
 *
 * Estrategia en orden de prioridad:
 *   1. Gemini con Google Search Grounding (IA + busqueda web integrada)
 *   2. Google Custom Search API + scraping de articulos
 *   3. DuckDuckGo HTML scraping + scraping de articulos
 *
 * La estrategia 1 es superior porque Gemini:
 *   - Busca, lee y sintetiza los resultados automaticamente
 *   - Devuelve fuentes citadas con URLs
 *   - Filtra informacion relevante del ruido
 *   - Entiende el contexto periodistico de la busqueda
 */

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Estrategia 1: Gemini Grounded Search ───

interface GeminiGroundedRequestBody {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  tools: Array<{ google_search: Record<string, never> }>;
  generationConfig: {
    temperature: number;
    maxOutputTokens: number;
  };
}

interface GeminiGroundingChunk {
  web?: {
    uri?: string;
    title?: string;
  };
}

interface GeminiCandidate {
  content?: {
    parts?: Array<{ text?: string }>;
  };
  groundingMetadata?: {
    groundingChunks?: GeminiGroundingChunk[];
    searchEntryPoint?: unknown;
  };
}

interface GeminiParsedResult {
  title?: string;
  source_name?: string;
  relevance?: string;
  source_url?: string;
  content?: string;
}

/**
 * Usa Gemini con Google Search grounding para investigar un tema.
 * Gemini busca en la web, lee los resultados y sintetiza la informacion.
 */
async function geminiGroundedSearch(queries: string[]): Promise<SearchResult[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const searchPrompt = `Sos un investigador periodistico de Radio Uno Formosa. Necesitas buscar informacion actualizada sobre los siguientes temas para enriquecer notas periodisticas.

BUSQUEDAS A REALIZAR:
${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

INSTRUCCIONES:
- Busca informacion verificable y actual sobre cada tema
- Prioriza fuentes periodisticas serias (agencias de noticias, diarios nacionales, medios oficiales)
- Extrae datos concretos: cifras, declaraciones textuales, fechas, decisiones oficiales
- Si hay informacion relevante para Formosa o el NEA argentino, priorizala
- Inclui las URLs de las fuentes

Responde en JSON con esta estructura:
{
  "results": [
    {
      "title": "Titulo del hallazgo o articulo",
      "content": "Resumen de 2-3 parrafos con los datos clave encontrados. Incluir cifras, declaraciones y datos verificables.",
      "source_url": "URL de la fuente principal",
      "source_name": "Nombre del medio",
      "relevance": "Por que es relevante para la nota"
    }
  ],
  "summary": "Sintesis general de lo encontrado en 2-3 oraciones"
}`;

  try {
    const model = "gemini-2.0-flash";
    const url = `${GEMINI_API}/${model}:generateContent?key=${apiKey}`;

    const body: GeminiGroundedRequestBody = {
      contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2000,
      },
    };

    await limiters.gemini.acquire();

    const response = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });

    const candidate: GeminiCandidate | undefined = response.data.candidates?.[0];
    if (!candidate) return null;

    // Extraer texto de la respuesta
    const textParts = candidate.content?.parts?.filter((p) => p.text) || [];
    const fullText = textParts.map((p) => p.text).join("\n");

    // Extraer grounding metadata (fuentes citadas por Google Search)
    const groundingMeta = candidate.groundingMetadata;
    const groundingChunks: GeminiGroundingChunk[] = groundingMeta?.groundingChunks || [];

    // Intentar parsear JSON de la respuesta
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    let parsedResults: SearchResult[] = [];

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { results?: GeminiParsedResult[] };
        parsedResults = (parsed.results || []).map((r) => ({
          title: r.title || r.source_name || "",
          snippet: r.relevance || "",
          url: r.source_url || "",
          content: r.content || "",
          scrapedTitle: r.title || "",
          scrapedImage: "",
        }));
      } catch (_) {
        // no-op
      }
    }

    // Si no parseo JSON, crear resultado del texto completo
    if (parsedResults.length === 0 && fullText.length > 50) {
      parsedResults = [
        {
          title: "Investigacion Gemini",
          snippet: "Resultados de busqueda web con IA",
          url: "",
          content: fullText.slice(0, 1500),
          scrapedTitle: "Investigacion Gemini",
          scrapedImage: "",
        },
      ];
    }

    // Enriquecer con URLs de grounding chunks de Google
    for (let i = 0; i < groundingChunks.length && i < parsedResults.length; i++) {
      const chunk = groundingChunks[i];
      if (chunk.web?.uri && !parsedResults[i].url) {
        parsedResults[i].url = chunk.web.uri;
        parsedResults[i].scrapedTitle = chunk.web.title || parsedResults[i].scrapedTitle;
      }
    }

    // Si hay grounding chunks adicionales no mapeados, agregarlos
    for (let i = parsedResults.length; i < groundingChunks.length && i < 6; i++) {
      const chunk = groundingChunks[i];
      if (chunk.web?.uri) {
        parsedResults.push({
          title: chunk.web.title || "",
          snippet: "",
          url: chunk.web.uri,
          content: "",
          scrapedTitle: chunk.web.title || "",
          scrapedImage: "",
        });
      }
    }

    console.log(`[Search] Gemini grounded search: ${parsedResults.length} resultados`);
    return parsedResults;
  } catch (error: unknown) {
    const axiosErr = error as AxiosError<{ error?: { message?: string } }>;
    console.error(
      "[Search] Error en Gemini grounded search:",
      axiosErr.response?.data?.error?.message || axiosErr.message,
    );
    return null;
  }
}

// ─── Estrategia 2: Google Custom Search API ───

async function googleCustomSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    await limiters.webSearch.acquire();
    const response = await axios.get("https://www.googleapis.com/customsearch/v1", {
      params: {
        key: process.env.GOOGLE_SEARCH_API_KEY,
        cx: process.env.GOOGLE_SEARCH_CX,
        q: query,
        num: maxResults,
        lr: "lang_es",
      },
    });

    return (response.data.items || []).map(
      (item: { title: string; snippet: string; link: string }) => ({
        title: item.title,
        snippet: item.snippet,
        url: item.link,
        content: "",
      }),
    );
  } catch (error: unknown) {
    const err = error as Error;
    console.error("[Search] Error en Google Custom Search:", err.message);
    return [];
  }
}

// ─── Estrategia 3: DuckDuckGo HTML Scraping ───

async function duckDuckGoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    await limiters.webSearch.acquire();
    const response = await axios.get("https://html.duckduckgo.com/html/", {
      params: { q: query },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data as string);
    const results: SearchResult[] = [];

    $(".result").each((i, el) => {
      if (i >= maxResults) return false;
      const title = $(el).find(".result__title").text().trim();
      const snippet = $(el).find(".result__snippet").text().trim();
      const url = $(el).find(".result__url").attr("href") || "";

      if (title) {
        results.push({ title, snippet, url, content: "" });
      }
    });

    return results;
  } catch (error: unknown) {
    const err = error as Error;
    console.error("[Search] Error en DuckDuckGo:", err.message);
    return [];
  }
}

// ─── Busqueda generica ───

async function searchWeb(query: string, maxResults: number = 3): Promise<SearchResult[]> {
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    return await googleCustomSearch(query, maxResults);
  }
  return await duckDuckGoSearch(query, maxResults);
}

// ─── Scraping de articulos ───

async function scrapeArticleContent(url: string): Promise<ScrapedArticle> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const $ = cheerio.load(response.data as string);
    $("script, style, nav, footer, header, aside").remove();

    const title = $("h1").first().text().trim() || $("title").text().trim();

    const paragraphs: string[] = [];
    $(
      "article p, .content p, .entry-content p, main p, .post p, .article-body p, .main-text p",
    ).each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 40) paragraphs.push(text);
    });

    if (paragraphs.length === 0) {
      $("p").each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) paragraphs.push(text);
      });
    }

    const imageUrl =
      $('meta[property="og:image"]').attr("content") ||
      $("article img").first().attr("src") ||
      $(".content img").first().attr("src") ||
      "";

    return {
      title,
      content: paragraphs.slice(0, 10).join("\n\n"),
      imageUrl,
      url,
    };
  } catch (error: unknown) {
    const err = error as Error;
    console.error(`[Search] Error scrapeando ${url}:`, err.message);
    return { title: "", content: "", imageUrl: "", url };
  }
}

// ─── Funcion principal de research ───

/**
 * Investiga temas usando la mejor estrategia disponible.
 * Prioridad: Gemini Grounded Search > Google Custom Search + scraping > DuckDuckGo + scraping
 */
async function searchAndEnrich(searchQueries: string[]): Promise<SearchResult[]> {
  // ─── Estrategia 1: Gemini Grounded Search (superior) ───
  // Gemini busca, lee y sintetiza en un solo paso
  const geminiResults = await geminiGroundedSearch(searchQueries);
  if (geminiResults && geminiResults.length > 0) {
    return geminiResults;
  }

  // ─── Fallback: busqueda tradicional + scraping ───
  console.log("[Search] Gemini no disponible, usando busqueda tradicional...");
  const allResults: SearchResult[] = [];

  for (const query of searchQueries.slice(0, 3)) {
    const results = await searchWeb(query, 2);

    for (const result of results) {
      if (result.url && result.url.startsWith("http")) {
        const article = await scrapeArticleContent(result.url);
        if (article.content) {
          allResults.push({
            ...result,
            content: article.content.slice(0, 500),
            scrapedTitle: article.title,
            scrapedImage: article.imageUrl,
          });
        }
      }
    }
  }

  return allResults;
}

export {
  geminiGroundedSearch,
  googleCustomSearch,
  duckDuckGoSearch,
  searchWeb,
  scrapeArticleContent,
  searchAndEnrich,
};
