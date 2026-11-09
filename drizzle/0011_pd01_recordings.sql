-- 0011_pd01_recordings — PD-01/D-1: schema del crudo de video
--
-- Alcance:
--   * stream_recordings   → una grabación por transmisión (índice único sobre
--     transmission_id); storage_prefix = raíz dentro del RawStorage,
--     started_at = ancla wall-clock de los offsets start_ms/end_ms de los
--     segmentos
--   * recording_segments  → segmentos físicos de una grabación; UNIQUE
--     (recording_id, sequence); end_ms NULL mientras el segmento escribe;
--     file_ref = clave relativa dentro del storage
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

CREATE TABLE IF NOT EXISTS "recording_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint,
	"file_ref" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_segments_recording_id_sequence_unique" UNIQUE("recording_id","sequence")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stream_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transmission_id" uuid NOT NULL,
	"storage_prefix" text NOT NULL,
	"status" varchar(20) DEFAULT 'recording' NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_recording_id_stream_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."stream_recordings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "stream_recordings" ADD CONSTRAINT "stream_recordings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "stream_recordings" ADD CONSTRAINT "stream_recordings_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recording_segments_tenant_id_idx" ON "recording_segments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recording_segments_recording_id_idx" ON "recording_segments" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recording_segments_recording_id_start_ms_idx" ON "recording_segments" USING btree ("recording_id","start_ms");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stream_recordings_tenant_id_idx" ON "stream_recordings" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stream_recordings_transmission_id_idx" ON "stream_recordings" USING btree ("transmission_id");
