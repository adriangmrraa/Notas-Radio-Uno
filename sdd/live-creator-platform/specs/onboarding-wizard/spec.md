# Spec: onboarding-wizard — Alta guiada del canal en 4 pasos (Tanda T3)

## Propósito

Wizard post-registro que deja al canal operativo sin ayuda: (1) canal/medio, (2) primer programa + primera transmisión programada, (3) personas con fotos, (4) conexión de redes vía Zernio — cerrando con "tu próxima transmisión es {fecha}". Crítico para early adopters (aceptación: "un canal se registra, completa onboarding y programa una transmisión sin ayuda").

## Actores

- Usuario recién registrado (owner del tenant nuevo).
- Sistema (crea programa, transmisión programada, persons, enrola rostros, inicia connect Zernio).

## Comportamiento observable

### Requirement: Flujo de 4 pasos persistido y retomable

El wizard MUST guardar progreso por paso (el usuario puede salir y retomar donde quedó), marcar `onboarding_completed` en el tenant al finalizar y permitir saltar pasos opcionales (personas y redes) con aviso de qué se pierde.

#### Scenario: Alta completa sin ayuda

- GIVEN un usuario que acaba de verificar su email
- WHEN completa canal→programa(lun–vie 10:00 YouTube)→Martín con 3 fotos→conecta IG por Zernio
- THEN existen: tenant configurado, programa con su URL, transmisión programada recurrente, persona enrolada con embeddings, social_connection activa, y la pantalla final muestra "tu próxima transmisión es lunes 10:00"

#### Scenario: Sale a mitad y retoma

- GIVEN wizard abandonado en el paso 3
- WHEN el usuario vuelve a entrar
- THEN retoma en el paso 3 con lo cargado en 1 y 2 intacto

### Requirement: Paso 2 crea programación real

El paso programa MUST crear el programa con su URL/plataforma y una transmisión programada (recurrente o fecha única) con `timezone` del tenant — la misma entidad que opera el scheduler corregido.

#### Scenario: Primera transmisión queda agendada

- GIVEN paso 2 completado con "lun–vie 10:00"
- WHEN finaliza el wizard
- THEN el scheduler disparará esa transmisión en la TZ del tenant (ver scheduler-fix)

### Requirement: Paso 3 enrola personas

Las fotos cargadas en el wizard MUST pasar por la validación/enrolamiento facial (ver people-directory/face-attribution): mínimo 1 foto, recomendado 3+, con feedback inmediato si una foto no tiene rostro.

#### Scenario: Foto rechazada en onboarding

- GIVEN carga de una foto sin rostro
- WHEN el enrolamiento la procesa
- THEN el wizard muestra el motivo y pide otra foto sin bloquear el resto del alta

### Requirement: Paso 4 conecta Zernio embebido

El wizard MUST invocar el connect embebido de Zernio (welcome white-label); conectar es opcional — si se salta, la publicación queda pendiente y el producto lo recuerda en el dashboard.

#### Scenario: Termina sin redes

- GIVEN usuario que salta el paso 4
- WHEN finaliza
- THEN `onboarding_completed=true`, el dashboard muestra "conectá tus redes para publicar" y la bandeja funciona en modo revisión

## Datos involucrados (conceptual)

- `tenants.onboarding_completed` + `tenants.config.onboarding` (progreso por paso).
- Crea: `programs`, `program_urls`, `scheduled_jobs`/transmisión programada, `persons`+`person_photos`+`face_embeddings`, `social_connections`.

## Errores y edge cases

- URL de stream inválida → validación inmediata con sugerencia de formato por plataforma; no bloquea (puede editarse después) pero advierte.
- Zernio no disponible durante el paso 4 → se puede saltar y retomar desde /conexiones.
- Tenant que se registra sin completar → banner persistente "terminá tu configuración" hasta completar.
- Registro duplicado de programa → se crea un único programa default; edición posterior normal.

## Trazabilidad

PC-10, PH (UX de primer uso), criterio de aceptación #1 del cambio. Depende de: scheduler-fix (transmisión real agendada en TZ correcta), people-directory+face-attribution (enrolamiento), zernio-publishing (connect), multi-tenant-auth (tenant nuevo con membresía owner).
