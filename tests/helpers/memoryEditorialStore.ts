/**
 * memoryEditorialStore — implementación en memoria de `EditorialStore` para
 * tests del servicio de resolución editorial (PC-05). Sin DB ni red: los
 * mismos filtros por tenant que la implementación drizzle (un program_id
 * ajeno al tenant no se encuentra → no se lee ni se escribe su perfil).
 */
import type {
    EditorialProfileRow,
    EditorialStore,
    EditorialProfileShape,
} from '../../src/server/services/editorialService';

export interface MemoryProgram {
    id: string;
    tenantId: string;
    name: string;
}

export interface MemorySeed {
    profiles?: EditorialProfileRow[];
    programs?: MemoryProgram[];
}

let rowSeq = 0;

export function makeProfileRow(
    over: Partial<EditorialProfileRow> & { tenantId: string },
): EditorialProfileRow {
    return {
        id: over.id ?? `mem-ep-${++rowSeq}`,
        programId: null,
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
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...over,
    };
}

export function createMemoryEditorialStore(seed: MemorySeed) {
    const profiles = new Map<string, EditorialProfileRow>(
        (seed.profiles ?? []).map((p) => [p.id, { ...p }]),
    );
    const programs = new Map<string, MemoryProgram>(
        (seed.programs ?? []).map((p) => [p.id, { ...p }]),
    );

    const programBelongsToTenant = async (tenantId: string, programId: string) => {
        const p = programs.get(programId);
        return !!p && p.tenantId === tenantId;
    };

    // Mimics el INNER JOIN programs de la implementación drizzle: la fila
    // tiene que ser del tenant Y colgar de un programa del mismo tenant.
    const findProgramProfile = async (tenantId: string, programId: string) => {
        if (!(await programBelongsToTenant(tenantId, programId))) return null;
        const row = [...profiles.values()].find(
            (p) => p.tenantId === tenantId && p.programId === programId,
        );
        return row ? { ...row } : null;
    };

    const store: EditorialStore = {
        async findTenantProfile(tenantId) {
            const row = [...profiles.values()].find(
                (p) => p.tenantId === tenantId && p.programId === null,
            );
            return row ? { ...row } : null;
        },

        findProgramProfile,
        programBelongsToTenant,

        async listProgramOverrides(tenantId) {
            return [...profiles.values()]
                .filter((p) => p.tenantId === tenantId && p.programId !== null)
                .map((row) => ({
                    row: { ...row },
                    programName: programs.get(row.programId as string)?.name ?? '',
                }))
                .filter((e) => programs.get(e.row.programId as string)?.tenantId === tenantId);
        },

        async upsertProfile(tenantId, programId, fields: Partial<EditorialProfileShape>) {
            const existing = [...profiles.values()].find(
                (p) => p.tenantId === tenantId && p.programId === programId,
            );
            if (existing) {
                Object.assign(existing, fields, { updatedAt: new Date() });
                return { ...existing };
            }
            const row = makeProfileRow({ tenantId, programId, ...fields });
            profiles.set(row.id, row);
            return { ...row };
        },

        async deleteProgramProfile(tenantId, programId) {
            const existing = [...profiles.values()].find(
                (p) => p.tenantId === tenantId && p.programId === programId,
            );
            if (!existing) return false;
            return profiles.delete(existing.id);
        },

        async listPrograms(tenantId) {
            return [...programs.values()]
                .filter((p) => p.tenantId === tenantId)
                .map((p) => ({ id: p.id, name: p.name }));
        },
    };

    return { store, profiles, programs };
}
