-- Migration: create clips table
-- Feature: Auto-Clips Verticales con Subtítulos

CREATE TABLE IF NOT EXISTS "clips" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "publication_id" uuid,
  "program_id" uuid,
  "title" varchar(255) NOT NULL,
  "hook_text" text NOT NULL,
  "audio_path" text,
  "video_path" text,
  "subtitles_path" text,
  "duration" integer NOT NULL DEFAULT 0,
  "status" varchar(30) NOT NULL DEFAULT 'generating',
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "clips_tenant_id_idx" ON "clips" ("tenant_id");
CREATE INDEX IF NOT EXISTS "clips_tenant_id_status_idx" ON "clips" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "clips_tenant_id_created_at_idx" ON "clips" ("tenant_id", "created_at");
