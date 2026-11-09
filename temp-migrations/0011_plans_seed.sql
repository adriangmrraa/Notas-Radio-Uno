-- ============================================================================
-- T2 / T-44 — Seed de planes trial / Creator / Media / Network / Enterprise
--
--   Límites (spec PRODUCT-VISION §3.2 / tasks T-44):
--     transmisiones/mes   8    / 30   / 120   / ∞        (trial: 2 — eligibility)
--     duración máx/tx     3h   / 6h   / 12h   / ∞        (trial: 3h)
--     clips/transmisión   10   / 25   / 50    / ∞
--     personas (roster)   10   / 50   / 200   / ∞
--     retención días      7    / 30   / 90    / custom (null)
--     plataformas destino 3    / 10   / 30    / ∞
--     miembros de equipo  1    / 5    / 15    / ∞
--     trial               7 días (TRIAL_DAYS en authService), 2 transmisiones,
--                         sin re-trial: email único en register + sub 1:1/tenant
--                         y ningún edge vuelve a 'trialing' (máquina T-39).
--
--   'trial' existe porque register() lo busca por name al crear la suscripción
--   trialing. Nunca es vendible: /plans lo filtra por nombre y /checkout lo
--   rechaza explícitamente.
--
--   Features: keys snake_case coherentes con FEATURE_DEFAULTS
--   (featureFlagService). zernio_publishing queda OFF en todos — rollout WU5
--   via tenant_features/admin, no por plan.
--
--   Idempotente: ON CONFLICT (name) DO NOTHING — no pisa ajustes manuales de
--   precios/features que haga operaciones después del seed.
-- ============================================================================

INSERT INTO "plans" (
  "name", "display_name", "description",
  "price_usd", "price_usd_yearly", "price_ars", "price_ars_yearly",
  "max_pipeline_hours_per_month", "max_team_members", "max_connected_platforms", "max_storage_gb",
  "max_transmissions_per_month", "max_duration_minutes", "max_clips_per_transmission",
  "max_persons", "retention_days",
  "features", "is_active", "sort_order"
) VALUES
  ('trial', 'Trial', 'Prueba gratuita: 7 días, 2 transmisiones',
   0.00, 0.00, 0.00, 0.00,
   6, 1, 3, 5,
   2, 180, 10,
   10, 7,
   '{"live_video":true,"face_attribution":true,"auto_publish":false,"zernio_publishing":false,"image_models_multi":false}'::jsonb,
   true, 0),
  ('creator', 'Creator', 'Para creadores individuales',
   49.00, 490.00, 49000.00, 490000.00,
   24, 1, 3, 50,
   8, 180, 10,
   10, 7,
   '{"live_video":true,"face_attribution":true,"auto_publish":false,"zernio_publishing":false,"image_models_multi":false}'::jsonb,
   true, 1),
  ('media', 'Media', 'Para medios y equipos chicos',
   149.00, 1490.00, 149000.00, 1490000.00,
   90, 5, 10, 200,
   30, 360, 25,
   50, 30,
   '{"live_video":true,"face_attribution":true,"auto_publish":true,"zernio_publishing":false,"image_models_multi":false}'::jsonb,
   true, 2),
  ('network', 'Network', 'Para cadenas y operaciones grandes',
   399.00, 3990.00, 399000.00, 3990000.00,
   360, 15, 30, 1000,
   120, 720, 50,
   200, 90,
   '{"live_video":true,"face_attribution":true,"auto_publish":true,"zernio_publishing":false,"image_models_multi":true}'::jsonb,
   true, 3),
  ('enterprise', 'Enterprise', 'A medida — límites custom por contrato',
   999.00, 9990.00, 999000.00, 9990000.00,
   NULL, NULL, NULL, 5000,
   NULL, NULL, NULL,
   NULL, NULL,
   '{"live_video":true,"face_attribution":true,"auto_publish":true,"zernio_publishing":true,"image_models_multi":true}'::jsonb,
   true, 4)
ON CONFLICT ("name") DO NOTHING;
