/**
 * Tests del slice PF-09: `networkVariantService` — variantes por red
 * (copy + hashtags del modelo) con menciones de handles REALES resueltas
 * determinísticamente desde `persons.social_links`, persistidas en
 * `publications.contentVariants` (shape canonical + `extras`).
 *
 * Deterministas, mismo estilo que noteFactory/quoteFlyers: store en
 * memoria con los mismos filtros por tenant que la impl drizzle, LLM
 * FAKE que captura el prompt y devuelve JSON fijo (¡NUNCA el provider
 * real!), `editorialContext`/`now` inyectados.
 *
 * REGLA DE ORO verificada: los handles de `extras.mentions` salen
 * SIEMPRE de socialLinks — aunque el modelo devuelva un campo
 * `mentions` con handles inventados, se ignora.
 *
 * Cubre el brief:
 *   - resolveMentions: 'x' antes que 'twitter', normalización '@'
 *     (faltante/URL/@+), sin handle en la red → no aparece, dedupe por
 *     handle, newsletter → [].
 *   - extractPersonIds: únicos, nulls/no-strings fuera, no-array → [].
 *   - generateVariants: persistido = canonical + extras (hashtags del
 *     modelo + mentions REALES); redes pedidas ⊆ válidas; default
 *     editorial vía activeFormats; errores publication_not_found /
 *     no_content / invalid_network / invalid_model_response; aislamiento
 *     por tenant; reemplazo completo de la columna.
 *   - POST /api/publications/:id/variants → 201/400/404/422.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de auth (mismo contrato que quoteFlyers.test.ts) ────────────
vi.mock('../src/server/middleware/auth.js', async (io) => {
    const actual = await io<typeof import('../src/server/middleware/auth.js')>();
    const fakeRequireAuth = (req: Request, res: Response, next: NextFunction): void => {
        const tenant = req.headers['x-test-tenant'];
        if (typeof tenant !== 'string' || tenant.length === 0) {
            res.status(401).json({ error: 'Token de autenticacion requerido' });
            return;
        }
        req.auth = {
            userId: '00000000-0000-4000-8000-000000000011',
            activeTenantId: tenant,
            tenantId: tenant,
            email: 'test@example.com',
            role: 'owner',
        };
        next();
    };
    return { ...actual, requireAuth: fakeRequireAuth };
});

import {
    buildVariantsPrompt,
    extractPersonIds,
    generateVariants,
    normalizeHandle,
    parseVariantsResponse,
    resolveMentions,
    NETWORK_HANDLE_KEYS,
    type GenerateVariantsDeps,
    type PersonSocialLinks,
    type VariantGenerateFn,
} from '../src/server/services/networkVariantService';
import type { AttributedQuote } from '../src/server/services/attributedQuotesService';
import type {
    ChatCompletionOptions,
    ContentVariantsWithExtras,
} from '../src/shared/types';
import {
    publicationsRouter,
    publicationsRouteDeps,
} from '../src/server/routes/publications';
import {
    createMemoryNetworkVariantStore,
    seedVariantPerson,
    seedVariantPublication,
    type MemoryNetworkVariantState,
} from './helpers/memoryNetworkVariantStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const PUB_1 = '00000000-0000-4000-8000-00000000aaa1';
const PUB_B = '00000000-0000-4000-8000-00000000bbb1';
const PERSON_1 = '00000000-0000-4000-8000-00000000ccc1';
const PERSON_2 = '00000000-0000-4000-8000-00000000ccc2';
const PERSON_3 = '00000000-0000-4000-8000-00000000ccc3';
const NOW = new Date('2026-03-03T12:00:00Z');

const EMPTY_EDITORIAL = { block: '', activeFormats: [] as string[], tone: null };

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeQuote(over: Partial<AttributedQuote> = {}): AttributedQuote {
    return {
        momentId: 'm-1',
        text: 'La inflación es el problema central de la economía.',
        startMs: 70_000,
        endMs: 74_000,
        score: null,
        reason: 'quote',
        speakerLabel: 'Speaker A',
        personId: PERSON_1,
        personName: 'María Pérez',
        personPhotoUrl: null,
        attribution: 'person',
        ...over,
    };
}

function person(over: Partial<PersonSocialLinks> = {}): PersonSocialLinks {
    return {
        id: PERSON_1,
        name: 'María Pérez',
        socialLinks: {},
        ...over,
    };
}

/** Respuesta JSON del LLM fake — shape del contrato por campo. */
const FAKE_LLM_JSON = JSON.stringify({
    twitterThread: {
        tweets: ['Tweet 1 del hilo', 'Tweet 2 del hilo'],
        hashtags: ['#economia', 'argentina'],
    },
    instagramCarousel: {
        slides: ['Slide hook', 'Slide datos', 'Slide CTA'],
        hashtags: ['#noticias'],
    },
    linkedinPost: {
        post: 'Post profesional de LinkedIn con datos.',
        hashtags: ['#periodismo'],
    },
    youtubeDescription: {
        desc: 'Descripción SEO de YouTube. 0:00 intro.',
        hashtags: ['#video'],
    },
    newsletterBlurb: {
        blurb: 'Blurb cercano del newsletter con CTA.',
        hashtags: [],
    },
});

interface GenerateCall {
    options: ChatCompletionOptions;
}

/** Deps fake deterministas — generate captura opciones, editorial vacía. */
function makeDeps(
    store: ReturnType<typeof createMemoryNetworkVariantStore>['store'],
    overrides: Partial<GenerateVariantsDeps> = {},
) {
    const calls: GenerateCall[] = [];
    const generate: VariantGenerateFn = async (options) => {
        calls.push({ options });
        return { text: FAKE_LLM_JSON, provider: 'deepseek' };
    };
    const deps: GenerateVariantsDeps = {
        store,
        generate,
        editorialContext: async () => EMPTY_EDITORIAL,
        now: () => NOW,
        ...overrides,
    };
    return { deps, calls };
}

// ─── normalizeHandle (pura) ───────────────────────────────────────────────────

describe('normalizeHandle', () => {
    it('agrega @ si falta; mantiene uno solo si ya viene', () => {
        expect(normalizeHandle('maria')).toBe('@maria');
        expect(normalizeHandle('@maria')).toBe('@maria');
        expect(normalizeHandle('@@maria')).toBe('@maria');
    });

    it('extrae el último segmento de una URL (con o sin protocolo)', () => {
        expect(normalizeHandle('https://x.com/maria')).toBe('@maria');
        expect(normalizeHandle('x.com/maria')).toBe('@maria');
        expect(normalizeHandle('https://instagram.com/@maria/')).toBe('@maria');
        expect(normalizeHandle('https://x.com/maria?ref=1')).toBe('@maria');
    });

    it('vacío o sin handle usable → null', () => {
        expect(normalizeHandle('')).toBeNull();
        expect(normalizeHandle('   ')).toBeNull();
        expect(normalizeHandle('https://x.com/')).toBeNull();
        expect(normalizeHandle('@')).toBeNull();
    });
});

// ─── resolveMentions (pura) ───────────────────────────────────────────────────

describe('resolveMentions', () => {
    it("'x' gana sobre 'twitter' en la key list de la red", () => {
        const out = resolveMentions(
            [
                person({
                    socialLinks: { twitter: '@viejo', x: '@nuevo' },
                }),
            ],
            'twitter',
        );
        expect(out).toEqual([
            { personId: PERSON_1, name: 'María Pérez', handle: '@nuevo' },
        ]);
    });

    it('usa twitter si no hay x; normaliza @ en todos los casos', () => {
        const out = resolveMentions(
            [
                person({ socialLinks: { twitter: 'maria_tw' } }),
                person({
                    id: PERSON_2,
                    name: 'Juan García',
                    socialLinks: { x: 'https://x.com/juang' },
                }),
            ],
            'twitter',
        );
        expect(out.map((m) => m.handle)).toEqual(['@maria_tw', '@juang']);
    });

    it('persona sin handle en la red → no aparece', () => {
        const out = resolveMentions(
            [
                person({
                    socialLinks: { instagram: '@maria_ig', web: 'x.com/maria' },
                }),
            ],
            'twitter',
        );
        expect(out).toEqual([]);
    });

    it('deduplica por handle (case-insensitive): dos personas, mismo @ → la primera', () => {
        const out = resolveMentions(
            [
                person({ socialLinks: { x: '@Mismo' } }),
                person({
                    id: PERSON_2,
                    name: 'Juan García',
                    socialLinks: { twitter: '@mismo' },
                }),
            ],
            'twitter',
        );
        expect(out).toHaveLength(1);
        expect(out[0].personId).toBe(PERSON_1);
        expect(out[0].handle).toBe('@Mismo');
    });

    it('newsletter nunca tiene menciones (key list vacía)', () => {
        const out = resolveMentions(
            [person({ socialLinks: { x: '@maria', email: 'm@m.com' } })],
            'newsletter',
        );
        expect(out).toEqual([]);
        expect(NETWORK_HANDLE_KEYS.newsletter).toEqual([]);
    });

    it('socialLinks no-objeto o null → no rompe, no aparece', () => {
        for (const socialLinks of [null, 'string', 42, ['x']]) {
            expect(
                resolveMentions([person({ socialLinks })], 'instagram'),
            ).toEqual([]);
        }
    });
});

// ─── extractPersonIds (pura) ──────────────────────────────────────────────────

describe('extractPersonIds', () => {
    it('personIds únicos, en orden de aparición; nulls y no-strings fuera', () => {
        const quotes = [
            makeQuote({ personId: PERSON_1 }),
            makeQuote({ personId: PERSON_2 }),
            makeQuote({ personId: PERSON_1 }), // duplicado
            makeQuote({ personId: null }), // sin atribuir
            { personId: 42 }, // no-string
            'no-soy-objeto',
        ];
        expect(extractPersonIds(quotes)).toEqual([PERSON_1, PERSON_2]);
    });

    it('no-array, null u objetos → []', () => {
        expect(extractPersonIds(null)).toEqual([]);
        expect(extractPersonIds('str')).toEqual([]);
        expect(extractPersonIds({ personId: PERSON_1 })).toEqual([]);
        expect(extractPersonIds([])).toEqual([]);
    });
});

// ─── parseVariantsResponse (pura) ─────────────────────────────────────────────

describe('parseVariantsResponse', () => {
    it('extrae contenido + hashtags por campo pedido; normaliza #', () => {
        const out = parseVariantsResponse(FAKE_LLM_JSON, ['twitter', 'linkedin']);
        expect(out.twitterThread).toEqual({
            content: ['Tweet 1 del hilo', 'Tweet 2 del hilo'],
            hashtags: ['#economia', '#argentina'],
        });
        expect(out.linkedinPost).toEqual({
            content: 'Post profesional de LinkedIn con datos.',
            hashtags: ['#periodismo'],
        });
        // Red no pedida → no se parsea aunque venga en el JSON.
        expect(out.instagramCarousel).toBeUndefined();
    });

    it('JSON inválido → invalid_model_response 502', () => {
        try {
            parseVariantsResponse('esto no es json', ['twitter']);
            expect.unreachable('debió lanzar invalid_model_response');
        } catch (e) {
            expect(e).toMatchObject({
                statusCode: 502,
                code: 'invalid_model_response',
            });
        }
    });

    it('JSON válido pero sin ningún campo pedido → invalid_model_response', () => {
        try {
            parseVariantsResponse('{"otraCosa": 1}', ['twitter', 'youtube']);
            expect.unreachable('debió lanzar invalid_model_response');
        } catch (e) {
            expect(e).toMatchObject({ code: 'invalid_model_response' });
        }
    });

    it('tolera campo como array/string pelado (modelo sin wrapper)', () => {
        const out = parseVariantsResponse(
            JSON.stringify({
                twitterThread: ['t1', 't2'],
                linkedinPost: 'post pelado',
            }),
            ['twitter', 'linkedin'],
        );
        expect(out.twitterThread).toEqual({ content: ['t1', 't2'], hashtags: [] });
        expect(out.linkedinPost).toEqual({ content: 'post pelado', hashtags: [] });
    });
});

// ─── buildVariantsPrompt (pura) ───────────────────────────────────────────────

describe('buildVariantsPrompt', () => {
    it('incluye título, nota, citas con autor, handles reales y editorial', () => {
        const prompt = buildVariantsPrompt({
            title: 'Título X',
            content: 'Cuerpo de la nota',
            quotes: [makeQuote()],
            networks: ['twitter', 'newsletter'],
            mentions: {
                twitter: [
                    { personId: PERSON_1, name: 'María Pérez', handle: '@maria_ok' },
                ],
            },
            editorialBlock: 'LINEA EDITORIAL DEL CANAL: sobria',
        });
        expect(prompt).toContain('LINEA EDITORIAL DEL CANAL: sobria');
        expect(prompt).toContain('Título: Título X');
        expect(prompt).toContain('Nota: Cuerpo de la nota');
        expect(prompt).toContain('— María Pérez');
        expect(prompt).toContain('@maria_ok (María Pérez)');
        expect(prompt).toContain('"twitterThread"');
        expect(prompt).toContain('"newsletterBlurb"');
        // Sólo los campos pedidos en el contrato del JSON.
        expect(prompt).not.toContain('"linkedinPost"');
    });
});

// ─── generateVariants (flujo completo con deps fake) ─────────────────────────

describe('generateVariants', () => {
    it('persiste canonical + extras con las mentions REALES de socialLinks (no las del LLM)', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote(), makeQuote({ personId: PERSON_2 })],
        });
        seedVariantPerson(state, {
            id: PERSON_1,
            tenantId: T_A,
            name: 'María Pérez',
            socialLinks: { x: 'maria_x', instagram: '@maria_ig' },
        });
        seedVariantPerson(state, {
            id: PERSON_2,
            tenantId: T_A,
            name: 'Juan García',
            socialLinks: { twitter: 'https://x.com/juang', linkedin: 'juan-li' },
        });
        // El modelo "tramposo" devuelve mentions inventadas + copy + hashtags.
        const generate: VariantGenerateFn = async () => ({
            text: JSON.stringify({
                twitterThread: {
                    tweets: ['T1 con @handle_inventado'],
                    hashtags: ['#eco'],
                    mentions: [{ name: 'Fake', handle: '@handle_inventado' }],
                },
            }),
            provider: 'deepseek',
        });
        const { deps } = makeDeps(store, { generate });

        const result = await generateVariants(
            { tenantId: T_A, publicationId: PUB_1, networks: ['twitter'] },
            deps,
        );

        expect(result.publicationId).toBe(PUB_1);
        expect(result.generatedAt).toBe(NOW);

        const persisted = state.publications[0]
            .contentVariants as ContentVariantsWithExtras;
        // Shape canonical compat: array de tweets + el resto vacío.
        expect(persisted.twitterThread).toEqual(['T1 con @handle_inventado']);
        expect(persisted.instagramCarousel).toEqual([]);
        expect(persisted.linkedinPost).toBe('');
        // extras.twitter: hashtags del modelo + mentions REALES resueltas.
        expect(persisted.extras?.twitter).toEqual({
            hashtags: ['#eco'],
            mentions: [
                { name: 'María Pérez', handle: '@maria_x' },
                { name: 'Juan García', handle: '@juang' },
            ],
        });
        // Sólo la red pedida aparece en extras.
        expect(Object.keys(persisted.extras ?? {})).toEqual(['twitter']);
        // mentionsResolved lleva el personId (info completa de la resolución).
        expect(result.mentionsResolved.twitter).toEqual([
            { personId: PERSON_1, name: 'María Pérez', handle: '@maria_x' },
            { personId: PERSON_2, name: 'Juan García', handle: '@juang' },
        ]);
        // Lo devuelto es exactamente lo persistido.
        expect(result.variants).toEqual(persisted);
    });

    it('sin networks → default de la línea editorial (activeFormats sociales)', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, { id: PUB_1, tenantId: T_A });
        const { deps, calls } = makeDeps(store, {
            editorialContext: async () => ({
                block: 'LINEA EDITORIAL',
                activeFormats: ['twitter', 'linkedin', 'corta'],
                tone: 'formal',
            }),
        });

        const result = await generateVariants(
            { tenantId: T_A, publicationId: PUB_1 },
            deps,
        );

        expect(Object.keys(result.variants.extras ?? {}).sort()).toEqual([
            'linkedin',
            'twitter',
        ]);
        expect(result.variants.twitterThread).toEqual([
            'Tweet 1 del hilo',
            'Tweet 2 del hilo',
        ]);
        expect(result.variants.linkedinPost).toBe(
            'Post profesional de LinkedIn con datos.',
        );
        // El prompt pidió sólo esos campos + llevó la línea editorial.
        const prompt = calls[0].options.userPrompt;
        expect(prompt).toContain('"twitterThread"');
        expect(prompt).toContain('"linkedinPost"');
        expect(prompt).not.toContain('"instagramCarousel"');
        expect(prompt).toContain('LINEA EDITORIAL');
        expect(state.publications[0].contentVariants).toEqual(result.variants);
    });

    it('sin perfil (activeFormats vacío) → las 5 redes', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, { id: PUB_1, tenantId: T_A });
        const { deps } = makeDeps(store);

        const result = await generateVariants(
            { tenantId: T_A, publicationId: PUB_1 },
            deps,
        );

        expect(Object.keys(result.variants.extras ?? {}).sort()).toEqual([
            'instagram',
            'linkedin',
            'newsletter',
            'twitter',
            'youtube',
        ]);
        expect(result.variants.newsletterBlurb).toBe(
            'Blurb cercano del newsletter con CTA.',
        );
        // Newsletter pedida pero sin menciones posibles.
        expect(result.variants.extras?.newsletter?.mentions).toEqual([]);
    });

    it('networks: [] → cae al default (todas, sin perfil)', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, { id: PUB_1, tenantId: T_A });
        const { deps } = makeDeps(store);

        const result = await generateVariants(
            { tenantId: T_A, publicationId: PUB_1, networks: [] },
            deps,
        );
        expect(Object.keys(result.variants.extras ?? {})).toHaveLength(5);
    });

    it('red inválida → invalid_network 422, sin tocar DB ni llamar al modelo', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, { id: PUB_1, tenantId: T_A });
        const { deps, calls } = makeDeps(store);

        await expect(
            generateVariants(
                { tenantId: T_A, publicationId: PUB_1, networks: ['tiktok'] },
                deps,
            ),
        ).rejects.toMatchObject({ statusCode: 422, code: 'invalid_network' });
        await expect(
            generateVariants(
                {
                    tenantId: T_A,
                    publicationId: PUB_1,
                    networks: ['twitter', 'myspace'],
                },
                deps,
            ),
        ).rejects.toMatchObject({ code: 'invalid_network' });
        expect(calls).toHaveLength(0);
        expect(state.publications[0].contentVariants).toBeNull();
    });

    it('publicación inexistente o ajena → publication_not_found 404', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, { id: PUB_B, tenantId: T_B });
        const { deps, calls } = makeDeps(store);

        await expect(
            generateVariants({ tenantId: T_A, publicationId: PUB_B }, deps),
        ).rejects.toMatchObject({
            statusCode: 404,
            code: 'publication_not_found',
        });
        await expect(
            generateVariants(
                { tenantId: T_A, publicationId: 'no-existe' },
                deps,
            ),
        ).rejects.toMatchObject({ code: 'publication_not_found' });
        expect(calls).toHaveLength(0);
        expect(state.publications[0].contentVariants).toBeNull();
    });

    it('sin título o sin contenido → no_content 422, sin llamar al modelo', async () => {
        for (const bad of [
            { title: null, content: 'hay cuerpo' },
            { title: 'Título', content: null },
            { title: '  ', content: 'hay cuerpo' },
            { title: 'Título', content: '   ' },
        ]) {
            const { store, state } = createMemoryNetworkVariantStore();
            seedVariantPublication(state, {
                id: PUB_1,
                tenantId: T_A,
                ...bad,
            });
            const { deps, calls } = makeDeps(store);
            await expect(
                generateVariants({ tenantId: T_A, publicationId: PUB_1 }, deps),
            ).rejects.toMatchObject({ statusCode: 422, code: 'no_content' });
            expect(calls).toHaveLength(0);
        }
    });

    it('el modelo devuelve basura → invalid_model_response 502, sin escritura', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, { id: PUB_1, tenantId: T_A });
        const { deps } = makeDeps(store, {
            generate: async () => ({ text: 'no json at all', provider: 'deepseek' }),
        });

        await expect(
            generateVariants({ tenantId: T_A, publicationId: PUB_1 }, deps),
        ).rejects.toMatchObject({
            statusCode: 502,
            code: 'invalid_model_response',
        });
        expect(state.publications[0].contentVariants).toBeNull();
    });

    it('persona citada de OTRO tenant → su handle no se resuelve (aislamiento)', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote()],
        });
        // La persona existe pero es de tenant-b → getPersonSocialLinks no la ve.
        seedVariantPerson(state, {
            id: PERSON_1,
            tenantId: T_B,
            name: 'María Pérez',
            socialLinks: { x: '@maria_ajena' },
        });
        const { deps } = makeDeps(store);

        const result = await generateVariants(
            { tenantId: T_A, publicationId: PUB_1, networks: ['twitter'] },
            deps,
        );

        expect(result.mentionsResolved.twitter).toEqual([]);
        const persisted = state.publications[0]
            .contentVariants as ContentVariantsWithExtras;
        expect(persisted.extras?.twitter?.mentions).toEqual([]);
    });

    it('reemplaza variants anteriores (corrida regenerable, no merge)', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            contentVariants: {
                twitterThread: ['viejo'],
                instagramCarousel: [],
                linkedinPost: '',
                youtubeDescription: '',
                newsletterBlurb: '',
                extras: { twitter: { hashtags: ['#viejo'], mentions: [] } },
            },
        });
        const { deps } = makeDeps(store);

        const result = await generateVariants(
            { tenantId: T_A, publicationId: PUB_1, networks: ['youtube'] },
            deps,
        );

        const persisted = state.publications[0]
            .contentVariants as ContentVariantsWithExtras;
        expect(persisted.twitterThread).toEqual([]); // viejo pisado
        expect(persisted.youtubeDescription).toBe(
            'Descripción SEO de YouTube. 0:00 intro.',
        );
        expect(Object.keys(persisted.extras ?? {})).toEqual(['youtube']);
        expect(result.variants).toEqual(persisted);
    });

    it('el prompt al modelo lleva citas atribuidas y los handles REALES por red', async () => {
        const { store, state } = createMemoryNetworkVariantStore();
        seedVariantPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote()],
        });
        seedVariantPerson(state, {
            id: PERSON_1,
            tenantId: T_A,
            name: 'María Pérez',
            socialLinks: { x: '@maria_real' },
        });
        const { deps, calls } = makeDeps(store);

        await generateVariants(
            { tenantId: T_A, publicationId: PUB_1, networks: ['twitter'] },
            deps,
        );

        expect(calls).toHaveLength(1);
        const { options } = calls[0];
        expect(options.jsonMode).toBe(true);
        expect(options.systemPrompt).toContain('NUNCA inventes handles');
        expect(options.userPrompt).toContain('@maria_real (María Pérez)');
        expect(options.userPrompt).toContain('— María Pérez');
        expect(options.userPrompt).toContain('Título de la nota');
    });
});

// ─── POST /api/publications/:id/variants (HTTP, app efímera) ─────────────────

describe('POST /api/publications/:id/variants', () => {
    let server: Server;
    let baseUrl: string;
    let state: MemoryNetworkVariantState;
    let calls: GenerateCall[];

    const variantsUrl = (id: string) => `${baseUrl}/api/publications/${id}/variants`;
    const authHeaders = (tenant?: string) =>
        tenant ? { 'x-test-tenant': tenant } : {};
    const postJson = (url: string, body: unknown, tenant?: string) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders(tenant) },
            body: JSON.stringify(body),
        });

    beforeEach(async () => {
        const mem = createMemoryNetworkVariantStore();
        state = mem.state;
        seedVariantPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote()],
        });
        seedVariantPerson(state, {
            id: PERSON_1,
            tenantId: T_A,
            name: 'María Pérez',
            socialLinks: { x: '@maria_real' },
        });
        // Publicación de OTRO tenant: existe pero es ajena.
        seedVariantPublication(state, { id: PUB_B, tenantId: T_B });
        // Publicación propia sin contenido → no_content.
        seedVariantPublication(state, {
            id: 'pub-vacia',
            tenantId: T_A,
            title: null,
            content: null,
        });

        calls = [];
        publicationsRouteDeps.variantsStore = mem.store;
        publicationsRouteDeps.generate = async (options) => {
            calls.push({ options });
            return { text: FAKE_LLM_JSON, provider: 'deepseek' };
        };
        publicationsRouteDeps.editorialContext = async () => EMPTY_EDITORIAL;
        publicationsRouteDeps.now = () => NOW;

        const app = express();
        app.use(express.json());
        app.use('/api/publications', publicationsRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        publicationsRouteDeps.variantsStore = undefined;
        publicationsRouteDeps.generate = undefined;
        publicationsRouteDeps.editorialContext = undefined;
        publicationsRouteDeps.now = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sin autenticación → 401', async () => {
        const res = await postJson(variantsUrl(PUB_1), {});
        expect(res.status).toBe(401);
    });

    it('201: genera y devuelve {publicationId, variants, mentionsResolved}', async () => {
        const res = await postJson(
            variantsUrl(PUB_1),
            { networks: ['twitter'] },
            T_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.publicationId).toBe(PUB_1);
        expect(json.variants.twitterThread).toEqual([
            'Tweet 1 del hilo',
            'Tweet 2 del hilo',
        ]);
        expect(json.variants.extras.twitter.mentions).toEqual([
            { name: 'María Pérez', handle: '@maria_real' },
        ]);
        expect(json.variants.extras.twitter.hashtags).toEqual([
            '#economia',
            '#argentina',
        ]);
        expect(json.mentionsResolved.twitter[0].personId).toBe(PERSON_1);
        // Persistido en la "columna".
        const persisted = state.publications[0]
            .contentVariants as ContentVariantsWithExtras;
        expect(persisted.extras?.twitter?.mentions).toEqual([
            { name: 'María Pérez', handle: '@maria_real' },
        ]);
        expect(calls).toHaveLength(1);
    });

    it('201 sin body.networks → default (todas las redes sin perfil)', async () => {
        const res = await postJson(variantsUrl(PUB_1), {}, T_A);
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(Object.keys(json.variants.extras)).toHaveLength(5);
    });

    it('400: networks no es array de strings', async () => {
        for (const bad of [
            { networks: 'twitter' },
            { networks: 42 },
            { networks: ['twitter', 5] },
            { networks: { twitter: true } },
        ]) {
            const res = await postJson(variantsUrl(PUB_1), bad, T_A);
            expect(res.status).toBe(400);
        }
        expect(calls).toHaveLength(0);
    });

    it('404: publicación ajena al tenant (sin leak ni escritura)', async () => {
        const res = await postJson(variantsUrl(PUB_B), {}, T_A);
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.code).toBe('publication_not_found');
        expect(state.publications[1].contentVariants).toBeNull();
        expect(calls).toHaveLength(0);
    });

    it('422: red inválida y publicación sin contenido', async () => {
        const resNet = await postJson(
            variantsUrl(PUB_1),
            { networks: ['tiktok'] },
            T_A,
        );
        expect(resNet.status).toBe(422);
        expect((await resNet.json()).code).toBe('invalid_network');

        const resEmpty = await postJson(variantsUrl('pub-vacia'), {}, T_A);
        expect(resEmpty.status).toBe(422);
        expect((await resEmpty.json()).code).toBe('no_content');
        expect(calls).toHaveLength(0);
    });

    it('502: el modelo devolvió basura → invalid_model_response', async () => {
        publicationsRouteDeps.generate = async () => ({
            text: '<html>500</html>',
            provider: 'deepseek',
        });
        const res = await postJson(variantsUrl(PUB_1), {}, T_A);
        expect(res.status).toBe(502);
        expect((await res.json()).code).toBe('invalid_model_response');
    });
});
