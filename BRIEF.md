# PE-03 — Identidad de personas: diarización → matching rostro en frames contra embeddings

KANBAN_TASK_ID: t_d2f3cad5
Slice de: ÉPICA E — Motor de análisis en vivo
Ejecutor: devin-swe-2-max (agente delegado en worktree Orca)
Base: aa3b6ad (master tip — incluye PE-01/02/06/07)

## Objetivo

Resolver `speaker_label` → `person_id`: por cada speaker de la diarización en
`transcript_segments`, samplear frames del video en SUS ventanas temporales,
detectar rostros (SCRFD+ArcFace) y matchear los embeddings contra
`face_embeddings` (pgvector). Escribir `person_id` con confianza. **AC:
corrección manual persiste** — la resolución automática sólo escribe donde
`person_id IS NULL`, y hay un método explícito de corrección.

## Contratos heredados (NO reimplementar)

| Pieza | Dónde | Uso |
|---|---|---|
| `getFaceDetector()` | `src/server/services/faceDetectionService.ts` | `detect(imageBuffer) → {faces:[{bbox,detScore,embedding:number[512]}]}`. Modelo `insightface-buffalo_l`. **`FakeFaceDetector` ya existe** — usalo en tests. |
| `face_embeddings` | `src/server/db/schema/persons.ts` | `tenant_id, person_id, embedding vector(512), det_score`. Matching = pgvector cosine distance (`<=>` via `sql` tag de drizzle) — umbral recomendado ~0.35 (ArcFace normalizado); exponerlo como constante configurable. |
| `persons` | `persons.ts` | `id, name, role_label, role, face_status`. |
| `transcript_segments` | `live.ts` | `speaker_label`, `person_id` (NULL), `start_ms/end_ms` — PE-02 ya los puebla. |
| `recording_segments` + `stream_recordings` | `recordings.ts` | frames vienen de `${storagePrefix}/${fileRef}` via `getRawStorage()` — igual que PE-02. |
| `transmissionSegmentsService.setSegmentSpeakers` | `transmissionSegmentsService.ts` (PE-06) | Propagar la resolución al jsonb `speakers` de los segmentos temáticos cuando apliquen (opcional pero deseable: update solo de labels que coincidaan). |
| ffmpeg | `src/server/lib/binaries.ts` | `ffmpeg -ss <ms> -i <mp4> -frames:v 1 -f image2pipe -vcodec mjpeg -` → Buffer del frame. |

## Arquitectura pedida (patrón del repo)

`src/server/services/personIdentityService.ts`:

- `PersonIdentityStore` + `createDrizzlePersonIdentityStore` + `createPersonIdentityService(store, deps)`.
- Store (TODA query con `tenant_id`):
  - `listUnresolvedSpeakers(tenantId, transmissionId)` → speaker_labels distintos con `person_id IS NULL` + su rango temporal (min/max start_ms).
  - `matchEmbedding(tenantId, embedding, limit)` → `[{personId, personName, distance}]` por distancia coseno `<=>` ASC.
  - `assignPersonToSpeaker(tenantId, transmissionId, speakerLabel, personId)` → UPDATE `transcript_segments` SET person_id **WHERE person_id IS NULL** (así la corrección manual persiste).
  - `overrideSpeakerPerson(tenantId, transmissionId, speakerLabel, personId|null)` → UPDATE forzado (corrección manual: pisa lo que haya, incluido null para desasignar).
- Deps inyectables: `detectFaces(buf)`, `extractFrame(fileRef, atMs)→Buffer`, `storage`/`fileRefFor(segment)`.
- `resolveTransmissionSpeakers({tenantId, transmissionId})` → por cada speaker sin resolver: samplea N frames dentro de su ventana (elegir recording_segment que cubre cada ms vía `listRecordingSegments`), detecta rostros, matchea embeddings, vota/agrupa → `{personId, confidence, evidence}` y escribe la asignación. Devuelve el mapa de resoluciones.
- `correctSpeakerPerson(...)` → override manual.
- Un frame sin rostro, un rostro sin match bajo umbral, o speaker sin frames → `personId=null` con razón; nunca rompe el loop.

## Tests (`tests/personIdentity.test.ts` + `tests/helpers/memoryPersonIdentityStore.ts`)

Deterministas (FakeFaceDetector + embeddings sintéticos normalizados):
- speaker resuelto cuando el match supera el umbral (distancia < umbral)
- sin match → person_id queda NULL con razón registrada
- auto-resolve NO pisa un person_id ya asignado (manual persiste) — el test lo verifica en el memory store replicando el WHERE
- `correctSpeakerPerson` pisa asignaciones previas y admite desasignar (null)
- aislamiento por tenant en queries del store
- múltiples speakers independientes

## Constraints

- `tenant_id` en TODA query. Distancia pgvector parametrizada (no interpolar el array a mano — `sql`${embedding}`` con cast `::vector` o array literal, como prefiera drizzle; revisar cómo `faceEnrollmentService` inserta el vector para el formato).
- NO tocar: `faceDetectionService.ts`, `faceEnrollmentService.ts`, `analysisEngineService.ts`, `streamRecorderService.ts`, schemas.
- No crear endpoints ni scheduler — el servicio es el contrato (el loop en vivo lo llama después).

## Gates

`npx tsc --noEmit` EXIT 0 · `npx vitest run` verde · `npm run build` verde.
`npm ci --ignore-scripts` primero si no hay node_modules.
Commit conventional en `pe-03-person-identity`, paths explícitos, sin atribución IA. NO push, NO PR.
