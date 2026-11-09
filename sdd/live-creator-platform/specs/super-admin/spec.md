# Spec: super-admin — Consola de operadores de la plataforma (Tanda T2)

## Propósito

Panel interno separado del producto cliente para operadores de PeriodistApp: lista y detalle de tenants, acciones administrativas (plan, trial, transmisiones extra, suspender), impersonación auditada de 30 minutos y métricas globales — al nivel del benchmark Dentalogic.

## Actores

- Operador de plataforma (usuario con `is_platform_admin`).
- Tenant administrado (objeto de las acciones).

## Comportamiento observable

### Requirement: Rol de plataforma y guard

El sistema MUST distinguir operadores con flag `is_platform_admin` en `users` (independiente del rol por tenant — un admin no necesita membresía). Todo `/api/admin/*` MUST pasar por un guard dedicado que exige `requireAuth` + flag; la consola `/admin` MUST ser inaccesible para usuarios cliente. El flag MUST ser seteable solo por otro platform admin o seed, nunca por el propio usuario ni por owner de tenant.

#### Scenario: Cliente intenta entrar a /api/admin

- GIVEN un user sin `is_platform_admin`
- WHEN llama `GET /api/admin/tenants`
- THEN recibe 403

### Requirement: Lista y detalle de tenants

La consola MUST listar tenants con plan, estado de suscripción, uso del ciclo (transmisiones consumidas/límite), fecha de alta y búsqueda. El detalle MUST mostrar usuarios, programas, actividad reciente y costo de IA estimado del tenant.

#### Scenario: Operador revisa un tenant

- GIVEN la consola `/admin`
- WHEN abre el tenant "Canal X"
- THEN ve sus miembros, plan Media, 18/30 transmisiones del ciclo, últimas transmisiones y costo IA estimado

### Requirement: Acciones administrativas auditadas

El operador MUST poder: cambiar plan, extender trial, otorgar transmisiones extra del ciclo (crédito de cuota), suspender/reactivar tenant, y ajustar feature flags/cuota. TODA acción MUST registrarse en audit log con actor, tenant afectado y payload.

#### Scenario: Otorgar +5 transmisiones a un early adopter

- GIVEN tenant con 30/30 usadas
- WHEN el operador otorga +5
- THEN su cuota efectiva del ciclo sube a 35, queda auditado, y el tenant puede disparar transmisiones otra vez

#### Scenario: Suspender un tenant

- GIVEN tenant en infracción
- WHEN el operador lo suspende
- THEN sus usuarios reciben 403 al operar (login informa suspensión) y sus jobs no disparan; la acción queda auditada

### Requirement: Impersonación auditada con expiración

El operador MUST poder "ver como" un tenant para soporte: emite un contexto de impersonación que expira a los 30 minutos, muestra banner permanente "viendo como {tenant}" en toda la UI, queda auditado inicio/fin, y SHOULD impedir acciones destructivas irreversibles (p. ej. pagos, borrar cuenta) durante la sesión.

#### Scenario: Soporte impersona y expira

- GIVEN el operador impersonando "Canal X"
- WHEN pasan 30 minutos
- THEN el contexto expira y vuelve a la consola admin; en audit quedan inicio, fin y acciones realizadas

### Requirement: Métricas globales de plataforma

La consola MUST exponer MRR (Σ precio congelado de suscripciones no canceladas), tenants activos, transmisiones procesadas, tasa de aprobación de assets, costo de IA por tenant, churn mensual, conversión de trial y alertas de `payment_failed` recientes (<7 días).

#### Scenario: Dashboard del operador

- GIVEN varios tenants con suscripciones
- WHEN el operador abre métricas
- THEN ve MRR, activos, churn del mes, conversión trial→pago y lista de tenants con pago fallido reciente

## Datos involucrados (conceptual)

- `users.is_platform_admin` (flag), sesiones de impersonación (token/contexto con expiresAt + audit).
- `audit_log` (todas las acciones admin), `tenant_quotas` (crédito extra), `tenant_features` (flags), `billing_events`/`subscriptions` para métricas.

## Errores y edge cases

- Admin impersonando NO puede impersonar a otro admin ni elevar flags.
- Tenant suspendido con transmisión `live` → la transmisión activa termina (nunca se corta), pero no se inician nuevas.
- Métricas con datos incompletos (sub sin precio congelado) → se excluyen del MRR con nota, no se estiman.
- Revocar flag a un admin logueado → su próximo request a /api/admin da 403.
- Impersonación durante impersonación → prohibida.

## Trazabilidad

PA-06, PA-07, PA-08, PA-09, PA-10, PI-03 (costo IA). Depende de multi-tenant-auth (flag+guard), usage-quota (crédito), feature-flags (ajuste), audit-log, subscription-lifecycle (métricas).
