/**
 * editorialService — línea editorial del canal (PC-05): resolución del perfil
 * efectivo tenant → programa.
 *
 * Semántica del schema (src/server/db/schema/editorialProfiles.ts):
 *   - `program_id IS NULL` → perfil DEFAULT del tenant (una fila por tenant).
 *   - `program_id` no nulo → override de ESE programa (una fila por par
 *     tenant+programa); gana campo a campo sobre el default del tenant.
 *
 * La persistencia pasa por la interfaz `EditorialStore` (inyectable): la
 * implementación real es `createDrizzleEditorialStore` (Postgres) y los tests
 * usan un store en memoria — sin red ni DB real. El merge es una función pura
 * (`mergeEditorialProfile`) para testear la regla campo a campo aislada.
 *
 * Regla de merge (campo a campo, decidida en PC05-BRIEF.md):
 *   - Escalares (`name`, `tone`, `toneDescription`, `styleGuide`, `industry`,
 *     `signature`, `isActive`): el override gana si el valor NO es null/
 *     undefined. Excepción documentada: `tone` e `isActive` son NOT NULL en la
 *     tabla, así que una fila de override existente SIEMPRE los define.
 *   - Arrays jsonb (`rules`, `examples`, `activeFormats`, `forbiddenTopics`):
 *     el override gana sólo si el array tiene al menos 1 elemento; un array
 *     vacío en el override significa "heredar del tenant".
 *   - Todo filtrado por tenant_id: un program_id de otro tenant no se resuelve
 *     (ni se lee su perfil, ni se escribe).
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import type { Database } from '../db/index.js';
import { editorialProfiles } from '../db/schema/editorialProfiles.js';
import { programs } from '../db/schema/programs.js';

// ---------------------------------------------------------------------------
// Tipos del dominio
// ---------------------------------------------------------------------------
export type EditorialProfileRow = typeof editorialProfiles.$inferSelect;

export interface EditorialExample {
    title: string;
    excerpt: string;
}

/** Campos editables del perfil (sin id/tenant/program/timestamps). */
export interface EditorialProfileShape {
    name: string | null;
    tone: string;
    toneDescription: string | null;
    styleGuide: string | null;
    rules: string[];
    examples: EditorialExample[];
    industry: string | null;
    activeFormats: string[];
    forbiddenTopics: string[];
    signature: string | null;
    isActive: boolean;
}

export const EDITORIAL_TONES = ['formal', 'informal', 'urgente', 'analitico', 'custom'] as const;
export type EditorialTone = (typeof EDITORIAL_TONES)[number];

/** Formatos válidos de `active_formats` (los mismos que ofrece la UI). */
export const EDITORIAL_FORMATS = [
    'flash',
    'corta',
    'completa',
    'cronica',
    'twitter',
    'linkedin',
    'instagram',
    'youtube',
    'newsletter',
] as const;

/** Perfil de plataforma: se usa cuando el tenant todavía no definió el suyo. */
export const DEFAULT_EDITORIAL_PROFILE: EditorialProfileShape = {
    name: null,
    tone: 'formal',
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

export interface EffectiveEditorialProfile extends EditorialProfileShape {
    sources: {
        /** false ⇒ el efectivo salió de DEFAULT_EDITORIAL_PROFILE. */
        hasTenantProfile: boolean;
        /** Campos que vienen del override del programa (camelCase). */
        overriddenFields: string[];
    };
}

// ---------------------------------------------------------------------------
// Merge (función pura — testeable sin DB)
// ---------------------------------------------------------------------------
const SCALAR_FIELDS = [
    'name',
    'tone',
    'toneDescription',
    'styleGuide',
    'industry',
    'signature',
    'isActive',
] as const;

const ARRAY_FIELDS = ['rules', 'examples', 'activeFormats', 'forbiddenTopics'] as const;

/**
 * Campos que un override "define" según la regla de merge: escalares no nulos
 * + arrays con al menos 1 elemento. Orden estable (como están en el shape).
 */
export function definedOverrideFields(override: Partial<EditorialProfileShape>): string[] {
    const fields: string[] = [];
    for (const k of SCALAR_FIELDS) {
        const v = override[k];
        if (v !== undefined && v !== null) fields.push(k);
    }
    for (const k of ARRAY_FIELDS) {
        const v = override[k];
        if (Array.isArray(v) && v.length > 0) fields.push(k);
    }
    return fields;
}

/**
 * Merge puro: `override` pisa sólo los campos que define (ver regla arriba);
 * el resto se hereda de `base`. No muta los argumentos.
 */
export function mergeEditorialProfile(
    base: EditorialProfileShape,
    override: Partial<EditorialProfileShape> | null | undefined,
): { profile: EditorialProfileShape; overriddenFields: string[] } {
    const overriddenFields = override ? definedOverrideFields(override) : [];
    const profile: EditorialProfileShape = {
        ...base,
        rules: [...base.rules],
        examples: [...base.examples],
        activeFormats: [...base.activeFormats],
        forbiddenTopics: [...base.forbiddenTopics],
    };
    for (const k of overriddenFields) {
        (profile as unknown as Record<string, unknown>)[k] = (
            override as unknown as Record<string, unknown>
        )[k];
    }
    return { profile, overriddenFields };
}

// ---------------------------------------------------------------------------
// Shape helpers (jsonb → tipado, defensivo)
// ---------------------------------------------------------------------------
function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

function asExamples(value: unknown): EditorialExample[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (v): v is EditorialExample =>
            !!v &&
            typeof v === 'object' &&
            typeof (v as EditorialExample).title === 'string' &&
            typeof (v as EditorialExample).excerpt === 'string',
    );
}

export function toEditorialShape(row: EditorialProfileRow): EditorialProfileShape {
    return {
        name: row.name ?? null,
        tone: row.tone ?? DEFAULT_EDITORIAL_PROFILE.tone,
        toneDescription: row.toneDescription ?? null,
        styleGuide: row.styleGuide ?? null,
        rules: asStringArray(row.rules),
        examples: asExamples(row.examples),
        industry: row.industry ?? null,
        activeFormats: asStringArray(row.activeFormats),
        forbiddenTopics: asStringArray(row.forbiddenTopics),
        signature: row.signature ?? null,
        isActive: row.isActive ?? true,
    };
}

// ---------------------------------------------------------------------------
// EditorialStore — persistencia inyectable (drizzle en prod, memoria en tests)
// ---------------------------------------------------------------------------
export interface ProgramOverrideEntry {
    row: EditorialProfileRow;
    programName: string;
}

export interface EditorialStore {
    /** Fila default del tenant (program_id IS NULL). */
    findTenantProfile(tenantId: string): Promise<EditorialProfileRow | null>;
    /**
     * Fila de override del programa. DEBE verificar además que el programa
     * pertenezca al tenant (join o doble chequeo): nunca se lee una fila
     * colgada de un program_id ajeno.
     */
    findProgramProfile(tenantId: string, programId: string): Promise<EditorialProfileRow | null>;
    programBelongsToTenant(tenantId: string, programId: string): Promise<boolean>;
    /** Overrides existentes del tenant (program_id NOT NULL), con nombre de programa. */
    listProgramOverrides(tenantId: string): Promise<ProgramOverrideEntry[]>;
    /**
     * Inserta o actualiza la fila (tenantId, programId). `programId = null` es
     * el default del tenant. En update, las claves ausentes no se tocan; en
     * insert, las ausentes toman el default de la tabla.
     */
    upsertProfile(
        tenantId: string,
        programId: string | null,
        fields: Partial<EditorialProfileShape>,
    ): Promise<EditorialProfileRow>;
    /** Borra la fila de override. Devuelve true si había algo que borrar. */
    deleteProgramProfile(tenantId: string, programId: string): Promise<boolean>;
    listPrograms(tenantId: string): Promise<Array<{ id: string; name: string }>>;
}

// ---------------------------------------------------------------------------
// Implementación drizzle (Postgres)
// ---------------------------------------------------------------------------
export function createDrizzleEditorialStore(executor: Database): EditorialStore {
    const db = executor;

    async function findTenantProfile(tenantId: string): Promise<EditorialProfileRow | null> {
        const [row] = await db
            .select()
            .from(editorialProfiles)
            .where(and(eq(editorialProfiles.tenantId, tenantId), isNull(editorialProfiles.programId)))
            .limit(1);
        return row ?? null;
    }

    async function findProgramProfile(
        tenantId: string,
        programId: string,
    ): Promise<EditorialProfileRow | null> {
        // El join con programs verifica que el programa sea del tenant:
        // una fila con tenant_id propio pero program_id ajeno no se lee.
        const [row] = await db
            .select({ profile: editorialProfiles })
            .from(editorialProfiles)
            .innerJoin(
                programs,
                and(eq(programs.id, editorialProfiles.programId), eq(programs.tenantId, tenantId)),
            )
            .where(
                and(
                    eq(editorialProfiles.tenantId, tenantId),
                    eq(editorialProfiles.programId, programId),
                ),
            )
            .limit(1);
        return row?.profile ?? null;
    }

    return {
        findTenantProfile,

        findProgramProfile,

        async programBelongsToTenant(tenantId, programId) {
            const [row] = await db
                .select({ id: programs.id })
                .from(programs)
                .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
                .limit(1);
            return !!row;
        },

        async listProgramOverrides(tenantId) {
            const rows = await db
                .select({ profile: editorialProfiles, programName: programs.name })
                .from(editorialProfiles)
                .innerJoin(
                    programs,
                    and(eq(programs.id, editorialProfiles.programId), eq(programs.tenantId, tenantId)),
                )
                .where(
                    and(eq(editorialProfiles.tenantId, tenantId), isNotNull(editorialProfiles.programId)),
                )
                .orderBy(programs.name);
            return rows.map((r) => ({ row: r.profile, programName: r.programName }));
        },

        async upsertProfile(tenantId, programId, fields) {
            const existing =
                programId === null
                    ? await findTenantProfile(tenantId)
                    : await findProgramProfile(tenantId, programId);

            const set: Partial<typeof editorialProfiles.$inferInsert> = {};
            if (fields.name !== undefined) set.name = fields.name;
            if (fields.tone !== undefined) set.tone = fields.tone;
            if (fields.toneDescription !== undefined) set.toneDescription = fields.toneDescription;
            if (fields.styleGuide !== undefined) set.styleGuide = fields.styleGuide;
            if (fields.rules !== undefined) set.rules = fields.rules;
            if (fields.examples !== undefined) set.examples = fields.examples;
            if (fields.industry !== undefined) set.industry = fields.industry;
            if (fields.activeFormats !== undefined) set.activeFormats = fields.activeFormats;
            if (fields.forbiddenTopics !== undefined) set.forbiddenTopics = fields.forbiddenTopics;
            if (fields.signature !== undefined) set.signature = fields.signature;
            if (fields.isActive !== undefined) set.isActive = fields.isActive;

            if (existing) {
                const [saved] = await db
                    .update(editorialProfiles)
                    .set(set)
                    .where(eq(editorialProfiles.id, existing.id))
                    .returning();
                return saved;
            }

            const [saved] = await db
                .insert(editorialProfiles)
                .values({ tenantId, programId, ...set })
                .returning();
            return saved;
        },

        async deleteProgramProfile(tenantId, programId) {
            const deleted = await db
                .delete(editorialProfiles)
                .where(
                    and(
                        eq(editorialProfiles.tenantId, tenantId),
                        eq(editorialProfiles.programId, programId),
                    ),
                )
                .returning({ id: editorialProfiles.id });
            return deleted.length > 0;
        },

        async listPrograms(tenantId) {
            return db
                .select({ id: programs.id, name: programs.name })
                .from(programs)
                .where(eq(programs.tenantId, tenantId))
                .orderBy(programs.name);
        },
    };
}

// ---------------------------------------------------------------------------
// API del servicio (store inyectado — ver tests/helpers/memoryEditorialStore)
// ---------------------------------------------------------------------------
export async function getTenantProfile(
    store: EditorialStore,
    tenantId: string,
): Promise<EditorialProfileRow | null> {
    return store.findTenantProfile(tenantId);
}

export async function getProgramProfile(
    store: EditorialStore,
    tenantId: string,
    programId: string,
): Promise<EditorialProfileRow | null> {
    // El programa debe ser del tenant antes de cualquier lectura/escritura.
    if (!(await store.programBelongsToTenant(tenantId, programId))) return null;
    return store.findProgramProfile(tenantId, programId);
}

/**
 * Perfil efectivo: default del tenant (o DEFAULT_EDITORIAL_PROFILE si no
 * existe) + merge campo a campo del override del programa (si existe y es del
 * tenant). Un programId ajeno se resuelve como "sin override".
 */
export async function getEffectiveProfile(
    store: EditorialStore,
    tenantId: string,
    programId?: string | null,
): Promise<EffectiveEditorialProfile> {
    const tenantRow = await store.findTenantProfile(tenantId);
    const base = tenantRow
        ? toEditorialShape(tenantRow)
        : { ...DEFAULT_EDITORIAL_PROFILE, rules: [], examples: [], activeFormats: [], forbiddenTopics: [] };
    const sources = { hasTenantProfile: !!tenantRow, overriddenFields: [] as string[] };

    if (!programId) return { ...base, sources };

    const overrideRow = await getProgramProfile(store, tenantId, programId);
    if (!overrideRow) return { ...base, sources };

    const { profile, overriddenFields } = mergeEditorialProfile(base, toEditorialShape(overrideRow));
    return { ...profile, sources: { ...sources, overriddenFields } };
}

export async function upsertTenantProfile(
    store: EditorialStore,
    tenantId: string,
    fields: Partial<EditorialProfileShape>,
): Promise<EditorialProfileRow> {
    return store.upsertProfile(tenantId, null, fields);
}

/** Upsert del override del programa. null ⇒ el programa no es del tenant (404). */
export async function upsertProgramProfile(
    store: EditorialStore,
    tenantId: string,
    programId: string,
    fields: Partial<EditorialProfileShape>,
): Promise<EditorialProfileRow | null> {
    if (!(await store.programBelongsToTenant(tenantId, programId))) return null;
    return store.upsertProfile(tenantId, programId, fields);
}

/** Borra el override. false ⇒ no existe o el programa es de otro tenant. */
export async function deleteProgramOverride(
    store: EditorialStore,
    tenantId: string,
    programId: string,
): Promise<boolean> {
    if (!(await store.programBelongsToTenant(tenantId, programId))) return false;
    return store.deleteProgramProfile(tenantId, programId);
}

export interface ProgramOverrideSummary {
    programId: string;
    programName: string;
    /** Campos que el override define (pisa al tenant), según la regla de merge. */
    overriddenFields: string[];
    isActive: boolean;
}

export async function listProgramOverrideSummaries(
    store: EditorialStore,
    tenantId: string,
): Promise<ProgramOverrideSummary[]> {
    const entries = await store.listProgramOverrides(tenantId);
    return entries.map(({ row, programName }) => ({
        programId: row.programId as string,
        programName,
        overriddenFields: definedOverrideFields(toEditorialShape(row)),
        isActive: row.isActive,
    }));
}

export async function listPrograms(
    store: EditorialStore,
    tenantId: string,
): Promise<Array<{ id: string; name: string }>> {
    return store.listPrograms(tenantId);
}
