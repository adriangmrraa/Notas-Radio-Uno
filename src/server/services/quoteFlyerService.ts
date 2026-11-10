/**
 * quoteFlyerService — quote-cards 1080x1080 con la foto REAL de la persona
 * detectada (PF-07).
 *
 * Las notas de PF-06 ya persisten `publications.quotes` (jsonb) como
 * `AttributedQuote[]` de `attributedQuotesService` — con `personId`/
 * `personName` resueltos computed-on-read. Este slice toma esas citas y
 * genera UN flyer por cita atribuida: la foto del speaker sale de
 * `person_photos.photoData` (bytea enrolada con face_detection, PE-03/PC-04)
 * — primaria si existe; si no, la más antigua (misma regla que
 * `faceEnrollmentService.findPrimaryPhoto` y `attributedQuotesService`).
 *
 * El canvas NO se reimplementa: `renderFlyer` default = `processQuoteFlyer`
 * de `imageService.ts` (NO TOCAR). Su contrato pide el `AttributedQuote` de
 * `src/shared/types.ts` (`{text, speaker, role, confidence}`) — DISTINTO del
 * `AttributedQuote` del service que vive en el jsonb. La adaptación de shape
 * se hace acá (`toFlyerQuote`), como pide el brief — imageService queda
 * intacto. Import lazy: el módulo queda liviano y los tests nunca cargan
 * @napi-rs/canvas ni sharp (renderFlyer se inyecta SIEMPRE en tests).
 *
 * Política sin foto (AC: foto REAL, nunca placeholder/silhouette): una
 * persona sin `person_photos` genera el flyer con `photoData = null` — el
 * canvas ya tolera null (círculo neutro). `onlyPersonsWithPhotos: true`
 * convierte ese caso en skip. Una cita sin `personId` siempre se saltea:
 * sin atribución no hay persona de quien sacar la foto.
 *
 * Los paths devueltos por el render se appendean a
 * `publications.quote_flyer_paths` (jsonb) con merge ATÓMICO server-side
 * (`COALESCE(...) || nuevo::jsonb` — mismo patrón `||` que
 * `clipRecutService.patchClipMetadata`): los flyers de corridas anteriores
 * nunca se pisan.
 *
 * Errores de dominio como `AppError` con `code` — la ruta los mapea tal
 * cual: `publication_not_found` (404), `no_quotes` (422).
 *
 * Patrón del repo: `QuoteFlyerStore` + `createDrizzleQuoteFlyerStore` +
 * memory store en tests — TODA query filtra por `tenant_id`.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { publications } from '../db/schema/publications.js';
import { personPhotos } from '../db/schema/persons.js';
import { AppError } from '../lib/errors.js';
import { loadTenantBranding } from './brandingService.js';
import type { AttributedQuote } from './attributedQuotesService.js';
import type {
    AttributedQuote as FlyerQuote,
    BrandingConfig,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Tipos del dominio
// ---------------------------------------------------------------------------

/** Lo que el servicio necesita de `publications` (tenant-scoped). */
export interface QuoteFlyerPublication {
    id: string;
    /**
     * Citas persistidas por PF-06 (jsonb = `AttributedQuote[]` del service).
     * `unknown` de cara al caller: el servicio valida `Array.isArray` antes
     * de iterar — jsonb puede traer cualquier cosa.
     */
    quotes: unknown;
}

/** Foto real de la persona (bytea ya decodificado a Buffer). */
export interface PersonPhotoRow {
    photoData: Buffer;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface QuoteFlyerStore {
    /** Publicación del tenant; null si no existe o es ajena. */
    getPublication(
        publicationId: string,
        tenantId: string,
    ): Promise<QuoteFlyerPublication | null>;
    /**
     * Foto REAL de la persona: primaria si existe; si no, la más antigua
     * (`is_primary DESC, created_at ASC` — misma regla que
     * `faceEnrollmentService.findPrimaryPhoto`). null = persona sin fotos.
     */
    getPersonPhoto(
        tenantId: string,
        personId: string,
    ): Promise<PersonPhotoRow | null>;
    /**
     * Concatena `paths` a `publications.quote_flyer_paths` con merge jsonb
     * atómico (`||` server-side) — nunca pisa los paths existentes.
     */
    appendFlyerPaths(
        publicationId: string,
        tenantId: string,
        paths: string[],
    ): Promise<void>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleQuoteFlyerStore(
    executor: Database = db,
): QuoteFlyerStore {
    return {
        async getPublication(publicationId, tenantId) {
            const [row] = await executor
                .select({
                    id: publications.id,
                    quotes: publications.quotes,
                })
                .from(publications)
                .where(
                    and(
                        eq(publications.id, publicationId),
                        eq(publications.tenantId, tenantId),
                    ),
                )
                .limit(1);
            return row ?? null;
        },

        async getPersonPhoto(tenantId, personId) {
            const [row] = await executor
                .select({ photoData: personPhotos.photoData })
                .from(personPhotos)
                .where(
                    and(
                        eq(personPhotos.tenantId, tenantId),
                        eq(personPhotos.personId, personId),
                    ),
                )
                .orderBy(
                    desc(personPhotos.isPrimary),
                    asc(personPhotos.createdAt),
                )
                .limit(1);
            if (!row) return null;
            return { photoData: Buffer.from(row.photoData) };
        },

        async appendFlyerPaths(publicationId, tenantId, paths) {
            // Concat jsonb atómica server-side (`||` de arrays): evita el
            // read-modify-write y nunca pisa flyers de corridas anteriores.
            await executor
                .update(publications)
                .set({
                    quoteFlyerPaths: sql`COALESCE(${publications.quoteFlyerPaths}, '[]'::jsonb) || ${JSON.stringify(paths)}::jsonb`,
                })
                .where(
                    and(
                        eq(publications.id, publicationId),
                        eq(publications.tenantId, tenantId),
                    ),
                );
        },
    };
}

// ---------------------------------------------------------------------------
// toFlyerQuote — adaptador de shape (puro, exportado para tests)
// ---------------------------------------------------------------------------

/**
 * `AttributedQuote` del service (la que PF-06 guarda en `publications.quotes`)
 * → `AttributedQuote` de `shared/types.ts` que `processQuoteFlyer` espera.
 *
 * El canvas lee `text`, `speaker` y `role ?? ''`:
 *   - `speaker` = personName → speakerLabel → fallback (misma cadena que
 *     `noteFactoryService.quoteAuthor`).
 *   - `role` = '' — el quote atribuido no porta rol (vive en
 *     `persons.role_label`, fuera del alcance del slice).
 *   - `confidence` es exigido por el tipo pero el canvas NO lo lee:
 *     constante 'medium' para satisfacer la firma sin inventar semántica.
 */
export function toFlyerQuote(quote: AttributedQuote): FlyerQuote {
    return {
        text: quote.text ?? '',
        speaker:
            quote.personName ?? quote.speakerLabel ?? 'Vocero sin identificar',
        role: '',
        confidence: 'medium',
    };
}

// ---------------------------------------------------------------------------
// generateQuoteFlyers — flujo completo
// ---------------------------------------------------------------------------

export interface GenerateQuoteFlyersInput {
    tenantId: string;
    publicationId: string;
    /**
     * true ⇒ una persona sin foto REAL se saltea (no se genera flyer sin
     * foto). Default false ⇒ el flyer se genera igual con `photoData=null`
     * (el canvas dibuja el círculo neutro — nunca placeholder/silhouette).
     */
    onlyPersonsWithPhotos?: boolean;
}

/** El render por cita — inyectable; default = `processQuoteFlyer` real. */
export type RenderFlyerFn = (
    quote: FlyerQuote,
    speakerPhotoData: Buffer | null,
    branding: BrandingConfig | null,
) => Promise<string>;

export interface GenerateQuoteFlyersDeps {
    store?: QuoteFlyerStore;
    renderFlyer?: RenderFlyerFn;
    loadBranding?: (tenantId: string) => Promise<BrandingConfig>;
    now?: () => Date;
}

export interface QuoteFlyerResult {
    /** Índice de la cita dentro de `publication.quotes`. */
    quoteIndex: number;
    personId: string;
    path: string;
}

export interface GenerateQuoteFlyersResult {
    publicationId: string;
    flyers: QuoteFlyerResult[];
    /** Citas saltadas: sin personId o (onlyPersonsWithPhotos) sin foto. */
    skipped: number;
    generatedAt: Date;
}

/**
 * `renderFlyer` default: `processQuoteFlyer` de imageService (canvas real).
 * Import lazy — como `defaultGenerate` de noteFactoryService: el módulo no
 * carga @napi-rs/canvas/sharp para quien sólo usa las funciones puras, y
 * los tests NUNCA llegan acá (siempre inyectan el fake).
 */
const defaultRenderFlyer: RenderFlyerFn = async (quote, photoData, branding) => {
    const { processQuoteFlyer } = await import('./imageService.js');
    return processQuoteFlyer(quote, photoData, branding);
};

/**
 * Genera los quote-cards de una publicación:
 *   publicación tenant-scoped → `quotes` jsonb → por cada cita CON
 *   `personId` se busca la foto real de la persona (primaria → más antigua)
 *   y se renderiza el flyer con el branding del tenant → los paths se
 *   appendean a `quote_flyer_paths` sin pisar los anteriores.
 *
 * Sin citas en el array ⇒ `no_quotes` (nunca una corrida vacía silenciosa).
 * Si ninguna cita produjo flyer, `appendFlyerPaths` no se llama (un append
 * de `[]` sería una escritura vacía).
 */
export async function generateQuoteFlyers(
    input: GenerateQuoteFlyersInput,
    deps: GenerateQuoteFlyersDeps = {},
): Promise<GenerateQuoteFlyersResult> {
    const store = deps.store ?? createDrizzleQuoteFlyerStore();
    const renderFlyer = deps.renderFlyer ?? defaultRenderFlyer;
    const loadBranding = deps.loadBranding ?? loadTenantBranding;
    const now = deps.now ?? (() => new Date());
    const onlyPersonsWithPhotos = input.onlyPersonsWithPhotos ?? false;

    const publication = await store.getPublication(
        input.publicationId,
        input.tenantId,
    );
    if (!publication) {
        throw new AppError(
            'Publicación no encontrada',
            404,
            'publication_not_found',
        );
    }

    const quotes: AttributedQuote[] = Array.isArray(publication.quotes)
        ? (publication.quotes as AttributedQuote[])
        : [];
    if (quotes.length === 0) {
        throw new AppError(
            'La publicación no tiene citas para generar flyers',
            422,
            'no_quotes',
        );
    }

    const branding = await loadBranding(input.tenantId);
    const flyers: QuoteFlyerResult[] = [];
    let skipped = 0;

    for (const [quoteIndex, quote] of quotes.entries()) {
        // Sin personId la cita no está atribuida a una persona: no hay foto
        // real que buscar → skip (nunca flyer "anónimo" con foto genérica).
        if (!quote?.personId) {
            skipped++;
            continue;
        }

        const photo = await store.getPersonPhoto(input.tenantId, quote.personId);
        const photoData = photo?.photoData ?? null;
        if (!photoData && onlyPersonsWithPhotos) {
            skipped++;
            continue;
        }

        const path = await renderFlyer(toFlyerQuote(quote), photoData, branding);
        flyers.push({ quoteIndex, personId: quote.personId, path });
    }

    if (flyers.length > 0) {
        await store.appendFlyerPaths(
            input.publicationId,
            input.tenantId,
            flyers.map((f) => f.path),
        );
    }

    return {
        publicationId: publication.id,
        flyers,
        skipped,
        generatedAt: now(),
    };
}
