-- Migration: public surfaces — add slug + is_public to programs
-- Feature #7: Public Surfaces

ALTER TABLE "programs"
  ADD COLUMN IF NOT EXISTS "slug" varchar(100),
  ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "programs_slug_unique" ON "programs" ("slug") WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS "programs_slug_idx" ON "programs" ("slug");
