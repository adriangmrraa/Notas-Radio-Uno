CREATE TABLE "asset_persons" (
	"asset_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" varchar(10) NOT NULL,
	CONSTRAINT "asset_persons_asset_id_person_id_role_pk" PRIMARY KEY("asset_id","person_id","role")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" varchar(15) NOT NULL,
	"status" varchar(20) DEFAULT 'generating' NOT NULL,
	"source" varchar(10) DEFAULT 'footage' NOT NULL,
	"title" varchar(255),
	"content" text,
	"media_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transmission_id" uuid,
	"program_id" uuid,
	"source_window" jsonb,
	"quotes" jsonb,
	"content_variants" jsonb,
	"edit_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"profile_version" integer,
	"delivery_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"legacy_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(50) NOT NULL,
	"provider" varchar(30),
	"display_name" varchar(100),
	"capabilities" jsonb,
	"cost_per_image" numeric(10, 5),
	"is_enabled" boolean DEFAULT true NOT NULL,
	"plan_gating" jsonb,
	"sort_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_models_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"social_connection_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(10) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"external_post_id" varchar(255),
	"last_error" text,
	"dedup_key" varchar(160),
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_jobs_dedup_key_unique" UNIQUE("dedup_key")
);
--> statement-breakpoint
CREATE TABLE "social_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" varchar(15) NOT NULL,
	"platform" varchar(30) NOT NULL,
	"external_account_id" varchar(255),
	"portfolio_id" uuid,
	"display_name" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_connections_tenant_provider_platform_account_unique" UNIQUE("tenant_id","provider","platform","external_account_id")
);
--> statement-breakpoint
ALTER TABLE "guest_dossiers" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_persons" ADD CONSTRAINT "asset_persons_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_persons" ADD CONSTRAINT "asset_persons_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_social_connection_id_social_connections_id_fk" FOREIGN KEY ("social_connection_id") REFERENCES "public"."social_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_portfolio_id_social_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."social_portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_persons_person_id_idx" ON "asset_persons" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "assets_tenant_id_status_idx" ON "assets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "assets_tenant_id_type_idx" ON "assets" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "assets_transmission_id_idx" ON "assets" USING btree ("transmission_id");--> statement-breakpoint
CREATE INDEX "publish_jobs_status_idx" ON "publish_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "publish_jobs_asset_id_idx" ON "publish_jobs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "social_connections_tenant_id_idx" ON "social_connections" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "guest_dossiers" ADD CONSTRAINT "guest_dossiers_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;