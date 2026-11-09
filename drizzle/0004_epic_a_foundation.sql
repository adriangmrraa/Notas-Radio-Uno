-- 0004_epic_a_foundation — Épica A (PA-01): fundación de schema SaaS + super admin
--
-- Alcance:
--   * tenant_features          → feature flags efectivos por tenant (con default por plan)
--   * impersonation_sessions    → sesiones auditadas de "ver como" (PA-10)
--   * users.is_platform_admin   → flag de super admin de plataforma (PA-06)
--   * audit_log                 → actor, entidad, outcome e impersonador (PA-05)
--   * team_invitations          → aceptación, reenvío y revocación (PA-02)
--
-- Además sincroniza el snapshot de Drizzle con objetos que existían sólo por
-- `db:push` (guests, guest_dossiers, clips, columnas de publications/programs).
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de duplicate_object),
-- para poder correr sobre bases nuevas y sobre bases ya desplegadas sin romper.

DO $$
BEGIN
  CREATE TYPE "public"."FeatureSource" AS ENUM('plan', 'override', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "public"."PublicationStatus" AS ENUM('pending_review', 'approved', 'published', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guest_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_id" uuid NOT NULL,
	"photo_data" "bytea" NOT NULL,
	"mime_type" varchar(20) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"role" varchar(100) NOT NULL,
	"bio" text,
	"scheduled_date" date NOT NULL,
	"scheduled_time_start" varchar(5),
	"scheduled_time_end" varchar(5),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "guest_dossiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guest_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"guest_name" varchar(200) NOT NULL,
	"scheduled_date" date NOT NULL,
	"content" jsonb,
	"status" varchar(30) DEFAULT 'generating' NOT NULL,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"publication_id" uuid,
	"program_id" uuid,
	"title" varchar(255) NOT NULL,
	"hook_text" text NOT NULL,
	"audio_path" text,
	"video_path" text,
	"subtitles_path" text,
	"duration" integer DEFAULT 0 NOT NULL,
	"status" varchar(30) DEFAULT 'generating' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "impersonation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"impersonated_user_id" uuid,
	"reason" text,
	"ip_address" varchar(45),
	"user_agent" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feature_key" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"limit_value" integer,
	"source" "FeatureSource" DEFAULT 'plan' NOT NULL,
	"plan_id" uuid,
	"plan_default_enabled" boolean DEFAULT false NOT NULL,
	"overridden_by_user_id" uuid,
	"overridden_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_platform_admin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN IF NOT EXISTS "quotes" jsonb;
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN IF NOT EXISTS "status" varchar(30) DEFAULT 'pending_review' NOT NULL;
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN IF NOT EXISTS "edit_history" jsonb DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN IF NOT EXISTS "quote_flyer_paths" jsonb DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN IF NOT EXISTS "content_variants" jsonb;
--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN IF NOT EXISTS "diarized" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN IF NOT EXISTS "speaker_count" integer;
--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN IF NOT EXISTS "provider" varchar(30);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "actor_role" varchar(20);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "actor_email" varchar(255);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "entity_type" varchar(60);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "entity_id" varchar(100);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "outcome" varchar(20) DEFAULT 'success' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "impersonated_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "accepted_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "last_sent_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "revoked_by_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "slug" varchar(100);
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guest_photos" ADD CONSTRAINT "guest_photos_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guests" ADD CONSTRAINT "guests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guests" ADD CONSTRAINT "guests_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guest_dossiers" ADD CONSTRAINT "guest_dossiers_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guest_dossiers" ADD CONSTRAINT "guest_dossiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guest_dossiers" ADD CONSTRAINT "guest_dossiers_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "clips" ADD CONSTRAINT "clips_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_impersonated_user_id_users_id_fk" FOREIGN KEY ("impersonated_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "tenant_features" ADD CONSTRAINT "tenant_features_overridden_by_user_id_users_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_photos_guest_id_idx" ON "guest_photos" USING btree ("guest_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guests_tenant_id_idx" ON "guests" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guests_program_id_idx" ON "guests" USING btree ("program_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guests_tenant_program_date_idx" ON "guests" USING btree ("tenant_id","program_id","scheduled_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_dossiers_guest_id_idx" ON "guest_dossiers" USING btree ("guest_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_dossiers_tenant_id_idx" ON "guest_dossiers" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guest_dossiers_program_date_idx" ON "guest_dossiers" USING btree ("program_id","scheduled_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clips_tenant_id_idx" ON "clips" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clips_tenant_id_status_idx" ON "clips" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clips_tenant_id_created_at_idx" ON "clips" USING btree ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonation_sessions_tenant_id_idx" ON "impersonation_sessions" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonation_sessions_admin_user_id_idx" ON "impersonation_sessions" USING btree ("admin_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonation_sessions_expires_at_idx" ON "impersonation_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_features_tenant_id_feature_key_unique" ON "tenant_features" USING btree ("tenant_id","feature_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_features_tenant_id_idx" ON "tenant_features" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_features_feature_key_idx" ON "tenant_features" USING btree ("feature_key");
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_impersonated_by_user_id_users_id_fk" FOREIGN KEY ("impersonated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_is_platform_admin_idx" ON "users" USING btree ("is_platform_admin");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publications_tenant_id_status_idx" ON "publications" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_tenant_id_action_created_at_idx" ON "audit_log" USING btree ("tenant_id","action","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invitations_tenant_id_status_idx" ON "team_invitations" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_invitations_tenant_id_email_pending_unique" ON "team_invitations" USING btree ("tenant_id","email") WHERE "team_invitations"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "programs_slug_idx" ON "programs" USING btree ("slug");
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "programs" ADD CONSTRAINT "programs_slug_unique" UNIQUE("slug");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
