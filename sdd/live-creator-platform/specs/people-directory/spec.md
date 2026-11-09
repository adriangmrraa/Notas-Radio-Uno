# Spec: people-directory — Biblioteca unificada de personas (Tanda T1)

## Propósito

Unificar `conductors` y `guests` en un solo módulo **Personas** por tenant: ficha con fotos múltiples, rol, bio, redes sociales, notas de contexto y relación muchos-a-muchos con programas — fuente única de "quién es quién" para atribución, menciones y contexto editorial.

## Actores

- Owner/editor del tenant (CRUD, carga de fotos, notas).
- Pipeline de rostros (consume fotos para embeddings — ver face-attribution).
- Publicador (usa handles de `socials` para menciones — T3).

## Comportamiento observable

### Requirement: Modelo unificado de persona

El sistema MUST exponer una entidad `persons` por tenant con: nombre, rol (conductor/columnista/invitado/producción), bio, fotos múltiples (mínimo 1, recomendado 3+ ángulos), redes sociales (X, Instagram, TikTok, YouTube, LinkedIn), notas de contexto libre, y programas asociados (M2M). Los conductores e invitados existentes MUST migrarse a `persons` conservando fotos, rol y vínculo a programas.

#### Scenario: Migración de conductores e invitados existentes

- GIVEN un tenant con 4 conductors y 6 guests (con fotos y programas)
- WHEN corre la migración
- THEN existen 10 persons con sus fotos, rol preservado (conductor/invitado) y asociación a sus programas; los invitados puntuales conservan su fecha/transmisión asociada

#### Scenario: Crear persona con ficha completa

- GIVEN un editor en /personas
- WHEN crea "Martín" con rol conductor, 3 fotos, @martin en X/IG y nota "habla de fútbol"
- THEN la persona queda listada con sus fotos, redes y nota, y aparece asignable a programas

### Requirement: Invitados puntuales vinculados a transmisión

El sistema MUST permitir asociar una persona a una transmisión concreta (invitado del día) además de la membresía por programa, y MUST conservar el dossier automático existente (bio, actividad reciente, controversias, preguntas sugeridas) enriquecido con las redes declaradas.

#### Scenario: Invitado del jueves

- GIVEN la transmisión programada del jueves
- WHEN el editor asigna a "Laura" como invitada de esa fecha
- THEN la transmisión muestra a Laura como invitada puntual con su dossier generado

### Requirement: Límite de biblioteca por plan

El sistema MUST enforzar `plans.maxPersons` al crear personas (no afecta a invitados puntuales ya registrados ni a migraciones).

#### Scenario: Plan Creator lleno

- GIVEN un tenant Creator con 10 persons
- WHEN intenta crear la 11.ª
- THEN recibe 403 con código de límite y oferta de upgrade

### Requirement: Validación de fotos para enrolamiento

Cada foto cargada MUST pasar por detección facial: una foto sin rostro detectable MUST ser rechazada con mensaje claro; la persona MAY existir sin embeddings completos pero el sistema MUST indicar su estado de enrolamiento (sin rostro / parcial / listo).

#### Scenario: Foto sin cara

- GIVEN una foto de un logo subida como foto de persona
- WHEN el sistema la analiza
- THEN la foto se rechaza con "no se detectó un rostro" y la persona queda en estado de enrolamiento pendiente

## Datos involucrados (conceptual)

- `persons`: tenantId, name, role, bio, socials jsonb, notes, isActive.
- `person_photos`: personId, imagen (storage/bytea), isPrimary, estado de enrolamiento.
- `person_program` (M2M) y `person_transmission` (invitado puntual con fecha).
- `face_embeddings` — referenciado aquí, especificado en face-attribution.
- `plans.maxPersons`; `guest_dossiers` existente enlazado a persons.

## Errores y edge cases

- Persona duplicada por nombre → advertencia/merge manual, no rechazo silencioso.
- Eliminar persona con apariciones históricas → soft-delete; `person_appearances` y assets conservan la atribución.
- Rol editable: un invitado recurrente puede promoverse a conductor sin perder historial.
- Tenant sin personas registradas → atribución degrada a speaker labels genéricos (ver face-attribution), nunca bloquea el pipeline.

## Trazabilidad

PC-01, PC-02, PC-03, PC-04 (validación de fotos), PC-09 (dossier). Alimenta face-attribution (embeddings), clip-extraction (lower-third), editorial (contexto), zernio-publishing (menciones).
