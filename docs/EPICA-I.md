# ÉPICA I — Robustez, observabilidad y lanzamiento

Checklist de la tarjeta `t_1da234af`. Cada ítem se marca `[x]` sólo con commits +
evidencia real de gates (EXIT codes, `Test Files N passed`, salida del verificador
PGlite). Fuente del texto/puntaje: la tarjeta del kanban.

## Checklist

- [x] PI-01 Cola de jobs (tabla Postgres MVP) con reintentos + dead-letter + panel de jobs en admin [5]

  **Commits (branch `periodistapp/t_1da234af-periodistapp-epica-i-robustez-observabilidad-y-lanzamiento`):**
  - `5bea3b4` `feat(jobs): add job_queue table with retries and dead-letter`
    — schema `job_queue` + migración `0020_narrow_invaders` + `jobQueueService` +
    `jobQueueWorker` + rutas tenant `/api/job-queue`.
  - `4fe80eb` `feat(admin): add jobs panel with filters and dead-letter requeue`
    — endpoints admin (`/api/admin/jobs`, `POST /jobs/:id/requeue`), auditoría
    `admin.job_requeued`, panel React `/admin/jobs`.
  - `5116ba3` `test(jobs): add deterministic job queue and admin jobs tests`
    — `memoryJobQueueStore` + 23 tests deterministas (fix `previousStatus` en audit).

  **Evidencia de gates (todos con EXIT real, ejecutados sobre el HEAD `5116ba3`):**
  - `npx tsc --noEmit` → **EXIT 0**
  - `npx vitest run` → **EXIT 0** — `Test Files 51 passed (51)`, `Tests 962 passed (962)`
  - `npm run build` → **EXIT 0** — `No schema changes, nothing to migrate`
  - `node scripts/verify-migration-pglite.mjs` → **EXIT 0** —
    `tabla PI-01: job_queue (15 columnas, FK tenant cascade, índices tenant+status, claim (status,run_at) y tenant+created_at, migración 0020 idempotente)`
  - `git diff --check` → **EXIT 0**

- [ ] PI-02 Logging estructurado + request-id + trazabilidad por transmisión [3]
- [ ] PI-03 Métricas de costo de IA por tenant/transmisión (alimenta super admin) [3]
- [ ] PI-04 Manejo de fallos de ingesta (stream caído, cortes) con reanudación de crudo [5]
- [ ] PI-05 Backup/retención de assets + política de borrado de crudos [2]
- [ ] PI-06 Checklist go-live: seeds de planes, datos demo, health checks, runbook de incidentes [3]
- [ ] PI-07 Piloto controlado: 1 canal real transmitiendo 1 semana, métricas de éxito [5]
