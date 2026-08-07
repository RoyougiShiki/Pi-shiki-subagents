# Pi Core / Modes / Council Domain Review

Status: plan artifact only; no implementation performed.

Baseline: `docs/pi-shiki-subagents/plans/whole-module-complexity-audit/README.md` plus targeted source reads of Pi core, mode registration, council/meeting, subagent pool, hub, and package metadata.

Review rule: findings are grouped by capability/function name. Code paths are listed only as evidence.

## Scope

Included capabilities:

- Pi extension composition and tool registration.
- Mode registration and tool-scope resolution.
- Subagent pool delegation reuse boundary where it affects modes/council.
- Council isolated execution and meeting orchestration.
- Meeting backend selection, transcript/debug surface, and chat hub surfaces.
- Import/static coupling between Pi core, modes, meeting, council, and pool.

Not assessed as runtime proof:

- Full dynamic extension reload behavior.
- Full council/meeting smoke with live models.
- Compiler-grade import graph beyond the checked-in lightweight scanner.

## Key Distinction: Static Coupling vs Runtime Cycles

- Proven: static/type-level coupling exists between Pi core and meeting/council modules. The baseline scanner reports cycles involving `src/pi/core/pi.ts`, `src/pi/meeting/pi-meeting.ts`, `src/pi/meeting/pi-council.ts`, and `src/pi/meeting/pi-meeting-pool.ts`.
- Not proven: a runtime/value initialization cycle causing reload failure or execution failure. Treat the cycle findings as maintainability and extraction risks unless a runtime reproduction is added.

## P0 Findings

### P0.1 Agent tool-boundary resolution parity

Capability: mode/subagent tool allowlist resolution.

Recommendation: **simplify/fix**.

Finding:

- Mode activation expands `tools`, `roles`, `@group`, nested group entries, wildcard patterns, and `*` before applying active tools.
- Subagent pool role resolution reads groups directly and returns raw group entries without the same expression expansion.
- Defaults make this observable: `_tool_groups.管理` contains `@子代理`; `designer` and `dispatcher` use `管理`, so subagent allowlists can contain an unexpanded pseudo-tool instead of `omo_subagent` / `omo_council`.
- This is a capability bug, not only a cleanup issue, because role names define runtime permissions.

Action:

1. Create or reuse one shared tool-expression resolver for both mode and subagent role/tool expansion.
2. Keep mode behavior as the compatibility reference.
3. Add tests for roles that include nested groups and wildcard entries.
4. Do not add a new registry abstraction; just remove duplicate resolution logic.

Cost: medium.

Benefit: high; removes permission drift between main modes and subagents.

Risk: medium; effective subagent tool scopes may change. The expected change is to make configured nested groups actually work.

Validation:

- Unit tests for `designer`, `dispatcher`, `fixer`, and `search` role/tool expansion.
- Test nested `@group` expansion from `_tool_groups.管理` to `@子代理` to concrete tools.
- `bun run typecheck`.
- Smoke: use `omo_subagent` pool mode with one role that delegates and verify active tools are concrete names only.

Evidence:

- `src/pi/core/pi-modes.ts` has expression expansion and mode application.
- `src/pi/subagent/subagent-pool.ts` has separate role expansion.
- `src/adapters/agents-default.json` defines nested group `管理: ["@子代理"]`.

### P0.2 Default agent/tool-group path consistency

Capability: default agent definition loading.

Recommendation: **simplify/fix**.

Finding:

- Multiple modules derive the default agents path independently.
- The subagent pool path uses `__dirname/../adapters/agents-default.json`, which can resolve differently from the shared adapter runtime path depending on source/build location.
- If defaults fail to load, `_tool_groups` can silently disappear and compound P0.1.

Action:

1. Use the existing shared default-agent loader/path helper everywhere possible.
2. If direct file reads remain, centralize path derivation in one adapter module.
3. Make missing default groups test-visible rather than silent where it affects permissions.

Cost: small.

Benefit: high; prevents missing defaults from weakening or breaking role-based tool scopes.

Risk: low; expected behavior is to load the same defaults already used elsewhere.

Validation:

- Unit test that subagent default `_tool_groups` load from `src/adapters/agents-default.json`.
- Existing subagent pool tests.
- `bun run typecheck`.

Evidence:

- `src/pi/subagent/subagent-pool.ts` defines its own `DEFAULTS_PATH`.
- `src/adapters/agent-runtime-config.ts` is already used by Pi modes/core for runtime definitions.

### P0.3 Council meeting parameter surface contract is now aligned

Capability: `omo_council` meeting orchestration API.

Recommendation: **resolved by routing meeting mode through the structured meeting backend; keep monitoring for regressions**.

Finding:

- Historical baseline: the registered `omo_council` tool exposed `backend` and `includeTranscript` parameters, while the old `mode="meeting"` branch created an inline hub/group-chat flow directly with `createAgentSession` and `getHub()`.
- Current contract: active `mode="meeting"` routes through the structured `runPiMeeting()` path and returns `formatPiMeetingResult()`, so backend/transcript/max-rounds parameters belong to the structured meeting API.
- The active extension does not register `/chat`; any interactive chat bridge remains dormant/experimental unless explicitly integrated.

Regression guardrails:

1. Keep `mode="meeting"` routed through `runPiMeeting()` and `formatPiMeetingResult()` for hidden round-based meetings.
2. If interactive group chat is introduced later, give it a separate explicit command/API and do not overload `mode="meeting"`.
3. Do not reintroduce two different `meeting` semantics behind the same `omo_council` mode.

Cost: medium.

Benefit: high; makes council meeting behavior match the advertised API and reduces duplicate orchestration.

Risk: medium; council behavior is user-visible, and any historical/manual `/chat` group-chat expectation must remain clearly marked as non-active unless a real command is added.

Validation:

- Targeted tests for `omo_council` parameter routing:
  - `mode="isolated"` remains isolated council.
  - `mode="meeting"` honors structured backend/transcript parameters through `runPiMeeting()`.
  - `includeTranscript=true` only produces transcript where the chosen path supports it.
- Manual smoke with `omo_council` meeting using `backend=session` and `backend=pool` if retained.
- `bun run typecheck`.

Evidence:

- `src/pi/core/pi.ts` registers `omo_council` and declares `backend` / `includeTranscript` parameters.
- Historical baseline used inline `createAgentSession` and `getHub()` directly; current `src/pi/core/pi.ts` routes `mode === 'meeting'` through `runPiMeeting()` and `formatPiMeetingResult()`.
- `src/pi/meeting/pi-meeting.ts` contains the separate structured `runPiMeeting()` / `resolvePiMeetingBackend()` path.

## P1 Findings

### P1.1 Pi extension composition root hotspot

Capability: Pi extension load, event wiring, and tool/command registration.

Recommendation: **simplify**.

Finding:

- `src/pi/core/pi.ts` is the largest and highest fan-out module in the baseline scan.
- It currently owns config parsing, prompt assembly, mode hook wiring, policy gates, subagent bridge wiring, council tool registration, preset UI, `/pi-sync`, pool status, and shutdown cleanup.
- This is acceptable as a composition root, but implementation details are now mixed into the root, increasing risk of accidental coupling.

Action:

1. Keep `pi.ts` as the composition root.
2. Extract only capability-owned registration units with stable seams, for example:
   - council tool registration,
   - preset command registration,
   - runtime event/policy gate wiring,
   - dev command registration.
3. Preserve registration order and side effects.
4. Avoid a generic plugin registry or broad rewrite.

Cost: medium.

Benefit: high; makes future meeting/mode changes easier and reduces central-file edit risk.

Risk: medium; registration order and event hook timing can change accidentally.

Validation:

- Existing adapter/core tests.
- Extension load smoke: mode status, `switch_mode`, `omo_subagent`, `omo_council`, `/preset`, `/pool-status` still register.
- `bun run typecheck`.

Evidence:

- Baseline scan: `src/pi/core/pi.ts` is about 1965 lines and has the highest local outgoing import count.
- Targeted read shows composition plus implementation code in one file.

### P1.2 Core ↔ meeting/council import coupling

Capability: meeting/council integration boundary.

Recommendation: **simplify**; first lightweight step completed.

Finding:

- Meeting and council modules now import shared config types (`OmniMoConfig`, `PiCouncilParticipantConfig`) from neutral `src/pi/config-types.ts`, not from `src/pi/core/pi.ts`.
- `src/pi/core/pi.ts` keeps type-only re-exports for compatibility with existing imports/tests.
- Pi core still imports meeting and council implementations and re-exports some meeting/council helpers; further facade extraction remains a future step.
- `pi-meeting-pool.ts` imports types from `pi-meeting.ts`; `pi-meeting.ts` imports the pool backend. This is separate meeting-internal coupling, not a core ↔ meeting type edge.
- Runtime/value cycle failure is not proven.

Follow-up action:

1. Preserve `src/pi/config-types.ts` as the neutral config contract for core and meeting modules.
2. Keep meeting implementations out of the composition root except through future registration/facade functions.
3. Re-run the scanner and compare cycles before any larger extraction.

Cost: small for the completed type extraction; medium for any later facade extraction.

Benefit: medium; removes a direct meeting → core type import and creates a cleaner extraction path.

Risk: medium; type movement can fan out across tests and exports.

Validation:

- Import graph scan before/after with `node docs/pi-shiki-subagents/plans/whole-module-complexity-audit/scan.mjs .`.
- Meeting/council targeted tests or smoke.
- `bun run typecheck`.

Evidence:

- Targeted scan confirms no meeting module imports types from `../core/pi`; both `pi-council.ts` and `pi-meeting.ts` import config types from `../config-types`.
- Baseline scanner previously reported static cycles among Pi core, meeting, council, and meeting pool; this patch intentionally removes only the low-risk core-config type edge.

### P1.3 Meeting backend duplication and semantic drift

Capability: hidden meeting execution backends.

Recommendation: **defer consolidation until P0.3 is decided; then simplify**.

Finding:

- There are at least three related orchestration concepts:
  - isolated council via subagent pool participant runs,
  - structured hidden meeting via `CreateAgentSessionMeetingBackend` / `PoolMeetingBackend`,
  - interactive hub/group chat via `pi-hub` from the registered tool.
- Some helper logic is duplicated, including assistant text extraction and semantic-overlap convergence.
- Consolidating before choosing the user-facing meeting semantics risks preserving the wrong abstraction.

Action:

1. Resolve P0.3 first: decide whether `mode="meeting"` means hidden structured meeting or interactive group chat.
2. After that, delete or demote the unchosen path from the default user-facing flow.
3. Share only small pure helpers if duplication remains after deletion.

Cost: medium.

Benefit: medium; reduces backend confusion and repeated prompt/session code.

Risk: medium to high; behavior and terminology are user-facing.

Validation:

- Capability matrix tests for isolated council, hidden meeting, and any retained chat mode.
- Manual smoke for backend selection if both `session` and `pool` remain.
- `bun run typecheck`.

Evidence:

- `src/pi/core/pi.ts` inline hub/group chat path.
- `src/pi/meeting/pi-meeting.ts` structured backend path.
- `src/pi/meeting/pi-meeting-pool.ts` pool backend path.

### P1.4 Transcript/debug surface must stay explicit and bounded

Capability: meeting transcript/debug output.

Recommendation: **keep with constraints**.

Finding:

- Structured meeting output omits transcript by default and appends transcript only when `includeTranscript=true`.
- The inline hub/group-chat path is a live chat surface rather than a bounded transcript appendix.
- Transcript expansion is explicitly out of scope in the baseline audit.

Action:

1. Preserve default transcript omission.
2. Keep `includeTranscript` as an explicit debug-only opt-in only for structured meeting results.
3. Do not add persistent transcript storage or dashboard surfaces as part of this audit.
4. If interactive chat remains, document it separately from hidden meeting transcript.

Cost: low.

Benefit: medium; prevents debug surfaces from expanding terminal UI and context volume.

Risk: low to medium; users may expect raw logs for debugging.

Validation:

- Test default meeting output contains metadata with `transcript omitted: yes`.
- Test `includeTranscript=true` appends transcript appendix only on supported backend.
- Grep docs for transcript/dashboard promises before release.

Evidence:

- `src/pi/meeting/pi-meeting.ts` gates transcript on `request.includeTranscript`.
- Baseline audit explicitly excludes transcript/dashboard/persistence expansion.

### P1.5 Import-facing public API exposure before deletion

Capability: package/deep-import surface.

Recommendation: **simplify after exposure check**.

Finding:

- The package `files` list ships `src/pi/**`, so dormant files under `src/pi` may be deep-importable even without internal production imports.
- This affects deletion decisions for chat bridge and possibly meeting helpers.

Action:

1. Before deleting any dormant Pi file, scan package metadata, README/docs, examples, and generated declarations/build output.
2. If not exposed, delete and update docs.
3. If exposed, mark experimental/dormant and remove from default runtime flow instead of deleting immediately.

Cost: low to medium.

Benefit: medium; avoids accidental public API breakage while still reducing active complexity.

Risk: medium; npm consumers may deep-import source paths.

Validation:

- Reference scan across repo and build declarations.
- `bun run build` for release-facing changes.
- `bun run typecheck`.

Evidence:

- `package.json` includes `src/pi` in published files.
- Baseline raw reference scan flags dormant chat bridge candidates.

## P2 Findings

### P2.1 Keep mode registration split but remove duplicate defaults knowledge

Capability: mode registration.

Recommendation: **keep/simplify**.

Finding:

- `pi-modes.ts` has a coherent role: mode commands, active mode persistence, mode tool application, and mode notices.
- It still duplicates some default path/config knowledge with Pi core and subagent pool.

Action:

1. Keep mode registration as its own module.
2. Remove duplicated default path and tool-group loading only when P0.1/P0.2 are addressed.
3. Do not merge modes back into `pi.ts`.

Cost: small.

Benefit: medium; keeps a useful boundary while reducing drift.

Risk: low.

Validation:

- Mode command tests/smoke.
- Tool allowlist tests.
- `bun run typecheck`.

Evidence:

- `src/pi/core/pi.ts` delegates mode commands/hooks/tool to `pi-modes.ts`.
- `pi-modes.ts` owns mode persistence and active tool application.

### P2.2 Keep pool notice bridge isolated

Capability: subagent completion transcript/debug surface.

Recommendation: **keep**.

Finding:

- Pool completion bridge uses a global symbol to survive reload/listener churn and sends compact follow-up messages.
- This is justified for lifecycle correctness but should remain isolated.

Action:

1. Do not generalize the global bridge pattern.
2. Do not use pool completion as a reason to add transcript persistence.
3. Keep completion messages compact and decision-oriented.

Cost: none now.

Benefit: medium; preserves reload safety without spreading global state.

Risk: medium if copied elsewhere.

Validation:

- Existing pool notice bridge tests.
- Smoke: subagent completion emits one follow-up after reload/re-registration.

Evidence:

- `src/pi/subagent/subagent-pool-notice-bridge.ts` uses `Symbol.for` and generation guards.

### P2.3 Defer dormant chat bridge deletion decision

Capability: interactive chat overlay.

Recommendation: **defer deletion; keep dormant/quarantined unless an explicit chat command contract is approved**.

Finding:

- `pi-chat-bridge.ts` is a rich terminal overlay surface and imports Pi TUI plus meeting hub.
- Historical baseline: the old meeting branch created hub meetings and returned text that mentioned `/chat`, while no active `/chat` command was registered.
- Current P1.3 contract: `omo_council mode=meeting` uses `runPiMeeting` plus `formatPiMeetingResult`; the active extension does not register `/chat`; the chat bridge remains dormant/experimental unless explicitly integrated.

Action:

1. Keep `omo_council mode=meeting` on the structured meeting backend unless a separate interactive chat command is approved.
2. Do not wire `pi-chat-bridge.ts` into default terminal flows; if retained, document it as dormant/experimental and explicitly integrated only.
3. If a future `/chat` command is added, add command registration, help text, tests, and docs in the same patch.

Cost: low to medium.

Benefit: medium; avoids terminal UI expansion and dormant complexity.

Risk: medium; potential deep imports or manual usage.

Validation:

- Internal and public reference scan.
- Package declaration/build check if deleted.
- `bun run typecheck`.

Evidence:

- `src/pi/subagent/pi-chat-bridge.ts` contains overlay UI but is not wired to an active command.
- Current implementation routes `omo_council mode=meeting` through `runPiMeeting` and `formatPiMeetingResult`; remaining `/chat` references state that no `/chat` command is registered.

## Suggested Execution Order

1. P0.2: centralize default agent/tool-group path loading.
2. P0.1: share tool expression expansion across mode and subagent scopes.
3. P0.3: decide and fix the `omo_council` meeting API contract.
4. P1.2: break type/static coupling after the meeting contract is clear.
5. P1.1: extract registration units from `pi.ts` without changing behavior.
6. P1.3/P2.3: consolidate or quarantine unchosen meeting/chat backends.
7. P1.4/P2.2: keep transcript and pool completion surfaces bounded.

## Validation Baseline for Follow-up Patches

For code changes:

```sh
bun run typecheck
bun test
git diff --check
```

For import/coupling changes:

```sh
node docs/pi-shiki-subagents/plans/whole-module-complexity-audit/scan.mjs .
```

For docs-only edits:

```sh
git diff --check
```

## Task Seeds

### Task A: Tool scope parity test plan

- Add tests that resolve tools for `designer`, `dispatcher`, `fixer`, and `search` as both mode/subagent where applicable.
- Assert no returned tool name starts with `@`.
- Assert wildcard group entries resolve only to actual registered tools when all tools are provided.

### Task B: Council meeting contract test plan

- Construct a test or harness around registered `omo_council` execution.
- Assert `mode="meeting"` either calls structured meeting backend or rejects unsupported backend/transcript parameters.
- Assert default meeting output does not include raw transcript.

### Task C: Static coupling reduction plan

- Classify imports among `pi.ts`, `pi-modes.ts`, `pi-council.ts`, `pi-meeting.ts`, and `pi-meeting-pool.ts` as type-only or value.
- Move only shared types needed to break real bidirectional coupling.
- Re-run the scan script and document before/after cycles.
