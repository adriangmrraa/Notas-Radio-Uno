CREATE TYPE "public"."InvitationStatus" AS ENUM('pending', 'accepted', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."InvoiceStatus" AS ENUM('pending', 'paid', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."JobExecutionStatus" AS ENUM('pending', 'running', 'completed', 'failed', 'canceled', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."PublicationSource" AS ENUM('pipeline', 'manual', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."ScheduleType" AS ENUM('recurring', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."SubscriptionStatus" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired');--> statement-breakpoint
CREATE TYPE "public"."UserRole" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."UserStatus" AS ENUM('pending', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"owner_id" uuid,
	"platform_name" varchar(255),
	"logo_url" text,
	"logo_data" "bytea",
	"logo_mime_type" varchar(20),
	"font_family" varchar(30) DEFAULT 'bebas_kai' NOT NULL,
	"template_id" varchar(30) DEFAULT 'dark_gradient' NOT NULL,
	"timezone" varchar(50) DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"avatar_url" text,
	"tenant_id" uuid NOT NULL,
	"role" "UserRole" DEFAULT 'owner' NOT NULL,
	"status" "UserStatus" DEFAULT 'pending' NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verification_token" uuid,
	"verification_token_expires_at" timestamp with time zone,
	"reset_password_token" uuid,
	"reset_password_expires_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"value" varchar NOT NULL,
	"category" varchar(50) NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text,
	"content" text,
	"image_path" text,
	"image_url" text,
	"source" "PublicationSource" DEFAULT 'manual' NOT NULL,
	"publish_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"text" text NOT NULL,
	"audio_file" text,
	"source" "PublicationSource" DEFAULT 'manual' NOT NULL,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"system_prompt" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"after_step" varchar(50),
	"is_enabled" boolean DEFAULT true NOT NULL,
	"ai_provider" varchar(50) DEFAULT 'auto' NOT NULL,
	"temperature" real DEFAULT 0.7 NOT NULL,
	"max_tokens" integer DEFAULT 2000 NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"template_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) DEFAULT 'default' NOT NULL,
	"node_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscription_id" uuid,
	"plan_name" varchar(100),
	"amount" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"status" "InvoiceStatus" DEFAULT 'pending' NOT NULL,
	"payment_provider" varchar(20),
	"external_invoice_id" varchar(255),
	"external_payment_id" varchar(255),
	"billing_period_start" timestamp with time zone,
	"billing_period_end" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(50) NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"description" text,
	"price_usd" numeric(10, 2) DEFAULT '0' NOT NULL,
	"price_usd_yearly" numeric(10, 2),
	"price_ars" numeric(10, 2),
	"price_ars_yearly" numeric(10, 2),
	"stripe_price_id_monthly" varchar(255),
	"stripe_price_id_yearly" varchar(255),
	"mp_plan_id_monthly" varchar(255),
	"mp_plan_id_yearly" varchar(255),
	"max_pipeline_hours_per_month" integer,
	"max_publications_per_month" integer,
	"max_scheduled_jobs" integer,
	"max_custom_agents" integer,
	"max_team_members" integer DEFAULT 1 NOT NULL,
	"max_connected_platforms" integer,
	"max_storage_gb" integer DEFAULT 5 NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "SubscriptionStatus" DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"billing_period" varchar(20) DEFAULT 'monthly',
	"payment_provider" varchar(20),
	"external_subscription_id" varchar(255),
	"external_customer_id" varchar(255),
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"pipeline_hours_used" numeric(10, 2) DEFAULT '0' NOT NULL,
	"publications_count" integer DEFAULT 0 NOT NULL,
	"transcription_minutes" numeric(10, 2) DEFAULT '0' NOT NULL,
	"ai_tokens_used" bigint DEFAULT 0 NOT NULL,
	"storage_used_mb" numeric(10, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_tenant_id_period_start_unique" UNIQUE("tenant_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "job_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "JobExecutionStatus" DEFAULT 'pending' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"publications_generated" integer DEFAULT 0 NOT NULL,
	"transcription_minutes" numeric(10, 2) DEFAULT '0' NOT NULL,
	"topics_detected" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"error_count" integer DEFAULT 0 NOT NULL,
	"execution_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"stream_url" text NOT NULL,
	"schedule_type" "ScheduleType" NOT NULL,
	"days_of_week" integer[] DEFAULT '{}' NOT NULL,
	"start_time" varchar(5) NOT NULL,
	"duration_minutes" integer NOT NULL,
	"timezone" varchar(50) DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"scheduled_date" date,
	"pipeline_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_status" varchar(20),
	"next_run_at" timestamp with time zone,
	"notify_on_complete" boolean DEFAULT true NOT NULL,
	"notify_on_error" boolean DEFAULT true NOT NULL,
	"notification_email" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"portfolio_id" uuid,
	"asset_type" varchar(50) NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"name" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_assets_tenant_id_external_id_unique" UNIQUE("tenant_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "social_portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_portfolios_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"action" varchar(100) NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"pipeline_runs" integer DEFAULT 0 NOT NULL,
	"pipeline_minutes" numeric(10, 2) DEFAULT '0' NOT NULL,
	"scheduled_runs" integer DEFAULT 0 NOT NULL,
	"scheduled_minutes" numeric(10, 2) DEFAULT '0' NOT NULL,
	"publications_generated" integer DEFAULT 0 NOT NULL,
	"publications_auto" integer DEFAULT 0 NOT NULL,
	"publications_manual" integer DEFAULT 0 NOT NULL,
	"publications_scheduled" integer DEFAULT 0 NOT NULL,
	"transcription_chunks" integer DEFAULT 0 NOT NULL,
	"transcription_minutes" numeric(10, 2) DEFAULT '0' NOT NULL,
	"topics_detected" integer DEFAULT 0 NOT NULL,
	"ai_tokens_used" bigint DEFAULT 0 NOT NULL,
	"agents_executed" integer DEFAULT 0 NOT NULL,
	"twitter_posts" integer DEFAULT 0 NOT NULL,
	"facebook_posts" integer DEFAULT 0 NOT NULL,
	"instagram_posts" integer DEFAULT 0 NOT NULL,
	"webhook_calls" integer DEFAULT 0 NOT NULL,
	"pipeline_errors" integer DEFAULT 0 NOT NULL,
	"publish_errors" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_metrics_tenant_id_metric_date_unique" UNIQUE("tenant_id","metric_date")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text,
	"icon" varchar(10),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"user_agent" text,
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"tenant_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "team_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "UserRole" DEFAULT 'editor' NOT NULL,
	"token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" "InvitationStatus" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_urls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"type" varchar(30) NOT NULL,
	"url" text NOT NULL,
	"label" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"schedule" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conductor_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conductor_id" uuid NOT NULL,
	"photo_data" "bytea" NOT NULL,
	"mime_type" varchar(20) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conductors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid,
	"name" varchar(255) NOT NULL,
	"role" varchar(100),
	"bio" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD CONSTRAINT "transcriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_agents" ADD CONSTRAINT "custom_agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_scheduled_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scheduled_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_assets" ADD CONSTRAINT "business_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_assets" ADD CONSTRAINT "business_assets_portfolio_id_social_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."social_portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_portfolios" ADD CONSTRAINT "social_portfolios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_urls" ADD CONSTRAINT "program_urls_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conductor_photos" ADD CONSTRAINT "conductor_photos_conductor_id_conductors_id_fk" FOREIGN KEY ("conductor_id") REFERENCES "public"."conductors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conductors" ADD CONSTRAINT "conductors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conductors" ADD CONSTRAINT "conductors_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "users_verification_token_idx" ON "users" USING btree ("verification_token");--> statement-breakpoint
CREATE INDEX "users_reset_password_token_idx" ON "users" USING btree ("reset_password_token");--> statement-breakpoint
CREATE INDEX "credentials_tenant_id_idx" ON "credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "credentials_tenant_id_category_idx" ON "credentials" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "publications_tenant_id_idx" ON "publications" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "publications_tenant_id_created_at_idx" ON "publications" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "transcriptions_tenant_id_idx" ON "transcriptions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "transcriptions_tenant_id_created_at_idx" ON "transcriptions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "custom_agents_tenant_id_idx" ON "custom_agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "pipeline_configs_tenant_id_idx" ON "pipeline_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_id_created_at_idx" ON "invoices" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscriptions_external_subscription_id_idx" ON "subscriptions" USING btree ("external_subscription_id");--> statement-breakpoint
CREATE INDEX "job_executions_job_id_idx" ON "job_executions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_executions_tenant_id_created_at_idx" ON "job_executions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_tenant_id_idx" ON "scheduled_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_next_run_at_is_active_idx" ON "scheduled_jobs" USING btree ("next_run_at","is_active");--> statement-breakpoint
CREATE INDEX "business_assets_tenant_id_idx" ON "business_assets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "business_assets_tenant_id_asset_type_idx" ON "business_assets" USING btree ("tenant_id","asset_type");--> statement-breakpoint
CREATE INDEX "business_assets_portfolio_id_idx" ON "business_assets" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "social_portfolios_tenant_id_idx" ON "social_portfolios" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "daily_metrics_tenant_id_metric_date_idx" ON "daily_metrics" USING btree ("tenant_id","metric_date");--> statement-breakpoint
CREATE INDEX "notifications_tenant_id_created_at_idx" ON "notifications" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_tenant_id_is_read_idx" ON "notifications" USING btree ("tenant_id","is_read");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_token_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "team_invitations_token_idx" ON "team_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "team_invitations_tenant_id_idx" ON "team_invitations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "program_urls_program_id_idx" ON "program_urls" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "programs_tenant_id_idx" ON "programs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conductor_photos_conductor_id_idx" ON "conductor_photos" USING btree ("conductor_id");--> statement-breakpoint
CREATE INDEX "conductors_tenant_id_idx" ON "conductors" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conductors_program_id_idx" ON "conductors" USING btree ("program_id");