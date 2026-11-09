import { db } from '../db/index.js';
import { editorialProfiles, editorialProfileVersions, programs } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// editorialProfileService — perfil editorial efectivo + versionado (T-28)
//
// Resolución: programa(editorial_overrides) → tenant(editorial_profiles) → default.
// Merge POR CAMPO: un override de programa solo pisa los campos que define;
// los objetos (rules, activeFormats) se mergean un nivel (programa gana claves).
// Cada update crea una editorial_profile_versions append-only (snapshot+version+1).
// ---------------------------------------------------------------------------

export interface EditorialProfileShape {
    tone: string;
    toneExamples: string[];
    rules: Record<string, unknown>;
    rubro: string | null;
    audience: string | null;
    activeFormats: Record<string, unknown>;
    approvalPolicy: 'review' | 'auto';
    defaultImageModel: string | null;
}

/** Default de plataforma — tenant sin perfil (spec: tono neutro, revisión obligatoria). */
export const DEFAULT_EDITORIAL_PROFILE: EditorialProfileShape = {
    tone: 'formal',
    toneExamples: [],
    rules: {},
    rubro: null,
    audience: null,
    activeFormats: {},
    approvalPolicy: 'review',
    defaultImageModel: null,
};

export interface EffectiveProfile extends EditorialProfileShape {
    /** Versión del perfil de tenant aplicada (0 = default de plataforma). */
    version: number;
    /** De dónde salieron los campos, para debugging del preview. */
    sources: {
        profile: 'tenant' | 'default';
        overriddenFields: string[];
    };
}

export type EditorialProfile = typeof editorialProfiles.$inferSelect;

// ── Helpers de shape ──────────────────────────────────────────────────────────
function toShape(row: EditorialProfile | null | undefined): EditorialProfileShape {
    if (!row) return { ...DEFAULT_EDITORIAL_PROFILE };
    return {
        tone: row.tone ?? DEFAULT_EDITORIAL_PROFILE.tone,
        toneExamples: Array.isArray(row.toneExamples) ? (row.toneExamples as string[]) : [],
        rules: (row.rules as Record<string, unknown>) ?? {},
        rubro: row.rubro ?? null,
        audience: row.audience ?? null,
        activeFormats: (row.activeFormats as Record<string, unknown>) ?? {},
        approvalPolicy: row.approvalPolicy ?? 'review',
        defaultImageModel: row.defaultImageModel ?? null,
    };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ── Reads ─────────────────────────────────────────────────────────────────────
export async function getTenantProfile(tenantId: string): Promise<EditorialProfile | null> {
    const [row] = await db.select().from(editorialProfiles)
        .where(eq(editorialProfiles.tenantId, tenantId))
        .limit(1);
    return row ?? null;
}

/**
 * Perfil efectivo: tenant/default + override por campo del programa.
 * `programId` debe pertenecer al mismo tenant (se verifica acá — nunca se
 * mezcla editorial cross-tenant).
 */
export async function getEffectiveProfile(tenantId: string, programId?: string | null): Promise<EffectiveProfile> {
    const profile = await getTenantProfile(tenantId);
    const base = toShape(profile);
    const version = profile?.version ?? 0;

    if (!programId) {
        return { ...base, version, sources: { profile: profile ? 'tenant' : 'default', overriddenFields: [] } };
    }

    // Una sola query: el programa debe existir Y pertenecer al tenant — nunca
    // se mezcla editorial cross-tenant.
    const [program] = await db.select({
        editorialOverrides: programs.editorialOverrides,
    }).from(programs)
        .where(and(eq(programs.id, programId), eq(programs.tenantId, tenantId)))
        .limit(1);

    if (!program) {
        return { ...base, version, sources: { profile: profile ? 'tenant' : 'default', overriddenFields: [] } };
    }

    const overrides = (program.editorialOverrides ?? {}) as Partial<EditorialProfileShape>;
    const overriddenFields: string[] = [];
    const merged: EditorialProfileShape = { ...base };

    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined || value === null) continue;
        const k = key as keyof EditorialProfileShape;
        if (k === 'rules' || k === 'activeFormats') {
            // Objetos: merge de claves un nivel — el programa gana por clave.
            if (isPlainObject(value)) {
                merged[k] = { ...(base[k] as Record<string, unknown>), ...value };
                overriddenFields.push(k);
            }
        } else if (k === 'toneExamples') {
            if (Array.isArray(value)) {
                merged.toneExamples = value as string[];
                overriddenFields.push(k);
            }
        } else {
            (merged as unknown as Record<string, unknown>)[k] = value;
            overriddenFields.push(k);
        }
    }

    return {
        ...merged,
        version,
        sources: { profile: profile ? 'tenant' : 'default', overriddenFields },
    };
}

// ── Write (versionado append-only) ────────────────────────────────────────────
export interface UpsertProfileInput {
    tone?: string;
    toneExamples?: string[];
    rules?: Record<string, unknown>;
    rubro?: string | null;
    audience?: string | null;
    activeFormats?: Record<string, unknown>;
    approvalPolicy?: 'review' | 'auto';
    defaultImageModel?: string | null;
    updatedBy?: string | null;
}

/**
 * Inserta o actualiza el perfil del tenant. SIEMPRE deja una fila nueva en
 * editorial_profile_versions con el snapshot completo resultante (append-only:
 * nunca edita ni borra versiones previas).
 */
export async function upsertProfile(tenantId: string, input: UpsertProfileInput): Promise<EditorialProfile> {
    const existing = await getTenantProfile(tenantId);
    const nextVersion = (existing?.version ?? 0) + 1;

    const fields: Partial<typeof editorialProfiles.$inferInsert> = {};
    if (input.tone !== undefined) fields.tone = input.tone;
    if (input.toneExamples !== undefined) fields.toneExamples = input.toneExamples;
    if (input.rules !== undefined) fields.rules = input.rules;
    if (input.rubro !== undefined) fields.rubro = input.rubro;
    if (input.audience !== undefined) fields.audience = input.audience;
    if (input.activeFormats !== undefined) fields.activeFormats = input.activeFormats;
    if (input.approvalPolicy !== undefined) fields.approvalPolicy = input.approvalPolicy;
    if (input.defaultImageModel !== undefined) fields.defaultImageModel = input.defaultImageModel;

    let saved: EditorialProfile;

    if (!existing) {
        [saved] = await db.insert(editorialProfiles).values({
            tenantId,
            ...fields,
            version: 1,
            updatedBy: input.updatedBy ?? null,
        }).returning();
    } else {
        [saved] = await db.update(editorialProfiles)
            .set({ ...fields, version: nextVersion, updatedBy: input.updatedBy ?? null })
            .where(eq(editorialProfiles.id, existing.id))
            .returning();
    }

    // Snapshot append-only (UNIQUE profile_id+version garantiza monotonía)
    await db.insert(editorialProfileVersions).values({
        profileId: saved.id,
        version: saved.version,
        snapshot: {
            ...toShape(saved),
            version: saved.version,
        },
        updatedBy: input.updatedBy ?? null,
    });

    return saved;
}

export async function listVersions(tenantId: string): Promise<Array<typeof editorialProfileVersions.$inferSelect>> {
    const profile = await getTenantProfile(tenantId);
    if (!profile) return [];
    return db.select().from(editorialProfileVersions)
        .where(eq(editorialProfileVersions.profileId, profile.id))
        .orderBy(editorialProfileVersions.version);
}
