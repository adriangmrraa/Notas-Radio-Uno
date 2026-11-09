-- PC-02: preserve legacy conductor names (which allow 255 characters) exactly.
ALTER TABLE "persons" ALTER COLUMN "name" SET DATA TYPE varchar(255);
--> statement-breakpoint
-- `person_id` is the durable migration marker.  We deliberately reuse each
-- legacy row's UUID as its person UUID: it gives a deterministic, tenant-safe
-- one-to-one correspondence without adding provenance columns or matching on
-- mutable data such as a person's name.
INSERT INTO "persons" (
  "id", "tenant_id", "name", "role_label", "role", "bio", "is_active", "created_at", "updated_at"
)
SELECT
  c."id",
  c."tenant_id",
  c."name",
  NULLIF(BTRIM(c."role"), ''),
  CASE LOWER(BTRIM(COALESCE(c."role", '')))
    WHEN 'columnista' THEN 'columnista'::"PersonRole"
    WHEN 'productor' THEN 'productor'::"PersonRole"
    WHEN 'invitado' THEN 'invitado'::"PersonRole"
    WHEN 'colaborador' THEN 'colaborador'::"PersonRole"
    WHEN 'otro' THEN 'otro'::"PersonRole"
    WHEN 'other' THEN 'otro'::"PersonRole"
    ELSE 'conductor'::"PersonRole"
  END,
  c."bio",
  c."is_active",
  c."created_at",
  c."updated_at"
FROM "conductors" c
WHERE c."person_id" IS NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "conductors"
SET "person_id" = "id"
WHERE "person_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "persons" p
    WHERE p."id" = "conductors"."id"
      AND p."tenant_id" = "conductors"."tenant_id"
  );
--> statement-breakpoint
INSERT INTO "persons" (
  "id", "tenant_id", "name", "role_label", "role", "bio", "is_active", "created_at", "updated_at"
)
SELECT
  g."id",
  g."tenant_id",
  g."name",
  NULLIF(BTRIM(g."role"), ''),
  'invitado'::"PersonRole",
  g."bio",
  g."is_active",
  g."created_at",
  g."updated_at"
FROM "guests" g
WHERE g."person_id" IS NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "guests"
SET "person_id" = "id"
WHERE "person_id" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "persons" p
    WHERE p."id" = "guests"."id"
      AND p."tenant_id" = "guests"."tenant_id"
  );
--> statement-breakpoint
INSERT INTO "person_program" (
  "tenant_id", "person_id", "program_id", "role_on_program", "is_primary"
)
SELECT
  c."tenant_id",
  c."person_id",
  c."program_id",
  NULLIF(LEFT(BTRIM(c."role"), 80), ''),
  true
FROM "conductors" c
INNER JOIN "programs" p
  ON p."id" = c."program_id"
  AND p."tenant_id" = c."tenant_id"
WHERE c."person_id" IS NOT NULL
  AND c."program_id" IS NOT NULL
ON CONFLICT ("person_id", "program_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "person_program" (
  "tenant_id", "person_id", "program_id", "role_on_program", "is_primary"
)
SELECT
  g."tenant_id",
  g."person_id",
  g."program_id",
  NULLIF(LEFT(BTRIM(g."role"), 80), ''),
  false
FROM "guests" g
INNER JOIN "programs" p
  ON p."id" = g."program_id"
  AND p."tenant_id" = g."tenant_id"
WHERE g."person_id" IS NOT NULL
ON CONFLICT ("person_id", "program_id") DO NOTHING;
