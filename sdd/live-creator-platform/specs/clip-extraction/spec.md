# Spec: clip-extraction — Clips reales cortados del crudo (Tanda T1)

## Propósito

Producir clips verticales 9:16 cortados del video crudo real de la transmisión (no clips sintéticos Remotion sobre audio como hoy), con re-encuadre, subtítulos quemados y branding del tenant, encolados como jobs con estados y re-corte manual.

## Actores

- Motor de análisis (detecta momento clipable con ventana sugerida) y usuario en sala en vivo (mark manual).
- Clip-cutter/render queue (trabajos sobre el crudo).
- Editor/owner del tenant (re-corte, aprobación posterior en bandeja).

## Comportamiento observable

### Requirement: Corte del crudo por ventana temporal

El sistema MUST generar un clip cortando la ventana `[startMs, endMs]` sobre los `recording_segments` del crudo con ffmpeg (`-ss`/`-t`), con precisión suficiente para que el clip arranque/termine en el momento detectado. Si la ventana abarca varios segmentos, el sistema MUST concatenarlos transparentemente.

#### Scenario: Momento detectado se convierte en clip del crudo

- GIVEN una transmisión `live` con crudo grabándose y un momento clipable detectado en 00:42:10–00:43:05
- WHEN el clip-cutter procesa la ventana
- THEN existe un asset clip cuyo video proviene del footage real de ese rango (no sintético), disponible para render 9:16

### Requirement: Re-encuadre a 9:16 con composición por persona

El sistema MUST re-encuadrar el corte a vertical 9:16. SHOULD centrar el crop en el rostro de la persona activa cuando hay atribución disponible; MUST caer a crop centrado como fallback determinístico si no hay información de rostros. MAY soportar layout split cuando dos personas hablan en simultáneo.

#### Scenario: Clip centrado en quien habla

- GIVEN un corte 16:9 donde la persona atribuida ocupa el tercio izquierdo
- WHEN se genera el 9:16
- THEN el crop sigue a esa persona; sin datos de rostro, el crop es centrado

### Requirement: Subtítulos y branding del tenant

El sistema MUST quemar subtítulos del tramo (transcripción con speaker resuelto) con el estilo tipográfico del tenant, y MUST aplicar overlay de marca: logo y lower-third con el nombre real de la persona cuando está atribuida. El overlay MAY implementarse vía composición Remotion sobre el footage.

#### Scenario: Clip con identidad del canal y del speaker

- GIVEN un clip con speaker resuelto a "Martín" y branding del tenant configurado
- WHEN termina el render
- THEN el MP4 final lleva subtítulos con la tipografía del tenant, logo, y lower-third "Martín" en su primera aparición

### Requirement: Cola de render con estados por clip y límite por plan

Cada clip MUST ser un job en la cola con estados `queued → rendering → ready | error` y reintento. El sistema MUST respetar `maxClipsPerTransmission` del plan: los momentos excedentes quedan registrados pero no renderizados salvo acción manual.

#### Scenario: Render falla y se reintenta

- GIVEN un render que aborta por ffmpeg
- WHEN el job reintenta
- THEN el clip vuelve a `queued`/`rendering` sin duplicar assets; tras N intentos queda `error` con causa visible

### Requirement: Re-corte manual

El usuario MUST poder ajustar inicio/fin sobre el segmento crudo y re-renderizar el clip conservando subtítulos/branding.

#### Scenario: Editor ajusta el clip

- GIVEN un clip `ready` de 55 s
- WHEN el editor mueve el inicio a +4 s y re-renderiza
- THEN se produce una nueva versión del clip recortada, sin alterar el crudo ni perder la versión previa

## Datos involucrados (conceptual)

- `assets`/`clips` tipo `clip`: transmissionId, sourceStartMs/EndMs sobre el crudo, variantes de render (videoPath, subtitlesPath, thumbnail), personas atribuidas, estado editorial (hereda ciclo de assets).
- `jobs_queue` (o cola equivalente): job de render con payload de ventana + opciones de reframe.
- `plans.maxClipsPerTransmission`.
- Branding del tenant (logo, fontFamily, templateId — ya existe).

## Errores y edge cases

- Ventana solicitada excede lo grabado (momento aún no finalizó) → se espera/clampa al crudo disponible.
- Segmento purgado → re-corte/re-render imposible: error explícito "crudo expirado por retención".
- Crudo con gap de captura dentro de la ventana → el clip salta el gap y lo marca, o se rechaza si el gap supera X s.
- Sin pista de audio en el tramo → clip se genera con video solamente, subtítulos omitidos.
- Plan sin reframe inteligente → crop centrado (feature flag, no error).

## Trazabilidad

PF-01, PF-02, PF-03, PF-04, PF-05. Depende de stream-recording (crudo), face-attribution (crop por rostro + lower-third), jobs queue (T3/go-live-ops). Los clips Remotion sintéticos actuales (QuoteClip/NewsClip) quedan como formato de asset distinto, no reemplazo.
