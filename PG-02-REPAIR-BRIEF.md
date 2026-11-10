# REPAIR PG-02 — cierres de calidad sobre `bced945` + `9551d3d`

Rama actual: `pg-01-unified-inbox` (tip `9551d3d`). PG-01 ya está cerrado en `ef87d8a`; **no toques ni reviertas PG-01**.

El revisor encontró 3 huecos en PG-02. Corregilos y verificá. Nada de esto es alcance nuevo: es terminar lo que PG-02 promete ("edición por IA sobre assets: texto y regeneración de imagen/clip").

## R1 — La edición de texto NO llega al usuario ni al asset (CRÍTICO)
Hoy `POST /api/assets/:id/edit-text` devuelve `{proposal, provider}` y el cliente hace `result.jobId ? ... : 'AI action completed.'`: **el texto editado se descarta**, no se ve ni se guarda. Eso no es "edición por IA sobre assets".

Required:
- El endpoint debe devolver el texto editado de forma explícita (`{ proposal, provider }` está bien) **y** el cliente debe mostrarlo (no un string genérico) — por ejemplo en un `<textarea>`/área de texto editable o en un panel de propuesta visible, con la instrucción del usuario y un botón para **aplicar** la edición.
- Aplicar la edición debe **persistir** el texto en el asset (`assets.payload.content` para `note`, `assets.payload.copy` para `post`) mediante el store/upsert ya existente, **write-through** a la fila fuente (`publications.content` vía `updatePublicationContent(id, tenantId, {content})` de `databaseService`), con `tenant_id` en cada query. Sólo `note`/`post` con `source_table='publications'`.
- El apply debe ser tenant-safe: asset ajeno ⇒ 404; `ref_id` debe casar con la publicación del mismo tenant.
- Si no hay proveedor de IA configurado, el error honesto 503 ya está: mantenelo (no simules texto).

Revisá el store de assets: si hace falta un método nuevo para actualizar `payload` de un asset (no sólo `upsertAsset` completo), agregalo con el mismo patrón `AssetStore` + memory store de tests (`tests/helpers/memoryAssetsStore.ts`) — nada de Drizzle directo en la ruta.

## R2 — La UI quedó en inglés y el resto de la app está en español (CONSISTENCIA)
`AssetsInboxPage.tsx` quedó con labels en inglés ("Asset inbox", "Clear filters", "Type", "Status", "Program", "Transmission", "All", "Previous", "Next", "Open asset", "Edit with AI", "Regenerate"). El resto del cliente es español y PG-01 ya estaba en español ("Bandeja de assets", "Limpiar filtros", "Todos", "No hay assets para estos filtros", "Anterior", "Siguiente", "Abrir asset"). **Volvé toda la UI a español** (incluidos los botones nuevos de IA: p. ej. "Editar con IA", "Regenerar", "Aplicar edición", "Procesando…"), conservando la funcionalidad nueva.

## R3 — La regeneración de clip manda un `prompt` que el worker ignora (HONESTIDAD)
`POST /:id/regenerate` encola `kind: 'reframe'` con `{clipId, assetId, prompt}`. El worker (`clipRenderWorker.ts`) para `kind:'reframe'` llama `reframeClip({tenantId, clipId})` y **descarta el prompt**: la UI promete "regenerar" y en realidad reencuadra. No es una mentira permitida en este repo.
- Reemplazá el uso de `kind:'reframe'` por el kind que **sí** representa la operación disponible (el worker sólo conoce `cut`, `reframe`, `subtitles`): usá el kind correcto según lo que realmente se va a ejecutar y **documentalo** en un comentario del código + en el reporte final. Si la operación real no es "regenerar con prompt" sino "reprocesar el clip", decilo así en el mensaje de la UI y en el nombre del campo (`instruction` en lugar de `prompt` si aplica), sin prometer edición por prompt que no ocurre.
- Para `flyer` (imagen): `generateImage` escribe el archivo y devuelve `{path, model}` — pero el asset **no se actualiza** con el path nuevo. Actualizá `assets.payload.flyerPath` con el path generado (mismo mecanismo de update de payload de R1) para que la regenerated image quede referenciada por el asset.
- Nunca inventes una URL pública ni un resultado: si `generateImage` falla, propagá el error real.

## Reglas
- `tenant_id` en toda query/mutación. Nada cross-tenant.
- Nada de llamadas a proveedores externos en tests/imports: seguí el patrón de deps inyectables ya usado (`assetsAiRouteDeps`).
- Tests focalizados nuevos que cubran, como mínimo: (a) apply de la edición persiste payload del asset + write-through a la publicación, (b) asset de otro tenant ⇒ 404, (c) el kind del job de clip es el que corresponde y el worker lo puede despachar, (d) flyer regenerado actualiza `payload.flyerPath`.
- Gates: `npx tsc --noEmit` EXIT 0, tests focalizados verdes, `npm run build` EXIT 0, `git diff --check` EXIT 0. Mostrá la salida real.
- Commit convencional con paths explícitos. **No** incluyas `BRIEF.md`, `PG-02-BRIEF.md` ni `remotion/package-lock.json` en commits. Sin push, sin merge, sin deploy.

## Entrega
Reportá: SHA de los commits, archivos, qué cambió en cada punto (R1/R2/R3), salida de los gates y cualquier límite real que quede.
