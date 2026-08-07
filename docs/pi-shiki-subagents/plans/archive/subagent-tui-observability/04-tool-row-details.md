# Subagent Observability Phase 4a Minimal Tool-Row Details Plan

Date: 2026-06-06
Status: draft; do not implement until oracle review

## Goal

Phase 4a adds a minimal read/write-like collapsed and expanded display for `omo_subagent` tool rows.

The goal is to show useful subagent internals without creating a transcript viewer or a complex TUI framework.

Keep the architecture split:

```txt
runtime facts
  -> normalized SubagentRunEvent
  -> SubagentRunState
  -> semantic details JSON
  -> Pi tool-row renderer adapter
```

## What Phase 4a shows

### Collapsed

Collapsed output is small, at most 3 lines:

```txt
Subagent oracle-review | completed | 3 tools | 00:42
  > tool read: src/pi/subagent/subagent-pool.ts
  > assistant: reviewed implementation...
```

If there are child runs:

```txt
Subagent oracle-review | completed | 3 tools | 00:42
  > assistant: reviewed implementation...
  +1 child run
```

### Expanded

Expanded output is still bounded:

```txt
Subagent oracle-review (oracle)
status: completed
model: dmxapi-responses/gpt-5.5
usage: in:35k out:332
elapsed: 00:42

Events:
  status: streaming
  tool read: src/pi/subagent/subagent-pool.ts
  assistant: reviewed implementation...
  status: completed

Children:
  * nested-search (search) | completed | 00:12
```

## Non-goals

Phase 4a must not add:

- completion notification redesign.
- overlay or detail popup.
- dashboard.
- Tauri API.
- persistence.
- full transcript storage.
- raw Pi SDK event display.
- raw tool arguments/results.
- full task prompt, user message, system prompt, or hidden prompt rendering.
- interactive tree controls.
- paging/search/filter UI.

The existing pool completion text remains as-is:

```txt
[pool] oracle 已完成
...
[decision] 请选择下一步...
```

Phase 4a only improves `omo_subagent` tool-row rendering.

## References

Phase 4a should reference existing Pi subagent/TUI work for rendering patterns only. It should not install, wrap, or replace the current OMO subagent runtime.

Useful references:

- Pi official subagent extension example: `/home/h/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts`
  - `onUpdate({ content, details })` pattern.
  - `renderCall` / `renderResult` split.
  - collapsed vs expanded result rendering.
  - bounded usage formatting.
- Pi TUI docs: `/home/h/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
  - width-safe component rendering expectations.
  - widget vs custom tool renderer boundaries.
- `harms-haus/pi-subagents`
  - pure render helpers such as delegate result rendering.
  - rolling-window style summarized subagent output.
  - useful as a boundary example: renderer consumes window state, not raw runtime.
- `vsumner/pi-subagents` / `@tintinweb/pi-subagents`
  - compact live widget style and status summaries.
  - completion boxes and bounded output examples.
- `ross-jill-ws/pi-subagent-in-memory`
  - in-process `createAgentSession` pattern and live cards.
  - nested subagent visibility idea.

Non-reference goals:

- Do not copy their subagent orchestration model.
- Do not add duplicate subagent tools.
- Do not replace OMO agent discovery, model resolution, delegation rules, or pool lifecycle.
- Do not import their package code as a dependency for Phase 4a.

The intended takeaway is UI shape and separation discipline, not feature parity.
## Architecture boundary

Only renderer adapter files may import Pi TUI/tool rendering components.

Canonical data remains semantic JSON, but Phase 4a details payloads must use a sanitized/bounded projection of that JSON. Future Tauri should consume sanitized semantic details JSON, not Pi renderer output and not raw `SubagentRunTreeView`.

Recommended files:

```txt
src/pi/subagent/subagent-run-detail-view.ts          # pure semantic detail view
src/pi/subagent/subagent-run-detail-view.test.ts
src/pi/subagent/subagent-run-tool-details.ts         # JSON details payload builder
src/pi/subagent/subagent-run-tool-details.test.ts
src/pi/subagent/subagent-run-tool-renderer.ts        # Pi renderer adapter only
src/pi/subagent/subagent-run-tool-renderer.test.ts
```

Allowed responsibilities:

- `subagent-run-detail-view.ts`: choose bounded fields from existing semantic snapshot.
- `subagent-run-tool-details.ts`: build a versioned JSON payload for tool results.
- `subagent-run-tool-renderer.ts`: render collapsed/expanded Pi tool rows from that JSON.

Forbidden:

- `AgentPool` importing TUI.
- renderer mutating `AgentPool` or run state.
- details payload containing raw SDK events or raw tool payloads.
- pure state/view modules importing Pi TUI.
- details payload directly embedding `SubagentRunTreeView`, because it contains `taskPreview` and recursive children outside Phase 4a bounds.
- renderer imports in `AgentPool` or any pure state/view module.

## Details payload

Do not put raw `SubagentRunTreeView` into tool result details. It includes `taskPreview`, which is prompt-derived. Phase 4a must build a sanitized, bounded payload:

```ts
interface OmoSubagentToolDetailsV1 {
  version: 1;
  action: 'spawn' | 'send' | 'list' | 'kill' | 'resume' | 'listSaved';
  runId?: string;
  summary: SubagentRunTreeSummaryView;
  focusedRun?: SubagentRunDetailView;
}

interface SubagentRunTreeSummaryView {
  roots: SubagentRunSummaryNode[];
  counts: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    dead: number;
  };
  hiddenRootCount: number;
}

interface SubagentRunSummaryNode {
  runId: string;
  title: string;
  agentName: string;
  status: SubagentRunStatus;
  elapsedText: string;
  usageText?: string;
  toolCount: number;
  children: SubagentRunSummaryNode[];
  hiddenChildCount: number;
}
```

Rules:

- no `taskPreview`.
- no raw task/message prompt.
- no raw assistant/user/system message.
- no raw tool args/result.
- no raw Pi SDK event.
- no full transcript.
- no persistence.
- no unbounded recursive children.
- usage remains optional; missing usage renders nothing, not fake zeroes.

`focusedRun` is present for `spawn` and maybe `resume`. It may be absent for `list`, `listSaved`, or ambiguous actions. `summary` is always sanitized and bounded.

## Detail view model

Keep it small:

```ts
interface SubagentRunDetailView {
  runId: string;
  title: string;
  agentName: string;
  status: SubagentRunStatus;
  model?: string;
  elapsedText: string;
  usageText?: string;
  toolCount: number;
  latestEvents: Array<{
    type: string;
    summary: string;
    toolName?: string;
    isError?: boolean;
  }>;
  children: Array<{
    runId: string;
    title: string;
    status: SubagentRunStatus;
    elapsedText: string;
  }>;
}
```

Bounds:

- collapsed events: latest 2.
- expanded events: latest 10.
- children shown: max 5.
- nested depth: max 2 in Phase 4a.
- extra events/children show `+N more`.

Do not include `taskPreview` in Phase 4a output or payload.

Assistant events are allowed only as sanitized semantic summaries. They are not transcript lines. The detail builder must transform event text into a safe summary before putting it in `latestEvents.summary`, and tests must prove sentinel raw assistant/user/system-like text does not appear in serialized payloads or rendered output.

## Renderer behavior

### renderCall

Show action and id only, never task/message text:

```txt
omo_subagent spawn oracle-review (oracle)
omo_subagent send oracle-review
omo_subagent list
```

### renderResult collapsed

Use `focusedRun` when present. Otherwise show snapshot summary.

Collapsed line budget: 3 lines.

### renderResult expanded

Show focused run metadata, bounded events, and bounded children.

Expanded line budget should still be small enough to be readable; no paging in Phase 4a.

## Runtime integration

Minimal `registerSubagentTool` changes:

1. Build sanitized details payload from `getPool().getRunTreeView()` after each action.
2. Add `renderCall` and `renderResult` to the tool definition.
3. Keep existing text fallback readable.
4. Do not change pool completion notification behavior.
5. Do not add new runtime state.
6. Do not import renderer/TUI code into `AgentPool` logic.

Because `registerSubagentTool` currently lives in the same file as `AgentPool`, Phase 4a must keep ownership explicit: runtime classes and helpers (`AgentPool`, run state, adapter, view) must not import renderer modules. If this becomes hard to maintain, split tool registration/rendering into a separate Pi adapter module before implementing richer rendering.

## Tests

Required tests:

### Pure detail view

- builds focused detail for a run.
- excludes `taskPreview`.
- sanitizes assistant/user/system-like event text into summaries rather than raw transcript lines.
- bounds collapsed events to max 2.
- bounds expanded events to max 10.
- bounds children to max 5.
- bounds nested depth to max 2.
- emits `+N more` indicators for truncated events/children.
- does not render fake usage when usage is absent.

### Details payload

- `spawn` details focus the spawned run.
- `list` details include sanitized `summary` without focus.
- details payload contains no raw prompt/message/tool args/tool result.
- serialized payload safety test: `JSON.stringify(details)` must not contain sentinel strings placed in task prompt / `taskPreview`, send message, assistant text, user-like text, system/hidden-like fixture, tool args, or tool result.
- payload does not contain a `taskPreview` key.
- payload does not contain raw `SubagentRunTreeView` recursive fields outside declared Phase 4a bounds.

### Renderer

- `renderCall` omits task/message prompt.
- collapsed result is at most 3 lines.
- expanded result shows bounded event summaries and children.
- missing details falls back to normal text.
- no raw prompt/task/message is rendered.
- narrow-width render test asserts no rendered line exceeds width.

### Regression

- child runs render only from semantic tree identity; no parent inference.
- unknown/missing usage does not render fake zero usage.
- existing pool completion text remains available and unchanged.
- `AgentPool` and pure state/view modules do not import renderer/TUI modules.

## Maintenance rule

If Phase 4a starts needing overlay, paging, search, transcript replay, persistence, or custom per-tool deep rendering, stop and split that into a separate future phase.

Phase 4a should stay a minimal tool-row readability improvement.

## Exit criteria

Phase 4a is ready to implement only after oracle approves this plan.

Implementation is complete only when:

- targeted tests pass.
- typecheck passes.
- oracle approves implementation.
- no overlay, Tauri API, dashboard, persistence, transcript viewer, or completion-notification redesign has been added.
