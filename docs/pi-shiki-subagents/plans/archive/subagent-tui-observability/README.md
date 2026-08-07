# Subagent TUI Observability Plan

Date: 2026-06-05
Status: approved for Phase 0 / Phase 1 only

## Goal

Expose OMO subagent progress in the Pi TUI without coupling subagent runtime logic to a specific UI. The same semantic view model should be usable by a future Tauri GUI.

Target user experience:

- Show active subagents and their latest status in a compact collapsed view.
- Support read/write-like expanded detail where the tool lifecycle supports it.
- Represent nested subagent calls as a tree.
- Display token/cost/context usage when the Pi session events provide it.

## Non-goals

Do not implement these in the current phase:

- A full transcript system.
- Raw Pi SDK event persistence.
- Raw tool arguments/results in UI state.
- Full prompts in UI state.
- Cross-process or cross-runtime live synchronization.
- A dashboard or Tauri GUI.
- Replacement of the current OMO subagent tool with another `pi-subagents` package.

External Pi subagent packages are references only. Installing them would duplicate the current OMO concepts for agent discovery, model resolution, delegation rules, and pool management.

## Architecture boundary

The implementation must keep four layers separate:

```txt
Pi SDK/session events
  -> normalized SubagentRunEvent adapter
  -> pure run state + semantic tree view model
  -> UI-specific renderer (Pi TUI now, Tauri later)
```

Only the adapter layer may know about Pi SDK event shapes. State and view modules must not import `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `AgentSession`, `ExtensionContext`, or UI components.

## Normalized state contract

Every run node must have stable tree identity:

```txt
runId
parentRunId?
agentName
displayName
depth
startedAt
```

Additional fields are optional or derived:

```txt
status
model
completedAt
usage
recent events
children
```

Usage fields are best-effort only. They must be absent by default and shown only when available:

```txt
input
output
cacheRead
cacheWrite
cost
contextTokens
turns
```

## Summary bounds

The run state is an observability summary, not a transcript. It must keep bounded data only:

- bounded recent events per run.
- bounded text length per event.
- no raw tool arguments.
- no raw tool results.
- no complete prompts.
- no unbounded assistant output.

## Phases

### Phase 0 — design document

This document records the boundary and scope before code changes.

### Phase 1 — pure state, view model, and session snapshot contract

Add pure modules and tests only:

```txt
src/pi/subagent/subagent-run-state.ts
src/pi/subagent/subagent-run-view.ts
src/pi/subagent/subagent-session-contract.ts
src/pi/subagent/subagent-run-state.test.ts
src/pi/subagent/subagent-run-view.test.ts
src/pi/subagent/subagent-session-contract.test.ts
```

Expected behavior:

- reduce normalized run events into bounded run state.
- build a semantic JSON tree view model.
- expose stable session/activity snapshots for future Pi TUI, Tauri, or chat/session surfaces.
- preserve parent/child nesting so nested subagent calls remain visible.
- preserve parallel/asynchronous runs as independent snapshots ordered by start time.
- map runtime statuses into neutral activity phases without changing runtime behavior.
- avoid all Pi SDK and TUI imports.

### Phase 2 — runtime wiring and consumer migration

Migrate runtime consumers to the pure contracts in small steps. Existing `subagent-pool.ts` already records normalized run events; future work should feed terminal widgets, Tauri surfaces, and any session/chat overlay from `subagent-session-contract.ts` rather than introducing another state model.

First completed migration step: `subagent-run-view.ts` now derives the existing `SubagentRunTreeView` from `SubagentSessionSnapshot` data, preserving the terminal widget output shape while making the pure view path snapshot-backed.

Further runtime consumer migration requires separate review before implementation.

### Phase 3 — compact Pi TUI widget

A Pi TUI renderer may consume the semantic view model via `ctx.ui.setWidget(...)` and render a compact above-editor subagent status tree.

Completed migration step: `subagent-run-widget.ts` now prefers `getSubagentSessionSnapshots()` when available and falls back to `getRunTreeView()` for compatibility. The renderer still receives the same `SubagentRunTreeView` shape and must not mutate run logic.

### Phase 4 — tool row rendering

Add `renderCall` / `renderResult` / `details` to `omo_subagent` for read/write-like collapsed and expanded tool rows where the tool lifecycle supports it.

Long-running asynchronous pool agents should not rely on old tool rows for live updates.

### Phase 5 — optional overlay, chat/session, or Tauri surface

A later Tauri GUI, chat/session surface, or detail overlay should consume the same semantic JSON snapshots rather than TUI component output.

## References

Useful reference patterns:

- Pi official subagent example: `examples/extensions/subagent/index.ts`
  - `onUpdate({ content, details })`
  - `renderCall` / `renderResult`
  - collapsed recent-item display
  - usage formatting
- Current project separation pattern; chat bridge is a dormant/experimental reference, not an active `/chat` contract:
  - `src/pi/subagent/chat-status-view.ts`
  - `src/pi/subagent/pi-chat-bridge.ts`
- External packages reviewed as references only:
  - `harms-haus/pi-subagents`
  - `vsumner/pi-subagents`
  - `ross-jill-ws/pi-subagent-in-memory`

## Review guardrails

Oracle approved Phase 0 and Phase 1 only, with these guardrails:

- Keep pure state/session contracts strictly pure: no Pi SDK, no `AgentSession`, no `ctx`, no `pi-tui`.
- Tests must assert bounds, tree identity behavior, activity phase mapping, and parallel/nested snapshot stability.
- Usage/cost/context fields are optional and absent by default.
- Any runtime consumer migration requires a separate review.
