# PD-03 — Scheduler de transmisiones programadas (ventana de espera + reintentos)

Ejecutá este brief **end-to-end, de forma totalmente autónoma**. No esperes aprobación de nadie.
Si un gate falla, arreglalo antes de reportar. **No dejes nada a medias.**

## Contexto del repo

- Worktree: el que ya tenés abierto. Rama de este slice: `pd-03-scheduler`.
- Stack: **Express 4 + TypeScript (ESM) + React 19 SPA + Drizzle ORM + Postgres (Neon)**.
- Contratos que ya existen (leelos primero y **reutilizalos**):
  - `src/server/db/schema/transmissions.ts` — `transmissions` (columnas: `tenant_id`, `program_id`,
    `scheduled_transmission_id`, `source`, `status`, `stream_url`, `resolved_stream_url`, `crudo_ref`,
    `duration_minutes`, `started_at`, `ended_at`, `waiting_since`, `last_heartbeat_at`, `error_message`,
    `pipeline_config`) y `scheduled_transmissions` (`tenant_id`, `program_id`, `name`, `stream_url`, `rrule`,
    `timezone`, `starts_at`, `ends_at`, `duration_minutes`, `auto_start`, `pipeline_config`, `is_active`,
    `next_run_at`, `last_run_at`, `last_transmission_id`).
  - `src/server/lib/rrule.ts` — `nextOccurrence(rrule, from, timezone)`, `parseRRule`, `wallToUtcMs`.
    **La recurrencia ya está resuelta en `next_run_at`**: usá esa columna, no reimplementes RRULE.
  - `src/server/lib/scheduleRules.ts` — reglas puras de la agenda (validación, `occurrencesBetween`).
  - `src/server/services/jobSchedulerService.ts` — el scheduler **legacy** de `scheduled_jobs`
    (tabla distinta). **NO lo modifiques salvo que el brief lo pida**: este slice es el scheduler **nuevo**
    de `scheduled_transmissions`. Podés **reusar** sus ideas (intervalo de 60 s, límites de concurrencia,
    patrón de `setInterval` + `try/catch`).
  - `src/server/services/streamRecorderService.ts` — `startRecording(opts)` (creado en D2/PD-01).
  - `src/server/services/streamSourceResolver.ts` — `resolveStreamUrl` (creado en D2/PD-01).
  - `src/server/services/liveDetectorService.ts` — `detectLiveStream(url)`.
  - `src/server/routes/transmissions.ts` — router existente.
  - `src/server/index.ts` — donde se inicializa `initJobScheduler(io)`.
  - `src/server/db/schema/enums.ts` — `TransmissionStatus` (`scheduled|waiting|live|processing|done|error|canceled`).
  - `src/server/services/usageTracker.ts` — `checkUsageLimits(tenantId)` (quota). La Épica B dejó la cuota
    de transmisiones por plan; **mirá** cómo se valida el límite de transmisiones (`plans.transmissions_per_cycle`
    y `usage_cycles`/`usage_records`) y **aplicá el gate de cuota ANTES de dispatch** si la API existe y es
    usable sin refactor grande. Si el gate real de cuota no está disponible de forma simple, **implementá al
    menos la verificación de `max_transmission_minutes` del plan** (columna `plans.max_transmission_minutes`)
    contra `transmissions.duration_minutes`, y **dejá explícito** en el informe qué parte de la cuota no
    pudiste cubrir.

## Objetivo (AC principal)

> **AC: un stream que arranca 10 minutos tarde se captura igual.**

El scheduler dispara las transmisiones programadas **according a `next_run_at`**, y cuando el live **no está
todavía al aire** la transmisión queda en `waiting` y **reintenta la detección durante una ventana de
espera** (default 30 minutos, configurable) hasta que el stream aparece. Si la ventana se agota sin que
aparezca, la transmisión pasa a `error` con mensaje descriptivo.

## 1. Archivo nuevo: `src/server/services/transmissionSchedulerService.ts`

API pública:

```ts
export interface TransmissionSchedulerOptions {
  /** Ventana de espera por live, en minutos. Default 30. */
  waitingWindowMinutes?: number;
  /** Intervalo entre reintentos de detección, en ms. Default 2 min (120000). */
  retryIntervalMs?: number;
  /** Máximo de transmisiones concurrentes. Default 5. */
  maxConcurrent?: number;
  /** Inyectable para tests. */
  now?: () => Date;
}

export function initTransmissionScheduler(io: Server, opts?: TransmissionSchedulerOptions): void;
export function stopTransmissionScheduler(): void;

/** Loop interno: busca y dispara transmisiones vencidas. Exportado para tests. */
export async function checkAndRunScheduledTransmissions(opts?: TransmissionSchedulerOptions): Promise<void>;
```

### 1.1 Descubrimiento de transmisiones vencidas

- Query: `scheduled_transmissions` con `is_active = true` **AND** `auto_start = true` **AND**
  `next_run_at IS NOT NULL` **AND** `next_run_at <= now()`. **Siempre filtrá por `tenant_id` cuando toques
  `transmissions`** (la query sobre `scheduled_transmissions` también debe ser tenant-safe: como el scheduler
  es global, **no** filtrés por tenant en el SELECT, pero **todas** las queries que tocan `transmissions`
  (creación/actualización) **sí** filtran por su `tenant_id`).
- Para cada una:
  - **Idempotencia**: si ya existe una `transmission` con ese `scheduled_transmission_id` en estado
    `scheduled|waiting|live|processing` → **no** la dupliques (salteala). Esto evita doble disparo cuando el
    loop corre dos veces en el mismo minuto o tras reinicio.
  - Creá `transmissions` con: `tenant_id`, `program_id`, `scheduled_transmission_id`, `source: 'live_capture'`,
    `status: 'scheduled'`, `stream_url`, `duration_minutes`, `pipeline_config` (heredado del scheduled),
    `started_at: now`.
  - Actualizá `scheduled_transmissions`: `last_run_at: now`, `last_transmission_id: <nuevo id>`,
    `next_run_at: nextOccurrence(rrule, now, timezone)` (**en la timezone de la regla**, no la del server —
    esto es un requisito duro; `rrule.ts` ya lo hace bien, usalo).
    - Para una regla puntual (`FREQ=DAILY;COUNT=1`), `nextOccurrence` devuelve `null` → `next_run_at = null`
      (la única ocurrencia ya se consumió).
  - **Si el tenant no tiene suscripción activa** → no dispatches: marcá la transmisión como `error` con
    `error_message` descriptivo (o `canceled` — **decidí y documentá** cuál; lo natural es `error` con
    mensaje de suscripción). **Una transmisión activa NUNCA se corta por cuota** — acá no hay transmisión
    activa todavía, así que aplicar el gate antes de crear la captura es correcto.

### 1.2 Ventana de espera + reintentos (el AC)

Para cada transmisión recién creada (o en `waiting`):
1. **Chequeá si el live está al aire**: `detectLiveStream(streamUrl)` (o `resolveStreamUrl` — **usá el que
   exista**; `liveDetectorService.detectLiveStream` es el que ya existe).
2. Si **NO** está al aire:
   - Poné `transmissions.status = 'waiting'`, `waiting_since = now` (solo la primera vez; si ya estaba
     `waiting`, **no** reinicies `waiting_since` — es el ancla de la ventana).
   - Programá el **reintento** para dentro de `retryIntervalMs`.
   - **No** abandones la transmisión mientras `now - waiting_since < waitingWindowMinutes`.
   - **Caso crítico del AC**: si el stream arranca 10 minutos tarde y la ventana es de 30 min, la transmisión
     **sigue en `waiting`** y en el siguiente reintento (a los 2 min) la detección la encuentra → pasa a
     `live`. **Este flujo tiene que estar implementado y testeado.**
   - Si la ventana se agota → `status = 'error'`, `error_message` = "No se detectó live en la ventana de
     espera de N minutos" (con el detalle de la URL).
3. Si **SÍ** está al aire:
   - `status = 'live'`, `started_at = now` (o el `started_at` original — **decidí y documentá**; lo natural es
     que `started_at` sea el ancla wall-clock del **inicio de la captura**, no el del disparo).
   - **Arrancá la grabación** con `startRecording({ tenantId, transmissionId, streamUrl, maxDurationMinutes })`.
     **Es async y puede tardar horas** → **NO** la awaits bloqueando el loop: `void handle.done.then(...)` /
     `.catch(...)`, y actualizá `transmissions.status` cuando termine (`processing` → `done`/`error`,
     según lo que devuelva el recorder).
   - Cuando arranque la grabación, emití el evento Socket.IO correspondiente (ver slice D5 — si el helper de
     eventos ya existe, usalo; si no, dejá un TODO explícito y **no** inventes un sistema de eventos nuevo).

### 1.3 Límites

- `maxConcurrent` (default 5) transmisiones en `live|processing` simultáneas: si se alcanzó, **no** descartes
  nada — dejá la transmisión en `waiting` y reintentá después. **Nunca** descartes silenciosamente.
- El loop corre cada **60 segundos** (igual que `jobSchedulerService`). Todo el cuerpo del loop va envuelto en
  `try/catch`: **una falla nunca tumba el scheduler** ni el boot del server.

### 1.4 Reanudación tras reinicio del server

Al arrancar (`initTransmissionScheduler`), **reconciliá**: `transmissions` en estado `waiting` o `live` que
quedaron huérfanas de un proceso anterior (su `last_heartbeat_at` es viejo o su recording no existe) →
pasarlas a `error` con mensaje "servidor reiniciado durante la transmisión" (o reintentarlas — **decidí y
documentá**; lo más seguro para no perder crudo es marcarlas `error` **sin** borrar los segmentos ya
grabados, que quedan `active` y purgeables por retención).

## 2. Integración con el boot

- `src/server/index.ts`: llamá `initTransmissionScheduler(io)` **junto a** `initJobScheduler(io)`.
- Si el proyecto ya tiene un flag de `PROCESS_ROLE` (mirá `src/server/index.ts` — si existe, respetalo:
  el scheduler **no** debe arrancar en un proceso que sólo serves API). Si el flag no existe, **NO lo
  inventes en este slice**: arrancá el scheduler siempre y dejá un TODO.

## 3. Tests — `tests/transmissionScheduler.test.ts`

Tests **deterministas, sin red, sin timers reales**. Inyectá `now`, el detector de live, el recorder y el
store de DB (mocks). Patrón de mocks del repo: `vi.mock(p, async (io) => ({ ...await io(), factory: vi.fn() }))`
(mock **parcial**; un mock total rompe imports).

Casos OBLIGATORIOS:
1. **Stream al aire**: `detectLiveStream` → `{found: true}` → se crea `transmissions` con
   `source='live_capture'`, `status='live'`, y se llama `startRecording` con el `tenantId` correcto.
2. **AC — stream arranca tarde**: `detectLiveStream` devuelve `found:false` en los primeros N intentos y
   `found:true` después. Con `now` inyectado, la transmisión debe **seguir en `waiting`** (no `error`) y al
   detectarse debe pasar a `live` y arrancar la grabación. **Este test es el AC del ítem: es obligatorio.**
3. **Ventana agotada**: `found:false` siempre y `now` avanza más allá de la ventana → `status='error'` con
   mensaje que mencione la ventana de espera.
4. **Idempotencia**: si ya hay una `transmission` abierta para ese `scheduled_transmission_id`, el loop **no**
   crea otra.
5. **No se dispara si `is_active=false` o `auto_start=false`**.
6. **`next_run_at` se avanza** con `nextOccurrence(rrule, now, timezone)` — y para una regla puntual queda
   `null`.
7. **Tenant safety**: la `transmission` creada tiene `tenant_id` igual al de la `scheduled_transmission` (no
   uno del body/config).
8. **Concurrencia**: con `maxConcurrent` alcanzado, la transmisión **queda en `waiting`** (no se descarta,
   no pasa a `error`).

## Gates — TODOS tienen que dar EXIT 0 real

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
```

Si no tocás el schema, `drizzle-kit generate` debe imprimir **"No schema changes, nothing to migrate"**.
Si tocás el schema (ej. un índice nuevo), generá la migración idempotente `0012_...` y actualizá el verificador.

## Commit

- **UN commit** al final, con los gates verdes.
- Conventional Commits, español, **sin atribución a IA**, sin `Co-Authored-By`.
  - Sugerido: `feat(scheduler): worker de transmisiones programadas con ventana de espera`
- **Paths explícitos** (nunca `git add -A` / `git add .`).
- **NO** push, **NO** merge, **NO** deploy. **NO** agregues `remotion/package-lock.json`.

## Informe final (obligatorio, en español)

1. Archivos creados/modificados (paths).
2. Exit code real de los 5 gates + línea de resumen de vitest + salida final del PGlite.
3. Qué imprimió `drizzle-kit generate`.
4. SHA del commit + `git show --stat`.
5. `git status --short` final.
6. **Qué está verificado por test y qué NO** — en particular, explicitá que el test del AC (stream tardío) pasa
   y **pegalo resumido** (qué asserts lo cubren).
7. Decisiones: estado en falta de cuota, `started_at` semántica, reconciliación post-restart, y **qué parte
   del gate de cuota NO pudiste cubrir** (si aplica).
8. Límites/supuestos, explícito.

Nada de "debería funcionar".
