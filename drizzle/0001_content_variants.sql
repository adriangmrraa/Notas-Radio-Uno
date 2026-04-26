-- Migration: add content_variants column to publications
-- Feature: Content Multiplier (1→N formats)

ALTER TABLE "publications" ADD COLUMN IF NOT EXISTS "content_variants" jsonb;
