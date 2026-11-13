# RUNBOOK — PeriodistApp (PI-06)

Runbook de incidentes de producción. Formato: **síntoma → diagnóstico → acción**.
Nunca pegues credenciales ni connection strings en tickets, logs ni chats: las
variables se referencian por NOMBRE (`DATABASE_URL`, `DEEPSEEK_API_KEY`, …) y se
editan en el panel del proveedor (Render/Easypanel) o en `.env` local.

Punto de partida de casi todo diagnóstico:

```bash
curl -s https://<host>/api/health | jq .
```

Respuesta esperada sana: `status: "ok"` con `checks.database.status: "up"`,
`checks.migrations.applied == checks.migrations.expected` y
`checks.aiProviders.configured` no vacío. `degraded` = la app sirve pero algo
está caído (200); `error` + 503 = DB inalcanzable.

---

## 1. Cola de jobs caída

**Síntoma:** jobs acumulados en `pending`, no se procesan renders/publicaciones/
purga/backup; el panel `/api/job-queue` muestra jobs viejos sin mover o muchos
`dead`.

**Diagnóstico:**

1. Verificar que el worker está habilitado y corriendo:
   - `JOB_QUEUE_WORKER_ENABLED` (cola genérica `job_queue`),
     `PUBLISH_WORKER_ENABLED` (`publish_jobs`), `RENDER_WORKER_ENABLED`
     (`clip_render_jobs`). Valor `0` = worker apagado.
   - Logs del proceso: `[JobQueue]`/worker iniciado al boot.
2. Verificar el estado de la cola como platform admin:
   `GET /api/job-queue?status=dead` y `GET /api/admin/jobs`.
   - Muchos `dead` con el mismo `last_error` → falla sistemática (no un job malo).
   - Muchos `pending` con `run_at` futuro → backlog normal con backoff, no caída.
3. `GET /api/health` → si `database.status` es `down` el problema es la DB
   (ver sección 5), no la cola.

**Acción:**

- Worker apagado por env → setear `*_WORKER_ENABLED` en `1` (o quitar la
  variable) y redeploy/restart del proceso.
- Worker corriendo pero jobs `dead` → reintentar manual:
  `POST /api/job-queue/:id/retry` (o `POST /api/admin/jobs/:id/retry`).
  Si el `last_error` apunta a un servicio externo, resolver esa causa primero
  (el retry vuelve a fallar si la causa sigue).
- Job con `kind` desconocido (`last_error` = "unknown job kind") → deploy
  incompleto: la versión del código no tiene el handler registrado. Actualizar
  el deploy o encolar el job desde una versión que sí lo tenga.
- Proceso API y worker en el mismo proceso (hoy): si el server entero está
  caído, restart del servicio — los workers arrancan en el boot
  (`initJobQueueWorker`, `initPublishWorker`, `initClipRenderWorker`).

---

## 2. Provider de IA caído

**Síntoma:** generación/notas/análisis fallan; errores del tipo "Ningún
proveedor de IA disponible" o 4xx/5xx del provider en logs.

**Diagnóstico:**

1. `GET /api/health` → `checks.aiProviders`:
   - `configured: []` → **ninguna key configurada** (la más común).
   - `configured: ["deepseek"]` pero sigue fallando → key inválida, cuota
     agotada o outage del provider (revisar logs `[AI]`/`AI SDK`).
2. El orden de fallback está en `aiSdkService`/`PROVIDERS`: `deepseek` →
   `google` → `openai`. Si el primero tiene key pero está caído, los
   siguientes cubren — sólo si sus keys también están seteadas.
3. Status page del provider correspondiente para confirmar outage externo.

**Acción:**

- Key faltante → setear `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` /
  `OPENAI_API_KEY` en el panel de env del hosting y **redeploy** (los env se
  leen al boot).
- Key inválida/cuota → rotar la key en el provider, actualizar el env y
  redeploy.
- Provider con outage → configurar key de un provider alternativo de la lista
  y redeploy; el servicio elige automáticamente entre los configurados.
- Verificar post-acción: `GET /api/health` debe volver a `ok` con
  `configured` no vacío, y re-probar una generación chica.

---

## 3. Migración faltante

**Síntoma:** el server no levanta (`[DB] Error running migrations` →
`process.exit(1)`), o endpoints nuevos fallan con `column does not exist` /
`relation does not exist`, o `/api/health` muestra
`checks.migrations.status: "pending"` (`applied < expected`).

**Diagnóstico:**

1. `GET /api/health` → comparar `migrations.applied` vs `expected`
   (entradas del journal `drizzle/meta/_journal.json`).
2. Revisar los logs de boot: `runMigrations()` corre al inicio y aborta el
   proceso si falla — si el proceso corre, las migraciones aplicaron o se
   marcaron por el fallback de "schema ya existe".
3. Verificar qué archivo `.sql` de `drizzle/` no está en la tabla
   `__drizzle_migrations` (la salida de health ya da el delta).

**Acción:**

- Deploy nuevo con migraciones → el boot las aplica solo
  (`runMigrations` en `src/server/db/migrate.ts`). Si el deploy anterior
  quedó a medio camino, hacer **rollback al commit anterior estable** y
  redeploy, o aplicar a mano en el entorno:
  `npm run db:migrate` con `DATABASE_URL` del entorno apuntado (NUNCA desde
  una máquina local contra producción sin aprobación).
- Error `42710`/`42P07` (type/table already exists) → el fallback del repo
  marca las migraciones como aplicadas; revisar que el resultado sea
  coherente (`health.migrations`).
- Migración fallida a medias → revisar el error SQL en logs, corregir el
  `.sql`, regenerar (`npm run db:generate`), commitear y redeploy. Nunca
  editar una migración ya aplicada en producción: crear una nueva.

---

## 4. Deploy fallido

**Síntoma:** el servicio no responde post-deploy, `deploy failed` en el panel
de Render/Easypanel, o el health check de Render marca el deploy como
unhealthy (`/api/health` no responde 200).

**Diagnóstico:**

1. Logs de build: `npm install && npm run build` (render.yaml) — ¿falló
   `tsc`, `vite build` o `drizzle-kit generate`? ¿Faltaron los binarios
   (`yt-dlp`, `ffmpeg` que baja el buildCommand)?
2. Logs de runtime del boot: ¿falló `runMigrations` (ver sección 3)? ¿Falta
   `DATABASE_URL`/`JWT_SECRET`/`ENCRYPTION_KEY`?
3. `GET /api/health`: `error` + 503 = DB inalcanzable (¿DATABASE_URL
   apuntando mal? ¿DB del entorno caída?); sin respuesta = el proceso no
   levantó.
4. `git status` local: ¿el deploy corrió sobre un commit sin los archivos
   migratorios o sin build limpio?

**Acción:**

- Rollback primero, diagnóstico después: en el panel de Render usar
  **Rollback** al último deploy sano (o `git revert` del commit culpable +
  push → auto-deploy).
- Falla de build → corregir el error en rama, correr `npm ci && npm run build`
  local hasta EXIT 0, redeploy.
- Env faltante tras agregar una feature → agregar la variable en el panel
  (ver `render.yaml`/`docs/GUIA_ENV_VARIABLES.md` como lista maestra) y
  redeploy.
- Health check flap → el endpoint puede tardar mientras `runMigrations`
  termina; si el servicio queda healthy a los ~30 s no es incidente. Si
  persiste 503, tratar como sección 5.

---

## 5. DB inalcanzable (`/api/health` → 503 `error`)

**Síntoma:** `checks.database.status: "down"`, todo endpoint que toca DB
falla, timeouts/`ECONNREFUSED` en logs.

**Diagnóstico:** ¿DB del proveedor caída (status page)? ¿`DATABASE_URL`
apunta al host correcto del entorno? ¿Firewall/allowlist del pool Neon?

**Acción:** verificar/rotar `DATABASE_URL` en el panel, confirmar
conectividad (`SELECT 1` desde un cliente del mismo entorno), restart del
servicio una vez la DB responda. No hay fix de código: es infraestructura.

---

## Referencias

- `GET /api/health` — semántica en `src/server/services/healthService.ts`.
- Cola genérica — `src/server/services/jobQueueService.ts`,
  rutas `/api/job-queue` + `/api/admin/jobs`.
- Migraciones — `src/server/db/migrate.ts`, journal `drizzle/meta/_journal.json`.
- Seeds — `scripts/seed-plans.ts` (catálogo), `scripts/seed-demo.ts` (demo).
- Deploy — `render.yaml`, `DEPLOYMENT_GUIDE.md`, `docs/DEPLOYMENT_EASYPANEL.md`.
