/**
 * Tests del slice PC-05 (línea editorial): resolución del perfil efectivo
 * tenant → programa.
 *
 * Corren contra `mergeEditorialProfile` (función pura) y un `EditorialStore`
 * en memoria (sin DB, sin red). Los AC centrales:
 *   - tenant sin perfil → DEFAULT_EDITORIAL_PROFILE.
 *   - tenant con perfil, sin programId → el perfil del tenant.
 *   - override de programa: pisa sólo los campos que define; el resto hereda.
 *   - arrays vacíos en el override → heredan (no pisan con vacío).
 *   - sources.overriddenFields = exactamente los campos pisados.
 *   - aislamiento: un programId de otro tenant no se resuelve ni se lee.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/neon-serverless';

import {
    DEFAULT_EDITORIAL_PROFILE,
    buildProfileUpsert,
    definedOverrideFields,
    getEffectiveProfile,
    getProgramProfile,
    mergeEditorialProfile,
    toEditorialShape,
    upsertProgramProfile,
    upsertTenantProfile,
    type EditorialProfileShape,
} from '../src/server/services/editorialService';
import { parseProfileBody } from '../src/server/routes/editorial';
import {
    createMemoryEditorialStore,
    makeProfileRow,
    type MemoryProgram,
} from './helpers/memoryEditorialStore';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const PROGRAM_A1 = '00000000-0000-4000-8000-0000000000a1';
const PROGRAM_B1 = '00000000-0000-4000-8000-0000000000b1';

const PROGRAMS: MemoryProgram[] = [
    { id: PROGRAM_A1, tenantId: TENANT_A, name: 'Mañana informativa' },
    { id: PROGRAM_B1, tenantId: TENANT_B, name: 'Programa ajeno' },
];

const TENANT_SHAPE: EditorialProfileShape = {
    name: 'Canal A',
    tone: 'formal',
    toneDescription: 'Tono institucional',
    styleGuide: 'Guía del canal',
    rules: ['Nunca nombrar menores', 'Citar dos fuentes'],
    examples: [{ title: 'Flash tipo', excerpt: 'Extracto del canal' }],
    industry: 'noticias',
    activeFormats: ['flash', 'corta'],
    forbiddenTopics: ['espectáculos'],
    signature: 'Canal A informa',
    isActive: true,
};

function seedTenant() {
    return createMemoryEditorialStore({
        programs: PROGRAMS,
        profiles: [makeProfileRow({ id: 'ep-tenant-a', tenantId: TENANT_A, programId: null, ...TENANT_SHAPE })],
    });
}

// ---------------------------------------------------------------------------
// mergeEditorialProfile — función pura
// ---------------------------------------------------------------------------
describe('mergeEditorialProfile (pura)', () => {
    it('override null/undefined devuelve la base sin campos pisados', () => {
        for (const override of [null, undefined, {}]) {
            const { profile, overriddenFields } = mergeEditorialProfile(TENANT_SHAPE, override);
            expect(profile).toEqual(TENANT_SHAPE);
            expect(overriddenFields).toEqual([]);
        }
    });

    it('pisa sólo los campos definidos y hereda el resto', () => {
        const { profile, overriddenFields } = mergeEditorialProfile(TENANT_SHAPE, {
            tone: 'urgente',
            rules: ['Regla del programa'],
        });

        expect(profile.tone).toBe('urgente');
        expect(profile.rules).toEqual(['Regla del programa']);
        // Heredados del tenant:
        expect(profile.name).toBe('Canal A');
        expect(profile.industry).toBe('noticias');
        expect(profile.signature).toBe('Canal A informa');
        expect(profile.examples).toEqual([{ title: 'Flash tipo', excerpt: 'Extracto del canal' }]);
        expect(overriddenFields).toEqual(['tone', 'rules']);
    });

    it('escalares null en el override NO pisan (heredan)', () => {
        const { profile, overriddenFields } = mergeEditorialProfile(TENANT_SHAPE, {
            name: null,
            industry: null,
            signature: null,
            toneDescription: null,
        });
        expect(profile.name).toBe('Canal A');
        expect(profile.industry).toBe('noticias');
        expect(profile.signature).toBe('Canal A informa');
        expect(overriddenFields).toEqual([]);
    });

    it('arrays vacíos en el override NO pisan (heredan)', () => {
        const { profile, overriddenFields } = mergeEditorialProfile(TENANT_SHAPE, {
            rules: [],
            examples: [],
            activeFormats: [],
            forbiddenTopics: [],
        });
        expect(profile.rules).toEqual(TENANT_SHAPE.rules);
        expect(profile.examples).toEqual(TENANT_SHAPE.examples);
        expect(profile.activeFormats).toEqual(TENANT_SHAPE.activeFormats);
        expect(profile.forbiddenTopics).toEqual(TENANT_SHAPE.forbiddenTopics);
        expect(overriddenFields).toEqual([]);
    });

    it('no muta la base ni el override', () => {
        const base: EditorialProfileShape = { ...TENANT_SHAPE, rules: ['r1'] };
        const override = { tone: 'informal', rules: ['r2'] };
        mergeEditorialProfile(base, override);
        expect(base.tone).toBe('formal');
        expect(base.rules).toEqual(['r1']);
        expect(override.rules).toEqual(['r2']);
    });
});

describe('definedOverrideFields', () => {
    it('lista los campos definidos en orden estable', () => {
        const fields = definedOverrideFields({
            name: 'X',
            tone: 'custom',
            toneDescription: null,
            rules: ['a'],
            examples: [],
            industry: 'radio',
            isActive: false,
            activeFormats: ['flash'],
        });
        expect(fields).toEqual(['name', 'tone', 'industry', 'isActive', 'rules', 'activeFormats']);
    });
});

// ---------------------------------------------------------------------------
// getEffectiveProfile — resolución con store
// ---------------------------------------------------------------------------
describe('getEffectiveProfile', () => {
    it('tenant sin perfil → DEFAULT_EDITORIAL_PROFILE (hasTenantProfile=false)', async () => {
        const { store } = createMemoryEditorialStore({ programs: PROGRAMS, profiles: [] });
        const eff = await getEffectiveProfile(store, TENANT_A);

        expect(eff).toMatchObject(DEFAULT_EDITORIAL_PROFILE);
        expect(eff.sources.hasTenantProfile).toBe(false);
        expect(eff.sources.overriddenFields).toEqual([]);
    });

    it('tenant con perfil, sin programId → devuelve el perfil del tenant', async () => {
        const { store } = seedTenant();
        const eff = await getEffectiveProfile(store, TENANT_A);

        expect(eff).toMatchObject(TENANT_SHAPE);
        expect(eff.sources.hasTenantProfile).toBe(true);
        expect(eff.sources.overriddenFields).toEqual([]);
    });

    it('override de programa: pisa los campos definidos, hereda el resto', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ id: 'ep-tenant-a', tenantId: TENANT_A, programId: null, ...TENANT_SHAPE }),
                makeProfileRow({
                    id: 'ep-ov-a1',
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    name: null,
                    tone: 'urgente',
                    toneDescription: 'Breaking news del programa',
                    styleGuide: null,
                    rules: ['Regla del programa'],
                    examples: [],
                    industry: null,
                    activeFormats: [],
                    forbiddenTopics: [],
                    signature: null,
                    isActive: true,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_A1);

        // Pisados por el override (tone siempre está definido: es NOT NULL).
        expect(eff.tone).toBe('urgente');
        expect(eff.toneDescription).toBe('Breaking news del programa');
        expect(eff.rules).toEqual(['Regla del programa']);
        expect(eff.isActive).toBe(true);
        // Heredados del tenant.
        expect(eff.name).toBe('Canal A');
        expect(eff.styleGuide).toBe('Guía del canal');
        expect(eff.industry).toBe('noticias');
        expect(eff.signature).toBe('Canal A informa');
        expect(eff.examples).toEqual(TENANT_SHAPE.examples);
        expect(eff.activeFormats).toEqual(TENANT_SHAPE.activeFormats);
        expect(eff.forbiddenTopics).toEqual(TENANT_SHAPE.forbiddenTopics);
    });

    it('arrays vacíos en el override heredan (no pisan con vacío)', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ id: 'ep-tenant-a', tenantId: TENANT_A, programId: null, ...TENANT_SHAPE }),
                makeProfileRow({
                    id: 'ep-ov-a1',
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    tone: 'informal',
                    rules: [],
                    examples: [],
                    activeFormats: [],
                    forbiddenTopics: [],
                    isActive: false,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_A1);

        expect(eff.rules).toEqual(TENANT_SHAPE.rules);
        expect(eff.examples).toEqual(TENANT_SHAPE.examples);
        expect(eff.activeFormats).toEqual(TENANT_SHAPE.activeFormats);
        expect(eff.forbiddenTopics).toEqual(TENANT_SHAPE.forbiddenTopics);
        expect(eff.sources.overriddenFields).not.toContain('rules');
        expect(eff.sources.overriddenFields).not.toContain('examples');
    });

    it('sources.overriddenFields = exactamente los campos pisados', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ id: 'ep-tenant-a', tenantId: TENANT_A, programId: null, ...TENANT_SHAPE }),
                makeProfileRow({
                    id: 'ep-ov-a1',
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    tone: 'analitico',
                    industry: 'deportes',
                    rules: [],
                    isActive: true,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_A1);

        expect([...eff.sources.overriddenFields].sort()).toEqual(
            ['industry', 'isActive', 'tone'].sort(),
        );
    });

    it('override sobre tenant sin perfil: mergea sobre DEFAULT', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({
                    id: 'ep-ov-a1',
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    tone: 'urgente',
                    rules: ['Regla del programa'],
                    isActive: true,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_A1);

        expect(eff.sources.hasTenantProfile).toBe(false);
        expect(eff.tone).toBe('urgente');
        expect(eff.rules).toEqual(['Regla del programa']);
        expect(eff.industry).toBeNull();
        expect(eff.signature).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Aislamiento multi-tenant
// ---------------------------------------------------------------------------
describe('aislamiento multi-tenant', () => {
    it('programId de otro tenant → se resuelve como sin override', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ id: 'ep-tenant-a', tenantId: TENANT_A, programId: null, ...TENANT_SHAPE }),
                // Fila corrupta/ajena: cuelga del programa de TENANT_B.
                makeProfileRow({
                    id: 'ep-ov-b1',
                    tenantId: TENANT_B,
                    programId: PROGRAM_B1,
                    tone: 'custom',
                    rules: ['Regla ajena'],
                    isActive: true,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_B1);

        expect(eff).toMatchObject(TENANT_SHAPE);
        expect(eff.sources.overriddenFields).toEqual([]);
        // No se leyó el override ajeno.
        expect(eff.rules).toEqual(TENANT_SHAPE.rules);
    });

    it('getProgramProfile con programId de otro tenant → null', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({
                    id: 'ep-ov-b1',
                    tenantId: TENANT_B,
                    programId: PROGRAM_B1,
                    tone: 'custom',
                    isActive: true,
                }),
            ],
        });

        const profile = await getProgramProfile(store, TENANT_A, PROGRAM_B1);
        expect(profile).toBeNull();
    });

    it('fila con tenant_id propio pero program_id ajeno no se lee (join)', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                // Fila corrupta: dice ser de TENANT_A pero cuelga del programa de TENANT_B.
                makeProfileRow({
                    id: 'ep-corrupt',
                    tenantId: TENANT_A,
                    programId: PROGRAM_B1,
                    tone: 'custom',
                    isActive: true,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_B1);
        expect(eff.sources.overriddenFields).toEqual([]);
        expect(eff.tone).toBe(DEFAULT_EDITORIAL_PROFILE.tone);
    });
});

// ---------------------------------------------------------------------------
// toEditorialShape — parsing defensivo de jsonb
// ---------------------------------------------------------------------------
describe('toEditorialShape', () => {
    it('jsonb con tipos raros se normaliza (strings solamente)', () => {
        const row = makeProfileRow({
            tenantId: TENANT_A,
            rules: ['ok', 42, null, 'bien'] as unknown as string[],
            examples: [
                { title: 'T', excerpt: 'E' },
                { title: 'sin excerpt' },
                'no-es-objeto',
            ] as unknown as { title: string; excerpt: string }[],
            activeFormats: 'flash' as unknown as string[],
        });
        const shape = toEditorialShape(row);
        expect(shape.rules).toEqual(['ok', 'bien']);
        expect(shape.examples).toEqual([{ title: 'T', excerpt: 'E' }]);
        expect(shape.activeFormats).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// is_active del tenant — interruptor maestro (W3)
// ---------------------------------------------------------------------------
describe('is_active del tenant — interruptor maestro', () => {
    it('canal inactivo + override isActive=true ⇒ efectivo inactivo', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({
                    id: 'ep-tenant-a',
                    tenantId: TENANT_A,
                    programId: null,
                    ...TENANT_SHAPE,
                    isActive: false,
                }),
                makeProfileRow({
                    id: 'ep-ov-a1',
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    tone: 'urgente',
                    isActive: true,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_A1);

        expect(eff.isActive).toBe(false);
        // Decisión documentada: la fila de override DEFINE isActive ⇒ queda
        // listado; el clamp del canal aplica al valor efectivo.
        expect(eff.sources.overriddenFields).toContain('isActive');
    });

    it('canal activo + override isActive=false ⇒ efectivo inactivo (el override sí puede desactivar)', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ id: 'ep-tenant-a', tenantId: TENANT_A, programId: null, ...TENANT_SHAPE }),
                makeProfileRow({
                    id: 'ep-ov-a1',
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    tone: 'urgente',
                    isActive: false,
                }),
            ],
        });

        const eff = await getEffectiveProfile(store, TENANT_A, PROGRAM_A1);
        expect(eff.isActive).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// upsertProfile — una fila por clave; la segunda escritura actualiza (W1)
// ---------------------------------------------------------------------------
describe('upsertProfile — idempotente por clave', () => {
    it('dos upserts del default del tenant ⇒ una sola fila y la segunda actualiza', async () => {
        const { store, profiles } = createMemoryEditorialStore({ programs: PROGRAMS, profiles: [] });

        await upsertTenantProfile(store, TENANT_A, { tone: 'formal', name: 'Canal A' });
        const again = await upsertTenantProfile(store, TENANT_A, { tone: 'informal', industry: 'deportes' });

        const rows = [...profiles.values()].filter(
            (p) => p.tenantId === TENANT_A && p.programId === null,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(again.id);
        expect(again.tone).toBe('informal');
        expect(again.industry).toBe('deportes');
        // Los campos ausentes en el segundo upsert no se tocan.
        expect(again.name).toBe('Canal A');
    });

    it('dos upserts del mismo override ⇒ una fila; programa ajeno ⇒ null y no escribe', async () => {
        const { store, profiles } = createMemoryEditorialStore({ programs: PROGRAMS, profiles: [] });

        await upsertProgramProfile(store, TENANT_A, PROGRAM_A1, { tone: 'urgente' });
        const again = await upsertProgramProfile(store, TENANT_A, PROGRAM_A1, {
            tone: 'analitico',
            rules: ['r1'],
        });

        const rows = [...profiles.values()].filter(
            (p) => p.tenantId === TENANT_A && p.programId === PROGRAM_A1,
        );
        expect(rows).toHaveLength(1);
        expect(again?.tone).toBe('analitico');
        expect(again?.rules).toEqual(['r1']);

        const foreign = await upsertProgramProfile(store, TENANT_A, PROGRAM_B1, { tone: 'custom' });
        expect(foreign).toBeNull();
        expect(profiles.size).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// buildProfileUpsert — el SQL es una sola sentencia ON CONFLICT (W1)
// ---------------------------------------------------------------------------
describe('buildProfileUpsert — SQL atómico', () => {
    const sqlDb = drizzle('postgres://unused.invalid/db');

    it('default del tenant ⇒ ON CONFLICT (tenant_id) WHERE program_id IS NULL (índice parcial)', () => {
        const q = buildProfileUpsert(sqlDb, TENANT_A, null, { tone: 'formal' }).toSQL();
        expect(q.sql).toContain('insert into "editorial_profiles"');
        expect(q.sql).toContain(
            'on conflict ("tenant_id") where "editorial_profiles"."program_id" is null do update set',
        );
    });

    it('override de programa ⇒ ON CONFLICT (tenant_id, program_id); sin SELECT previo', () => {
        const q = buildProfileUpsert(sqlDb, TENANT_A, PROGRAM_A1, { tone: 'urgente' }).toSQL();
        expect(q.sql).toContain('on conflict ("tenant_id","program_id") do update set');
        expect(q.sql.toLowerCase()).not.toContain('select');
    });
});

// ---------------------------------------------------------------------------
// parseProfileBody — normalización de strings vacíos (W4)
// ---------------------------------------------------------------------------
describe('parseProfileBody — strings vacíos', () => {
    it('escalares: vacío/whitespace ⇒ ausente (no pisa); null limpia; valor se trimea', () => {
        const { fields, error } = parseProfileBody({ tone: 'formal', name: '   ', signature: '' });
        expect(error).toBeUndefined();
        expect(fields?.tone).toBe('formal');
        expect(fields && 'name' in fields).toBe(false);
        expect(fields && 'signature' in fields).toBe(false);

        const cleared = parseProfileBody({ tone: 'formal', name: null });
        expect(cleared.fields && 'name' in cleared.fields).toBe(true);
        expect(cleared.fields?.name).toBeNull();

        expect(parseProfileBody({ tone: 'formal', name: '  Canal A  ' }).fields?.name).toBe('Canal A');
    });

    it('arrays: items vacíos se descartan; puros vacíos ⇒ [] (hereda)', () => {
        const { fields } = parseProfileBody({ tone: 'formal', rules: ['  ok  ', '   ', 'bien'] });
        expect(fields?.rules).toEqual(['ok', 'bien']);

        const emptied = parseProfileBody({ tone: 'formal', rules: ['', '   '] });
        expect(emptied.fields?.rules).toEqual([]);
    });

    it('activeFormats: normaliza antes del enum check y rechaza inválidos', () => {
        const ok = parseProfileBody({ tone: 'formal', activeFormats: [' flash ', ''] });
        expect(ok.fields?.activeFormats).toEqual(['flash']);

        const bad = parseProfileBody({ tone: 'formal', activeFormats: ['flash', 'bogus'] });
        expect(bad.error).toBeDefined();
        expect(bad.fields).toBeUndefined();
    });

    it('examples: title vacío se ignora, excerpt ausente ⇒ "", malformados ⇒ error', () => {
        const { fields, error } = parseProfileBody({
            tone: 'formal',
            examples: [
                { title: '  ', excerpt: 'ignorado' },
                { title: '  Titulo  ', excerpt: '  Extracto  ' },
                { title: 'Sin excerpt' },
            ],
        });
        expect(error).toBeUndefined();
        expect(fields?.examples).toEqual([
            { title: 'Titulo', excerpt: 'Extracto' },
            { title: 'Sin excerpt', excerpt: '' },
        ]);

        expect(parseProfileBody({ tone: 'formal', examples: ['no-es-objeto'] }).error).toBeDefined();
        expect(parseProfileBody({ tone: 'formal', examples: [{ title: 'T', excerpt: 42 }] }).error).toBeDefined();
        expect(parseProfileBody({ tone: 'formal', examples: [{ title: 1 }] }).error).toBeDefined();
    });
});
