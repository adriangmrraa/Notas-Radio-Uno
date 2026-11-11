# PH-04 — Dashboard “Ahora”

## Contexto y base
- Repo: PeriodistApp (Express + TypeScript / React SPA / Drizzle + Postgres).
- Worktree/branch: `ph-04-dashboard-now`.
- Base exacta: `origin/ph-03-navigation` @ `90a23df`, que ya contiene Épica G, PH-01 design system, PH-02 landing y PH-03 navegación.
- Objetivo: construir el Dashboard “Ahora”: información de transmisión en vivo, próximas transmisiones, pendientes operativos y uso de capacidad, usando datos reales ya disponibles en backend/repositorios. Debe sentirse como una consola editorial de producción, con los tokens/densidad definidos por PH-01.

## Reglas duras
1. Trabajá únicamente en este worktree. No tocar `master`, no mergear, no desplegar.
2. No inventar métricas, precios, stock ni datos. Para estados sin datos usar UI honesta de vacío/error/loading y copy contextual.
3. Toda consulta multi-tenant debe filtrar por `tenant_id`; respetar RLS y los patrones de auth/request context existentes.
4. No exponer secretos ni variables de entorno al cliente.
5. Inspeccioná el código existente antes de decidir APIs o queries; reutilizá endpoints/repositorios si ya existen. Si falta una agregación, implementala server-side siguiendo el patrón del repo.
6. Mantené compatibilidad con las rutas y módulos de Épica G (`/assets`, `/publish`, Zernio) y la navegación PH-03.
7. No modifiques ni incluyas `PH04-BRIEF.md` en el commit. No uses `git add -A` ni `git add .`.

## Alcance de producto
- Rediseñar o crear la pantalla de dashboard inicial para priorizar el “ahora”.
- Mostrar de manera útil y basada en datos reales:
  - transmisiones activas/en vivo y señal/estado disponible;
  - próximas transmisiones/programación;
  - pendientes que requieren atención (por ejemplo alertas, renders/publicaciones/jobs, según las fuentes existentes);
  - consumo/uso disponible por plan o recursos cuando exista fuente real; si no existe, no simularlo: mostrar estado/copy que derive hacia configuración/uso real.
- Añadir accesos accionables a los módulos correspondientes, conservando diseño dark/light, responsividad y accesibilidad básica.
- Usar componentes/tokens existentes del design system; evitar una segunda estética.
- Añadir tests focalizados si el patrón del repo lo permite, especialmente para la composición/mapeo de estados.

## Proceso obligatorio
1. Revisar estructura, dashboard actual, rutas, contratos API y esquema Drizzle existentes.
2. Implementar el slice completo con separación cliente/servidor adecuada.
3. Ejecutar al menos los gates:
   - `npx tsc --noEmit`
   - tests focalizados relevantes si existen/creás tests
   - `npm run build`
   - `git diff --check`
4. Verificar caracteres UTF-8 en todo archivo UI que toques: buscar `⬦` y `�` y corregirlos si aparecen.
5. Revisar `git status --porcelain` y el diff. Commit convencional, pequeño y sin atribución IA, con paths explícitos. Excluir este brief y cualquier artefacto no relacionado.
6. Push de backup: `git push -u origin ph-04-dashboard-now`.

## Criterio de aceptación
- Dashboard “Ahora” funcional y navegable en la SPA, no una maqueta desconectada.
- Datos scoping-safe por tenant; no se agregan consultas sin `tenant_id` cuando aplique.
- Estados de ausencia/carga/error son explícitos y consistentes con el design system.
- `npx tsc --noEmit` y `npm run build` terminan con exit 0; `git diff --check` limpio.
- La rama contiene el commit y quedó pusheada a `origin/ph-04-dashboard-now`.

## Reporte final esperado
Indicar: archivos modificados, fuentes de datos reales utilizadas, SHA del commit, ref remota pusheada, salida/resumen exacto de gates y cualquier limitación honesta. No pedir aprobaciones: ejecutá end-to-end dentro de estas reglas.
