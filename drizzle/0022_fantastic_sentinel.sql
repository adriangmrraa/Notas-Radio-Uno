-- 0022_fantastic_sentinel — PI-05: manifest del backup de assets derivados
--
-- Alcance:
--   * asset_backup_entries → una fila por ARCHIVO derivado respaldado por
--     `assetBackupService.syncAssetBackups` (espejo incremental hacia el
--     BackupStorage: BACKUP_ROOT o <repo>/data/backup).
--   * UNIQUE (tenant_id, source_path) = contrato de idempotencia del sync:
--     la misma fuente siempre resuelve a la MISMA fila, re-correr jamás
--     duplica (mismo patrón que assets_tenant_source_ref_unique, PF-10).
--   * `bytes` + `source_mtime_ms` = test barato de cambio (estilo rsync);
--     `checksum` sha256 = integridad del respaldo. `status` ∈ backed_up |
--     missing | error con la razón en `last_error`.
--   * Aislamiento por tenant_id (regla dura del repo). ON DELETE cascade:
--     borrar el tenant borra su manifest (los archivos de backup quedan —
--     son datos fuera de la DB, el manifest sólo los describe).
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

CREATE TABLE IF NOT EXISTS "asset_backup_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_path" text NOT NULL,
	"source_ref" varchar(96) NOT NULL,
	"backup_path" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"source_mtime_ms" bigint DEFAULT 0 NOT NULL,
	"checksum" varchar(64),
	"status" varchar(16) DEFAULT 'backed_up' NOT NULL,
	"last_error" text,
	"backed_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_backup_entries_tenant_source_unique" UNIQUE("tenant_id","source_path")
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "asset_backup_entries" ADD CONSTRAINT "asset_backup_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_backup_entries_tenant_id_idx" ON "asset_backup_entries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_backup_entries_tenant_id_status_idx" ON "asset_backup_entries" USING btree ("tenant_id","status");