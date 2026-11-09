-- Migration: add program_id to scheduled_jobs (T-05 scheduler-fix)
-- Links a scheduled job to a program (nullable; SET NULL on program delete).
-- NOTE: drizzle-kit generate also emitted catch-up drift (guests, dossiers,
-- publications review columns, etc.) — those objects pre-date this change and
-- are intentionally NOT re-created here to stay idempotent on existing DBs.
-- The meta snapshot (0004_snapshot.json) still captures the full current
-- schema so future generates diff cleanly.

ALTER TABLE "scheduled_jobs" ADD COLUMN IF NOT EXISTS "program_id" uuid;--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
