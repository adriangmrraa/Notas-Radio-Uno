# PG-06 — Menciones/etiquetas con las redes de `people` al publicar

Rama actual: `pg-01-unified-inbox`. PG-01..PG-05 ya están cerrados: **no los reviertas**.
Implementá **sólo PG-06**.

## Objetivo
Que al publicar, el texto que se manda a cada red incluya las **menciones reales de las personas
citadas** (tomadas de sus redes, nunca inventadas por el LLM) y las **etiquetas (hashtags)** que
correspondan, sin romper la publicación a las redes que no soportan menciones.

## Reutilizá lo que YA existe (no reimplementes)
- `src/server/services/networkVariantService.ts` (PF-09):
  - `normalizeHandle(raw)` → `'@handle'` normalizado (saca URLs, `www.`, `@` duplicado).
  - `NETWORK_HANDLE_KEYS`: qué keys de `persons.social_links` aportan handle por red y en qué orden
    de preferencia (twitter ⇒ `x` antes que `twitter`; newsletter ⇒ [] porque no hay handle).
  - `resolveMentions(personsList, network)` → `ResolvedMention[]` con `{personId, name, handle}` y
    dedupe por handle (case-insensitive).
  - `extractPersonIds(quotes)` → ids de personas citadas (de `publications.quotes`, PF-06).
- `persons.social_links` es jsonb (`{ twitter, instagram, linkedin, x, web, email, … }`) — **el
  nombre real de la columna es `social_links` / campo `socialLinks`** (el comentario de la SDD decía
  `persons.socials`: usá el que existe en el repo).
- Publicación: PG-05 dejó `publishJobService` / `publish_jobs` y el circuito de publicación
  (job por red/cuenta). Los **jobs** son el lugar donde se arma el texto final por plataforma.

## Alcance

### 1) Resolución de menciones por plataforma de publicación
- Las redes de publicación ahora incluyen las de Zernio: `instagram`, `facebook`, `tiktok`,
  `youtube`, `linkedin`, `twitter` (X), `threads`, `pinterest`, `reddit`, `bluesky`.
  `NETWORK_HANDLE_KEYS` hoy cubre 5 redes (PF-09) y su tipo `NetworkVariantKey` es parte del
  contrato de variantes de contenido: **no cambies ese tipo ni el comportamiento de las variantes**.
- Creá un mapa **nuevo, del dominio de publicación** (p. ej. en `src/server/services/mentionService.ts`):
  `PUBLISH_MENTION_KEYS: Record<PublishPlatform, readonly string[]>` que diga qué keys de
  `social_links` aportan handle para cada red de publicación (reusando las preferencias ya
  definidas: X ⇒ `x` antes que `twitter`; TikTok ⇒ `tiktok`; Threads ⇒ `threads`; Bluesky ⇒
  `bluesky`; Pinterest ⇒ `pinterest`; Reddit ⇒ `reddit`; Facebook/Instagram ⇒ `facebook`/
  `instagram`).
- Reusá `normalizeHandle` (no lo reescribas) y **dedupe por handle case-insensitive**.
- Para las redes **sin** handle de la persona (o sin soporte de mención, p. ej. un canal de
  newsletter), la persona simplemente no se menciona.
- Las menciones se resuelven **desde `persons` del tenant** (`social_links`), por los
  `personId` de las citas de la publicación (o por una lista explícita de personas si el job la
  trae). **Nunca** uses nombres para adivinar handles, ni los que pidió el LLM.

### 2) Composición del texto por red
- Al crear los `publish_jobs` (PG-05), el `content` que se manda a cada plataforma debe incluir:
  - las menciones (`@handle`) de las personas citadas que tienen handle **para esa red**,
  - las **etiquetas/hashtags** del contenido (ver abajo).
- Implementá una función pura y testeable, p. ej.
  `composePublishContent({ baseText, platform, mentions, hashtags })` → texto final, **determinista**:
  - menciones al final del texto, separadas por espacio, **sin duplicar** una mención que ya esté
    en el texto base (case-insensitive),
  - hashtags normalizados: sin `#` duplicado, sin espacios, sin acentos raros (mirá qué reglas usa
    el repo si ya existe un normalizador de hashtags; si no, definí una simple y documentala),
    sin duplicados, y **preservando el orden original**.
- **De dónde salen los hashtags**: si la publicación ya tiene hashtags en `contentVariants`
  (PF-09/PC-06) o en el texto, se respetan; además se acepta una lista explícita de hashtags en el
  request de publicación (validada). **No inventes hashtags** a partir del título ni del tema: si no
  hay hashtags definidos, no se agregan.
- Límites de plataforma: si una red tiene límite de longitud de caption (p. ej. X/Twitter 280),
  **recortá de forma segura** (priorizando el texto base y truncando con `…`) o **rechazá con error
  claro** — lo que el repo ya haga para límites de plataformas; no inventes un límite equivocado:
  usá las constantes del repo si existen, si no, documentá el límite que apliques y su fuente.

### 3) API/UI
- La UI de publicación (la que muestra los jobs, PG-05) debe **mostrar las menciones y hashtags
  que se van a publicar por red** antes de aprobar (previsualización), y permitir **excluir** una
  mención concreta (toggle por persona). Todo en español.
- Si el job ya está creado, la UI muestra el texto final que se envió (guardado en el job, p. ej.
  `payload`/columna jsonb si PG-05 dejó lugar; si no, agregá lo mínimo necesario y justificá).

### 4) Persistencia
- Si hace falta guardar el texto final por job/red, usá una columna jsonb en `publish_jobs`
  (migración nueva, la que asigne `drizzle-kit`) o el `payload` que PG-05 haya dejado. **No** metas
  esto en columnas de texto plano si hay jsonb.

## Calidad (gates obligatorios, con salida real)
- `npx tsc --noEmit` → EXIT 0.
- `npx vitest run` (suite completa) → verde con el resumen.
- `node scripts/verify-migration-pglite.mjs` → EXIT 0 (incluye la sección nueva si hubo migración).
- `npm run build` → EXIT 0 y **"No schema changes, nothing to migrate"**.
- `git diff --check` → EXIT 0.
- Tests focalizados nuevos, como mínimo: (a) `composePublishContent` mete las menciones al final y no
  duplica una que ya estaba, (b) hashtags normalizados sin duplicados y en orden, (c) una persona sin
  handle para esa red no se menciona, (d) el handle sale de `social_links` real (nunca del nombre),
  (e) aislamiento: las personas son del tenant, (f) el texto final queda persistido en el job.

## Reglas de git
- Commit convencional con **paths explícitos** (nunca `git add -A` ni `git add .`), sin atribución de IA.
- **No** incluyas en los commits los `BRIEF*.md` ni `remotion/package-lock.json`.
- **NO push, NO merge a master, NO deploy.**

## Reporte final
SHA + archivos + cómo se arman las menciones/hashtags por red + salida de los gates + decisiones
(mapa de keys por red, normalización de hashtags, manejo de límites de longitud) + límites reales.
