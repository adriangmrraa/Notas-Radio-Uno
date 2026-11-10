/**
 * Tests del slice PF-07: `quoteFlyerService` — quote-cards 1080x1080 con
 * la foto REAL de la persona detectada, appendeados a
 * `publications.quote_flyer_paths`.
 *
 * Deterministas, mismo estilo que noteFactory/attributedQuotes: store en
 * memoria con los mismos filtros por tenant que la impl drizzle,
 * `renderFlyer` FAKE que captura args y devuelve paths sintéticos (¡NUNCA
 * el canvas real!), `loadBranding`/`now` inyectados.
 *
 * Cubre el brief:
 *   - flyer por cita con personId → renderFlyer recibe el shape del canvas
 *     ({text, speaker, role, confidence}), el Buffer de photoData y el
 *     branding del tenant.
 *   - cita sin personId → skip, no llama renderFlyer.
 *   - persona sin foto → photoData null al render (default) / skip con
 *     onlyPersonsWithPhotos — nunca placeholder.
 *   - foto primaria primero; sin primaria, la más antigua.
 *   - appendFlyerPaths concatena sin pisar paths previos.
 *   - publication_not_found / no_quotes / aislamiento por tenant.
 *   - POST /api/publications/:id/quote-flyers → 201/400/404/422.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de auth (mismo contrato que noteFactory.test.ts) ────────────
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

import { AppError } from '../src/server/lib/errors';
import {
    generateQuoteFlyers,
    toFlyerQuote,
    type GenerateQuoteFlyersDeps,
    type RenderFlyerFn,
} from '../src/server/services/quoteFlyerService';
import type { AttributedQuote } from '../src/server/services/attributedQuotesService';
import type { BrandingConfig } from '../src/shared/types';
import {
    publicationsRouter,
    publicationsRouteDeps,
} from '../src/server/routes/publications';
import {
    createMemoryQuoteFlyerStore,
    seedPersonPhoto,
    seedQuoteFlyerPublication,
    type MemoryQuoteFlyerState,
} from './helpers/memoryQuoteFlyerStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const PUB_1 = '00000000-0000-4000-8000-00000000aaa1';
const PUB_B = '00000000-0000-4000-8000-00000000bbb1';
const PERSON_1 = '00000000-0000-4000-8000-00000000ccc1';
const PERSON_2 = '00000000-0000-4000-8000-00000000ccc2';
const PERSON_NO_PHOTO = '00000000-0000-4000-8000-00000000ccc3';
const PHOTO_1 = Buffer.from('foto-real-de-maria');
const NOW = new Date('2026-03-02T12:00:00Z');

const BRANDING: BrandingConfig = {
    logoBuffer: Buffer.from('logo'),
    platformName: 'Canal Test',
    fontFamily: 'bebas_kai',
    templateId: 'dark_gradient',
};

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
        personPhotoUrl: '/api/persons/p-1/photos/ph-1',
        attribution: 'person',
        ...over,
    };
}

interface RenderCall {
    quote: ReturnType<typeof toFlyerQuote>;
    photoData: Buffer | null;
    branding: BrandingConfig | null;
}

/** Deps fake deterministas — renderFlyer captura, nada toca canvas ni DB. */
function makeDeps(store: ReturnType<typeof createMemoryQuoteFlyerStore>['store']) {
    const calls: RenderCall[] = [];
    let seq = 0;
    const renderFlyer: RenderFlyerFn = async (quote, photoData, branding) => {
        calls.push({ quote, photoData, branding });
        return `output/quote_fake_${++seq}.jpg`;
    };
    const deps: GenerateQuoteFlyersDeps = {
        store,
        renderFlyer,
        loadBranding: async () => BRANDING,
        now: () => NOW,
    };
    return { deps, calls };
}

// ─── toFlyerQuote (pura) ──────────────────────────────────────────────────────

describe('toFlyerQuote', () => {
    it('mapea al shape del canvas: text, speaker=personName, role vacío', () => {
        expect(toFlyerQuote(makeQuote())).toEqual({
            text: 'La inflación es el problema central de la economía.',
            speaker: 'María Pérez',
            role: '',
            confidence: 'medium',
        });
    });

    it('sin personName cae al speakerLabel; sin identidad → fallback', () => {
        expect(
            toFlyerQuote(makeQuote({ personName: null })).speaker,
        ).toBe('Speaker A');
        expect(
            toFlyerQuote(makeQuote({ personName: null, speakerLabel: null })).speaker,
        ).toBe('Vocero sin identificar');
    });

    it('text null → string vacío (el canvas hace split sobre text)', () => {
        expect(toFlyerQuote(makeQuote({ text: null })).text).toBe('');
    });
});

// ─── generateQuoteFlyers (flujo completo con deps fake) ──────────────────────

describe('generateQuoteFlyers', () => {
    it('un flyer por cita con personId: render recibe shape, foto real y branding', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [
                makeQuote(),
                makeQuote({
                    momentId: 'm-2',
                    text: 'Segunda cita de otra persona.',
                    personId: PERSON_2,
                    personName: 'Juan García',
                }),
            ],
        });
        seedPersonPhoto(state, {
            tenantId: T_A,
            personId: PERSON_1,
            photoData: PHOTO_1,
            isPrimary: true,
        });
        const { deps, calls } = makeDeps(store);

        const result = await generateQuoteFlyers(
            { tenantId: T_A, publicationId: PUB_1 },
            deps,
        );

        expect(result.publicationId).toBe(PUB_1);
        expect(result.skipped).toBe(0);
        expect(result.generatedAt).toBe(NOW);
        expect(result.flyers).toEqual([
            { quoteIndex: 0, personId: PERSON_1, path: 'output/quote_fake_1.jpg' },
            { quoteIndex: 1, personId: PERSON_2, path: 'output/quote_fake_2.jpg' },
        ]);

        // renderFlyer recibió (quoteShape, photoData, branding) — el Buffer
        // de la foto REAL de María, no una URL ni un placeholder.
        expect(calls).toHaveLength(2);
        expect(calls[0].quote).toEqual({
            text: 'La inflación es el problema central de la economía.',
            speaker: 'María Pérez',
            role: '',
            confidence: 'medium',
        });
        expect(calls[0].photoData).toBe(PHOTO_1);
        expect(calls[0].branding).toBe(BRANDING);
        // Persona sin fotos → photoData null (el canvas decide).
        expect(calls[1].photoData).toBeNull();

        // Los paths se appendearon al jsonb de la publicación.
        expect(state.publications[0].quoteFlyerPaths).toEqual([
            'output/quote_fake_1.jpg',
            'output/quote_fake_2.jpg',
        ]);
    });

    it('cita sin personId → skip: no llama renderFlyer ni getPersonPhoto', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [
                makeQuote(),
                makeQuote({
                    momentId: 'm-2',
                    personId: null,
                    personName: null,
                    attribution: 'speaker',
                }),
            ],
        });
        seedPersonPhoto(state, {
            tenantId: T_A,
            personId: PERSON_1,
            photoData: PHOTO_1,
        });
        const { deps, calls } = makeDeps(store);

        const result = await generateQuoteFlyers(
            { tenantId: T_A, publicationId: PUB_1 },
            deps,
        );

        expect(result.skipped).toBe(1);
        expect(result.flyers).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(state.publications[0].quoteFlyerPaths).toEqual([
            'output/quote_fake_1.jpg',
        ]);
    });

    it('persona sin foto (default) → flyer igual con photoData=null, nunca placeholder', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote({ personId: PERSON_NO_PHOTO })],
        });
        const { deps, calls } = makeDeps(store);

        const result = await generateQuoteFlyers(
            { tenantId: T_A, publicationId: PUB_1 },
            deps,
        );

        expect(result.skipped).toBe(0);
        expect(result.flyers).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0].photoData).toBeNull();
    });

    it('onlyPersonsWithPhotos=true → persona sin foto se saltea', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [
                makeQuote({ personId: PERSON_NO_PHOTO }),
                makeQuote({ momentId: 'm-2', personId: PERSON_1 }),
            ],
        });
        seedPersonPhoto(state, {
            tenantId: T_A,
            personId: PERSON_1,
            photoData: PHOTO_1,
        });
        const { deps, calls } = makeDeps(store);

        const result = await generateQuoteFlyers(
            { tenantId: T_A, publicationId: PUB_1, onlyPersonsWithPhotos: true },
            deps,
        );

        expect(result.skipped).toBe(1);
        expect(result.flyers).toHaveLength(1);
        expect(result.flyers[0].personId).toBe(PERSON_1);
        expect(calls).toHaveLength(1);
        expect(calls[0].photoData).toBe(PHOTO_1);
    });

    it('foto REAL: primaria primero; sin primaria, la más antigua', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        const OLD = Buffer.from('foto-vieja');
        const PRIMARY = Buffer.from('foto-primaria');
        const NEW = Buffer.from('foto-nueva');
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [
                makeQuote({ personId: PERSON_1 }),
                makeQuote({ momentId: 'm-2', personId: PERSON_2 }),
            ],
        });
        // PERSON_1: primaria creada DESPUÉS de una vieja → gana la primaria.
        seedPersonPhoto(state, {
            tenantId: T_A, personId: PERSON_1, photoData: OLD, createdAt: 1,
        });
        seedPersonPhoto(state, {
            tenantId: T_A, personId: PERSON_1, photoData: PRIMARY,
            isPrimary: true, createdAt: 2,
        });
        // PERSON_2: dos no-primarias → gana la más antigua.
        seedPersonPhoto(state, {
            tenantId: T_A, personId: PERSON_2, photoData: NEW, createdAt: 10,
        });
        seedPersonPhoto(state, {
            tenantId: T_A, personId: PERSON_2, photoData: OLD, createdAt: 5,
        });
        const { deps, calls } = makeDeps(store);

        await generateQuoteFlyers({ tenantId: T_A, publicationId: PUB_1 }, deps);

        expect(calls[0].photoData).toBe(PRIMARY);
        expect(calls[1].photoData).toBe(OLD);
    });

    it('appendFlyerPaths concatena sin pisar paths de corridas anteriores', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote()],
            quoteFlyerPaths: ['output/quote_previo.jpg'],
        });
        const { deps } = makeDeps(store);

        await generateQuoteFlyers({ tenantId: T_A, publicationId: PUB_1 }, deps);

        expect(state.publications[0].quoteFlyerPaths).toEqual([
            'output/quote_previo.jpg',
            'output/quote_fake_1.jpg',
        ]);
    });

    it('publicación inexistente o ajena → publication_not_found 404, sin escritura', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_B,
            tenantId: T_B,
            quotes: [makeQuote()],
        });
        const { deps, calls } = makeDeps(store);

        await expect(
            generateQuoteFlyers({ tenantId: T_A, publicationId: PUB_B }, deps),
        ).rejects.toMatchObject({
            statusCode: 404,
            code: 'publication_not_found',
        });
        await expect(
            generateQuoteFlyers({ tenantId: T_A, publicationId: 'no-existe' }, deps),
        ).rejects.toMatchObject({ code: 'publication_not_found' });
        expect(calls).toHaveLength(0);
        expect(state.publications[0].quoteFlyerPaths).toEqual([]);
    });

    it('sin citas (array vacío, null o no-array) → no_quotes 422', async () => {
        for (const quotes of [[], null, 'no-soy-array', { raro: true }]) {
            const { store, state } = createMemoryQuoteFlyerStore();
            seedQuoteFlyerPublication(state, { id: PUB_1, tenantId: T_A, quotes });
            const { deps, calls } = makeDeps(store);

            await expect(
                generateQuoteFlyers({ tenantId: T_A, publicationId: PUB_1 }, deps),
            ).rejects.toMatchObject({ statusCode: 422, code: 'no_quotes' });
            expect(calls).toHaveLength(0);
            expect(state.publications[0].quoteFlyerPaths).toEqual([]);
        }
    });

    it('aislamiento por tenant: foto de tenant-b no alimenta el flyer de tenant-a', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote()],
        });
        // La foto existe pero es de OTRO tenant → photoData null.
        seedPersonPhoto(state, {
            tenantId: T_B,
            personId: PERSON_1,
            photoData: PHOTO_1,
            isPrimary: true,
        });
        const { deps, calls } = makeDeps(store);

        const result = await generateQuoteFlyers(
            { tenantId: T_A, publicationId: PUB_1, onlyPersonsWithPhotos: true },
            deps,
        );

        expect(result.skipped).toBe(1);
        expect(calls).toHaveLength(0);
        expect(state.publications[0].quoteFlyerPaths).toEqual([]);
    });

    it('todas las citas salteadas → no llama appendFlyerPaths (sin escritura vacía)', async () => {
        const { store, state } = createMemoryQuoteFlyerStore();
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote({ personId: null, attribution: 'speaker' })],
            quoteFlyerPaths: ['output/quote_previo.jpg'],
        });
        const { deps, calls } = makeDeps(store);

        const result = await generateQuoteFlyers(
            { tenantId: T_A, publicationId: PUB_1 },
            deps,
        );

        expect(result.flyers).toHaveLength(0);
        expect(result.skipped).toBe(1);
        expect(calls).toHaveLength(0);
        expect(state.publications[0].quoteFlyerPaths).toEqual([
            'output/quote_previo.jpg',
        ]);
    });
});

// ─── POST /api/publications/:id/quote-flyers (HTTP, app efímera) ──────────────

describe('POST /api/publications/:id/quote-flyers', () => {
    let server: Server;
    let baseUrl: string;
    let state: MemoryQuoteFlyerState;
    let calls: RenderCall[];

    const flyerUrl = (id: string) => `${baseUrl}/api/publications/${id}/quote-flyers`;
    const authHeaders = (tenant?: string) =>
        tenant ? { 'x-test-tenant': tenant } : {};
    const postJson = (url: string, body: unknown, tenant?: string) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders(tenant) },
            body: JSON.stringify(body),
        });

    beforeEach(async () => {
        const mem = createMemoryQuoteFlyerStore();
        state = mem.state;
        seedQuoteFlyerPublication(state, {
            id: PUB_1,
            tenantId: T_A,
            quotes: [makeQuote()],
        });
        seedPersonPhoto(state, {
            tenantId: T_A,
            personId: PERSON_1,
            photoData: PHOTO_1,
            isPrimary: true,
        });
        // Una publicación de otro tenant: existe pero es ajena.
        seedQuoteFlyerPublication(state, {
            id: PUB_B,
            tenantId: T_B,
            quotes: [makeQuote()],
        });
        // Publicación propia sin citas → no_quotes.
        seedQuoteFlyerPublication(state, {
            id: 'pub-vacia',
            tenantId: T_A,
            quotes: [],
        });

        calls = [];
        let seq = 0;
        publicationsRouteDeps.store = mem.store;
        publicationsRouteDeps.renderFlyer = async (quote, photoData, branding) => {
            calls.push({ quote, photoData, branding });
            return `output/quote_route_${++seq}.jpg`;
        };
        publicationsRouteDeps.loadBranding = async () => BRANDING;
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
        publicationsRouteDeps.store = undefined;
        publicationsRouteDeps.renderFlyer = undefined;
        publicationsRouteDeps.loadBranding = undefined;
        publicationsRouteDeps.now = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sin autenticación → 401', async () => {
        const res = await postJson(flyerUrl(PUB_1), {});
        expect(res.status).toBe(401);
    });

    it('201: genera los flyers y devuelve {publicationId, flyers, skipped}', async () => {
        const res = await postJson(flyerUrl(PUB_1), {}, T_A);
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.publicationId).toBe(PUB_1);
        expect(json.flyers).toEqual([
            { quoteIndex: 0, personId: PERSON_1, path: 'output/quote_route_1.jpg' },
        ]);
        expect(json.skipped).toBe(0);
        expect(calls).toHaveLength(1);
        expect(calls[0].photoData).toBe(PHOTO_1);
        expect(calls[0].quote.speaker).toBe('María Pérez');
    });

    it('400: onlyPersonsWithPhotos no boolean', async () => {
        const res = await postJson(
            flyerUrl(PUB_1),
            { onlyPersonsWithPhotos: 'si' },
            T_A,
        );
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('404: publicación ajena al tenant (sin leak ni escritura)', async () => {
        const res = await postJson(flyerUrl(PUB_B), {}, T_A);
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.code).toBe('publication_not_found');
        expect(JSON.stringify(json)).not.toContain(T_B);
        expect(calls).toHaveLength(0);
    });

    it('422: publicación sin citas → no_quotes', async () => {
        const res = await postJson(flyerUrl('pub-vacia'), {}, T_A);
        expect(res.status).toBe(422);
        const json = await res.json();
        expect(json.code).toBe('no_quotes');
        expect(calls).toHaveLength(0);
    });

    it('201 con onlyPersonsWithPhotos=true: persona sin foto → skipped', async () => {
        seedQuoteFlyerPublication(state, {
            id: 'pub-sin-foto',
            tenantId: T_A,
            quotes: [makeQuote({ personId: PERSON_NO_PHOTO })],
        });
        const res = await postJson(
            flyerUrl('pub-sin-foto'),
            { onlyPersonsWithPhotos: true },
            T_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.flyers).toEqual([]);
        expect(json.skipped).toBe(1);
        expect(calls).toHaveLength(0);
    });
});
