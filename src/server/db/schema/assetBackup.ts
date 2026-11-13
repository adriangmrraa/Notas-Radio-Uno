import {
  pgTable,
  uuid,
  varchar,
  text,
  bigint,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * asset_backup_entries — manifest del backup incremental de assets derivados
 * (PI-05, Épica I).
 *
 * Una fila por ARCHIVO derivado respaldado (no por asset lógico): el espejo
 * incremental que corre `assetBackupService.syncAssetBackups` copia los
 * archivos que el producto genera (renders de clips bajo `output/`, flyers
 * de `publications.quote_flyer_paths`, imágenes) hacia el `BackupStorage`
 * (`BACKUP_ROOT` o `<repo>/data/backup`) y deja acá el recibo.
 *
 * La UNIQUE `(tenant_id, source_path)` es el contrato de idempotencia —
 * mismo criterio que `assets_(tenant,source_table,ref_id)` (PF-10): el mismo
 * archivo origen siempre resuelve a la MISMA fila del manifest, re-correr el
 * sync jamás duplica. `source_path` se guarda tal como figura en la fila
 * origen (ruta local absoluta o relativa a `output/`); `backup_path` es la
 * key destino dentro del BackupStorage (`{tenant_id}/{key_relativa}` — el
 * árbol de backup queda tenant-scoped igual que TODA escritura del repo).
 *
 * `source_ref` guarda la procedencia legible (`clip:{id}:video_path`,
 * `publication:{id}:image_path`, `publication:{id}:quote_flyer_paths[N]`) —
 * trazabilidad para el panel admin y para un futuro restore.
 *
 * Idempotencia por `bytes` + `source_mtime_ms` (decisión PI-05 — documentada
 * en el header del servicio): una corrida saltea el archivo si la entrada
 * `backed_up` tiene el mismo size+mtime que la fuente; el `checksum` sha256
 * se guarda por integridad (detección de corrupción del backup), NO como
 * test de cambio — recalcularlo exigiría leer cada archivo en cada corrida.
 *
 * `status` ∈ 'backed_up' | 'missing' | 'error': `missing` = la fila origen
 * referencia un archivo que ya no existe en disco (queda registrado — la
 * cobertura del endpoint status lo cuenta aparte); `error` = la copia falló
 * (razón en `last_error`, se reintenta en la próxima corrida). En
 * `missing`/`error` se conservan `bytes`/`checksum`/`source_mtime_ms` de la
 * última copia exitosa — describen el último respaldo bueno, no la fuente
 * actual.
 */
export const assetBackupEntries = pgTable(
  'asset_backup_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sourcePath: text('source_path').notNull(),
    sourceRef: varchar('source_ref', { length: 96 }).notNull(),
    backupPath: text('backup_path').notNull(),
    // bytes/mtime de la ÚLTIMA copia exitosa (bigint: archivos > 2 GB).
    bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
    sourceMtimeMs: bigint('source_mtime_ms', { mode: 'number' })
      .notNull()
      .default(0),
    checksum: varchar('checksum', { length: 64 }),
    status: varchar('status', { length: 16 }).notNull().default('backed_up'),
    lastError: text('last_error'),
    /** Última vez que el sync procesó esta entrada (éxito o hallazgo). */
    backedUpAt: timestamp('backed_up_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('asset_backup_entries_tenant_id_idx').on(t.tenantId),
    index('asset_backup_entries_tenant_id_status_idx').on(
      t.tenantId,
      t.status,
    ),
    // Contrato de idempotencia del sync — mismo patrón que assets (PF-10).
    unique('asset_backup_entries_tenant_source_unique').on(
      t.tenantId,
      t.sourcePath,
    ),
  ],
);
