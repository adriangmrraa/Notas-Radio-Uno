CREATE TABLE "clip_render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clip_id" uuid,
	"kind" varchar(32) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clip_render_jobs" ADD CONSTRAINT "clip_render_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clip_render_jobs" ADD CONSTRAINT "clip_render_jobs_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clip_render_jobs_tenant_id_idx" ON "clip_render_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "clip_render_jobs_clip_id_idx" ON "clip_render_jobs" USING btree ("clip_id");--> statement-breakpoint
CREATE INDEX "clip_render_jobs_status_run_at_idx" ON "clip_render_jobs" USING btree ("status","run_at");