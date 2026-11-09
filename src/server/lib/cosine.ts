// ---------------------------------------------------------------------------
// cosine.ts — cosine similarity para embeddings faciales (GATE-1 fallback)
//
// pgvector NO está disponible (ver sdd/live-creator-platform/design/gate1-pgvector.md):
// face_embeddings.embedding es jsonb float[512] y el match se calcula acá.
// Los embeddings de InsightFace vienen ~L2-normalizados, pero se normaliza
// defensivamente igual.
// ---------------------------------------------------------------------------

/** Cosine similarity en [-1, 1]. Devuelve 0 ante dims distintas o norma 0. */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
    if (!a || !b || a.length === 0 || a.length !== b.length) return 0;

    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na <= 0 || nb <= 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface CosineMatch<T> {
    item: T;
    similarity: number;
}

/**
 * Mejor match por cosine de `query` contra un set de candidatos.
 * Devuelve null si ninguno supera el umbral.
 */
export function bestCosineMatch<T>(
    query: number[],
    candidates: T[],
    getEmbedding: (item: T) => number[] | null | undefined,
    threshold: number,
): CosineMatch<T> | null {
    let best: CosineMatch<T> | null = null;
    for (const item of candidates) {
        const sim = cosineSimilarity(query, getEmbedding(item));
        if (sim >= threshold && (best === null || sim > best.similarity)) {
            best = { item, similarity: sim };
        }
    }
    return best;
}
