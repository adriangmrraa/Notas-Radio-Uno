# Spec: editorial-profiles — Línea editorial por tenant y programa (Tanda T1)

## Propósito

Formalizar la línea editorial del canal como entidad versionada — tono, reglas de estilo, rubro, formatos activos, política de aprobación — aplicable por tenant con override por programa e inyectada en un único punto de construcción de prompts.

## Actores

- Owner/editor del tenant (define y edita el perfil).
- Motor de generación (notas, copies, momentos, variantes — consume el perfil).
- Programa (puede sobreescribir el perfil del tenant).

## Comportamiento observable

### Requirement: Perfil editorial por tenant

El sistema MUST mantener un `editorial_profile` por tenant con: tono (formal/informal/humor/duro/fan + ejemplos de titulares few-shot), reglas jsonb (léxico, palabras prohibidas, encuadre, "nunca titular con apellidos", "siempre nombre del programa"), rubro (streaming-entretenimiento/noticias/deportes/política), audiencia, formatos activos por tipo y red, y política de aprobación (revisión obligatoria vs auto-publicación).

#### Scenario: Tenant de deportes configura su línea

- GIVEN un tenant con rubro deportes
- WHEN define tono "fan", prohíbe "derrota histórica" y exige mencionar el programa
- THEN el perfil queda persistido y versionado, y todo contenido nuevo respeta esas reglas

### Requirement: Override por programa

Un programa MUST poder sobreescribir campos del perfil del tenant (merge por campo, no reemplazo total); lo no definido hereda del tenant.

#### Scenario: Programa político dentro de un canal de entretenimiento

- GIVEN tenant con tono "humor" y programa "Mesa Política" con override tono "duro" + regla extra
- WHEN se genera contenido para ese programa
- THEN los prompts usan tono duro + reglas del tenant + regla extra del programa

### Requirement: Inyección en un único choke-point

Todo prompt de generación (notas, copies por red, detección de momentos, títulos, variantes) MUST construirse en un único prompt-builder que recibe el perfil editorial efectivo (programa→tenant→default) más el contexto de personas/programa. Ningún servicio MAY armar prompts con tono/reglas por su cuenta.

#### Scenario: Generación de nota usa la línea

- GIVEN perfil con palabras prohibidas y ejemplos few-shot
- WHEN el pipeline redacta una nota
- THEN el prompt incluye tono, reglas y ejemplos; el resultado no contiene palabras prohibidas

### Requirement: Versionado para auditoría

Cada cambio del perfil MUST crear una nueva versión con timestamp y autor; los assets generados SHOULD registrar qué versión del perfil se aplicó.

#### Scenario: Auditoría de por qué salió un titular

- GIVEN una nota cuestionada
- WHEN se inspecciona el asset
- THEN se ve la versión del editorial_profile vigente al generarla

## Datos involucrados (conceptual)

- `editorial_profiles`: tenantId (único por tenant) — campos anteriores + version + updatedBy.
- `programs.editorialOverrides` (jsonb) o perfil hijo por programa.
- Política de aprobación alimenta review-and-autopublish (T3).

## Errores y edge cases

- Tenant sin perfil → default de plataforma (tono neutro, revisión obligatoria).
- Reglas contradictorias programa↔tenant → prevalece el campo del programa (documentado).
- Perfil inválido (jsonb malformado) → validación rechaza con mensajes por campo.
- Formatos activos vacíos → el pipeline genera solo el set mínimo (clip+nota) o nada, según config.

## Trazabilidad

PC-05, PC-06. Consume people-directory (contexto), alimenta clip-extraction (copies), assets (notas/flyers), review-and-autopublish (política).
