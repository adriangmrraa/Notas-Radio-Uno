# Spec: usage-quota — Cuota por transmisiones, TZ-aware e idempotente (Tanda T2)

## Propósito

Monetización real por transmisiones (modelo D-5, patrón Dentalogic): `tenant_quotas` con período YYYY-MM calculado en la timezone del tenant, `quota_operations` con `operation_id` para idempotencia en retries de webhooks/jobs, enforcement efectivo ANTES de disparar pipeline — reemplazando `usage_records`/`checkUsageLimits` (definido pero NUNCA invocado — verificado).

## Actores

- Scheduler y pipeline (consumen cuota).
- Webhooks de billing y jobs (retries exigen idempotencia).
- Tenant (ve su medidor) y super-admin (otorga créditos).

## Comportamiento observable

### Requirement: Período de cuota en timezone del tenant

El sistema MUST mantener `tenant_quotas` (tenantId, período `YYYY-MM`, transmissionsCount, otros contadores) donde el período se calcula con `periodForDate(now, tenant.timezone)` — un tenant en Buenos Aires cambia de ciclo a medianoche ART, no a medianoche del server ni del billing provider.

#### Scenario: Cambio de mes en TZ del tenant

- GIVEN tenant con `timezone='America/Argentina/Buenos_Aires'`
- WHEN son las 00:30 ART del 1.° de diciembre (03:30 UTC)
- THEN el consumo cae en el período `2025-12`, no en `2025-11`

### Requirement: Consumo idempotente por operation_id

Todo consumo de cuota MUST llevar `operation_id` único persistido en `quota_operations`: un retry del mismo operation_id MUST devolver el resultado original sin descontar dos veces. El incremento MUST ser atómico (upsert ON CONFLICT) para que despachos concurrentes no se pisen.

#### Scenario: Webhook/job reintentado no duplica

- GIVEN un dispatch con operation_id `op-123` que consumió 1 transmisión
- WHEN el mismo operation_id se reintenta (retry del job o del webhook)
- THEN la cuota queda igual y la operación devuelve el mismo resultado

### Requirement: Enforcement antes de disparar

El sistema MUST chequear y reservar cuota ANTES de iniciar captura (manual o scheduler): si `transmissionsCount >= maxTransmissionsPerMonth + créditos`, la transmisión no arranca y el tenant recibe señal de paywall (402/código de límite + modal upgrade/add-on). Una transmisión que YA está activa MUST NUNCA cortarse por cuota. `maxDurationMinutes` del plan actúa como anti-abuso: la transmisión se detiene suavemente al llegar al tope, con aviso.

#### Scenario: Paywall al agotar el ciclo

- GIVEN plan Media 30/30
- WHEN el usuario intenta iniciar una transmisión manual o el scheduler quiere disparar
- THEN se bloquea con código de límite + oferta de upgrade/add-on; scheduler registra `skipped_quota`

#### Scenario: Nunca se corta el vivo

- GIVEN la transmisión #30 del ciclo corriendo cuando el contador llega al límite
- WHEN supera el tope
- THEN continúa hasta finalizar; el límite aplica a la PRÓXIMA transmisión

### Requirement: Liberación por fallo temprano

Si una transmisión falla antes de N minutos de captura efectiva (umbral configurable, p.ej. 5 min), el consumo MUST liberarse (misma operation_id, operación de reversa) — el cliente no paga una transmisión que nunca capturó.

#### Scenario: Live que nunca existió

- GIVEN una transmisión que pasó a `error` sin capturar (ventana de espera agotada)
- WHEN se evalúa el consumo
- THEN no descuenta (o se revierte) la transmisión del ciclo

### Requirement: Medidor visible y add-ons

El tenant MUST ver "usaste X de Y transmisiones" con fecha de renovación del ciclo en su TZ; banners de uso al >80%; add-ons +5/+15 disponibles como créditos que expiran con el ciclo (no acumulan).

#### Scenario: Banner al 80%

- GIVEN 25/30 transmisiones usadas
- WHEN el usuario abre el dashboard
- THEN ve el banner de uso alto + opción de comprar add-on

## Datos involucrados (conceptual)

- `tenant_quotas`: tenantId, period (YYYY-MM), transmissionsCount, +contadores secundarios (pipelineHours como cap).
- `quota_operations`: operationId (único), tenantId, period, delta, kind (consume|release|grant), metadata.
- `plans`: +maxTransmissionsPerMonth, +maxDurationMinutes, +maxClipsPerTransmission, +maxPersons, +retentionDays, +maxConnectedPlatforms (ya existe).
- Créditos extra de admin (ver super-admin) como grant operations.

## Errores y edge cases

- Dos dispatches concurrentes por el último cupo → la reserva atómica deja pasar uno solo.
- Tenant sin suscripción → tratado como cuota 0 con paywall (excepto trial elegible).
- Cambio de plan a mitad de ciclo → el nuevo límite aplica desde el cambio; consumo previo se conserva.
- Add-on comprado en ciclo vencido → aplica al ciclo vigente del tenant.
- `usage_records` legacy → se migra/lee como histórico; el nuevo metering escribe solo en `tenant_quotas`.

## Trazabilidad

PB-01, PB-02, PB-05, PB-06, D-5. Consume: scheduler-fix (pre-dispatch), subscription-lifecycle (plan vigente), super-admin (grants), review/dashboard (medidor).
