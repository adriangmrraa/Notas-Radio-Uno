# Spec: subscription-lifecycle — Máquina de estados de suscripción + billing_events + dunning (Tanda T2)

## Propósito

Reemplazar las mutaciones ad-hoc de `subscriptions.status` por una máquina de estados con aristas validadas (`subscription-machine`, función pura), un log append-only `billing_events`, dunning con reintentos y emails, trial-eligibility y soft-cancel — completitud billing estilo Dentalogic sobre Stripe + MercadoPago.

## Actores

- Webhooks de Stripe/MercadoPago (fuentes de verdad de pagos).
- Tenant (sujeto de la suscripción) — recibe emails transaccionales.
- Worker de dunning; super-admin (acciones manuales).

## Comportamiento observable

### Requirement: Máquina de estados con transiciones validadas

El sistema MUST mover `subscriptions.status` SOLO a través de la máquina: `trialing → active | expired | canceled`; `active → past_due (payment_failed) | canceled | suspended`; `past_due → active (reactivated) | suspended (grace agotado) | canceled`; `suspended → active | canceled`. Toda transición inválida MUST ser rechazada explícitamente. Todo cambio MUST emitir un `billing_event` y actualizar campos de período de forma consistente.

#### Scenario: Pago fallido mueve a past_due

- GIVEN suscripción `active` con Stripe
- WHEN llega `invoice.payment_failed`
- THEN la máquina transiciona a `past_due`, emite billing_event `payment_failed` e inicia el ciclo de dunning

#### Scenario: Transición inválida rechazada

- GIVEN suscripción `canceled`
- WHEN un proceso intenta marcarla `trialing`
- THEN la máquina rechaza la transición y registra el intento

### Requirement: billing_events append-only

El sistema MUST registrar en `billing_events` todo evento relevante (trial_started, trial_converted, charged, payment_failed, reactivated, plan_changed, canceled, suspended, addon_purchased, admin_grant) con tenantId, payload del provider y timestamp — append-only, jamás update/delete.

#### Scenario: Auditoría del historial de cobro

- GIVEN un tenant con trial convertido y 2 renovaciones
- WHEN se consulta su historial
- THEN aparecen `trial_started`, `trial_converted`, `charged`×2 en orden, con payloads de origen

### Requirement: Dunning con grace

En `past_due` el sistema MUST reintentar el cobro según política (p.ej. 3 intentos) y enviar emails de aviso; transcurrida la ventana de grace (p.ej. 7 días, configurable) sin pago → `suspended` (servicio bloqueado con paywall, datos intactos); un pago exitoso en cualquier punto → `active` (evento `reactivated`).

#### Scenario: Recuperación dentro de grace

- GIVEN suscripción `past_due` día 3
- WHEN Stripe confirma `invoice.paid`
- THEN vuelve a `active`, emite `reactivated`, y el acceso queda pleno

#### Scenario: Grace agotado

- GIVEN `past_due` con grace de 7 días cumplidos
- WHEN el worker evalúa
- THEN transiciona a `suspended`, notifica por email y el tenant ve solo pantalla de regularización

### Requirement: Trial-eligibility 7 días / 2 transmisiones

El registro MUST otorgar trial elegible una sola vez por tenant/email: 7 días o 2 transmisiones consumidas, lo primero que ocurra; al agotarse sin pago → `expired` con paywall. La elegibilidad MUST impedir re-trials del mismo tenant.

#### Scenario: Trial consumido por uso

- GIVEN tenant en trial que ya consumió 2 transmisiones al día 3
- WHEN intenta una tercera
- THEN la suscripción queda `expired` y ve el paywall de checkout

### Requirement: Soft-cancel y cambio de plan

`cancelAtPeriodEnd` MUST mantener el servicio activo hasta `currentPeriodEnd` y registrar motivo de cancelación. Cambio de plan MUST transicionar vía máquina con prorrateo del provider y evento `plan_changed` con precio congelado del nuevo plan.

#### Scenario: Cancela a mitad de ciclo

- GIVEN `active` con período hasta el 30
- WHEN el usuario cancela el día 10
- THEN `cancelAtPeriodEnd=true`, sigue activo hasta el 30, y el evento `canceled` guarda el motivo

## Datos involucrados (conceptual)

- `subscriptions`: + campos de máquina (graceEndsAt, dunningAttempts, frozenPrice, cancelReason) — enum de estados puede requerir `expired`/`suspended` (ya existen) + semántica `past_due`.
- `billing_events` (append-only): tipo, tenantId, subscriptionId, payload jsonb, provider, externalId (idempotencia de webhook).
- `quota_operations`/`tenant_quotas` para consumo de trial por transmisiones.
- Emails: trial por vencer, pago ok/fallido, suspensión (PB-09).

## Errores y edge cases

- Webhook duplicado/out-of-order → dedup por `externalId` en billing_events; la máquina evalúa el estado actual, no la llegada.
- Pago de un período anterior tras suspensión → `reactivated` y se reabre acceso.
- Tenant sin suscripción (tenant nuevo) → la máquina crea `trialing` si elegible.
- MP y Stripe para el mismo tenant → la suscripción tiene un solo provider activo; el cambio de provider es transición explícita.
- Downgrade con uso sobre el nuevo límite → aplica al próximo ciclo; nunca bloquea lo ya consumido.

## Trazabilidad

PB-04, PB-07, PB-09, D-5 visión, gap Dentalogic (máquina DI pura + billing_events). Depende de bug-fixes (webhook Stripe firma) — sin firma válida los eventos son spoofeables; alimenta usage-quota (límites del plan vigente) y super-admin (métricas/alertas).
