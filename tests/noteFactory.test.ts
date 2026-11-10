/**
 * Tests del slice PF-06: `noteFactoryService` — notas periodísticas por
 * rubro (flash|corta|completa|cronica) desde `transmission_segments` +
 * citas atribuidas, persistidas en `publications` (source='pipeline',
 * status='pending_review').
 *
 * Deterministas, mismo estilo que attributedQuotes/liveRoomApi: store en
 * memoria con los mismos filtros por tenant que la impl drizzle, `generate`
 * FAKE (nunca el provider real), `editorialBlock`/`listQuotes`/
 * `programBelongsToTenant` inyectados.
 *
 * Cubre el brief:
 *   - buildNotePrompt: instrucciones distintas por rubro, citas
 *     `“texto” — Nombre` sólo en rubros con includeQuotes, editorial
 *     block incluido, segmentos con franja mm:ss.
 *   - parseNoteResponse: JSON limpio, ```json fences, basura → error
 *     tipado invalid_model_response.
 *   - generateNote completo: insertPublication con quotes jsonb = citas
 *     atribuidas usadas, source/status del pipeline, y los errores de
 *     dominio transmission_not_found / invalid_program / no_content /
 *     invalid_format con aislamiento por tenant.
 *   - POST /api/transmissions/:id/notes → 201/400/404/422.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de auth (mismo contrato que liveRoomApi.test.ts) ────────────
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
    buildNotePrompt,
    formatMsTimestamp,
    generateNote,
    NOTE_RUBROS,
    parseNoteResponse,
    RUBRO_TEMPLATES,
    type GenerateNoteDeps,
    type NoteSegment,
} from '../src/server/services/noteFactoryService';
import type { AttributedQuote } from '../src/server/services/attributedQuotesService';
import { notesRouter, notesRouteDeps } from '../src/server/routes/notes';
import {
    createMemoryNoteFactoryStore,
    seedNoteSegment,
    type MemoryNoteFactoryState,
} from './helpers/memoryNoteFactoryStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const TX_1 = '00000000-0000-4000-8000-00000000aaa1';
const TX_B = '00000000-0000-4000-8000-00000000bbb1';
const PROGRAM_A = '00000000-0000-4000-8000-00000000ccc1';
const PROGRAM_B = '00000000-0000-4000-8000-00000000ccc2';
const NOW = new Date('2026-03-01T12:00:00Z');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSegments(): NoteSegment[] {
    return [
        {
            id: 'seg-1',
            startMs: 60_000,
            endMs: 150_000,
            topic: 'Apertura: inflación de febrero',
            summary: 'El conductor presenta el dato del INDEC.',
            speakers: [{ label: 'Speaker A', personId: 'p-1' }],
        },
        {
            id: 'seg-2',
            startMs: 150_000,
            endMs: 300_000,
            topic: 'Entrevista con la ministra',
            summary: 'Preguntas sobre las medidas económicas.',
            speakers: [{ label: 'Speaker B', personId: null }],
        },
    ];
}

function makeQuote(over: Partial<AttributedQuote> = {}): AttributedQuote {
    return {
        momentId: 'm-1',
        text: 'La inflación es el problema central de la economía.',
        startMs: 70_000,
        endMs: 74_000,
        score: null,
        reason: 'quote',
        speakerLabel: 'Speaker A',
        personId: 'p-1',
        personName: 'María Pérez',
        personPhotoUrl: '/api/persons/p-1/photos/ph-1',
        attribution: 'person',
        ...over,
    };
}

function seedTransmission(
    state: MemoryNoteFactoryState,
    v: { id?: string; tenantId?: string; programId?: string | null; status?: string } = {},
) {
    state.transmissions.push({
        id: v.id ?? TX_1,
        tenantId: v.tenantId ?? T_A,
        programId: v.programId === undefined ? PROGRAM_A : v.programId,
        status: v.status ?? 'done',
    });
}

function seedSegments(state: MemoryNoteFactoryState, tenantId = T_A, txId = TX_1) {
    for (const s of makeSegments()) {
        seedNoteSegment(state, { ...s, tenantId, transmissionId: txId });
    }
}

/** Deps fake deterministas — nada toca DB ni provider real. */
function makeDeps(store: ReturnType<typeof createMemoryNoteFactoryStore>['store']) {
    const prompts: string[] = [];
    const quotes = [makeQuote()];
    const deps: GenerateNoteDeps = {
        store,
        generate: async (prompt) => {
            prompts.push(prompt);
            return JSON.stringify({
                title: 'Título generado',
                body: 'Cuerpo de la nota generada.',
            });
        },
        editorialBlock: async () => 'BLOQUE EDITORIAL DEL CANAL',
        listQuotes: async () => quotes,
        programBelongsToTenant: async (tenantId, programId) =>
            tenantId === T_A && programId === PROGRAM_A,
        now: () => NOW,
    };
    return { deps, prompts, quotes };
}

// ─── formatMsTimestamp / buildNotePrompt (puras) ──────────────────────────────

describe('formatMsTimestamp', () => {
    it('formatea mm:ss con padding; minutos pueden superar 59', () => {
        expect(formatMsTimestamp(0)).toBe('00:00');
        expect(formatMsTimestamp(90_000)).toBe('01:30');
        expect(formatMsTimestamp(61_999)).toBe('01:01');
        expect(formatMsTimestamp(3_660_000)).toBe('61:00');
    });
});

describe('buildNotePrompt', () => {
    const base = {
        segments: makeSegments(),
        quotes: [makeQuote()],
        editorialBlock: 'BLOQUE EDITORIAL DEL CANAL',
    };

    it('cada rubro produce instrucciones distintas (las del template, verbatim)', () => {
        const prompts = NOTE_RUBROS.map((format) =>
            buildNotePrompt({ ...base, format }),
        );
        // Los 4 prompts son distintos entre sí.
        expect(new Set(prompts).size).toBe(NOTE_RUBROS.length);
        for (const format of NOTE_RUBROS) {
            const prompt = buildNotePrompt({ ...base, format });
            expect(prompt).toContain(RUBRO_TEMPLATES[format].instructions);
            expect(prompt).toContain(RUBRO_TEMPLATES[format].label);
        }
    });

    it('incluye el editorial block y los segmentos con franja mm:ss', () => {
        const prompt = buildNotePrompt({ ...base, format: 'completa' });
        expect(prompt).toContain('BLOQUE EDITORIAL DEL CANAL');
        expect(prompt).toContain('[01:00–02:30] Apertura: inflación de febrero');
        expect(prompt).toContain('[02:30–05:00] Entrevista con la ministra');
        expect(prompt).toContain('voces: Speaker A');
    });

    it('rubros con includeQuotes muestran las citas atribuidas `“texto” — Nombre`', () => {
        for (const format of ['corta', 'completa', 'cronica'] as const) {
            const prompt = buildNotePrompt({ ...base, format });
            expect(prompt).toContain('CITAS ATRIBUIDAS');
            expect(prompt).toContain(
                '“La inflación es el problema central de la economía.” — María Pérez',
            );
        }
    });

    it('flash (includeQuotes=false) omite la sección de citas', () => {
        const prompt = buildNotePrompt({ ...base, format: 'flash' });
        expect(prompt).not.toContain('CITAS ATRIBUIDAS');
        expect(prompt).not.toContain('María Pérez');
    });

    it('cita sin personName cae al speakerLabel; sin identidad → fallback', () => {
        const prompt = buildNotePrompt({
            ...base,
            format: 'corta',
            quotes: [
                makeQuote({
                    personName: null,
                    personId: null,
                    speakerLabel: 'Speaker B',
                    attribution: 'speaker',
                    text: 'Segunda cita.',
                }),
                makeQuote({
                    momentId: 'm-3',
                    personName: null,
                    personId: null,
                    speakerLabel: null,
                    attribution: 'unattributed',
                    text: 'Tercera cita.',
                }),
            ],
        });
        expect(prompt).toContain('“Segunda cita.” — Speaker B');
        expect(prompt).toContain('“Tercera cita.” — Vocero sin identificar');
    });

    it('sin editorial block ni citas el prompt igual lleva segmentos + contrato JSON', () => {
        const prompt = buildNotePrompt({
            format: 'corta',
            segments: makeSegments(),
            quotes: [],
        });
        expect(prompt).toContain('SEGMENTOS DE LA TRANSMISIÓN');
        expect(prompt).not.toContain('CITAS ATRIBUIDAS');
        expect(prompt).toContain('{"title": "título de la nota", "body": "cuerpo completo de la nota"}');
    });
});

// ─── parseNoteResponse (pura) ─────────────────────────────────────────────────

describe('parseNoteResponse', () => {
    it('JSON limpio → {title, body}', () => {
        expect(
            parseNoteResponse('{"title": "Mi título", "body": "El cuerpo."}'),
        ).toEqual({ title: 'Mi título', body: 'El cuerpo.' });
    });

    it('tolera fences ```json ... ```', () => {
        const raw = '```json\n{"title": "T", "body": "B"}\n```';
        expect(parseNoteResponse(raw)).toEqual({ title: 'T', body: 'B' });
    });

    it('basura no-JSON → AppError 502 invalid_model_response', () => {
        try {
            parseNoteResponse('no soy json ni cerca');
            expect.unreachable('debió lanzar');
        } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).statusCode).toBe(502);
            expect((err as AppError).code).toBe('invalid_model_response');
        }
    });

    it('JSON válido sin title/body → invalid_model_response', () => {
        for (const raw of ['{}', '{"title": "solo título"}', '[]', '"texto"']) {
            try {
                parseNoteResponse(raw);
                expect.unreachable(`debió lanzar para ${raw}`);
            } catch (err) {
                expect((err as AppError).code).toBe('invalid_model_response');
            }
        }
    });
});

// ─── generateNote (flujo completo con deps fake) ─────────────────────────────

describe('generateNote', () => {
    it('flujo completo: generate fake → publicación pipeline pending_review con citas jsonb', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        seedTransmission(state);
        seedSegments(state);
        const { deps, prompts, quotes } = makeDeps(store);

        const result = await generateNote(
            { tenantId: T_A, transmissionId: TX_1, format: 'completa', programId: PROGRAM_A },
            deps,
        );

        expect(result.segmentsUsed).toBe(2);
        expect(result.quotesUsed).toBe(1);
        expect(result.generatedAt).toBe(NOW);

        // La publicación quedó persistida con el contrato del pipeline.
        expect(state.publications).toHaveLength(1);
        const pub = state.publications[0];
        expect(result.publication).toBe(pub);
        expect(pub).toMatchObject({
            tenantId: T_A,
            title: 'Título generado',
            content: 'Cuerpo de la nota generada.',
            source: 'pipeline',
            status: 'pending_review',
        });
        // quotes jsonb = las AttributedQuote usadas, tal cual (con personName).
        expect(pub.quotes).toEqual(quotes);
        expect((pub.quotes as AttributedQuote[])[0].personName).toBe('María Pérez');

        // El prompt llevó editorial block + instrucciones del rubro + citas.
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('BLOQUE EDITORIAL DEL CANAL');
        expect(prompts[0]).toContain(RUBRO_TEMPLATES.completa.instructions);
        expect(prompts[0]).toContain('— María Pérez');
    });

    it('flash: las citas no van al prompt ni a publication.quotes (no fueron "usadas")', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        seedTransmission(state);
        seedSegments(state);
        const { deps, prompts } = makeDeps(store);

        const result = await generateNote(
            { tenantId: T_A, transmissionId: TX_1, format: 'flash' },
            deps,
        );

        expect(result.quotesUsed).toBe(0);
        expect(state.publications[0].quotes).toEqual([]);
        expect(prompts[0]).not.toContain('María Pérez');
    });

    it('transmisión inexistente o de otro tenant → transmission_not_found 404', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        // Existe, pero es de tenant-b: para tenant-a es 404, no leak.
        seedTransmission(state, { tenantId: T_B });
        const { deps } = makeDeps(store);

        await expect(
            generateNote({ tenantId: T_A, transmissionId: TX_1, format: 'corta' }, deps),
        ).rejects.toMatchObject({
            statusCode: 404,
            code: 'transmission_not_found',
        });
        expect(state.publications).toHaveLength(0);
    });

    it('programId ajeno → invalid_program 404 (nunca perfil incorrecto)', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        seedTransmission(state);
        seedSegments(state);
        const { deps } = makeDeps(store);

        await expect(
            generateNote(
                { tenantId: T_A, transmissionId: TX_1, format: 'corta', programId: PROGRAM_B },
                deps,
            ),
        ).rejects.toMatchObject({ statusCode: 404, code: 'invalid_program' });
        expect(state.publications).toHaveLength(0);
    });

    it('sin segmentos → no_content 422 (error tipado, nunca nota vacía)', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        seedTransmission(state);
        // Tenant-b sí tiene segmentos — no se leen (aislamiento).
        seedSegments(state, T_B, TX_1);
        const { deps } = makeDeps(store);

        await expect(
            generateNote({ tenantId: T_A, transmissionId: TX_1, format: 'corta' }, deps),
        ).rejects.toMatchObject({ statusCode: 422, code: 'no_content' });
        expect(state.publications).toHaveLength(0);
    });

    it('formato fuera de rubros → invalid_format 422', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        seedTransmission(state);
        seedSegments(state);
        const { deps, prompts } = makeDeps(store);

        await expect(
            generateNote({ tenantId: T_A, transmissionId: TX_1, format: 'twitter' }, deps),
        ).rejects.toMatchObject({ statusCode: 422, code: 'invalid_format' });
        expect(prompts).toHaveLength(0);
        expect(state.publications).toHaveLength(0);
    });

    it('generate devuelve basura → invalid_model_response 502 y no inserta', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        seedTransmission(state);
        seedSegments(state);
        const { deps } = makeDeps(store);
        deps.generate = async () => 'salida rota del modelo';

        await expect(
            generateNote({ tenantId: T_A, transmissionId: TX_1, format: 'corta' }, deps),
        ).rejects.toMatchObject({ statusCode: 502, code: 'invalid_model_response' });
        expect(state.publications).toHaveLength(0);
    });

    it('aislamiento por tenant: segmentos de tenant-b no alimentan la nota de tenant-a', async () => {
        const { store, state } = createMemoryNoteFactoryStore();
        seedTransmission(state); // tenant-a, TX_1
        // La transmisión de A existe pero sus segmentos son de tenant-b con
        // la misma transmissionId → la nota de A no tiene contenido.
        seedNoteSegment(state, {
            id: 'seg-b',
            tenantId: T_B,
            transmissionId: TX_1,
            startMs: 0,
            endMs: 1_000,
            topic: 'Contenido ajeno',
        });
        const { deps } = makeDeps(store);
        // listQuotes fake respeta el contrato: lo que devuelve es del caller;
        // el store (los segmentos) es lo que filtra por tenant.
        await expect(
            generateNote({ tenantId: T_A, transmissionId: TX_1, format: 'corta' }, deps),
        ).rejects.toMatchObject({ code: 'no_content' });
    });
});

// ─── POST /api/transmissions/:id/notes (HTTP, app efímera) ────────────────────

describe('POST /api/transmissions/:id/notes', () => {
    let server: Server;
    let baseUrl: string;
    let state: MemoryNoteFactoryState;
    let prompts: string[];

    const noteUrl = (id: string) => `${baseUrl}/api/transmissions/${id}/notes`;
    const authHeaders = (tenant?: string) =>
        tenant ? { 'x-test-tenant': tenant } : {};
    const postJson = (url: string, body: unknown, tenant?: string) =>
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...authHeaders(tenant) },
            body: JSON.stringify(body),
        });

    beforeEach(async () => {
        const mem = createMemoryNoteFactoryStore();
        state = mem.state;
        seedTransmission(state);
        seedSegments(state);
        // Una transmisión de otro tenant: existe pero es ajena.
        seedTransmission(state, { id: TX_B, tenantId: T_B });
        seedSegments(state, T_B, TX_B);

        prompts = [];
        notesRouteDeps.store = mem.store;
        notesRouteDeps.generate = async (prompt) => {
            prompts.push(prompt);
            return '{"title": "Nota de prueba", "body": "Cuerpo de la nota."}';
        };
        notesRouteDeps.listQuotes = async () => [makeQuote()];
        notesRouteDeps.editorialBlock = async () => 'BLOQUE EDITORIAL';
        notesRouteDeps.programBelongsToTenant = async (tenantId, programId) =>
            tenantId === T_A && programId === PROGRAM_A;
        notesRouteDeps.now = () => NOW;

        const app = express();
        app.use(express.json());
        app.use('/api/transmissions', notesRouter);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        notesRouteDeps.store = undefined;
        notesRouteDeps.generate = undefined;
        notesRouteDeps.listQuotes = undefined;
        notesRouteDeps.editorialBlock = undefined;
        notesRouteDeps.programBelongsToTenant = undefined;
        notesRouteDeps.now = undefined;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('sin autenticación → 401', async () => {
        const res = await postJson(noteUrl(TX_1), { format: 'corta' });
        expect(res.status).toBe(401);
    });

    it('201: genera la nota y devuelve {publication} con quotes atribuidas', async () => {
        const res = await postJson(
            noteUrl(TX_1),
            { format: 'completa', programId: PROGRAM_A },
            T_A,
        );
        expect(res.status).toBe(201);
        const json = await res.json();
        expect(json.publication).toMatchObject({
            tenantId: T_A,
            title: 'Nota de prueba',
            source: 'pipeline',
            status: 'pending_review',
        });
        expect(json.segmentsUsed).toBe(2);
        expect(json.quotesUsed).toBe(1);
        expect(json.publication.quotes[0].personName).toBe('María Pérez');
        expect(prompts).toHaveLength(1);
    });

    it('400: body mal formado (format faltante / programId no UUID)', async () => {
        for (const body of [{}, { format: 42 }, { format: ' ' }, { format: 'corta', programId: 'no-uuid' }]) {
            const res = await postJson(noteUrl(TX_1), body, T_A);
            expect(res.status).toBe(400);
        }
        expect(state.publications).toHaveLength(0);
    });

    it('404: transmisión ajena al tenant (sin leak ni escritura)', async () => {
        const res = await postJson(noteUrl(TX_B), { format: 'corta' }, T_A);
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.code).toBe('transmission_not_found');
        expect(JSON.stringify(json)).not.toContain(T_B);
        expect(state.publications).toHaveLength(0);
    });

    it('404: programId que no pertenece al tenant', async () => {
        const res = await postJson(
            noteUrl(TX_1),
            { format: 'corta', programId: PROGRAM_B },
            T_A,
        );
        expect(res.status).toBe(404);
        const json = await res.json();
        expect(json.code).toBe('invalid_program');
    });

    it('422: formato inválido y transmisión sin contenido', async () => {
        const badFormat = await postJson(noteUrl(TX_1), { format: 'tiktok' }, T_A);
        expect(badFormat.status).toBe(422);
        expect((await badFormat.json()).code).toBe('invalid_format');

        // Transmisión del tenant sin segmentos → no_content.
        seedTransmission(state, { id: 'tx-empty', tenantId: T_A });
        const empty = await postJson(noteUrl('tx-empty'), { format: 'corta' }, T_A);
        expect(empty.status).toBe(422);
        expect((await empty.json()).code).toBe('no_content');
    });
});
