/**
 * Memory store para los tests de PG-07 — implementa `PublishChannelStore`
 * (settings + business_assets) con los mismos filtros tenant-scoped que el
 * drizzle real: getSetting/upsertSetting por (tenantId,key), listActiveAssets
 * por tenantId+isActive, getAssetById/updateAssetMetadata por (tenantId,id).
 */
import type {
    PublishChannelAsset,
    PublishChannelStore,
} from '../../src/server/services/publishChannelService';

export interface ChannelAssetInput {
    id: string;
    tenantId: string;
    assetType: string;
    externalId: string;
    name?: string | null;
    metadata?: Record<string, unknown>;
    isActive?: boolean;
}

export function makeChannelAsset(
    v: ChannelAssetInput,
): PublishChannelAsset {
    return {
        id: v.id,
        tenantId: v.tenantId,
        assetType: v.assetType,
        externalId: v.externalId,
        name: v.name ?? null,
        metadata: v.metadata ?? {},
        isActive: v.isActive ?? true,
    };
}

export function createMemoryPublishChannelStore(seed?: {
    settings?: Record<string, Record<string, string>>;
    assets?: PublishChannelAsset[];
}): { store: PublishChannelStore; state: { settings: Map<string, Map<string, string>>; assets: PublishChannelAsset[] } } {
    const settings = new Map<string, Map<string, string>>();
    for (const [tenantId, kv] of Object.entries(seed?.settings ?? {})) {
        settings.set(tenantId, new Map(Object.entries(kv)));
    }
    const assets = (seed?.assets ?? []).map((a) => ({
        ...a,
        metadata: { ...a.metadata },
    }));

    const store: PublishChannelStore = {
        async getSetting(tenantId, key) {
            return settings.get(tenantId)?.get(key) ?? null;
        },
        async upsertSetting(tenantId, key, value) {
            if (!settings.has(tenantId)) settings.set(tenantId, new Map());
            settings.get(tenantId)!.set(key, value);
        },
        async listActiveAssets(tenantId) {
            return assets.filter((a) => a.tenantId === tenantId && a.isActive);
        },
        async getAssetById(tenantId, assetId) {
            return (
                assets.find((a) => a.tenantId === tenantId && a.id === assetId) ??
                null
            );
        },
        async updateAssetMetadata(tenantId, assetId, metadata) {
            const asset = assets.find(
                (a) => a.tenantId === tenantId && a.id === assetId,
            );
            if (!asset) return null;
            asset.metadata = { ...metadata };
            return asset;
        },
    };

    return { store, state: { settings, assets } };
}
