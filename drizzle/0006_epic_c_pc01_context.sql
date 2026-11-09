-- 0006_epic_c_pc01_context — Épica C (PC-01): foundation de contexto del canal
--
-- Alcance:
--   * persons                  → biblioteca única de personas del canal
--     (unifica conductores/invitados; conductors.person_id y guests.person_id
--     quedan como puente no-breaking hacia el modelo nuevo)
--   * person_photos            → fotos de referencia multi-foto por persona
--   * face_embeddings          → embeddings de rostro vector(512) (pgvector)
--   * person_program           → N:M persona↔programa con rol en el programa
--   * editorial_profiles       → línea editorial del canal (default por tenant
--     + override por programa)
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de duplicate_object),
-- para poder correr sobre bases nuevas y sobre bases ya desplegadas sin romper.
-- Requiere pgvector para face_embeddings.embedding (Neon/Render lo proveen).

CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "public"."FaceEnrollmentStatus" AS ENUM('pending', 'enrolled', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "public"."PersonRole" AS ENUM('conductor', 'columnista', 'productor', 'invitado', 'colaborador', 'otro');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "face_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"person_photo_id" uuid NOT NULL,
	"model" varchar(80) DEFAULT 'insightface-buffalo_l' NOT NULL,
	"dimensions" integer DEFAULT 512 NOT NULL,
	"embedding" vector(512) NOT NULL,
	"det_score" real,
	"quality" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"photo_data" "bytea" NOT NULL,
	"mime_type" varchar(40) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"face_detected" boolean DEFAULT false NOT NULL,
	"face_count" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "person_program" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"role_on_program" varchar(80),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"role_label" varchar(120),
	"role" "PersonRole" DEFAULT 'conductor' NOT NULL,
	"bio" text,
	"notes" text,
	"social_links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding_ref" uuid,
	"face_status" "FaceEnrollmentStatus" DEFAULT 'pending' NOT NULL,
	"consent_given" boolean DEFAULT false NOT NULL,
	"consent_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "editorial_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid,
	"name" varchar(120),
	"tone" varchar(40) DEFAULT 'formal' NOT NULL,
	"tone_description" text,
	"style_guide" text,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"industry" varchar(80),
	"active_formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signature" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conductors" ADD COLUMN IF NOT EXISTS "person_id" uuid;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN IF NOT EXISTS "person_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "face_embeddings" ADD CONSTRAINT "face_embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "face_embeddings" ADD CONSTRAINT "face_embeddings_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "face_embeddings" ADD CONSTRAINT "face_embeddings_person_photo_id_person_photos_id_fk" FOREIGN KEY ("person_photo_id") REFERENCES "public"."person_photos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "person_photos" ADD CONSTRAINT "person_photos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "person_photos" ADD CONSTRAINT "person_photos_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "person_program" ADD CONSTRAINT "person_program_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "person_program" ADD CONSTRAINT "person_program_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "person_program" ADD CONSTRAINT "person_program_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "person_program" ADD CONSTRAINT "person_program_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "persons" ADD CONSTRAINT "persons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "persons" ADD CONSTRAINT "persons_embedding_ref_face_embeddings_id_fk" FOREIGN KEY ("embedding_ref") REFERENCES "public"."face_embeddings"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "editorial_profiles" ADD CONSTRAINT "editorial_profiles_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "conductors" ADD CONSTRAINT "conductors_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "guests" ADD CONSTRAINT "guests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_embeddings_tenant_id_idx" ON "face_embeddings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_embeddings_person_id_idx" ON "face_embeddings" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "face_embeddings_person_photo_id_idx" ON "face_embeddings" USING btree ("person_photo_id");--> statement-breakpoint
-- Búsqueda por similitud coseno sobre el embedding (pgvector, HNSW).
CREATE INDEX IF NOT EXISTS "face_embeddings_embedding_hnsw_idx" ON "face_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_photos_tenant_id_idx" ON "person_photos" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_photos_person_id_idx" ON "person_photos" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "person_program_person_program_unique" ON "person_program" USING btree ("person_id","program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_program_tenant_id_idx" ON "person_program" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_program_program_id_idx" ON "person_program" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "person_program_created_by_user_id_idx" ON "person_program" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persons_tenant_id_idx" ON "persons" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persons_embedding_ref_idx" ON "persons" USING btree ("embedding_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persons_tenant_active_idx" ON "persons" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persons_tenant_role_idx" ON "persons" USING btree ("tenant_id","role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "persons_tenant_name_idx" ON "persons" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "editorial_profiles_tenant_program_unique" ON "editorial_profiles" USING btree ("tenant_id","program_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "editorial_profiles_tenant_default_unique" ON "editorial_profiles" USING btree ("tenant_id") WHERE "editorial_profiles"."program_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "editorial_profiles_tenant_id_idx" ON "editorial_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "editorial_profiles_program_id_idx" ON "editorial_profiles" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conductors_person_id_idx" ON "conductors" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "guests_person_id_idx" ON "guests" USING btree ("person_id");
