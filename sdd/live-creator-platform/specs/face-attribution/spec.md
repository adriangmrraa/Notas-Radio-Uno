# Spec: face-attribution — Identificación de personas por rostro + voz (Tanda T1)

## Propósito

Resolver "quién habla" con nombre real: embeddings faciales por foto enrolada (InsightFace self-hosted, SCRFD + ArcFace) almacenados en pgvector, detección de rostros en frames sampleados del crudo, y fusión con la diarización de voz por wall-clock para atribuir speakers — con corrección manual que realimenta la sesión.

## Actores

- Pipeline de ingesta (frame sampler + face service InsightFace en el VPS de ingesta).
- Editor en sala en vivo (corrige atribuciones).
- Tenant (consentimiento implícito: solo se identifica a personas que él mismo enroló — enrolled-only).

## Comportamiento observable

### Requirement: Enrolamiento facial por foto

Al subir una foto de persona, el sistema MUST detectar el rostro y generar un embedding persistido en `face_embeddings` (pgvector). Una foto sin rostro MUST rechazarse; una foto con múltiples rostros SHOULD rechazarse pidiendo una foto más clara. Los embeddings MUST ser por tenant — jamás se matchea contra personas de otro tenant (enrolled-only).

#### Scenario: Enrolar 3 fotos de Martín

- GIVEN la persona "Martín" del tenant A
- WHEN se suben 3 fotos con su rostro visible
- THEN existen 3 embeddings asociados a Martín y la persona queda "lista" para matching

### Requirement: Detección de apariciones en el crudo

El sistema MUST samplear frames del crudo en vivo (1–2 fps configurable), detectar rostros y matchearlos por similitud coseno contra los embeddings del tenant con un umbral de confianza, produciendo `person_appearances` (personId o "desconocido", startMs/endMs wall-clock, confidence, bbox opcional).

#### Scenario: Rostro conocido aparece 4 minutos

- GIVEN un tenant con Martín enrolado y una transmisión live
- WHEN Martín está en pantalla de 00:10:00 a 00:14:00
- THEN existe un `person_appearance` para Martín en esa ventana con confianza ≥ umbral

### Requirement: Fusión speaker↔rostro por wall-clock

El sistema MUST cruzar los speaker labels de la diarización con las apariciones faciales en la misma ventana wall-clock para resolver el nombre real del speaker. Cuando un speaker label coincide consistentemente con una sola persona, MUST proponer la atribución; cuando es ambiguo (varias caras, solapamiento), MUST marcarla como candidata/de baja confianza, nunca inventarla.

#### Scenario: Speaker A = Martín

- GIVEN diarización "Speaker A" activa 00:10–00:14 y person_appearance de Martín en la misma ventana
- WHEN corre la fusión
- THEN el timeline muestra "Martín" en lugar de "Speaker A" con su confianza de atribución

### Requirement: Corrección manual que realimenta la sesión

El usuario MUST poder corregir una atribución ("esto no es Martín, es el invitado") desde la sala en vivo, y la corrección MUST aplicarse hacia adelante en la misma transmisión para ese speaker label y persistir en los segmentos ya generados.

#### Scenario: Corrección en vivo

- GIVEN Speaker B atribuido a "Invitado X" con baja confianza
- WHEN el editor lo corrige a "Laura"
- THEN las apariciones siguientes de Speaker B se atribuyen a Laura en esta transmisión y las ya emitidas quedan corregidas

### Requirement: Objetivo de calidad y degradación

El sistema SHOULD alcanzar ≥90% de atribución correcta en el piloto con ≥3 fotos por persona. MUST degradar con gracia: sin embeddings, sin InsightFace disponible o confianza baja → se conservan speaker labels genéricos y el resto del pipeline continúa.

#### Scenario: Servicio de rostros caído

- GIVEN InsightFace no responde durante una transmisión
- WHEN el pipeline corre
- THEN clips/notas se generan igual, speakers quedan genéricos, y la falta se reporta como warning (no error fatal)

## Datos involucrados (conceptual)

- `face_embeddings`: personId, tenantId, vector (pgvector), photoId origen.
- `person_appearances`: transmissionId, personId?, speakerLabel?, startMs/endMs, confidence, source (face|fusion|manual).
- Muestras de voz/voice-prints: OUT (v2).
- Consentimiento/enrolamiento: estado por persona (hereda de people-directory).

## Errores y edge cases

- Pocas fotos o mala calidad → confianza baja; el onboarding exige 3+ fotos (R-3).
- Dos personas enroladas visualmente similares → atribución candidata, requiere corrección; nunca auto-confirmada.
- Nadie enrolado → módulo en modo "sin rostros": solo diarización.
- Rostro no enrolado recurrente → se reporta como "desconocido frecuente" sugiriendo enrolarlo.
- Retención biométrica: embeddings y apariciones se eliminan al purgar la persona/tenant.

## Trazabilidad

PE-03, PC-04 (pipeline de rostros), R-3 (biometría/consentimiento). Depende de people-directory (persons+fotos), stream-recording (frames del crudo), diarización AssemblyAI existente. Consumido por live-room, clip-extraction (crop+lower-third), PF-05/PF-07 (citas con nombre+foto).
