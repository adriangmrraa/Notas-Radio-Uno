# PC-02 — Migración de conductores e invitados a `persons`

## Contexto y alcance estricto

Este worktree nace de `origin/master` en `95f112e`, que ya contiene PC-01 (`persons`, `person_photos`, `face_embeddings`, `person_program`, `editorial_profiles`). Implementá **solamente PC-02** de Épica C: migrar de forma segura e idempotente los conductores y guests existentes a la biblioteca `persons` del mismo `tenant_id`.

La decisión SDD vigente es: conductores + guests se unifican en `persons`; no renombrar las tablas históricas. La nueva migración debe preservar el historial sin duplicar registros al reaplicarse. No implementar UI, pipeline de rostros, editorial UI/prompts, agenda, schema de transmisiones ni onboarding.

## Primero: inspección real

1. Leé `PC02-BRIEF.md`, `drizzle/`, `src/server/db/schema/`, los repositories/routes que consumen conductores/guests y `scripts/verify-migration-pglite.mjs`.
2. Identificá los nombres físicos y relaciones reales de las tablas de conductores e invitados; no inventes columnas.
3. Definí una correspondencia determinista hacia `persons` con `tenant_id` obligatorio y rol apropiado. Conservá nombre/datos disponibles, y metadatos/note/redes sólo si existen en origen.

## Implementación

- Crear una migración SQL Drizzle nueva, idempotente y segura que backfille datos históricos a `persons`.
- Debe ser robusta frente a reejecuciones: no crear duplicados. Usá claves/condiciones que existan realmente y que distingan tenant + origen.
- Si hace falta una marca de procedencia para una migración correctamente idempotente, agregala sólo si es mínima, justificada y dentro de PC-02; preferí una estrategia compatible con el schema PC-01.
- Agregá o actualizá el verificador PGlite y tests específicos si la arquitectura del repo los usa, para probar: datos de al menos dos tenants, migración, reaplicación, aislamiento por tenant y ausencia de duplicados.
- No tocar ni borrar archivos residuales/brieves de otros worktrees. No usar `git add -A` ni `git add .`.

## Gates obligatorios

Ejecutá y esperá resultado final con exit code:

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
# además el test/verificador específico nuevo si lo agregás
git diff --check
```

No arrancar el server ni usar `DATABASE_URL` real. La migración se verifica con PGlite.

## Git y reporte

Cuando los gates estén verdes, hacé **un solo commit conventional** con paths explícitos y sin atribución IA. No push, no merge, no deploy. Dejá el árbol limpio respecto de los archivos del slice (el brief puede quedar untracked). Al final informá: SHA, archivos, estrategia concreta anti-duplicado, salida resumida de cada gate y cualquier límite real encontrado.
