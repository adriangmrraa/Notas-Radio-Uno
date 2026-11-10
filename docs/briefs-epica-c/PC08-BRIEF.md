# PC-08 — Agenda (UI): crear/editar transmisión programada (fecha o semanal), auto-start, calendario

Ejecutá este brief **end to end, de forma autónoma**. Nunca esperes aprobación. Si algo del brief es imposible,
NO lo simules: dejalo sin hacer, explicá por qué y seguí con el resto.

## Objetivo del slice

La **agenda del canal**: el cliente programa sus emisiones (una fecha puntual o una recurrencia semanal) y las ve
en un calendario. Esta slice es la **capa de gestión** sobre el schema que ya existe.

## Contexto real (verificado)

- Repo `periodistapp`: **Express 4 + TypeScript (API) + React SPA (Vite) + Drizzle/Postgres**.
- Base: `origin/master` @ `e9d2781` (PC-01..PC-07 ya integrados).
- **PC-07 ya dejó el schema** (`src/server/db/schema/transmissions.ts`):
  - `scheduled_transmissions`: `id`, `tenant_id` (NOT NULL), `program_id` (nullable FK), `name` (varchar 255 NOT NULL),
    `description`, `stream_url` (text NOT NULL), **`rrule` varchar(255) NOT NULL**, **`timezone` varchar(64) NOT NULL
    default `'America/Argentina/Buenos_Aires'`**, `starts_at` (timestamptz NOT NULL), `ends_at` (nullable),
    `duration_minutes` (int NOT NULL default 60), **`auto_start` boolean NOT NULL default true**,
    `pipeline_config` jsonb, `is_active` bool, `next_run_at`, `last_run_at`, `last_transmission_id`,
    `created_at`, `updated_at`.
  - `transmissions`: `id`, `tenant_id`, `program_id`, `scheduled_transmission_id`, `source`, `status`, `stream_url`,
    `resolved_stream_url`, `crudo_ref`, `duration_minutes`, `started_at`, `ended_at`, `waiting_since`,
    `last_heartbeat_at`, `error_message`, `pipeline_config`, timestamps.
- **PC-07 también dejó `src/server/lib/rrule.ts`** con `parseRRule`, `nextOccurrence(rrule, from, timezone)` y
  `describeRRule(rrule)` — **usalo, no reescribas un parser**. La aritmética de fechas va en la timezone de la regla.
- **Ya existe una página de "Programados"**: `src/client/pages/ScheduledJobsPage.tsx` (jobs existentes, tabla con
  `useApi()`), y la ruta `/scheduled` + ítem de nav "Programados" en `src/client/components/Sidebar.tsx` (`NAV_MAIN`).
  **No la toques**: la agenda de transmisiones es una pantalla **nueva y distinta** (RRULE + calendario), no una
  extensión de los jobs.
- **Existe `src/client/pages/ProgramsPage.tsx`** (CRUD de programas + invitados, con dialogs) — es la referencia
  de estilo para un CRUD con modal en este repo.
- **Ya existe `src/server/routes/programs.ts`** (patrón de API con `requireAuth` + `req.auth!.tenantId` + `and(eq(...id),
  eq(...tenantId))` + 404 para ids ajenos) y `src/server/routes/editorial.ts` (API con upsert, padrão de este slice).

## Decisiones de diseño (aplicalas)

1. **Dos modos de recurrencia**:
   - **Puntual** (one-shot): una fecha/hora concreta ⇒ RRULE generado como `FREQ=DAILY;COUNT=1` con `starts_at`
     en ese instante. (Alternativa equivalente: `FREQ=YEARLY;BYMONTH=..;BYMONTHDAY=..` — **elegí una y
     documentá**; `FREQ=DAILY;COUNT=1` es más simple de calcular y de describir.)
   - **Semanal** (recurring): días de la semana + hora ⇒ `FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0`.
   - Opcionalmente **diario**: `FREQ=DAILY;BYHOUR=..;BYMINUTE=..`. Si lo soportás, sumalo al selector de modo.
   El usuario **no escribe RRULE a mano**: lo arma la UI. (Opcional: mostrar el RRULE resultante en lectura, y
   permitir editarlo como texto avanzado **sólo si valida** con `parseRRule` — si no, no lo hagas.)
2. **`timezone`**: la UI debe ofrecer una lista de zonas horarias frecuentes (incluida `America/Argentina/Buenos_Aires`)
   y mostrar la hora local de la emisión en esa zona. El servidor puede estar en UTC: **nunca** calcules "hoy" con la
   fecha del server.
3. **`next_run_at`**: se calcula en el servidor al crear/editar con `nextOccurrence(rrule, starts_at, timezone)`.
   Si devuelve `null` (regla vencida) ⇒ **400** con mensaje claro ("esa recurrencia ya terminó").
4. **Auto-start**: `auto_start` es un toggle de la agenda. **Este slice NO implementa el worker que dispara la
   transmisión** (eso es PD-03, Épica D). Lo que sí debe existir es el **endpoint de disparo manual**:
   `POST /api/transmissions/scheduled/:id/start` que **crea una fila en `transmissions`** con
   `source='manual'`, `status='scheduled'`, `stream_url` heredada, `pipeline_config` heredada,
   `scheduled_transmission_id` y `program_id` de la agenda. Es el "auto-start" manual y deja el circuito preparado
   para que el worker de PD-03 reuse la misma lógica.
   Si `auto_start=false`, el endpoint manual **igual funciona** (disparo manual explícito del usuario) — el toggle
   sólo governa el disparo automático futuro.
5. **Aislamiento**: toda query filtra por `tenant_id` del `req.auth`. `programId` de otro tenant ⇒ 404/400.
   El `tenant_id` nunca viene del body.

## Qué hay que construir

### 1. API — `src/server/routes/transmissions.ts` (nuevo)

Router con `requireAuth` en todas las rutas (mismo patrón que `editorial.ts`):

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/transmissions/scheduled` | Lista las transmisiones programadas del tenant, con `programName` (join), `description` del RRULE (`describeRRule`), `nextRunAt` y `lastRunAt`. |
| POST | `/api/transmissions/scheduled` | Crea una transmisión programada. Body: `{ name, description?, streamUrl, programId?, mode: 'once'\|'weekly'\|'daily', date?, time, daysOfWeek?, timezone, durationMinutes, autoStart, pipelineConfig?, endsAt? }`. Valida: `name` no vacío, `streamUrl` URL http(s) válida, `durationMinutes` 5..480, `time` `HH:MM`, `daysOfWeek` requerido en modo weekly (1..7), `timezone` válida (IANA — validá con `Intl.DateTimeFormat`), `programId` del tenant si viene. Calcula `rrule` + `starts_at` + `next_run_at` con la lib de PC-07. **400** con mensaje claro en cada error. |
| GET | `/api/transmissions/scheduled/:id` | Detalle de una entrada de agenda (404 si es de otro tenant). |
| PUT | `/api/transmissions/scheduled/:id` | Actualiza (mismas validaciones). Recalcula `rrule`, `starts_at` y `next_run_at`. |
| DELETE | `/api/transmissions/scheduled/:id` | Borra la entrada de agenda. Si tiene `transmissions` vinculadas (`last_transmission_id` o filas con `scheduled_transmission_id`), **no borres filas de `transmissions`**: el borrado de la agenda no debe borrar el historial ⇒ usá `ON DELETE SET NULL` (ya está en el schema) y verificá que la fila `transmissions` queda con `scheduled_transmission_id = NULL`. |
| POST | `/api/transmissions/scheduled/:id/start` | Dispara la transmisión: crea la fila en `transmissions` (§2.4) y devuelve `{ transmission }`. |
| GET | `/api/transmissions` | Lista las **corridas** (`transmissions`) del tenant, con filtro opcional `?status=` y `?limit=`. Sirve para mostrar "últimas emisiones" y el estado de cada corrida. |

- Montá el router en `src/server/index.ts` (`app.use("/api/transmissions", transmissionsRouter)`).
- Si el repo tiene una gate de suscripción para crear recursos (mirá `requireActiveSubscription` en
  `src/server/middleware/auth.ts` y cómo se usa en `routes/pipeline.ts`), aplicala **si** es lo que corresponde para
  una Transmission programada; si no, no inventes una gate nueva.

### 2. UI — `src/client/pages/AgendaPage.tsx` (nuevo)

- Ruta `/agenda` en `src/client/main.tsx` (dentro del bloque `PrivateRoute` + `Layout`) + ítem de nav en
  **`src/client/components/Sidebar.tsx`** (`NAV_MAIN`, icono de lucide-react, ej. `CalendarDays`).
- La página tiene:
  1. **Vista calendario** (mensual, del mes actual, con navegación mes anterior/siguiente): cada día muestra las
     emisiones programadas de ese día. Muestra la **hora en la timezone de cada entrada** (no la del server).
  2. **Vista lista** (alternativa o complementaria): tabla con nombre, programa, recurrencia (descripción en español),
     próxima emisión, auto-start (sí/no), activa, acciones.
  3. **Crear/editar** (modal): nombre, URL del stream, programa (opcional, del tenant), **modo** (puntual / semanal /
     diario), fecha (si puntual), hora, días de la semana (si semanal), timezone, duración, auto-start,
     topics/temas prohibidos **NO** (eso es la línea editorial, otro módulo), `pipelineConfig` opcional
     (tono/estructura/autoPublish — el repo ya usa esos nombres en `ScheduledJobsPage`).
  4. **Disparar ahora** (botón por entrada) → llama al endpoint de start y muestra la transmisión creada.
  5. **Activar/desactivar** y **borrar** (con confirmación).
- Estados: carga, vacío honesto ("Todavía no hay transmisiones programadas"), errores visibles.
- Usá `useApi()` y los componentes/estilos de `src/client/components/ui/`. Nada de datos inventados.
- **No** implementes un worker ni timers de auto-start en el cliente (PD-03 lo hace en el servidor).

### 3. Tests (obligatorios)

`npx vitest run` verde. Lo testeable sin DB:
- La **construcción del RRULE** desde el input de la UI: modo puntual ⇒ `FREQ=DAILY;COUNT=1`; semanal con
  días [1,3,5] y hora 18:00 ⇒ `FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0`; diario ⇒ `FREQ=DAILY;BYHOUR=..`.
  Extraé esa función a un módulo testeable (ej. `src/server/lib/scheduleRules.ts` o similar) y testeala.
- El cálculo de `starts_at` a partir de fecha + hora + timezone (que la fecha local correcta se convierta al instante
  UTC correcto): un caso con `America/Argentina/Buenos_Aires` que **difiera** del caso UTC ⇒ prueba que la tz manda.
- Validaciones: `durationMinutes` fuera de 5..480 ⇒ error; `time` inválida ⇒ error; `daysOfWeek` vacío en modo weekly
  ⇒ error; RRULE que ya venció ⇒ error.
- Si el repo tiene forma de testear rutas (mirá cómo PC-04/PC-05 testearon servicios), cubrí al menos la lógica de
  validación del body **sin HTTP** (función pura).

## Verificación (exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

`npm run build` debe seguir imprimiendo **"No schema changes, nothing to migrate"** (si genera migración, hay drift:
revisá que no hayas tocado el schema).

## Fuera de scope (NO lo implementes)

- El **worker/scheduler** que dispara las transmisiones automáticamente (PD-03, Épica D), los estados
  `waiting/live/processing` en vivo, Socket.IO, la ingesta de video y el crudo (PD-01/PD-02/PD-04).
- **PC-09** (dossier), **PC-10** (onboarding).
- No modifiques `scheduled_jobs` / `ScheduledJobsPage` / `jobSchedulerService`.
- No cambies el schema: **NO toques** `drizzle/`, `drizzle/meta/` ni `src/server/db/schema/` (si encontrás un error
  real de schema, documentalo en el reporte, no lo arregles).
- No agregues dependencias (vitest ya está). No instales una librería de calendario: **armá el calendario a mano**
  con CSS/grid (el repo no tiene ninguna).

## Límites duros

- **NO push**, **NO merge** a master, **NO deploy**.
- **NO toques** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`: todo en este worktree.
- **NO uses `git add -A` ni `git add .`**: commit con **paths explícitos**.
- Commit **conventional** (`feat(agenda): ...`), **sin atribución de IA**, sin `Co-Authored-By`.
- No borres ni reescribas untracked preexistentes.
- Si algo es imposible, no lo simules: explicá por qué en el reporte y seguí con el resto.

## Reporte final (obligatorio)

1. SHA del commit + `git show --stat`.
2. Exit code de cada gate + la línea "No schema changes…" del build + línea de resumen de vitest.
3. Endpoints creados (método + ruta + código de estado) y rutas de UI agregadas.
4. Ejemplo concreto de RRULE generado por cada modo (puntual / semanal / diario) y cómo se calcula `starts_at` +
   `next_run_at` con la timezone.
5. Qué hace el endpoint de disparo manual y qué queda para PD-03.
6. Cómo se comprueba el aislamiento multi-tenant.
7. Qué quedó fuera y por qué.
