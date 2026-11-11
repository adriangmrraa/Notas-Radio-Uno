# BRIEF — PH-03 Navegación newsroom

Implementá **solo PH-03**: rediseñá sidebar/topbar y la navegación por módulos nuevos para PeriodistApp. Partís de `3ebf1ac` (PH-01+PH-02+ÉPICA G). No merge/deploy ni backend/migraciones.

## Alcance
- Inspeccioná `Layout.tsx`, `Sidebar.tsx`, `main.tsx`, rutas y feature flags/roles existentes.
- Convertí la navegación autenticada en una IA de newsroom clara y densa: Ahora/operación en vivo, producción/editorial, contenido (`/assets`), publicación (`/publish`), programación, analítica y configuración/conexiones. Debe incluir TODAS las rutas actuales, especialmente las nuevas de ÉPICA G; no ocultes funcionalidades ni enlaces por capricho.
- Conservá autorización/roles y rutas ya existentes; no inventes permisos ni rutas.
- Mejorá topbar: contexto de página/módulo y acciones de navegación útiles, respetando el toggle de tema PH-01.
- Navegación responsive/tablet aceptable sin invadir PH-07; mantené accesibilidad (labels, foco, aria).
- Usá tokens `--ds-*`; no dependencias nuevas; no rediseñes pages internas (PH-04/05 después).
- Commit conventional con paths explícitos y sin atribución IA.

## Gates
`npx tsc --noEmit`, `npm run build`, `git diff --check`, control de `⬦|�`, status y SHA. Deben dar EXIT 0. Reportá archivos, arquitectura final de navegación, gates y SHA.
