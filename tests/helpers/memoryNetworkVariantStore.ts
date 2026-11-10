/**
 * memoryNetworkVariantStore — implementación en memoria de
 * `NetworkVariantStore` para tests de `networkVariantService` (PF-09).
 * Sin DB: los mismos filtros por tenant que la implementación drizzle
 * (una publicación o persona de otro tenant no se lee ni se escribe).
 */
import type {
    ContentVariantsWithExtras,
    NetworkVariantKey,
} from '../../src/shared/types';
import type {
    NetworkVariantPublication,
    NetworkVariantStore,
    PersonSocialLinks,
} from '../../src/server/services/networkVariantService';

export interface MemoryNetworkVariantPublicationRow {
    id: string;
    tenantId: string;
    title: string | null;
    content: string | null;
    /** jsonb tal cual — `unknown` como en la fila real. */
    quotes: unknown;
    /** Lo persistido por updateContentVariants (reemplazo completo). */
    contentVariants: unknown;
}

export interface MemoryNetworkVariantPersonRow {
    id: string;
    tenantId: string;
    name: string;
    /** jsonb tal cual — `unknown` como en la fila real. */
    socialLinks: unknown;
}

export interface MemoryNetworkVariantState {
    publications: MemoryNetworkVariantPublicationRow[];
    persons: MemoryNetworkVariantPersonRow[];
}

export function createMemoryNetworkVariantStore(): {
    store: NetworkVariantStore;
    state: MemoryNetworkVariantState;
} {
    const state: MemoryNetworkVariantState = {
        publications: [],
        persons: [],
    };

    const store: NetworkVariantStore = {
        async getPublication(publicationId, tenantId) {
            // WHERE id AND tenant_id — un id ajeno NO se encuentra.
            const row = state.publications.find(
                (p) => p.id === publicationId && p.tenantId === tenantId,
            );
            return row
                ? {
                      id: row.id,
                      title: row.title,
                      content: row.content,
                      quotes: row.quotes,
                  }
                : null;
        },

        async getPersonSocialLinks(tenantId, personIds) {
            if (personIds.length === 0) return [];
            // WHERE tenant_id AND id IN (...) — como la impl drizzle.
            return state.persons
                .filter(
                    (p) =>
                        p.tenantId === tenantId && personIds.includes(p.id),
                )
                .map(
                    (p): PersonSocialLinks => ({
                        id: p.id,
                        name: p.name,
                        socialLinks: p.socialLinks,
                    }),
                );
        },

        async updateContentVariants(publicationId, tenantId, variants) {
            const row = state.publications.find(
                (p) => p.id === publicationId && p.tenantId === tenantId,
            );
            if (!row) return;
            // UPDATE completo de la columna — una corrida reemplaza.
            row.contentVariants = variants;
        },
    };

    return { store, state };
}

/** Atajo de seeding de publicación con title/content/quotes/variants. */
export function seedVariantPublication(
    state: MemoryNetworkVariantState,
    v: {
        id: string;
        tenantId: string;
        title?: string | null;
        content?: string | null;
        quotes?: unknown;
        contentVariants?: ContentVariantsWithExtras | unknown;
    },
): MemoryNetworkVariantPublicationRow {
    const row: MemoryNetworkVariantPublicationRow = {
        id: v.id,
        tenantId: v.tenantId,
        // `undefined` → default de fixture; `null` explícito se respeta
        // (sirve para testear no_content).
        title: v.title === undefined ? 'Título de la nota' : v.title,
        content:
            v.content === undefined
                ? 'Contenido de la nota con datos y contexto.'
                : v.content,
        quotes: v.quotes ?? [],
        contentVariants: v.contentVariants ?? null,
    };
    state.publications.push(row);
    return row;
}

/** Atajo de seeding de persona con sus social_links. */
export function seedVariantPerson(
    state: MemoryNetworkVariantState,
    v: {
        id: string;
        tenantId: string;
        name: string;
        socialLinks?: Record<string, unknown> | unknown;
    },
): MemoryNetworkVariantPersonRow {
    const row: MemoryNetworkVariantPersonRow = {
        id: v.id,
        tenantId: v.tenantId,
        name: v.name,
        socialLinks: v.socialLinks ?? {},
    };
    state.persons.push(row);
    return row;
}

// Re-export de conveniencia para los tests.
export type { NetworkVariantKey };
