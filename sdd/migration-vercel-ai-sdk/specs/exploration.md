# Exploration: Migration Roadmap - Vercel AI SDK + shadcn/ui + AI Elements

## Current State

El proyecto **PeriodistApp** es una aplicación de AI Newsroom Automation con:

### Frontend Stack (to migrate)
- React 19 + Vite 6 + Tailwind CSS 4
- React Flow (@xyflow/react) para pipeline visualization
- Custom CSS (746 líneas en index.css + 1381 líneas en App.css) con glassmorphism
- Socket.IO client para real-time updates
- lucide-react para iconos
- Zustand (solo tipos, no implementado aún)

### Backend Stack (se mantiene)
- Express + TypeScript
- Prisma (SQLite/PostgreSQL)
- Socket.IO server
- AI Service: DeepSeek + Gemini con llamadas REST (sin streaming)

### UI Components to Migrate
- Sidebar (custom CSS en index.css líneas 222-505)
- Modals (custom CSS en index.css líneas 691-712)
- Activity Cards (custom CSS en App.css líneas 653-794)
- Pipeline visualization (React Flow en PipelineEditor.tsx)

### AI Integration Actual
- `aiService.ts` usa DeepSeek y Gemini con axios
- No hay streaming actualmente
- Solo llamadas request/response

---

## Affected Areas

### Files que se deben modificar:

| File | Why |
|------|-----|
| `package.json` | Agregar dependencias: shadcn/ui, ai, streamdown |
| `tailwind.config.js` | Configurar shadcn/ui |
| `src/client/index.css` | Migrar a componentes shadcn |
| `src/client/App.css` | Migrar a shadcn + animaciones |
| `src/client/components/Sidebar.tsx` | → shadcn NavigationMenu |
| `src/client/components/Layout.tsx` | → shadcn Layout components |
| `src/client/pages/Dashboard.tsx` | → shadcn Cards, Badge |
| `src/client/editor/PipelineEditor.tsx` | Mantener React Flow + shadcn |
| `src/client/App.tsx` | → shadcn components |
| `src/server/services/aiService.ts` | → Migrar a Vercel AI SDK |
| `src/client/hooks/usePipelineState.tsx` | Agregar streaming UI |

---

## Approaches

### 1. Incremental Migration (RECOMMENDED)
Migrar componente por componente manteniendo ambos sistemas temporalmente.

**Pros:**
- Menor riesgo por fase
- Testing continuo en cada paso
- Posibilidad de rollback por componente
- Equipo puede seguir desarrollando features

**Cons:**
- Puede generar inconsistencias visuales temporalmente
- Más tiempo total de migración
- Requiere mantener dos sistemas en paralelo

**Complexity:** Medium

### 2. Big Bang Migration
Migrar todo junto con nueva UI simultáneamente.

**Pros:**
- Consistencia total desde el inicio
- Refactor completo sin deuda técnica
- No hay mantenimiento de sistemas duales

**Cons:**
- Alto riesgo de bugs ocultos
- Freeze de desarrollo durante migración
- Rollback difícil si hay problemas

**Complexity:** High

### 3. Parallel + Feature Flags
Nueva UI en paralelo con feature flags para rollout gradual.

**Pros:**
- Control total de qué se muestra
- Rollback instantáneo por feature
- Testing A/B posible

**Cons:**
- Complejidad en mantener dos sistemas
- Feature flags pueden crear deuda
- Requiere más testing

**Complexity:** High

---

## Recommended Approach

**Enfoque: Incremental Migration por fases**

Con la siguiente secuencia:

1. **Fase 0:** Preparación (deps + config)
2. **Fase 1:** Foundation (shadcn + Tailwind theme)
3. **Fase 2:** UI Components (Sidebar → Modals → Cards)
4. **Fase 3:** Pipeline Visualization (React Flow + animaciones)
5. **Fase 4:** AI Integration (Vercel AI SDK + streaming)

---

## Phase 1: Setup & Foundation

### Tasks:

1.1 **Install shadcn/ui**
```bash
npx shadcn@latest init -d
```

Componentes necesarios:
- `npx shadcn@latest add button card dialog sheet navigation-menu avatar dropdown-menu badge skeleton tooltip popover select textarea input label tabs card`

1.2 **Configure Tailwind theme**
- Mapear colores existentes de `index.css` a shadcn CSS variables
- Mantener el theme dark actual (--color-void, --color-surface)
- Agregar animations de Tailwind 4 a shadcn

1.3 **Install Vercel AI SDK**
```bash
npm install ai @ai-sdk/react
```

1.4 **Install Streamdown** (para streaming UI)
```bash
npm install streamdown
```

### Dependencies a agregar en package.json:
```json
{
  "ai": "^4.0.0",
  "@ai-sdk/react": "^0.0.0",
  "streamdown": "^2.0.0",
  "class-variance-authority": "^0.7.0",
  "clsx": "^2.1.0",
  "tailwind-merge": "^2.2.0",
  "@radix-ui/react-dialog": "^1.0.5",
  "@radix-ui/react-navigation-menu": "^1.1.4",
  "@radix-ui/react-slot": "^1.0.2"
}
```

---

## Phase 2: UI Component Migration

### 2.1 Migrate Sidebar → shadcn

**Archivo:** `src/client/components/Sidebar.tsx`

**Componentes shadcn a usar:**
- `NavigationMenu` para estructura
- `Button` variant="ghost" para items
- `Avatar` para user card

**Mapeo de CSS:**
- `.sidebar-root` → `NavigationMenu`
- `.sidebar-item` → `Button variant="ghost"`
- `.sidebar-avatar` → `Avatar`

**Proceso:**
1. Crear componente `Sidebar` nuevo con shadcn
2. Testear navegación
3. Eliminar CSS antiguo

### 2.2 Migrate Modals → shadcn Dialog/Sheet

**Archivos afectados:**
- `AgentConfigModal` en `PipelineEditor.tsx`
- `ImageEditModal` en `App.tsx`
- `NoteModal` en `App.tsx`

**Componentes shadcn:**
- `Dialog` para modales principales
- `Sheet` para sidebars

**Proceso:**
1. Reemplazar `.modal-overlay` con shadcn `Dialog`
2. Animaciones con `Dialog.Portal` + CSS

### 2.3 Create Activity Cards con shadcn

**Archivo:** `src/client/App.tsx` - `ActivityCard`

**Componentes shadcn:**
- `Card` para contenedor
- `CardHeader`, `CardTitle`, `CardContent`
- `Badge` para status
- `Skeleton` para loading

---

## Phase 3: Pipeline Visualization

### 3.1 Redesign Pipeline View

**Mantener:**
- React Flow (`@xyflow/react`) — funciona bien
- Socket.IO real-time

**Mejorar:**
- Nodos con shadcn `Card`
- Edges con animaciones CSS
- MiniMap con shadcn styling

### 3.2 Add Animations

De `index.css` a mantener:
- `@keyframes slideUp` → Tailwind `animate-slide-up`
- `@keyframes fadeIn` → Tailwind `animate-fade-in`
- `@keyframes glowPulse` → Custom utility

### 3.3 Integrate with Socket.IO

**Verificar:**
- `usePipelineState.tsx` sigue funcionando
- Eventos `pipeline-update` se renderizan correctamente
- Fallback si Socket desconecta

---

## Phase 4: AI Integration

### 4.1 Migrate AI calls to Vercel AI SDK

**Archivo:** `src/server/services/aiService.ts`

**Cambios:**
```typescript
// Antes (axios)
const response = await axios.post(DEEPSEEK_API, body, {
  headers: { Authorization: `Bearer ${apiKey}` }
});
return response.data.choices[0].message.content;

// Después (Vercel AI SDK)
import { generateText } from 'ai';
const { text } = await generateText({
  model: deepseek('deepseek-chat'),
  messages: [{ role: 'user', content: userPrompt }],
  system: systemPrompt,
});
return text;
```

### 4.2 Add Streaming UI

**Archivo:** Componentes que usan AI (TBD)

**Pattern:**
```typescript
import { useCompletion } from '@ai-sdk/react';

function AIComponent() {
  const { completion, input, handleInputChange, handleSubmit } = useCompletion({
    api: '/api/ai/chat',
    onFinish: (prompt, completion) => {
      // Handle streaming complete
    }
  });

  return (
    <div>
      <p>{completion}</p>
    </div>
  );
}
```

### 4.3 Integrate Streamdown

Para manejo avanzado de streaming:
```typescript
import { createStreamableValue } from 'ai';
import { streamText } from 'ai';
```

---

## Risks

### High Risk
1. **Glassmorphism effects** — El diseño actual usa `.glass-card`, backdrop-filter, gradientes. shadcn no tiene equivalentes directos.
   - **Mitigation:** Crear custom shadcn variants o mantener CSS parcial.

2. **Real-time updates** — Socket.IO debe seguir funcionando durante y después de migración.
   - **Mitigation:** No modificar `useSocket.ts` hasta Fase 3. Testing E2E del pipeline.

3. **Theme consistency** — Tailwind 4 con @theme vs shadcn CSS variables.
   - **Mitigation:** Usar shadcn CSS variables como source of truth, mapear Tailwind a estas.

### Medium Risk
4. **React 19 compatibility** — shadcn/ui usa Radix UI que debería ser compatible, pero verificar.
   - **Mitigation:** Testing en dev primero.

5. **Breaking changes Vercel AI SDK v4** — SDK puede tener cambios de API.
   - **Mitigation:** Lockear versión, leer changelog antes de actualizar.

### Low Risk
6. **Bundle size** — Agregar shadcn + AI SDK incrementa bundle.
   - **Mitigation:** Usar code splitting, lazy load AI components.

---

## What Can Break

| Feature | Risk | Impact |
|---------|------|--------|
| Pipeline real-time | HIGH | Perder eventos de estado |
| Activity Cards streaming | HIGH | UI no muestra progreso |
| Glassmorphism effects | MEDIUM | Diseño pierde identidad visual |
| Sidebar navigation | MEDIUM | No se puede navegar |
| Modals | LOW | Experience degradada |
| AI generation | LOW | Errores en generación |

---

## What Needs Testing

### E2E Tests
1. **Pipeline Flow:**
   - Start pipeline → Verificar activity cards aparecen
   - Stop pipeline → Verificar estado se actualiza
   - Reconnect socket → Verificar recovery

2. **Navigation:**
   - Sidebar → Todas las rutas funcionan
   - Modals → Open/close sin glitches
   - Responsive → Mobile view funciona

3. **AI:**
   - Streaming → Texto aparece gradualmente
   - Error handling → Fallback a no-streaming

### Visual Regression Tests
- Snapshot de Dashboard
- Snapshot de Pipeline Editor
- Snapshot de Sidebar

---

## Rollback Plan

### Strategy: Feature Flag + Branch

1. **Branch Strategy:**
   - `main` → siempre estable
   - `feature/migration` → desarrollo de migración
   - PRs atómicos por fase

2. **Feature Flags:**
   ```typescript
   // toggle para nueva UI
   const USE_SHADCN = process.env.VITE_USE_SHADCN === 'true';
   
   // en componentes
   {USE_SHADCN ? <NewSidebar /> : <OldSidebar />}
   ```

3. **Rollback Steps:**
   - Si falla Fase 2: Revertir cambios, mantener old Sidebar
   - Si falla Fase 4: Revertir aiService, mantener axios calls
   - Si falla todo: Descartar branch, seguir en main

4. **Tiempo de rollback:** 15-30 minutos por fase

---

## Timeline Estimate

| Phase | Effort | Duration |
|-------|--------|----------|
| Phase 1: Setup | 2 days | 2 days |
| Phase 2: UI Components | 5 days | 1 week |
| Phase 3: Pipeline | 3 days | 3-4 days |
| Phase 4: AI | 4 days | 1 week |
| **Total** | **~14 days** | **~3 weeks** |

---

## Ready for Proposal

**Yes** — Este análisis es suficiente para crear el proposal formal.

### El orchestrator debe decir al usuario:
1. ¿Confirmás el enfoque incremental por fases?
2. ¿Prioridad de migración? (UI primero o AI primero)
3. ¿Timeline aceptable de ~3 semanas?
4. ¿Resource availability para code review por fase?

---

## Appendix: Color Mapping

### Current → shadcn

| Current CSS Variable | Value | shadcn Mapping |
|---------------------|-------|----------------|
| `--color-void` | #060610 | `background` |
| `--color-surface` | #0a0e1a | `background` |
| `--color-card` | rgba(255,255,255,0.025) | `card` |
| `--color-border` | rgba(255,255,255,0.05) | `border` |
| Accent cyan | #22d3ee | `primary` |
| Accent purple | #a78bfa | `secondary` |
| Success | #00d4aa | `success` |
| Warning | #f59e0b | `warning` |
| Error | #ef4444 | `destructive` |

---

## Appendix: Dependencies

### Current Dependencies (package.json)
```
react: ^19.0.0
react-dom: ^19.0.0
@xyflow/react: ^12.10.1
tailwindcss: ^4.2.2
socket.io-client: ^4.8.0
lucide-react: ^1.7.0
zustand: (types only)
```

### New Dependencies
```
ai: ^4.0.0
@ai-sdk/react: latest
streamdown: ^2.0.0
class-variance-authority: ^0.7.0
clsx: ^2.1.0
tailwind-merge: ^2.2.0
@radix-ui/react-*: (varios para shadcn)
```

### Dependencies to REMOVE (after migration)
- Custom CSS (~2000 líneas redundantes)
- Potentially: some lucide-react if shadcn covers it
