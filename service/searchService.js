import axios from "axios";
import * as cheerio from "cheerio";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * Busca información en internet usando múltiples estrategias.
 * Soporta: Google Custom Search API, o scraping directo de Google.
 * Retorna array de { title, snippet, url, content }
 */
async function searchWeb(query, maxResults = 3) {
  // Estrategia 1: Google Custom Search API (si hay API key)
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    return await googleCustomSearch(query, maxResults);
  }

  // Estrategia 2: Scraping directo de DuckDuckGo HTML
  return await duckDuckGoSearch(query, maxResults);
}

/**
 * Búsqueda usando Google Custom Search API
 */
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
    console.error("Error en Google Custom Search:", error.message);
    return [];
  }
}

/**
 * Búsqueda usando DuckDuckGo HTML (sin API key necesaria)
 */
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
    console.error("Error en DuckDuckGo search:", error.message);
    return [];
  }
}

/**
 * Scraping del contenido de un artículo web.
 * Extrae título y texto principal.
 */
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

    // Remover scripts, styles, nav, footer
    $("script, style, nav, footer, header, aside").remove();

    const title =
      $("h1").first().text().trim() ||
      $("title").text().trim();

    // Extraer párrafos principales
    const paragraphs = [];
    $("article p, .content p, .entry-content p, main p, .post p, .article-body p, .main-text p").each(
      (_, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) {
          paragraphs.push(text);
        }
      },
    );

    // Si no encontró con selectores específicos, usar todos los p
    if (paragraphs.length === 0) {
      $("p").each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > 40) {
          paragraphs.push(text);
        }
      });
    }

    // Extraer primera imagen relevante
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
    console.error(`Error scrapeando ${url}:`, error.message);
    return { title: "", content: "", imageUrl: "", url };
  }
}

/**
 * Realiza búsquedas basadas en los queries de insights y scrapea los mejores resultados.
 * Retorna información consolidada para enriquecer la nota.
 */
async function searchAndEnrich(searchQueries) {
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
