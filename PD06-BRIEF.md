# PD-06 — Retención del crudo por plan + job de purga

Ejecutá este brief **end-to-end, de forma totalmente autónoma**. No esperes aprobación de nadie.
Si un gate falla, arreglalo antes de reportar. **No dejes nada a medias.**

## Contexto del repo

- Worktree: el que ya tenés abierto. Rama de este slice: `pd-06-retention`.
- Stack: **Express 4 + TypeScript (ESM) + React 19 SPA + Drizzle ORM + Postgres (Neon)**.
- Contratos que ya existen (leelos primero y **reutilizalos**):
  - `src/server/db/schema/billing.ts` — tabla `plans`. **Ya tiene** `rawRetentionDays` → columna
    `raw_retention_days` (integer, nullable). **NO agregues la columna** — ya existe. Verificá su valor por
    defecto en los seeds (`src/server/services/planService.ts` / `scripts/seed-plans.ts`).
  - `src/server/db/schema/recordings.ts` — `stream_recordings` (columnas: `tenant_id`, `transmission_id`,
    `storage_prefix`, `status` `recording|completed|error`, `total_bytes`, `started_at`, `ended_at`) y
    `recording_segments` (`tenant_id`, `recording_id`, `sequence`, `start_ms`, `end_ms`, `file_ref`, `bytes`,
    `status` `active|corrupt|purged`).
  - `src/server/db/schema/transmissions.ts` — `transmissions` (`crudo_ref`, `ended_at`, `status`,
    `tenant_id`, `duration_minutes`).
  - `src/server/db/schema/subscriptions.ts` (dentro de `billing.ts`) — `subscriptions` con `tenant_id`,
    `plan_id`, `status`. Para saber el plan de un tenant.
  - `src/server/services/rawStorageService.ts` — `RawStorage` con `deletePrefix(prefix)` y
    `deleteFile(key)`. **Usá esto para borrar** — no borres con `fs` directo (perdés el saneo de path
    traversal).
  - `src/server/services/transmissionSchedulerService.ts` — el scheduler (D3/PD-03): **ya corre un loop
    de 60 s** y es el lugar natural para enganchar el job diario de purga.
  - `src/server/services/jobSchedulerService.ts` — el scheduler legacy: **mirá cómo hace el mantenimiento
    periódico** (`MAINTENANCE_EVERY_N_TICKS` con un contador) — es el patrón a reusar para un job diario.
  - `src/server/services/clipService.ts` — cómo el repo borra archivos temporales (patrón de cleanup).
  - `src/server/db/schema/clips.ts` — `clips`: los **assets derivados** que **NO** se deben borrar.
- Tests: `vitest`, en `tests/*.test.ts`.

## Objetivo

Implementar la **retención del crudo por plan** y el **job de purga**:
- El crudo (segmentos MP4) se conserva **`plans.raw_retention_days` días** desde el fin de la transmisión.
- Pasada la retención, un job **borra los archivos del storage** y marca los segmentos como `purged`,
  **sin borrar metadatos ni los clips/assets derivados**.

## 1. Servicio — `src/server/services/rawRetentionService.ts`

API:

```ts
export interface RetentionPolicy {
  tenantId: string;
  /** Días de retención del crudo. null = sin límite (no purgar). */
  retentionDays: number | null;
}

export interface PurgeCandidate {
  recordingId: string;
  tenantId: string;
  storagePrefix: string;
  /** Instante de fin de la transmisión (ancla de la retención). */
  endedAt: Date;
  daysOverdue: number;
}

export interface PurgeOutcome {
  scanned: number;
  purged: number;
  skipped: number;
  bytesFreed: number;
  errors: Array<{ recordingId: string; message: string }>;
}

/** Días de retención efectivos del tenant (según su plan). null = ilimitado. */
export async function getRetentionPolicy(tenantId: string): Promise<RetentionPolicy>;

/**
 * Grabaciones cuyo crudo venció la retención.
 * `now` inyectable para tests.
 */
export async function findExpiredRecordings(
  now: Date,
  opts?: { limit?: number },
): Promise<PurgeCandidate[]>;

/** Borra el crudo vencido: archivos + marca los segmentos purged. */
export async function purgeExpiredRecordings(
  now: Date,
  opts?: { limit?: number; dryRun?: boolean },
): Promise<PurgeOutcome>;

/** Etiqueta legible de la política, p.ej. "30 días" o "sin límite". */
export function describeRetention(policy: RetentionPolicy): string;
```

### 1.1 Política de retención
- Leé el plan del tenant vía `subscriptions` → `plans.raw_retention_days`.
- Si el tenant **no tiene** suscripción o plan → **no purgar** (`retentionDays: null` = sin límite). Es la
  decisión segura: nunca borras datos de un tenant sin plan definido.
- Si `raw_retention_days` es `null` en el plan → **sin límite** (no purgar).
- Si el plan dice `0` → interpreta como **sin límite** (0 días de retención borraría todo al día siguiente de
  la emisión, que no es la intención). **Decidí y documentá** esta interpretación.

### 1.2 Candidatos
- Una grabación es candidata cuando:
  - `stream_recordings.status = 'completed'` (no borres grabaciones en curso: `recording`),
  - su transmisión **terminó** (`transmissions.ended_at IS NOT NULL`),
  - `now - ended_at > retention_days` (días completos; usá días exactos, no redondees a la baja),
  - y **no** está ya purgada (los segmentos con `status='purged'` no cuentan; si **todos** los segmentos ya
    están `purged`, la grabación se considera purgada y no es candidata).
- **Toda query filtra por `tenant_id`** — regla dura del repo. Como el job es global, el SELECT puede traer
  varias transmisiones, pero **cada UPDATE/DELETE debe acotarse por `tenant_id`**.
- `limit` por defecto (p.ej. 100) para que el job no bloquee la DB de una vez.

### 1.3 Purga — el paso importante
Para cada candidata:
1. **Verificá que no haya renders de clips pendientes** que referencien ese crudo. Buscá en `clips` (y en
   cualquier tabla de jobs pendientes que exista — **mirá** `src/server/db/schema/jobs.ts`: `job_executions`
   —) si hay un clip **en estado no terminal** (p.ej. `generating`) cuya transmisión sea esa.
   - Si **sí** hay renders pendientes → **NO borres** el crudo: marcá la candidata como `skipped` y **no** la
     borres. (Requisito de la spec: "purga de un crudo aún referenciado por render de clip pendiente → el
     render completa primero".)
2. **Borrá los archivos** con `RawStorage.deletePrefix(storagePrefix)`.
3. **Marcá** los `recording_segments` con `status = 'purged'` (NO los borres: los metadatos sobreviven) y
   `stream_recordings.status` → **mantenelo** como `completed` (o un estado nuevo — **decidí y documentá**;
   lo natural es dejar la fila y marcar los segmentos `purged`, para que el historial siga visible).
4. **Liberá `transmissions.crudo_ref`** (ponelo `null`): el crudo ya no existe, dejar el ref sería mentir.
   **NO** borres la fila `transmissions` ni los `clips` derivados — **los clips y assets sobreviven**.
5. Sumá los bytes liberados (`total_bytes` de la grabación).
6. Si algo falla → registrá el error en `errors[]` y **seguí** con la siguiente candidata (una falla no
   aborta el job).

### 1.4 `dryRun`
- Con `dryRun: true` **no** borra nada ni actualiza filas: sólo calcula y devuelve `PurgeOutcome` con
  `scanned`/`purged` (los que *serían* purgados) y `bytesFreed` estimado. Sirve para el panel y los tests.

## 2. Job diario — enganche en el scheduler

- `src/server/services/transmissionSchedulerService.ts` ya tiene un loop de 60 s con un contador de
  mantenimiento (mirá el patrón de `jobSchedulerService.ts`: `MAINTENANCE_EVERY_N_TICKS`). **Reusá ese patrón**
  para ejecutar la purga **una vez por día**.
- **No** invoques la purga en cada tick (es I/O pesada). Usá un contador de ticks **y** una marca de última
  ejecución (en memoria es suficiente; si el server reinicia, purga de nuevo — es idempotente).
- La purga **nunca** debe tumbar el scheduler: todo en `try/catch`.
- Configurable por env: `RETENTION_PURGE_INTERVAL_MINUTES` (default 1440 = 24 h) y
  `RETENTION_PURGE_ENABLED` (default true) — para poder apagarlo sin deploy.

## 3. Exposición (mínima)

- `GET /api/transmissions/retention` (con `requireAuth`): devuelve la política del tenant
  (`{ retentionDays, label }`) y un **resumen** (cuántas grabaciones están candidatas, cuántas se purgarían).
  **Sin datos de otros tenants.**
- Si agregás el botón de purga manual: `POST /api/transmissions/retention/purge` (con `requireAuth` +
  `requireActiveSubscription`) → ejecuta `purgeExpiredRecordings(now, { dryRun: false })` y devuelve el
  `PurgeOutcome`. **Decidí si lo exponés o no** — si lo exponés, sólo para roles owner/editor (mirá el
  middleware de roles del repo: `requireRole`).

## 4. Tests — `tests/rawRetentionService.test.ts`

Tests deterministas, con DB mockeada y `now` inyectado.

Casos OBLIGATORIOS:
1. **Política**: tenant con plan de 30 días → `retentionDays = 30`. Tenant sin plan → `null` (sin límite).
   Plan con `raw_retention_days = null` → `null`. Plan con `0` → `null` (sin límite) — **el caso de la
   interpretación documentada**.
2. **No candidata**: grabación `status='recording'` (en curso) → **no** se purga.
3. **No candidata**: transmisión sin `ended_at` → **no** se purga.
4. **Candidata**: grabación completada hace 31 días con retención 30 → **es** candidata.
5. **Frontera exacta**: grabación terminada hace exactamente 30 días → **NO** es candidata (la retención
   incluye el día 30; se purga al superarla).
6. **Purga real**: `purgeExpiredRecordings` borra el prefijo del storage (verificá que se llamó
   `deletePrefix` con el `storage_prefix` correcto), marca los segmentos `purged` (NO los borra), y pone
   `transmissions.crudo_ref = null`.
7. **Los clips derivados sobreviven**: el `PurgeOutcome` no toca la tabla `clips` (verificá que no hay
   DELETE/UPDATE sobre clips).
8. **Render pendiente**: con un clip en estado `generating` para esa transmisión → la candidata se **saltea**
   (`skipped`), **no** se borra el storage y **no** se marcan los segmentos.
9. **`dryRun`**: no borra archivos ni actualiza filas, pero devuelve los conteos esperados.
10. **Tenant safety**: el UPDATE de segmentos está acotado por `tenant_id`.

**Patrón de mocks del repo**: `vi.mock(p, async (io) => ({ ...await io(), factory: vi.fn() }))` (mock
**parcial**; un mock total rompe imports). Para el storage, inyectá un `RawStorage` fake que registre las
llamadas.

## Gates — TODOS tienen que dar EXIT 0 real

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
```

Si no tocás el schema, `drizzle-kit generate` debe imprimir **"No schema changes, nothing to migrate"**.
Si tocás el schema, migración idempotente `0012_...` + verificador PGlite actualizado.

## Commit

- **UN commit** al final, con los gates verdes.
- Conventional Commits, español, **sin atribución a IA**, sin `Co-Authored-By`.
  - Sugerido: `feat(retention): purga del crudo por retención de plan`
- **Paths explícitos** (nunca `git add -A` / `git add .`).
- **NO** push, **NO** merge, **NO** deploy. **NO** agregues `remotion/package-lock.json`.

## Informe final (obligatorio, en español)

1. Archivos creados/modificados (paths).
2. Exit code real de los 5 gates + línea de resumen de vitest + salida final del PGlite.
3. Qué imprimió `drizzle-kit generate`.
4. SHA del commit + `git show --stat`.
5. `git status --short` final.
6. **Qué está verificado por test y qué NO** — en particular, explicitá cómo verificaste que **los clips
   derivados sobreviven** y que el **render pendiente bloquea la purga**.
7. Decisiones: interpretación de `raw_retention_days = 0`, estado de `stream_recordings` tras purgar, si
   exponiste el botón manual y con qué guard de rol.
8. Límites/supuestos, explícito.

Nada de "debería funcionar".
