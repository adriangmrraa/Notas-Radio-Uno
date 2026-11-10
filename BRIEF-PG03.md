# PG-03 — Config de auto-publicación por tenant/programa (respeta plan)

Contexto: esta rama `pg-01-unified-inbox` ya entregó **PG-01** (bandeja unificada sobre `assets`) y **PG-02** (edición IA sobre assets: `edit-text` + `regenerate`). Implementá **sólo PG-03** de ÉPICA G (tarjeta kanban `t_ddc69173`).

## Objetivo
Configuración de **auto-publicación** por tenant y por programa, respetando el **plan del tenant** (límites de cuentas/canales/publicaciones y flags de features). Debe existir una fuente única de config (tabla o capa propia), una API para leer/actualizarla y una UI mínima para gestionarla, todo con alcance `tenant_id` estricto.

## Alcance
1. **Modelo/config**: definí la configuración de auto-publicación (qué programa/canal publica, con qué límites y condiciones). Preferí la capa/tabla existente si ya hay un lugar natural para esto; si no, creá la mínima necesaria. Evitá migración salvo que sea realmente indispensable — si la creás, seguí las convenciones de migración del repo (Drizzle + pglite en tests) y verificá el SQL.
2. **Resolución server-side del plan**: toda decisión de auto-publicación debe resolverse contra el plan/suscripción del tenant en el servidor. Si el plan no habilita la feature o excede el límite → respuesta honesta (error o estado explícito), nunca publicación silenciosa ni bypass de cuota. El bypass de "primer canal" del trial ya existe: **no lo dupliques ni lo extiendas**.
3. **API**: endpoints para leer la config del tenant y para actualizar/activar-desactivar auto-publicación. Validación de entrada (Zod o el validador que use el repo), `tenant_id` tomado del contexto de auth y **nunca del payload**. Resolver el tenant/programa/canal contra el scope del tenant antes de operar.
4. **UI**: panel o vista donde el tenant vea su config de auto-publicación y pueda activarla/desactivarla. Reusa los patrones de UI del repo (mismos hooks/API client, mismos estados de loading/error/vacío, i18n/copy en español como en PG-01/PG-02). Respetá el look&feel ya construido en `src/client/pages/AssetsInboxPage.tsx`.
5. **Tests focalizados**: cobertura de aislamiento tenant (un tenant no lee/escribe config de otro), de los límites por plan (plan que no habilita la feature → rejection explícito) y del ciclo leer/actualizar.

## Fuera de alcance
- PG-04 (integración Zernio / `social_connections`), PG-05 (`publish_jobs`), PG-06 (menciones), PG-07 (migración Meta/Twitter a legacy): **no los toques**.
- Nada de credenciales sociales: nunca veas ni persistas tokens de plataformas.
- No toques PG-01/PG-02 salvo que needing un fix puntual y lo justifiques en el reporte.

## Calidad / gates (obligatorios, en este orden)
1. `npx tsc --noEmit` → EXIT 0.
2. Tests focalizados (`npx vitest run <archivos focalizados>`) → EXIT 0, con conteo explícito de tests.
3. `npm run build` → EXIT 0.
4. `git diff --check` → EXIT 0.
5. Revisá el diff completo.

Si migrás: verificá el SQL con las convenciones del repo (pg-mem/pglite en tests) y NO apliques nada contra una base real ni contra producción.

## Límites duros
- Todo el código en **este** worktree. **Nunca** en `C:/Users/Asus/Documents/estabilizacion/periodistapp` (checkout compartido).
- **NO push, NO merge, NO deploy, NO migraciones contra prod.**
- Commit convencional con **paths explícitos** (nunca `git add -A` ni `git add .`), sin atribución de IA, sin `Co-Authored-By`.
- No expongas secretos ni edites variables de entorno.

## Entrega (reporte final)
1. SHA de los commits.
2. Archivos tocados.
3. Rutas/API/UI incorporadas.
4. Tests/gates con salida real (conteos, exit codes).
5. Decisiones relevantes y cualquier punto que quede abierto.
