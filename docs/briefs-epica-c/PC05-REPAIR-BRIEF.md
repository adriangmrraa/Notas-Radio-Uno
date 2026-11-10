# PC-05 Repair — W1 y W3 (bugs reales, inexpensive)

El QA final dio **GO** sobre `2410ff3` con 0 criticals, pero dejó dos warnings que son bugs concretos. Se
corrigen acá, dentro del mismo slice, antes de integrar a master.

## W1 — El upsert no es atómico (`src/server/services/editorialService.ts`, ~líneas 290-323)

`upsertProfile` hace **find-then-insert**: dos `PUT` concurrentes sobre el perfil default del tenant (o sobre el
mismo override de programa) pueden ambos ver "no existe" y el segundo choca contra
`editorial_profiles_tenant_default_unique` / `editorial_profiles_tenant_program_unique` → **500 genérico**.

**Fix**: upsert real y atómico con `onConflictDoUpdate` de Drizzle, sobre la constraint correcta:
- default del tenant: `onConflictDoUpdate({ target: [editorialProfiles.tenantId], targetWhere: sql`${editorialProfiles.programId} is null`, set: {...} })`
  — el índice parcial `editorial_profiles_tenant_default_unique` es sobre `tenant_id` **where `program_id is null`**;
  verificá contra la API de Drizzle 0.44 cómo se expresa `targetWhere` (mirá el código de drizzle en
  `node_modules/drizzle-orm/pg-core` si hace falta) y **probá que el SQL generado es el correcto**.
- override de programa: `onConflictDoUpdate({ target: [editorialProfiles.tenantId, editorialProfiles.programId], set: {...} })`.
- Si `onConflictDoUpdate` con `targetWhere` no es viable en esta versión de Drizzle, la alternativa es
  **insert → catch de error de unique violation → update**, siempre dentro de una transacción. Elegí una y
  justificá en el reporte por qué.
- **Agregá un test** que verifique que dos upserts consecutivos del default (o del override) **no** crean dos filas
  y que el segundo **actualiza** (el store en memoria del test tiene que replicar la semántica de upsert; si tu
  store en memoria no puede, aggregate un test al nivel del store drizzle con mock, o documentá el hueco).

## W3 — `isActive`/`tone` del override pisan siempre (semántica undesirable)

Hoy, como `tone` e `isActive` son NOT NULL en el schema, **toda** fila de override los pisa. Consecuencia concreta:
si el perfil **del canal** está desactivado (`is_active = false`) y hay un override de programa, el perfil efectivo
del programa queda **activo** — el canal deactivated revive por un override.

**Fix (regla clara, aplicala)**: en `getEffectiveProfile`, si el perfil **default del tenant** existe y tiene
`is_active = false`, el perfil efectivo es **inactivo** (y queda `is_active: false`) **sin importar** el override.
Es decir: `is_active` del tenant es un interruptor maestro; el override sólo puede **desactivar** (poner false),
nunca **reactivar** algo que el canal tiene desactivado.

- Para `tone`: mantené el comportamiento actual (el override pisa el tono siempre si hay fila de override) — está
  documentado y es razonable. **No lo cambies.**
- Agregá/ajustá un test: tenant `is_active=false` + override de programa `is_active=true` ⇒ efectivo `is_active=false`
  y el override queda listado en `overriddenFields` (o no — según cómo lo implementes, pero **documentá** la decisión
  y que sea **consistente** entre código y test).

## W4 (mismo repair, barato) — validación de strings vacíos

`parseProfileBody` acepta `""` / `"   "` en escalares y `""` en items de arrays / títulos de ejemplos; al ser
non-null, **pisan** el valor heredado con basura.

**Fix**: normalizá los escalares con `.trim()`; tratá string vacío (post-trim) como **ausente** (`undefined` ⇒
hereda/no pisa). Para arrays: **filtrá** items vacíos (post-trim) al guardar; si el array queda vacío, se comporta
como array vacío ⇒ hereda (regla ya existente). Para ejemplos: exigí `title` no vacío tras trim (si viene vacío,
se ignora ese ejemplo) y `excerpt` opcional → si falta, se guarda como `""` (el schema lo define así).

## Qué NO tocar

- La regla de merge por campo (ya correcta y verificada por el QA).
- Los filtros por tenant (ya correctos).
- `drizzle/`, `drizzle/meta/`, `src/server/db/schema/` — **NO** se tocan.
- No agregues dependencias. No toques los servicios de prompts (eso es PC-06).

## Gates (exit code real, a completion)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

`npm run build` debe seguir imprimiendo **"No schema changes, nothing to migrate"**.

## Commit

**Un commit nuevo** (NO amendes `2410ff3`, así el QA queda trazable):
`fix(editorial): upsert atomico, is_active del canal como interruptor maestro y validacion de strings vacios`

Paths explícitos. Sin push, sin merge, sin deploy. Sin atribución de IA.

## Reporte final

1. SHA nuevo + `git show --stat`.
2. Exit code de cada gate + línea de resumen de vitest.
3. Cómo quedó el upsert (SQL/mecanismo) y por qué es atómico.
4. La regla final de `is_active` con el ejemplo concreto.
5. Qué tests nuevos se agregaron.
