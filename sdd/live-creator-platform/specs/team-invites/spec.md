# Spec: team-invites — Invitaciones de equipo por email (Tanda T2)

## Propósito

Dar uso real a `team_invitations` (tabla existe con token/status/expiresAt pero CERO rutas — verificado): flujo invitar→email con token→aceptación que crea membresía en el tenant, más módulo Equipo para gestionar usuarios, roles e invitaciones pendientes.

## Actores

- Owner del tenant (invita, cambia roles, revoca).
- Invitado (recibe email, acepta, define contraseña si es cuenta nueva).
- Miembro del equipo (ve el roster según rol).

## Comportamiento observable

### Requirement: Invitar por email con rol

`POST /api/team/invitations` MUST crear una invitación con email normalizado, rol (editor/viewer; solo owner puede invitar owners), token único y expiración (p.ej. 7 días), y enviar el email con el link de aceptación. MUST respetar `plans.maxTeamMembers` (miembros activos + invitaciones pendientes cuentan contra el límite).

#### Scenario: Owner invita a un editor

- GIVEN un tenant con plan que permite 5 miembros y 2 actuales
- WHEN el owner invita a pepe@x.com como editor
- THEN se crea la invitación `pending`, se envía el email con link `/accept-invite?token=…` y el conteo del plan refleja 3/5

#### Scenario: Límite de equipo alcanzado

- GIVEN plan con maxTeamMembers=1
- WHEN el owner intenta invitar
- THEN recibe 403 con código de límite y oferta de upgrade

### Requirement: Aceptación crea membresía

El endpoint de aceptación MUST: validar token `pending` y no expirado; si el email ya tiene usuario, crear la membresía en el tenant con el rol invitado (el usuario se verifica si no lo estaba); si no existe, crear cuenta (nombre + contraseña en pantalla de aceptación) y su membresía. La invitación pasa a `accepted`. El invitado NUNCA elige su rol — lo define quien invita.

#### Scenario: Invitado nuevo acepta

- GIVEN invitación válida para nuevo@x.com como viewer
- WHEN completa nombre y contraseña en el link
- THEN existe el usuario verificado + membresía viewer en el tenant, y puede hacer login

#### Scenario: Invitado con cuenta existente

- GIVEN invitación para ana@x.com que ya es owner de otro tenant
- WHEN acepta
- THEN se crea su membresía con el rol invitado en el nuevo tenant (multi-tenant-auth), sin tocar su cuenta

### Requirement: Gestión de invitaciones y miembros

El módulo Equipo MUST listar miembros (con rol) e invitaciones pendientes; owner MUST poder reenviar (nuevo token/misma o renovada expiración), revocar (status `revoked`), y cambiar rol de miembros. Un miembro no puede quitarse el último owner del tenant.

#### Scenario: Revocar invitación pendiente

- GIVEN invitación `pending` para pepe@x.com
- WHEN el owner la revoca
- THEN el token deja de funcionar (status `revoked`) y el link muestra "invitación inválida"

#### Scenario: Cambiar rol editor→viewer

- GIVEN miembro editor
- WHEN el owner lo cambia a viewer
- THEN su rol efectivo en el tenant pasa a viewer en su próximo request/token

## Datos involucrados (conceptual)

- `team_invitations` (existente): email, role, token, status, expiresAt, invitedBy.
- `user_tenants` (membresía creada al aceptar — ver multi-tenant-auth).
- `plans.maxTeamMembers`.

## Errores y edge cases

- Token expirado → status `expired` (o validación), pantalla pide reenvío.
- Invitar email ya miembro del tenant → 409 "ya es miembro".
- Invitar email con invitación `pending` vigente → reenvía o 409 configurable, nunca duplica tokens activos.
- Email mal escrito → la invitación queda pendiente y revocable; no hay leak de datos (aceptación requiere el token).
- Último owner: no se puede degradar ni remover → 409.
- Rate limit en endpoints de invite/accept (misma política que auth).

## Trazabilidad

PA-02, PA-03. Depende de multi-tenant-auth (`user_tenants`) y audit-log (acciones sensibles registradas).
