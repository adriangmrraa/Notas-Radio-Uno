/**
 * networkVariantService — variantes por red: copy + hashtags + menciones
 * con handles REALES (PF-09).
 *
 * `generateContentVariants` (contentMultiplierService, línea vieja — NO
 * TOCAR) ya produce copy por red pero ni hashtags ni menciones. Este
 * servicio es el camino ÉPICA F: un solo llamado al modelo genera el copy
 * y los hashtags de las redes pedidas, y las MENCIONES se resuelven
 * determinísticamente desde `persons.social_links` — los handles son
 * hechos, el LLM NUNCA los genera (REGLA DE ORO del brief): aunque el
 * modelo devuelva un campo `mentions`, se ignora; lo persistido sale
 * siempre de `resolveMentions`.
 *
 * Persistencia: `publications.contentVariants` (jsonb, ya existe — cero
 * migraciones). El shape queda canonical-compatible (`ContentVariants`:
 * twitterThread=tweets, instagramCarousel=slides, linkedinPost=post,
 * youtubeDescription=desc, newsletterBlurb=blurb; lo no pedido queda
 * vacío) más `extras` por red pedida:
 * `{<network>: {hashtags: string[], mentions: [{name, handle}]}}`.
 * En el tipo TS es `ContentVariantsWithExtras` (extends ContentVariants):
 * el brief pedía `extras` directo en `ContentVariants`, pero eso rompe
 * los `Record<keyof ContentVariants, ...>` de contentMultiplierService
 * (NO TOCAR) — la extensión deja el runtime idéntico sin tocar el viejo.
 *
 * Redes (`NetworkVariantKey`, las keys de `extras` y del body
 * `{networks?: string[]}`): twitter | instagram | linkedin | youtube |
 * newsletter. Si no se piden, el default es `activeVariantKeys` de la
 * línea editorial efectiva (`resolveEditorialPromptContext`) mapeado de
 * vuelta a redes; sin perfil o sin formatos sociales ⇒ las 5.
 *
 * Errores de dominio como `AppError` con `code` (mismo patrón PF-06):
 * publication_not_found (404), no_content (422), invalid_network (422),
 * invalid_model_response (502).
 *
 * Patrón del repo: `NetworkVariantStore` + `createDrizzleNetworkVariantStore`
 * + memory store en tests — TODA query filtra por `tenant_id`. `generate`
 * es dep inyectable con el MISMO contrato que `chatCompletion` (lazy
 * import en el default): los tests siempre usan el fake, nunca un
 * provider real.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { db, type Database } from '../db/index.js';
import { publications } from '../db/schema/publications.js';
import { persons } from '../db/schema/persons.js';
import { AppError } from '../lib/errors.js';
import { extractJSON } from './aiService.js';
import { activeVariantKeys } from './editorialPromptService.js';
import type { EditorialGenerationContext } from './editorialPromptService.js';
import type { AttributedQuote } from './attributedQuotesService.js';
import type {
    ChatCompletionOptions,
    ChatCompletionResult,
    ContentVariants,
    ContentVariantsWithExtras,
    NetworkVariantKey,
} from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Redes y campos canónicos
// ---------------------------------------------------------------------------

/** Alias de dominio del brief (`NETWORK_HANDLE_KEYS: Record<NetworkKey, …>`). */
export type NetworkKey = NetworkVariantKey;

/** Las 5 redes válidas — también sirven para validar `networks` del body. */
export const NETWORK_VARIANT_KEYS: readonly NetworkVariantKey[] = [
    'twitter',
    'instagram',
    'linkedin',
    'youtube',
    'newsletter',
];

/**
 * Keys de `persons.social_links` que aportan handle por red, EN ORDEN de
 * preferencia: para twitter gana `x` sobre `twitter` (X es el nombre
 * vigente). `newsletter` no tiene menciones (no hay handle que arrobar).
 */
export const NETWORK_HANDLE_KEYS: Record<NetworkVariantKey, readonly string[]> =
    {
        twitter: ['x', 'twitter'],
        instagram: ['instagram'],
        linkedin: ['linkedin'],
        youtube: ['youtube'],
        newsletter: [],
    };

/**
 * Campos canónicos de `ContentVariants` (el shape que el client consume).
 * Como `extras` vive en `ContentVariantsWithExtras`, `keyof ContentVariants`
 * sigue siendo exactamente estos 5.
 */
export type VariantFieldKey = keyof ContentVariants;

/** Red → campo canónico (inverso exacto de VARIANT_FORMAT_KEYS de PC-06). */
export const NETWORK_TO_FIELD: Record<NetworkVariantKey, VariantFieldKey> = {
    twitter: 'twitterThread',
    instagram: 'instagramCarousel',
    linkedin: 'linkedinPost',
    youtube: 'youtubeDescription',
    newsletter: 'newsletterBlurb',
};

/** Campo canónico → red. */
export const FIELD_TO_NETWORK: Record<VariantFieldKey, NetworkVariantKey> = {
    twitterThread: 'twitter',
    instagramCarousel: 'instagram',
    linkedinPost: 'linkedin',
    youtubeDescription: 'youtube',
    newsletterBlurb: 'newsletter',
};

// ---------------------------------------------------------------------------
// Tipos del dominio
// ---------------------------------------------------------------------------

/** Lo que el servicio necesita de `publications` (tenant-scoped). */
export interface NetworkVariantPublication {
    id: string;
    title: string | null;
    content: string | null;
    /** `AttributedQuote[]` persistido por PF-06 (jsonb — `unknown` de cara al caller). */
    quotes: unknown;
}

/** Persona citada con sus redes (sólo lo que la resolución necesita). */
export interface PersonSocialLinks {
    id: string;
    name: string;
    socialLinks: unknown;
}

/** Mención resuelta — handle REAL normalizado con '@' (nunca del LLM). */
export interface ResolvedMention {
    personId: string;
    name: string;
    handle: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface NetworkVariantStore {
    /** Publicación del tenant; null si no existe o es ajena. */
    getPublication(
        publicationId: string,
        tenantId: string,
    ): Promise<NetworkVariantPublication | null>;
    /**
     * `{id, name, socialLinks}` de las personas pedidas — una sola query
     * (`inArray` + `eq tenant_id`); personas de otro tenant no se leen.
     */
    getPersonSocialLinks(
        tenantId: string,
        personIds: string[],
    ): Promise<PersonSocialLinks[]>;
    /**
     * UPDATE completo de `content_variants` — una corrida reemplaza a la
     * anterior (las variantes son regenerables; no hace falta merge).
     */
    updateContentVariants(
        publicationId: string,
        tenantId: string,
        variants: ContentVariantsWithExtras,
    ): Promise<void>;
}

/** Implementación drizzle — TODA query filtra por tenant_id. */
export function createDrizzleNetworkVariantStore(
    executor: Database = db,
): NetworkVariantStore {
    return {
        async getPublication(publicationId, tenantId) {
            const [row] = await executor
                .select({
                    id: publications.id,
                    title: publications.title,
                    content: publications.content,
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

        async getPersonSocialLinks(tenantId, personIds) {
            if (personIds.length === 0) return [];
            return executor
                .select({
                    id: persons.id,
                    name: persons.name,
                    socialLinks: persons.socialLinks,
                })
                .from(persons)
                .where(
                    and(
                        eq(persons.tenantId, tenantId),
                        inArray(persons.id, personIds),
                    ),
                );
        },

        async updateContentVariants(publicationId, tenantId, variants) {
            await executor
                .update(publications)
                .set({ contentVariants: variants })
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
// Menciones determinísticas (puras — el corazón del slice)
// ---------------------------------------------------------------------------

/**
 * Normaliza un valor de `social_links` a handle con UN solo '@'.
 * Tolera lo que la gente guarda de verdad:
 *   'maria' / '@maria' / '@@maria'        → '@maria'
 *   'https://x.com/maria?ref=1'           → '@maria' (1er segmento del path)
 *   'x.com/@maria'                        → '@maria'
 *   '' / '   ' / 'https://x.com/'         → null (no hay handle usable)
 */
export function normalizeHandle(raw: string): string | null {
    let v = raw.trim();
    if (!v) return null;
    if (v.includes('/')) {
        // URL (con o sin protocolo): el handle es el primer segmento del
        // path — los segmentos que son dominio (contienen '.') o 'www' se
        // saltan. 'x.com/maria/status/1' → 'maria'; 'https://x.com/' → ''.
        v = v.replace(/^https?:\/\//i, '');
        const segments = v.split(/[/?#]/).filter((s) => s.length > 0);
        v =
            segments.find(
                (s) => !s.includes('.') && s.toLowerCase() !== 'www',
            ) ?? '';
    }
    v = v.split(/[?#]/)[0].trim();
    v = v.replace(/^@+/, '');
    return v ? `@${v}` : null;
}

/**
 * Por cada persona, el handle de `network` = el primer key de
 * `NETWORK_HANDLE_KEYS[network]` presente y con string usable en
 * `socialLinks` — normalizado a '@handle'. Sin handle en esa red ⇒ la
 * persona no aparece. Dedupe por handle (case-insensitive, gana el primero).
 * `newsletter` ⇒ siempre [].
 */
export function resolveMentions(
    personsList: readonly PersonSocialLinks[],
    network: NetworkVariantKey,
): ResolvedMention[] {
    const keys = NETWORK_HANDLE_KEYS[network];
    if (keys.length === 0) return [];

    const seen = new Set<string>();
    const out: ResolvedMention[] = [];

    for (const person of personsList) {
        const links =
            person.socialLinks && typeof person.socialLinks === 'object'
                ? (person.socialLinks as Record<string, unknown>)
                : {};

        let handle: string | null = null;
        for (const key of keys) {
            const raw = links[key];
            if (typeof raw !== 'string' || !raw.trim()) continue;
            handle = normalizeHandle(raw);
            if (handle) break;
        }
        if (!handle) continue;

        const dedupeKey = handle.toLowerCase();
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        out.push({ personId: person.id, name: person.name, handle });
    }
    return out;
}

/** personIds únicos de las citas (personId string no vacío; nulls fuera). */
export function extractPersonIds(quotes: unknown): string[] {
    if (!Array.isArray(quotes)) return [];
    const ids = new Set<string>();
    for (const q of quotes) {
        const personId = (q as { personId?: unknown } | null)?.personId;
        if (typeof personId === 'string' && personId.length > 0) {
            ids.add(personId);
        }
    }
    return [...ids];
}

// ---------------------------------------------------------------------------
// Prompt + parseo (puras)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Sos un experto en contenido multiplataforma para medios de comunicación.
Tu trabajo es transformar notas periodísticas en piezas optimizadas para cada red social.
Los handles de mención (@usuario) que se listan son REALES y verificados: podés usarlos tal cual en el copy cuando menciones a esa persona, pero NUNCA inventes handles nuevos ni respondas con un campo de menciones.
Siempre respondés con JSON válido, sin texto extra, sin markdown.`;

/** Rótulo humano por red (prompt). */
const NETWORK_LABELS: Record<NetworkVariantKey, string> = {
    twitter: 'X/Twitter',
    instagram: 'Instagram',
    linkedin: 'LinkedIn',
    youtube: 'YouTube',
    newsletter: 'Newsletter',
};

/**
 * Contrato JSON pedido al modelo por campo: la key del contenido dentro
 * del objeto (`{<contentKey>: …, "hashtags": []}`) + regla de estilo.
 * Las menciones NO se piden — se inyectan del mapa determinístico.
 */
const FIELD_LLM_SPEC: Record<
    VariantFieldKey,
    { contentKey: 'tweets' | 'slides' | 'post' | 'desc' | 'blurb'; isArray: boolean; example: string; rule: string }
> = {
    twitterThread: {
        contentKey: 'tweets',
        isArray: true,
        example:
            '"twitterThread": {"tweets": ["tweet 1 (max 280 chars)", "tweet 2"], "hashtags": ["#tag1", "#tag2"]}',
        rule: '- X/Twitter: máximo 5 tweets, cada uno ≤280 caracteres, primer tweet debe enganchar; mencioná con los @handles reales listados cuando corresponda.',
    },
    instagramCarousel: {
        contentKey: 'slides',
        isArray: true,
        example:
            '"instagramCarousel": {"slides": ["Slide 1 texto", "Slide 2", "Slide 3"], "hashtags": ["#tag1", "#tag2"]}',
        rule: '- Instagram: 5-7 slides, texto conciso por slide, primer slide = hook, último slide = CTA.',
    },
    linkedinPost: {
        contentKey: 'post',
        isArray: false,
        example:
            '"linkedinPost": {"post": "Post completo para LinkedIn (profesional, 300-500 palabras)", "hashtags": ["#tag1", "#tag2"]}',
        rule: '- LinkedIn: tono profesional, incluí datos duros, cerrá con pregunta para engagement.',
    },
    youtubeDescription: {
        contentKey: 'desc',
        isArray: false,
        example:
            '"youtubeDescription": {"desc": "Descripción para YouTube con timestamps y keywords SEO", "hashtags": ["#tag1", "#tag2"]}',
        rule: '- YouTube: incluí keywords SEO, estructura con timestamps ficticios (ej: 0:00, 1:30, etc.).',
    },
    newsletterBlurb: {
        contentKey: 'blurb',
        isArray: false,
        example:
            '"newsletterBlurb": {"blurb": "Resumen para newsletter (2-3 párrafos, enganche + link)", "hashtags": []}',
        rule: '- Newsletter: tono cercano, como si le escribieras a un suscriptor, cerrá con call to action.',
    },
};

export interface BuildVariantsPromptInput {
    title: string;
    content: string;
    /** Citas atribuidas persistidas (PF-06) — se listan con su autor. */
    quotes: readonly AttributedQuote[];
    /** Redes pedidas — el JSON sólo incluye esos campos. */
    networks: readonly NetworkVariantKey[];
    /** Menciones REALES resueltas por red (se exponen al modelo). */
    mentions: Partial<Record<NetworkVariantKey, ResolvedMention[]>>;
    /** Bloque de línea editorial serializado (PC-06); "" ⇒ sin perfil. */
    editorialBlock?: string;
}

/** Nombre visible de la cita (misma cadena de fallback que noteFactory). */
function quoteAuthor(q: AttributedQuote): string {
    return q.personName ?? q.speakerLabel ?? 'Vocero sin identificar';
}

/**
 * Prompt determinista: editorialBlock primero (directriz principal),
 * título + nota, citas atribuidas, handles reales disponibles por red
 * (para que el modelo los use — nunca los genere) y el contrato JSON de
 * salida con SOLO los campos de las redes pedidas.
 */
export function buildVariantsPrompt(input: BuildVariantsPromptInput): string {
    const parts: string[] = [];

    const editorial = input.editorialBlock?.trim();
    if (editorial) parts.push(editorial);

    const fields = input.networks.map((n) => NETWORK_TO_FIELD[n]);
    const exampleJson = `{\n  ${fields
        .map((f) => FIELD_LLM_SPEC[f].example)
        .join(',\n  ')}\n}`;
    const variantRules = fields.map((f) => FIELD_LLM_SPEC[f].rule).join('\n');

    const quoteLines = input.quotes
        .filter((q) => q.text?.trim())
        .map((q) => `- “${q.text!.trim()}” — ${quoteAuthor(q)}`);

    const mentionLines = input.networks
        .map((network) => {
            const mentions = input.mentions[network] ?? [];
            if (mentions.length === 0) return null;
            const list = mentions
                .map((m) => `${m.handle} (${m.name})`)
                .join(', ');
            return `- ${NETWORK_LABELS[network]}: ${list}`;
        })
        .filter((l): l is string => l !== null);

    parts.push(
        [
            'A partir de esta nota periodística, generá versiones optimizadas para cada plataforma pedida.',
            '',
            `Título: ${input.title}`,
            `Nota: ${input.content}`,
            ...(quoteLines.length
                ? [
                      '',
                      'CITAS ATRIBUIDAS DE LA NOTA (podés referenciarlas con su autor):',
                      ...quoteLines,
                  ]
                : []),
            ...(mentionLines.length
                ? [
                      '',
                      'MENCIONES DISPONIBLES — handles REALES por red (usalos tal cual si mencionás a la persona; NO inventes otros):',
                      ...mentionLines,
                  ]
                : []),
            '',
            'Generá un JSON con exactamente esta estructura (SOLO estos formatos, son los pedidos):',
            exampleJson,
            '',
            'Reglas estrictas:',
            variantRules,
            '- Hashtags: 3-6 por pieza, relevantes al tema, sin espacios.',
            '- Todo en español rioplatense.',
            '- Solo el JSON, sin texto adicional.',
        ].join('\n'),
    );

    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// parseVariantsResponse — parseo defensivo del JSON del modelo (puro)
// ---------------------------------------------------------------------------

export interface ParsedNetworkPayload {
    /** tweets/slides → string[]; post/desc/blurb → string. */
    content: string[] | string;
    hashtags: string[];
}

/** Normaliza hashtags del modelo: '#tag'/'tag' → '#tag', sin vacíos, dedupe. */
function normalizeHashtags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const tag = item.trim().replace(/^#+/, '').trim();
        if (!tag) continue;
        const normalized = `#${tag}`;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
    }
    return out;
}

/**
 * Filtra strings de un array del modelo (ignora no-strings y vacíos).
 * Devuelve null si no quedó nada usable.
 */
function stringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const items = value.filter(
        (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    return items.length > 0 ? items : null;
}

/**
 * JSON del modelo → payload por campo canónico pedido.
 * Contrato: `{<field>: {<contentKey>: …, "hashtags": []}}`; tolera además
 * el campo como array/string pelado (un modelo que omitió el wrapper).
 * JSON inválido o sin NINGÚN campo pedido ⇒ 502 `invalid_model_response`
 * (mismo patrón PF-06: el modelo devolvió basura, no es error del usuario).
 */
export function parseVariantsResponse(
    raw: string,
    requestedNetworks: readonly NetworkVariantKey[],
): Partial<Record<VariantFieldKey, ParsedNetworkPayload>> {
    const parsed = extractJSON(raw);
    const obj =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    if (!obj) {
        throw new AppError(
            'La respuesta del modelo no es un JSON válido',
            502,
            'invalid_model_response',
        );
    }

    const out: Partial<Record<VariantFieldKey, ParsedNetworkPayload>> = {};

    for (const network of requestedNetworks) {
        const field = NETWORK_TO_FIELD[network];
        const spec = FIELD_LLM_SPEC[field];
        const value = obj[field];
        if (value === undefined || value === null) continue;

        let content: string[] | string | null = null;
        let hashtags: string[] = [];

        if (Array.isArray(value)) {
            // Tolerancia: array pelado = contenido sin wrapper ni hashtags.
            content = spec.isArray ? stringArray(value) : value.find(
                (v): v is string => typeof v === 'string',
            ) ?? null;
        } else if (typeof value === 'string') {
            content = spec.isArray ? [value] : value;
        } else if (typeof value === 'object') {
            const record = value as Record<string, unknown>;
            const inner = record[spec.contentKey];
            content = spec.isArray
                ? stringArray(inner)
                : typeof inner === 'string' && inner.trim()
                  ? inner
                  : null;
            hashtags = normalizeHashtags(record.hashtags);
        }

        // Campo presente pero sin contenido usable ⇒ queda vacío (como
        // contentMultiplierService normaliza lo no activo — shape fijo).
        if (content === null || content === '') continue;
        out[field] = { content, hashtags };
    }

    if (Object.keys(out).length === 0) {
        throw new AppError(
            'La respuesta del modelo no trae ninguna variante pedida',
            502,
            'invalid_model_response',
        );
    }
    return out;
}

// ---------------------------------------------------------------------------
// generateVariants — flujo completo
// ---------------------------------------------------------------------------

export interface GenerateVariantsInput {
    tenantId: string;
    publicationId: string;
    /**
     * Redes pedidas (NetworkVariantKey). undefined o [] ⇒ default de la
     * línea editorial (`activeVariantKeys` de activeFormats; sin perfil o
     * sin formatos sociales ⇒ las 5). Un valor fuera de las 5 ⇒
     * `invalid_network`.
     */
    networks?: string[];
}

/**
 * Dep del LLM — MISMO contrato que `chatCompletion` de aiSdkService:
 * el fake de tests captura las opciones y devuelve `{text, provider}`.
 */
export type VariantGenerateFn = (
    options: ChatCompletionOptions,
) => Promise<ChatCompletionResult>;

/** Perfil editorial efectivo: bloque para el prompt + activeFormats. */
export type EditorialContextFn = (
    tenantId: string,
    programId?: string | null,
) => Promise<EditorialGenerationContext>;

export interface GenerateVariantsDeps {
    store?: NetworkVariantStore;
    generate?: VariantGenerateFn;
    /**
     * Default: `resolveEditorialPromptContext` (lazy). El brief lo llama
     * `editorialBlock`, pero el default de redes necesita `activeFormats`
     * además del bloque — una sola resolución devuelve ambos.
     */
    editorialContext?: EditorialContextFn;
    now?: () => Date;
}

export interface GenerateVariantsResult {
    publicationId: string;
    /** Lo persistido en `publications.contentVariants` (canonical + extras). */
    variants: ContentVariantsWithExtras;
    /** Menciones reales resueltas por red pedida (con personId). */
    mentionsResolved: Partial<Record<NetworkVariantKey, ResolvedMention[]>>;
    generatedAt: Date;
}

/** `generate` default: chatCompletion real — lazy, los tests nunca llegan. */
const defaultGenerate: VariantGenerateFn = async (options) => {
    const { chatCompletion } = await import('./aiSdkService.js');
    return chatCompletion(options);
};

/** `editorialContext` default: resolución real del perfil efectivo (lazy). */
const defaultEditorialContext: EditorialContextFn = async (tenantId, programId) => {
    const { resolveEditorialPromptContext } = await import(
        './editorialPromptService.js'
    );
    return resolveEditorialPromptContext(tenantId, programId);
};

/** Redes del default editorial: field keys de activeVariantKeys → redes. */
function defaultNetworks(
    activeFormats: readonly string[],
): NetworkVariantKey[] {
    const fields = activeVariantKeys(activeFormats);
    const networks = fields.map((f) => FIELD_TO_NETWORK[f]);
    return networks.length > 0 ? networks : [...NETWORK_VARIANT_KEYS];
}

/**
 * Genera las variantes por red de una publicación:
 *   publicación tenant-scoped → title+content requeridos → redes pedidas
 *   (o default editorial) → citas → personIds → social_links → menciones
 *   determinísticas por red → prompt (título+contenido+citas+handles
 *   reales+línea editorial) → LLM → parseo → canonical + extras → UPDATE
 *   de `content_variants`.
 *
 * Las menciones persistidas son SIEMPRE las resueltas: si el modelo
 * devolviera un campo `mentions` con handles inventados, se ignora.
 */
export async function generateVariants(
    input: GenerateVariantsInput,
    deps: GenerateVariantsDeps = {},
): Promise<GenerateVariantsResult> {
    const store = deps.store ?? createDrizzleNetworkVariantStore();
    const generate = deps.generate ?? defaultGenerate;
    const editorialContext = deps.editorialContext ?? defaultEditorialContext;
    const now = deps.now ?? (() => new Date());

    // Redes explícitas: validar ANTES de tocar la DB (fail fast — un
    // valor inválido es 422 sin lectura, como PF-06 valida el formato).
    let requestedNetworks: NetworkVariantKey[] | null = null;
    if (input.networks !== undefined && input.networks !== null) {
        if (!Array.isArray(input.networks)) {
            throw new AppError(
                'networks debe ser un array de redes válidas',
                422,
                'invalid_network',
            );
        }
        const valid: NetworkVariantKey[] = [];
        for (const n of input.networks) {
            if (
                typeof n !== 'string' ||
                !NETWORK_VARIANT_KEYS.includes(n as NetworkVariantKey)
            ) {
                throw new AppError(
                    `Red inválida: '${String(n)}'. Válidas: ${NETWORK_VARIANT_KEYS.join(', ')}`,
                    422,
                    'invalid_network',
                );
            }
            if (!valid.includes(n as NetworkVariantKey)) {
                valid.push(n as NetworkVariantKey);
            }
        }
        // `networks: []` = sin selección explícita ⇒ cae al default editorial.
        if (valid.length > 0) requestedNetworks = valid;
    }

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

    const title = publication.title?.trim() ?? '';
    const content = publication.content?.trim() ?? '';
    if (!title || !content) {
        throw new AppError(
            'La publicación no tiene título o contenido para generar variantes',
            422,
            'no_content',
        );
    }

    const quotes: AttributedQuote[] = Array.isArray(publication.quotes)
        ? (publication.quotes as AttributedQuote[])
        : [];

    // En paralelo: perfil editorial efectivo (bloque + formatos) y las
    // social_links de las personas citadas (tenant-scoped).
    const personIds = extractPersonIds(publication.quotes);
    const [editorial, personsWithLinks] = await Promise.all([
        editorialContext(input.tenantId, null),
        personIds.length > 0
            ? store.getPersonSocialLinks(input.tenantId, personIds)
            : Promise.resolve<PersonSocialLinks[]>([]),
    ]);

    const networks = requestedNetworks ?? defaultNetworks(editorial.activeFormats);

    // Menciones determinísticas por red pedida — el mapa va al prompt y,
    // aparte, a extras/mentionsResolved (el LLM nunca las genera).
    const mentionsByNetwork: Partial<Record<NetworkVariantKey, ResolvedMention[]>> =
        {};
    for (const network of networks) {
        mentionsByNetwork[network] = resolveMentions(personsWithLinks, network);
    }

    const prompt = buildVariantsPrompt({
        title,
        content,
        quotes,
        networks,
        mentions: mentionsByNetwork,
        editorialBlock: editorial.block,
    });

    const { text } = await generate({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: prompt,
        temperature: 0.6,
        maxTokens: 3000,
        jsonMode: true,
        usageContext: {
            tenantId: input.tenantId,
            feature: 'network-variants',
        },
    });

    const parsed = parseVariantsResponse(text, networks);

    // Shape canonical (compat): los campos pedidos toman el contenido del
    // modelo; los no pedidos quedan vacíos como en contentMultiplierService.
    // `extras` lleva una entrada por red PEDIDA (aunque el modelo no haya
    // devuelto su campo): hashtags del modelo + menciones determinísticas.
    const variants: ContentVariantsWithExtras = {
        twitterThread: [],
        instagramCarousel: [],
        linkedinPost: '',
        youtubeDescription: '',
        newsletterBlurb: '',
        extras: {},
    };
    for (const network of networks) {
        const field = NETWORK_TO_FIELD[network];
        const payload = parsed[field];
        if (payload) {
            if (field === 'twitterThread' || field === 'instagramCarousel') {
                variants[field] = Array.isArray(payload.content)
                    ? payload.content
                    : [payload.content];
            } else {
                variants[field] = Array.isArray(payload.content)
                    ? payload.content.join('\n')
                    : payload.content;
            }
        }
        variants.extras![network] = {
            hashtags: payload?.hashtags ?? [],
            mentions: (mentionsByNetwork[network] ?? []).map((m) => ({
                name: m.name,
                handle: m.handle,
            })),
        };
    }

    await store.updateContentVariants(
        input.publicationId,
        input.tenantId,
        variants,
    );

    return {
        publicationId: publication.id,
        variants,
        mentionsResolved: mentionsByNetwork,
        generatedAt: now(),
    };
}
