# BRIEF — PF-04 Cola de render de clips (jobs) + estados por clip + reintento

**KANBAN_TASK_ID**: t_682756fa (ÉPICA F — PF-04, 3 pts)
**Base**: `b481548` (master tip, incluye PF-01 clipCutterService)
**Branch**: `pf-04-render-queue`
**Worktree**: `C:/Users/Asus/orca/workspaces/periodistapp/pf-04-render-queue`

## Contexto

PF-01 (`clipCutterService.cutRawWindow`) corta ventanas del crudo y deja el `clips` row en
`generating → pending_review | error`. ÉPICA F necesita una **cola de render** que desacople
"pedir un clip" de "renderizarlo", con estados persistentes por job y reintento automático.

`scheduled_jobs`/`job_executions` existen pero son para jobs recurrentes de programación de
transmisiones — NO reutilizar. Necesitamos tabla propia para jobs de render ad-hoc.

Patrones del repo a seguir OBLIGATORIAMENTE:
- Store pattern: interface `XStore` + `createDrizzleXStore(db)` + memory store en tests
  (ver `src/server/services/transmissionSegmentsService.ts`, `clipCutterService.ts`)
- `tenant_id` en TODA query de DB (verificación automática)
- Worker init como `initJobScheduler(io)` en `src/server/index.ts:277`
- Timestamps `timestamp('x', { withTimezone: true })`, `updatedAt` con `$onUpdateFn`
- Índices por tenant + por la query del claim (status, run_at)

## Alcance

### 1) Schema — `clip_render_jobs` (nueva tabla, migración drizzle)

Archivo nuevo `src/server/db/schema/renderJobs.ts` + export en `schema/index.ts`.

Columnas:
- `id` uuid PK defaultRandom
- `tenant_id` uuid NOT NULL FK tenants cascade + index
- `clip_id` uuid NULL FK clips cascade + index (nullable: para kind='cut' el clip lo crea el cutter durante el render; el worker lo rellena al terminar)
- `kind` varchar(32) NOT NULL — 'cut' ahora; diseñar extensible (PF-02 'reframe', PF-03 'subtitles' vendrán)
- `status` varchar(20) NOT NULL default 'pending' — 'pending' | 'running' | 'done' | 'error' | 'cancelled'
- `payload` jsonb NOT NULL default {} — para 'cut': `{ transmissionId, startMs, endMs }`
- `attempts` integer NOT NULL default 0
- `max_attempts` integer NOT NULL default 3
- `last_error` text NULL
- `run_at` timestamptz NOT NULL defaultNow — cuándo puede correr (backoff mueve esto)
- `started_at` timestamptz NULL, `finished_at` timestamptz NULL
- `created_at`, `updated_at` (patrón jobs.ts)
- Índice compuesto `(status, run_at)` para el claim del worker

Generar migración con `npm run db:generate` (o `npx drizzle-kit generate` según package.json)
y verificar que aplica limpio contra pglite como hizo PE-06 (ver script de verificación en
drizzle/ o tests previos — reproducir el patrón usado para transmission_segments).

### 2) `clipRenderQueueService.ts` — Store pattern

Interface `ClipRenderQueueStore` + drizzle impl + export. Métodos:
- `enqueue({tenantId, clipId?, kind, payload, maxAttempts?})` → job (status 'pending', run_at now)
- `claimNext(now)` → job | null — atómico: status 'pending' AND run_at <= now → 'running',
  attempts+1, started_at=now. Tenant-agnóstico OK SOLO aquí (la cola es global; el job ya
  lleva tenant_id). Documentar esa excepción con comentario.
- `markDone(jobId, {clipId?})` → status 'done', finished_at, rellena clip_id si viene
- `markFailed(jobId, error, {retryAt})` → si attempts < max_attempts: status vuelve a
  'pending' con run_at=retryAt + last_error; si no: status 'error' terminal + finished_at
- `retry(jobId, tenantId)` → manual: status→'pending', run_at→now, attempts→0, last_error→null.
  Permitido desde 'error' o 'cancelled'.
- `listByClip(clipId, tenantId)`, `getById(jobId, tenantId)`, `listPending(tenantId?)`

### 3) `clipRenderWorker.ts` — loop de dispatch

`initClipRenderWorker(io?)` siguiendo el patrón de `initJobScheduler`:
- `setInterval` cada ~10s (constante `POLL_MS`, env-overridable `RENDER_WORKER_POLL_MS`)
- Por tick: `store.claimNext(now)` → si hay job, dispatch por `kind`:
  - `'cut'` → `clipCutterService.cutRawWindow({tenantId: job.tenantId, ...job.payload})`
    → devuelve clip → `markDone(jobId, {clipId: clip.id})`
  - kind desconocido → `markFailed` con error 'unknown kind' (sin reintento: markFailed
    directo a terminal — pasar flag o retryAt far-future NO; mejor: markFailed con
    retry:false → terminal)
- Error del render → `markFailed(jobId, err.message, {retryAt: now + attempts*60_000})`
  (backoff lineal 1min por intento)
- Fire-and-forget por tick: un job no bloquea el siguiente claim del próximo tick
- Un solo worker por proceso (flag de guard si se llama 2 veces)
- `io` opcional: emit `clip:render:done`/`clip:render:error` al room `tenant:{tenantId}`
  si io presente (mismo contrato de rooms que transmission:moments — ver index.ts)

Dependencias inyectables para test: `{store, cutRawWindow, now, backoffMs}` con defaults reales.

### 4) Wiring — `src/server/index.ts`

`initClipRenderWorker(io)` junto a `initJobScheduler(io)` (línea ~277), env-guarded igual que
los otros schedulers si ellos lo están (revisar cómo se guardan; si no hay guard, agregar
`if (process.env.RENDER_WORKER_ENABLED !== '0')`).

### 5) Tests deterministas

`tests/helpers/memoryRenderJobsStore.ts` + `tests/clipRenderQueue.test.ts`:
- enqueue → claimNext devuelve job (status running, attempts=1)
- claimNext respeta run_at futuro (no lo toma)
- markFailed con attempts < max → vuelve 'pending' con run_at=retryAt
- markFailed con attempts = max → 'error' terminal
- retry() manual desde 'error' → 'pending', attempts 0
- worker tick con cutRawWindow fake → markDone con clipId rellenado
- worker tick con cutter que tira → markFailed + backoff
- tenant isolation en getById/listByClip/retry
- cancel (si lo implementás) o al menos listPending

## NO TOCAR

- `clipCutterService.ts` (es el target del dispatch, se consume vía dep inyectable)
- `clipService.ts`, `streamRecorderService.ts`, `analysisEngineService.ts`, `liveAnalysisRunner.ts`
- Schemas existentes (solo AGREGAR `renderJobs.ts`)
- No implementar reframe/subtitles (PF-02/03) — solo el kind 'cut' funcional

## Gates obligatorios

```bash
npm ci --ignore-scripts   # si node_modules no está
npx drizzle-kit generate  # migración
# verificar migración aplica limpio (patrón pglite usado en PE-06)
npx tsc --noEmit          # EXIT 0
npx vitest run            # todos verdes (471 base + nuevos)
npm run build             # verde
```

## Reporte

`DONE: PF-04 → <SHA>` + archivos + gates + decisiones (p.ej. si clip_id nullable, política
de retry, índice de claim). Si bloqueado: `BLOCKED: <razón>` + qué falta.
