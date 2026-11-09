# Spec: go-live-ops — Cola de jobs, observabilidad, retención y lanzamiento (Tanda T3)

## Propósito

Robustez operativa para early adopters: cola de jobs en Postgres con reintentos y dead-letter, logging estructurado con request-id, métricas de costo de IA por tenant/transmisión, política operacional de backup/purga, checklist go-live y piloto controlado. Decisión D-6 (Postgres MVP, extraer a workers >10–20 streams simultáneos).

## Actores

- Workers del sistema (ejecutan jobs del pipeline).
- Super-admin/operador (panel de jobs, métricas, runbook).
- Soporte (diagnostica con trazabilidad por request/transmisión).

## Comportamiento observable

### Requirement: Cola de jobs en Postgres con reintentos y dead-letter

Los trabajos pesados (render de clips, análisis post-stream, purga, publicación, dossier) MUST encolarse en `jobs_queue` (type, payload, status `pending|running|done|failed|dead`, attempts, runAt, lockedBy) con backoff exponencial y pasaje a dead-letter tras N intentos — reemplazando los `setTimeout`/`setInterval` in-process dispersos (scheduler, retries, purgas) para trabajo que debe sobrevivir reinicios.

#### Scenario: Render sobrevive un deploy

- GIVEN un job de render `pending` cuando el server reinicia
- WHEN el worker vuelve
- THEN el job se retoma y completa — no se pierde como un setTimeout en memoria

#### Scenario: Job venenoso a dead-letter

- GIVEN un job que falla N veces seguidas
- WHEN agota intentos
- THEN pasa a `dead` con último error, visible en el panel admin para intervención

### Requirement: Panel de jobs en admin

La consola admin MUST listar jobs por estado/tipo/tenant con reintento manual desde dead-letter.

#### Scenario: Operador reintenta un dead-letter

- GIVEN un publish job en `dead` por una caída de Zernio ya resuelta
- WHEN el operador lo re-encola
- THEN vuelve a `pending` y procesa

### Requirement: Logging estructurado y trazabilidad

Los logs MUST ser estructurados (JSON) con `requestId`, `tenantId`, `transmissionId`/`jobId` cuando aplique; cada request genera/propaga request-id y toda la actividad de una transmisión es consultable por su id de punta a punta (PI-02).

#### Scenario: Diagnosticar una transmisión fallida

- GIVEN transmission `error` reportada por el cliente
- WHEN soporte filtra logs por transmissionId
- THEN ve captura→análisis→render→fallo con request-ids, sin grepear texto suelto

### Requirement: Métricas de costo de IA por tenant/transmisión

Cada llamada a proveedor de IA (análisis video, transcripción, imagen, texto) MUST registrar costo estimado atribuido a tenant+transmisión (PI-03), alimentando el detalle de tenant en super-admin y el control de margen por plan.

#### Scenario: Costo de una transmisión de 3 h

- GIVEN una transmisión procesada
- WHEN el operador consulta su detalle
- THEN ve el costo IA desglosado por proveedor/paso vs. margen del plan

### Requirement: Retención, purga y backup operacionalizados

La purga de crudos por `retentionDays` (stream-recording) MUST correr como job de la cola con log de eliminados; assets generados MUST conservarse (son el producto); la política de borrado de datos biométricos acompaña la purga de persons/tenant (PI-05).

#### Scenario: Purga diaria auditada

- GIVEN el job de purga corriendo cada noche
- WHEN encuentra crudos vencidos
- THEN elimina archivos, marca segmentos purgados y registra el resultado por tenant

### Requirement: Checklist go-live y piloto

El lanzamiento MUST validar: seeds de planes (Creator/Media/Network/Enterprise con límites de la tabla de negocio), health checks de dependencias (yt-dlp, ffmpeg, InsightFace, Zernio, Stripe/MP, AssemblyAI), datos demo disponibles, y runbook de incidentes (stream caído, cuota, webhook fallido, Zernio down). El piloto (PI-07) exige 1 canal real 1 semana con métricas: ≥5 clips/transmisión, ≥90% atribución, uptime de captura, aprobación rate.

#### Scenario: Go-live checklist verde

- GIVEN despliegue a producción
- WHEN se corre el checklist
- THEN cada dependencia reporta healthy, los planes existen con límites correctos y el runbook está accesible

## Datos involucrados (conceptual)

- `jobs_queue`: type, payload, status, attempts/maxAttempts, runAt, lockedBy, lastError, tenantId.
- `ai_cost_records` (o métricas equivalentes): tenantId, transmissionId, provider, kind, tokens/units, costEstimate.
- Logs estructurados con requestId (infra, no tabla).

## Errores y edge cases

- Dos workers toman el mismo job → locking por `lockedBy`/lease, nunca doble ejecución visible (idempotencia en el handler).
- `MAX_CONCURRENT` de capturas/renders parametrizado; exceso queda `pending`, no perdido.
- Métricas de costo son estimadas (pricing del provider puede cambiar) → documentadas como estimate, auditables por evento.
- Escala >10–20 streams simultáneos → extracción a workers/BullMQ es deuda conocida con trigger definido (D-6).
- Transmisiones `live` huérfanas tras crash → reconciliación al boot: marcar/recuperar según estado del crudo.

## Trazabilidad

PI-01, PI-02, PI-03, PI-04 (reanudación comparte con stream-recording), PI-05, PI-06, PI-07, D-6. Sostiene a TODAS las tandas (cola para clips/publish/purga) y alimenta super-admin (panel + métricas).
