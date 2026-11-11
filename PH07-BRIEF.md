# PH-07 — Responsive aceptable en tablet (la sala en vivo se usa en producción)

## Contexto

- Repo: `periodistapp` (Express 4 + TS + React SPA + Drizzle/Postgres + Vite).
- Worktree AISLADO: `C:/Users/Asus/orca/workspaces/periodistapp/ph-07-responsive`, rama `ph-07-responsive`.
- Base ya entregada: `42b295c` (= `origin/ph-06-email-branding`), que encadena Épica G + PH-01..PH-06.
- El checkout COMPARTIDO `C:/Users/Asus/Documents/estabilizacion/periodistapp` es de SOLO LECTURA: NO lo toques ni commitees ahí.

## Objetivo

La sala en vivo (`/en-vivo`) se usa en producción desde tablets. Hoy el layout es de escritorio y en
tablet se rompe o queda inusable. Este slice hace que **la experiencia en tablet sea aceptable de verdad**,
no sólo "que no desborde".

Qué significa "aceptable" en tablet, de forma concreta y medible:

1. **Sin scroll horizontal** en ninguna vista: nada se sale del viewport (ni tablas, ni cards, ni la
   topbar, ni el sidebar, ni el timeline de la sala en vivo).
2. **Targets táctiles ≥ 44px** en los controles principales (botones de la sala, play/pause, chat, publicar).
3. **La sala en vivo se puede usar completa desde tablet**: ver la transmisión, ver el chat, y al menos
   poder pausar/reanudar y enviar un mensaje — sin depender del mouse ni de hover.
4. **Sidebar como drawer**: en `< lg` el sidebar no debe estar fijo en 240px robando espacio; debe colapsar
   a un botón que abre un overlay. Si ya existe un drawer, mejorarlo; no reimplementar el de cero.
5. **Tablas**: en pantallas chicas pasan a scroll horizontal **contenido** (con `overflow-x-auto` sobre un
   contenedor, NO sobre `body`), o a una versión de cards si la tabla es simple. Elegí por tabla y justificá.
6. **Tipografía y espaciado**: usar los tokens de PH-01 (`--ds-*`) y los breakpoints ya definidos en el
   proyecto; no inventes un sistema de breakpoints nuevo.

## Alcance

- Repasar **todas** las vistas con datos, priorizando: `/en-vivo` (la sala), `/dashboard`, `/assets`,
  `/publish`, `/agenda`, `/pacientes`, `/review`, `/settings`, `/login`.
- Primitives compartidos: si varios módulos necesitan el mismo patrón (tabla responsive, drawer, botón
  táctil), va a un componente compartido — no una copia por módulo.
- Reutilizá los componentes de feedback de PH‑05 (`EmptyState`, `LoadingState`, `ErrorState`) y los tokens
  de PH‑01. **No reimplementar** lo que ya existe.
- `tenant_id` en toda query. RLS inviolable.

## Criterios de aceptación (TODOS obligatorios)

- **Cero scroll horizontal** en viewport de 768×1024 (tablet portrait) en las vistas del alcance.
  Medilo de verdad: si hay automated tests con jsdom/happy-dom no alcanzan para medir layout; **no
  declares verde lo que no mediste**. Si no podés medir el layout automáticamente, decilo explícitamente
  como NO VERIFICADO y describí qué habría que revisar a mano.
- Los targets táctiles principales miden ≥ 44px (verificá en el código: clases de tamaño o CSS explícito).
- El sidebar en `< lg` es drawer/overlay y no ocupa layout.
- **Tests**: al menos un test por cada primitive compartido nuevo (drawer, tabla responsive) y tests de los
  componentes tocados. Si agregás un componente, su test va con él.
- `npx tsc --noEmit` → **EXIT 0**.
- `npx vitest run` → **EXIT 0** con línea de resumen explícita (`Test Files N passed (N)` / `Tests N passed (N)`).
- `npm run build` → **EXIT 0** (sin drift de schema: debe imprimir "No schema changes, nothing to migrate").
- `git diff --check` → sin salida.
- **UTF-8 intacto**: nada de `Ã` / `Â` / `�` en lo que escribas (verificá con grep antes de commitear).

## Reglas de ejecución

- Trabajá **de forma autónoma**: no esperes aprobación ni preguntes. El bypass de permisos ya está activo.
- **Un commit por unidad lógica**, mensajes convencionales (`feat|fix|refactor|test|docs(chore): ...`),
  **paths explícitos** (nunca `git add -A`), **sin atribución de IA**.
- **NO** hagas push, NO mergees a `master`, NO deployes, NO corras migraciones contra producción.
- Si un gate falla, **no lo declares verde**: reportá el output real y qué falta.
- Si un criterio no se puede medir automáticamente, **decilo como NO VERIFICADO** — no lo adornes.

## Antes de terminar

Dejá el árbol limpio (todo commiteado) y verificá con `git status --porcelain` que no queda nada sin commitear
salvo que sea deliberadamente no commiteable (y entonces decilo explícitamente en el reporte).
