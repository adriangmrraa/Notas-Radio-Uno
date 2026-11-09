ALTER TYPE "public"."JobExecutionStatus" ADD VALUE 'skipped_quota';--> statement-breakpoint
CREATE TABLE "face_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"photo_id" uuid,
	"embedding" jsonb NOT NULL,
	"model" varchar(50) DEFAULT 'buffalo_l' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"photo_data" "bytea" NOT NULL,
	"mime_type" varchar(20) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"enrollment_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_program" (
	"person_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	CONSTRAINT "person_program_person_id_program_id_pk" PRIMARY KEY("person_id","program_id")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(50),
	"bio" text,
	"socials" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"enrollment_status" varchar(20) DEFAULT 'none' NOT NULL,
	"consent_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_appearances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transmission_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid,
	"speaker_label" varchar(10),
	"source" varchar(10) NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"confidence" numeric(4, 3),
	"bbox" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_transmission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"transmission_id" uuid,
	"program_id" uuid,
	"scheduled_date" date,
	"role" varchar(20) DEFAULT 'guest' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recording_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint,
	"file_ref" text NOT NULL,
	"bytes" bigint,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_segments_recording_id_sequence_unique" UNIQUE("recording_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "stream_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transmission_id" uuid NOT NULL,
	"storage_prefix" text NOT NULL,
	"status" varchar(20) DEFAULT 'recording' NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "stream_recordings_transmission_id_unique" UNIQUE("transmission_id")
);
--> statement-breakpoint
CREATE TABLE "transmission_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transmission_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"title" text,
	"summary" text,
	"start_ms" bigint,
	"end_ms" bigint,
	"speakers" jsonb,
	"score" numeric(10, 3),
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid,
	"scheduled_job_id" uuid,
	"source" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'scheduled' NOT NULL,
	"stream_url" text,
	"resolved_stream_url" text,
	"crudo_ref" text,
	"duration_minutes" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"waiting_since" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"error_message" text,
	"operation_id" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "editorial_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editorial_profile_versions_profile_id_version_unique" UNIQUE("profile_id","version")
);
--> statement-breakpoint
CREATE TABLE "editorial_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tone" varchar(30),
	"tone_examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rubro" varchar(50),
	"audience" text,
	"active_formats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_policy" varchar(10) DEFAULT 'review' NOT NULL,
	"default_image_model" varchar(50),
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "editorial_profiles_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "job_executions" ADD COLUMN "transmission_id" uuid;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "editorial_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "face_embeddings" ADD CONSTRAINT "face_embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_embeddings" ADD CONSTRAINT "face_embeddings_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_embeddings" ADD CONSTRAINT "face_embeddings_photo_id_person_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."person_photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_photos" ADD CONSTRAINT "person_photos_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_program" ADD CONSTRAINT "person_program_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_program" ADD CONSTRAINT "person_program_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_appearances" ADD CONSTRAINT "person_appearances_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_appearances" ADD CONSTRAINT "person_appearances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_appearances" ADD CONSTRAINT "person_appearances_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_transmission" ADD CONSTRAINT "person_transmission_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_transmission" ADD CONSTRAINT "person_transmission_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_transmission" ADD CONSTRAINT "person_transmission_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_transmission" ADD CONSTRAINT "person_transmission_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_recording_id_stream_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."stream_recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_recordings" ADD CONSTRAINT "stream_recordings_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transmission_segments" ADD CONSTRAINT "transmission_segments_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transmission_segments" ADD CONSTRAINT "transmission_segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transmissions" ADD CONSTRAINT "transmissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transmissions" ADD CONSTRAINT "transmissions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transmissions" ADD CONSTRAINT "transmissions_scheduled_job_id_scheduled_jobs_id_fk" FOREIGN KEY ("scheduled_job_id") REFERENCES "public"."scheduled_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_profile_versions" ADD CONSTRAINT "editorial_profile_versions_profile_id_editorial_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."editorial_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_profile_versions" ADD CONSTRAINT "editorial_profile_versions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "face_embeddings_tenant_id_idx" ON "face_embeddings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "face_embeddings_person_id_idx" ON "face_embeddings" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_photos_person_id_idx" ON "person_photos" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_program_program_id_idx" ON "person_program" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "persons_tenant_id_idx" ON "persons" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "person_appearances_transmission_id_idx" ON "person_appearances" USING btree ("transmission_id");--> statement-breakpoint
CREATE INDEX "person_appearances_tenant_id_person_id_idx" ON "person_appearances" USING btree ("tenant_id","person_id");--> statement-breakpoint
CREATE INDEX "person_transmission_tenant_id_scheduled_date_idx" ON "person_transmission" USING btree ("tenant_id","scheduled_date");--> statement-breakpoint
CREATE INDEX "person_transmission_tenant_id_transmission_id_idx" ON "person_transmission" USING btree ("tenant_id","transmission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_transmission_person_id_transmission_id_unique" ON "person_transmission" USING btree ("person_id","transmission_id") WHERE "person_transmission"."transmission_id" is not null;--> statement-breakpoint
CREATE INDEX "recording_segments_recording_id_start_ms_idx" ON "recording_segments" USING btree ("recording_id","start_ms");--> statement-breakpoint
CREATE INDEX "transmission_segments_transmission_id_start_ms_idx" ON "transmission_segments" USING btree ("transmission_id","start_ms");--> statement-breakpoint
CREATE INDEX "transmission_segments_tenant_id_created_at_idx" ON "transmission_segments" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "transmissions_tenant_status_idx" ON "transmissions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "transmissions_tenant_id_created_at_idx" ON "transmissions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "editorial_profiles_tenant_id_idx" ON "editorial_profiles" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE set null ON UPDATE no action;