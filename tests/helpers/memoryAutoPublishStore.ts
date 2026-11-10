/**
 * memoryAutoPublishStore — implementación en memoria de `AutoPublishStore`
 * para los tests de `autoPublishService` (PG-03). Sin DB: replica la
 * semántica exacta de la impl drizzle:
 *
 *   - `upsertConfig` keyed por (tenant_id, program_key) — la UNIQUE del
 *     schema. En conflicto pisa mode/platforms/publish_days/publish_time/
 *     timezone/is_active/program_id y refresca updated_at (como el
 *     ON CONFLICT real). Como program_key vale '__all__' para la global,
 *     la deduplicación de la config global funciona igual que en Postgres
 *     con la UNIQUE sobre program_key.
 *   - TODA lectura/escritura filtra por tenant_id (una fila ajena no se
 *     lee ni se toca).
 *   - `programExists` consulta las filas seed de programs (con tenantId —
 *     un programa de OTRO tenant no existe para este store).
 */
import type {
    AutoPublishConfigRow,
    AutoPublishConfigWrite,
    AutoPublishStore,
} from '../../src/server/services/autoPublishService';

/** Fila seed de programs — el memory store la usa para programExists. */
export interface MemoryProgramSeed {
    id: string;
    tenantId: string;
    name: string;
    isActive: boolean;
}

export interface MemoryAutoPublishState {
    configs: AutoPublishConfigRow[];
    programs: MemoryProgramSeed[];
}

let seq = 0;
const nextConfigId = () =>
    `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createMemoryAutoPublishStore(): {
    store: AutoPublishStore;
    state: MemoryAutoPublishState;
} {
    const state: MemoryAutoPublishState = {
        configs: [],
        programs: [],
    };

    const store: AutoPublishStore = {
        async getConfig(tenantId, programKey) {
            const row = state.configs.find(
                (c) => c.tenantId === tenantId && c.programKey === programKey,
            );
            return row ? clone(row) : null;
        },

        async getConfigById(tenantId, id) {
            const row = state.configs.find(
                (c) => c.id === id && c.tenantId === tenantId,
            );
            return row ? clone(row) : null;
        },

        async listConfigs(tenantId) {
            return state.configs
                .filter((c) => c.tenantId === tenantId)
                .sort(
                    (a, b) =>
                        a.programKey.localeCompare(b.programKey) ||
                        a.createdAt.getTime() - b.createdAt.getTime(),
                )
                .map(clone);
        },

        async upsertConfig(row: AutoPublishConfigWrite): Promise<AutoPublishConfigRow> {
            // ON CONFLICT (tenant_id, program_key) DO UPDATE — mismo target
            // que la UNIQUE del schema; cubre la global ('__all__') también.
            const existing = state.configs.find(
                (c) => c.tenantId === row.tenantId && c.programKey === row.programKey,
            );
            const now = new Date();
            if (existing) {
                existing.programId = row.programId;
                existing.mode = row.mode;
                existing.platforms = clone(row.platforms);
                existing.publishDays = clone(row.publishDays);
                existing.publishTime = row.publishTime;
                existing.timezone = row.timezone;
                existing.isActive = row.isActive;
                existing.updatedAt = now;
                return clone(existing);
            }
            const config: AutoPublishConfigRow = {
                id: nextConfigId(),
                tenantId: row.tenantId,
                programId: row.programId,
                programKey: row.programKey,
                mode: row.mode,
                platforms: clone(row.platforms),
                publishDays: clone(row.publishDays),
                publishTime: row.publishTime,
                timezone: row.timezone,
                isActive: row.isActive,
                createdAt: now,
                updatedAt: now,
            };
            state.configs.push(config);
            return clone(config);
        },

        async deleteConfig(tenantId, id) {
            const index = state.configs.findIndex(
                (c) => c.id === id && c.tenantId === tenantId,
            );
            if (index === -1) return false;
            state.configs.splice(index, 1);
            return true;
        },

        async programExists(tenantId, programId) {
            return state.programs.some(
                (p) => p.id === programId && p.tenantId === tenantId,
            );
        },
    };

    return { store, state };
}

/** Seed de conveniencia para programas del tenant. */
export function seedProgram(
    state: MemoryAutoPublishState,
    v: Partial<MemoryProgramSeed> & { id: string; tenantId: string },
): MemoryProgramSeed {
    const row: MemoryProgramSeed = {
        name: 'Programa de prueba',
        isActive: true,
        ...v,
    };
    state.programs.push(row);
    return row;
}
