# Spec: stream-recording — Captura y grabación del crudo de video (Tanda T1)

## Propósito

Grabar el video crudo (no solo audio) de un stream en vivo mientras dura la transmisión, segmentado en MP4 sobre storage, con timeline anclado a wall-clock, retención por plan, reanudación ante cortes y fallback de upload de VOD. **Decisión vinculante B-1**: YouTube es fuente garantizada desde T1 — la ingesta corre en VPS propio/proxies dedicados, no en Render.

## Actores

- Scheduler / usuario que inicia una transmisión (manual, programada o por upload).
- Servicio de ingesta (stream recorder) ejecutando en el VPS de ingesta.
- Tenant (su plan define `retentionDays` del crudo).
- Job de purga.

## Comportamiento observable

### Requirement: Captura de video en vivo segmentada

El sistema MUST resolver la URL del live una única vez (yt-dlp) y grabar el stream resultante con `ffmpeg -c copy -f segment` a archivos MP4 consecutivos en storage del tenant, sin re-encode del crudo. MUST anotar cada segmento con su ventana wall-clock absoluta (startMs/endMs relativos al inicio de la transmisión) para poder alinearlo con utterances de diarización y detecciones de rostros.

#### Scenario: Transmisión en vivo graba crudo segmentado

- GIVEN una transmisión en estado `live` con streamUrl resuelta
- WHEN el recorder corre durante 65 minutos
- THEN existe un `stream_recording` con N `recording_segments` MP4 consecutivos, cada uno con su rango wall-clock, y el crudo es reproducible de punta a punta

#### Scenario: Stream corta y retoma (reanudación)

- GIVEN una grabación en curso
- WHEN el stream se cae 3 minutos y vuelve
- THEN el recorder reintenta la captura, retoma en un nuevo segmento, y los segmentos previos quedan intactos con un gap wall-clock registrado (no se pierde crudo ya grabado)

### Requirement: Fallback de upload de VOD

El sistema MUST permitir cargar un archivo de video ya emitido (VOD) como `crudo_ref` de una transmisión creada para procesamiento post-stream, tratándolo como una transmisión válida para todo el pipeline downstream (clips, rostros, análisis). El upload MAY provenir de una URL de VOD descargable o de subida directa de archivo.

#### Scenario: Early adopter sube el VOD de su programa

- GIVEN un tenant sin captura en vivo posible (p.ej. live ya terminado)
- WHEN sube el MP4 del programa como VOD
- THEN se crea una transmisión con `source=vod_upload`, el crudo queda segmentado/registrado y el pipeline produce clips y assets como si hubiera sido en vivo

### Requirement: Ciclo de vida de la transmisión con estados observables

El sistema MUST mantener estados `scheduled → waiting → live → processing → done | error | canceled` en `transmissions`, emitir eventos Socket.IO al room del tenant en cada transición y registrar `source` (`live_capture` | `vod_upload`) y `crudo_ref` cuando exista grabación.

#### Scenario: Stream que arranca tarde

- GIVEN una transmisión programada que dispara a las 10:00
- WHEN el live no está al aire
- THEN la transmisión queda en `waiting`, reintenta detección durante la ventana de espera (default 30 min, configurable), y pasa a `live` al detectar — o a `error` al agotar la ventana, emitiendo el evento correspondiente

### Requirement: Retención del crudo por plan y purga

El sistema MUST conservar el crudo durante `plans.retentionDays` días desde el fin de la transmisión y eliminarlo luego vía job de purga. La purga MUST remover archivos de storage y marcar `recording_segments` como purgados sin borrar metadatos ni assets derivados.

#### Scenario: Crudo expirado se purga, clips sobreviven

- GIVEN un plan Media (retención 30 días) y una transmisión finalizada hace 31 días
- WHEN corre el job de purga
- THEN los archivos del crudo se eliminan del storage y los clips/assets generados siguen disponibles

## Datos involucrados (conceptual)

- `transmissions`: tenantId, programId?, scheduledJobId?, source, status, streamUrl, crudoRef, startedAt/endedAt wall-clock, error info.
- `stream_recordings`: transmissionId, storageRef raíz, estado, bytes totales.
- `recording_segments`: recordingId, sequence, startMs/endMs (offset wall-clock), fileRef, bytes, estado (active/purged).
- `plans.retentionDays` (nuevo campo del plan).

## Errores y edge cases

- Resolución yt-dlp falla o live no existe → `waiting`→`error` con mensaje; no consume cuota si nunca capturó (ver usage-quota).
- Storage lleno / fallo de escritura → segmento marcado corrupto, recorder reintenta en nuevo segmento; transmisión a `error` si persiste.
- `MAX_CONCURRENT` de capturas alcanzado → transmisión queda encolada/`waiting`, nunca se descarta silenciosamente.
- VOD upload corrupto o sin pista de video → rechazo con mensaje claro.
- Purga de un crudo aún referenciado por render de clip pendiente → el render completa primero o se marca `error` con reintento disponible.

## Trazabilidad

PD-01, PD-02, PD-07, PD-04 (estados/eventos), PI-04 (reanudación), PI-05 (retención/purga), PB-01 (`retentionDays`). Riesgo R-1 resuelto por B-1 (VPS/proxies + fallback VOD).
