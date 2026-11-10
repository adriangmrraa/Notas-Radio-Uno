-- PG-06: composición del contenido por red — menciones reales
-- (persons.social_links), etiquetas finales, exclusiones del operador y
-- flag de truncado por límite de plataforma. El texto final vive en
-- `content`; `payload` guarda la estructura para la UI.
ALTER TABLE "publish_jobs" ADD COLUMN IF NOT EXISTS "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;