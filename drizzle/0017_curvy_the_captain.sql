-- 0017_curvy_the_captain — PG-04: integración Zernio (conexión de cuentas)
--
-- Alcance:
--   * zernio_profiles → un perfil Zernio por tenant (UNIQUE tenant_id):
--     guarda sólo el profile_id opaco que Zernio creó con
--     externalId = tenant_id. Es la vía de aislamiento de las llamadas.
--   * social_connections → cuentas sociales conectadas: ids opacos de
--     Zernio (account_id = _id de la cuenta en Zernio, no el de la red),
--     plataforma, usuario, estado y perfil Zernio dueño. NUNCA guarda
--     tokens ni credenciales — el OAuth lo hospeda Zernio.
--   * La UNIQUE (tenant_id, platform, account_id) es el contrato de
--     dedupe del callback OAuth y del sync: re-conectar la misma cuenta
--     actualiza la fila (ON CONFLICT DO UPDATE) en vez de duplicarla.
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de
-- duplicate_object), para poder correr sobre bases nuevas y sobre bases ya
-- desplegadas sin romper — el verificador PGlite la reaplica como gate.

CREATE TABLE IF NOT EXISTS "social_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"platform" varchar(32) NOT NULL,
	"account_id" varchar(64) NOT NULL,
	"username" varchar(255),
	"display_name" varchar(255),
	"status" varchar(20) DEFAULT 'connected' NOT NULL,
	"zernio_profile_id" varchar(64) NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_connections_tenant_platform_account_unique" UNIQUE("tenant_id","platform","account_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zernio_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profile_id" varchar(64) NOT NULL,
	"name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zernio_profiles_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "zernio_profiles" ADD CONSTRAINT "zernio_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_connections_tenant_id_idx" ON "social_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_connections_tenant_id_status_idx" ON "social_connections" USING btree ("tenant_id","status");
