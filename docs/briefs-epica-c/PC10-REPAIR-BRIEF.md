# PC-10 Repair — W1, W2, W3, W4 (bugs reales)

El QA dio **GO** sobre `21cb9a9` con 0 criticals, pero dejó 4 warnings que son bugs concretos. Se corrigen acá,
dentro del mismo slice, antes de integrar a master.

## W3 — `useApi.ts` se traga el mensaje de error del backend (bug **preexistente**, alto impacto)

`src/client/hooks/useApi.ts` (líneas ~65-72):

```ts
if (!response.ok) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    throw new Error(json.error || json.message || json.detail || `HTTP ${response.status}`);
  } catch {                                   // ← captura el throw de arriba
    throw new Error(`HTTP ${response.status}`); // ← y lo reemplaza
  }
}
```

El `throw` de dentro del `try` lo captura el `catch` del mismo `try`: **todo** mensaje de error del backend se
pierde y el usuario ve `HTTP 409` en vez de "Ese slug ya está en uso". Esto afecta a **toda la app** (agenda,
personas, editorial, onboarding…), y contradice el requisito de "mensaje claro" de varios slices.

**Fix**: sacar el `throw` de dentro del `try` (parsear aparte, después lanzar). Concretamente:

```ts
if (!response.ok) {
  const text = await response.text();
  let message = `HTTP ${response.status}`;
  try {
    const json = JSON.parse(text);
    message = json.error || json.message || json.detail || message;
  } catch {
    // respuesta no-JSON: se queda el mensaje por defecto
  }
  throw new Error(message);
}
```

**Ojo**: este archivo es compartido. El fix es **quirle** y no debe cambiar ningún otro comportamiento
(401 → redirect a `/login`, 402 → `QuotaExceededError`, etc. quedan igual). Agregá un test que cubra el caso:
respuesta 409 con body `{"error":"Ese slug ya está en uso"}` ⇒ el error lanzado tiene ese mensaje (no `HTTP 409`).
Si no hay forma cómoda de testear `fetchApi` (es un hook de React), extraé la lógica de parseo a una función pura
exportada (ej. `parseErrorMessage(text, status)`) y testeala — **esa es la opción preferida**.

## W4 — el paso "canal" se marca completo con cualquier actualización parcial

`applyChannelStep` marca el paso `channel` como `done` con **cualquier** update no vacío (ej. sólo `{slug}`), aunque
`name` / `platformName` / `timezone` queden sin configurar. Con eso, `canComplete` puede dar `true` sin un canal
realmente configurado.

**Fix**: el paso `channel` está completo **sólo si** el tenant tiene `name` (no vacío) **y** `platformName` (no vacío)
**y** `timezone` (no vacío). Si el update es parcial, el paso **no** se marca como completo (o se marca según el
estado real del tenant, no según lo que vino en el body). La UI siempre manda todos los campos, así que el
comportamiento visible no cambia; lo que cambia es que el backend no miente.
Agregá/ajustá el test del cálculo de pasos para cubrir el caso "canal con nombre pero sin platformName ⇒ paso
pendiente".

## W1 — `step/:stepId` inválido devuelve 404 en vez de 400

El brief especificaba **400** con mensaje claro para un `stepId` desconocido; el código devuelve 404.
**Fix**: alinealo con el brief ⇒ **400** con mensaje claro (el 404 queda para recursos que existen pero son de otro
tenant). Agregá el assert en el test del route o en el de las reglas.

## W2 — marcas combinantes literales en el código fuente

`src/server/services/programService.ts:~23` y `src/server/lib/onboardingRules.ts:~208` usan los caracteres
combinantes **literales** (`[̀-ͯ]`) donde el original usaba escapes (`[\u0300-\u036f]`). Funciona hoy, pero es
frágil ante cualquier herramienta que normalice NFC.

**Fix**: volvé a los escapes `\u0300-\u036f` (equivalencia verificada por el QA: los codepoints son los mismos).
Mismo criterio para cualquier otro literal combinante en los archivos tocados.

## W5 (mismo repair, barato) — cobertura del refactor de `programs.ts`

El commit movió ~170 líneas de `routes/programs.ts` a `services/programService.ts`. El QA verificó **a mano** que
el comportamiento se preserva (mismo orden de validación, mismos mensajes, misma transacción, mismo
`ensureUniqueSlug`), pero **no hay test** que lo cubra.

**Fix**: agregá tests del `programService` para lo que se movió y es testeable sin DB: `slugifyProgram` (con
diacríticos, espacios, caracteres inválidos, resultado idéntico al original) y `ensureUniqueSlug` (con un source
inyectable). El objetivo es que una futura regresión en el slug no pase inadvertida.

## Qué NO tocar

- `drizzle/`, `drizzle/meta/`, `src/server/db/schema/` — NO se tocan.
- La lógica del guard de redirección, los 4 pasos y sus endpoints (salvo W1/W4).
- Sin dependencias nuevas.

## Gates (exit code real, a completion)

```bash
npx tsc --noEmit
npm run build
node scripts/verify-migration-pglite.mjs
npx vitest run
git diff --check
git status --short
```

`npm run build` debe seguir imprimiendo **"No schema changes, nothing to migrate"**.
Ojo: el runner PGlite puede fallar con `stdin is not a tty` de forma transitoria; si pasa, re-corré y reportá la
corrida que terminó.

## Commit

**Un commit nuevo** (NO amendes `21cb9a9`, así el QA queda trazable):
`fix(onboarding): conservar mensajes de error de la API y endurecer el paso de canal`

Paths explícitos. Sin push, sin merge, sin deploy. Sin atribución de IA.

## Reporte final

1. SHA nuevo + `git show --stat`.
2. Exit code de cada gate + línea de resumen de vitest.
3. W3: el diff de `useApi.ts` (antes/después) y el test que lo cubre.
4. W4: la nueva regla de "canal completo" y el test.
5. W1/W2/W5: qué cambió exactamente.
6. Confirmación de que el resto del onboarding (guard, endpoints, pasos) quedó intacto.
