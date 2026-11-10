/**
 * memoryAssetsStore — implementación en memoria de `AssetStore` para los
 * tests de `assetsService` (PF-10). Sin DB: replica la semántica exacta
 * de la impl drizzle:
 *
 *   - `upsertAsset` keyed por (tenant_id, source_table, ref_id) — la UNIQUE
 *     del schema. En conflicto actualiza title/payload/parent/transmission/
 *     updated_at y PRESERVA status (como el ON CONFLICT real).
 *   - TODA lectura/escritura filtra por tenant_id (una fila ajena no se
 *     lee ni se toca).
 *   - `updateSourceStatus` escribe sobre las filas seed de clips /
 *     publications — si el ref_id no matchea (flyer: uuid derivado) es
 *     no-op, igual que en Postgres.
 */
import type {
    AssetListFilters,
    AssetRow,
    AssetSourceTable,
    AssetStore,
    AssetUpsertInput,
    LedgerClipRow,
    LedgerPublicationRow,
} from '../../src/server/services/assetsService';

/**
 * Filas seed con tenantId — `LedgerClipRow`/`LedgerPublicationRow` no lo
 * exponen al servicio (las queries ya filtran), pero el memory store lo
 * necesita para replicar el WHERE tenant_id en lecturas y write-through.
 */
export interface MemoryClipSeed extends LedgerClipRow {
    tenantId: string;
}

export interface MemoryPublicationSeed extends LedgerPublicationRow {
    tenantId: string;
}

export interface MemoryTransmissionSeed {
    id: string;
    tenantId: string;
    programId: string | null;
}

export interface MemoryAssetState {
    assets: AssetRow[];
    clips: MemoryClipSeed[];
    publications: MemoryPublicationSeed[];
    transmissions: MemoryTransmissionSeed[];
}

let seq = 0;
const nextAssetId = () =>
    `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createMemoryAssetsStore(): {
    store: AssetStore;
    state: MemoryAssetState;
} {
    const state: MemoryAssetState = {
        assets: [],
        clips: [],
        publications: [],
        transmissions: [],
    };

    const findAsset = (
        tenantId: string,
        sourceTable: string,
        refId: string,
    ) =>
        state.assets.find(
            (a) =>
                a.tenantId === tenantId &&
                a.sourceTable === sourceTable &&
                a.refId === refId,
        );

    const store: AssetStore = {
        async upsertAsset(row: AssetUpsertInput): Promise<AssetRow> {
            const existing = findAsset(
                row.tenantId,
                row.sourceTable,
                row.refId,
            );
            const now = new Date();
            if (existing) {
                // ON CONFLICT DO UPDATE: campos estructurales sí, status NO.
                existing.title = row.title ?? null;
                existing.payload = clone(row.payload ?? {});
                existing.parentAssetId = row.parentAssetId ?? null;
                existing.transmissionId = row.transmissionId ?? null;
                existing.updatedAt = now;
                return clone(existing);
            }
            const asset: AssetRow = {
                id: nextAssetId(),
                tenantId: row.tenantId,
                kind: row.kind,
                sourceTable: row.sourceTable,
                refId: row.refId,
                parentAssetId: row.parentAssetId ?? null,
                title: row.title ?? null,
                status: row.status,
                payload: clone(row.payload ?? {}),
                transmissionId: row.transmissionId ?? null,
                createdAt: now,
                updatedAt: now,
            };
            state.assets.push(asset);
            return clone(asset);
        },

        async getAsset(id, tenantId) {
            const row = state.assets.find(
                (a) => a.id === id && a.tenantId === tenantId,
            );
            return row ? clone(row) : null;
        },

        async listAssets(tenantId, filters: AssetListFilters = {}) {
            const page = await store.listAssetsPage(tenantId, filters, 1, Number.MAX_SAFE_INTEGER);
            return page.assets;
        },

        async listAssetsPage(tenantId, filters, page, pageSize) {
            const rows = state.assets
                .filter((a) => {
                    if (a.tenantId !== tenantId) return false;
                    if (filters.kind !== undefined && a.kind !== filters.kind) return false;
                    if (filters.status !== undefined && a.status !== filters.status) return false;
                    if (filters.transmissionId !== undefined) {
                        const transmission = state.transmissions.find((t) =>
                            t.id === filters.transmissionId && t.tenantId === tenantId,
                        );
                        if (!transmission || a.transmissionId !== filters.transmissionId) return false;
                    }
                    if (filters.programId !== undefined) {
                        const transmission = state.transmissions.find((t) =>
                            t.id === a.transmissionId &&
                            t.tenantId === tenantId &&
                            t.programId === filters.programId,
                        );
                        if (!transmission) return false;
                    }
                    return true;
                })
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
            const start = (page - 1) * pageSize;
            return { assets: rows.slice(start, start + pageSize).map(clone), total: rows.length };
        },

        async setAssetStatus(id, tenantId, status) {
            const row = state.assets.find(
                (a) => a.id === id && a.tenantId === tenantId,
            );
            if (!row) return null;
            row.status = status;
            row.updatedAt = new Date();
            return clone(row);
        },

        async updateSourceStatus(
            sourceTable: AssetSourceTable,
            refId,
            tenantId,
            legacyStatus,
        ) {
            if (sourceTable === 'clips') {
                const clip = state.clips.find(
                    (c) => c.id === refId && c.tenantId === tenantId,
                );
                if (clip) clip.status = legacyStatus;
            } else {
                const pub = state.publications.find(
                    (p) => p.id === refId && p.tenantId === tenantId,
                );
                if (pub) pub.status = legacyStatus;
            }
        },

        async listClips(tenantId, transmissionId) {
            return state.clips
                .filter(
                    (c) =>
                        c.tenantId === tenantId &&
                        (transmissionId === undefined ||
                            c.transmissionId === transmissionId),
                )
                .map((c) => ({ ...clone(c) }));
        },

        async listPublications(tenantId) {
            return state.publications
                .filter((p) => p.tenantId === tenantId)
                .map((p) => ({ ...clone(p) }));
        },

        async listPublicationFlyerPaths(tenantId, publicationId) {
            const pub = state.publications.find(
                (p) => p.id === publicationId && p.tenantId === tenantId,
            );
            if (!pub || !Array.isArray(pub.quoteFlyerPaths)) return [];
            return (pub.quoteFlyerPaths as unknown[]).filter(
                (v): v is string => typeof v === 'string' && v.trim().length > 0,
            );
        },
    };

    return { store, state };
}

// ─── Seeds de conveniencia ────────────────────────────────────────────────────

export function seedAssetClip(
    state: MemoryAssetState,
    v: Partial<MemoryClipSeed> & { id: string; tenantId: string },
): MemoryClipSeed {
    const row: MemoryClipSeed = {
        title: 'Clip de prueba',
        status: 'pending_review',
        videoPath: 'clips/test.mp4',
        duration: 30,
        transmissionId: null,
        metadata: null,
        ...v,
    };
    state.clips.push(row);
    return row;
}

export function seedAssetTransmission(
    state: MemoryAssetState,
    row: MemoryTransmissionSeed,
): MemoryTransmissionSeed {
    state.transmissions.push({ ...row });
    return row;
}

export function seedAssetPublication(
    state: MemoryAssetState,
    v: Partial<MemoryPublicationSeed> & { id: string; tenantId: string },
): MemoryPublicationSeed {
    const row: MemoryPublicationSeed = {
        title: 'Nota de prueba',
        status: 'pending_review',
        content: 'Contenido de la nota.',
        quoteFlyerPaths: [],
        ...v,
    };
    state.publications.push(row);
    return row;
}
