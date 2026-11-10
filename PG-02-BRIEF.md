# PG-02 — Edición por IA sobre assets

Implementá **sólo PG-02** sobre la rama existente `pg-01-unified-inbox`, cuyo HEAD `ef87d8a` ya contiene PG-01. Objetivo: brindar edición editorial asistida por IA sobre assets: edición de texto y solicitud de regeneración de imagen/clip, sin fake data ni proveedores inventados.

## Límites/decisiones
- Reutilizá `assets`, su estado editorial y los servicios AI/pipelines reales ya existentes. Descubrí el patrón del repo antes de tocarlo.
- `tenant_id` es obligatorio en cada consulta y mutación. Verificá que el asset pertenezca al tenant antes de cualquier acción; las referencias asociadas (publication/clip) también deben quedar tenant-scoped.
- Texto: permití una acción explícita sobre assets editables (nota/post/flyer si corresponde) que use el modelo/proveedor configurado del tenant o el servicio real existente para proponer/aplicar edición. La API debe retornar errores honestos cuando falta proveedor/configuración; no simules contenido ni credenciales.
- Imagen/clip: ofrecé solicitudes de regeneración que entren por los servicios/colas reales ya disponibles (p. ej. image registry / render jobs). Si el tipo de asset no es compatible, devolvé validación 4xx clara. No implementes generación inline falsa ni inventes URL/resultados.
- Integrá la UI de `/assets`: acciones de edición/regeneración con feedback loading/error/success, sin introducir secretos al cliente.
- No implementar Zernio/autopublicación/publicación: PG-03+.

## Calidad
- Tests focalizados de autorización tenant, validación por tipo y delegación correcta a servicios/colas (mocks o memory stores según patrones existentes).
- Nada lanza llamadas externas durante imports/tests. No dependas de env de producción.
- Corré `npx tsc --noEmit`, tests focalizados, `npm run build`, `git diff --check` con salida/exit real.
- Commit convencional con paths explícitos, sin `git add -A`/`.` y sin atribución IA. No push, no merge, no deploy.

## Entrega
Commit(s) en esta rama y reporte con SHA, rutas/UI/servicios, tests/gates y cualquier límite real de integración detectado.
