/**
 * memoryQuoteFlyerStore — implementación en memoria de `QuoteFlyerStore`
 * para tests de `quoteFlyerService` (PF-07). Sin DB: los mismos filtros
 * por tenant que la implementación drizzle (una publicación o foto de otro
 * tenant no se lee ni se escribe).
 *
 * `getPersonPhoto` replica la regla de la impl real: primaria primero; si
 * no hay primaria, la más antigua (`isPrimary` DESC, `createdAt` ASC) —
 * misma regla que `faceEnrollmentService.findPrimaryPhoto`.
 */
import type {
    QuoteFlyerPublication,
    QuoteFlyerStore,
} from '../../src/server/services/quoteFlyerService';

export interface MemoryQuoteFlyerPublicationRow {
    id: string;
    tenantId: string;
    /** jsonb tal cual — `unknown` como en la fila real. */
    quotes: unknown;
    /** Paths ya persistidos (jsonb) — appendFlyerPaths los mergea. */
    quoteFlyerPaths: string[];
}

export interface MemoryPersonPhotoRow {
    tenantId: string;
    personId: string;
    photoData: Buffer;
    isPrimary: boolean;
    /** Orden de llegada — la "más antigua" es la de createdAt menor. */
    createdAt: number;
}

export interface MemoryQuoteFlyerState {
    publications: MemoryQuoteFlyerPublicationRow[];
    photos: MemoryPersonPhotoRow[];
}

export function createMemoryQuoteFlyerStore(): {
    store: QuoteFlyerStore;
    state: MemoryQuoteFlyerState;
} {
    const state: MemoryQuoteFlyerState = {
        publications: [],
        photos: [],
    };

    const store: QuoteFlyerStore = {
        async getPublication(publicationId, tenantId) {
            // WHERE id AND tenant_id — un id ajeno NO se encuentra.
            const row = state.publications.find(
                (p) => p.id === publicationId && p.tenantId === tenantId,
            );
            return row ? { id: row.id, quotes: row.quotes } : null;
        },

        async getPersonPhoto(tenantId, personId) {
            const candidates = state.photos
                .filter(
                    (ph) =>
                        ph.tenantId === tenantId && ph.personId === personId,
                )
                .sort(
                    (a, b) =>
                        Number(b.isPrimary) - Number(a.isPrimary) ||
                        a.createdAt - b.createdAt,
                );
            const row = candidates[0];
            return row ? { photoData: row.photoData } : null;
        },

        async appendFlyerPaths(publicationId, tenantId, paths) {
            const row = state.publications.find(
                (p) => p.id === publicationId && p.tenantId === tenantId,
            );
            if (!row) return;
            // Concat — nunca pisa los paths previos (semántica del `||`).
            row.quoteFlyerPaths = [...row.quoteFlyerPaths, ...paths];
        },
    };

    return { store, state };
}

/** Atajo de seeding de publicación con quotes + flyer paths previos. */
export function seedQuoteFlyerPublication(
    state: MemoryQuoteFlyerState,
    v: {
        id: string;
        tenantId: string;
        quotes?: unknown;
        quoteFlyerPaths?: string[];
    },
): MemoryQuoteFlyerPublicationRow {
    const row: MemoryQuoteFlyerPublicationRow = {
        id: v.id,
        tenantId: v.tenantId,
        quotes: v.quotes ?? null,
        quoteFlyerPaths: v.quoteFlyerPaths ?? [],
    };
    state.publications.push(row);
    return row;
}

let photoSeq = 0;

/** Atajo de seeding de foto de persona (default: no primaria, orden seq). */
export function seedPersonPhoto(
    state: MemoryQuoteFlyerState,
    v: {
        tenantId: string;
        personId: string;
        photoData: Buffer;
        isPrimary?: boolean;
        createdAt?: number;
    },
): void {
    state.photos.push({
        tenantId: v.tenantId,
        personId: v.personId,
        photoData: v.photoData,
        isPrimary: v.isPrimary ?? false,
        createdAt: v.createdAt ?? photoSeq++,
    });
}
