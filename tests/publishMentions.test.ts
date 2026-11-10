/**
 * Tests del slice PG-06 — menciones reales + etiquetas por red de
 * publicación:
 *
 *   - `mentionService` puro: `resolvePublishMentions` (PUBLISH_MENTION_KEYS,
 *     x > twitter, persona sin handle omitida, NUNCA desde el nombre),
 *     `normalizePublishHashtag(s)` (sin '#', sin espacios, dedupe por
 *     orden) y `composePublishContent` (menciones+etiquetas al final, sin
 *     duplicar lo que ya está, recorte seguro por límite de plataforma).
 *   - `publishJobService`: `composeForTargets` dentro de
 *     `enqueuePublishJobs`/`enqueueForApproval` — el `content` persistido
 *     ya es el texto final por red y `payload` guarda la estructura;
 *     tenant isolation vía `listMentionPersons` (dep inyectada);
 *     `previewPublishEnqueue` devuelve lo mismo sin encolar.
 *   - Rutas: `POST /api/review/:id/publish-preview` y
 *     `POST /api/review/:id/approve` con personIds/excludePersonIds/
 *     hashtags del body (400 si mal tipados).
 *
 * Deterministas: store en memoria (mismos filtros que drizzle), deps de
 * menciones inyectadas, sin DB real ni red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ─── Mock parcial de DB (importarlo crea un Pool Neon) ───────────────────────
vi.mock('../src/server/db/index.js', async (io) => ({
    ...(await io()),
    db: {},
}));

// ─── Mock parcial de auth (mismo contrato que publishApprove.test.ts) ────────
vi.mock('../src/server/middleware/auth.js', async (io) => {
    const actual =
        await io<typeof import('../src/server/middleware/auth.js')>();
    const fakeRequireAuth = (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
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

// ─── Mocks de módulo para las rutas de review ────────────────────────────────
const mocks = vi.hoisted(() => ({
    pubs: new Map<
        string,
        {
            id: string;
            tenantId: string;
            title: string | null;
            content: string | null;
            imagePath: string | null;
            imageUrl: string | null;
            status: string;
        }
    >(),
    publishToChannels: vi.fn(),
    updatePublicationStatus: vi.fn(),
    addEditHistoryEntry: vi.fn(),
}));

vi.mock('../src/server/services/databaseService.js', () => ({
    getPublicationsByStatus: async () => ({ publications: [], total: 0 }),
    getReviewPublicationById: async (id: string, tenantId: string) => {
        const pub = mocks.pubs.get(id);
        return pub && pub.tenantId === tenantId ? pub : null;
    },
    updatePublicationStatus: mocks.updatePublicationStatus,
    updatePublicationContent: async () => null,
    addEditHistoryEntry: mocks.addEditHistoryEntry,
}));

vi.mock('../src/server/services/publishService.js', () => ({
    publishToChannels: mocks.publishToChannels,
}));
vi.mock('../src/server/services/auditService.js', async (io) => ({
    ...(await io()),
    auditFromRequest: vi.fn(async () => undefined),
}));
vi.mock('../src/server/services/aiSdkService.js', () => ({
    chatCompletion: vi.fn(),
}));
vi.mock('../src/server/services/imageService.js', () => ({
    processImage: vi.fn(),
}));
vi.mock('../src/server/services/brandingService.js', () => ({
    loadTenantBranding: vi.fn(),
}));
vi.mock('../src/server/services/contentMultiplierService.js', () => ({
    generateContentVariants: vi.fn(),
    regenerateVariant: vi.fn(),
}));
vi.mock('../src/server/services/editorialPromptService.js', () => ({
    programBelongsToTenant: vi.fn(async () => true),
    resolveEditorialPromptContext: vi.fn(async () => ({
        tone: 'formal',
        block: '',
    })),
}));

import {
    composePublishContent,
    containsPublishToken,
    normalizePublishHashtag,
    normalizePublishHashtags,
    resolvePublishMentions,
    PUBLISH_MENTION_KEYS,
    PUBLISH_TEXT_LIMITS,
} from '../src/server/services/mentionService';
import {
    enqueueForApproval,
    enqueuePublishJobs,
    previewPublishEnqueue,
    validatePublishOptions,
    type PublishJobDeps,
} from '../src/server/services/publishJobService';
import type { PersonSocialLinks } from '../src/server/services/networkVariantService';
import type { SocialConnectionRow } from '../src/server/services/socialConnectionsService';
import { registerReviewRoutes, reviewPublishDeps } from '../src/server/routes/review';
import { createMemoryPublishJobStore } from './helpers/memoryPublishJobStore';
import { createMemoryPublishChannelStore } from './helpers/memoryPublishChannelStore';

const T_A = 'tenant-a';
const T_B = 'tenant-b';
const PUB_ID = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333331';
const P2 = '33333333-3333-4333-8333-333333333332';
const CONN_IG = '55555555-5555-4555-8555-555555555551';
const CONN_TW = '55555555-5555-4555-8555-555555555552';
const T0 = new Date('2026-11-10T12:00:00.000Z');

const person = (
    id: string,
    name: string,
    socialLinks: Record<string, unknown>,
): PersonSocialLinks => ({ id, name, socialLinks });

const makeConn = (
    v: Partial<SocialConnectionRow> & {
        tenantId: string;
        platform: string;
        accountId: string;
    },
): SocialConnectionRow => ({
    id: v.id ?? CONN_IG,
    tenantId: v.tenantId,
    platform: v.platform,
    accountId: v.accountId,
    username: v.username ?? 'radio.uno',
    displayName: v.displayName ?? 'Radio Uno',
    status: v.status ?? 'connected',
    zernioProfileId: v.zernioProfileId ?? 'zprof_1',
    lastSyncedAt: null,
    createdAt: T0,
    updatedAt: T0,
});

// ─── resolvePublishMentions — handle REAL por red (PUBLISH_MENTION_KEYS) ─────

describe('resolvePublishMentions — por plataforma de publicación', () => {
    it('resuelve el handle del key de la red; X prefiere `x` sobre `twitter`', () => {
        const people = [
            person(P1, 'María', {
                x: 'maria_x',
                twitter: 'maria_legacy',
                instagram: 'maria.ig',
            }),
        ];
        expect(resolvePublishMentions(people, 'twitter')).toEqual([
            { personId: P1, name: 'María', handle: '@maria_x' },
        ]);
        expect(resolvePublishMentions(people, 'instagram')).toEqual([
            { personId: P1, name: 'María', handle: '@maria.ig' },
        ]);
        // `twitter` cae a `twitter` cuando no hay `x`:
        const sinX = [person(P1, 'María', { twitter: 'maria_legacy' })];
        expect(resolvePublishMentions(sinX, 'twitter')[0].handle).toBe(
            '@maria_legacy',
        );
    });

    it('mapea las 10 redes de publicación (tiktok/threads/bluesky/pinterest/reddit/facebook)', () => {
        const people = [
            person(P1, 'Ana', {
                tiktok: 'ana.tt',
                threads: 'ana.th',
                bluesky: 'ana.bsky',
                pinterest: 'anapin',
                reddit: 'u_ana',
                facebook: 'ana.fb',
                linkedin: 'ana-in',
                youtube: '@anayt',
            }),
        ];
        for (const [platform, handle] of [
            ['tiktok', '@ana.tt'],
            ['threads', '@ana.th'],
            ['bluesky', '@ana.bsky'],
            ['pinterest', '@anapin'],
            ['reddit', '@u_ana'],
            ['facebook', '@ana.fb'],
            ['linkedin', '@ana-in'],
            ['youtube', '@anayt'],
        ] as const) {
            const out = resolvePublishMentions(people, platform);
            expect(out).toEqual([
                { personId: P1, name: 'Ana', handle },
            ]);
        }
        expect(Object.keys(PUBLISH_MENTION_KEYS).sort()).toEqual(
            [
                'bluesky',
                'facebook',
                'instagram',
                'linkedin',
                'pinterest',
                'reddit',
                'threads',
                'tiktok',
                'twitter',
                'youtube',
            ].sort(),
        );
    });

    it('persona sin handle en la red destino queda fuera', () => {
        const people = [
            person(P1, 'Con Twitter', { x: 'conx' }),
            person(P2, 'Sin Nada', { web: 'https://ejemplo.com' }),
        ];
        const out = resolvePublishMentions(people, 'tiktok');
        expect(out).toEqual([]);
    });

    it('el handle sale de social_links — NUNCA del nombre de la persona', () => {
        // 'Ana' no tiene ningún social_links → no se menciona aunque el
        // nombre sugeriría '@ana'.
        const people = [
            person(P1, 'Ana', {}),
            person(P2, 'José', { instagram: '@handle.real' }),
        ];
        const out = resolvePublishMentions(people, 'instagram');
        expect(out).toEqual([
            { personId: P2, name: 'José', handle: '@handle.real' },
        ]);
    });

    it('dedupe por handle case-insensitive y `exclude` filtra por personId', () => {
        const people = [
            person(P1, 'A', { x: 'Duplicado' }),
            person(P2, 'B', { x: '@DUPLICADO' }),
        ];
        expect(resolvePublishMentions(people, 'twitter')).toHaveLength(1);
        expect(
            resolvePublishMentions(people, 'twitter', {
                exclude: new Set([P1]),
            }),
        ).toEqual([{ personId: P2, name: 'B', handle: '@DUPLICADO' }]);
    });

    it('plataforma desconocida / sin soporte de mención → []', () => {
        const people = [person(P1, 'Ana', { x: 'ana' })];
        expect(resolvePublishMentions(people, 'mastodon')).toEqual([]);
        expect(resolvePublishMentions(people, 'newsletter')).toEqual([]);
    });
});

// ─── Hashtags ────────────────────────────────────────────────────────────────

describe('normalizePublishHashtags — sin #, sin espacios, dedupe por orden', () => {
    it('normaliza variantes de input al formato #tag', () => {
        expect(normalizePublishHashtag('#tag')).toBe('#tag');
        expect(normalizePublishHashtag('##tag')).toBe('#tag');
        expect(normalizePublishHashtag('  mi tag ')).toBe('#mitag');
        expect(normalizePublishHashtag('#Música!')).toBe('#Musica');
        expect(normalizePublishHashtag('#')).toBeNull();
        expect(normalizePublishHashtag('   ')).toBeNull();
    });

    it('deduplica case-insensitive preservando el orden original', () => {
        expect(
            normalizePublishHashtags([
                '#Deporte',
                'deporte',
                '##POLÍTICA',
                'local',
                42,
                null,
                '#Local',
            ]),
        ).toEqual(['#Deporte', '#POLITICA', '#local']);
    });
});

// ─── composePublishContent — texto final determinista por red ────────────────

describe('composePublishContent — menciones y etiquetas al final', () => {
    it('agrega menciones y hashtags al final separados por espacio', () => {
        const out = composePublishContent({
            baseText: 'La nota del día',
            platform: 'instagram',
            mentions: [{ handle: '@maria' }, { handle: '@jose' }],
            hashtags: ['#deporte', 'local'],
        });
        expect(out.text).toBe('La nota del día\n\n@maria @jose #deporte #local');
        expect(out.mentions).toEqual(['@maria', '@jose']);
        expect(out.hashtags).toEqual(['#deporte', '#local']);
        expect(out.truncated).toBe(false);
        // determinista — misma entrada, misma salida
        expect(
            composePublishContent({
                baseText: 'La nota del día',
                platform: 'instagram',
                mentions: [{ handle: '@maria' }, { handle: '@jose' }],
                hashtags: ['#deporte', 'local'],
            }).text,
        ).toBe(out.text);
    });

    it('no duplica menciones ni hashtags ya presentes (case-insensitive)', () => {
        const out = composePublishContent({
            baseText: 'Habla @MARIA sobre #Deporte en la ciudad',
            platform: 'instagram',
            mentions: [{ handle: '@maria' }, { handle: '@jose' }],
            hashtags: ['#DEPORTE', '#ciudad'],
        });
        // @maria y #Deporte ya están → sólo se agregan @jose y #ciudad.
        expect(out.text).toBe(
            'Habla @MARIA sobre #Deporte en la ciudad\n\n@jose #ciudad',
        );
    });

    it('mail@maria o @mari dentro de otra palabra NO cuentan como mención', () => {
        expect(containsPublishToken('escribile a mail@maria.com', '@maria')).toBe(
            false,
        );
        expect(containsPublishToken('habla @mariaperez', '@maria')).toBe(false);
        expect(containsPublishToken('habla @Maria perez', '@maria')).toBe(true);
    });

    it('sin texto base la cola sale sola (sin \\n\\n vacío adelante)', () => {
        const out = composePublishContent({
            baseText: '   ',
            platform: 'twitter',
            mentions: [{ handle: '@maria' }],
        });
        expect(out.text).toBe('@maria');
    });

    it('twitter: recorta el base con … priorizando menciones/etiquetas', () => {
        const base = 'x'.repeat(300);
        const out = composePublishContent({
            baseText: base,
            platform: 'twitter',
            mentions: [{ handle: '@maria' }],
            hashtags: ['#deporte'],
        });
        expect(out.truncated).toBe(true);
        expect(out.text.length).toBeLessThanOrEqual(280);
        expect(out.text).toMatch(/…\n\n@maria #deporte$/);
        expect(out.text.startsWith(base.slice(0, 10))).toBe(true);
    });

    it('si ni la cola entra, descarta tokens del final (hashtags primero)', () => {
        const base = 'x'.repeat(276);
        const out = composePublishContent({
            baseText: base,
            platform: 'twitter',
            mentions: [{ handle: '@m' }],
            // Tag tan largo que la cola no entra ni con '…' de base.
            hashtags: [`#${'a'.repeat(276)}`],
        });
        expect(out.text.length).toBeLessThanOrEqual(280);
        // El hashtag se descartó; la mención (más prioritaria) quedó.
        expect(out.text).not.toContain('#aaa');
        expect(out.text).toContain('@m');
        expect(out.hashtags).toEqual([]);
        expect(out.mentions).toEqual(['@m']);
    });

    it('plataforma sin límite declarado → no recorta (instagram/linkedin)', () => {
        const base = 'x'.repeat(3000);
        const out = composePublishContent({
            baseText: base,
            platform: 'instagram',
            mentions: [{ handle: '@m' }],
        });
        expect(out.truncated).toBe(false);
        expect(out.text.length).toBeGreaterThan(280);
        expect(PUBLISH_TEXT_LIMITS.instagram).toBeUndefined();
    });

    it('limit explícito en null desactiva el recorte aunque haya límite', () => {
        const out = composePublishContent({
            baseText: 'x'.repeat(300),
            platform: 'twitter',
            limit: null,
        });
        expect(out.truncated).toBe(false);
        expect(out.text).toHaveLength(300);
    });
});

// ─── enqueuePublishJobs — composición por red persistida en el job ───────────

describe('enqueuePublishJobs — texto final compuesto por red en el job', () => {
    const quotes = [{ personId: P1, text: 'Cita de María' }, { personId: P2 }];
    const people = [
        person(P1, 'María', { x: 'maria_x', instagram: 'maria.ig' }),
        person(P2, 'José', { x: 'jose_x' }),
    ];

    const depsWithMentions = (
        store: PublishJobDeps['store'],
        recorded?: { tenantId?: string; ids?: string[] },
    ): PublishJobDeps => ({
        store,
        now: () => T0,
        getMentionSource: async () => ({
            quotes,
            contentVariants: null,
        }),
        listMentionPersons: async (tenantId, personIds) => {
            if (recorded) {
                recorded.tenantId = tenantId;
                recorded.ids = personIds;
            }
            // Misma regla que el drizzle: sólo personas del tenant pedido
            // y con id ∈ personIds (WHERE tenant_id = $1 AND id IN (...)).
            return tenantId === T_A
                ? people.filter((p) => personIds.includes(p.id))
                : [];
        },
    });

    it('compone menciones por red y las persiste en content + payload', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const result = await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [
                    { platform: 'instagram', accountId: 'zacc_1' },
                    { platform: 'twitter', accountId: 'zacc_2' },
                    { platform: 'reddit', accountId: 'zacc_3' },
                ],
                content: 'Contenido de la nota',
            },
            depsWithMentions(store),
        );
        const ig = state.jobs.find((j) => j.platform === 'instagram')!;
        const tw = state.jobs.find((j) => j.platform === 'twitter')!;
        const rd = state.jobs.find((j) => j.platform === 'reddit')!;
        // Instagram: sólo María (José no tiene handle ig).
        expect(ig.content).toBe('Contenido de la nota\n\n@maria.ig');
        expect(ig.payload).toEqual({
            mentions: [{ personId: P1, name: 'María', handle: '@maria.ig' }],
            hashtags: [],
        });
        // Twitter/X: ambos (key `x`).
        expect(tw.content).toBe('Contenido de la nota\n\n@maria_x @jose_x');
        // Reddit: ninguno tiene handle de reddit → texto intacto.
        expect(rd.content).toBe('Contenido de la nota');
        expect(rd.payload).toEqual({});
        expect(result.jobs.map((j) => j.content)).toEqual([
            ig.content,
            tw.content,
            rd.content,
        ]);
    });

    it('los personIds salen de publication.quotes vía getMentionSource', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const recorded: { tenantId?: string; ids?: string[] } = {};
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [{ platform: 'twitter', accountId: 'zacc_2' }],
                content: 'Nota',
            },
            depsWithMentions(store, recorded),
        );
        expect(recorded.tenantId).toBe(T_A);
        expect(recorded.ids).toEqual([P1, P2]);
    });

    it('tenant isolation: listMentionPersons va con tenantId y el ajeno no se usa', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        // La dep devuelve [] para otro tenant — igual que el drizzle
        // (WHERE tenant_id = $1). Las personas "existen" pero no son del
        // tenant → el job queda sin menciones.
        await enqueuePublishJobs(
            {
                tenantId: T_B,
                publicationId: PUB_ID,
                targets: [{ platform: 'twitter', accountId: 'zacc_9' }],
                content: 'Nota ajena',
            },
            depsWithMentions(store),
        );
        expect(state.jobs[0].content).toBe('Nota ajena');
        expect(state.jobs[0].payload).toEqual({});
    });

    it('personIds explícitos del request pisan los de quotes', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const recorded: { ids?: string[] } = {};
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [{ platform: 'twitter', accountId: 'zacc_2' }],
                content: 'Nota',
                personIds: [P2],
            },
            depsWithMentions(store, recorded),
        );
        expect(recorded.ids).toEqual([P2]);
        expect(state.jobs[0].content).toBe('Nota\n\n@jose_x');
    });

    it('excludePersonIds saca la mención y queda en payload.excludedPersonIds', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [{ platform: 'twitter', accountId: 'zacc_2' }],
                content: 'Nota',
                excludePersonIds: [P1],
            },
            depsWithMentions(store),
        );
        expect(state.jobs[0].content).toBe('Nota\n\n@jose_x');
        expect(state.jobs[0].payload).toEqual({
            mentions: [{ personId: P2, name: 'José', handle: '@jose_x' }],
            hashtags: [],
            excludedPersonIds: [P1],
        });
    });

    it('hashtags del request: se normalizan, deduplican y viajan por TODAS las redes', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                targets: [
                    { platform: 'instagram', accountId: 'zacc_1' },
                    { platform: 'twitter', accountId: 'zacc_2' },
                ],
                content: 'Nota',
                hashtags: ['##Deporte', 'deporte', ' mi ciudad '],
            },
            depsWithMentions(store),
        );
        for (const j of state.jobs) {
            expect(j.content).toContain('#Deporte #miciudad');
            expect(j.payload.hashtags).toEqual(['#Deporte', '#miciudad']);
        }
    });

    it('hashtags de contentVariants.extras[red] se respetan sólo en esa red', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const deps: PublishJobDeps = {
            store,
            now: () => T0,
            getMentionSource: async () => ({
                quotes: [],
                contentVariants: {
                    extras: {
                        instagram: { hashtags: ['#Verano'] },
                        twitter: { hashtags: ['#Hilo'] },
                    },
                },
            }),
            listMentionPersons: async () => [],
        };
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [
                    { platform: 'instagram', accountId: 'zacc_1' },
                    { platform: 'twitter', accountId: 'zacc_2' },
                    { platform: 'tiktok', accountId: 'zacc_3' },
                ],
                content: 'Nota',
            },
            deps,
        );
        const byPlatform = Object.fromEntries(
            state.jobs.map((j) => [j.platform, j]),
        );
        expect(byPlatform.instagram.content).toBe('Nota\n\n#Verano');
        expect(byPlatform.twitter.content).toBe('Nota\n\n#Hilo');
        // tiktok no es NetworkVariantKey → sin extras de dónde sacar tags.
        expect(byPlatform.tiktok.content).toBe('Nota');
        expect(byPlatform.tiktok.payload).toEqual({});
    });

    it('un hashtag ya presente en el texto no se duplica', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                targets: [{ platform: 'instagram', accountId: 'zacc_1' }],
                content: 'Cobertura de #Deporte hoy',
                hashtags: ['#deporte', '#local'],
            },
            depsWithMentions(store),
        );
        expect(state.jobs[0].content).toBe(
            'Cobertura de #Deporte hoy\n\n@maria.ig #local',
        );
    });

    it('twitter >280: el content persistido entra en el límite (truncated)', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                targets: [{ platform: 'twitter', accountId: 'zacc_2' }],
                content: 'Nota larga: ' + 'x'.repeat(400),
            },
            depsWithMentions(store),
        );
        const job = state.jobs[0];
        expect(job.content.length).toBeLessThanOrEqual(280);
        expect(job.content).toContain('…');
        expect(job.payload.truncated).toBe(true);
    });

    it('sin origen editorial ni personas citadas → payload {} y content intacto', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        await enqueuePublishJobs(
            {
                tenantId: T_A,
                targets: [{ platform: 'instagram', accountId: 'zacc_1' }],
                content: 'Sólo texto',
            },
            {
                store,
                now: () => T0,
                getMentionSource: async () => null,
                listMentionPersons: async () => [],
            },
        );
        expect(state.jobs[0].content).toBe('Sólo texto');
        expect(state.jobs[0].payload).toEqual({});
    });

    it('idempotencia: re-encolar con otras exclusiones cae en el MISMO job', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const deps = depsWithMentions(store);
        const input = {
            tenantId: T_A,
            publicationId: PUB_ID,
            targets: [{ platform: 'twitter', accountId: 'zacc_2' }],
            content: 'Nota',
        };
        const first = await enqueuePublishJobs(input, deps);
        const second = await enqueuePublishJobs(
            { ...input, excludePersonIds: [P1] },
            deps,
        );
        // La idempotency_key es origen×plataforma×cuenta — la composición
        // no la cambia: la segunda llamada deduplica (no reescribe).
        expect(second.deduplicatedCount).toBe(1);
        expect(second.jobs[0].id).toBe(first.jobs[0].id);
        expect(state.jobs).toHaveLength(1);
        expect(state.jobs[0].content).toBe(first.jobs[0].content);
    });
});

// ─── enqueueForApproval + preview ────────────────────────────────────────────

describe('enqueueForApproval + previewPublishEnqueue', () => {
    const conns = [
        makeConn({ id: CONN_IG, tenantId: T_A, platform: 'instagram', accountId: 'zacc_1' }),
        makeConn({ id: CONN_TW, tenantId: T_A, platform: 'twitter', accountId: 'zacc_2' }),
    ];
    const mentionDeps = {
        getMentionSource: async () => ({
            quotes: [{ personId: P1 }],
            contentVariants: null,
        }),
        listMentionPersons: async () => [
            person(P1, 'María', { x: 'maria_x', instagram: 'maria.ig' }),
        ],
    };

    it('approve compone por red según las conexiones del tenant', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const result = await enqueueForApproval(
            { tenantId: T_A, publicationId: PUB_ID, content: 'Nota aprobada' },
            {
                store,
                now: () => T0,
                // PG-07: canal en memoria — default híbrido, sin assets legacy.
                channelStore: createMemoryPublishChannelStore().store,
                envTwitterBot: false,
                listConnections: async () => conns,
                listAutoPublishConfigs: async () => [],
                ...mentionDeps,
            },
        );
        expect(result.usedZernio).toBe(true);
        const ig = state.jobs.find((j) => j.platform === 'instagram')!;
        const tw = state.jobs.find((j) => j.platform === 'twitter')!;
        expect(ig.content).toBe('Nota aprobada\n\n@maria.ig');
        expect(tw.content).toBe('Nota aprobada\n\n@maria_x');
    });

    it('preview devuelve el mismo texto final SIN encolar jobs', async () => {
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        const preview = await previewPublishEnqueue(
            { tenantId: T_A, publicationId: PUB_ID, content: 'Nota' },
            {
                store,
                now: () => T0,
                // PG-07: canal en memoria — default híbrido, sin assets legacy.
                channelStore: createMemoryPublishChannelStore().store,
                envTwitterBot: false,
                listConnections: async () => conns,
                listAutoPublishConfigs: async () => [],
                ...mentionDeps,
            },
        );
        expect(preview.usedZernio).toBe(true);
        expect(preview.previews).toHaveLength(2);
        const ig = preview.previews.find((p) => p.platform === 'instagram')!;
        expect(ig.content).toBe('Nota\n\n@maria.ig');
        expect(ig.mentions).toEqual([
            { personId: P1, name: 'María', handle: '@maria.ig' },
        ]);
        expect(ig.accountLabel).toBe('radio.uno');
        const tw = preview.previews.find((p) => p.platform === 'twitter')!;
        expect(tw.textLimit).toBe(280);
        // Nada encolado:
        expect(state.jobs).toHaveLength(0);
    });

    it('preview con exclusiones muestra el texto final sin esa persona', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const preview = await previewPublishEnqueue(
            {
                tenantId: T_A,
                publicationId: PUB_ID,
                content: 'Nota',
                excludePersonIds: [P1],
            },
            {
                store,
                now: () => T0,
                // PG-07: canal en memoria — default híbrido, sin assets legacy.
                channelStore: createMemoryPublishChannelStore().store,
                envTwitterBot: false,
                listConnections: async () => conns,
                listAutoPublishConfigs: async () => [],
                ...mentionDeps,
            },
        );
        expect(preview.previews.every((p) => p.content === 'Nota')).toBe(true);
        expect(preview.previews.every((p) => p.mentions.length === 0)).toBe(true);
    });

    it('sin conexiones → usedZernio:false y previews vacíos', async () => {
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        const preview = await previewPublishEnqueue(
            { tenantId: T_A, publicationId: PUB_ID, content: 'Nota' },
            {
                store,
                now: () => T0,
                // PG-07: canal en memoria — default híbrido, sin assets legacy.
                channelStore: createMemoryPublishChannelStore().store,
                envTwitterBot: false,
                listConnections: async () => [],
                listAutoPublishConfigs: async () => [],
            },
        );
        expect(preview).toEqual({
            usedZernio: false,
            connectionCount: 0,
            previews: [],
            channelMode: 'hybrid',
            legacyPlatforms: [],
            skipped: [],
        });
    });
});

// ─── validatePublishOptions ──────────────────────────────────────────────────

describe('validatePublishOptions — validación del body', () => {
    it('devuelve los campos saneados cuando vienen bien', () => {
        expect(
            validatePublishOptions({
                personIds: [P1],
                excludePersonIds: [P2, P2],
                hashtags: ['##Deporte', 'local'],
            }),
        ).toEqual({
            personIds: [P1],
            excludePersonIds: [P2],
            hashtags: ['#Deporte', '#local'],
        });
        expect(validatePublishOptions({})).toEqual({});
    });

    it('rechaza personIds no-uuid y hashtags mal tipados', () => {
        expect(() =>
            validatePublishOptions({ personIds: ['no-es-uuid'] }),
        ).toThrowError(expect.objectContaining({ statusCode: 400 }));
        expect(() =>
            validatePublishOptions({ excludePersonIds: 'x' }),
        ).toThrowError(expect.objectContaining({ statusCode: 400 }));
        expect(() =>
            validatePublishOptions({ hashtags: Array(31).fill('#a') }),
        ).toThrowError(expect.objectContaining({ statusCode: 400 }));
        expect(() =>
            validatePublishOptions({ hashtags: [123] }),
        ).toThrowError(expect.objectContaining({ statusCode: 400 }));
    });
});

// ─── Rutas /api/review — preview + approve con opciones PG-06 ────────────────

describe('POST /api/review/:id/publish-preview y approve — opciones PG-06', () => {
    let server: Server | null = null;
    let baseUrl = '';

    const api = (path: string, init?: RequestInit, tenant = T_A) =>
        fetch(`${baseUrl}${path}`, {
            ...init,
            headers: {
                'content-type': 'application/json',
                'x-test-tenant': tenant,
                ...(init?.headers ?? {}),
            },
        });

    const seedPub = (id: string, tenantId = T_A) => {
        mocks.pubs.set(id, {
            id,
            tenantId,
            title: 'Nota',
            content: 'Contenido de la nota',
            imagePath: null,
            imageUrl: null,
            status: 'pending_review',
        });
    };

    beforeEach(async () => {
        mocks.pubs.clear();
        mocks.publishToChannels.mockReset().mockResolvedValue({ drive: 'ok' });
        mocks.updatePublicationStatus
            .mockReset()
            .mockImplementation(
                async (id: string, _t: string, status: string) => {
                    const pub = mocks.pubs.get(id);
                    if (pub) pub.status = status;
                    return pub ?? null;
                },
            );
        mocks.addEditHistoryEntry.mockReset().mockResolvedValue(null);

        const app = express();
        app.use(express.json());
        registerReviewRoutes(app);
        server = await new Promise<Server>((resolve) => {
            const s = app.listen(0, () => resolve(s));
        });
        const { port } = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
        reviewPublishDeps.enqueueForApproval = undefined;
        reviewPublishDeps.previewPublishEnqueue = undefined;
        reviewPublishDeps.publishJobDeps = undefined;
        await new Promise((r) => server?.close(() => r(null)));
        server = null;
    });

    const zernioDeps = (store: PublishJobDeps['store']): PublishJobDeps => ({
        store,
        now: () => T0,
        // PG-07: canal en memoria — default híbrido, sin assets legacy.
        channelStore: createMemoryPublishChannelStore().store,
        envTwitterBot: false,
        listConnections: async () => [
            makeConn({
                tenantId: T_A,
                platform: 'instagram',
                accountId: 'zacc_1',
            }),
            makeConn({
                id: CONN_TW,
                tenantId: T_A,
                platform: 'twitter',
                accountId: 'zacc_2',
            }),
        ],
        listAutoPublishConfigs: async () => [],
        getMentionSource: async () => ({
            quotes: [{ personId: P1 }],
            contentVariants: null,
        }),
        listMentionPersons: async () => [
            person(P1, 'María', { x: 'maria_x', instagram: 'maria.ig' }),
        ],
    });

    it('publish-preview devuelve el texto final por red sin encolar', async () => {
        seedPub(PUB_ID);
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = zernioDeps(store);

        const res = await api(`/api/review/${PUB_ID}/publish-preview`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            usedZernio: boolean;
            previews: Array<{
                platform: string;
                content: string;
                mentions: Array<{ handle: string }>;
            }>;
        };
        expect(body.usedZernio).toBe(true);
        expect(body.previews).toHaveLength(2);
        expect(
            body.previews.find((p) => p.platform === 'instagram')!.content,
        ).toBe('Contenido de la nota\n\n@maria.ig');
        expect(
            body.previews.find((p) => p.platform === 'twitter')!.content,
        ).toBe('Contenido de la nota\n\n@maria_x');
        expect(state.jobs).toHaveLength(0);
    });

    it('approve con excludePersonIds/hashtags compone y persiste el texto final', async () => {
        seedPub(PUB_ID);
        const { store, state } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = zernioDeps(store);

        const res = await api(`/api/review/${PUB_ID}/approve`, {
            method: 'POST',
            body: JSON.stringify({
                excludePersonIds: [P1],
                hashtags: ['#Urgente'],
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { publish: string; enqueued: number };
        expect(body.publish).toBe('zernio');
        expect(body.enqueued).toBe(2);
        for (const job of state.jobs) {
            expect(job.content).toBe('Contenido de la nota\n\n#Urgente');
            expect(job.payload.excludedPersonIds).toEqual([P1]);
            expect(job.payload.hashtags).toEqual(['#Urgente']);
        }
    });

    it('excludePersonIds mal tipado → 400 (no 500)', async () => {
        seedPub(PUB_ID);
        const { store } = createMemoryPublishJobStore({ now: () => T0 });
        reviewPublishDeps.publishJobDeps = zernioDeps(store);
        const res = await api(`/api/review/${PUB_ID}/approve`, {
            method: 'POST',
            body: JSON.stringify({ excludePersonIds: 'no-array' }),
        });
        expect(res.status).toBe(400);
    });

    it('publicación ajena → 404 en preview; sin auth → 401', async () => {
        seedPub(PUB_ID, 'tenant-ajeno');
        const res = await api(`/api/review/${PUB_ID}/publish-preview`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(404);
        const unauth = await fetch(
            `${baseUrl}/api/review/${PUB_ID}/publish-preview`,
            { method: 'POST', body: '{}' },
        );
        expect(unauth.status).toBe(401);
    });
});
