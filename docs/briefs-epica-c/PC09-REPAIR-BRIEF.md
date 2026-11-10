# PC-09 Repair — W1: restaurar el filtrado en SQL de `listDossiers`

El QA dio **GO** sobre `4d17dad` con 0 criticals, pero dejó un warning que es una **regresión real** de
comportamiento: `listDossiers` movió el filtrado por `programId` / `date` (y el nuevo `scheduledTransmissionId`)
del `WHERE` SQL a **memoria** — ahora trae **todas** las filas del tenant y filtra en el proceso.

Consecuencia: un tenant con muchos dossiers (uno por invitado por fecha, histórico que crece) paga la lectura
completa en cada llamada a `GET /api/dossiers`, que es el endpoint que la UI consulta para filtrar por
programa/fecha. Antes era un query indexado.

## Fix

- `listDossiers` debe volver a filtrar **en SQL**: los filtros `programId`, `date` y `scheduledTransmissionId`
  van en el `WHERE` con `eq(...)` (los índices `guest_dossiers_program_date_idx` y el nuevo de la FK lo cubren).
- La **re-verificación en memoria** del `tenant_id` que el autor añadió como defensa extra **se puede quedar**
  (es inocua y el QA laapproveó como no vacua), pero no debe reemplazar al filtro SQL.
- Si el store inyectable que usan los tests necesita una forma de expresar el filtro, ajustá el store de tests
  para que **replique** el `WHERE` (no el filtrado en memoria), y mantené el test que inyecta filas de otro tenant
  para comprobar que **no** se cuelan.

## Test

- Agregá/ajustá un test que compruebe que el filtro se aplica **en la query** (por ejemplo, inyectando un source
  que registre el `where`/los parámetros usados, o comprobando que el source no recibe filas de otros programas).
  Si eso no es practicable con el store actual, documentá el hueco en el reporte — pero el **fix del SQL** es
  obligatorio.

## Qué NO tocar

- `drizzle/`, `drizzle/meta/`, `src/server/db/schema/`.
- El prompt/contenido del dossier, el resto del módulo, la UI.
- `scheduled_jobs` / `ScheduledJobsPage` / `jobSchedulerService`.
- Sin dependencias nuevas.

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
corrida que terminó.

## Commit

**Un commit nuevo** (NO amendes `4d17dad`):
`fix(dossier): restaurar el filtrado SQL de listDossiers`

Paths explícitos. Sin push, sin merge, sin deploy. Sin atribución de IA.

## Reporte final

1. SHA nuevo + `git show --stat`.
2. Exit code de cada gate + línea de resumen de vitest.
3. El diff conceptual: qué cambió en `listDossiers` (antes/después) y cómo se comprueba que el filtro quedó en SQL.
4. Qué test se agregó/ajustó.
