# PC-08 Repair — W1 y W2 (bugs reales de la agenda)

El QA dio **GO** sobre `512c7aa` con 0 criticals, pero dejó dos warnings que son bugs concretos de comportamiento.
Se corrigen acá, dentro del mismo slice, antes de integrar.

## W1 — `isActive` se ignora al crear (`src/server/routes/transmissions.ts`)

`parseScheduleBody` acepta `isActive`, pero `valuesFromFields` **no lo incluye** en el INSERT del POST (sí lo
aplica en el PUT). Consecuencia: crear una entrada con `isActive: false` la deja **activa** en silencio.

**Fix**: el POST debe respetar el `isActive` que viene (default `true` si no viene). Agregá el campo al insert y
un test que cubra el caso (si el store de test es inyectable como en otros slices, usalo; si no, al menos dejá la
lógica en una función pura testeable, p.ej. `valuesFromFields`, y testeala).

## W2 — `occurrencesBetween` no recorta por `starts_at` (`src/server/lib/scheduleRules.ts`, ~líneas 391-413)

El parámetro `startsAt` sólo se usa para el caso `COUNT=1`. Consecuencia: al navegar a un mes **anterior** a la
creación, el calendario muestra ocurrencias "fantasma" de una regla que nunca se programó.

**Fix**: las ocurrencias devueltas deben ser **estrictamente posteriores** a `startsAt` (la primera emisión de la
regla). Con `FREQ=DAILY;COUNT=1` eso ya está; el bug aparece con `FREQ=WEEKLY`/`DAILY` sin COUNT, donde la serie
empieza en `starts_at` y no debe mostrar sheds anteriores.
Agregá un test: una regla semanal creada "hoy" ⇒ `occurrencesBetween` para el mes pasado devuelve **0** ocurrencias.

## Ojo con la semántica (no la rompas)

- `nextOccurrence` (en `rrule.ts`) ya garantiza "estrictamente posterior a `from`" y es lo que usa el servidor para
  `next_run_at`. **No lo cambies** — los 16 tests de PC-07 deben seguir verdes.
- El recorte por `starts_at` es en la capa de **occurrencias del calendario** (`scheduleRules.ts`), no en `rrule.ts`.
- Si el fix de W2 requiere un parámetro nuevo en `occurrencesBetween`, actualizá sus callers (`AgendaPage.tsx` y
  el route que devuelve ocurrencias) y los tests.

## Qué NO tocar

- `drizzle/`, `drizzle/meta/`, `src/server/db/schema/` — NO se tocan.
- `scheduled_jobs` / `ScheduledJobsPage` / `jobSchedulerService` — NO se tocan.
- Sin dependencias nuevas. El W3 del QA ("Hoy" usa la fecha del browser, no la tz de la entrada) queda como
  warning **cosmetico**: no lo arregles en este repair (es un edge de UI, no un bug de datos).

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
Ojo: el runner PGlite puede fallar con `stdin is not a tty` de forma transitoria; si pasa, re-corré y reportá la
corrida que terminó (la 2ª debería dar 0).

## Commit

**Un commit nuevo** (NO amendes `512c7aa`, así el QA queda trazable):
`fix(agenda): respetar is_active al crear y recortar ocurrencias por starts_at`

Paths explícitos. Sin push, sin merge, sin deploy. Sin atribución de IA.

## Reporte final

1. SHA nuevo + `git show --stat`.
2. Exit code de cada gate + línea de resumen de vitest.
3. Qué cambió exactamente en W1 y W2 (archivo:línea antes/después) y los tests nuevos.
4. Confirmación de que los tests de PC-07 (`tests/rrule.test.ts`) siguen verdes sin haber cambiado `rrule.ts`.
