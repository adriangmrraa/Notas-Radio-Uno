# Spec: review-and-autopublish — Bandeja unificada, edición por IA y auto-publicación (Tanda T3)

## Propósito

Elevar el Copiloto Editorial actual (`/api/review` sobre publications) a una bandeja única sobre `assets` con edición en lenguaje natural y política de aprobación por tenant/programa: revisión obligatoria (default) o auto-publicación apenas el asset queda listo.

## Actores

- Editor/owner (revisa, edita, aprueba en batch).
- Sistema (auto-publica según política, encola publish_jobs).
- IA de edición (reescritura de texto, regeneración de imagen/clip).

## Comportamiento observable

### Requirement: Bandeja unificada con acciones editoriales

La bandeja MUST listar assets en `pending_review` (todos los tipos) con acciones: aprobar, rechazar, editar contenido, regenerar media, aprobar en batch. Aprobar MUST transicionar a `approved` y encolar publish_jobs hacia las conexiones configuradas del programa/tenant.

#### Scenario: Aprobación en batch

- GIVEN 6 assets en revisión del programa de hoy
- WHEN el editor selecciona 5 y aprueba
- THEN pasan a `approved`, se encolan sus publish_jobs y 1 queda pendiente

### Requirement: Edición por IA en lenguaje natural

El usuario MUST poder editar un asset con instrucciones libres ("más corto", "titular más agresivo", "regenerá el flyer con otro fondo"): texto se reescribe manteniendo línea editorial; media se regenera con el registry correspondiente; todo cambio entra a `editHistory`.

#### Scenario: "Hacelo más corto"

- GIVEN una nota de 400 palabras en revisión
- WHEN el editor pide "más corta y citá a Martín"
- THEN el texto se regenera aplicando el editorial_profile, Martín queda citado, y el editHistory registra la instrucción

### Requirement: Política de aprobación por tenant/programa

El sistema MUST respetar la política del editorial_profile efectivo (ver editorial-profiles) + gating del plan: `review` (todo pasa por bandeja, default) o `auto` (los assets `ready` se aprueban y publican solos, la bandeja queda como registro). Auto-publicación MUST estar deshabilitada para planes que no la incluyen (ver tabla de límites: Creator no, Media+ sí).

#### Scenario: Auto-publish en plan Media

- GIVEN tenant Media con política `auto` en un programa
- WHEN un clip queda `ready`
- THEN se marca `approved` automáticamente, se publica vía publish_jobs, y aparece en la bandeja con badge "auto-publicado"

#### Scenario: Plan sin auto-publish

- GIVEN tenant Creator con política `auto` configurada
- WHEN un asset queda listo
- THEN va a la bandeja igual (el plan manda sobre la preferencia) y la UI indica que auto-publish requiere upgrade

### Requirement: Rechazo y regeneración

Rechazar un asset MUST llevarlo a `rejected` con motivo opcional; el rechazo SHOULD poder pedir regeneración (nueva variante reemplazando la anterior en la cola).

#### Scenario: Rechazo con regeneración

- GIVEN un flyer feo
- WHEN el editor lo rechaza pidiendo regenerar con otro fondo
- THEN nace una nueva versión en `generating` y la anterior queda `rejected` en historial

## Datos involucrados (conceptual)

- `assets` + `editHistory` (ver assets-unified), `editorial_profiles.approvalPolicy`, publish_jobs (trigger), `audit_log` (approve/reject/publish auditados).

## Errores y edge cases

- Asset aprobado sin conexiones destino → queda `approved` con aviso "sin redes conectadas" (no error); publica cuando exista conexión.
- Publish_job falla tras aprobación → asset muestra estado de entrega `failed` por conexión, reintentable sin re-aprobar.
- Auto-publish con Zernio caído → assets quedan `approved`+jobs `queued`, nunca se pierden.
- Edición IA que viola reglas editoriales → el prompt-builder aplica el perfil; el resultado no incumple reglas declaradas.

## Trazabilidad

PG-01, PG-02, PG-03, PF-09 (variantes por red heredan aquí), PH-04 (badge de pendientes en dashboard "Ahora"). Depende de assets-unified, editorial-profiles, zernio-publishing, usage-quota/plan gating, audit-log.
