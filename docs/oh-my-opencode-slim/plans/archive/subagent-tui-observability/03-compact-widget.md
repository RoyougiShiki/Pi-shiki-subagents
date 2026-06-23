# Subagent Observability Phase 3 Compact TUI Widget Plan

Date: 2026-06-05
Status: draft for oracle review; do not implement until approved

## Scope

Phase 3 adds a compact Pi TUI status widget for active OMO subagents. It consumes the Phase 2 semantic snapshot only:

```txt
AgentPool.getRunTreeView()
  -> SubagentRunTreeView semantic JSON
  -> width-safe plain text widget lines
  -> ctx.ui.setWidget(...)
```

Phase 3 does not add:

- `renderCall` / `renderResult` tool-row rendering.
- expandable read/write-like tool details.
- overlays or detail popups.
- Tauri APIs.
- persistence.
- raw transcript display.
- raw Pi SDK event display.

Tool-row collapsed/expanded rendering remains Phase 4.

## Architecture boundary

The widget must be a UI adapter only. It must not mutate subagent runtime state and must not know Pi SDK session event shapes.

Allowed dependencies:

```txt
Phase 3 widget runtime -> getPool().getRunTreeView()
Phase 3 line renderer  -> SubagentRunTreeView / SubagentRunViewNode types
```

Forbidden dependencies in Phase 1/2 pure modules remain unchanged:

```txt
@earendil-works/pi-coding-agent
@earendil-works/pi-tui
ExtensionContext
ctx.ui
setWidget
renderCall/renderResult
Tauri assumptions
```

The semantic JSON model remains the Tauri boundary. Tauri should consume `SubagentRunTreeView`, not terminal-specific lines.

## Proposed files

```txt
src/pi/subagent/subagent-run-widget-lines.ts
src/pi/subagent/subagent-run-widget-lines.test.ts
src/pi/subagent/subagent-run-widget.ts
src/pi/subagent/subagent-run-widget.test.ts
```

`subagent-run-widget-lines.ts` is a pure, ANSI-free line adapter from semantic JSON to terminal-safe strings. It is separate from `subagent-run-view.ts` so the Tauri boundary remains semantic JSON, not terminal text.

`subagent-run-widget.ts` is the only Phase 3 file allowed to use `ExtensionContext` / `ctx.ui.setWidget`.

`AgentPool` may expose a non-UI run-state listener in Phase 3, for example:

```txt
onRunStateChange(cb: () => void): () => void
```

This listener is only a notification that the semantic snapshot may have changed. It must not accept `ctx`, call `ctx.ui`, return terminal lines, or know about widgets. `ctx.ui` remains exclusively in `subagent-run-widget.ts`.

## Widget behavior

The widget should show only when there is useful subagent activity.

Suggested collapsed output:

```txt
● Subagents: 1 running · 1 completed
├─ ● oracle-review (oracle) · streaming · 2 tools · ↑1.2k ↓300 · 00:18
│  ⎿ reading src/pi/subagent/subagent-pool.ts
└─ ✓ scout (search) · completed · 1 tool · 00:42
```

Rules:

- active runs (`starting`, `streaming`, `idle`) are prioritized.
- completed/failed/dead runs are visible only within a small TTL based on `completedAt` and the render `now`, default 10 seconds; after TTL, they are hidden from the widget even though they may remain in the semantic snapshot.
- keep a small line budget, default 8 lines.
- if the tree exceeds the budget, show a final `+N more` summary.
- each node shows at most the latest 1 recent line in widget mode.
- no ANSI control sequences.
- no raw tool args/results/prompts.
- no full assistant output beyond bounded Phase 1 summaries.
- do not render `taskPreview` in the compact widget; it may contain prompt text even when bounded.

## Width safety

Pi TUI rendered lines must not exceed available terminal width. The line renderer should accept options:

```txt
width
maxLines
maxDepth
```

The renderer must restrict widget output to an ASCII-safe subset before truncation, then enforce `line.length <= width`. Non-ASCII or wide/CJK characters from semantic fields should be replaced or removed before truncation. This keeps Phase 3 simple and avoids display-width ambiguity without adding a width library.

## Update cadence

Avoid excessive UI updates.

Recommended runtime behavior:

- register a lightweight non-UI pool run-state listener such as `onRunStateChange(cb)`; existing pool completed/error events are not sufficient because they may not fire for every `recordRunEvent`.
- render immediately on pool event.
- optionally refresh on a low-frequency timer only while active runs exist, e.g. once per second for elapsed time.
- clear the widget when the tree summary has no visible active/recent entries.
- store the last rendered lines and call `ctx.ui.setWidget` only when lines change.
- apply the completed/failed/dead TTL filter during line rendering; clear the widget when no active or TTL-visible runs remain.

No high-frequency spinner is required in Phase 3.

## Runtime integration

`src/pi/core/pi.ts` or an equivalent extension wiring location may register the widget after `registerSubagentTool(pi)` and once an `ExtensionContext` is available.

The integration should be small:

```txt
registerSubagentRunWidget(ctx, pool = getPool())
  -> pool.onRunStateChange(scheduleRender)
  -> pool.getRunTreeView({ now })
  -> renderSubagentRunWidgetLines(view, { now, width, maxLines, ttlMs })
  -> ctx.ui.setWidget("omo-subagents", lines or undefined)
```

If the current Pi type definitions only support `ctx.ui.setWidget(id, string[] | undefined)`, use that simple form. Do not import Pi TUI components in Phase 3.

## Tests

Required tests:

- line renderer returns empty lines for `no subagents`.
- active run renders a compact status line.
- nested runs render as indented tree lines.
- long lines are truncated to width.
- line budget produces `+N more`.
- no raw prompt/tool arg/result appears when semantic recent lines are already bounded.
- widget runtime clears widget when there are no visible lines.
- widget runtime avoids redundant `setWidget` calls for unchanged lines.
- widget runtime uses `getRunTreeView` semantic snapshot and does not mutate pool state.
- pool run-state notification is non-UI and does not receive `ctx` or call `ctx.ui`.
- inactive completed/failed/dead runs are hidden after TTL and cause widget clearing when no active runs remain.
- `taskPreview` is not rendered.
- width safety handles wide/CJK text by ASCII-sanitizing before truncation.

Tests should mock `ctx.ui.setWidget` and `pool.getRunTreeView`; they should not use real Pi TUI, terminal components, or Tauri.

## Risks and mitigations

### UI/logic coupling

Mitigation: only `subagent-run-widget.ts` touches `ctx.ui`. Line rendering consumes semantic view model only.

### Tauri boundary erosion

Mitigation: Tauri consumes `SubagentRunTreeView`. `subagent-run-widget-lines.ts` is explicitly a Pi terminal adapter, not the canonical view model.

### TUI noise

Mitigation: show only compact lines, dedupe unchanged renders, and clear when inactive.

### Runtime overhead

Mitigation: no high-frequency spinner; at most one low-frequency active timer, stopped when no active runs are visible.

## Exit criteria

Phase 3 is complete only when:

- oracle approves this design.
- compact widget implementation passes tests.
- typecheck passes.
- state/view/adapter purity boundary remains intact.
- no tool-row renderer, overlay, Tauri API, persistence, or raw transcript display has been added.
