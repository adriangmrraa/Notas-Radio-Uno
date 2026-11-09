# Spec: feature-flags — Flags por tenant con precedencia (Tanda T2)

## Propósito

`tenant_features` con precedencia **override tenant > plan > default**, para rollout gradual de superficie nueva a early adopters y kill-switch sin deploy. Reemplaza `plans.features` (jsonb que existe pero NUNCA se lee — verificado en código: se devuelve en /me pero nada lo evalúa).

## Actores

- Plataforma/super-admin (define defaults por plan y overrides por tenant).
- Cualquier servicio/UI que gatea comportamiento.
- Tenant (hereda flags de su plan salvo override).

## Comportamiento observable

### Requirement: Resolución con precedencia y expiración

La resolución de un flag MUST seguir: override vigente del tenant (tenant_features con `expiresAt` no vencido) → valor del plan del tenant → default de plataforma. Un override vencido MUST dejar de aplicar automáticamente.

#### Scenario: Early adopter con video habilitado

- GIVEN flag `live_video` default off, plan Media off, y override del tenant X a true por 30 días
- WHEN el tenant X resuelve `live_video`
- THEN obtiene true hasta el vencimiento; al expirar vuelve a off sin intervención

#### Scenario: Plan Network lo tiene, Creator no

- GIVEN `auto_publish` en plan Network=true, Creator=false
- WHEN ambos resuelven el flag sin override
- THEN Network ve true y Creator false

### Requirement: API de evaluación server-side y hook cliente

El sistema MUST exponer `resolveFeature(tenantId, flag)` server-side para guards de rutas/servicios, y un endpoint/hook (`useFeature`) que entregue los flags efectivos del tenant activo al cliente. La UI MUST ocultar superficie flaggeada, PERO el guard server-side es la autoridad — ocultar en UI no es enforcement.

#### Scenario: Endpoint protegido por flag

- GIVEN `live_video` off para el tenant
- WHEN llama una ruta de transmisión de video
- THEN recibe 403 con código de feature deshabilitada, aunque la UI lo hubiera mostrado

### Requirement: Superficie nueva detrás de flags

Toda capacidad nueva del cambio (video en vivo, rostros, Zernio, auto-publish, multi-modelo de imágenes, admin) MUST declararse con flag y ser desactivable por tenant sin deploy — rollback plan de la propuesta.

#### Scenario: Kill-switch de Zernio

- GIVEN un incidente con la API de Zernio
- WHEN el operador desactiva `zernio_publishing` para todos
- THEN la publicación cae a los canales legacy sin redeploy

## Datos involucrados (conceptual)

- `tenant_features`: tenantId, key, value, expiresAt, setBy (admin).
- `plans.features` (jsonb) → se reutiliza como capa de plan (ahora sí se lee).
- Catálogo de flags conocidos (registro en código/config con default).

## Errores y edge cases

- Flag desconocido → resuelve a default seguro (off para superficie nueva) + warning.
- Override con `expiresAt` pasado → ignorado (no eliminado; queda auditable).
- Cambio de plan → los flags del plan cambian, los overrides del tenant se conservan.
- Caché de flags → invalidar al escribir override (switch inmediato, no esperar TTL).

## Trazabilidad

PA-11, gap Dentalogic (feature_flags > plan > default + expires_at), rollback plan del cambio. Consumido por todas las tandas.
