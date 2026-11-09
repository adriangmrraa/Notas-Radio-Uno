# Spec: scheduler-fix — Scheduler con timezone correcto, cuota y transmissions (Tanda T1 — MODIFIED: `scheduling`)

## Propósito

Corregir el scheduler existente (`jobSchedulerService`): hoy compara hora/día **del servidor** contra `job.startTime` ignorando `job.timezone` (bug verificado en `checkAndRunJobs`: usa `now.getDay()`/`getHours()` server-local). Además: chequear cuota ANTES de disparar, y vincular cada ejecución a una `transmission`.

## Actores

- Scheduler (loop 60 s) — actor principal.
- Tenant (su `job.timezone`, su cuota).
- Motor de ingesta (recibe el dispatch).

## Comportamiento observable

### Requirement: Disparo en la timezone del job — MODIFIED

La comparación de disparo MUST evaluarse en `job.timezone`: día de semana, `startTime` y dedup "ya corrió hoy" MUST calcularse convirtiendo `now` a la zona del job (y para dedup, `lastRunAt` a la zona del job), no con la TZ del proceso. `scheduled_jobs.timezone` MUST ser editable vía API/UI (hoy no se envía en POST/PUT — verificado en `routes/jobs.ts`). (Previously: comparación en TZ del server; jobs disparaban a hora incorrecta para tenants fuera de esa TZ.)

#### Scenario: Canal argentino en servidor UTC

- GIVEN job "Programa" recurrente lunes–viernes 10:00 con `timezone='America/Argentina/Buenos_Aires'` y server en UTC
- WHEN son las 10:00 en Buenos Aires (13:00 UTC)
- THEN el job dispara; y NO dispara a las 10:00 UTC

#### Scenario: Sin doble disparo por fecha cruzada

- GIVEN el job anterior ya corrió hoy en su TZ
- WHEN el loop re-evalúa en el mismo minuto o tras reinicio del server
- THEN no dispara una segunda ejecución (dedup por fecha en TZ del job)

### Requirement: Chequeo de cuota antes del dispatch — ADDED

Antes de crear la ejecución, el scheduler MUST verificar la cuota de transmisiones del tenant (ver usage-quota): con cuota disponible consume y despacha; sin cuota, MUST marcar la ejecución como `skipped_quota` (o equivalente), notificar al tenant y NO consumir transmisión. Una transmisión activa NUNCA se corta por cuota.

#### Scenario: Sin cuota no dispara

- GIVEN tenant con 30/30 transmisiones del ciclo usadas
- WHEN llega la hora de un job
- THEN se registra la ejecución omitida por cuota, el tenant recibe notificación/paywall, y no se inicia captura

### Requirement: Ejecución vinculada a transmission — ADDED

Cada dispatch del scheduler MUST crear una `transmission` (`source=live_capture`) vinculada al `scheduledJob`/`jobExecution`, heredando su pipelineConfig y perfil editorial; la ventana de espera y reintentos de live-detection se mantiene (15×2 min actual, configurable).

#### Scenario: Trazabilidad programa→agenda→transmisión

- GIVEN un job vinculado a un programa
- WHEN dispara y captura
- THEN existe la transmission con vínculo a job, ejecución y programa, visible en agenda e historial

## Datos involucrados (conceptual)

- `scheduled_jobs`: + `programId?`, `timezone` (editable), vínculo a transmission vía `job_executions.transmissionId`.
- `job_executions`: + `transmissionId`, status `skipped_quota`.
- `tenant_quotas` (consumo — ver usage-quota).

## Errores y edge cases

- `timezone` inválida → validación la rechaza al guardar el job.
- Job one_time con `scheduledDate` pasada → no dispara; se marca expirado.
- Cambio de TZ del job entre corridas → la próxima evaluación usa la nueva TZ.
- Cuota se agota entre chequeo y dispatch (carrera) → la reserva atómica de cuota decide (usage-quota es la autoridad).
- Server reiniciado con jobs activos → las transmisiones `live` huérfanas se detectan y reconcilian (ver go-live-ops).

## Trazabilidad

PD-03 (ventana/reintentos), PB-02 (consume cuota), bug de exploración "scheduler ignora job.timezone". Depende de usage-quota (T2) para el chequeo — en T1 el chequeo puede estar detrás de flag hasta que cuota exista.
