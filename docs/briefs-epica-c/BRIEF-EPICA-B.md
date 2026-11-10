# BRIEF — ÉPICA B: Billing por transmisiones (PeriodistApp)

Trabajás SOLO en este worktree: `C:/Users/Asus/orca/workspaces/periodistapp/epica-b-billing`
Rama: `epica-b-billing` (base = `origin/master` + merge ff de `epica-a-foundation` @ 315fb80).
Corré todo automáticamente, sin pedir aprobación, sin abrir TUIs interactivas para preguntar.

Repo: Express + TypeScript (ESM, imports con `.js`) + React SPA (Vite) + Drizzle ORM sobre Postgres/Neon.

## Objetivo
El modelo de negocio (suscripción **por transmisiones**) funciona end-to-end: medir, cobrar, avisar, suspender.

## Reglas inviolables
1. **`tenant_id` en TODA query** multi-tenant. Nada global sin filtro.
2. **Una transmisión ACTIVA nunca se corta por cuota.** El medidor se consulta únicamente al *iniciar* una transmisión. Ningún loop, cron ni webhook puede detener un pipeline en curso.
3. No tocar `master`, no push, no deploy, no merge. Sólo commits locales en `epica-b-billing`.
4. Commits convencionales, **paths explícitos** (`git add <archivo>`), **sin atribución de IA**, sin `git add -A`. Un commit por unidad PB-0X, mensaje `feat(billing): PB-0X ...`.
5. Secretos: nunca loguear claves; si falta una env (Stripe/MP/SMTP) el código compila y devuelve error de configuración — **nunca** lanza al importar.
6. No inventar datos. Si no podés verificar algo (no hay Stripe keys ni Postgres), reportalo como NO VERIFICADO; no simules éxito.
7. Respetá el estilo existente: servicios en `src/server/services/*.ts`, rutas en `src/server/routes/*.ts`, `AppError` de `src/server/lib/errors.ts`, auditoría con `auditFromRequest`/`recordAuditEvent` y `AUDIT_ACTIONS`.
8. Admin UI existente: `src/client/pages/admin/` (AdminLayout, AdminTenants, AdminTenantDetail). Extendé ese patrón.

## Contexto ya construido (Épica A, no lo rehagas)
- `plans`, `subscriptions`, `usageRecords`, `invoices` en `src/server/db/schema/billing.ts`.
- `requireActiveSubscription` en `src/server/middleware/auth.ts` (acepta trialing/active).
- `adminService.grantExtraTransmissions()` guarda `tenants.config.extraTransmissions` (número). **Esto debe seguir funcionando**: el medidor debe sumar ese extra como transmisiones disponibles.
- Al registrarse (`authService.register`) se busca un plan llamado `'trial'` y se crea `subscriptions` con `status='trialing'`, `trialEndsAt = now + 7d`. Hoy NO existe ese plan seedeado → el seed de PB-03 debe incluirlo.
- `auditService.AUDIT_ACTIONS` ya tiene `BILLING_CHECKOUT`, `BILLING_PLAN_CHANGED`, `BILLING_PAYMENT_OK`, `BILLING_PAYMENT_FAILED`, `ADMIN_PLAN_CHANGED`.
- `src/server/routes/billing.ts` ya tiene: `/plans`, `/my-subscription`, `/usage`, `/invoices`, `/checkout` (stripe + mercadopago), `/cancel`, webhooks de Stripe y MP.
- El webhook de Stripe **está roto**: usa `JSON.stringify(req.body)` con `express.json()` ya aplicado → la firma nunca valida. Hay que arreglarlo (ver PB-04).

---

## PB-01 — Schema `usage_cycles` + campos de plan

En `src/server/db/schema/enums.ts` agregá:
```ts
export const usageCycleStatusEnum = pgEnum('UsageCycleStatus', ['open', 'closed']);
export const quotaOperationStatusEnum = pgEnum('QuotaOperationStatus', ['reserved', 'consumed', 'released']);
export const addonPurchaseStatusEnum = pgEnum('AddonPurchaseStatus', ['pending', 'paid', 'failed', 'refunded']);
```

En `src/server/db/schema/billing.ts` agregá a `plans` (todas nullable salvo las marcadas):
- `transmissionsPerCycle: integer` (null = ilimitado)
- `maxTransmissionMinutes: integer` (duración máx por transmisión)
- `maxClipsPerTransmission: integer`
- `maxPeople: integer` (personas en la biblioteca)
- `rawRetentionDays: integer` (retención del material crudo)

Tablas nuevas:

**`usage_cycles`** (`usageCycles`): `id` uuid pk, `tenantId` uuid notNull fk tenants cascade, `periodStart` date notNull, `periodEnd` date notNull, `includedTransmissions` integer notNull default 0, `addonTransmissions` integer notNull default 0, `transmissionsUsed` integer notNull default 0, `status` usageCycleStatusEnum notNull default 'open', `createdAt`, `updatedAt`. `unique(tenantId, periodStart)`; index `(tenantId, status)`.

**`quota_operations`**: `id`, `tenantId` fk cascade, `usageCycleId` fk usage_cycles cascade, `operationId` varchar(120) notNull (idempotencia), `kind` varchar(40) notNull default 'transmission_start', `status` quotaOperationStatusEnum notNull default 'consumed', `transmissionRef` varchar(160), `createdAt`, `releasedAt` timestamp, `releaseReason` varchar(40). `unique(tenantId, operationId)`.

**`plan_addons`**: `id`, `kind` varchar(40) notNull default 'transmissions', `name` varchar(40) notNull unique (ej `'+5'`, `'+15'`), `transmissions` integer notNull, `priceUsd` numeric(10,2) notNull, `priceArs` numeric(10,2), `stripePriceId` varchar(255), `mpPreferencePlanId` varchar(255), `isActive` boolean default true, `sortOrder` integer default 0.

**`addon_purchases`**: `id`, `tenantId` fk cascade, `usageCycleId` fk set null, `addonId` fk plan_addons restrict, `quantity` integer notNull default 1, `transmissionsGranted` integer notNull, `amount` numeric(10,2) notNull, `currency` varchar(3) notNull, `provider` varchar(20), `externalId` varchar(255), `status` addonPurchaseStatusEnum default 'pending', `appliedAt` timestamp, `expiresAt` timestamp (fin del ciclo), `createdAt`.

**`billing_events`** (append-only): `id`, `tenantId` fk cascade, `type` varchar(60) notNull, `provider` varchar(20), `externalEventId` varchar(255), `payload` jsonb notNull default {}, `createdAt`. `unique(provider, externalEventId)`.

En `subscriptions` agregá: `pastDueSince` timestamp, `graceEndsAt` timestamp, `dunningAttempts` integer notNull default 0, `lastDunningAt` timestamp, `suspendedAt` timestamp, `trialTransmissionsIncluded` integer notNull default 2.

Exportá tablas/relaciones en `src/server/db/schema/index.ts` (relaciones de `tenants` incluídas).

**Migración**: generá con `npx drizzle-kit generate --name epic_b_billing` → `drizzle/0005_epic_b_billing.sql` + snapshot. Después **hacé el SQL idempotente** para bases ya desplegadas: `CREATE TYPE` dentro de `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`, `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`. Prohibido cambiar migraciones 0000–0004.

---

## PB-02 — Metering por transmisiones

Nuevo `src/server/services/transmissionMeteringService.ts`:

- `RELEASE_WINDOW_MINUTES = 5`
- `getOrCreateUsageCycle(tenantId)`: período = `subscription.currentPeriodStart/currentPeriodEnd` si existen; si no, mes calendario en la TZ del tenant (`tenants.timezone`, default `America/Argentina/Buenos_Aires`). `includedTransmissions` = `2` si `status='trialing'`, si no `plan.transmissionsPerCycle ?? 0`.
- `getQuotaStatus(tenantId)` → `{ planName, status, periodStart, periodEnd, included, addon, extra (tenants.config.extraTransmissions), used, remaining, percentUsed, unlimited }`.
  `remaining = max(0, included + addon + extra - used)`; si `plan.transmissionsPerCycle === null` → `unlimited: true`.
- `consumeTransmission({ tenantId, operationId, transmissionRef })` → **atómico y idempotente**:
  - si ya existe `quota_operations` con ese `(tenantId, operationId)` → devolvé `{ allowed: true, duplicate: true, ...quota }`.
  - si `unlimited` → registrá operación y devolvé `allowed: true`.
  - si `remaining <= 0` → `{ allowed: false, reason: 'QUOTA_EXCEEDED', quota }` **sin** registrar operación.
  - si hay cupo → en UNA transacción: incrementá `transmissionsUsed` con guarda (`WHERE transmissions_used < included+addon`) y insertá la operación `status='consumed'`. Usá `sql` template de drizzle y verificá `rowCount`; si 0 → no hay cupo.
- `releaseTransmission({ tenantId, operationId, reason })`: sólo si la operación está `'consumed'`; pone `status='released'`, `releasedAt`, `releaseReason`, y decrementa `transmissionsUsed` sólo si `> 0`. Idempotente.
- `releaseStaleOperations({ olderThanMinutes = RELEASE_WINDOW_MINUTES })`: libera operaciones `consumed` con `createdAt` más viejo que la ventana **y** cuya referencia ya no esté activa. La invoca `jobSchedulerService` (ver abajo) o el arranque.

**Enforcement en `POST /api/pipeline/start`** (`src/server/routes/pipeline.ts`):
- Después de `requireActiveSubscription` y de validar programa, y ANTES de crear el `AutoPipeline`:
  `const operationId = crypto.randomUUID()` → `consumeTransmission(...)`.
- Si `!allowed` → `res.status(402).json({ error: 'No te quedan transmisiones en este ciclo', code: 'QUOTA_EXCEEDED', quota, upsell: { canBuyAddons: true, canUpgrade: true } })`.
- Si `pipeline.start()` **lanza** dentro de la ventana → `releaseTransmission(...)` con `reason: 'start_failed'` (no se cobra una transmisión que nunca arrancó). Pasada la ventana se cobra igual.
- Devolvé `usage: { operationId, remaining }` en la respuesta OK.
- **Guard de regresión**: el bloqueo por cuota NO puede ejecutarse si `pipelines.get(tenantId)?.running` (una transmisión activa sigue, no se corta). Agregá un comentario explícito y no agregues chequeos de cuota en `/stop`, en el loop del pipeline ni en el scheduler sobre pipelines corriendo.
- `jobSchedulerService.ts`: agregá al tick periódico `await releaseStaleOperations()` envuelto en `try/catch` (una falla de cuota nunca tumba el scheduler).

**Endpoints nuevos en `routes/billing.ts`**:
- `GET /api/billing/quota` (auth) → `getQuotaStatus(req.auth.tenantId)`.

---

## PB-03 — Seed de planes + admin de planes

`src/server/services/planService.ts`:
- `seedPlans()`: upsert idempotente por `name` (no pisa precios si ya existen; sólo completa `null`s). Planes:
  | name | displayName | USD/mes | transmisiones | min máx | clips | personas | retención crudo | equipo | storage |
  |---|---|---|---|---|---|---|---|---|---|
  | trial | Prueba | 0 | 2 | 60 | 3 | 5 | 3 | 1 | 2 |
  | creator | Creator | 29 | 20 | 90 | 6 | 15 | 7 | 3 | 20 |
  | media | Media | 79 | 80 | 120 | 12 | 50 | 15 | 8 | 100 |
  | network | Network | 199 | 250 | 180 | 25 | 200 | 30 | 25 | 400 |
  | enterprise | Enterprise | 0 (a medida) | null (ilimitado) | 240 | 50 | null | 90 | 100 | 1000 |
  `trial` con `isActive=false, sortOrder=-1` (no se muestra en la grilla pública); el resto `isActive=true`.
  `features` jsonb: mantener las flags existentes coherentes (`advanced_analytics`, `api_access`, `priority_transcription`, `multi_provider_ai`…) — copiá las que ya use `tenantFeaturesService.builder`.
- Script `scripts/seed-plans.ts` (`npx tsx scripts/seed-plans.ts`).
- Llamá `seedPlans()` en `src/server/index.ts` al arrancar, en `try/catch` (no debe tumbar el server sin DB).
- `listPlans()` (todos, incluye inactivos) y `updatePlan(id, patch)` con Zod en la ruta. Al cambiar límites/planes, **auditar** con `AUDIT_ACTIONS.ADMIN_PLAN_CHANGED`.

Rutas admin (`src/server/routes/admin.ts`, router ya protegido por `requirePlatformAdmin`):
- `GET /api/admin/plans`
- `PATCH /api/admin/plans/:id` (displayName, priceUsd, priceUsdYearly, priceArs, priceArsYearly, transmissionsPerCycle, maxTransmissionMinutes, maxClipsPerTransmission, maxPeople, rawRetentionDays, maxTeamMembers, maxStorageGb, isActive, sortOrder)

UI: `src/client/pages/admin/AdminPlans.tsx` (tabla editable de límites/precios, toggles de activo) + ruta en `src/client/main.tsx` + link en `AdminLayout.tsx`.

---

## PB-04 — Checkout MercadoPago + Stripe: alta, cambio con prorrateo, cancelación

**Fix crítico del webhook Stripe**: en `src/server/index.ts`, ANTES de `app.use(express.json({...}))`, registrá:
```ts
app.use('/api/billing/webhook/stripe', express.raw({ type: '*/*' }));
```
y en `routes/billing.ts` usá `stripe.webhooks.constructEvent(req.body as Buffer, sig, secret)` (aceptá también `Buffer.isBuffer(req.body) === false` → 400, no `JSON.stringify`).

**Idempotencia**: cada webhook escribe primero en `billing_events` con `(provider, externalEventId)` único; si el insert choca (evento repetido) → respondé `{received:true}` sin reprocesar.

`POST /api/billing/checkout`: mantener; agregar `metadata.kind = 'subscription'`.
`POST /api/billing/change-plan` (auth + owner): `{ planName, billingPeriod, provider }`, body validado con Zod.
- Stripe con suscripción externa: `stripe.subscriptions.update(externalSubscriptionId, { items: [{ id: itemId, price: newPriceId }], proration_behavior: 'create_prorations', cancel_at_period_end: false })`. Actualizá `subscriptions.planId/currentPeriodStart/currentPeriodEnd` con lo que devuelve Stripe.
- Stripe sin suscripción externa → comportamiento de `/checkout`.
- MercadoPago: **no hay prorrateo real** en `PreApproval`. Implementá cambio **efectivo al final del ciclo**: guardá `pendingPlanId` en `tenants.config.pendingPlan` (o tabla si preferís, pero documentá) y aplicá el cambio en el webhook/lifecycle cuando cierre el período. Documentá el límite en el comentario del handler.
- Auditoría `BILLING_PLAN_CHANGED` con `{ from, to, provider, proration }`.

`POST /api/billing/cancel`: mantener `cancelAtPeriodEnd`. Agregá `POST /api/billing/reactivate` (auth+owner) → `cancelAtPeriodEnd=false`, `canceledAt=null` y reactiva en Stripe si aplica.

**Webhook events a manejar** (Stripe): `checkout.session.completed` (suscripción **y** add-on, según `metadata.kind`), `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` (sincronizar plan/periodo/cancelAtPeriodEnd), `customer.subscription.deleted`.
**MP**: `subscription_preapproval` (authorized/paused/cancelled) y `payment` (approved/rejected).

---

## PB-05 — Add-ons de transmisiones (+5 / +15), expiran con el ciclo

- Seed en `seedPlans()`: `plan_addons` `'+5'` (5 transmisiones, USD 19, ARS 19000) y `'+15'` (15, USD 45, ARS 45000).
- `GET /api/billing/addons` (auth) → catálogo activo + `usageCycleId` actual.
- `POST /api/billing/addons/checkout` (auth+owner) `{ addonName, provider }`:
  - Stripe: `checkout.sessions.create({ mode: 'payment', line_items: [...], metadata: { kind: 'addon', tenantId, addonName, usageCycleId } })`. Si el add-on no tiene `stripePriceId`, usá `price_data` inline con `priceUsd`.
  - MP: `Preference`/`Payment` de pago único — si la SDK instalada no expone `Preference`, usá `Payment` con `external_reference: 'addon_<tenantId>_<addonName>_<usageCycleId>'` y documentá.
- Al confirmarse el pago (`applyAddonPurchase`): en transacción → `usage_cycles.addonTransmissions += transmissionsGranted`, `addon_purchases` a `paid` con `appliedAt=now`, `expiresAt=usageCycle.periodEnd`. Idempotente por `(provider, externalId)`.
- Como los add-ons viven en la fila del ciclo, **expiran solos** al abrirse el ciclo siguiente (el ciclo nuevo arranca con `addonTransmissions=0`). No los arrastres.

---

## PB-06 — Paywall UX: bloqueo suave + modal + banners

- Hook `src/client/hooks/useQuota.ts`: `{ quota, loading, refresh }` sobre `GET /billing/quota`.
- `src/client/components/billing/UpgradeModal.tsx`: modal con planes (`/billing/plans`) + add-ons (`/billing/addons`), CTA a checkout y a compra de add-on. Debe abrirse cuando el start devuelve `code === 'QUOTA_EXCEEDED'`.
- `src/client/components/billing/UsageBanner.tsx`: banner de uso. `>80%` → warning ámbar ("te quedan N transmisiones"); `>=100%` → rojo con CTA. Se monta en `Dashboard.tsx` y en `BillingPage`.
- **Bloqueo suave** = el contenido existente (notas, clips, historial, facturación) sigue visible; sólo se bloquea **iniciar una transmisión nueva**. No bloquees la app entera.
- En la pantalla de inicio de pipeline (`Dashboard.tsx` / donde se dispara `/api/pipeline/start`): si llega 402 con `QUOTA_EXCEEDED`, abrí `UpgradeModal` con el detalle de cuota en vez de un toast genérico.

---

## PB-07 — Ciclo de vida de la suscripción

`src/server/services/subscriptionLifecycleService.ts`:
- `TRIAL_DAYS = 7`, `TRIAL_TRANSMISSIONS = 2`, `GRACE_DAYS = 7`, `MAX_DUNNING_ATTEMPTS = 3`.
- `startTrial(tenantId)` — usado por `authService.register`: plan `trial`, `status='trialing'`, `trialEndsAt=now+7d`, `trialTransmissionsIncluded=2`. Si no existe el plan `trial`, no rompas el registro (log + seguir).
- `recordBillingEvent({ tenantId, type, provider, externalEventId, payload })` (append-only, idempotente por provider+externalEventId).
- `handlePaymentFailed(tenantId, provider)` → `dunningAttempts++`, `status='past_due'`, `pastDueSince ??= now`, `graceEndsAt = now + 7d`, email de pago fallido con número de intento. Si `dunningAttempts >= 3` → `suspendSubscription(tenantId)`.
- `handlePaymentSucceeded(tenantId)` → `status='active'`, `dunningAttempts=0`, `pastDueSince=null`, `graceEndsAt=null`, email de pago ok, **reabre ciclo de uso** si cambió el período.
- `suspendSubscription(tenantId)` → `status='suspended'`, `suspendedAt=now`, email de suspensión, evento.
- `evaluateTransitions()` (corre en el tick del scheduler + arranque, `try/catch`):
  - `trialing` con `trialEndsAt < now` → `expired` (evento + email de trial vencido).
  - `past_due` con `graceEndsAt < now` → `suspended`.
  - `cancelAtPeriodEnd && currentPeriodEnd < now` → `canceled`.
  - aplica `tenants.config.pendingPlan` cuando `currentPeriodEnd < now` (cambio diferido de MP).
- `requireActiveSubscription` ya bloquea `past_due`? **No**: hoy acepta sólo `trialing|active`, así que un `past_due` queda bloqueado al instante. Ajustalo: permitir `past_due` **dentro de la gracia** (`graceEndsAt > now`) para que el dunning no corte el servicio el día 1, y devolver `code: 'PAYMENT_OVERDUE'` con los días restantes cuando esté en gracia.
- Programá `evaluateTransitions()` en `jobSchedulerService` (cada ~15 min) y una vez al arrancar.

---

## PB-08 — Página Facturación

Ampliá `src/client/pages/BillingPage.tsx` (sin romper lo que ya funciona):
- Card de plan actual (nombre, estado, período, botón upgrade/downgrade/cancelar/reactivar).
- **Medidor de uso**: transmisiones `used / (included + addon + extra)` con barra, % y aviso >80%; si es ilimitado, mostralo como "ilimitado".
- Historial de facturas (ya existe) con estado legible.
- Compra de add-ons (+5 / +15) con precio en la moneda elegida.
- Trial: días restantes + transmisiones restantes del trial.
- Errores claros si el provider no está configurado (503) — no pantalla en blanco.

---

## PB-09 — Emails transaccionales

En `src/server/services/emailService.ts` agregá (reusando `sendEmail`, que ya no-op sin SMTP):
- `sendTrialEndingEmail(email, name, daysLeft)`
- `sendTrialExpiredEmail(email, name)`
- `sendPaymentSucceededEmail(email, name, amount, currency, planDisplayName)`
- `sendPaymentFailedEmail(email, name, attempt, graceEndsAt)`
- `sendSubscriptionSuspendedEmail(email, name)`
- `sendAddonPurchasedEmail(email, name, transmissions, expiresAt)`

Disparadores:
- trial por vencer: en `evaluateTransitions()`, trials con `<= 2` días, una sola vez (dedupe con `billing_events` tipo `trial_ending_notified`).
- pago ok/fallido/suspensión: desde los webhooks vía `subscriptionLifecycleService`.
- add-on: al aplicar la compra.
Buscá el email del owner con `users` por `tenants.ownerId` (o el usuario `role='owner'` del tenant).

---

## Verificación obligatoria (gates) — correr y pegar salida real

1. `npx tsc --noEmit` → **EXIT 0**.
2. `npm run build` → **EXIT 0** (client + server + `drizzle-kit generate` debe decir `No schema changes` al final).
3. **Migración real**: escribí `scripts/verify-migration-pglite.mjs` que:
   - levanta `@electric-sql/pglite` en memoria,
   - aplica en orden todos los `drizzle/*.sql`,
   - **aplica la 0005 dos veces** (prueba de idempotencia),
   - imprime `OK` + la lista de tablas nuevas (`usage_cycles`, `quota_operations`, `plan_addons`, `addon_purchases`, `billing_events`) y columnas nuevas de `plans`/`subscriptions`.
   Corré `node scripts/verify-migration-pglite.mjs` → EXIT 0 con esa salida.
4. `npx tsx scripts/seat-plans...` no: corré `npx tsx scripts/seed-plans.ts` sólo si hay `DATABASE_URL`; si no, omitilo y decilo.
5. Lógica pura: extraé la matemática de cuota/prorrateo a `src/server/lib/quotaMath.ts` (`computeRemaining`, `computePercentUsed`, `isWarning`, `computeProrationAmount`) y verificá con `npx tsx scripts/verify-quota-math.ts` (assercións con `node:assert`, imprime `quota-math OK`). Casos: remaining 0, warning >80, ilimitado, prorrateo a mitad de ciclo.
6. `git status --porcelain` al final: árbol limpio (todo commiteado).

## Reporte final (obligatorio)
Para cada PB-0X: `[x]` + SHA + qué archivos + cómo se verificó. Y una sección **NO VERIFICADO** con lo que no pudiste ejecutar (Stripe/MP reales, SMTP, Postgres real) y por qué. Sin adornos: si un gate falló, decilo con el error.
