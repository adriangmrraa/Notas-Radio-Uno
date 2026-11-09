# Spec: live-room — Sala "En vivo" de una transmisión (Tanda T1)

## Propósito

Pantalla de monitoreo y control de una transmisión en curso: timeline en tiempo real con speakers ya resueltos a personas reales, momentos detectados, clips generándose, panel de rostros con corrección y acciones de control (mark manual, pausar/finalizar).

## Actores

- Owner/editor del tenant (opera la sala; usable en tablet — PH-07).
- Sistema (emite eventos Socket.IO por transmisión al room del tenant).

## Comportamiento observable

### Requirement: Timeline en vivo con identidad resuelta

La sala MUST mostrar la transcripción en tiempo real con nombres reales cuando la atribución existe ("Martín:", no "Speaker A"), los momentos detectados marcados con score/razón y las alertas de keywords. MUST actualizarse vía Socket.IO sin recarga.

#### Scenario: Editor mira el vivo

- GIVEN una transmisión `live` con atribución funcionando
- WHEN el editor abre `/en-vivo/{id}`
- THEN ve el timeline avanzando con "Martín:" / "Laura:", momentos marcados y alertas, actualizándose en vivo

### Requirement: Clips generándose en tiempo real

La sala MUST mostrar cards de clips a medida que se detectan momentos → se encolan → se renderizan → quedan listos, con su estado visible.

#### Scenario: Clip aparece solo

- GIVEN un momento clipable detectado
- WHEN el render termina
- THEN la card del clip pasa de "procesando" a "listo" en la sala sin intervención

### Requirement: Panel de personas detectadas con corrección

La sala MUST listar rostros/personas detectadas con su confianza y MUST permitir corregir la atribución (ver face-attribution), reflejando el cambio de inmediato en el timeline.

#### Scenario: Corrijo desde la sala

- GIVEN "Speaker B → Invitado X" con confianza baja
- WHEN el editor lo reasigna a "Laura"
- THEN el timeline re-etiqueta sus intervenciones a "Laura"

### Requirement: Mark manual y control de transmisión

El usuario MUST poder disparar "generar clip ahora" (marca una ventana hacia atrás de N segundos configurables), "generar nota de este bloque", y pausar/finalizar la transmisión. Estas acciones MUST estar disponibles también para transmisiones iniciadas por scheduler.

#### Scenario: Mark manual durante un momento viral

- GIVEN algo clipable que el análisis no marcó
- WHEN el editor pulsa "clip ahora"
- THEN se encola un clip sobre los últimos N segundos del crudo

### Requirement: Estados de la transmisión visibles

La sala MUST reflejar el estado (`waiting`, `live`, `processing`, `done`, `error`) con UI acorde: banner de espera mientras no hay señal, indicador de caída/reintento ante cortes, y resumen al finalizar.

#### Scenario: Stream se cae 2 minutos

- GIVEN una transmisión live
- WHEN la captura entra en reintento
- THEN la sala muestra "señal caída — reintentando" y recupera el timeline al volver, marcando el gap

## Datos involucrados (conceptual)

- `transmissions` (estado, wall-clock), `transmission_segments` (tema, resumen, speakers, ventana), `person_appearances`, eventos Socket.IO por transmisión en room `tenant:{id}`.
- Assets tipo clip con estado de render (clip-extraction).

## Errores y edge cases

- Usuario abre la sala de una transmisión `done` → modo replay/lectura con crudo disponible (según retención).
- Múltiples usuarios del tenant en la sala → ambos ven los mismos eventos; correcciones se propagan.
- Transmisión de OTRO tenant → 404/forbidden vía guard de tenant activo.
- Sin atribución disponible → timeline con speaker labels genéricos (degradado, no error).
- Navegación durante captura → reconexión del socket rehidrata estado desde el último segmento.

## Trazabilidad

PD-04, PD-05, PE-07 (alertas sobre nueva transcripción), PH-07 (tablet). Depende de stream-recording (estados/crudo), face-attribution (nombres), clip-extraction (cards), multi-tenant-auth (room por tenant activo).
