import axios from "axios";
import * as cheerio from "cheerio";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Servicio de investigación web.
 *
 * Estrategia en orden de prioridad:
 *   1. Gemini con Google Search Grounding (IA + búsqueda web integrada)
 *   2. Google Custom Search API + scraping de artículos
 *   3. DuckDuckGo HTML scraping + scraping de artículos
 *
 * La estrategia 1 es superior porque Gemini:
 *   - Busca, lee y sintetiza los resultados automáticamente
 *   - Devuelve fuentes citadas con URLs
 *   - Filtra información relevante del ruido
 *   - Entiende el contexto periodístico de la búsqueda
 */

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Estrategia 1: Gemini Grounded Search ───

/**
 * Usa Gemini con Google Search grounding para investigar un tema.
 * Gemini busca en la web, lee los resultados y sintetiza la información.
 *
 * @param {string[]} queries - Búsquedas a realizar
 * @returns {Array<{ title, snippet, url, content, scrapedTitle, scrapedImage }>}
 */
async function geminiGroundedSearch(queries) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const searchPrompt = `Sos un investigador periodístico de Radio Uno Formosa. Necesitás buscar información actualizada sobre los siguientes temas para enriquecer notas periodísticas.

BÚSQUEDAS A REALIZAR:
${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

INSTRUCCIONES:
- Buscá información verificable y actual sobre cada tema
- Priorizá fuentes periodísticas serias (agencias de noticias, diarios nacionales, medios oficiales)
- Extraé datos concretos: cifras, declaraciones textuales, fechas, decisiones oficiales
- Si hay información relevante para Formosa o el NEA argentino, priorizala
- Incluí las URLs de las fuentes

Respondé en JSON con esta estructura:
{
  "results": [
    {
      "title": "Título del hallazgo o artículo",
      "content": "Resumen de 2-3 párrafos con los datos clave encontrados. Incluir cifras, declaraciones y datos verificables.",
      "source_url": "URL de la fuente principal",
      "source_name": "Nombre del medio",
      "relevance": "Por qué es relevante para la nota"
    }
  ],
  "summary": "Síntesis general de lo encontrado en 2-3 oraciones"
}`;

  try {
    const model = "gemini-2.0-flash";
    const url = `${GEMINI_API}/${model}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: searchPrompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2000,
      },
    };

    const response = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });

    const candidate = response.data.candidates?.[0];
    if (!candidate) return null;

    // Extraer texto de la respuesta
    const textParts = candidate.content?.parts?.filter((p) => p.text) || [];
    const fullText = textParts.map((p) => p.text).join("\n");

    // Extraer grounding metadata (fuentes citadas por Google Search)
    const groundingMeta = candidate.groundingMetadata;
    const groundingChunks = groundingMeta?.groundingChunks || [];
    const searchEntryPoint = groundingMeta?.searchEntryPoint;

    // Intentar parsear JSON de la respuesta
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    let parsedResults = [];

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        parsedResults = (parsed.results || []).map((r) => ({
          title: r.title || r.source_name || "",
          snippet: r.relevance || "",
          url: r.source_url || "",
          content: r.content || "",
          scrapedTitle: r.title || "",
          scrapedImage: "",
        }));
      } catch (_) {}
    }

    // Si no parseó JSON, crear resultado del texto completo
    if (parsedResults.length === 0 && fullText.length > 50) {
      parsedResults = [{
        title: "Investigación Gemini",
        snippet: "Resultados de búsqueda web con IA",
        url: "",
        content: fullText.slice(0, 1500),
        scrapedTitle: "Investigación Gemini",
        scrapedImage: "",
      }];
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
  } catch (error) {
    console.error("[Search] Error en Gemini grounded search:", error.response?.data?.error?.message || error.message);
    return null;
  }
}

// ─── Estrategia 2: Google Custom Search API ───

async function googleCustomSearch(query, maxResults) {
  try {
    const response = await axios.get(
      "https://www.googleapis.com/customsearch/v1",
      {
        params: {
          key: process.env.GOOGLE_SEARCH_API_KEY,
          cx: process.env.GOOGLE_SEARCH_CX,
          q: query,
          num: maxResults,
          lr: "lang_es",
        },
      },
    );

    return (response.data.items || []).map((item) => ({
      title: item.title,
      snippet: item.snippet,
      url: item.link,
      content: "",
    }));
  } catch (error) {
    console.error("[Search] Error en Google Custom Search:", error.message);
    return [];
  }
}

// ─── Estrategia 3: DuckDuckGo HTML Scraping ───

async function duckDuckGoSearch(query, maxResults) {
  try {
    const response = await axios.get("https://html.duckduckgo.com/html/", {
      params: { q: query },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    const results = [];

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
  } catch (error) {
    console.error("[Search] Error en DuckDuckGo:", error.message);
    return [];
  }
}

// ─── Búsqueda genérica ───

async function searchWeb(query, maxResults = 3) {
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    return await googleCustomSearch(query, maxResults);
  }
  return await duckDuckGoSearch(query, maxResults);
}

// ─── Scraping de artículos ───

async function scrapeArticleContent(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const $ = cheerio.load(response.data);
    $("script, style, nav, footer, header, aside").remove();

    const title =
      $("h1").first().text().trim() ||
      $("title").text().trim();

    const paragraphs = [];
    $("article p, .content p, .entry-content p, main p, .post p, .article-body p, .main-text p").each(
      (_, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) paragraphs.push(text);
      },
    );

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
  } catch (error) {
    console.error(`[Search] Error scrapeando ${url}:`, error.message);
    return { title: "", content: "", imageUrl: "", url };
  }
}

// ─── Función principal de research ───

/**
 * Investiga temas usando la mejor estrategia disponible.
 * Prioridad: Gemini Grounded Search > Google Custom Search + scraping > DuckDuckGo + scraping
 *
 * @param {string[]} searchQueries - Queries de búsqueda generados por el insight service
 * @returns {Array<{ title, snippet, url, content, scrapedTitle, scrapedImage }>}
 */
async function searchAndEnrich(searchQueries) {
  // ─── Estrategia 1: Gemini Grounded Search (superior) ───
  // Gemini busca, lee y sintetiza en un solo paso
  const geminiResults = await geminiGroundedSearch(searchQueries);
  if (geminiResults && geminiResults.length > 0) {
    return geminiResults;
  }

  // ─── Fallback: búsqueda tradicional + scraping ───
  console.log("[Search] Gemini no disponible, usando búsqueda tradicional...");
  const allResults = [];

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

export { searchWeb, scrapeArticleContent, searchAndEnrich };
