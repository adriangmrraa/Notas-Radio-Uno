# PD-05 — Sala "En vivo" (UI): timeline, personas resueltas, momentos, clips, mark manual

Ejecutá este brief **end-to-end, de forma totalmente autónoma**. No esperes aprobación de nadie.
Si un gate falla, arreglalo antes de reportar. **No dejes nada a medias.**

## Contexto del repo

- Worktree: el que ya tenés abierto. Rama de este slice: `pd-05-live-room`.
- Stack: **Express 4 + TypeScript (ESM) + React 19 SPA (Vite) + Drizzle ORM + Postgres (Neon)** + **Socket.IO 4**.
- UI: **React 19 + Vite + Tailwind + shadcn/ui** (componentes en `src/client/components/ui/`).
  - Componentes shadcn **ya disponibles**: `button`, `card`, `badge`, `tabs`, `dialog`, `input`, `label`,
    `select`, `scroll-area`, `separator`, `skeleton`, `toast`, `use-toast`, `progress`, `accordion`, `avatar`.
  - **NO agregues dependencias nuevas** al `package.json` (no hay internet garantizada en el build y el
    repo tiene convenciones estrictas).
- Contratos que ya existen (leelos primero y **reutilizalos**):
  - `src/client/hooks/useSocket.ts` — el hook de socket (ya manda `auth: { token }`).
  - `src/client/hooks/useApi.ts` — el hook de API (prefix `/api`, Bearer desde `localStorage.accessToken`).
    **Ojo**: este hook tiene un fix reciente que preserva el mensaje de error del backend — **no lo rompas**.
  - `src/client/hooks/useLiveAlerts.ts` — ejemplo de hook que escucha eventos de socket.
  - `src/client/pages/AgendaPage.tsx` — página de agenda (referencia de layout, tablas y fetch).
  - `src/client/pages/ClipsPage.tsx` — página de clips (referencia de cards + estados).
  - `src/client/pages/PersonsPage.tsx` — módulo de personas (referencia de uso de `persons`).
  - `src/client/components/Layout.tsx` y `src/client/components/Sidebar.tsx` — **agregá la entrada de
    navegación "En vivo"** siguiendo el patrón de las demás.
  - `src/server/routes/transmissions.ts` — router existente de transmisiones.
  - `src/server/services/transmissionService.ts` — FSM + eventos Socket.IO (creado en D4/PD-04):
    eventos `transmission:status` y `transmission:updated`, rooms `tenant:{tenantId}` y
    `transmission:{transmissionId}`.
  - `src/server/db/schema/transmissions.ts`, `recordings.ts`, `persons.ts` — schema.
  - `src/server/db/schema/clips.ts` — `clips` (estado, `video_path`, `title`, `hook_text`, `duration`).
  - `src/server/db/schema/publications.ts` — `transcriptions` (texto, `duration_seconds`, `diarized`,
    `speaker_count`, `provider`).
  - `src/server/routes/clip.ts` / `clips.ts` — cómo el repo expone y sirve los clips.
- Tests: `vitest` (lado servidor). Para el cliente, el repo tiene tests de hooks con
  `tests/useApi-error.test.ts` — **mirá cómo testea un hook** si necesitás testear lógica de cliente.

## Objetivo

La **Sala "En vivo"**: una pantalla `/en-vivo/:transmissionId` (o `/en-vivo` con selector) donde el editor
del tenant ve la transmisión en curso:

1. **Estado de la transmisión** visible (`waiting`, `live`, `processing`, `done`, `error`) con UI acorde:
   banner de espera mientras no hay señal, indicador de caída/reintento, resumen al finalizar.
2. **Timeline de transcripción** que avanza en vivo (vía Socket.IO, sin recarga) mostrando la
   transcripción con **personas resueltas** cuando hay atribución, y **speaker labels genéricos**
   ("Speaker A") cuando no la hay — **degradado, nunca error**.
3. **Momentos detectados** marcados con score/razón.
4. **Clips generándose**: cards con su estado (`generating` → `ready` → `error`) que aparecen solas.
5. **Panel de personas detectadas** con confianza.
6. **Mark manual**: "generar clip ahora" (ventana hacia atrás de N segundos), "generar nota de este bloque",
   "pausar/finalizar la transmisión".

## 1. API — `src/server/routes/live.ts` (archivo nuevo)

Router nuevo, montado en `src/server/index.ts` como `liveRouter` en `/api/live`.

**Reglas duras:**
- `tenant_id` en **toda** query — sin excepciones.
- Toda query sobre `transmissions` filtra por `tenant_id` **y** `id`; si no pertenece → **404** (no 403: no
  reveles la existencia de recursos de otro tenant).
- `requireAuth` en todas las rutas.

### Endpoints

**`GET /api/live/transmissions/:id`**
Devuelve el estado completo de la sala:
```jsonc
{
  "transmission": { "id", "status", "source", "streamUrl", "crudoRef", "startedAt", "endedAt",
                    "durationMinutes", "errorMessage", "programId", "programName" },
  "recording": { "id", "status", "segmentCount", "totalBytes", "startedAt", "endedAt" } | null,
  "segments": [ { "sequence", "startMs", "endMs", "bytes", "status" } ],
  "timeline": [ { "id", "startMs", "endMs", "speakerLabel", "personId", "personName", "personPhotoUrl",
                  "text", "confidence" } ],
  "moments": [ { "id", "startMs", "endMs", "title", "reason", "score" } ],
  "clips": [ { "id", "title", "hookText", "status", "duration", "videoUrl" } ],
  "people": [ { "personId", "name", "photoUrl", "confidence", "speakerLabel" } ]
}
```
- `timeline`: **si no existe una fuente de utterances con timestamps en el schema, NO inventes una tabla
  nueva**: armalo con lo que exista hoy. Mirá `src/server/db/schema/publications.ts` → tabla `transcriptions`
  (tiene `text`, `created_at`, `duration_seconds`, `diarized`, `speaker_count`) y **el tipo `Utterance` en
  `src/shared/types.ts`** (que tiene `startMs`/`endMs`/`speakerLabel`).
  - **Decisión requerida**: si no hay persistencia de utterances con offsets, creá una tabla mínima
    `transcript_segments` (`tenant_id`, `transmission_id`, `start_ms`, `end_ms`, `speaker_label`,
    `person_id` nullable, `text`, `confidence`) **con migración idempotente + asserts en el verificador
    PGlite** — es el mínimo para que la sala muestre algo real y para que la ÉpICA E (motor de análisis)
    pueda alimentarla. **Si preferís no tocar el schema, el endpoint debe devolver `timeline: []` vacío y
    documentarlo** — pero entonces la sala no cumple el ítem. **Lo correcto es crear la tabla.**
  - `personId`/`personName`: resolvé contra `persons` (tabla de la Épica C, ya existe) por el
    `person_id` de la fila. **Sin atribución → `personId: null` y `speakerLabel` genérico.**
- `moments`: mismosCriteria — si no hay tabla de momentos, creá `transmission_moments` mínima o **reutilizá**
  la que exista. Mirá si el pipeline actual guarda momentos (`src/server/services/topicService.ts`,
  `clipService.ts` — `detectHighlights` devuelve `ClipCandidate[]` con `startMs`, `endMs`, `reason`, `hookText`).
  **Documentá de dónde salen los momentos.**
- `clips`: de la tabla `clips`, filtrada por la transmisión (si `clips` no tiene `transmission_id`,
  **agregá la columna** con migración idempotente — es la forma de que la sala muestre los clips de ESTA
  transmisión).
- `people`: del panel de personas detectadas (misma fuente que el timeline: `persons` + confianza).

**`POST /api/live/transmissions/:id/mark`** — mark manual
- Body: `{ type: 'clip' | 'note', windowSeconds?: number }`.
- `type: 'clip'` → crea un clip候选: registrá un momento manual en la tabla de momentos (o en la de segments)
  con `startMs = max(0, nowMs - windowSeconds*1000)`, `endMs = nowMs`, `reason: 'mark manual'`, y
  **encolá el render del clip** si existe la infra (mirá `clipService.ts` → `generateClipVideo` /
  `createClip`). Si la infra de render no es alcanzable desde acá, **creá el clip en estado `generating`**
  con el `metadata` de la ventana y **dejá un TODO explícito** — no inventes un sistema de colas nuevo.
- `type: 'note'` → registrá un mark de tipo nota (en la misma tabla de momentos/segments con
  `kind: 'mark'` y `title`).
- Respondé 201 con lo creado.

**`POST /api/live/transmissions/:id/stop`** — finalizar
- Body opcional: `{ reason?: string }`.
- Transicioná la transmisión a `processing` (o `canceled`) usando `transitionTransmission` (del slice D4) —
  **no** hagas UPDATE directo: la FSM es la única puerta.
- Respondé 200.

## 2. Cliente

### 2.1 Página — `src/client/pages/LiveRoomPage.tsx` (nuevo)
- Ruta: `/en-vivo/:transmissionId` (y `/en-vivo` → selector de transmisión activa del tenant).
  - Mirá cómo se registran las rutas (`src/client/App.tsx` o similar) y seguí el patrón.
- Layout: dos columnas (o panel lateral en tablet — la spec pide que sea usable en tablet).
  - **Izquierda**: estado + timeline.
  - **Derecha**: panel de personas + cards de clips + acciones (mark manual, finalizar).
- **Estados de carga/vacío/error**: la spec lo pide explícitamente. Usá `Skeleton` para loading, y estados
  vacíos con texto claro ("Todavía no hay transcripción", "No se detectó live en la ventana de espera").
- **Responsive**: usable en tablet ( breakpoint `md`).

### 2.2 Timeline
- Componente `src/client/components/live/LiveTimeline.tsx`.
- Lista cronológica de utterances con: avatar/foto de la persona (o iniciales del speaker label), nombre
  (**"Martín:"** si hay persona resuelta, **"Speaker A:"** si no), texto, y timestamp relativo (`mm:ss`).
- **Los momentos** se muestran como un marcador visual en la línea de tiempo (con score/razón al hacer hover
  o click).
- **Auto-scroll** al final cuando llega algo nuevo, **pero** si el usuario scrolleó hacia arriba, **no** lo
  forcés (respetá al usuario).

### 2.3 Clips
- Componente `src/client/components/live/LiveClipsPanel.tsx`.
- Card por clip con su estado (`generating` con spinner/`Skeleton`, `ready` con miniatura o link, `error` con
  mensaje + botón de reintento si la API lo soporta).
- **Aparecen solas** vía Socket.IO (evento de clip nuevo) o vía polling de respaldo (cada 10 s) — **decidí y
  documentá**.

### 2.4 Mark manual
- Botón "Generar clip ahora" → `POST .../mark` con `{ type: 'clip', windowSeconds: 30 }`.
- Botón "Generar nota" → `{ type: 'note' }`.
- Feedback al usuario: toast de éxito/error (el repo ya tiene `use-toast`).
- **Deshabilitado** si la transmisión no está `live` (con tooltip explicando por qué).

### 2.5 Socket en la sala
- `useSocket()` + `socket.on('transmission:status', ...)` y `socket.on('transmission:updated', ...)`.
- Suscribirse al room de transmisión: el cliente emite `transmission:subscribe` con `{ transmissionId }`
  (el servidor valida que la transmisión sea del tenant — implementalo en D4; si el handler del cliente no
  existe, agregá el `socket.emit` y **dejá claro** que depende del servidor).
- Al recibir `transmission:status`:
  - si el estado cambió → re-fetch del payload de la sala (o actualizá el estado local).
  - si `status === 'live'` → empezar a pedir el timeline cada N segundos como respaldo (por si el socket
    pierde un evento).
- **Cleanup**: al desmontar, `socket.off(...)` y `socket.emit('transmission:unsubscribe')`.

### 2.6 Navegación
- `src/client/components/Sidebar.tsx`: agregá la entrada **"En vivo"** con el ícono que ya use el repo.
- Si no hay lista de transmisiones para elegir, el ítem de navegación puede llevar a `/en-vivo` con un
  selector que liste las transmisiones recientes del tenant (`GET /api/transmissions` ya existe).

## 3. Tests — `tests/liveRoomApi.test.ts` (servidor, lo que se puede testear sin DOM)

- `GET /api/live/transmissions/:id` sin auth → **401**.
- Con auth → **200** con el shape esperado.
- Transmisión de **otro tenant** → **404** (y **no** filtra datos).
- `POST .../mark` → **201** y crea el momento/clip con la ventana correcta.
- `POST .../stop` → transiciona vía la FSM y devuelve 200.
- Tenant safety: las queries filtran por `tenant_id`.

Si agregás tablas nuevas, **extendé `scripts/verify-migration-pglite.mjs`** con asserts reales (tablas,
columnas, FKs, índices) y **reaplicá** la migración para probar idempotencia.

## 4. Gates — TODOS tienen que dar EXIT 0 real

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
```

`npm run build` corre `build:client` (Vite) + `build:server` (tsc) + `drizzle-kit generate`. Si tocás el
schema, la migración debe quedar en sync (sin drift).

## 5. Commit

- **UN commit** al final, con los gates verdes.
- Conventional Commits, español, **sin atribución a IA**, sin `Co-Authored-By`.
  - Sugerido: `feat(live-room): sala En vivo con timeline, momentos, clips y mark manual`
- **Paths explícitos** (nunca `git add -A` / `git add .`).
- **NO** push, **NO** merge, **NO** deploy. **NO** agregues `remotion/package-lock.json`.

## 6. Informe final (obligatorio, en español)

1. Archivos creados/modificados (paths).
2. Exit code real de los 5 gates + línea de resumen de vitest + salida final del PGlite.
3. Qué imprimió `drizzle-kit generate` (¿"No schema changes"?).
4. SHA del commit + `git show --stat`.
5. `git status --short` final.
6. **Qué está verificado por test y qué NO** — separá explícitamente lo que la UI **no** tiene test
   automatizado (lo normal en este repo) y decí **cómo verificaste visualmente** la página (si la abriste:
   `npm run dev:client` + `npm run dev:server` — **ojo: `runMigrations()` corre al boot contra `DATABASE_URL`,
   que podría ser PRODUCCIÓN — NO arranques el server contra la DB real**; si verificaste visualmente,
   explicá cómo lo hiciste sin tocar la DB de producción).
7. Decisiones: de dónde salen los momentos, si creaste tablas nuevas (cuáles), polling vs socket, cómo se
   encola el clip del mark manual.
8. Límites/supuestos, explícito.

Nada de "debería funcionar".
