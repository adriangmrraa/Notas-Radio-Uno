# Spec: assets-unified — Modelo unificado de contenido derivado (Tanda T3)

## Propósito

Unificar `clips` y `publications` en un solo modelo `assets` con tipo (`clip|nota|flyer|quote_card|post`), estados editoriales consistentes y metadata común — una sola bandeja, un solo ciclo de vida y un solo destino de publicación.

## Actores

- Pipeline/fábrica de contenido (produce assets).
- Editor (los revisa, edita, aprueba — ver review-and-autopublish).
- Zernio/publish_jobs (los distribuye).

## Comportamiento observable

### Requirement: Modelo asset unificado con ciclo de vida editorial

El sistema MUST representar todo contenido derivado como `assets` con: type, título, contenido/copys, media refs (videoPath, imagePath, thumbnail), transmissionId?, programId?, persons mencionados/atribuidos, estado editorial `generating → ready → pending_review → approved | rejected → published | failed`, editHistory y variantes por red. Los `clips` y `publications` existentes MUST migrarse conservando estado, media e historial.

#### Scenario: Migración del catálogo existente

- GIVEN un tenant con 40 publications y 15 clips
- WHEN corre la migración
- THEN existen 55 assets (nota/clip según origen) con su estado, media y metadatos preservados; las rutas legacy leen del nuevo modelo o reciben redirect

#### Scenario: Ciclo de vida completo de un clip

- GIVEN un momento detectado en una transmisión
- WHEN el render termina
- THEN el asset `clip` está `ready`→`pending_review`; al aprobarse `approved`; al publicarse vía publish_jobs `published` con referencia al post externo

### Requirement: Bandeja única filtrable

El sistema MUST exponer una bandeja que liste TODOS los assets pendientes/listos con filtros por tipo, programa, transmisión, persona y estado — reemplazando las vistas separadas de clips y publicaciones.

#### Scenario: Cola unificada

- GIVEN 3 clips, 2 notas y 1 flyer en revisión
- WHEN el editor abre la bandeja
- THEN los ve juntos, filtra por "clips del programa del lunes" y opera en batch

### Requirement: Trazabilidad a la transmisión y personas

Cada asset MUST conservar vínculo a la transmisión (y ventana del crudo si es clip) y a las personas atribuidas/mencionadas, habilitando "todo lo generado por el programa de hoy" y "todo donde aparece Laura".

#### Scenario: Filtrar por persona

- GIVEN assets con personas atribuidas
- WHEN se filtra por Laura
- THEN aparecen clips/notas donde ella habla o es citada

## Datos involucrados (conceptual)

- `assets`: tenantId, type, status, title, content, mediaRefs jsonb, transmissionId, programId, sourceWindowMs?, quotes/citations, contentVariants, editHistory, profileVersion (editorial).
- `asset_persons`: assetId, personId, role (speaker|mentioned|cited).
- Migración desde `clips`/`publications` (estados actuales `generating`/`pending_review`/… mapeados al ciclo unificado).

## Errores y edge cases

- Asset huérfano (transmisión purgada) → conserva media propia; el vínculo queda histórico.
- Tipos con media distinta (clip=video, flyer=imagen, nota=texto) → campos de media opcionales por tipo; validación exige el mínimo por tipo.
- Clips Remotion sintéticos (QuoteClip/NewsClip legacy) → se migran como `quote_card`/tipo equivalente, distinguibles de clips reales por `source=synthetic|footage`.
- Estados inválidos en migración → se mapean al estado más cercano y se loguean.
- Dos editores modifican el mismo asset → última escritura gana con entrada en editHistory (conflicto visible).

## Trazabilidad

PF-10, PG-01, PC-01 (personas vinculadas). Depende de clip-extraction (clips reales como assets), editorial-profiles (versión aplicada), review-and-autopublish (bandeja/acciones), zernio-publishing (publish_jobs por asset).
