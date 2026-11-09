-- 0010_pc09_dossier_transmission — PC-09: dossier vinculado a la emisión de agenda
--
-- Alcance:
--   * guest_dossiers.scheduled_transmission_id  → uuid NULL, FK →
--     scheduled_transmissions(id) ON DELETE SET NULL, con su índice.
--
-- Nullable a propósito: hay dossiers preexistentes y un dossier puede
-- generarse sin emisión (invitado fuera de agenda). El vínculo se hace contra
-- `scheduled_transmissions` y NO contra `transmissions`: la entrada de agenda
-- es estable entre corridas (varias corridas pueden salir de la misma
-- entrada), así que el dossier queda a mano para cualquier disparo de esa
-- emisión sin retoques al endpoint /start.
--
-- `program_id` y `scheduled_date` siguen NOT NULL — el flujo legacy de
-- dossier por programa+fecha no cambia.
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guarda de
-- duplicate_object): el verificador PGlite la reaplica como gate.

ALTER TABLE "guest_dossiers" ADD COLUMN IF NOT EXISTS "scheduled_transmission_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guest_dossiers" ADD CONSTRAINT "guest_dossiers_scheduled_transmission_id_scheduled_transmissions_id_fk" FOREIGN KEY ("scheduled_transmission_id") REFERENCES "public"."scheduled_transmissions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_dossiers_scheduled_transmission_id_idx" ON "guest_dossiers" USING btree ("scheduled_transmission_id");
