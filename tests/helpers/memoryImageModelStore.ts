/**
 * memoryImageModelStore — implementación en memoria de `ImageModelStore`
 * para tests de `imageModelService` (PF-08). Sin DB: la única query del
 * store real es `tenants.config.imageModel` filtrada por `tenants.id` —
 * acá se replica con un array de filas tenant-scoped (un tenant ajeno NO
 * lee el default de otro).
 */
import type { ImageModelStore } from '../../src/server/services/imageModelService';

export interface MemoryTenantRow {
    tenantId: string;
    /** `tenants.config.imageModel` — null = sin default configurado. */
    imageModel: string | null;
}

export interface MemoryImageModelState {
    tenants: MemoryTenantRow[];
}

export function createMemoryImageModelStore(): {
    store: ImageModelStore;
    state: MemoryImageModelState;
} {
    const state: MemoryImageModelState = { tenants: [] };

    const store: ImageModelStore = {
        async getTenantImageModel(tenantId) {
            // WHERE id = tenantId — el default de otro tenant no se lee.
            const row = state.tenants.find((t) => t.tenantId === tenantId);
            return row?.imageModel ?? null;
        },
    };

    return { store, state };
}

/** Atajo de seeding de tenant con su `config.imageModel`. */
export function seedImageModelTenant(
    state: MemoryImageModelState,
    v: { tenantId: string; imageModel?: string | null },
): MemoryTenantRow {
    const row: MemoryTenantRow = {
        tenantId: v.tenantId,
        imageModel: v.imageModel ?? null,
    };
    state.tenants.push(row);
    return row;
}
