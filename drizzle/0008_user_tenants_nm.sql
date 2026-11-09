-- 0008 â€” MembresÃ­as N:M usuarioâ†”tenant (decisiÃ³n B-2 / T-37)
--
-- `user_tenants` es la fuente de verdad del acceso: un usuario puede pertenecer
-- a varios tenants con un rol por tenant. `users.tenant_id` pasa a legacy
-- (primer tenant) y deja de ser NOT NULL; `users.role`/`users.status` quedan
-- como datos histÃ³ricos de la cuenta.
--
-- Idempotente a propÃ³sito: correrla dos veces (o sobre una base ya migrada por
-- db:push) no rompe.

CREATE TABLE IF NOT EXISTS "user_tenants" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" "UserRole" DEFAULT 'viewer' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tenants_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_tenant_id_tenants_id_fk";
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_tenants_tenant_id_idx" ON "user_tenants" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_tenants_user_id_idx" ON "user_tenants" USING btree ("user_id");
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
-- Backfill (0008 del design): cada usuario existente queda con la membresÃ­a de
-- su tenant actual y conserva su rol. Una cuenta suspendida arrastra membresÃ­a
-- suspendida en su tenant histÃ³rico.
INSERT INTO "user_tenants" ("user_id", "tenant_id", "role", "status", "created_at", "updated_at")
SELECT
	u."id",
	u."tenant_id",
	u."role",
	CASE WHEN u."status" = 'suspended' THEN 'suspended' ELSE 'active' END,
	u."created_at",
	now()
FROM "users" u
WHERE u."tenant_id" IS NOT NULL
ON CONFLICT ("user_id", "tenant_id") DO NOTHING;
--> statement-breakpoint
-- El owner del tenant (tenants.owner_id) es owner en su membresÃ­a, aunque su
-- rol histÃ³rico diga otra cosa.
UPDATE "user_tenants" ut
SET "role" = 'owner', "updated_at" = now()
FROM "tenants" t
WHERE t."id" = ut."tenant_id"
	AND t."owner_id" = ut."user_id"
	AND ut."role" <> 'owner';
