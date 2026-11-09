-- 0008_pc07_transmissions — PC-07: schema de transmisiones
--
-- Alcance:
--   * transmissions            → una corrida/estado de una transmisión
--     (scheduled → waiting → live → processing → done | error | canceled;
--     estados que consume la ingesta de Épica D)
--   * scheduled_transmissions  → la agenda del canal (qué se transmite, de qué
--     programa, con qué recurrencia RRULE RFC 5545 y en qué timezone IANA)
--
-- `scheduled_transmissions` es una tabla NUEVA y distinta de `scheduled_jobs`
-- (motor de jobs preexistente): no la reemplaza ni la modifica.
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

DO $$
BEGIN
  CREATE TYPE "public"."TransmissionSource" AS ENUM('live_capture', 'vod_upload', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "public"."TransmissionStatus" AS ENUM('scheduled', 'waiting', 'live', 'processing', 'done', 'error', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_transmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"stream_url" text NOT NULL,
	"rrule" varchar(255) NOT NULL,
	"timezone" varchar(64) DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"auto_start" boolean DEFAULT true NOT NULL,
	"pipeline_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_transmission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid,
	"scheduled_transmission_id" uuid,
	"source" "TransmissionSource" NOT NULL,
	"status" "TransmissionStatus" DEFAULT 'scheduled' NOT NULL,
	"stream_url" text,
	"resolved_stream_url" text,
	"crudo_ref" text,
	"duration_minutes" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"waiting_since" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"error_message" text,
	"pipeline_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "scheduled_transmissions" ADD CONSTRAINT "scheduled_transmissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "scheduled_transmissions" ADD CONSTRAINT "scheduled_transmissions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "scheduled_transmissions" ADD CONSTRAINT "scheduled_transmissions_last_transmission_id_transmissions_id_fk" FOREIGN KEY ("last_transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transmissions" ADD CONSTRAINT "transmissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transmissions" ADD CONSTRAINT "transmissions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transmissions" ADD CONSTRAINT "transmissions_scheduled_transmission_id_scheduled_transmissions_id_fk" FOREIGN KEY ("scheduled_transmission_id") REFERENCES "public"."scheduled_transmissions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_transmissions_tenant_is_active_idx" ON "scheduled_transmissions" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_transmissions_tenant_next_run_at_idx" ON "scheduled_transmissions" USING btree ("tenant_id","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_transmissions_program_id_idx" ON "scheduled_transmissions" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_transmissions_last_transmission_id_idx" ON "scheduled_transmissions" USING btree ("last_transmission_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transmissions_tenant_status_idx" ON "transmissions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transmissions_tenant_id_created_at_idx" ON "transmissions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transmissions_program_id_idx" ON "transmissions" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transmissions_scheduled_transmission_id_idx" ON "transmissions" USING btree ("scheduled_transmission_id");
