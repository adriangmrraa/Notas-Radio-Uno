-- 0005_epic_b_billing — Épica B (PB-01): modelo de suscripción por transmisiones
--
-- Alcance:
--   * usage_cycles      → medición de transmisiones por período de facturación
--   * quota_operations  → consumo/liberación de cuota, idempotente por operation_id
--   * plan_addons       → catálogo de add-ons (+5 / +15 transmisiones)
--   * addon_purchases   → compras de add-ons (expiran con el ciclo)
--   * billing_events    → append-only + dedupe de webhooks (provider, external_event_id)
--   * plans             → límites del modelo por transmisiones
--   * subscriptions     → dunning, gracia y transmisiones de trial
--
-- Toda la migración es IDEMPOTENTE (IF NOT EXISTS / guardas de duplicate_object),
-- para poder correr sobre bases nuevas y sobre bases ya desplegadas sin romper.

DO $$
BEGIN
  CREATE TYPE "public"."AddonPurchaseStatus" AS ENUM('pending', 'paid', 'failed', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "public"."QuotaOperationStatus" AS ENUM('reserved', 'consumed', 'released');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  CREATE TYPE "public"."UsageCycleStatus" AS ENUM('open', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "addon_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"usage_cycle_id" uuid,
	"addon_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"transmissions_granted" integer NOT NULL,
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"provider" varchar(20),
	"external_id" varchar(255),
	"status" "AddonPurchaseStatus" DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addon_purchases_provider_external_id_unique" UNIQUE("provider","external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"type" varchar(60) NOT NULL,
	"provider" varchar(20),
	"external_event_id" varchar(255),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_provider_external_event_id_unique" UNIQUE("provider","external_event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plan_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(40) DEFAULT 'transmissions' NOT NULL,
	"name" varchar(40) NOT NULL,
	"transmissions" integer NOT NULL,
	"price_usd" numeric(10, 2) NOT NULL,
	"price_ars" numeric(10, 2),
	"stripe_price_id" varchar(255),
	"mp_preference_plan_id" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_addons_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quota_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"usage_cycle_id" uuid,
	"operation_id" varchar(120) NOT NULL,
	"kind" varchar(40) DEFAULT 'transmission_start' NOT NULL,
	"status" "QuotaOperationStatus" DEFAULT 'consumed' NOT NULL,
	"transmission_ref" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" varchar(40),
	CONSTRAINT "quota_operations_tenant_id_operation_id_unique" UNIQUE("tenant_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"included_transmissions" integer DEFAULT 0 NOT NULL,
	"addon_transmissions" integer DEFAULT 0 NOT NULL,
	"transmissions_used" integer DEFAULT 0 NOT NULL,
	"status" "UsageCycleStatus" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_cycles_tenant_id_period_start_unique" UNIQUE("tenant_id","period_start")
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "transmissions_per_cycle" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "max_transmission_minutes" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "max_clips_per_transmission" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "max_people" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "raw_retention_days" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grace_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "dunning_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "last_dunning_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "trial_transmissions_included" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_usage_cycle_id_usage_cycles_id_fk" FOREIGN KEY ("usage_cycle_id") REFERENCES "public"."usage_cycles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "addon_purchases" ADD CONSTRAINT "addon_purchases_addon_id_plan_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."plan_addons"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "quota_operations" ADD CONSTRAINT "quota_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "quota_operations" ADD CONSTRAINT "quota_operations_usage_cycle_id_usage_cycles_id_fk" FOREIGN KEY ("usage_cycle_id") REFERENCES "public"."usage_cycles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "usage_cycles" ADD CONSTRAINT "usage_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "addon_purchases_tenant_id_idx" ON "addon_purchases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_events_tenant_id_idx" ON "billing_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quota_operations_tenant_id_status_idx" ON "quota_operations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_cycles_tenant_id_status_idx" ON "usage_cycles" USING btree ("tenant_id","status");
