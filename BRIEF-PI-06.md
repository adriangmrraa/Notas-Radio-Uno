# BRIEF-PI-06 — Checklist go-live de PeriodistApp (seeds, demo, health, runbook)

Ejecutá este brief de forma **completamente automática**. No esperes aprobación humana en
ningún paso: los permisos ya están en modo bypass. Si un comando falla, diagnosticá y
seguí; sólo frená si el brief lo prohíbe explícitamente.

- **Repo**: `periodistapp` (Express + TypeScript / React SPA / Drizzle + Postgres).
- **Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pi-06-golive-checklist`
- **Rama**: `pi-06-golive-checklist` (base `834af36` = `origin/master`).
- **Nunca** trabajes en el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`.
- **No** modifiques el `BRIEF.md` de la raíz del repo (pertenece a otro slice, `PF-10`).
  Este brief es `BRIEF-PI-06.md`.

## Objetivo

Entregar los 4 artefactos del checklist go-live (PI-06), en disco, con los gates verdes.

### 1. Seeds de planes
- Tabla de planes con los **tiers reales** del producto: leé el código, el schema, la landing
  pública y los tests del repo para no inventar nombres ni precios. Usá lo que el repo ya define.
- Seed **idempotente**: re-run sin duplicar (`ON CONFLICT DO NOTHING` / `DO UPDATE`).
- Ubicación: el lugar que el repo ya use para seeds (`supabase/seed.sql`, `drizzle/seed.ts`,
  `scripts/seed*`, etc.). Si el repo no tiene seeds, creá el que encaje con su stack.
- Sin datos inventados presentados como "reales": los planes deben ser los del producto.

### 2. Datos demo (multi-tenant + RLS)
- Dataset coherente con los seeds: tenant demo + org + sedes + membresías + contenido mínimo.
- **Toda** query filtra por `tenant_id`. Ningún seed puede leer/escribir datos de otro tenant.
- Debe existir un **test que pruebe el aislamiento** entre dos tenants del dataset demo
  (un tenant no lee lo del otro).

### 3. Health check
- Endpoint de health que reporte estado **real**: DB alcanzable, migraciones aplicadas,
  provider de IA configurado.
- **NO** expone secretos, tokens ni connection strings en la respuesta ni en logs.
- Estados coherentes: `ok` / `degraded` / `error` con códigos HTTP consistentes
  (p. ej. 200 / 200 o 503 / 503 según semántica del repo; justificá la decisión en el commit).

### 4. Runbook de incidentes
- Documento en el repo (p. ej. `docs/RUNBOOK.md` o `docs/operations/`) con
  **síntoma → diagnóstico → acción concreta** para estos casos obligatorios:
  - "cola de jobs caída"
  - "provider de IA caído"
  - "migración faltante"
  - "deploy fallido"
- Acciones ejecutables, no teoría. Sin credenciales ni connection strings reales.

## Gates exactos (TODOS deben dar EXIT 0, sobre el árbol de este worktree)

1. Instalá dependencias primero: `pnpm install --frozen-lockfile` si hay `pnpm-lock.yaml`,
   si no `npm ci` (si no hay lockfile compatible, `npm install`).
2. `npx tsc --noEmit` → **EXIT 0**
3. `npx vitest run` (suite completa) → **EXIT 0**. Reportá el conteo de archivos de test y
   de tests ejecutados en el mensaje final.
4. `npm run build` → **EXIT 0**
5. `git diff --check` → **EXIT 0**
6. `git status --porcelain --untracked-files=all` → **vacío** (nada sin commitear)

Si un gate falla por un problema **preexistente** ajeno a tu cambio, NO lo maquilles ni lo
"arregles" de más: medí cuántos errores son tuyos, reportá el número exacto de errores
preexistentes y el de los tuyos, y dejá tu parte en EXIT 0.

## Orden de commits

- Work-unit commits convencionales: `feat(...)`, `test(...)`, `docs(...)`.
- **Paths explícitos** en cada `git add`. **Nunca** `git add -A` ni `git add .`.
- Sin atribución de IA. Sin `Co-Authored-By`.

## Límites duros (respetalos al pie de la letra)

- **NO** push a `master`/`main` (ni a ninguna rama remota). **NO** merge. **NO** deploy.
- **NO** migraciones contra producción. **NO** tocar el checkout compartido.
- **NO** exponer tokens, claves, connection strings ni secretos en código, logs, seeds, tests
  ni docs. Usá variables de entorno / placeholders explícitos.
- **NO** modificar el esquema en producción; las migraciones del repo (si las agregás) son
  archivos locales solamente, sin aplicarlas a ningún entorno remoto.
- Todo query de datos multi-tenant filtra por `tenant_id`.

## Cierre

Cuando los 4 entregables estén en disco con los gates verdes:

1. Dejá la rama lista para revisión (commits en la rama, worktree limpio).
2. Reportá en el mensaje final:
   - los **comandos exactos** que corriste y su **EXIT real** (número, no "OK"),
   - el conteo de tests de vitest,
   - la lista de archivos creados/modificados,
   - los hashes de los commits (`git log --oneline`),
   - `git status --porcelain` vacío.
3. Si algún gate no pudo quedar verde, decí exactamente cuál, por qué y qué quedó sin hacer.
   No inventes resultados.
