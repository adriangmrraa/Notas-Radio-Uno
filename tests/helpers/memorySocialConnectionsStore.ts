/**
 * memorySocialConnectionsStore — implementación en memoria de
 * `SocialConnectionsStore` para los tests de `socialConnectionsService`
 * (PG-04). Sin DB: replica la semántica exacta de la impl drizzle:
 *
 *   - `upsertConnection` keyed por (tenant_id, platform, account_id) — la
 *     UNIQUE del schema. En conflicto pisa username/display_name/status/
 *     zernio_profile_id/last_synced_at y refresca updated_at (como el
 *     ON CONFLICT real): re-conectar actualiza, nunca duplica.
 *   - `upsertZernioProfile` keyed por tenant_id — un perfil por tenant.
 *   - `markMissingDisconnected` pone 'disconnected' + last_synced_at a las
 *     filas del tenant con status='connected' cuyo account_id no está en
 *     la lista (lista vacía ⇒ marca todas las conectadas — igual que el
 *     SQL: NOT IN () no se emite, queda sólo el filtro tenant+status).
 *   - TODA lectura/escritura filtra por tenant_id (una fila ajena no se
 *     lee, no se actualiza ni se borra).
 *   - `getTenantName` consulta las filas seed de `tenants`.
 */
import type {
    SocialConnectionRow,
    SocialConnectionsStore,
    SocialConnectionWrite,
    ZernioProfileRow,
    ZernioProfileWrite,
} from '../../src/server/services/socialConnectionsService';

export interface MemoryTenantSeed {
    id: string;
    name: string;
}

export interface MemorySocialConnectionsState {
    connections: SocialConnectionRow[];
    zernioProfiles: ZernioProfileRow[];
    tenants: MemoryTenantSeed[];
}

let seq = 0;
const nextId = () =>
    `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const cloneDates = (row: SocialConnectionRow): SocialConnectionRow => {
    const c = clone(row);
    c.lastSyncedAt = c.lastSyncedAt ? new Date(c.lastSyncedAt) : null;
    c.createdAt = new Date(c.createdAt);
    c.updatedAt = new Date(c.updatedAt);
    return c;
};
const cloneProfile = (row: ZernioProfileRow): ZernioProfileRow => {
    const c = clone(row);
    c.createdAt = new Date(c.createdAt);
    c.updatedAt = new Date(c.updatedAt);
    return c;
};

export function createMemorySocialConnectionsStore(): {
    store: SocialConnectionsStore;
    state: MemorySocialConnectionsState;
} {
    const state: MemorySocialConnectionsState = {
        connections: [],
        zernioProfiles: [],
        tenants: [],
    };

    const store: SocialConnectionsStore = {
        async listConnections(tenantId) {
            return state.connections
                .filter((c) => c.tenantId === tenantId)
                .sort(
                    (a, b) =>
                        a.platform.localeCompare(b.platform) ||
                        a.createdAt.getTime() - b.createdAt.getTime(),
                )
                .map(cloneDates);
        },

        async getConnectionById(tenantId, id) {
            const row = state.connections.find(
                (c) => c.id === id && c.tenantId === tenantId,
            );
            return row ? cloneDates(row) : null;
        },

        async upsertConnection(row: SocialConnectionWrite): Promise<SocialConnectionRow> {
            // ON CONFLICT (tenant_id, platform, account_id) DO UPDATE.
            const existing = state.connections.find(
                (c) =>
                    c.tenantId === row.tenantId &&
                    c.platform === row.platform &&
                    c.accountId === row.accountId,
            );
            const now = new Date();
            if (existing) {
                existing.username = row.username;
                existing.displayName = row.displayName;
                existing.status = row.status;
                existing.zernioProfileId = row.zernioProfileId;
                existing.lastSyncedAt = row.lastSyncedAt;
                existing.updatedAt = now;
                return cloneDates(existing);
            }
            const conn: SocialConnectionRow = {
                id: nextId(),
                tenantId: row.tenantId,
                platform: row.platform,
                accountId: row.accountId,
                username: row.username,
                displayName: row.displayName,
                status: row.status,
                zernioProfileId: row.zernioProfileId,
                lastSyncedAt: row.lastSyncedAt,
                createdAt: now,
                updatedAt: now,
            };
            state.connections.push(conn);
            return cloneDates(conn);
        },

        async markMissingDisconnected(tenantId, keepAccountIds, now) {
            let marked = 0;
            for (const c of state.connections) {
                if (c.tenantId !== tenantId || c.status !== 'connected') continue;
                if (keepAccountIds.includes(c.accountId)) continue;
                c.status = 'disconnected';
                c.lastSyncedAt = now;
                c.updatedAt = now;
                marked++;
            }
            return marked;
        },

        async deleteConnection(tenantId, id) {
            const index = state.connections.findIndex(
                (c) => c.id === id && c.tenantId === tenantId,
            );
            if (index === -1) return false;
            state.connections.splice(index, 1);
            return true;
        },

        async getZernioProfile(tenantId) {
            const row = state.zernioProfiles.find((p) => p.tenantId === tenantId);
            return row ? cloneProfile(row) : null;
        },

        async upsertZernioProfile(row: ZernioProfileWrite): Promise<ZernioProfileRow> {
            const existing = state.zernioProfiles.find((p) => p.tenantId === row.tenantId);
            const now = new Date();
            if (existing) {
                existing.profileId = row.profileId;
                existing.name = row.name;
                existing.updatedAt = now;
                return cloneProfile(existing);
            }
            const profile: ZernioProfileRow = {
                id: nextId(),
                tenantId: row.tenantId,
                profileId: row.profileId,
                name: row.name,
                createdAt: now,
                updatedAt: now,
            };
            state.zernioProfiles.push(profile);
            return cloneProfile(profile);
        },

        async getTenantName(tenantId) {
            return state.tenants.find((t) => t.id === tenantId)?.name ?? null;
        },
    };

    return { store, state };
}

/** Seed de conveniencia para tenants. */
export function seedTenant(
    state: MemorySocialConnectionsState,
    v: MemoryTenantSeed,
): MemoryTenantSeed {
    state.tenants.push(v);
    return v;
}
