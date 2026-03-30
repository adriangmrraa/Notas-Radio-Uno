# Fase 1: Auth UI + Tailwind + App Shell
> Origen: Transformacion SaaS Periodistapp — conversacion 2026-03-28

## 1. Contexto y Objetivos

- **Problema:** El backend auth existe completo (register, login, JWT, email verification, roles, subscription guard) pero el frontend no tiene ninguna pagina de auth ni layout SaaS. La app es un single-page sin proteccion.
- **Solucion:** Crear auth pages (login/register/forgot-password), instalar Tailwind con dark theme premium, crear app shell con sidebar, y proteger rutas.
- **KPIs:** Usuario puede registrarse, loguearse, ver dashboard protegido, y ser redirigido a login si no esta autenticado.

## 2. Esquemas de Datos

- **Entradas:** email, password, fullName, organizationName (register); email, password (login)
- **Salidas:** JWT en HttpOnly cookie, user object con tenant_id, role, subscription status
- **Persistencia:** Sin cambios en DB schema — usa endpoints existentes

## 3. Logica de Negocio (Invariantes)

- SI usuario no autenticado ENTONCES redirect a /login
- SI JWT expira ENTONCES redirect a /login (401 handling)
- SI subscription expired ENTONCES redirect a /billing (402 handling)
- SI usuario no verificado ENTONCES mostrar banner "Verifica tu email"
- RESTRICCION: JWT se envia como HttpOnly cookie con credentials: 'include'
- SOBERANIA: tenantId se resuelve del JWT en el backend, nunca del frontend

## 4. Stack y Restricciones

- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS + Lucide React
- **Backend:** Sin cambios — endpoints /api/auth/* ya existen
- **Routing:** React Router v7 con rutas protegidas
- **Styling:** Dark theme premium (bg-[#06060e], glassmorphism, cyan accent)

## 5. Criterios de Aceptacion (Gherkin)

### Escenario 1: Registro exitoso
- DADO que estoy en /register
- CUANDO completo email, password, nombre y organizacion y hago submit
- ENTONCES veo mensaje "Verifica tu email" y soy redirigido a /login

### Escenario 2: Login exitoso
- DADO que estoy en /login con cuenta verificada
- CUANDO ingreso email y password correctos
- ENTONCES soy redirigido a /dashboard y veo el sidebar

### Escenario 3: Ruta protegida sin auth
- DADO que no estoy logueado
- CUANDO intento acceder a /dashboard
- ENTONCES soy redirigido a /login

### Escenario 4: Login con credenciales incorrectas
- DADO que estoy en /login
- CUANDO ingreso password incorrecta
- ENTONCES veo error "Email o contraseña incorrectos"

### Escenario 5: Forgot password
- DADO que estoy en /forgot-password
- CUANDO ingreso mi email
- ENTONCES veo mensaje "Revisa tu email para resetear tu password"

## 6. Archivos Afectados

| Archivo | Tipo | Cambio |
|---|---|---|
| `package.json` | MODIFY | Agregar tailwindcss, postcss, autoprefixer, lucide-react, @tailwindcss/forms |
| `tailwind.config.js` | CREATE | Config con dark theme |
| `postcss.config.js` | CREATE | PostCSS plugins |
| `src/client/index.css` | CREATE | Tailwind directives + globals |
| `src/client/App.tsx` | MODIFY | Reestructurar routing completo |
| `src/client/main.tsx` | MODIFY | Agregar AuthProvider |
| `src/client/contexts/AuthContext.tsx` | CREATE | Auth state + methods |
| `src/client/hooks/useApi.ts` | CREATE | Fetch wrapper con auth |
| `src/client/pages/Login.tsx` | CREATE | Login page |
| `src/client/pages/Register.tsx` | CREATE | Register page |
| `src/client/pages/ForgotPassword.tsx` | CREATE | Forgot password page |
| `src/client/pages/Dashboard.tsx` | CREATE | Dashboard (wrapper del App actual) |
| `src/client/components/Layout.tsx` | CREATE | Shell con sidebar |
| `src/client/components/Sidebar.tsx` | CREATE | Navegacion lateral |
| `src/client/components/PrivateRoute.tsx` | CREATE | Route guard |

## 7. Casos Borde y Riesgos

| Riesgo | Mitigacion |
|---|---|
| App.tsx actual tiene 1100 lineas de logica | Mover todo a Dashboard.tsx, App.tsx solo routing |
| CSS existente (App.css 1381 lineas) puede conflictuar con Tailwind | Mantener App.css para el dashboard legacy, Tailwind para nuevas pages |
| Pipeline editor usa ReactFlow con CSS propio | No tocar editor, solo agregar shell alrededor |
| Backend espera organizationName en register | Mapearlo como store_name en el frontend |
