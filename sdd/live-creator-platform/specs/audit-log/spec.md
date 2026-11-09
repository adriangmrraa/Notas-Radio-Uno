# Spec: audit-log — Auditoría de acciones sensibles (Tanda T2)

## Propósito

Extender `audit_log` (la tabla existe y hoy solo escribe `authService`: register/login/verify/reset — verificado) a TODAS las acciones sensibles de la plataforma, con un punto único de escritura y visibilidad para el tenant y el super-admin.

## Actores

- Cualquier usuario autenticado (origen de acciones auditables).
- Super-admin (acciones admin + impersonación — audiencia principal).
- Owner del tenant (puede consultar la actividad de su tenant).

## Comportamiento observable

### Requirement: Cobertura de acciones sensibles

El sistema MUST registrar en `audit_log` — vía un helper único (no inserts ad-hoc dispersos) — al menos: auth (login ok/fallido, verify, reset), membresía (invite, accept, role change, remove), billing (checkout, cancel, plan change, webhook transitions), cuota (grant admin, add-on), publicación (approve, publish, reject, auto-publish), admin (todas las acciones + impersonación inicio/fin), settings sensibles (webhooks, credenciales — sin valores, solo claves). Cada entrada MUST llevar tenantId (o null en acciones de plataforma), userId actor, action, ip, userAgent y metadata mínima suficiente.

#### Scenario: Quién publicó qué

- GIVEN un asset aprobado y publicado
- WHEN se consulta el audit del tenant
- THEN aparece `asset_approved` y `asset_published` con actor y timestamp

#### Scenario: Impersonación completa auditada

- GIVEN un operador que impersonó 12 minutos
- WHEN se revisa audit_log
- THEN hay `impersonation_started` y `impersonation_ended` + cada acción realizada durante la sesión atribuida al operador con flag `impersonated=true`

### Requirement: Escritura no bloqueante y confidencial

La escritura de audit MUST ser best-effort (nunca tumba el request principal por fallo de audit) y MUST NUNCA persistir secretos: tokens, contraseñas, credenciales ni cuerpos de webhook se registran solo como referencias/claves.

#### Scenario: Fallo de audit no rompe el flujo

- GIVEN la tabla audit_log inaccesible momentáneamente
- WHEN un usuario hace login
- THEN el login funciona y el error de audit se loguea como warning

### Requirement: Middleware de roles aplicado a rutas sensibles

Las rutas de mutación MUST aplicar `requireRole` consistente (owner > editor > viewer): un viewer MUST recibir 403 en cualquier mutación de negocio. Esto cierra PA-04.

#### Scenario: Viewer intenta publicar

- GIVEN user con membresía viewer
- WHEN llama a aprobar/publicar un asset
- THEN 403 — y queda auditado el intento como `forbidden_attempt`

## Datos involucrados (conceptual)

- `audit_log` (existente): + convención de `action` namespaced (`auth.login`, `team.invite`, `admin.impersonate`, `billing.plan_changed`, …), `impersonatedBy` opcional en metadata.
- Endpoint `GET /api/admin/tenants/:id/audit` (admin) y/o vista de actividad del tenant.

## Errores y edge cases

- Acción sin usuario (webhook, worker) → userId null + actor `system:{origen}` en metadata.
- Volumen alto → índice por tenantId+createdAt (ya existe); retención/paginación en consultas.
- Acciones de plataforma sin tenant → tenantId null permitido (schema ya lo soporta).

## Trazabilidad

PA-04, PA-05, PA-12 parcial, gap Dentalogic. Transversal: lo invocan multi-tenant-auth, team-invites, super-admin, subscription-lifecycle, zernio-publishing, review-and-autopublish.
