/**
 * Tests del slice PC-06 (línea editorial en prompts): serialización del
 * perfil efectivo a bloque de instrucciones, filtrado de variantes por
 * activeFormats y resolución con degradación.
 *
 * Sin DB ni IA: `buildEditorialPromptBlock` y `activeVariantKeys` son
 * puras; la resolución se testea contra un `EditorialStore` en memoria.
 *
 * AC cubiertos:
 *   - perfil vacío / null / isActive=false ⇒ bloque "".
 *   - cada campo del perfil aparece en el bloque (tono, guía, rubro,
 *     formatos, reglas, temas prohibidos, ejemplos, firma).
 *   - reglas y temas prohibidos van como RESTRICCIONES explícitas.
 *   - activeFormats restringido ⇒ sólo las variantes activas se piden.
 *   - sin perfil (ni default ni override) o error de resolución ⇒
 *     contexto vacío (la generación queda igual que antes).
 */
import { describe, expect, it } from 'vitest';

import {
    activeVariantKeys,
    buildEditorialPromptBlock,
    programBelongsToTenant,
    resolveEditorialPromptBlock,
    resolveEditorialPromptContext,
    VARIANT_FORMAT_KEYS,
} from '../src/server/services/editorialPromptService';
import type {
    EditorialProfileShape,
    EditorialStore,
} from '../src/server/services/editorialService';
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

const EMPTY_SHAPE: EditorialProfileShape = {
    name: null,
    tone: '',
    toneDescription: null,
    styleGuide: null,
    rules: [],
    examples: [],
    industry: null,
    activeFormats: [],
    forbiddenTopics: [],
    signature: null,
    isActive: true,
};

const FULL_SHAPE: EditorialProfileShape = {
    name: 'Canal A',
    tone: 'analitico',
    toneDescription: 'Tono de análisis en profundidad',
    styleGuide: 'Oraciones cortas, datos primero',
    rules: ['Nunca nombrar menores', 'Citar dos fuentes'],
    examples: [{ title: 'La economía en cifras', excerpt: 'Los datos del mes' }],
    industry: 'economia',
    activeFormats: ['twitter', 'linkedin'],
    forbiddenTopics: ['espectaculos', 'violencia grafica'],
    signature: 'Canal A informa',
    isActive: true,
};

// ---------------------------------------------------------------------------
// buildEditorialPromptBlock — serializador puro
// ---------------------------------------------------------------------------
describe('buildEditorialPromptBlock', () => {
    it('null / undefined ⇒ ""', () => {
        expect(buildEditorialPromptBlock(null)).toBe('');
        expect(buildEditorialPromptBlock(undefined)).toBe('');
    });

    it('perfil vacío (sin datos que aportar) ⇒ ""', () => {
        expect(buildEditorialPromptBlock(EMPTY_SHAPE)).toBe('');
    });

    it('isActive=false ⇒ "" (línea desactivada, no se inyecta)', () => {
        expect(buildEditorialPromptBlock({ ...FULL_SHAPE, isActive: false })).toBe('');
    });

    it('perfil completo ⇒ menciona cada campo', () => {
        const block = buildEditorialPromptBlock(FULL_SHAPE);
        expect(block).not.toBe('');

        expect(block).toContain('LINEA EDITORIAL DEL CANAL');
        // Tono + descripción
        expect(block).toContain('analitico');
        expect(block).toContain('Tono de análisis en profundidad');
        // Guía de estilo
        expect(block).toContain('Oraciones cortas, datos primero');
        // Rubro
        expect(block).toContain('economia');
        // Formatos activos
        expect(block).toContain('twitter, linkedin');
        // Reglas
        expect(block).toContain('Nunca nombrar menores');
        expect(block).toContain('Citar dos fuentes');
        // Temas prohibidos
        expect(block).toContain('espectaculos');
        expect(block).toContain('violencia grafica');
        // Ejemplos de referencia
        expect(block).toContain('La economía en cifras');
        expect(block).toContain('Los datos del mes');
        // Firma
        expect(block).toContain('Canal A informa');
    });

    it('reglas y temas prohibidos van como RESTRICCIONES, no como contexto', () => {
        const block = buildEditorialPromptBlock({
            ...EMPTY_SHAPE,
            rules: ['Nunca nombrar menores'],
            forbiddenTopics: ['espectaculos'],
        });

        // Reglas = obligatorias y prevalecen
        expect(block).toMatch(/reglas editoriales OBLIGATORIAS/i);
        expect(block).toMatch(/gana la regla/i);
        // Temas prohibidos = NO incluir
        expect(block).toMatch(/temas PROHIBIDOS/i);
        expect(block).toMatch(/NO los incluyas/i);
    });

    it('sólo serializa los campos que existen (parcial)', () => {
        const block = buildEditorialPromptBlock({ ...EMPTY_SHAPE, signature: 'Firma X' });
        expect(block).toContain('Firma X');
        expect(block).not.toContain('Reglas editoriales');
        expect(block).not.toContain('PROHIBIDOS');
        expect(block).not.toContain('Guia de estilo');
    });

    it('ejemplos sin título no generan la sección de ejemplos', () => {
        const block = buildEditorialPromptBlock({
            ...EMPTY_SHAPE,
            examples: [{ title: '  ', excerpt: 'extracto huérfano' }],
        });
        expect(block).not.toContain('Ejemplos de referencia');
        expect(block).not.toContain('extracto huérfano');
    });

    it('el tono se declara como tono de la línea editorial (directriz principal)', () => {
        const block = buildEditorialPromptBlock({ ...EMPTY_SHAPE, tone: 'urgente' });
        expect(block).toContain('directriz principal');
        expect(block).toContain('Tono de la linea editorial: urgente');
    });
});

// ---------------------------------------------------------------------------
// activeVariantKeys — qué formatos sociales se piden
// ---------------------------------------------------------------------------
const ALL_VARIANT_KEYS = [
    'twitterThread',
    'instagramCarousel',
    'linkedinPost',
    'youtubeDescription',
    'newsletterBlurb',
] as const;

describe('activeVariantKeys', () => {
    it('undefined / vacío ⇒ todos los formatos (comportamiento histórico)', () => {
        expect(activeVariantKeys(undefined)).toEqual([...ALL_VARIANT_KEYS]);
        expect(activeVariantKeys(null)).toEqual([...ALL_VARIANT_KEYS]);
        expect(activeVariantKeys([])).toEqual([...ALL_VARIANT_KEYS]);
    });

    it('activeFormats con formatos sociales ⇒ sólo esos', () => {
        const keys = activeVariantKeys(['twitter', 'linkedin']);
        expect(keys).toEqual(['twitterThread', 'linkedinPost']);
        expect(keys).not.toContain('instagramCarousel');
        expect(keys).not.toContain('youtubeDescription');
        expect(keys).not.toContain('newsletterBlurb');
    });

    it('activeFormats sólo con formatos de nota ⇒ sin restricción (todos)', () => {
        // 'flash'/'corta' son formatos de nota, no de variante social: el
        // perfil no expresó restricción sobre las variantes.
        expect(activeVariantKeys(['flash', 'corta'])).toEqual([...ALL_VARIANT_KEYS]);
    });

    it('mezcla nota + social ⇒ sólo los sociales', () => {
        expect(activeVariantKeys(['flash', 'instagram'])).toEqual(['instagramCarousel']);
    });

    it('cubre todas las plataformas declaradas en VARIANT_FORMAT_KEYS', () => {
        expect(Object.values(VARIANT_FORMAT_KEYS)).toEqual([...ALL_VARIANT_KEYS]);
        expect(activeVariantKeys(['twitter', 'instagram', 'linkedin', 'youtube', 'newsletter']))
            .toEqual([...ALL_VARIANT_KEYS]);
    });
});

// ---------------------------------------------------------------------------
// resolveEditorialPromptContext — resolución con store en memoria
// ---------------------------------------------------------------------------
describe('resolveEditorialPromptContext', () => {
    it('tenant sin perfil ⇒ contexto vacío (fallback honesto)', async () => {
        const { store } = createMemoryEditorialStore({ programs: PROGRAMS, profiles: [] });
        const ctx = await resolveEditorialPromptContext(TENANT_A, null, store);

        expect(ctx.block).toBe('');
        expect(ctx.activeFormats).toEqual([]);
        expect(ctx.tone).toBeNull();
    });

    it('perfil del tenant ⇒ bloque serializado + formatos + tono', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [makeProfileRow({ tenantId: TENANT_A, programId: null, ...FULL_SHAPE })],
        });
        const ctx = await resolveEditorialPromptContext(TENANT_A, null, store);

        expect(ctx.block).toContain('LINEA EDITORIAL DEL CANAL');
        expect(ctx.block).toContain('analitico');
        expect(ctx.activeFormats).toEqual(['twitter', 'linkedin']);
        expect(ctx.tone).toBe('analitico');
    });

    it('override del programa: mergea sobre el default del tenant', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ tenantId: TENANT_A, programId: null, ...FULL_SHAPE }),
                makeProfileRow({
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    tone: 'urgente',
                    rules: ['Regla del programa'],
                    isActive: true,
                }),
            ],
        });
        const ctx = await resolveEditorialPromptContext(TENANT_A, PROGRAM_A1, store);

        expect(ctx.tone).toBe('urgente');
        expect(ctx.block).toContain('urgente');
        expect(ctx.block).toContain('Regla del programa');
        // heredados del tenant (firma y formatos no pisados por el override)
        expect(ctx.block).toContain('Canal A informa');
        expect(ctx.activeFormats).toEqual(['twitter', 'linkedin']);
    });

    it('override sin perfil default del tenant ⇒ el perfil efectivo se inyecta igual', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({
                    tenantId: TENANT_A,
                    programId: PROGRAM_A1,
                    tone: 'urgente',
                    rules: ['Regla del programa'],
                    isActive: true,
                }),
            ],
        });
        const ctx = await resolveEditorialPromptContext(TENANT_A, PROGRAM_A1, store);

        expect(ctx.block).toContain('urgente');
        expect(ctx.block).toContain('Regla del programa');
    });

    it('isActive=false ⇒ contexto vacío (línea desactivada)', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ tenantId: TENANT_A, programId: null, ...FULL_SHAPE, isActive: false }),
            ],
        });
        const ctx = await resolveEditorialPromptContext(TENANT_A, null, store);
        expect(ctx.block).toBe('');
        expect(ctx.tone).toBeNull();
    });

    it('programId de otro tenant ⇒ se resuelve sin override (aislamiento)', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [
                makeProfileRow({ tenantId: TENANT_A, programId: null, ...FULL_SHAPE }),
                makeProfileRow({
                    tenantId: TENANT_B,
                    programId: PROGRAM_B1,
                    tone: 'custom',
                    rules: ['Regla ajena'],
                    isActive: true,
                }),
            ],
        });
        const ctx = await resolveEditorialPromptContext(TENANT_A, PROGRAM_B1, store);

        expect(ctx.block).toContain('LINEA EDITORIAL DEL CANAL');
        expect(ctx.block).not.toContain('Regla ajena');
        expect(ctx.tone).toBe('analitico');
    });

    it('store que falla ⇒ contexto vacío (degradación, no throw)', async () => {
        const brokenStore = {
            findTenantProfile: () => Promise.reject(new Error('db caido')),
        } as unknown as EditorialStore;
        const ctx = await resolveEditorialPromptContext(TENANT_A, null, brokenStore);

        expect(ctx.block).toBe('');
        expect(ctx.activeFormats).toEqual([]);
        expect(ctx.tone).toBeNull();
    });
});

describe('resolveEditorialPromptBlock', () => {
    it('devuelve sólo el bloque serializado', async () => {
        const { store } = createMemoryEditorialStore({
            programs: PROGRAMS,
            profiles: [makeProfileRow({ tenantId: TENANT_A, programId: null, ...FULL_SHAPE })],
        });
        const block = await resolveEditorialPromptBlock(TENANT_A, null, store);
        expect(block).toContain('LINEA EDITORIAL DEL CANAL');
    });

    it('sin perfil ⇒ ""', async () => {
        const { store } = createMemoryEditorialStore({ programs: PROGRAMS, profiles: [] });
        expect(await resolveEditorialPromptBlock(TENANT_A, null, store)).toBe('');
    });
});

// ---------------------------------------------------------------------------
// programBelongsToTenant — validación de programId en endpoints manuales
// ---------------------------------------------------------------------------
describe('programBelongsToTenant', () => {
    it('programa propio ⇒ true; ajeno o inexistente ⇒ false', async () => {
        const { store } = createMemoryEditorialStore({ programs: PROGRAMS, profiles: [] });
        expect(await programBelongsToTenant(TENANT_A, PROGRAM_A1, store)).toBe(true);
        expect(await programBelongsToTenant(TENANT_A, PROGRAM_B1, store)).toBe(false);
        expect(await programBelongsToTenant(TENANT_A, 'no-existe', store)).toBe(false);
    });

    it('store que falla ⇒ false (no se puede probar pertenencia)', async () => {
        const brokenStore = {
            programBelongsToTenant: () => Promise.reject(new Error('db caido')),
        } as unknown as EditorialStore;
        expect(await programBelongsToTenant(TENANT_A, PROGRAM_A1, brokenStore)).toBe(false);
    });
});
