# PH-06 — Emails con branding de plataforma

## Contexto

- Repo: `periodistapp` (Express 4 + TS + React SPA + Drizzle/Postgres + Vite).
- Worktree AISLADO: `C:/Users/Asus/orca/workspaces/periodistapp/ph-06-email-branding`, rama `ph-06-email-branding`.
- Base ya entregada: `cbfa55b` (= `origin/ph-05-empty-states`), que encadena Épica G + PH-01..PH-05.
- El checkout COMPARTIDO `C:/Users/Asus/Documents/estabilizacion/periodistapp` es de SOLO LECTURA: NO lo toques ni commitees ahí.

## Estado actual (verificado, no inventes)

`src/server/services/emailService.ts` tiene un `sendEmail(to, subject, html)` y **10 emails con HTML inline hardcodeado**:
`sendVerificationEmail`, `sendWelcomeEmail`, `sendPasswordResetEmail`, `sendTeamInviteEmail`,
`sendTrialEndingEmail`, `sendTrialExpiredEmail`, `sendPaymentSucceededEmail`, `sendPaymentFailedEmail`,
`sendAddonPurchasedEmail`, `sendSubscriptionSuspendedEmail`.

Cada uno construye su propio `<html>` con estilos distintos: eso es exactamente lo que hay que unificar.
Además el `from` está fijo: `SMTP_FROM || 'PeriodistApp <noreply@periodistapp.com>'`.

## Qué hay que hacer

1. **Plantilla base con branding** — un único layout reutilizable, p. ej.
   `src/server/services/emailTemplates.ts` (o `src/server/emails/layout.ts`), que envuelva el contenido y
   aplique:
   - el **color de marca del tenant** cuando exista (verificá cómo el branding por tenant se guarda:
     `tenantFeaturesService`, `brandingService` o la tabla `tenants.config`; NO inventes un esquema nuevo
     si ya existe uno — leé el código real primero).
   - el **logo** del tenant si hay URL pública; si es blob autenticado, usá un fallback de texto/monograma.
   - un pie con razón social, enlaces legales y "te llegó este mail porque..." (transparencia).
   - **tabla de estilos inline** (los clientes de email no soportan `<style>` en todos los clientes).
2. **Migrar los 10 emails** a la plantilla, sin cambiar su contenido funcional ni sus variables.
   Cada email debe seguir enviando lo mismo: mismos links, mismos datos, mismo `subject`.
3. **Fallback sin configuración**: si el tenant no tiene branding, el mail debe salir con el branding
   **de plataforma** (por defecto), nunca roto ni vacío. Definí los defaults de plataforma en un solo lugar.
4. **Sin datos sensibles en el mail**: nunca incluir contraseñas, tokens sin expirar, ni credenciales.
   Los tokens de verificación y reset siguen siendo de un solo uso — no cambiar ese comportamiento.
5. **Texto alternativo**: cada mail debe incluir una versión `text` en texto plano (no sólo HTML), porque
   muchos clientes lo usan. `sendEmail` hoy sólo manda `html`: aggregate el campo `text`.

## Criterios de aceptación (TODOS obligatorios)

- Los 10 emails usan la plantilla compartida: **cero `<html>` inline por email**. Verificable con grep:
  no debe haber `sendVerificationEmail` ni los demás armando su propio `<html>`.
- Un **render helper testeable**: `renderEmail({...}) → { html, text }`, sin enviar nada. Eso permite testear
  sin SMTP.
- **Tests propios** del render helper:
  - con branding de tenant (color + logo) → aparecen en el HTML.
  - sin branding → usa los defaults de plataforma y **no rompe**.
  - la versión `text` contiene los mismos datos clave (links y montos).
  - los 10 tipos de email renderizan sin error y contienen su contenido esperado.
- `npx tsc --noEmit` → **EXIT 0**.
- `npx vitest run` → **EXIT 0** con línea de resumen explícita (`Test Files N passed (N)` / `Tests N passed (N)`).
- `npm run build` → **EXIT 0** (este slice NO debería tocar el schema; si generás migraciones, deben ser
  idempotentes y verificables con `node scripts/verify-migration-pglite.mjs`).
- `git diff --check` → sin salida.
- **UTF-8 intacto**: nada de `Ã` / `Â` / `�` en lo que escribas (verificá con grep antes de commitear).

## Reglas de ejecución

- Trabajá **de forma autónoma**: no esperes aprobación ni preguntes. El bypass de permisos ya está activo.
- **Un commit por unidad lógica**, mensajes convencionales (`feat|fix|refactor|test|docs(chore): ...`),
  **paths explícitos** (nunca `git add -A`), **sin atribución de IA**.
- **NO** hagas push, NO mergees a `master`, NO deployes, NO envíes emails reales, NO corras migraciones
  contra producción.
- Si un gate falla, **no lo declares verde**: reportá el output real y qué falta.

## Antes de terminar

Dejá el árbol limpio (todo commiteado) y verificá con `git status --porcelain` que no queda nada sin commitear
salvo que sea deliberadamente no commiteable (y entonces decilo explícitamente en el reporte).
