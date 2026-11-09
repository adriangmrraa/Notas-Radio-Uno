# Spec: multi-tenant-auth — Un usuario, N tenants, tenant activo (Tanda T2 — NEW + MODIFIED: `auth`)

## Propósito

**Decisión vinculante B-2**: un usuario puede pertenecer a varios tenants desde v1 (multi-marca). Se introduce `user_tenants` (membresía con rol por tenant), un tenant activo en sesión/JWT, switcher en UI, y todos los guards operan sobre el tenant activo. Reemplaza el FK único `users.tenantId` actual. SPEC-03 queda como referencia histórica — está escrita contra Prisma y el ORM real es Drizzle; no cubre membresía N:N.

## Actores

- Usuario con una o varias membresías.
- Owner que invita gente a SU tenant (el rol vive en la membresía, no en el usuario).
- Guards/middleware (requireAuth, requireRole, requireActiveSubscription).

## Comportamiento observable

### Requirement: Membresía usuario↔tenant con rol

El sistema MUST modelar la pertenencia en `user_tenants` (userId, tenantId, role, status): un mismo email puede ser owner del tenant A y viewer del tenant B. El rol efectivo SIEMPRE es el de la membresía del tenant activo. `users.tenantId` MUST migrarse: cada usuario existente queda con membresía en su tenant actual conservando rol.

#### Scenario: Migración de usuarios existentes

- GIVEN la base actual (1 user = 1 tenant via `users.tenantId`)
- WHEN corre la migración
- THEN cada user tiene una fila en `user_tenants` con su tenant y rol previos, y su sesión sigue funcionando

#### Scenario: Mismo email, dos marcas

- GIVEN ana@x.com owner de "Canal A" e invitada editor de "Canal B"
- WHEN lista sus membresías
- THEN ve ambas con roles distintos por tenant

### Requirement: Tenant activo en sesión

El JWT/contexto de request MUST portar `activeTenantId` además de `userId`. `requireAuth` MUST resolver `req.auth.tenantId` = tenant activo y validar que el user tiene membresía activa en él. En login con varias membresías MUST elegirse un default (primera/última usada) y devolver la lista para el switcher.

#### Scenario: Login multi-tenant

- GIVEN ana con 2 membresías
- WHEN hace login
- THEN recibe token con tenant activo (el último usado o el primero) + lista de sus tenants para el switcher

#### Scenario: Membresía revocada con sesión viva

- GIVEN ana con token cuyo activeTenantId es "Canal B" y su membresía en B fue revocada
- WHEN hace un request
- THEN recibe 403/401 y el cliente ofrece cambiar a otro tenant o re-login

### Requirement: Switch de tenant

El sistema MUST proveer `POST /api/auth/switch-tenant` (o equivalente): valida membresía, emite nuevo token con el tenant activo elegido (y re-join del socket a `tenant:{nuevo}`). La UI MUST mostrar un switcher con los tenants del usuario y el activo marcado. Toda query de dominio, Socket.IO room, settings, credenciales y cuota operan sobre el tenant activo.

#### Scenario: Switch Canal A → Canal B

- GIVEN ana autenticada en Canal A
- WHEN switchea a Canal B
- THEN el nuevo token porta B, las API devuelven datos de B, el socket se une a `tenant:B` y el rol efectivo pasa a editor

### Requirement: Registro e invitación sobre membresía

`register` MUST crear tenant + membresía owner (en vez de `users.tenantId`). Aceptar una invitación MUST crear membresía en el tenant invitante si el email ya existe (sin crear usuario duplicado ni moverlo de tenant).

#### Scenario: Invitado que ya tiene cuenta

- GIVEN ana@x.com ya registrada (Canal A)
- WHEN acepta invitación a Canal B
- THEN se crea su membresía en Canal B con el rol invitado; su cuenta y Canal A quedan intactos

### Requirement: Todas las operaciones sobre tenant activo

Todo endpoint protegido MUST derivar tenant únicamente del tenant activo del token — nunca de `user.tenantId` ni de un tenantId pasado por body. Endpoints que hoy leen `users.tenantId` MUST migrar a membresía+activo.

#### Scenario: Sin spoofing por body

- GIVEN ana en Canal A
- WHEN envía `tenantId=CanalC` en el body de una mutación
- THEN el request opera sobre Canal A (el activo) — el body no puede cambiar el scope

## Datos involucrados (conceptual)

- `user_tenants`: userId, tenantId, role, status, lastUsedAt. (users.tenantId → deprecado tras migración.)
- JWT payload: userId, activeTenantId, email, role (de la membresía activa), isPlatformAdmin.
- `refresh_tokens`: ya tiene tenantId — se alinea a la sesión activa.

## Errores y edge cases

- Usuario con 0 membresías (todas revocadas) → login ok pero app muestra estado "sin acceso", sin datos.
- Switch a tenant suspendido (tenant.isActive=false) → 403 con mensaje.
- Rol distinto por tenant → `requireRole` evalúa el rol de la membresía activa, no un rol global.
- Token viejo (pre-migración) → se trata como inválido o se traduce si tiene tenantId válido con membresía.
- Platform admin NO necesita membresía: opera vía consola/impersonación (ver super-admin), nunca como miembro fantasma.

## Trazabilidad

B-2 (decisión), PA (fundación), D-3 visión. Bloquea/alimenta: team-invites (membresía por invitación), super-admin (guard separado), usage-quota y todas las capacidades (scope por tenant activo).
