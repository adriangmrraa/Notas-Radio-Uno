# PeriodistApp Design System

## Tokens

Global semantic tokens live in `src/client/index.css` and use the `--ds-*` prefix. New shared UI must use semantic roles (`--ds-bg`, `--ds-surface`, `--ds-text`, `--ds-border`, `--ds-brand`) instead of raw colors. Spacing uses `--ds-space-1` through `--ds-space-6`; radii use `--ds-radius-*`.

The `.dark` class provides the newsroom dark palette. `Layout` applies the initial theme from `localStorage` (`periodistapp-theme`) or the system preference, then persists changes made with the header theme control.

## Newsroom density

Use `newsroom-panel` for neutral shared surfaces, `newsroom-list` for compact stacked rows, `newsroom-table` for dense data tables, and `newsroom-control` for form controls. All interactive elements must retain the global `:focus-visible` ring.

Keep page-specific styling scoped. PH-01 defines foundations; it does not redesign route layouts.
