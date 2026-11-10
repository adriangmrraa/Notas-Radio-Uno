CREATE TABLE "transmission_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transmission_id" uuid NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"topic" varchar(200),
	"summary" text,
	"speakers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transmission_segments" ADD CONSTRAINT "transmission_segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transmission_segments" ADD CONSTRAINT "transmission_segments_transmission_id_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."transmissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transmission_segments_tenant_id_idx" ON "transmission_segments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "transmission_segments_transmission_id_start_ms_idx" ON "transmission_segments" USING btree ("transmission_id","start_ms");