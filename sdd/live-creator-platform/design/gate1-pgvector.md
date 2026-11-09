# GATE-1 — Spike pgvector (T-06): resultado

**Veredicto: FALLBACK** — `face_embeddings.embedding` se persiste como `jsonb` (float[512]) y el matching por cosine similarity se calcula en aplicación (Node), no con `embedding <=>`.

## Qué se intentó

1. Buscar `DATABASE_URL` real para correr `CREATE EXTENSION IF NOT EXISTS vector` + `SELECT '[1,2,3]'::vector` contra la DB de staging/desarrollo.
2. Resultado: **no existe `.env` en este workspace** — solo `.env.example` con placeholder `postgresql://periodist:TU_CONTRASENA_SEGURA@localhost:5432/periodistapp`. No hay `DATABASE_URL` en el entorno del proceso ni Postgres local alcanzable.
3. Conclusión: la DB **no es alcanzable** desde el entorno de desarrollo actual → no se puede ejecutar ni verificar el spike en Neon real.

## Decisión (regla vinculante)

Per la regla del spike: *"si la DB no es alcanzable o no soporta vector → documentar y aplicar el fallback del design"*. El fallback ya está previsto en `design.md` (risks, supuesto #4):

- `face_embeddings.embedding` → `jsonb` con `number[]` de 512 dims (equivalente a `numeric[]`, sin dependencia de extensión).
- Matching por tenant: leer embeddings del tenant (`≈50 persons × pocas fotos` — viable en app, según design) y cosine similarity en Node con umbral ~0.5.
- **Ninguna migración crea `CREATE EXTENSION vector`** — así la cadena de migraciones no depende de pgvector y aplica en cualquier Postgres.

## Verificación pendiente en staging (manual)

Cuando haya `DATABASE_URL` real en staging, el operador PUEDE ejecutar opcionalmente:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT '[1,2,3]'::vector;
```

Si pgvector está disponible, una migración futura puede convertir `face_embeddings.embedding` a `vector(512)` + índice `hnsw (embedding vector_cosine_ops)` y reemplazar el cosine en app por `ORDER BY embedding <=> $1`. El fallback no lo bloquea — es solo aditivo.

## Impacto

- T-08: resuelto por fallback (sin migración de extensión).
- T-23/T-24/T-25: `faceService`/`frameSamplerService` deben implementar cosine en app (helper compartido, p.ej. `src/server/lib/cosine.ts`) en vez de `<=>` en SQL.
