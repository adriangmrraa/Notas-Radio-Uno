# PC-08 QA FINAL — read-only, contexto fresco

Revisá el commit `512c7aa` de la rama `pc-08-agenda-ui` contra la base `e9d2781`. **Read-only**: no modifiques,
no stages, no commitees, no push, no merge, no deploy. `PC08-QA-BRIEF.md` puede quedar untracked.

## Contexto

PC-08 = **agenda de transmisiones**: API `/api/transmissions/*` + UI `AgendaPage` (`/agenda`) con calendario
mensual, lista, modal CRUD y disparo manual. Schema ya existía (PC-07: `scheduled_transmissions` + `transmissions`
+ `src/server/lib/rrule.ts`). El commit agrega `src/server/routes/transmissions.ts` (7 endpoints),
`src/server/lib/scheduleRules.ts` (capa pura UI→RRULE), `src/client/pages/AgendaPage.tsx` (729 líneas),
`tests/scheduleRules.test.ts` (285 líneas), ruta `/agenda` + nav, y **exporta** `wallToUtcMs` desde `rrule.ts`
(1 línea de diff).

## Qué auditar

### 1. API — 7 endpoints, contrato y validaciones
Rutas esperadas: `GET|POST /api/transmissions/scheduled`, `GET|PUT|DELETE /api/transmissions/scheduled/:id`,
`POST /api/transmissions/scheduled/:id/start`, `GET /api/transmissions`.
- ¿Están todas montadas (`app.use("/api/transmissions", ...)` en `src/server/index.ts`)?
- `requireAuth` en todas.
- **Validaciones del body**: `name` no vacío, `streamUrl` URL http(s), `durationMinutes` 5..480, `time` `HH:MM`,
  `daysOfWeek` requerido en modo weekly, `timezone` IANA válida, `programId` del tenant, `mode` válido.
  ¿Cada error devuelve **400 con mensaje claro** (no 500)? ¿El body puede meter `tenantId`/`id` y sobrescribir algo?
- **Disparo manual** (`POST .../start`): ¿crea la fila en `transmissions` con `source='manual'`, `status='scheduled'`,
  `stream_url` y `pipeline_config` heredadas, `scheduled_transmission_id` y `program_id` de la agenda? ¿Actualiza
  `last_run_at`/`last_transmission_id` de la agenda?
- **DELETE de la agenda**: ¿las filas de `transmissions` quedan con `scheduled_transmission_id = NULL` (no se borra
  historial)? ¿Qué pasa con `last_transmission_id` (FK `set null`)?
- ¿El listado de `transmissions` acepta `?status=` y `?limit=` y valida ambos?

### 2. Aislamiento multi-tenant
- Cada query filtra por `tenant_id` del `req.auth`.
- `id` de agenda de otro tenant ⇒ **404** en GET/PUT/DELETE/start.
- `programId` de otro tenant ⇒ 400/404 (no se inserta la relación).
- El `tenant_id` nunca viene del body.

### 3. RRULE: construcción desde la UI + timezone
- `scheduleRules.ts`: modo puntual ⇒ ¿`FREQ=DAILY;COUNT=1`? semanal con días [1,3,5] 18:00 ⇒
  `FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0`? diario ⇒ `FREQ=DAILY;BYHOUR=..;BYMINUTE=..`?
- `starts_at`: ¿se calcula con la **timezone de la entrada** (no la del server)? Test BA vs UTC: los instantes
  deben diferir.
- `next_run_at`: ¿se calcula con `nextOccurrence(rrule, starts_at, timezone)`? Si la regla ya venció ⇒ **400**.
- ¿La UI deja escribir RRULE a mano? Si sí, ¿valida con `parseRRule`?
- **Ojo**: `rrule.ts` tuvo **1 línea** de diff (exportar `wallToUtcMs`). Verificá que ese cambio no alteró el
  comportamiento de `nextOccurrence` (los tests de PC-07 deben seguir verdes).

### 4. UI (`AgendaPage.tsx`)
- Ruta `/agenda` dentro del bloque `PrivateRoute` de `main.tsx`; nav en `Sidebar.tsx` (`NAV_MAIN`) con icono que
  **exista** en la versión de lucide-react instalada (el agente chequeó `CalendarDays` — confirmalo).
- Calendario mensual **armado a mano** (sin librería nueva): ¿muestra las emisiones del mes en la **timezone de
  cada entrada**? ¿navega mes anterior/siguiente? ¿muestra las de hoy?
- Modal crear/editar con los modos (puntual/semanal/diario), hora, días, timezone, duración, auto-start.
- Disparar ahora, activar/desactivar, borrar con confirmación.
- Estados de carga / vacío honesto / errores visibles. Usa `useApi()`.
- ¿La UI calcula "hoy" con la fecha del **browser** en vez de la tz de la entrada? (Puede ser un bug menor de
  bordes: marcá si el día se calcula en UTC vs local.)

### 5. Tests
- `tests/scheduleRules.test.ts`: ¿prueba la construcción del RRULE por modo, `starts_at` con tz, y las
  validaciones? ¿Qué queda sin probar (p.ej.: la capa HTTP, la escritura en DB)?
- Suite completa verde (esperado: 5 files / 103 tests).

### 6. Scope
- `scheduled_jobs` / `ScheduledJobsPage` / `jobSchedulerService` **NO** tocados.
- `drizzle/`, `drizzle/meta/`, `src/server/db/schema/` NO tocados.
- Sin dependencias nuevas. Sin worker/scheduler (PD-03), sin estados en vivo, sin Socket.IO.

### 7. Gates (a completion, exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check e9d2781..HEAD
git status --short
```

Ojo: el runner PGlite puede fallar con `stdin is not a tty` de forma **transitoria** (ya se vio en otros slices).
Si te pasa, **re-corré** y reportá el resultado de la corrida que terminó: si el script es correcto, la 2ª corrida da 0.

## Salida

**GO** o **NO-GO** estricto. CRITICALS primero (archivo:línea + escenario concreto). Después warnings.
Exit codes + línea de resumen de vitest. Lo no verificado, explícito.
