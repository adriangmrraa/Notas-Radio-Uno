import axios from "axios";
import * as cheerio from "cheerio";

interface ScrapedArticle {
  title: string;
  content: string;
  imageUrl: string | undefined;
  datePublished: string | undefined;
}

async function scrapeElComercialArticle(url: string): Promise<ScrapedArticle> {
  try {
    const response = await axios.get<string>(url);
    const html = response.data;
    const $ = cheerio.load(html);

    const title = $('h1[itemprop="headline"]').text().trim();
    const content = $("div.main-text > p")
      .map((_i, el) => $(el).text().trim())
      .get()
      .join("\n");
    const imageUrl = $("figure img").first().attr("src");
    const datePublished = $("meta[itemprop='datePublished']").attr("content");

    return {
      title,
      content,
      imageUrl,
      datePublished,
    };
  } catch (error) {
    console.error("Error al raspar el artículo:", error);
    throw error;
  }
}

export { scrapeElComercialArticle };
export type { ScrapedArticle };
