# PC-04 — Pipeline de rostros: foto → detectar cara → embedding → guardar

Ejecutá este brief **end to end, de forma autónoma**. Nunca esperes aprobación. No pidas permisos: el
harness corre con permisos abiertos. No inventes features ni datos: si algo no está especificado acá,
dejalo fuera y anotalo en el reporte final.

## Contexto: de dónde parte este slice

- Repo: `periodistapp` — Express 4 + TypeScript + React SPA (Vite) + Drizzle/Postgres.
- Base: `origin/master` @ `aa9fa24` (ya incluye PC-01 schema, PC-02 migración legacy, PC-03 CRUD de
  personas con multi-foto).
- **El schema ya existe y NO hay que crearlo**: `face_embeddings` (`vector(512)`, `model` default
  `'insightface-buffalo_l'`, `dimensions` default 512, `det_score`, `quality`) y `person_photos`
  (`face_detected` boolean default false, `face_count` integer default 0) ya están en
  `drizzle/0006_epic_c_pc01_context.sql`. **NO toques `drizzle/` ni `src/server/db/schema/`** salvo que
  descubras un error REAL, y en ese caso lo documentás.
- **PC-03 ya sube fotos** a `person_photos` (`photo_data` bytea, `mime_type`, `is_primary`, `width`,
  `height`) y las marca con `face_detected=false` / `face_count=0`. PC-04 **consume** esas fotos.
- **Decisión SDD D-3 (aplicar)**: InsightFace self-hosted (SCRFD + ArcFace) + embeddings en pgvector.
  Enrolled-only (sólo personas que el tenant registra) + consentimiento explícito.

## AC (criterio de aceptación, el que cierra el slice)

> **Una foto SIN cara se rechaza con un mensaje claro y explícito.** Y una foto CON cara genera un
> embedding de 512 dimensiones guardado en `face_embeddings`, con `person_photos.face_detected=true`
> y `face_count` correcto.

## Ruta técnica: qué usar (verificada en esta máquina, NO la inventes)

El InsightFace **de Python no está instalado** en esta máquina y **no hay Docker**. La ruta viable y
verificada es **ONNX en el runtime Node**:

- `onnxruntime-node@1.31.1` — **verificado**: `npm i onnxruntime-node@1.31.1` instala en 6s y
  `require('onnxruntime-node')` carga con `{"common":"1.31.1","node":"1.31.1"}`.
- Modelos InsightFace `buffalo_l` (SCRFD `det_10g.onnx` + ArcFace `w600k_r50.onnx`): **verificado
  descargable** desde
  `https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip`
  (HTTP 206, ZIP válido — magic `PK\x03\x04`).

### Reglas duras de los modelos (importante)

1. **NO commitees los `.onnx`** ni el zip: son binarios de ~300 MB. Van **descargados en runtime**,
   cacheados en una carpeta fuera de git (por ejemplo `.cache/face-models/` o `node_modules/.cache/`),
   con la URL y el checksum (SHA-256) del zip **documentados en el código** y la descarga happening
   **de forma perezosa** (una sola vez, y reusada).
2. **El pipeline debe funcionar aunque los modelos no estén descargados**: si el detector no está
   disponible, la API responde con un **error honesto y accionable** (ej. 503 "modelo de detección no
   disponible, ejecutá el script de descarga"), **nunca** un 200 silencioso con `face_detected=false`
   haciéndose pasar por "no había cara". Esa distinción (sin cara vs. detector no disponible) es el
   corazón del AC.
3. **No agregues una dependencia de red en el build**: `npm run build` tiene que seguir funcionando
   sin descargar modelos. La carga del modelo es **runtime**, no build-time.
4. Si `onnxruntime-node` (binario nativo) no te compila o no carga en esta máquina, **no lo fuerces**:
   reportá el error exacto y dejá el resto del slice (contrato de API, validación, persistencia,
   gating de consentimiento, tests) implementado y funcionando contra una **interfaz de detector
   inyectable** (`FaceDetector` con una implementación real y otra fake para tests). Eso es mejor que
   una feature a medias. La interfaz inyectable es **requerida** igual, para poder testear sin modelos.

## Qué implementar

### 1. Capa de detección — `src/server/services/faceDetectionService.ts` (archivo nuevo)

Interfaz inyectable, por ejemplo:

```ts
export interface DetectedFace { bbox: [number,number,number,number]; detScore: number; embedding: number[] }
export interface FaceDetector {
  detect(input: Buffer): Promise<{ faces: DetectedFace[]; model: string }>
}
```

- Implementación real: **SCRFD** (detección) + **ArcFace** (embedding de 512 dims), vía
  `onnxruntime-node` y los modelos `buffalo_l`.
- Preprocesado correcto de la imagen (el input es un buffer PNG/JPEG: decodificá, pasá a RGB, resize
  al input size del modelo, normalizá como espera SCRFD/ArcFace).
- Una **implementación fake** para tests (devuelve caras-count y embedding determinista).
- El servicio expone una función que resuelve el detector: **lazy**, cachea la instancia y los modelos
  en memoria, y **no lanza al importar el módulo** (importar el service no puede romper el server si
  falta el modelo).

### 2. API — extendé `src/server/routes/persons.ts` (archivo existente, ya mergeado)

Rutas nuevas (mismo patrón de auth y tenant que el resto del archivo: `requireAuth`, `req.auth.tenantId`,
`and(eq(...id), eq(...tenantId))`, y **404** para ids de otro tenant):

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/api/persons/:id/photos/:photoId/enroll` | **Ruta principal.** Toma la foto ya subida, corre el detector y:<br>• **0 caras → 400** con mensaje claro (ej. `"No se detectó ningún rostro en la foto"`). **Este es el AC**: foto sin cara → rechazo explícito.<br>• **1 cara →** persiste el embedding en `face_embeddings` (`person_id`, `person_photo_id`, `model`, `dimensions=512`, `embedding`, `det_score`), actualiza `person_photos.face_detected=true` y `face_count=1`, setea `persons.embedding_ref` a ese embedding, `persons.face_status='enrolled'` y `persons.consent_given=true` + `consent_at=now()`.<br>• **>1 caras → 400** con mensaje claro (no se puede enrolar una persona a partir de una foto con varias caras: es ambigua). |
| POST | `/api/persons/:id/enroll` | Atajo: enrola la foto **primaria** de la persona, con las mismas reglas. |
| DELETE | `/api/persons/:id/photos/:photoId/embedding` | Desenrola: borra el `face_embeddings` de esa foto, limpia `persons.embedding_ref`, vuelve `face_status='pending'` y `face_detected=false`. |
| GET | `/api/persons/:id/face-status` | Estado del enrolment: `face_status`, `consent_given`, `embedding_ref`, `face_count`, y si el modelo está disponible o no. |

**Reglas de seguridad y de honestidad (CRITICAL si se violan):**
- `requireAuth` en todas.
- **Toda** query filtra por `tenant_id`: la foto, la persona y el embedding son del tenant del usuario.
  Un `photoId` de otro tenant → **404**.
- **Consentimiento**: sólo se enrola si la persona tiene `consent_given=true` o el request lo marca
  explícitamente como consentimiento en el body (`{ consent: true }`) — y en ese caso queda registrado
  (`consent_given=true`, `consent_at=now()`). Si no hay consentimiento → **400** con mensaje que lo
  explique.
- **Un embedding por foto**: re-enrolar la misma foto **actualiza** el embedding existente en vez de
  duplicar la fila (o borra y crea, pero **nunca** dos embeddings vivos para la misma `person_photo_id`).
- **Error de detector no disponible → 503**, no 400 ni 200. El cliente tiene que poder distinguir
  "no hay cara" de "no puedo detectar".
- El vector de 512 dims se inserta como `vector(512)` de pgvector. **Cuidado**: el verificador PGlite
  sustituye `vector(N)` por `bytea` (PGlite no trae pgvector) — el SQL real corre sobre Postgres con
  pgvector (Neon/Render). **No apuntes tests a la base de producción.**

### 3. UI — extendé `src/client/pages/PersonsPage.tsx` (archivo existente, ya mergeado)

- En la galería de cada persona: botón **"Enrolar rostro"** por foto (y un botón de enrolar la
  primaria), con estado visible: pendiente / enrolled / fallido / **"detector no disponible"**.
- Mostrar consent checkbox explícito antes de enrolar, y el texto de consentimiento.
- Mostrar el resultado del rechazo: si la API devuelve 400 "no se detectó ningún rostro", la UI lo
  muestra **literalmente** al usuario (mensaje claro, no un error genérico).
- Manejar el 503 (detector no disponible) con un mensaje accionable distinto al de "no hay cara".
- Botón para desenrolar.

### 4. Tests (obligatorios: son la prueba del AC)

Tests **unitarios** del slice, con la **implementación fake** del detector (sin modelos, sin red,
sin DB real):

- foto con 0 caras → **400** con mensaje que menciona que no se detectó un rostro.
- foto con 2 caras → **400** con mensaje claro.
- foto con 1 cara → se persiste el embedding con **512 dimensiones**, `face_detected=true`,
  `face_count=1`, `face_status='enrolled'`, `consent_given=true`, `consent_at` seteado.
- sin consentimiento → 400.
- detector no disponible → **503** (y **NO** 200 con `face_detected=false`).
- re-enrolar la misma foto **no** deja dos embeddings vivos para esa `person_photo_id`.
- desenrolar limpia `embedding_ref`, vuelve `face_status='pending'` y borra el embedding.
- aislamiento: un `personId`/`photoId` de otro tenant → **404** y **no** escribe nada.

Usá el runner de tests que ya tenga el repo (mirá `package.json`); si no hay, agregá vitest como
devDependency **sólo si hace falta** y corré la suite completa. Reportá la línea de resumen real
(`Test Files ... Tests ...`).

### 5. Verificación (la hace el agente, con exit code real)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run            # o el comando de tests que corresponda
git diff --check
git status --short
```

`npm run build` incluye `npx drizzle-kit generate`: tiene que seguir imprimiendo
**"No schema changes, nothing to migrate"** (si genera migración, hay drift: revisá que no hayas
tocado el schema).

Si los modelos NO se pueden descargar en esta máquina, **eso no bloquea el slice**: los tests van
contra el detector fake. Reportalo explícitamente como **"no verificado contra el modelo real"** en
vez de darlo por bueno.

## Fuera de scope (NO lo implementes — es PC-05/PC-06/PC-07/PC-08/PC-09/PC-10)

- Línea editorial (`editorial_profiles`, tono, reglas, ejemplos) → PC-05/PC-06.
- `transmissions`, `scheduled_transmissions`, agenda, RRULE → PC-07/PC-08.
- Dossier de invitados → PC-09.
- Onboarding wizard → PC-10.
- **Búsqueda por similitud** de rostros (matching de personas en video) → es PC-06/PC-08, no este slice.
  Este slice sólo detecta y enrola.

## Límites duros

- **NO push** a ninguna rama. **NO merge** a `master`. **NO deploy**. Ni a `origin`.
- **NO toques** el checkout compartido `C:/Users/Asus/Documents/estabilizacion/periodistapp`: todo
  dentro de este worktree.
- **NO uses `git add -A` ni `git add .`**: commit con **paths explícitos**.
- **NO commitees modelos `.onnx`, zips, ni binarios.** Nada de `node_modules`.
- **NO modifiques** `drizzle/`, `drizzle/meta/` ni `src/server/db/schema/`.
- Commit **conventional** (`feat(persons): ...`), **sin atribución de IA**, sin `Co-Authored-By`.
- **NO borres ni reescribas** los untracked preexistentes (`remotion/package-lock.json`,
  `BRIEF-EPICA-B.md`, `README.md`, etc.): no son tuyos.
- Si algo del brief es imposible, **no lo simules**: dejalo sin hacer, explicá por qué en el reporte y
  seguí con el resto. Cero features a medias.

## Reporte final (obligatorio)

1. **SHA** del commit + `git show --stat`.
2. **Exit code real** de cada gate (`tsc`, `build`, `pglite`, `vitest`, `diff --check`) y la línea de
   resumen de los tests (`Test Files ... Tests ...`).
3. **Cómo probaste el AC**: el caso de 0 caras (código de respuesta + mensaje literal que devuelve la
   API), el caso de 1 cara (qué se persiste y con cuántas dimensiones) y el caso de detector no
   disponible.
4. **Qué detector usaste de verdad** (onnxruntime-node + SCRFD/ArcFace, o fake) y **qué quedó sin
   verificar contra el modelo real**, si algo.
5. **Cómo verificaste el aislamiento multi-tenant** (qué query filtra por tenant y qué devuelve un id
   de otro tenant).
6. **Qué quedó fuera y por qué**, si algo no se pudo hacer.
