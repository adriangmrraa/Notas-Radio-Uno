import { getDb } from "./databaseService.js";
import type { DuplicateCheckResult, Publication } from "../../shared/types.js";

/**
 * Servicio de detección de duplicados.
 *
 * Antes de publicar un tema, verifica si ya fue publicado recientemente
 * comparando contra la base de datos de publicaciones.
 *
 * Estrategias de comparación:
 *   1. Similitud de título (normalización + overlap de palabras)
 *   2. Similitud de contenido/resumen vs publicaciones recientes
 */

interface RecentPublication {
  id: number;
  title: string;
  content: string | null;
  created_at: string;
}

/**
 * Busca publicaciones recientes dentro de un rango de horas.
 * @param hoursBack - Cuántas horas hacia atrás buscar (default 24)
 * @returns Publicaciones recientes
 */
export function findRecentPublications(hoursBack: number = 24): RecentPublication[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  return db
    .prepare("SELECT id, title, content, created_at FROM publications WHERE created_at > ? ORDER BY created_at DESC")
    .all(cutoff) as RecentPublication[];
}

/**
 * Normaliza un string para comparación.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

/**
 * Extrae palabras significativas (>3 caracteres) de un string normalizado.
 */
function significantWords(text: string): string[] {
  return normalize(text).split(/\s+/).filter((w) => w.length > 3);
}

/**
 * Calcula el porcentaje de overlap entre dos conjuntos de palabras.
 */
function wordOverlap(wordsA: string[], wordsB: string[]): number {
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setB = new Set(wordsB);
  const overlap = wordsA.filter((w) => setB.has(w)).length;
  return overlap / Math.min(wordsA.length, wordsB.length);
}

/**
 * Verifica si un tema/título ya fue publicado recientemente.
 *
 * @param topic - Nombre del tema a verificar
 * @param summary - Resumen del tema (opcional, para comparación más precisa)
 * @param hoursBack - Ventana de tiempo en horas (default 24)
 * @param threshold - Umbral de similitud 0-1 (default 0.5)
 * @returns Resultado de la verificación de duplicados
 */
export function isDuplicateTopic(
  topic: string,
  summary: string = "",
  hoursBack: number = 24,
  threshold: number = 0.5,
): DuplicateCheckResult {
  const recentPubs = findRecentPublications(hoursBack);
  if (recentPubs.length === 0) {
    return { isDuplicate: false, matchedPublication: null, similarity: 0 };
  }

  const topicWords = significantWords(topic);
  const summaryWords = summary ? significantWords(summary) : [];
  const combinedWords = [...new Set([...topicWords, ...summaryWords])];

  let bestMatch: RecentPublication | null = null;
  let bestSimilarity = 0;

  for (const pub of recentPubs) {
    // Comparar contra título de la publicación
    const pubTitleWords = significantWords(pub.title);
    const titleSimilarity = wordOverlap(topicWords, pubTitleWords);

    // Comparar contra contenido de la publicación (si existe)
    let contentSimilarity = 0;
    if (pub.content && combinedWords.length > 0) {
      const pubContentWords = significantWords(pub.content.slice(0, 500));
      contentSimilarity = wordOverlap(combinedWords, pubContentWords);
    }

    // Tomar la mejor similitud (título tiene más peso)
    const similarity = Math.max(titleSimilarity * 1.0, contentSimilarity * 0.8);

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMatch = pub;
    }
  }

  // También comparar con normalización directa (substring)
  const normalizedTopic = normalize(topic);
  for (const pub of recentPubs) {
    const normalizedTitle = normalize(pub.title);
    if (normalizedTopic.includes(normalizedTitle) || normalizedTitle.includes(normalizedTopic)) {
      if (normalizedTopic.length > 5 && normalizedTitle.length > 5) {
        return {
          isDuplicate: true,
          matchedPublication: pub as unknown as Publication,
          similarity: 1.0,
        };
      }
    }
  }

  return {
    isDuplicate: bestSimilarity >= threshold,
    matchedPublication: bestSimilarity >= threshold ? (bestMatch as unknown as Publication) : null,
    similarity: bestSimilarity,
  };
}

/**
 * Verifica si un tema ya está en la lista de temas publicados en la sesión actual.
 * Complementa la verificación contra la DB.
 *
 * @param topic - Tema a verificar
 * @param publishedTopics - Lista de temas ya publicados en esta sesión
 * @returns true si el tema ya fue publicado en la sesión
 */
export function isTopicInSession(topic: string, publishedTopics: string[]): boolean {
  const normalizedTopic = normalize(topic);
  return publishedTopics.some((published) => {
    const normalizedPublished = normalize(published);
    if (normalizedTopic === normalizedPublished) return true;
    if (normalizedTopic.includes(normalizedPublished) || normalizedPublished.includes(normalizedTopic)) return true;
    const overlapScore = wordOverlap(significantWords(topic), significantWords(published));
    return overlapScore >= 0.5;
  });
}
