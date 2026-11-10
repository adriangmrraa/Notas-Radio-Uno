-- 0018_worried_wallow — PG-05: cola persistente de publicación vía Zernio
--
-- Alcance:
--   * publish_jobs → un job por (contenido × red × cuenta) encolado al
--     aprobar. El worker claimea `queued` y publica contra POST /v1/posts
--     usando `idempotency_key` como header Idempotency-Key — reintentar
--     nunca duplica el post en Zernio.
--   * NUNCA guarda credenciales: platform + account_id son ids opacos de
--     Zernio (mismo criterio que social_connections). connection_id queda
--     como traza del origen (SET NULL si la cuenta se desconecta).
--   * scheduled_for es la intención editorial del usuario; next_attempt_at
--     es el gate real del claim del worker (backoff/schedule) — no se
--     mezclan a propósito.
--   * UNIQUE idempotency_key = contrato de dedupe del enqueue:
--     re-encolar el mismo (tenant, origen, plataforma, cuenta) devuelve el
--     job existente en vez de duplicarlo.
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

CREATE TABLE IF NOT EXISTS "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid,
	"publication_id" uuid,
	"connection_id" uuid,
	"platform" varchar(32) NOT NULL,
	"account_id" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"zernio_post_id" varchar(64),
	"idempotency_key" varchar(255) NOT NULL,
	"content" text NOT NULL,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"last_error_category" varchar(32),
	"last_error_source" varchar(16),
	"scheduled_for" timestamp with time zone,
	"published_at" timestamp with time zone,
	"platform_post_url" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_connection_id_social_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."social_connections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_tenant_id_idx" ON "publish_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_tenant_id_status_idx" ON "publish_jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_tenant_id_created_at_idx" ON "publish_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publish_jobs_status_next_attempt_idx" ON "publish_jobs" USING btree ("status","next_attempt_at");
