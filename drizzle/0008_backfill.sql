-- 0008 backfill — live-creator-platform (T-12)
-- Data migration: user_tenants, persons family, guest_dossiers.person_id,
-- assets, tenant_quotas, social_connections.
-- IDEMPOTENTE: cada sentencia es segura de re-ejecutar (guards NOT EXISTS /
-- ON CONFLICT DO NOTHING). Copia canónica en temp-migrations/0008_backfill.sql.
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Tabla de mapeo legacy→person (artefacto de migración; queda para auditoría
--    e idempotencia — no forma parte del schema drizzle de aplicación).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "person_legacy_map" (
	"source_table" varchar(20) NOT NULL,
	"source_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	CONSTRAINT "person_legacy_map_pk" PRIMARY KEY ("source_table","source_id")
);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. user_tenants ← users (rol preservado; suspended → suspended, resto active)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "user_tenants" ("user_id","tenant_id","role","status","created_at")
SELECT u."id", u."tenant_id", u."role",
	CASE WHEN u."status" = 'suspended' THEN 'suspended' ELSE 'active' END,
	u."created_at"
FROM "users" u
WHERE u."tenant_id" IS NOT NULL
ON CONFLICT ("user_id","tenant_id") DO NOTHING;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. persons ← conductors + guests (vía person_legacy_map para idempotencia y
--    trazabilidad). role: conductors→'conductor', guests→'invitado' (design).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
	r RECORD;
	new_id uuid;
BEGIN
	FOR r IN SELECT * FROM "conductors" LOOP
		IF NOT EXISTS (SELECT 1 FROM "person_legacy_map" m WHERE m."source_table" = 'conductors' AND m."source_id" = r."id") THEN
			INSERT INTO "persons" ("tenant_id","name","role","bio","is_active","created_at","updated_at")
			VALUES (r."tenant_id", r."name", 'conductor', r."bio", r."is_active", r."created_at", r."updated_at")
			RETURNING "id" INTO new_id;
			INSERT INTO "person_legacy_map" ("source_table","source_id","person_id") VALUES ('conductors', r."id", new_id);
		END IF;
	END LOOP;

	FOR r IN SELECT * FROM "guests" LOOP
		IF NOT EXISTS (SELECT 1 FROM "person_legacy_map" m WHERE m."source_table" = 'guests' AND m."source_id" = r."id") THEN
			INSERT INTO "persons" ("tenant_id","name","role","bio","is_active","created_at","updated_at")
			VALUES (r."tenant_id", r."name", 'invitado', r."bio", r."is_active", r."created_at", r."updated_at")
			RETURNING "id" INTO new_id;
			INSERT INTO "person_legacy_map" ("source_table","source_id","person_id") VALUES ('guests', r."id", new_id);
		END IF;
	END LOOP;
END $$;
--> statement-breakpoint

-- 2a. person_photos ← conductor_photos + guest_photos (pending: re-enrola T-24)
INSERT INTO "person_photos" ("person_id","photo_data","mime_type","is_primary","enrollment_status","created_at")
SELECT m."person_id", cp."photo_data", cp."mime_type", cp."is_primary", 'pending', cp."created_at"
FROM "conductor_photos" cp
JOIN "person_legacy_map" m ON m."source_table" = 'conductors' AND m."source_id" = cp."conductor_id"
WHERE NOT EXISTS (
	SELECT 1 FROM "person_photos" pp
	WHERE pp."person_id" = m."person_id" AND pp."photo_data" = cp."photo_data"
);
--> statement-breakpoint

INSERT INTO "person_photos" ("person_id","photo_data","mime_type","is_primary","enrollment_status","created_at")
SELECT m."person_id", gp."photo_data", gp."mime_type", gp."is_primary", 'pending', gp."created_at"
FROM "guest_photos" gp
JOIN "person_legacy_map" m ON m."source_table" = 'guests' AND m."source_id" = gp."guest_id"
WHERE NOT EXISTS (
	SELECT 1 FROM "person_photos" pp
	WHERE pp."person_id" = m."person_id" AND pp."photo_data" = gp."photo_data"
);
--> statement-breakpoint

-- 2b. person_program ← conductors.program_id + guests.program_id
INSERT INTO "person_program" ("person_id","program_id")
SELECT m."person_id", c."program_id"
FROM "conductors" c
JOIN "person_legacy_map" m ON m."source_table" = 'conductors' AND m."source_id" = c."id"
WHERE c."program_id" IS NOT NULL
ON CONFLICT ("person_id","program_id") DO NOTHING;
--> statement-breakpoint

INSERT INTO "person_program" ("person_id","program_id")
SELECT m."person_id", g."program_id"
FROM "guests" g
JOIN "person_legacy_map" m ON m."source_table" = 'guests' AND m."source_id" = g."id"
WHERE g."program_id" IS NOT NULL
ON CONFLICT ("person_id","program_id") DO NOTHING;
--> statement-breakpoint

-- 2c. person_transmission ← guests con scheduled_date futura (invitado puntual)
INSERT INTO "person_transmission" ("tenant_id","person_id","program_id","scheduled_date","role","created_at")
SELECT g."tenant_id", m."person_id", g."program_id", g."scheduled_date", 'guest', g."created_at"
FROM "guests" g
JOIN "person_legacy_map" m ON m."source_table" = 'guests' AND m."source_id" = g."id"
WHERE g."scheduled_date" >= CURRENT_DATE
	AND NOT EXISTS (
		SELECT 1 FROM "person_transmission" pt
		WHERE pt."person_id" = m."person_id"
			AND pt."program_id" IS NOT DISTINCT FROM g."program_id"
			AND pt."scheduled_date" = g."scheduled_date"
	);
--> statement-breakpoint

-- 2d. guest_dossiers.person_id ← map via guest_id
UPDATE "guest_dossiers" d
SET "person_id" = m."person_id"
FROM "person_legacy_map" m
WHERE m."source_table" = 'guests'
	AND m."source_id" = d."guest_id"
	AND d."person_id" IS NULL;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. assets ← clips (type='clip', source='synthetic') + publications (type='nota')
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "assets" ("tenant_id","type","status","source","title","content","media_refs","program_id","legacy_ref","created_at","updated_at")
SELECT c."tenant_id", 'clip',
	CASE c."status"
		WHEN 'generating' THEN 'generating' WHEN 'ready' THEN 'ready' WHEN 'completed' THEN 'ready'
		WHEN 'pending_review' THEN 'pending_review' WHEN 'approved' THEN 'approved'
		WHEN 'rejected' THEN 'rejected' WHEN 'published' THEN 'published'
		WHEN 'failed' THEN 'failed' WHEN 'error' THEN 'failed'
		ELSE 'ready'
	END,
	'synthetic', c."title", c."hook_text",
	jsonb_build_object('videoPath', c."video_path", 'audioPath', c."audio_path", 'subtitlesPath', c."subtitles_path"),
	CASE WHEN EXISTS (SELECT 1 FROM "programs" p WHERE p."id" = c."program_id") THEN c."program_id" ELSE NULL END,
	jsonb_build_object('table', 'clips', 'id', c."id", 'metadata', c."metadata"),
	c."created_at", c."created_at"
FROM "clips" c
WHERE NOT EXISTS (
	SELECT 1 FROM "assets" a
	WHERE a."legacy_ref"->>'table' = 'clips' AND (a."legacy_ref"->>'id')::uuid = c."id"
);
--> statement-breakpoint

INSERT INTO "assets" ("tenant_id","type","status","source","title","content","media_refs","quotes","content_variants","edit_history","legacy_ref","created_at","updated_at")
SELECT p."tenant_id", 'nota',
	CASE p."status"
		WHEN 'generating' THEN 'generating' WHEN 'ready' THEN 'ready' WHEN 'pending_review' THEN 'pending_review'
		WHEN 'approved' THEN 'approved' WHEN 'rejected' THEN 'rejected' WHEN 'published' THEN 'published'
		WHEN 'failed' THEN 'failed'
		ELSE 'pending_review'
	END,
	'synthetic', p."title", p."content",
	jsonb_build_object('imagePath', p."image_path", 'thumbnailPath', p."image_url"),
	p."quotes", p."content_variants", COALESCE(p."edit_history", '[]'::jsonb),
	jsonb_build_object('table', 'publications', 'id', p."id"),
	p."created_at", p."created_at"
FROM "publications" p
WHERE NOT EXISTS (
	SELECT 1 FROM "assets" a
	WHERE a."legacy_ref"->>'table' = 'publications' AND (a."legacy_ref"->>'id')::uuid = p."id"
);
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. tenant_quotas ← usage_records (todos los períodos; transmissions arranca 0)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "tenant_quotas" ("tenant_id","period","transmissions_count","pipeline_hours","extra_transmissions","storage_mb","updated_at")
SELECT ur."tenant_id", to_char(ur."period_start", 'YYYY-MM'), 0, ur."pipeline_hours_used", 0, ur."storage_used_mb", ur."updated_at"
FROM "usage_records" ur
ON CONFLICT ("tenant_id","period") DO NOTHING;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. social_connections ← business_assets (meta_legacy / twitter_legacy)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO "social_connections" ("tenant_id","provider","platform","external_account_id","portfolio_id","display_name","metadata","is_active","connected_at","created_at")
SELECT b."tenant_id",
	CASE WHEN b."asset_type" = 'twitter_account' THEN 'twitter_legacy' ELSE 'meta_legacy' END,
	CASE b."asset_type"
		WHEN 'facebook_page' THEN 'facebook'
		WHEN 'instagram_account' THEN 'instagram'
		WHEN 'twitter_account' THEN 'twitter'
		ELSE b."asset_type"
	END,
	b."external_id", b."portfolio_id", b."name", b."metadata", b."is_active", b."created_at", b."created_at"
FROM "business_assets" b
ON CONFLICT ("tenant_id","provider","platform","external_account_id") DO NOTHING;
--> statement-breakpoint

-- 5a. twitter_legacy por credencial válida sin business_asset asociado
--     (credencial global/por tenant: TWITTER_TOKEN_* category='twitter' is_valid)
INSERT INTO "social_connections" ("tenant_id","provider","platform","external_account_id","display_name","metadata","is_active","connected_at","created_at")
SELECT c."tenant_id", 'twitter_legacy', 'twitter', NULL, 'Twitter (legacy)', '{}'::jsonb, true, c."created_at", c."created_at"
FROM "credentials" c
WHERE c."category" = 'twitter'
	AND c."is_valid" = true
	AND c."name" LIKE 'TWITTER_TOKEN_%'
	AND NOT EXISTS (
		SELECT 1 FROM "social_connections" s
		WHERE s."tenant_id" = c."tenant_id" AND s."provider" = 'twitter_legacy' AND s."platform" = 'twitter'
	);
