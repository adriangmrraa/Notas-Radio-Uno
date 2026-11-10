# PG-01 — Bandeja unificada de assets

Implementá **sólo PG-01** de ÉPICA G sobre esta rama `pg-01-unified-inbox`, base `73b043a` (`origin/master`). Objetivo: una bandeja editorial unificada sustentada en la tabla/capa `assets` ya entregada por PF-10, con filtros combinables por tipo, programa y transmisión.

## Decisiones y límites
- Todo acceso a datos debe quedar estrictamente acotado por `tenant_id`; no aceptar ni consultar assets cross-tenant.
- Reutilizá la máquina de estados/capa `assets` existente. No dupliques entidades ni agregues datos fake.
- Descubrí y seguí los patrones reales del repo para rutas Express, hooks/API React, páginas y autorización. `optionalAuth`/viewer guard como corresponda.
- Debe haber una ruta/API de listado paginado/ordenado para la bandeja con filtros validados (tipo, `programId`, `transmissionId`; más un estado editorial si la capa existente lo expone de modo natural), y una UI accesible para aplicarlos, limpiar filtros y ver un estado vacío. Debe mostrar información editorial útil del asset y navegar/abrir el asset donde exista un patrón.
- Filtros de programa y transmisión tienen que ser del tenant; no confíes en IDs ajenos. Las consultas deben aplicar `tenant_id` directamente, aun si existen FKs.
- No toques publicación Zernio, auto-publicación ni edición IA: son PG-02+.
- No expongas secretos ni modifiques variables de entorno.

## Calidad
- Sumá tests focalizados de contrato/ruta y/o helper de query que prueben aislamiento tenant y filtros. Si cambiás schema/migración, verificá el SQL siguiendo `periodistapp-gates`; evitá una migración salvo que sea indispensable.
- Corré `npx tsc --noEmit` y `npm run build` hasta obtener exit 0. Corré los tests focalizados disponibles.
- Revisá `git diff --check` y el diff completo. No uses `git add -A` ni `git add .`; commit convencional con paths explícitos y sin atribución de IA. No push, no merge, no deploy.

## Entrega
1. Implementá completo, no dejes stubs.
2. Commit en esta rama.
3. En el reporte final indicá: SHA, archivos, rutas/API/UI incorporadas, tests/gates y cualquier decisión relevante.
