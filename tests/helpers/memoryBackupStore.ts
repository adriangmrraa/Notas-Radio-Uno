/**
 * memoryBackupStore — implementación en memoria de `BackupStore` para los
 * tests de `assetBackupService` (PI-05). Sin DB: reproduce los MISMOS
 * filtros que la implementación drizzle:
 *
 *   - `listAssetSources`: una fila por path derivado de clips
 *     (video_path, subtitles_path, metadata.sourceVideoPath) y de
 *     publications (image_path, quote_flyer_paths[]), dedupe por
 *     (tenant, source_path), orden estable por (tenantId, sourcePath),
 *     acotado por `opts.tenantId` y `opts.limit`.
 *   - `getEntry`/`recordEntry`: upsert por (tenant_id, source_path) — la
 *     UNIQUE del schema replicada: re-correr nunca duplica.
 *   - `summarize`: cobertura por tenant con bytes sólo de `backed_up`
 *     (mismo criterio que el GROUP BY drizzle).
 */
import type {
  AssetSourceRow,
  BackupEntry,
  BackupStore,
  BackupTenantCoverage,
} from '../../src/server/services/assetBackupService';

export interface MemoryClipAssetRow {
  id: string;
  tenantId: string;
  videoPath?: string | null;
  subtitlesPath?: string | null;
  /** `metadata->>'sourceVideoPath'` — render anterior auditable. */
  sourceVideoPath?: string | null;
}

export interface MemoryPublicationAssetRow {
  id: string;
  tenantId: string;
  imagePath?: string | null;
  flyerPaths?: string[];
}

export interface MemoryBackupState {
  clips: MemoryClipAssetRow[];
  publications: MemoryPublicationAssetRow[];
  /** Manifest: clave `${tenantId}${sourcePath}` (la UNIQUE replicada). */
  entries: Map<string, BackupEntry>;
  /** Historial de recordEntry (asserts de tests). */
  writes: BackupEntry[];
}

export function createMemoryBackupStore(seed: {
  clips?: MemoryClipAssetRow[];
  publications?: MemoryPublicationAssetRow[];
  entries?: BackupEntry[];
}): { store: BackupStore; state: MemoryBackupState } {
  const state: MemoryBackupState = {
    clips: (seed.clips ?? []).map((r) => ({ ...r })),
    publications: (seed.publications ?? []).map((r) => ({ ...r })),
    entries: new Map(
      (seed.entries ?? []).map((e) => [
        `${e.tenantId}${e.sourcePath}`,
        { ...e },
      ]),
    ),
    writes: [],
  };

  const store: BackupStore = {
    async listAssetSources(opts) {
      const rows: AssetSourceRow[] = [];
      for (const c of state.clips) {
        if (opts.tenantId && c.tenantId !== opts.tenantId) continue;
        if (c.sourceVideoPath) {
          rows.push({
            tenantId: c.tenantId,
            sourcePath: c.sourceVideoPath,
            sourceRef: `clip:${c.id}:metadata.sourceVideoPath`,
          });
        }
        if (c.videoPath) {
          rows.push({
            tenantId: c.tenantId,
            sourcePath: c.videoPath,
            sourceRef: `clip:${c.id}:video_path`,
          });
        }
        if (c.subtitlesPath) {
          rows.push({
            tenantId: c.tenantId,
            sourcePath: c.subtitlesPath,
            sourceRef: `clip:${c.id}:subtitles_path`,
          });
        }
      }
      for (const p of state.publications) {
        if (opts.tenantId && p.tenantId !== opts.tenantId) continue;
        if (p.imagePath) {
          rows.push({
            tenantId: p.tenantId,
            sourcePath: p.imagePath,
            sourceRef: `publication:${p.id}:image_path`,
          });
        }
        (p.flyerPaths ?? []).forEach((fp, i) => {
          rows.push({
            tenantId: p.tenantId,
            sourcePath: fp,
            sourceRef: `publication:${p.id}:quote_flyer_paths[${i}]`,
          });
        });
      }
      // Dedup por (tenant, source_path) — misma UNIQUE del manifest.
      const seen = new Set<string>();
      return rows
        .filter((r) => {
          const k = `${r.tenantId}${r.sourcePath}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, opts.limit);
    },

    async getEntry(tenantId, sourcePath) {
      const e = state.entries.get(`${tenantId}${sourcePath}`);
      return e ? { ...e } : null;
    },

    async recordEntry(entry) {
      // Upsert por (tenant_id, source_path) — la UNIQUE replicada: la misma
      // fuente siempre pisa la MISMA fila.
      state.entries.set(`${entry.tenantId}${entry.sourcePath}`, { ...entry });
      state.writes.push({ ...entry });
    },

    async summarize(opts) {
      const byTenant = new Map<string, BackupTenantCoverage>();
      for (const e of state.entries.values()) {
        if (opts?.tenantId && e.tenantId !== opts.tenantId) continue;
        const cov =
          byTenant.get(e.tenantId) ??
          {
            tenantId: e.tenantId,
            entries: 0,
            bytes: 0,
            missing: 0,
            errors: 0,
            lastBackedUpAt: null,
          };
        if (e.status === 'backed_up') {
          cov.entries += 1;
          cov.bytes += e.bytes;
        } else if (e.status === 'missing') {
          cov.missing += 1;
        } else if (e.status === 'error') {
          cov.errors += 1;
        }
        if (
          cov.lastBackedUpAt === null ||
          e.backedUpAt > cov.lastBackedUpAt
        ) {
          cov.lastBackedUpAt = e.backedUpAt;
        }
        byTenant.set(e.tenantId, cov);
      }
      return [...byTenant.values()].sort((a, b) =>
        a.tenantId.localeCompare(b.tenantId),
      );
    },
  };

  return { store, state };
}
