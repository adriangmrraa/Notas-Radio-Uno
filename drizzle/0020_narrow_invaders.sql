-- 0020_narrow_invaders — PI-01: cola de trabajo genérica `job_queue`
--
-- Alcance:
--   * job_queue → cola transversal de la plataforma (MVP Postgres, decisión
--     D-6): un job por fila con `kind` discriminador ('retention.purge' es
--     el seed; varchar para agregar kinds sin migración), reintentos con
--     backoff exponencial y dead-letter en la misma tabla (status='dead' +
--     dead_lettered_at).
--   * Ciclo de vida: pending → running → succeeded | pending (retry) |
--     dead | failed | cancelled.
--   * `run_at` es el gate del claim: status='pending' AND run_at <= now —
--     el índice compuesto (status, run_at) lo cubre.
--   * Aislamiento por tenant_id en TODA query, incluido el claim (no hay
--     RLS en el repo). ON DELETE cascade: borrar el tenant borra su cola.
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

CREATE TABLE IF NOT EXISTS "job_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"last_error" text,
	"error_category" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_queue_tenant_id_idx" ON "job_queue" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_queue_tenant_id_status_idx" ON "job_queue" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_queue_status_run_at_idx" ON "job_queue" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_queue_tenant_id_created_at_idx" ON "job_queue" USING btree ("tenant_id","created_at");
