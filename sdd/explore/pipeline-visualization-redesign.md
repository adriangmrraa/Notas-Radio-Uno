# Exploration: Pipeline Visualization Redesign

## Current State

The system currently uses **React Flow** (`@xyflow/react` v12) for pipeline visualization with:

- **Custom PipelineNode component** with vertical flow layout
- **9 pipeline stages**: capture → transcribe → analyze → insights → search → generate_news → generate_title → generate_flyer → publish
- **Real-time status via Socket.IO**:
  - `idle` (gray) - awaiting execution
  - `running` (cyan pulse animation) - actively processing
  - `completed` (green #00d4aa) - finished successfully
  - `error` (red #e94560) - failed
- **MiniMap** for overview navigation
- **Custom node handles** for vertical connections

### Key Files
- `src/client/editor/PipelineEditor.tsx` — Main React Flow implementation
- `src/client/editor/components/PipelineNode.tsx` — Custom node with status styling
- `src/client/hooks/usePipelineState.tsx` — Socket.IO event handling for real-time updates

### CSS Variables (from App.css)
- `--bg-primary: #0b0d17` — Dark theme background
- `--accent: #06b6d4` — Cyan accent (running state)
- `--success: #00d4aa` — Green (completed)
- `--error: #e94560` — Red (error)

---

## Affected Areas

| File | Why Affected |
|------|--------------|
| `src/client/editor/PipelineEditor.tsx` | Main pipeline view, would need refactoring |
| `src/client/editor/components/PipelineNode.tsx` | Custom node - replace with new component |
| `src/client/hooks/usePipelineState.tsx` | Socket.IO integration - enhance with streaming |
| `src/client/editor/PipelineEditor.css` | All current styling - migrate to Tailwind |
| Package.json | Add new dependencies (shadcn/ui, possibly Vercel AI SDK) |

---

## Approaches

### 1. **Option A: Keep React Flow + Style with Tailwind**
Preserve the graph-based visualization but modernize styling

- **Pros**: 
  - Keep drag-and-drop, free-form layout capability
  - Maintain MiniMap for overview
  - Graph visualization is unique and powerful for pipeline editing
  - Lower risk - incremental change
  
- **Cons**: 
  - Still dependent on React Flow library
  - May not fully achieve "new stack" goal
  - Custom node styling remains complex

- **Effort**: Low-Medium

---

### 2. **Option B: Custom Vertical Stepper with Tailwind**
Replace React Flow entirely with a linear stepper component

- **Pros**:
  - Full control over UI/UX
  - Better performance (no graph engine overhead)
  - Easier to style with Tailwind
  - Simpler component hierarchy
  - Can add shadcn/ui Progress/Steps components
  
- **Cons**:
  - Lose free-form editing capability
  - MiniMap would need custom implementation
  - More initial development work
  - Changes the mental model of "pipeline editing"

- **Effort**: Medium-High

---

### 3. **Option C: Hybrid Approach** (Recommended)
Use both - PipelineView for execution, Editor stays with React Flow

- **Pros**:
  - Preserve "magic" (real-time visualization) during execution
  - Keep React Flow for complex editing scenarios
  - Add Streamdown for AI thought display
  - Best of both worlds
  - Incremental migration
  
- **Cons**:
  - Two visualization modes to maintain
  - More components to build
  - State synchronization between modes

- **Effort**: Medium

---

### 4. **Option D: React Flow + shadcn/ui Wrapper**
Create shadcn-style wrapper around React Flow

- **Pros**:
  - Keep React Flow power
  - Consistent UI with shadcn design language
  - StatusBadge, Progress components from shadcn
  
- **Cons**: 
  - Still heavy dependency on React Flow
  - Complex wrapper components needed
  - Less Tailwind-native feel

- **Effort**: Medium

---

## Recommendation

**Option C: Hybrid Approach** is recommended because:

1. **Preserves the "magic"** — Real-time status visualization remains intact
2. **Incremental migration** — No big-bang refactoring
3. **Enhanced UX** — Add Streamdown for AI thoughts during execution
4. **Best tooling** — Use shadcn/ui for the execution view, keep React Flow for complex editing

### Proposed Component Structure

```
src/client/
├── components/
│   ├── pipeline/
│   │   ├── PipelineView.tsx        # Main execution view (NEW)
│   │   ├── StepIndicator.tsx      # Individual step with status (NEW)
│   │   ├── StatusBadge.tsx        # Reusable status indicator (NEW)
│   │   ├── AIDisplay.tsx          # Streamdown for AI thoughts (NEW)
│   │   └── PipelineStepper.tsx    # Vertical stepper wrapper (NEW)
│   └── editor/
│       └── PipelineNode.tsx       # Keep for editor mode
└── hooks/
    └── useAIStream.ts             # Vercel AI SDK streaming hook (NEW)
```

### Real-time Enhancement

Current Socket.IO approach is solid. Enhance with:
- **Vercel AI SDK** for streaming AI thoughts to AIDisplay component
- Keep Socket.IO for pipeline status (step transitions)
- Combine both for complete real-time picture

---

## Risks

1. **State synchronization** — Hybrid approach needs careful state management between editor and execution views
2. **Breaking "magic"** — Any redesign must preserve the pulse animation and status colors users expect
3. **Migration effort** — Moving from React Flow custom CSS to pure Tailwind requires careful planning
4. **Bundle size** — Adding shadcn/ui + Vercel AI SDK increases bundle; need code splitting

---

## Ready for Proposal

**Yes** — This exploration provides enough context for a design proposal.

### Next Steps for Orchestrator

The user should be told:
1. Recommended approach is **Option C (Hybrid)** to preserve the "magic" while modernizing
2. New components needed: `PipelineView`, `StepIndicator`, `StatusBadge`, `AIDisplay`
3. Socket.IO stays for status; Vercel AI SDK adds streaming for AI thoughts
4. Ready to proceed to **sdd-propose** phase for formal change proposal
