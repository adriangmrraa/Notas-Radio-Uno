CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"source_table" varchar(24) NOT NULL,
	"ref_id" uuid NOT NULL,
	"parent_asset_id" uuid,
	"title" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transmission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_tenant_source_ref_unique" UNIQUE("tenant_id","source_table","ref_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_parent_asset_id_assets_id_fk" FOREIGN KEY ("parent_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_tenant_id_idx" ON "assets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "assets_tenant_id_kind_idx" ON "assets" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "assets_tenant_id_status_idx" ON "assets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "assets_transmission_id_idx" ON "assets" USING btree ("transmission_id");