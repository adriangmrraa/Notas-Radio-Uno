-- 0012_busy_hex — PD-05: schema de la Sala "En vivo"
--
-- Alcance:
--   * transcript_segments   → utterances de la transcripción en vivo; offsets
--     start_ms/end_ms relativos a transmissions.started_at (misma convención
--     que recording_segments); person_id NULL hasta que la atribución resuelva
--     al speaker contra persons (degradado a speaker_label genérico).
--   * transmission_moments  → momentos relevantes; kind='detected' los inserta
--     el motor de análisis (Épica E), kind='mark' son marks manuales del
--     editor (clip_id NULL ⇒ nota, clip_id SET ⇒ mark que disparó un clip).
--   * clips.transmission_id → corrida que originó el clip (FK SET NULL:
--     borrar la transmisión no borra el clip ya producido).
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

CREATE TABLE IF NOT EXISTS "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transmission_id" uuid NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"speaker_label" varchar(80),
	"person_id" uuid,
	"text" text NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transmission_moments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transmission_id" uuid NOT NULL,
	"kind" varchar(20) DEFAULT 'detected' NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"title" text,
	"reason" text,
	"score" real,
	"clip_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN IF NOT EXISTS "transmission_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transmission_moments" ADD CONSTRAINT "transmission_moments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transmission_moments" ADD CONSTRAINT "transmission_moments_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "transmission_moments" ADD CONSTRAINT "transmission_moments_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcript_segments_tenant_id_idx" ON "transcript_segments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcript_segments_transmission_id_start_ms_idx" ON "transcript_segments" USING btree ("transmission_id","start_ms");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcript_segments_person_id_idx" ON "transcript_segments" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transmission_moments_tenant_id_idx" ON "transmission_moments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transmission_moments_transmission_id_start_ms_idx" ON "transmission_moments" USING btree ("transmission_id","start_ms");--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "clips" ADD CONSTRAINT "clips_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clips_transmission_id_idx" ON "clips" USING btree ("transmission_id");
