# Subagent Observability Phase 2 Runtime Wiring Plan

Date: 2026-06-05
Status: draft for oracle review; do not implement until approved

## Scope

Phase 2 wires the existing OMO subagent runtime into the Phase 1 pure state/view model. It does not add TUI widgets, tool-row renderers, overlays, Tauri APIs, persistence, or dashboard behavior.

The goal is only:

```txt
subagent-pool runtime activity
  -> normalized SubagentRunEvent
  -> pure SubagentRunState
  -> semantic SubagentRunTreeView snapshot
```

## Hard boundary

Runtime wiring may import Phase 1 pure modules, but Phase 1 modules must remain independent.

Allowed in Phase 2 runtime code:

- `SubagentRunEvent`
- `createSubagentRunState()`
- `updateSubagentRunState()`
- `createSubagentRunTreeView()`
- local adapter code that inspects unknown Pi session events defensively

Forbidden in Phase 2 state/view modules:

- Pi TUI imports
- `ExtensionContext`
- `ctx.ui`
- widgets
- tool row rendering components
- Tauri assumptions
- raw Pi SDK event types as public state contracts

## Proposed files

```txt
src/pi/subagent/subagent-run-adapter.ts
src/pi/subagent/subagent-run-adapter.test.ts
```

Optional, only if it keeps `subagent-pool.ts` small:

```txt
src/pi/subagent/subagent-run-runtime.ts
src/pi/subagent/subagent-run-runtime.test.ts
```

No UI renderer file should be added in Phase 2.

## Runtime ownership

`AgentPool` should own the in-memory observability state for its active process:

```txt
private runState = createSubagentRunState()
```

It may expose a semantic snapshot method for future consumers:

```txt
getRunTreeView(options?): SubagentRunTreeView
```

This method returns JSON-like data only. It must not return terminal lines, ANSI strings, TUI components, or mutable internal state.

## Event identity

When `pool.spawn` accepts a task, record a normalized `run_started` event.

Identity mapping:

```txt
runId        = opts.id
parentRunId = explicit parent run id source only, otherwise undefined
agentName   = opts.agent.name
displayName = opts.name || opts.id
depth       = opts.depth ?? 0
startedAt   = entry.startedAt
taskPreview = bounded preview of opts.task
model       = entry.model
```

The only acceptable parent identity sources are:

```txt
1. an explicit `parentRunId` option passed into `AgentPool.spawn`, or
2. `process.env.OMO_AGENT_ID` captured once at `omo_subagent` tool execution entry and passed into `spawn` as `parentRunId`.
```

Do not infer `parentRunId` from `parentAgent`, `depth`, active pool entries, timing, agent names, or other global mutable state. `parentAgent` is a name and is not unique enough for nested run trees. `depth` is display metadata and is not identity.

If neither explicit source is available, `parentRunId` must remain absent. The tree should be correct when identity exists, but Phase 2 must not invent a parent.

## Adapter contract

`subagent-run-adapter.ts` should convert runtime facts into normalized events. It should accept `unknown` session events, not a raw SDK type exported to state/view.

Suggested API:

```ts
interface SessionEventContext {
  runId: string;
  agentName: string;
  now: () => number;
}

function toSubagentRunEvents(
  context: SessionEventContext,
  event: unknown,
): SubagentRunEvent[]
```

The adapter must be defensive:

- unknown event shape -> no event.
- missing usage -> no usage snapshot.
- missing tool details -> no tool summary.
- malformed values -> no event or sanitized fallback.

## Event mapping

Best-effort mapping only:

```txt
turn_start             -> status(streaming)
agent_end              -> status(idle), assistant summary if available
message_end assistant  -> assistant summary + optional usage snapshot
recognized tool call   -> tool_call with sanitized summary
recognized tool result -> tool_result with sanitized summary/error flag
sendPrompt success     -> run_finished(completed)
sendPrompt error       -> run_finished(failed)
kill                   -> run_finished(dead) only if initial run is still active
spawn failure          -> run_finished(failed) if a run was started
```

Do not promise realtime token usage. Usage snapshots are optional and only recorded when events expose usage data.

Persistent pool lifecycle semantics: `run_finished(completed)` means the observed prompt run completed, not that the underlying pool session is dead or unusable. In Phase 2, the initial `spawn` task is the only run that must be represented. Later `pool send` turns are out of scope unless represented as separately identified runs in a later reviewed phase. Phase 2 must not append later `send` results to a completed initial run in a way that corrupts its lifecycle.

Kill semantics must also respect the initial-run lifecycle. If the initial run is still active, `kill` records `run_finished(dead)`. If the initial run already reached `completed` or `failed`, `kill` terminates the pool session but must not overwrite that initial run status with `dead`. A later phase may add separate pool-session lifecycle state if needed.

## Summary policy

The adapter may derive short summaries, but it must not store raw payloads.

Rules:

- no raw event object in state.
- no raw tool args object in state.
- no raw tool result object in state.
- no full prompt or system prompt in state.
- assistant text is capped by Phase 1 limits.
- tool summaries are short, preformatted strings only.
- bash command summaries should be generic or aggressively capped; exact command retention is not required for Phase 2.

Examples of acceptable summaries:

```txt
read: file
bash: command
edit: file
write: file
tool: <name>
```

## Required `subagent-pool.ts` changes

Keep changes minimal and runtime-only:

0. Extend `AgentPool.spawn` options with explicit `parentRunId?: string`; populate it from `registerSubagentTool` only when `process.env.OMO_AGENT_ID` is available at tool execution entry.
1. Extend `PoolEntry` metadata only as needed:

```txt
parentRunId?
depth?
taskPreview?
```

2. Add private helper:

```txt
recordRunEvent(event: SubagentRunEvent): void
```

3. In `spawn`, after `entry` is created, record `run_started`.

4. In `session.subscribe`, call adapter and record returned normalized events.

5. In async initial `sendPrompt(...).then(...)` launched by `spawn`, record `run_finished(completed|failed)` for that initial run before emitting existing pool completed/error events. Do not represent later manual `pool send` turns as updates to the completed initial run in Phase 2.

6. In `kill`, record `run_finished(dead)` only when the initial run is still active; do not overwrite completed/failed initial-run status.

7. Add semantic snapshot method:

```txt
getRunTreeView(options?): SubagentRunTreeView
```

Do not change the public model-facing `omo_subagent` tool output in Phase 2 except possibly tests for the new snapshot method. Tool row `details` belongs to Phase 4.

## Tests

Phase 2 tests should cover:

- spawn records `run_started` with stable identity.
- session `turn_start` maps to streaming status.
- message usage maps to optional usage snapshot when present.
- unknown session event is ignored.
- sendPrompt success records completed.
- sendPrompt error records failed.
- kill records dead.
- kill after initial completion does not change the initial run from completed to dead.
- child run with parent run id appears nested in semantic snapshot.
- parentRunId stays absent when there is no explicit parent run id source.
- parent is not inferred from `parentAgent`, `depth`, active entries, timing, or agent name.
- later `pool send` after an initial run completes does not mutate the completed initial run lifecycle in Phase 2.
- no TUI/Pi component imports in adapter/state/view modules.

Tests should use fake events and fake `now` values. Do not depend on real Pi TUI or Tauri.

## Risks and mitigations

### Pi event shape drift

Mitigation: adapter accepts `unknown`, emits nothing for unsupported shapes, and keeps raw event details out of state.

### Runtime bloat in `subagent-pool.ts`

Mitigation: keep conversion logic in `subagent-run-adapter.ts`; `subagent-pool.ts` only records lifecycle facts and invokes adapter.

### Usage overclaiming

Mitigation: usage remains optional. UI later hides missing fields.

### UI coupling

Mitigation: Phase 2 returns only semantic JSON snapshots. No renderer is implemented.

## Exit criteria

Phase 2 is complete only when:

- oracle approves this design.
- runtime wiring tests pass.
- typecheck passes.
- state/view purity boundary remains intact.
- no TUI widget, overlay, renderCall, renderResult, or Tauri surface has been added.
