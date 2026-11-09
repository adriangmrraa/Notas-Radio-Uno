# Spec: bug-fixes — Webhook Stripe, fuga de tenant en settings, restos de Prisma (Tanda T2 — MODIFIED: `billing`, `settings`)

## Propósito

Tres correcciones verificadas en código que bloquean producción sana: (1) firma del webhook de Stripe rota por `express.json()` global, (2) `setSetting`/`getSetting` con `tenantId` opcional que escribe al system tenant, (3) restos de Prisma (`prisma.config.ts`, `prisma-temp-sqlite.prisma`) que contradicen el ORM real (Drizzle).

## Actores

- Stripe / MercadoPago (emisores de webhooks).
- Servicios internos que leen/escriben settings.
- Devs (deuda a eliminar).

## Comportamiento observable

### Requirement: Firma de webhook Stripe con raw body — MODIFIED

El endpoint `POST /api/billing/webhook/stripe` MUST recibir el body crudo (`express.raw()`) ANTES de `express.json()` para esa ruta y MUST construir el evento con ese buffer — hoy hace `constructEvent(JSON.stringify(req.body))` sobre el JSON ya parseado, lo que invalida la firma (verificado en `routes/billing.ts:305`). Un evento con firma inválida MUST responder 400 sin procesar.

#### Scenario: Webhook real de Stripe verifica

- GIVEN Stripe enviando `invoice.paid` con firma válida
- WHEN llega al webhook
- THEN `constructEvent` valida la firma sobre el raw body y el evento se procesa

#### Scenario: Payload alterado se rechaza

- GIVEN un POST con firma inválida o body modificado
- WHEN llega al webhook
- THEN responde 400 y no muta suscripciones (blinda la máquina de estados)

#### Scenario: Verificación MP — endurecer también

- GIVEN el webhook de MercadoPago acepta cualquier POST (sin verificación de origen — verificado: no hay firma/secret)
- WHEN llega un POST forjado
- THEN el sistema SHOULD rechazarlo validando firma/secret de MP o re-consultando la entidad a la API antes de mutar (mínimo: nunca mutar estado sin confirmación contra la API de MP, que ya hace parcialmente — formalizarlo como requisito)

### Requirement: tenantId obligatorio en setSetting/getSetting — MODIFIED

`setSetting`/`getSetting`/`getSettingsByPrefix`/`deleteSetting` MUST exigir `tenantId` (parámetro requerido o contexto obligatorio) — hoy default a `getSystemTenantId()` cuando no se pasa, lo que hace que `routes/settings.ts` y `publishService.ts` lean/escriban webhooks del system tenant (fuga de tenancy verificada). Todo llamador MUST pasar el tenant activo. (Previously: firma con `tenantId?` que caía al system tenant.)

#### Scenario: Webhook del tenant no se comparte

- GIVEN tenant A y tenant B con webhooks distintos
- WHEN cada uno guarda `webhook_pipeline` desde /api/settings
- THEN cada setting queda bajo su tenantId; ninguno lee el del otro ni el global por accidente

#### Scenario: Compilación fuerza el fix

- GIVEN cualquier llamada sin tenantId
- WHEN se compila/ejecuta
- THEN falla (tipo o error explícito), no escribe silenciosamente al system tenant

### Requirement: Limpieza de restos Prisma — ADDED

El repo MUST eliminar `prisma.config.ts`, `prisma-temp-sqlite.prisma` y cualquier referencia a Prisma en docs de setup activo, para que la única fuente de verdad de persistencia sea Drizzle (`src/server/db/schema` + `drizzle/`).

#### Scenario: Repo coherente

- GIVEN el repo tras el fix
- WHEN se inspecciona la raíz
- THEN no hay archivos de Prisma y la documentación activa habla solo de Drizzle

## Datos involucrados (conceptual)

- `settings` (PK compuesta tenantId+key — ya correcta; el bug es de uso, no de schema).
- Suscripciones/billing_events: blindados por la firma (ver subscription-lifecycle).

## Errores y edge cases

- Settings del system tenant que existen hoy por la fuga → evaluar migración: mover a su tenant real o marcarlos como defaults globales explícitos (decisión en design).
- `express.raw()` solo en la ruta webhook — no debe romper el parsing JSON del resto.
- Orden de middleware: registrar la ruta raw ANTES de `express.json()` global o usar routing por path.

## Trazabilidad

Bugs documentados en exploración + PRODUCT-VISION §8 (deuda técnica). Desbloquea subscription-lifecycle (firma Stripe) y corrige fuga multi-tenant que contradice B-2.
