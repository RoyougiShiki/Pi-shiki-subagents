# Subagent Runtime / Observability and Harness Warning Evidence Domain Review

Status: plan-only domain review; do not implement from this file without a follow-up patch plan.

Baseline:

- `docs/pi-shiki-subagents/plans/whole-module-complexity-audit/README.md`
- `docs/pi-shiki-subagents/plans/whole-module-complexity-audit/scan.mjs`

Scope: subagent runtime/observability and harness warning evidence. Findings are grouped by capability name first. Code paths are evidence only.

Out of scope:

- Source/test/config edits in this review task.
- Tauri desktop design.
- Rich subagent detail panels.
- Transcript/dashboard/persistence expansion.
- Dependency additions or large rewrites.

## Executive Summary

P0 work should fix two correctness hazards before broader simplification:

1. Subagent tool resolution must use the same expression semantics as mode tool resolution.
2. Subagent default agent/tool-group loading must use the shared default-agent path.

P1 work should preserve the current good boundaries while simplifying lifecycle and evidence contracts:

- Keep pool-first reuse semantics, but make lifecycle/persistence ownership explicit.
- Keep harness warning evidence tool-agnostic.
- Keep terminal rendering compact and bounded.

P2 work is mostly defer/monitor:

- Keep pure state/view modules as-is.
- Avoid expanding global state, persistence, or terminal detail features unless a targeted bug requires it.

## Capability Findings

### P0.1 — Subagent tool resolution consistency

Recommendation: simplify/fix.

Finding:

- Mode tool resolution supports tool expressions such as `*`, `@group`, and wildcard patterns.
- Subagent pool resolution currently returns direct `tools` values or raw role-group entries and does not fully expand nested group entries.
- Default tool groups include nested group use, e.g. `管理: ["@子代理"]`; a subagent using the `管理` role can receive `@子代理` as an unresolved tool name instead of the actual subagent tools.

Evidence:

- Mode resolution: `src/pi/core/pi-modes.ts`
- Subagent resolution: `src/pi/subagent/subagent-pool.ts`
- Nested groups: `src/adapters/agents-default.json`
- Baseline: README P0.1 and `scan.mjs` raw findings

Decision: simplify/fix. Do not add a new resolver framework; share or extract one small resolver path if possible.

Cost: medium.

Benefit: high; removes hidden permission drift between mode and subagent sessions.

Risk: medium; changing effective subagent tool allowlists can expose too many or too few tools if tests miss default roles.

Executable tasks:

1. Add a focused tool-resolution test matrix before changing behavior.
   - Agents/roles: `dispatcher`, `designer`, `fixer`, `search`, and one direct `tools` agent.
   - Inputs: literal tools, `@group`, nested `@group`, wildcard, `*`, empty role group.
   - Expected: subagent resolved tool names match mode semantics for the same runtime definitions and available tool list.
2. Replace subagent raw role-group expansion with the shared mode-equivalent expression expansion.
3. Keep unknown groups observable but non-fatal; assert warning/empty behavior explicitly if existing mode semantics keep it that way.

Validation:

- Targeted subagent tool-resolution tests.
- Existing subagent pool tests.
- `bun run typecheck`.
- Manual smoke: `omo_subagent` pool spawn for a role using nested groups, then confirm effective tool allowlist does not contain literal `@...` entries.

### P0.2 — Default agents path consistency

Recommendation: simplify/fix.

Finding:

- Subagent runtime builds a default agents path from its own module directory.
- Shared runtime agent config already exposes `getDefaultAgentsPath()`.
- The subagent-local path can resolve under the wrong tree depending on runtime `__dirname`, causing default `_tool_groups` to be missed silently.

Evidence:

- Shared helper: `src/adapters/agent-runtime-config.ts`
- Subagent local path: `src/pi/subagent/subagent-pool.ts`
- Baseline: README P0.2

Decision: simplify/fix. Use the shared helper or equivalent single source.

Cost: small.

Benefit: high; default agents and tool groups load consistently for modes and subagents.

Risk: low; this should reduce path variance rather than change config precedence.

Executable tasks:

1. Add a unit test that subagent tool-group loading reads default groups from `src/adapters/agents-default.json`.
2. Replace the subagent-local default path with the shared default-agent path helper.
3. Verify user/project overrides still merge in the intended order.

Validation:

- Targeted default path test.
- Existing config/subagent tests.
- `bun run typecheck`.

### P1.1 — Pool-first subagent lifecycle and reuse

Recommendation: keep/simplify.

Finding:

- Current `omo_subagent` protocol is pool-first: `list`, `spawn`, `send`, `kill`, plus saved-session `listSaved`/`resume`.
- This supports the required subagent reuse behavior: callers should run `pool list` first, reuse idle agents via `pool send`, and spawn only when no suitable idle agent exists.
- Lifecycle complexity is concentrated around async spawn, busy guards, kill/dispose, singleton pool, env mutation, and registry persistence.

Evidence:

- Tool protocol and busy guard: `src/pi/subagent/subagent-tool.ts`
- Pool manager: `src/pi/subagent/subagent-pool.ts`
- Baseline scope: README architecture constraints and subagent notes

Decision: keep/simplify. Preserve pool mode; do not re-enable single mode or replace agent discovery/delegation.

Cost: medium if cleaned up; none for keeping current behavior.

Benefit: high; pool reuse avoids repeated agent startup and aligns with current delegation instructions.

Risk: medium; env mutation and async session state can race if lifecycle ownership is changed carelessly.

Executable tasks:

1. Document the lifecycle contract in tests or README-adjacent docs:
   - `spawn` starts async work and returns immediately.
   - `send` is valid only for existing non-busy agents.
   - `kill` must unsubscribe, abort, dispose, delete in-memory entry, and mark run state terminal.
   - `resetPool` must kill all sessions and clear the singleton.
2. Add or verify tests for:
   - `send` rejected while `starting`/`streaming`.
   - `kill` unsubscribes and disposes once.
   - `resetPool` clears active singleton state.
   - registry save/list behavior does not imply live session availability.
3. Keep spawn env mutation serialized; do not broaden env-based state.

Validation:

- Existing `src/adapters/subagent-pool.test.ts` or equivalent subagent pool tests.
- Targeted tests for busy, kill, reset, and registry listing.
- `bun run typecheck`.

### P1.2 — Global state ownership and reload lifecycle

Recommendation: keep with constraints.

Finding:

- The pool notice bridge intentionally uses `globalThis` plus `Symbol.for` to prevent stale listeners across extension reloads.
- Other subagent state also has process-level ownership: singleton pool, registered widget singleton, spawn mutex, and environment variables.
- The global bridge is justified, but spreading global state would increase reload and stale-listener risk.

Evidence:

- Bridge global generation guard: `src/pi/subagent/subagent-pool-notice-bridge.ts`
- Pool singleton/mutex/env save-restore: `src/pi/subagent/subagent-pool.ts`
- Widget singleton: `src/pi/subagent/subagent-run-widget.ts`
- Baseline: README P2.4

Decision: keep/defer. Keep the bridge isolated; defer broader lifecycle refactors until a concrete reload bug appears.

Cost: low now; medium if refactored.

Benefit: medium; reload-safe listener behavior is useful.

Risk: medium; extra globals can leak listeners, duplicate notifications, or retain stale contexts.

Executable tasks:

1. Treat `subagent-pool-notice-bridge` as the only allowed global bridge for this domain.
2. Add a guardrail test if not present:
   - registering twice unsubscribes the previous listener;
   - old generation cannot send completed follow-up messages;
   - reset-for-tests invalidates old generation.
3. Do not introduce new `globalThis` state without a named reload-lifecycle bug and a failing test.

Validation:

- Pool notice bridge tests.
- Manual extension reload smoke if available.
- `bun run typecheck`.

### P1.3 — UI/runtime boundaries

Recommendation: keep/simplify at adapter boundary only.

Finding:

- Static scan found no hard UI/SDK violations in pure subagent state/view modules.
- Runtime pool imports state/view types but does not directly render TUI widgets.
- UI-specific behavior is concentrated in tool renderer/widget/bridge layers, which is the expected boundary.

Evidence:

- Pure state/view: `src/pi/subagent/subagent-run-state.ts`, `src/pi/subagent/subagent-run-view.ts`
- UI adapters: `src/pi/subagent/subagent-run-tool-renderer.ts`, `src/pi/subagent/subagent-run-widget.ts`, `src/pi/subagent/subagent-pool-notice-bridge.ts`
- Boundary scan: `scan.mjs` and README coverage notes

Decision: keep. Do not collapse pure modules into UI adapters just to reduce file count.

Cost: none now.

Benefit: high; preserves semantic state for future consumers without adding a Tauri dependency or rich UI now.

Risk: low; module count is higher, but roles are clear.

Executable tasks:

1. Keep pure state/view modules free of Pi SDK, Pi TUI, `ctx.ui`, `setWidget`, `renderCall`, and `renderResult`.
2. Keep SDK/TUI imports only in adapter layers.
3. Retain or add a static boundary test/scan pattern matching the baseline constraints.

Validation:

- Boundary scan from `scan.mjs`.
- Subagent state/view/widget-line tests.
- `bun run typecheck`.

### P1.4 — Harness warning evidence contract

Recommendation: keep/simplify contract boundaries.

Finding:

- Harness evidence adaptation is already mostly tool-agnostic: it consumes generic tool evidence, command text, output text, success flags, and explicit wrapper summaries.
- It should not grow branches for specific third-party tool wrappers.
- Success inference is acceptable for direct commands; non-direct wrappers should provide explicit summaries such as `tests: exit=0`, `typecheck: exit=1`, or `lint: exit=0`.

Evidence:

- Evidence adapter: `src/pi/harness/evidence-adapter.ts`
- Runtime hook normalization: `src/pi/harness/register-harness-hooks.ts`
- Baseline: README P1.4

Decision: keep/simplify. Preserve generic evidence fields; do not add third-party-tool-specific warning logic.

Cost: low.

Benefit: high; prevents evidence logic from expanding with every tool provider.

Risk: low to medium; generic contracts may require wrapper authors to emit clearer summaries instead of relying on weak heuristics.

Executable tasks:

1. Keep the evidence contract centered on:
   - `toolName`, `args`, `result`, `success`, `exitCode`, `timestamp`;
   - generic command semantics;
   - explicit output summaries for wrapper/non-direct tools.
2. Add tests that prove wrapper evidence is recognized only through explicit summaries, not hard-coded wrapper names.
3. Keep infra-noise downgrade restricted to explicit wait/sleep-only operations or explicit infra metadata.

Validation:

- Evidence adapter tests.
- Completion/harness audit tests.
- Negative test: unknown wrapper without explicit summary does not count as verified success.

### P1.5 — Harness persistence cleanup and bounded ownership

Recommendation: simplify/defer.

Finding:

- Harness persistence stores tool-result budget state, recovered evidence summary, and verifier verdicts in per-session companion files.
- Writes use temporary files and rename, and register hooks serialize in-memory queues within one runtime.
- There is no broad cleanup/retention policy in the reviewed files; expanding persistence would increase disk and stale-state risk.

Evidence:

- Budget state persistence: `src/pi/harness/tool-result-budget-persistence.ts`
- Evidence summary persistence: `src/pi/harness/evidence-summary-persistence.ts`
- Verifier verdict persistence: `src/pi/harness/verifier-verdict-persistence.ts`
- Runtime storage keys: `src/pi/harness/register-harness-hooks.ts`

Decision: defer cleanup policy unless persistence is touched for functional reasons. Do not expand persistence surfaces in this audit.

Cost: small to medium for a cleanup policy; none now.

Benefit: medium if stale files are a real issue; low if current data remains small and session-scoped.

Risk: medium; over-eager cleanup could erase evidence needed for resumed sessions.

Executable tasks:

1. Before adding cleanup, inventory persisted file types and current retention expectations.
2. If cleanup is needed, make it opt-in or threshold-based and session-safe.
3. Add tests for invalid JSON load behavior and atomic save failure behavior if not already present.

Validation:

- Persistence unit tests for load/save invalid files.
- Manual resumed-session smoke if cleanup is introduced.
- `bun run typecheck`.

### P1.6 — Terminal compactness for subagent observability

Recommendation: keep/defer rich details.

Finding:

- Current renderer and detail builder intentionally bound output: collapsed result lines, event limits, depth/child/root limits, clipping, and sanitized run IDs.
- This supports terminal compactness while still exposing enough observability for pool status and follow-up decisions.
- Rich detail panels remain out of scope.

Evidence:

- Tool detail limits: `src/pi/subagent/subagent-tool.ts`, `src/pi/subagent/subagent-run-tool-details.ts`
- Renderer compact limits: `src/pi/subagent/subagent-run-tool-renderer.ts`
- State event limits: `src/pi/subagent/subagent-run-state.ts`
- Baseline architecture constraint: terminal TUI stays compact

Decision: keep. Defer rich detail views.

Cost: none now.

Benefit: high; prevents terminal noise and preserves fast review of pool events.

Risk: low; users may want more detail, but expanded views/dashboard are non-goals for this audit.

Executable tasks:

1. Keep collapsed subagent results to a small fixed number of lines.
2. Keep event text, task preview, root, child, and depth limits explicit.
3. Add/keep snapshot tests for collapsed and expanded rendering width/line bounds.

Validation:

- Renderer line-bound tests.
- Widget-line tests.
- Manual `omo_subagent` spawn/list result readability smoke.

### P2.1 — Dormant chat bridge / rich detail surfaces

Recommendation: delete or explicitly defer after exposure check.

Finding:

- Baseline scan identified `pi-chat-bridge` as a dormant feature candidate with no proven production importer.
- This domain review confirms the active direction is pool notices, compact tool results, and bounded widgets, not private/group chat surfaces.

Evidence:

- Baseline README P1.3
- Static scan reference list in `scan.mjs`

Decision: delete if no public/deep-import exposure exists; otherwise mark dormant/experimental and keep outside active terminal flows.

Cost: low to medium.

Benefit: medium; removes dormant UI complexity.

Risk: medium; source packages may be deep-imported even without internal imports.

Executable tasks:

1. Check package metadata, README/docs, examples, and generated/build outputs for public references.
2. If no exposure exists, delete and clean docs in a separate implementation patch.
3. If exposure may exist, document as dormant/deferred and keep it unregistered.

Validation:

- Public/deep-import exposure grep.
- `bun run typecheck` after any deletion.
- Docs link check/grep if docs change.

### P2.2 — Pure subagent state/view modules

Recommendation: keep.

Finding:

- Pure modules are bounded and adapter-free.
- They support observability without coupling runtime pool logic to terminal UI.

Evidence:

- `src/pi/subagent/subagent-run-state.ts`
- `src/pi/subagent/subagent-run-view.ts`
- `src/pi/subagent/subagent-run-widget-lines.ts`
- Baseline README P2.3

Decision: keep as-is unless touched for behavior.

Cost: none.

Benefit: high.

Risk: low.

Validation:

- Boundary scan.
- Existing subagent state/view tests.

## Suggested Execution Order

1. P0.2 default agents path consistency.
2. P0.1 subagent tool resolution consistency.
3. P1.4 harness evidence adapter contract tests, if warning behavior changes.
4. P1.1 pool lifecycle tests and documentation of pool-first reuse semantics.
5. P1.2 global bridge guardrail tests, only if reload/listener work is touched.
6. P1.6 renderer compactness snapshot/bounds tests, only if terminal output changes.
7. P1.5 persistence cleanup policy only if stale state becomes a demonstrated problem.
8. P2.1 dormant chat bridge exposure decision.

## Minimum Validation Baseline

For any follow-up implementation patch:

```sh
bun run typecheck
bun test
git diff --check
```

For narrower patches, run targeted tests first, then typecheck and diff check.

## Acceptance Criteria for This Review Artifact

- Findings are grouped by capability name, not source path.
- Each finding includes keep/delete/simplify/defer, cost, benefit, risk, and validation.
- Source paths appear only as evidence.
- No source, test, or project config files are modified by this review.
