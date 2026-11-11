# PH-05 — Estados vacíos / loading / error consistentes en todos los módulos

## Contexto

- Repo: `periodistapp` (Express 4 + TS + React SPA + Drizzle/Postgres + Vite).
- Worktree AISLADO: `C:/Users/Asus/orca/workspaces/periodistapp/ph-05-empty-states`, rama `ph-05-empty-states`.
- Base yaHF: `aa7f200` (= `origin/ph-04-dashboard-now`), que encadena Épica G completa + PH-01..PH-04.
- El checkout COMPARTIDO `C:/Users/Asus/Documents/estabilizacion/periodistapp` es de SOLO LECTURA: NO lo toques, NO commitees ahí.

## Objetivo

Unificar los tres estados de toda vista de datos — **vacío**, **cargando** y **error** — en componentes
compartidos, y aplicarlos en todos los módulos del workspace. Hoy cada pantalla inventa su propio spinner,
su propio texto de vacío y su propio try/catch: eso produce pantallas en blanco, spinners eternos y errores
crudos que muestran nombres de campos internos al usuario.

## Qué hay que hacer

1. **Componentes compartidos** en `src/client/components/feedback/` (crear la carpeta):
   - `EmptyState` — ilustración/ícono + título + descripción + acción opcional. Reusar el patrón que ya
     existe en `src/client/pages/Dashboard.tsx` (PH-04) como referencia de forma, pero **extraerlo** a un
     componente compartido y reutilizarlo desde Dashboard y desde el resto.
   - `LoadingState` — spinner con skeleton opcional y texto (`aria-busy`, `role="status"`).
   - `ErrorState` — mensaje legible para el usuario + acción "Reintentar" que vuelve a disparar la carga.
     **Nunca** renderizar el mensaje crudo de la API ni stack traces.
2. **Hook de carga** compartido, p. ej. `useAsyncData<T>()`, que devuelva
   `{ data, loading, error, reload }` y maneje el caso de error parcial (al endpoint que falla).
   Debe evitar el patrón `setLoading(true)` dentro del `useEffect` (regla ESLint `react-hooks/set-state-in-effect`
   en este repo: diferir con `void Promise.resolve().then(() => load())`).
3. **Aplicar** a todos los módulos con datos. Módulos a cubrir (verificá la lista real en `src/client/pages/`):
   `/assets`, `/publish`, `/en-vivo`, `/agenda`, `/pacientes`, `/programas`, `/historial`, `/revision`,
   `/personas`, `/materiales`, `/configuracion`, `/agenda`, `/dashboard`, `/leads`, `/reportes`.
   **Prioridad:** los que hoy muestran pantalla en blanco o texto crudo de error.
4. **Mensajes en español rioplatense**, sin jerga técnica. Estados vacíos que expliquen **qué hacer**
   (no sólo "no hay datos"): p. ej. en `/assets`: "Todavía no hay materiales" + acción "Subir el primero".
5. **Estados de error differentiated**: sin conexión, sin permisos (403 → "no tenés acceso a esto"), y
   error genérico. El 403 no debe decir "ocurrió un error".

## Criterios de aceptación (TODOS obligatorios)

- Cada módulo con datos usa los componentes compartidos; no queda un spinner/empty/error propio.
- El componente `ErrorState` nunca muestra el texto crudo de la API.
- Tests: para cada componente compartido, tests propios (vacío, cargando, error, 403, reintento) y al menos
  un test de integración por módulo representativo (`/assets` y `/publish` como mínimo) verificando que
  renderiza vacío cuando la API devuelve `[]`, y ErrorState cuando la API falla.
- `npx tsc --noEmit` → **EXIT 0**.
- `npx vitest run` → **EXIT 0** con línea de resumen explícita (`Test Files N passed (N)` / `Tests N passed (N)`).
- `npm run build` → **EXIT 0** (si generás migraciones, deben ser idempotentes; este slice NO debería
  necesitar migraciones: es UI).
- `git diff --check` → sin salida.
- **UTF-8 intacto**: nada de `Ã` / `Â` / `�` en los archivos que escribas (verificá con grep antes de commitear).

## Reglas de ejecución

- Trabajá **de forma autónoma**: no esperes aprobación ni perguntes. El bypass de permisos ya está activo.
- **Un commit por unidad lógica**, mensajes convencionales (`feat|fix|refactor|test|docs(chore): ...`),
  **paths explícitos** (nunca `git add -A`), **sin atribución de IA**.
- **NO** hagas push, NO mergees a `master`, NO deployes, NO corras migraciones contra producción.
- Al terminar: reportá los SHAs, el conteo exacto de tests y el resultado de cada gate.
- Si un gate falla, **no lo declares verde**: reportá el output real y qué falta.

## Antes de terminar

Dejá el árbol limpio (todo commiteado) y verificá con `git status --porcelain` que no queda nada sin commitear
salvo que sea deliberadamente no commiteable (y entonces decilo explícitamente en el reporte).
