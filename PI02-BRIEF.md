# BRIEF — ÉPICA I / PI-02: Logging estructurado + request-id + trazabilidad por transmisión

**KANBAN_TASK_ID**: `t_1da234af` (PeriodistApp — ÉPICA I: Robustez, observabilidad y lanzamiento)
**Base**: `a50b0fb` (HEAD de la rama `periodistapp/t_1da234af-…` — incluye PI-01 ya entregado)
**NO partir de `origin/master` (1b06da1) ni de `73b043a`: perderías PI-01.**
**Branch**: `periodistapp/t_1da234af-periodistapp-epica-i-robustez-observabilidad-y-lanzamiento`
**Worktree**: `C:/Users/Asus/Documents/estabilizacion/periodistapp/.worktrees/t_1da234af`

> El `BRIEF.md` de la raíz es stale (ÉPICA F). `PI01-BRIEF.md` es el brief de PI-01 (ya entregado).
> **Este archivo es el brief válido de PI-02.**

---

## 1. Objetivo de este slice (PI-02, segundo `- [ ]` de la ÉPICA I)

**Logging estructurado + request-id + trazabilidad por transmisión.**

Hoy el server tiene **349 `console.*`** (verificado: `grep -rn "console\." --include=*.ts src/server/ | wc -l`),
todos con formato libre `"[algo] mensaje"`. No hay request-id: una petición que falla deja
pistas sueltas y **no se puede correlacionar** un error con la transmisión que lo originó.

Este slice entrega:

1. Un **logger estructurado** (JSON en producción) con **request-id** por petición.
2. **Trazabilidad por transmisión**: cada línea de log de una operación ligada a una transmisión
   lleva el `transmissionId`, para poder reconstruir qué pasó con una emisión concreta.
3. Un **middleware** que genera/adopta el request-id, lo propaga en la respuesta
   (`X-Request-Id`) y lo expone a los logs.

## 2. Estado real del repo (VERIFICADO el 2026-11-11 — no re-descubrir)

- **NO hay dependencia de logging**: `package.json` no tiene `pino`/`winston`/`bunyan`.
  Deps actuales: `@ai-sdk/*, @napi-rs/canvas, @neondatabase/serverless, drizzle-orm, express,
  express-rate-limit, socket.io, stripe, uuid, zod, …`. **NO agregues una dependencia de logging**
  (sin `npm install` de paquetes nuevos: no hay red garantizada y agrega superficie).
  → **Escribí el logger a mano** con `node:util` + `console` detrás.
- **NO hay `AsyncLocalStorage` en el repo** (0 hits). Sí viene con Node — usalo (`node:async_hooks`).
- `uuid` **SÍ** es dependencia (`^10.0.0`) → usalo para los ids (`import { v4 as uuidv4 } from 'uuid'`).
- No hay RLS; el aislamiento sigue siendo por `tenant_id` (no lo toques en este slice).
- La app Express se arma en `src/server/index.ts`: el orden actual es
  `helmet → cors → express.raw(stripe) → express.json → cookieParser → apiLimiter → optionalAuth →
  viewerWriteGuard → static → registerPublicRoutes → rutas → 404`.
- `src/server/lib/` existe (`errors.ts`, `quotaMath.ts`, …) — es donde va el módulo nuevo.
- PI-01 ya dejó `src/server/services/jobQueueService.ts` y `jobQueueWorker.ts`: **usá el logger
  nuevo en esos dos** (son los archivos que este slice toca de la ÉPICA I).

## 3. Alcance

### 3.1 `src/server/lib/logger.ts` — logger estructurado (nuevo)

- Sin dependencias nuevas. API mínima y explícita:
  - `log.info(msg, fields?)`, `log.warn(...)`, `log.error(msg, fields?)`, `log.debug(...)`.
  - `log.child(fields)` → logger derivado con campos fijos (p.ej. `{ transmissionId }`).
- **Formato**:
  - `NODE_ENV === 'production'` → **una línea JSON por evento** (parseable por cualquier agregador).
    Ej: `{"ts":"2026-11-11T03:00:00.000Z","level":"info","msg":"...","requestId":"...","tenantId":"..."}`.
  - fuera de producción → línea legible `[LEVEL] msg key=value …` (mismo nivel de detalle).
- **Campos**: `ts` (ISO), `level`, `msg`, y los `fields` que se le pasen.
  **El `requestId` actual se inyecta automáticamente** si está en el contexto (ver §3.2).
- **Redacción OBLIGATORIA**: nunca loguees secretos. El logger **redacta** (reemplaza por
  `[REDACTED]`) los valores de claves cuyo nombre matchee, case-insensitive:
  `password, passwd, secret, token, apiKey, api_key, authorization, cookie, accessToken,
  refreshToken, credential, credentials, connectionString, databaseUrl, privateKey`.
  Además: los valores que **parezcan** una URL de Postgres con credenciales
  (`postgres://user:pass@…`) se redactan en cualquier clave.
  Esto se testea (§3.5).
- **Nunca** loguees el body completo de una request ni cabeceras de autenticación.
- `Error` como campo: logueá `err.message` + `err.stack` (o `err` serializado), nunca `[object Object]`.
- Exportá además `LOG_LEVEL` por env (`LOG_LEVEL=debug|info|warn|error`, default `info`):
  mensajes por debajo del nivel **no** se emiten (para no inundar en prod).

### 3.2 `src/server/lib/requestContext.ts` — contexto asíncrono (nuevo)

- Con `AsyncLocalStorage` de `node:async_hooks`:
  - `getRequestContext()` → `{ requestId?, tenantId?, transmissionId? } | undefined`.
  - `runWithRequestContext(ctx, fn)` → ejecuta `fn` con ese contexto.
  - `setRequestContext(patch)` → actualiza el contexto dentro del scope actual.
- `requestId` se genera con `uuidv4()` salvo que exista.
- El logger lee el contexto en cada llamada → **todas** las líneas de una petición llevan el
  `requestId` sin que cada call-site tenga que pasarlo a mano.

### 3.3 `src/server/middleware/requestId.ts` — middleware (nuevo)

- Exporta `requestIdMiddleware` (Express `RequestHandler`):
  - Lee `X-Request-Id` (o `x-request-id`) del request. **Si viene, lo adopta** (para que un
    gateway o el cliente pueda propagar su correlación) **sólo si es seguro**: string de 1..128
    chars y **sólo** `[A-Za-z0-9._:-]`. Si no cumple → genera uno nuevo (no lo rechaces con 400:
    no rompas tráfico por un header sucio).
  - Si no viene → `uuidv4()`.
  - Setéa `X-Request-Id` en la **respuesta** (status 2xx/4xx/5xx alike).
  - Corre el resto de la app dentro de `runWithRequestContext({ requestId }, …)`.
  - Al terminar (en `res.on('finish')`) emite **una línea** de log con:
    `method`, `path`, `status`, `durationMs`, `requestId`, y `tenantId` si está disponible.
- **Tenant**: el middleware corre **antes** de `optionalAuth`, así que el `tenantId` todavía no
  existe cuando empieza. Solución: logueá en `res.on('finish')` y leé `req.auth?.tenantId`
  **en ese momento** (ya populateado). Documentalo.
- Montalo en `src/server/index.ts` **antes** de `optionalAuth` y **antes** de las rutas
  (después de `helmet`/`cors` está bien; que sea el primero de los que toca `/api`).

### 3.4 Migración de call-sites — **alcance acotado y medible**

Convertir los 349 `console.*` es un refactor gigante y riesgoso: **NO lo hagas**. Hacé el
**núcleo + laSignup**. Alcance exacto:

**(a) Núcleo del servidor** — `src/server/index.ts`: los ~14 `console.*` de arranque/cierre/
CORS/health → `log.*`. Ojo: los de CORS van a `log.warn` con `{ origin }`.

**(b) Trazabilidad por transmisión** — `src/server/services/streamRecorderService.ts`:
sus `console.error('[recorder] …')` → `log.error('…', { tenantId, transmissionId, recordingId,
sequence, err })`. El recorder **ya tiene** `tenantId`, `transmissionId` y `recordingId` en scope
(verificá los sitios de `setSegmentEndMs`/`insertSegment`/`finalizeRecording`/`transitionRun`).
**Éste es el corazón de PI-02**: una línea de log de un corte de stream tiene que decir QUÉ
transmisión era.

**(c) `src/server/services/transmissionSchedulerService.ts`** — sus 15 `console.*` → `log.*`
con `{ tenantId, transmissionId }` cuando la línea corresponda a una emisión concreta.

**(d) PI-01** — `src/server/services/jobQueueService.ts` y `src/server/services/jobQueueWorker.ts`:
sus `console.*` → `log.*` (el worker ya tiene `job.tenantId`, `job.kind`, `job.id`).

**(e) `src/server/routes/jobQueue.ts` y `src/server/routes/admin.ts`** — los `console.error` de
`handleError`/`fail` → `log.error` **con `{ requestId }` explícito** (o dejá que el logger lo
inyecte del contexto — prefiero que lo inyecte solo, pero en el `catch` el contexto sigue vivo).

**Los demás archivos quedan con `console.*`** — eso es correcto para este slice (migración
incremental). **Documentá en el reporte cuántos `console.*` quedan** y que quedan para PI-06/后续.

### 3.5 Tests — `tests/logging.test.ts` (nuevo) + helpers si hacen falta

Deterministas: sin DB, sin red, sin timers. Casos **obligatorios**:

1. **Formato JSON en producción**: con `NODE_ENV='production'`, `log.info('x', { a: 1 })` emite
   **una línea** que parsea como JSON con `ts`, `level`, `msg`, `a`.
2. **Formato legible fuera de producción**: no es JSON pero contiene nivel, msg y los campos.
3. **Nivel**: un `log.debug` con `LOG_LEVEL=info` **no** emite nada; con `LOG_LEVEL=debug` emite.
4. **Redacción**: `log.info('m', { password: 'x', apiKey: 'y', Authorization: 'Bearer z' })`
   → **ningún** valor secreto aparece en la salida; los 3 salen como `[REDACTED]`.
5. **Redacción de URL con credenciales**: `{ detail: 'postgres://u:p@host/db' }` → la contraseña
   no aparece.
6. **Request-id automático**: dentro de `runWithRequestContext({ requestId: 'abc' }, …)`,
   `log.info('m')` incluye `requestId: 'abc'`.
7. **Middleware — request-id generado**: sin header → la respuesta trae `X-Request-Id` con forma
   uuid v4 y el log de finish lo incluye.
8. **Middleware — request-id adoptado**: con `X-Request-Id: 'corr-123'` válido → la respuesta
   devuelve **ese mismo** valor y el log lo incluye.
9. **Middleware — request-id inválido**: con `X-Request-Id` con caracteres fuera de
   `[A-Za-z0-9._:-]` (ej. `'bad id!'` o 200 chars) → se genera uno **nuevo** (no se propaga el
   sucio) y la request **no** falla.
10. **Middleware — log de finish**: la línea emitida incluye `method`, `path`, `status`,
    `durationMs` y `requestId`.
11. **Trazabilidad por transmisión**: `log.child({ transmissionId: 'tx-1' })` → las líneas derivadas
    incluyen `transmissionId: 'tx-1'`, y el `requestId` del contexto **también** aparece
    (contexto + child se combinan, no se pisan).
12. **Contexto anidado**: `runWithRequestContext` anidado → el interno gana; al salir, el externo
    vuelve. (Testeá que no se filtre el del scope interno al scope padre.)

**Patrón de tests HTTP**: el repo ya tiene el patrón de app Express efímera + auth mockeado en
`tests/publishJobs.test.ts` (mock **parcial** de `../src/server/db/index.js`:
`...await io()` + `db: {}`). Reutilizá ese patrón para probar el middleware con `supertest`-like
helper: si `supertest` **no** está en `package.json`, **NO lo agregues** — levantá el server con
`http.createServer(app)` y hacé el request con `fetch` contra `http://127.0.0.1:<puerto>`
(patrón `tests/publishJobs.test.ts`/`tests/liveRoomApi.test.ts`).

### 3.6 Checklist de la ÉPICA I

Actualizá `docs/EPICA-I.md` (ya existe, creado por PI-01): marcá **PI-02** como `[x]` con el SHA
de tus commits + la evidencia real de los gates, y **dejá PI-01 como está**. Los ítems PI-03..PI-07
quedan `- [ ]`.

## 4. Reglas de dominio (inviolables)

- **Nunca loguees secretos**: la redacción del §3.1 es la barrera, pero además **no pases**
  tokens, cookies, passwords ni bodies de request a `log.*`. Ante la duda, logueá el `id`.
- **`tenant_id` y `transmissionId` en los logs** cuando apliquen — es el punto del slice.
- Los logs **no** deben romper la app: un error al loguear **no** puede tumbar una request
  (envolvé el emit en try/catch y seguí).
- No toques `publish_jobs`, `clip_render_jobs`, `scheduled_jobs` ni `job_executions`.
- No cambies contratos de API existentes (agregar un header de respuesta **sí** está permitido y
  es parte del slice).
- **Fuera de alcance**: PI-03 métricas de costo IA, PI-04 ingesta, PI-05 retención,
  PI-06 go-live, PI-07 piloto.

## 5. Gates exactos (EXIT real, sin pipe — el exit code tiene que verse)

```bash
npx tsc --noEmit          # EXIT 0
npx vitest run            # debe imprimir "Test Files N passed (N)"
npm run build             # EXIT 0 — y debe decir "No schema changes, nothing to migrate"
git diff --check          # EXIT 0
```

`npm run build` tiene que decir **`No schema changes, nothing to migrate`** — este slice **no**
toca el schema, así que cualquier migración nueva es drift tuyo: revisala.

Si algún gate falla por un archivo **ajeno** a tu slice, NO lo arregles: reportalo explícitamente
y seguí.

## 6. Commits

- Conventional commits, **un commit por unidad de trabajo**:
  1. `feat(logging): add structured logger and request-id context`
  2. `feat(logging): add request-id middleware and wire it into the server`
  3. `feat(logging): migrate transmission, recorder and job queue logs to the structured logger`
  4. `test(logging): add deterministic logger and request-id tests`
  5. `docs(epica-i): mark PI-02 complete with SHA and gate evidence`
- **Paths explícitos** en `git add` — **NUNCA** `git add -A`, `git add .`, `git stash`, `git checkout`.
- **Sin atribución IA** (nada de `Co-Authored-By`, nada de "generated by").
- **NO push**: commiteá y dejá la rama lista. El orquestador pushea el backup después de verificar.

## 7. Límites duros (respetalos o el trabajo se rechaza)

- **NO push** a `master`/`main`, **NO merge**, **NO deploy**.
- **NO dependencias nuevas** (ni `npm install`).
- **NO tocar** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`.
- La integración a `master` espera la **firma de Adrián** en `t_851c4b77`.

## 8. Reporte final (obligatorio, en el cuerpo de la respuesta)

1. Qué construiste (con `file:line`) y **qué NO** migraste de los 349 `console.*` (conteo exacto
   antes/después).
2. Salida real de los 4 gates (EXIT codes + `Test Files N passed`).
3. SHA de los commits + `git log --oneline` + `git status --porcelain` (limpio).
4. Cómo se garantiza la no-exposición de secretos (redacción + qué NO se loguea).
5. Lo que **NO** quedó verificado, declarado explícitamente.
