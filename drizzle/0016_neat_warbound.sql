-- 0016_neat_warbound — PG-03: configuración de auto-publicación por tenant/programa
--
-- Alcance:
--   * auto_publish_configs → modo (off|on_approval|scheduled), plataformas
--     objetivo por nombre de red (jsonb), días/hora/zona para el modo
--     programado, y flag is_active.
--   * program_id NULL = config global del tenant. Como NULL no deduplica en
--     un UNIQUE de Postgres, la deduplicación va sobre (tenant_id,
--     program_key) — program_key la setea siempre el servicio
--     ('__all__' para la global, program_id::text para las de programa).
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

CREATE TABLE IF NOT EXISTS "auto_publish_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid,
	"program_key" varchar(40) NOT NULL,
	"mode" varchar(24) DEFAULT 'off' NOT NULL,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"publish_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"publish_time" varchar(5),
	"timezone" varchar(64) DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_publish_configs_tenant_program_unique" UNIQUE("tenant_id","program_key")
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "auto_publish_configs" ADD CONSTRAINT "auto_publish_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "auto_publish_configs" ADD CONSTRAINT "auto_publish_configs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_publish_configs_tenant_id_idx" ON "auto_publish_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auto_publish_configs_program_id_idx" ON "auto_publish_configs" USING btree ("program_id");
