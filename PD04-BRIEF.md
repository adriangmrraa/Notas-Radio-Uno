# PD-04 — Estados de transmisión + eventos Socket.IO

Ejecutá este brief **end-to-end, de forma totalmente autónoma**. No esperes aprobación de nadie.
Si un gate falla, arreglalo antes de reportar. **No dejes nada a medias.**

## Contexto del repo

- Worktree: el que ya tenés abierto. Rama de este slice: `pd-04-states-socket`.
- Stack: **Express 4 + TypeScript (ESM) + React 19 SPA + Drizzle ORM + Postgres (Neon)** + **Socket.IO 4**.
- Contratos que ya existen (leelos primero y **reutilizalos**):
  - `src/server/db/schema/transmissions.ts` — tabla `transmissions`.
  - `src/server/db/schema/enums.ts` — `TransmissionStatus`: `scheduled | waiting | live | processing | done | error | canceled`.
  - `src/server/services/transmissionSchedulerService.ts` — el scheduler (creado en el slice D3/PD-03) que
    ya mueve transmisiones entre estados y arranca la grabación.
  - `src/server/services/streamRecorderService.ts` — `startRecording` (D2/PD-01).
  - `src/server/index.ts` — donde se crea el servidor Socket.IO (`new Server(httpServer, {...})`) y donde se
    inicializan los schedulers (`initJobScheduler(io)`).
  - `src/server/services/notificationService.ts` — patrón de eventos Socket.IO ya usado en el repo.
  - `src/server/services/pipelineService.ts` — cómo emite eventos durante el pipeline (`io.emit(...)`).
  - `src/client/hooks/useSocket.ts` — el hook cliente que ya se conecta al socket (lee `localStorage.accessToken`
    y lo manda en `auth: { token }`).
  - `src/client/hooks/useLiveAlerts.ts` — ejemplo de hook que escucha eventos del socket.
- Tests: `vitest`, en `tests/*.test.ts`.

## Objetivo

1. **Una máquina de estados (FSM) explícita y testeable** para las transmisiones:
   `scheduled → waiting → live → processing → done | error | canceled`.
2. **Eventos Socket.IO** emitidos en **cada transición**, por **room de tenant**, para que la UI se entere
   en vivo.

## 1. FSM pura — `src/server/lib/transmissionStateMachine.ts`

**Función pura, sin DB, sin IO, sin Socket.IO.** Esto es lo que la hace testeable.

```ts
import type { TransmissionStatus } from '../db/schema/enums.js';

export interface TransitionContext {
  tenantId: string;
  transmissionId: string;
  from: TransmissionStatus;
  to: TransmissionStatus;
  now: Date;
  /** Datos de la transición (error, crudo_ref, started_at, etc.). */
  payload?: Record<string, unknown>;
}

export interface TransitionDecision {
  allowed: boolean;
  /** Razón del rechazo, en español. */
  reason?: string;
}

export function canTransition(from: TransmissionStatus, to: TransmissionStatus): boolean;
export function transition(from: TransmissionStatus, to: TransmissionStatus): TransitionDecision;
export const TRANSMISSION_TRANSITIONS: Readonly<Record<TransmissionStatus, readonly TransmissionStatus[]>>;
```

Aristas permitidas (según la spec `stream-recording`):

| Desde | Hacia |
|---|---|
| `scheduled` | `waiting`, `live`, `error`, `canceled` |
| `waiting` | `live`, `error`, `canceled` |
| `live` | `processing`, `error`, `canceled` |
| `processing` | `done`, `error` |
| `done` | — (terminal) |
| `error` | — (terminal) |
| `canceled` | — (terminal) |

Reglas:
- **Una transición a un estado terminal desde un estado terminal es inválida.**
- **Transición a un estado idéntico** (`from === to`) es inválida (excepto `error → error` que puede ser un
  re-registro de error: **decidí y documentá**; lo más simple es **permitir** `error → error` como
  actualización del mensaje — hacelo así y dejalo escrito).
- `canTransition` es la forma rápida; `transition` es la que devuelve el motivo del rechazo.

## 2. Servicio — `src/server/services/transmissionService.ts`

Envoltorio con DB + eventos. Debe ser **el único lugar** por el que se cambia el estado de una transmisión
(así nadie se saltea la FSM). API:

```ts
export interface TransitionOptions {
  tenantId: string;
  transmissionId: string;
  to: TransmissionStatus;
  /** Mensaje de error (para `to='error'`). */
  errorMessage?: string;
  /** Campos extra a setear en la misma transaction (crudo_ref, started_at, ended_at, resolved_stream_url...). */
  patch?: Partial<{
    crudoRef: string | null;
    resolvedStreamUrl: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    waitingSince: Date | null;
    lastHeartbeatAt: Date | null;
    durationMinutes: number | null;
  }>;
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  transmission?: TransmissionRow;
}

export async function transitionTransmission(opts: TransitionOptions): Promise<TransitionResult>;
```

Comportamiento:
1. **Leé** la transmisión filtrando por `tenant_id` **y** `id` (query tenant-safe; si no existe o es de otro
   tenant → `ok:false`, razón "transmisión no encontrada"). **Nunca** reveles si el recurso es de otro tenant.
2. Validá la transición con la FSM. Si es inválida → `ok:false` con el motivo. **No** hagas UPDATE.
3. **En una `db.transaction`**: actualizá `transmissions` con `status = to` + los campos de `patch` +
   `updated_at`.
   - Al pasar a `live`: `started_at = now` (si no viene en patch).
   - Al pasar a `waiting`: `waiting_since = now` **solo si estaba en `null`** (no lo reinicies: es el ancla de
     la ventana de espera).
   - Al pasar a `processing`: `ended_at = now` (si no viene en patch).
   - Al pasar a `done` / `error` / `canceled`: `ended_at = now` (si no viene en patch).
   - Al pasar a `error`: `error_message = errorMessage`.
4. **Emití el evento Socket.IO** (ver punto 3) **después** de que la transaction commitee (nunca emitás un
   estado que no quedó persistido).
5. Devolvé la fila actualizada.

**Regla dura:** `tenant_id` en toda query.

## 3. Eventos Socket.IO

### 3.1 Rooms

- Cada tenant tiene su room: **`tenant:{tenantId}`**. Los clientes se unen al room de su tenant.
- Cada transmisión tiene su room: **`transmission:{transmissionId}`** (para la sala "En vivo" de PD-05).
- **El room de la transmisión debe ser verificable contra el tenant**: un cliente de otro tenant **no** puede
  unirse a un room de transmisión ajeno. Implementá un helper de autorización por room.

### 3.2 Eventos emitidos

En **cada** transición, emití **dos** eventos:

| Evento | Payload | Para quién |
|---|---|---|
| `transmission:status` | `{ transmissionId, tenantId, status, previousStatus, startedAt, endedAt, errorMessage, crudoRef, updatedAt }` | room `transmission:{id}` + room `tenant:{tenantId}` |
| `transmission:updated` | el objeto transmisión completo serializado | room `tenant:{tenantId}` |

Payload **sin secretos**: nunca claves, tokens, URLs firmadas ni credenciales.

### 3.3 Suscripción del cliente a rooms (autorización)

En `src/server/index.ts` (donde se configura el `io`):
- `io.use(...)` — middleware de autenticación del socket: leé el token del handshake (`socket.handshake.auth.token`)
  y **verificá** el JWT + que la membresía del tenant siga activa (mirá cómo lo hace `src/server/middleware/auth.ts`
  y `src/server/services/membershipService.ts`). Si no es válido → `next(new Error('unauthorized'))`.
- `io.on('connection', ...)`:
  - `socket.join('tenant:' + tenantId)` automáticamente (el tenant sale del token, **nunca** del cliente).
  - Handler `transmission:subscribe` con payload `{ transmissionId }`: verificá que la transmisión **pertenece al
    tenant del socket** (query tenant-safe) → `socket.join('transmission:' + id)`. Si no pertenece → emití
    `transmission:error` con `{ message }` y **no** lo unas.
  - Handler `transmission:unsubscribe` → `socket.leave(...)`.

**No** confíes en el `tenantId` que mande el cliente. **No** permitas unirse a un room de tenant arbitrario.

### 3.4 Cliente

`src/client/hooks/useSocket.ts`:
- Ya se conecta con `auth: { token }`. **Mantené** ese contrato.
- Agregá un helper tipado para suscribirse a los eventos de transmisión, y **un room por tenant no se elige
  desde el cliente** (el servidor lo decide).
- Tipá los payloads de `transmission:status` / `transmission:updated` (en `src/shared/types.ts` o en un
  `src/client/types/` nuevo — seguí la convención del repo).

## 4. Tests — `tests/transmissionStateMachine.test.ts` + `tests/transmissionService.test.ts`

### 4.1 FSM (pura, sin mocks)
- Todas las aristas de la tabla son permitidas.
- Todas las combinaciones **no** listadas son rechazadas (test exhaustivo sobre las 7×7 combinaciones — es
  barato y es la garantía real).
- Estados terminales no tienen aristas salientes.
- `error → error` permitido (actualización de mensaje); `done → done` rechazado.
- El motivo del rechazo es un string en español no vacío.

### 4.2 Servicio (con DB mockeada)
- Transición válida → hace UPDATE con `tenant_id` en el WHERE y emite el evento.
- Transición inválida → **no** hace UPDATE, devuelve `ok:false` con motivo.
- Transmisión de **otro tenant** → `ok:false` ("no encontrada") y **no** emite evento.
- Pasar a `waiting` dos veces **no** reinicia `waiting_since`.
- Pasar a `error` setea `error_message`.
- El evento se emite **después** del commit (verificá el orden con un mock que registre la secuencia).

### 4.3 Autorización de rooms
- Socket con token válido → se une a `tenant:{suTenantId}`.
- `transmission:subscribe` con una transmisión **de otro tenant** → **no** se une al room de transmisión.
- Socket sin token / token inválido → conexión rechazada.

**Patrón de mocks del repo**: `vi.mock(p, async (io) => ({ ...await io(), factory: vi.fn() }))` (mock
**parcial**; un mock total rompe imports).

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
  - Sugerido: `feat(transmissions): FSM de estados y eventos Socket.IO por room de tenant`
- **Paths explícitos** (nunca `git add -A` / `git add .`).
- **NO** push, **NO** merge, **NO** deploy. **NO** agregues `remotion/package-lock.json`.

## Informe final (obligatorio, en español)

1. Archivos creados/modificados (paths).
2. Exit code real de los 5 gates + línea de resumen de vitest + salida final del PGlite.
3. Qué imprimió `drizzle-kit generate`.
4. SHA del commit + `git show --stat`.
5. `git status --short` final.
6. **Qué está verificado por test y qué NO** — en particular, cómo verificaste la autorización de rooms
   (cross-tenant).
7. Decisiones: `error → error`, serialización del payload, nombres exactos de los eventos.
8. Límites/supuestos, explícito.

Nada de "debería funcionar".
